package main

import (
	"errors"
	"maps"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// supervisor runs `termote serve` in the background: the OS service manager
// (systemd --user, launchd, a Scheduled Task) or, where there is none, a
// detached process tracked by the PID file serve writes.
type supervisor interface {
	Name() string
	// Available reports whether this supervisor can be used on this machine.
	Available() bool
	// Installed reports whether Termote registered itself with it.
	Installed() bool
	// Install registers `<exe> serve` with env; it is idempotent.
	Install(exe string, env map[string]string) error
	// Start starts the server, restarting it when it already runs.
	Start() error
	// Stop stops the server; the caller waits for the port to be free.
	Stop() error
	// Status reports whether the server runs, with its PID when known.
	Status() (running bool, pid int, err error)
	Uninstall() error
	// AutoStart reports whether the server comes back after a reboot or login.
	AutoStart() bool
}

// exitConfigUnusable is serve's exit status when the saved config cannot be
// used (the password no longer decrypts). Supervisors do not restart on it:
// only `termote start --fresh` fixes it.
const exitConfigUnusable = 78

// supervisors lists what can run the server here, preferred first.
func (c *cli) supervisors() []supervisor {
	if c.testSupervisors != nil {
		return c.testSupervisors
	}
	var out []supervisor
	switch c.goos {
	case "linux":
		out = append(out, &systemdSupervisor{c: c})
	case "darwin":
		out = append(out, &launchdSupervisor{c: c})
	case "windows":
		out = append(out, &taskSupervisor{c: c}, &startupSupervisor{c: c})
	}
	return append(out, &detachedSupervisor{c: c})
}

// installedSupervisor is the one Termote registered with, or nil. The choice
// is not saved: asking each one follows reality (systemd enabled in WSL
// later, a task removed by hand).
func (c *cli) installedSupervisor() supervisor {
	for _, s := range c.supervisors() {
		if s.Installed() {
			return s
		}
	}
	return nil
}

// preferredSupervisor is the first available one; detached always is.
func (c *cli) preferredSupervisor() supervisor {
	for _, s := range c.supervisors() {
		if s.Available() {
			return s
		}
	}
	return &detachedSupervisor{c: c}
}

// serviceEnv is the environment the service runs with: the PATH of the shell
// running `start` (so tmux, Homebrew, nvm and ~/.local/bin are found and
// every pane inherits them), the herdr socket, the XDG dirs that locate the
// config and the install (update run from a pane must find it), and the
// locale tmux needs for UTF-8. Never a TERMOTE_* variable:
// serve reads its settings from the config file.
func (c *cli) serviceEnv() map[string]string {
	env := map[string]string{}
	for _, k := range []string{"PATH", "HERDR_SOCKET_PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "LANG", "LC_ALL"} {
		if v := c.getenv(k); v != "" {
			env[k] = v
		}
	}
	return env
}

// sortedKeys returns the keys of env in order, for stable unit files.
func sortedKeys(env map[string]string) []string { return slices.Sorted(maps.Keys(env)) }

// readPIDFile returns the PID serve recorded, or 0.
func (c *cli) readPIDFile() int {
	b, err := os.ReadFile(c.pidFile())
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return pid
}

// serverProcess returns the running server recorded in the PID file. The PID
// must still run `termote serve` (the binary is shared with the CLI, so the
// name alone proves nothing), which also guards against a reused PID.
func (c *cli) serverProcess() (procInfo, bool) {
	pid := c.readPIDFile()
	if pid <= 0 || pid == c.pid {
		return procInfo{}, false
	}
	procs, err := c.procs()
	if err != nil {
		return procInfo{}, false
	}
	for _, p := range procs {
		if p.PID == pid && c.isServeProcess(p) {
			return p, true
		}
	}
	return procInfo{}, false
}

// isServeProcess reports a `termote serve` process. Unix sees the argv; a
// Windows process listing only has the image, so its name is checked.
func (c *cli) isServeProcess(p procInfo) bool {
	if c.goos == "windows" {
		base := strings.ToLower(p.Exe[strings.LastIndexAny(p.Exe, `\/`)+1:])
		return base == "termote.exe" || base == "termote-dev.exe"
	}
	// The argv is joined by spaces, so the binary path may contain some:
	// match the argument at the end, then the binary's name before it.
	for _, suffix := range []string{" serve", " serve --service"} {
		if bin, ok := strings.CutSuffix(p.Cmdline, suffix); ok {
			base := filepath.Base(bin)
			return base == "termote" || base == "termote-dev"
		}
	}
	return false
}

// detachedSupervisor starts serve in its own session and stops it through the
// PID file. Nothing restarts it after a crash or a reboot.
type detachedSupervisor struct{ c *cli }

func (d *detachedSupervisor) Name() string    { return "detached" }
func (d *detachedSupervisor) Available() bool { return true }
func (d *detachedSupervisor) AutoStart() bool { return false }

// Installed is true while the PID file names a running server.
func (d *detachedSupervisor) Installed() bool {
	_, ok := d.c.serverProcess()
	return ok
}

func (d *detachedSupervisor) Install(string, map[string]string) error { return nil }

func (d *detachedSupervisor) Start() error {
	if err := d.Stop(); err != nil {
		return err
	}
	if err := ensureDir(d.c.stateDir()); err != nil {
		return err
	}
	exe := d.c.stableExe()
	env := environ(d.c.serviceEnv())
	env = withoutHerdrPaneEnv(withoutTermoteEnv(env))
	_, exited, err := startDetached(exe, []string{"serve"}, d.c.home, env, d.c.serverLog())
	if err != nil {
		return err
	}
	d.c.detachedExited = exited
	return nil
}

func (d *detachedSupervisor) Stop() error {
	p, ok := d.c.serverProcess()
	if !ok {
		removeFile(d.c.pidFile())
		return nil
	}
	if err := d.c.terminate(p.PID, processKillWait); err != nil {
		return err
	}
	removeFile(d.c.pidFile())
	return nil
}

func (d *detachedSupervisor) Status() (bool, int, error) {
	p, ok := d.c.serverProcess()
	return ok, p.PID, nil
}

func (d *detachedSupervisor) Uninstall() error { return d.Stop() }

// withoutTermoteEnv drops every TERMOTE_* variable: a server started from a
// shell that exported one must still read only the config.
func withoutTermoteEnv(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if !isTermoteEnv(kv) {
			out = append(out, kv)
		}
	}
	return out
}

// withoutHerdrPaneEnv drops what Herdr sets for one pane or plugin command
// (HERDR_ENV, HERDR_PANE_ID, HERDR_PLUGIN_*, ...), so a server started from a
// Herdr pane or the Herdr plugin, and every terminal it opens, does not claim
// to be that pane. HERDR_SOCKET_PATH stays: it names the Herdr to serve.
func withoutHerdrPaneEnv(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if !strings.HasPrefix(k, "HERDR_") || k == "HERDR_SOCKET_PATH" {
			out = append(out, kv)
		}
	}
	return out
}

// serverLog is where serve's output goes when a supervisor does not keep it.
func (c *cli) serverLog() string { return filepath.Join(c.stateDir(), "termote.log") }

// waitStopped waits until nothing answers on the port, so a new server can
// bind it and an old one cannot answer a health check meant for the new. It
// connects rather than binds: macOS lets 127.0.0.1 bind while an old server
// still holds 0.0.0.0.
func (c *cli) waitStopped(port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 200*time.Millisecond)
		if err != nil {
			return nil
		}
		conn.Close()
		if time.Now().After(deadline) {
			return errors.New("port " + strconv.Itoa(port) + " is still in use after stopping the server")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// writePIDFile records this server for stop and status.
func (c *cli) writePIDFile() error {
	if err := ensureDir(c.stateDir()); err != nil {
		return err
	}
	return os.WriteFile(c.pidFile(), []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
}

// removePIDFile deletes the PID file if it still names this process.
func (c *cli) removePIDFile() {
	if c.readPIDFile() == os.Getpid() {
		removeFile(c.pidFile())
	}
}
