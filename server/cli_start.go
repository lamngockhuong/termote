package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

// startOptions are the flags of start after merging the saved config.
type startOptions struct {
	lan         bool
	noAuth      bool
	fresh       bool
	herdrNoAuth bool
	port        int
	tailscale   string
	noTailscale bool
	mux         string
	allowHosts  []string // user-added names, persisted
	removeHosts []string
}

// serverStartWait bounds the wait for a started server to answer.
var serverStartWait = 15 * time.Second

func (c *cli) parseStartArgs(args []string) (startOptions, map[string]bool, error) {
	var o startOptions
	var hosts, remove stringList
	fs := c.newFlagSet("start")
	fs.BoolVar(&o.lan, "lan", false, "")
	fs.BoolVar(&o.noAuth, "no-auth", false, "")
	fs.BoolVar(&o.fresh, "fresh", false, "")
	fs.BoolVar(&o.herdrNoAuth, "allow-herdr-no-auth", false, "")
	fs.IntVar(&o.port, "port", 0, "")
	fs.StringVar(&o.tailscale, "tailscale", "", "")
	fs.BoolVar(&o.noTailscale, "no-tailscale", false, "")
	fs.StringVar(&o.mux, "mux", "", "")
	fs.Var(&hosts, "allow-host", "")
	fs.Var(&remove, "remove-host", "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return o, nil, flagErr(err)
	}
	if len(pos) > 0 {
		return o, nil, usageError("start takes no arguments, only options (see: termote help)")
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if set["tailscale"] && o.noTailscale {
		return o, nil, usageError("--tailscale and --no-tailscale cannot be combined")
	}
	o.allowHosts, o.removeHosts = hosts, remove
	return o, set, nil
}

// mergeSaved applies saved values for every flag not given on the command
// line. --allow-host adds to the saved names, --remove-host drops one, and a
// boolean flag turns a saved value off with =false.
func mergeSaved(o *startOptions, set map[string]bool, s *savedConfig) {
	if s == nil {
		s = &savedConfig{}
	}
	if !set["lan"] {
		o.lan = s.LAN
	}
	if !set["no-auth"] {
		o.noAuth = s.NoAuth
	}
	if !set["port"] && s.Port != 0 {
		o.port = s.Port
	}
	if !set["tailscale"] && !o.noTailscale {
		o.tailscale = s.Tailscale
	}
	if !set["mux"] {
		o.mux = s.Mux
	}
	if !set["allow-herdr-no-auth"] {
		o.herdrNoAuth = s.HerdrAllowNoAuth
	}
	for _, h := range s.AllowHosts {
		if !slices.Contains(o.allowHosts, h) {
			o.allowHosts = append(o.allowHosts, h)
		}
	}
	o.allowHosts = slices.DeleteFunc(o.allowHosts, func(h string) bool {
		return slices.ContainsFunc(o.removeHosts, func(r string) bool { return strings.EqualFold(r, h) })
	})
	slices.Sort(o.allowHosts)
}

func (c *cli) validateStart(o *startOptions) error {
	if o.port == 0 {
		o.port = c.defaultPort()
	}
	if o.port < 1 || o.port > 65535 {
		return usageError("invalid port: %d", o.port)
	}
	switch o.mux {
	case "tmux", "":
	case "herdr":
		if c.goos == "windows" {
			return usageError("--mux herdr is not supported on Windows")
		}
		if o.noAuth && !o.herdrNoAuth {
			return usageError("--mux herdr --no-auth would expose every herdr workspace without a password; add --allow-herdr-no-auth to accept that")
		}
	default:
		return usageError("unknown --mux %q (use: tmux, herdr)", o.mux)
	}
	for _, h := range append(slices.Clone(o.allowHosts), o.removeHosts...) {
		if err := validateHostName(h); err != nil {
			return usageError("%v", err)
		}
	}
	if o.tailscale != "" {
		if err := validTailscale(o.tailscale); err != nil {
			return usageError("%v", err)
		}
	}
	return nil
}

// detectMux picks the backend the first time: herdr when its server answers
// on the socket, tmux (psmux on Windows) when installed, and asks when both
// are there. The choice is saved; later starts keep it unless --mux is given.
func (c *cli) detectMux() (string, error) {
	herdr := c.goos != "windows" && c.herdrRunning()
	_, tmuxErr := c.run.LookPath("tmux")
	tmux := tmuxErr == nil
	switch {
	case herdr && tmux && c.interactive:
		if strings.HasPrefix(c.choose("Terminal backend (both are available):", []string{
			"herdr - Herdr workspaces (running now)",
			"tmux - one tmux session",
		}), "tmux") {
			return "tmux", nil
		}
		return "herdr", nil
	case herdr && tmux:
		c.infof("Backend: tmux (herdr is running too; switch with: termote start --mux herdr)")
		return "tmux", nil
	case herdr:
		c.infof("Backend: herdr (its server is running at %s)", herdrSocketPath())
		return "herdr", nil
	case tmux:
		c.infof("Backend: tmux (herdr is not running)")
		return "tmux", nil
	}
	if c.goos == "windows" {
		return "", errors.New("psmux not found. Install it: winget install psmux (https://github.com/psmux/psmux)")
	}
	return "", errors.New("no terminal backend found. Install tmux (brew install tmux, or sudo apt install tmux) or run herdr (https://herdr.dev)")
}

// herdrReachable reports whether herdr's socket (named pipe on Windows)
// accepts a connection.
func herdrReachable() bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := dialHerdr(ctx, herdrSocketPath())
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// preflight checks that the backend's command is installed.
func (c *cli) preflight(mux string) error {
	switch mux {
	case "tmux":
		if _, err := c.run.LookPath("tmux"); err != nil {
			if c.goos == "windows" {
				return errors.New("psmux not found. Install it: winget install psmux (https://github.com/psmux/psmux)")
			}
			return errors.New("tmux not found. Install it: brew install tmux (macOS) or sudo apt install tmux (Debian/Ubuntu)")
		}
	case "herdr":
		if _, err := c.run.LookPath("herdr"); err != nil {
			return errors.New("herdr not found in PATH; install herdr or use --mux tmux")
		}
	}
	return nil
}

func (c *cli) cmdStart(args []string) error {
	o, set, err := c.parseStartArgs(args)
	if err != nil {
		return err
	}
	saved, err := c.loadConfig()
	if err != nil {
		return fmt.Errorf("cannot read %s (%v); fix or delete it, then start again", c.configFile(), err)
	}
	mergeSaved(&o, set, saved)
	if err := c.validateStart(&o); err != nil {
		return err
	}
	if o.mux == "" {
		if o.mux, err = c.detectMux(); err != nil {
			return err
		}
	}
	if err := c.validateStart(&o); err != nil {
		return err
	}
	if err := c.preflight(o.mux); err != nil {
		return err
	}
	pass, reused, err := c.setupAuth(o, saved)
	if err != nil {
		return err
	}

	c.heading("Termote Start")
	prevTS := ""
	prevPort := c.defaultPort()
	if saved != nil {
		prevTS = saved.Tailscale
		if saved.Port != 0 {
			prevPort = saved.Port
		}
	}
	bind := "127.0.0.1"
	if o.lan {
		bind = "0.0.0.0"
	}
	portErr := func(err error) error {
		return fmt.Errorf("port %d is in use by another program (%v); stop it or choose --port", o.port, err)
	}
	var running []supervisor
	for _, s := range c.supervisors() {
		if s.Installed() {
			running = append(running, s)
		}
	}
	// Everything that can fail is checked before the running server stops:
	// the user may be connected through it. A port other than the running
	// server's is checked now; the same port only once that server is gone.
	if len(running) == 0 || o.port != prevPort {
		if err := portFree(bind, o.port); err != nil {
			return portErr(err)
		}
	}
	if o.tailscale != "" {
		ownPort := 0
		if len(running) > 0 {
			ownPort = prevPort
		}
		if err := c.setupTailscale(o.tailscale, o.port, ownPort); err != nil {
			return err
		}
	}

	// Stop what runs now, under any supervisor, so the port is free and a
	// registration left from another one (detached before systemd was
	// enabled) does not linger.
	for _, s := range running {
		if err := s.Stop(); err != nil {
			c.warnf("Could not stop the server (%s): %v", s.Name(), err)
		}
	}
	if len(running) > 0 {
		if err := c.waitStopped(prevPort, processKillWait+2*time.Second); err != nil {
			return err
		}
		if o.port == prevPort {
			if err := portFree(bind, o.port); err != nil {
				return portErr(err)
			}
		}
	}
	if prevTS != "" && prevTS != o.tailscale {
		c.removeTailscale(prevTS, prevPort)
	}
	if err := c.saveConfig(savedConfig{
		LAN:              o.lan,
		NoAuth:           o.noAuth,
		Port:             o.port,
		Tailscale:        o.tailscale,
		Mux:              o.mux,
		AllowHosts:       o.allowHosts,
		HerdrAllowNoAuth: o.herdrNoAuth,
		Password:         c.keptPassword(pass, saved),
		Container:        c.savedContainer(saved),
	}); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	sup, err := c.registerService()
	if err != nil {
		return err
	}
	if err := sup.Start(); err != nil {
		return err
	}
	if err := c.waitForServer(o.port, pass, c.version, serverStartWait, c.detachedExited); err != nil {
		return fmt.Errorf("%v; last log lines:\n%s", err, tailFile(c.serverLog(), 15))
	}
	c.infof("Server running under %s (backend: %s)", sup.Name(), o.mux)
	if !sup.AutoStart() {
		c.warnf("No service manager found: the server will not start again after a reboot or crash; run 'termote start' then")
	}
	c.showAccessInfo(o, pass, reused)
	return nil
}

// registerService installs the server with the preferred supervisor and
// removes any other registration. A Scheduled Task refused by policy falls
// back to the Startup folder.
func (c *cli) registerService() (supervisor, error) {
	exe := c.stableExe()
	env := c.serviceEnv()
	// systemd and launchd open the log themselves, before serve runs.
	if err := ensureDir(c.stateDir()); err != nil {
		return nil, err
	}
	sup := c.preferredSupervisor()
	if err := sup.Install(exe, env); err != nil {
		if _, ok := sup.(*taskSupervisor); !ok {
			return nil, fmt.Errorf("register with %s: %w", sup.Name(), err)
		}
		c.warnf("Could not create the Scheduled Task (%v); using the Startup folder instead (no restart after a crash)", err)
		sup = &startupSupervisor{c: c}
		if err := sup.Install(exe, env); err != nil {
			return nil, err
		}
	}
	for _, s := range c.supervisors() {
		if s.Name() != sup.Name() && s.Installed() {
			if err := s.Uninstall(); err != nil {
				c.warnf("Could not remove the old %s registration: %v", s.Name(), err)
			}
		}
	}
	return sup, nil
}

// setupAuth returns the password to run with; empty means auth is off.
func (c *cli) setupAuth(o startOptions, saved *savedConfig) (pass string, reused bool, err error) {
	if o.noAuth {
		return "", false, nil
	}
	if !o.fresh && saved != nil {
		switch {
		case saved.Password != "":
			return saved.Password, true, nil
		case saved.PasswordUnreadable:
			c.warnf("Saved password cannot be decrypted (%s missing or changed); setting a new one", c.secretFile())
		}
	}
	if c.interactive {
		fmt.Fprint(c.out, "Enter password for admin (Enter = auto-generate): ")
		p, err := c.readPassword()
		if err == nil && p != "" {
			return p, false, nil
		}
	}
	p, err := generatePassword()
	if err != nil {
		return "", false, err
	}
	return p, false, nil
}

// serverHealth is /api/mux/health.
type serverHealth struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	Backend string `json:"backend"`
	PID     int    `json:"pid"`
}

// fetchHealth asks the server on port for its health; code is the HTTP
// status (0 when nothing answers).
func fetchHealth(port int, pass string) (serverHealth, int) {
	var h serverHealth
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/mux/health", port), nil)
	if pass != "" {
		req.SetBasicAuth(adminUser, pass)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return h, 0
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		json.NewDecoder(resp.Body).Decode(&h)
	}
	return h, resp.StatusCode
}

// waitForServer waits until the health endpoint reports ok for version (any
// version when empty), the process exits (exited closes) or the timeout
// passes.
func (c *cli) waitForServer(port int, pass, version string, timeout time.Duration, exited <-chan struct{}) error {
	deadline := time.Now().Add(timeout)
	last := "no answer"
	for time.Now().Before(deadline) {
		h, code := fetchHealth(port, pass)
		switch {
		case code == http.StatusOK && h.Status == "ok" && (version == "" || h.Version == version):
			return nil
		case code == http.StatusOK && h.Status == "ok":
			last = fmt.Sprintf("version %s answers, expected %s", h.Version, version)
		case code != 0:
			last = fmt.Sprintf("HTTP %d, status %q", code, h.Status)
		}
		select {
		case <-exited:
			return errors.New("the server exited right after starting")
		case <-time.After(200 * time.Millisecond):
		}
	}
	return fmt.Errorf("the server did not become healthy within %s (%s)", timeout, last)
}

func (c *cli) cmdStop(args []string) error {
	if pos, err := parseArgs(c.newFlagSet("stop"), args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError("stop takes no arguments (the container has its own: termote container down)")
	}
	saved, _ := c.loadConfig()
	sup := c.installedSupervisor()
	if sup == nil {
		c.infof("Termote is not running")
		return nil
	}
	if err := sup.Stop(); err != nil {
		return err
	}
	if err := c.waitStopped(c.savedPort(saved), processKillWait+2*time.Second); err != nil {
		return err
	}
	if saved != nil {
		c.removeTailscale(saved.Tailscale, c.savedPort(saved))
	}
	if sup.AutoStart() {
		c.infof("Termote stopped (%s). It starts again at the next login; 'termote uninstall' removes it.", sup.Name())
	} else {
		c.infof("Termote stopped")
	}
	return nil
}

// cmdRestart stops and starts the server with the saved config unchanged.
func (c *cli) cmdRestart(args []string) error {
	if pos, err := parseArgs(c.newFlagSet("restart"), args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError("restart takes no arguments (the container has its own: termote container down)")
	}
	saved, err := c.loadConfig()
	if err != nil {
		return err
	}
	sup := c.installedSupervisor()
	if saved == nil || sup == nil {
		return errors.New("Termote is not set up yet; run: termote start")
	}
	port := c.savedPort(saved)
	if err := sup.Stop(); err != nil {
		return err
	}
	if err := c.waitStopped(port, processKillWait+2*time.Second); err != nil {
		return err
	}
	if err := sup.Start(); err != nil {
		return err
	}
	if err := c.waitForServer(port, saved.Password, c.version, serverStartWait, c.detachedExited); err != nil {
		return fmt.Errorf("%v; last log lines:\n%s", err, tailFile(c.serverLog(), 15))
	}
	c.infof("Termote restarted (%s)", sup.Name())
	return nil
}

func (c *cli) savedPort(saved *savedConfig) int {
	if saved != nil && saved.Port != 0 {
		return saved.Port
	}
	return c.defaultPort()
}

// cmdStatus reports what the running server itself says, then how it is
// supervised and reached.
func (c *cli) cmdStatus(args []string) error {
	port := 0
	fs := c.newFlagSet("status")
	fs.IntVar(&port, "port", 0, "")
	if _, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	}
	saved, _ := c.loadConfig()
	if port == 0 {
		port = c.savedPort(saved)
	}
	pass := ""
	if saved != nil {
		pass = saved.Password
	}
	c.heading("Termote Status")
	h, code := fetchHealth(port, pass)
	running := code == http.StatusOK
	switch {
	case running:
		fmt.Fprintf(c.out, "  %s server :%d - %s\n", c.paint(ansiGreen, "[OK]"), port, h.Status)
		fmt.Fprintf(c.out, "  Version: v%s\n  Backend: %s\n  PID: %d\n", h.Version, h.Backend, h.PID)
	case code == http.StatusUnauthorized:
		running = true
		fmt.Fprintf(c.out, "  %s server :%d - running (the saved password was not accepted)\n", c.paint(ansiYellow, "[OK]"), port)
	case code != 0:
		fmt.Fprintf(c.out, "  %s server :%d - HTTP %d\n", c.paint(ansiRed, "[--]"), port, code)
	default:
		fmt.Fprintf(c.out, "  %s server :%d - not running\n", c.paint(ansiRed, "[--]"), port)
	}
	if saved != nil {
		bind, auth := "127.0.0.1 (this machine only)", "on"
		if saved.LAN {
			bind = "0.0.0.0 (LAN)"
		}
		if saved.NoAuth {
			auth = "off"
		}
		fmt.Fprintf(c.out, "  Bind: %s\n  Auth: %s\n", bind, auth)
		if saved.Tailscale != "" {
			host, tsPort := splitTailscale(saved.Tailscale)
			fmt.Fprintf(c.out, "  Tailscale: https://%s:%s\n", host, tsPort)
		}
	}
	if sup := c.installedSupervisor(); sup != nil {
		fmt.Fprintf(c.out, "  Supervisor: %s\n", sup.Name())
	} else {
		fmt.Fprintf(c.out, "  Supervisor: none (run: termote start)\n")
	}
	fmt.Fprintln(c.out)
	if !running {
		return &exitError{code: 1}
	}
	return nil
}

// cmdUninstall removes the service, Termote's Tailscale mapping, the
// `termote` command and the installed versions. The config (and its saved
// password) and the logs stay; the message names both dirs.
func (c *cli) cmdUninstall(args []string) error {
	if pos, err := parseArgs(c.newFlagSet("uninstall"), args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError("uninstall takes no arguments (the container has its own: termote container down)")
	}
	saved, _ := c.loadConfig()
	c.heading("Termote Uninstall")
	for _, s := range c.supervisors() {
		if s.Installed() {
			if err := s.Uninstall(); err != nil {
				c.warnf("Could not remove the %s registration: %v", s.Name(), err)
			} else {
				c.infof("Removed the %s registration", s.Name())
			}
		}
	}
	if saved != nil {
		c.removeTailscale(saved.Tailscale, c.savedPort(saved))
	}
	c.cmdUnlink()
	if c.isInstalledRelease() {
		c.removeInstall()
	} else if isDir(c.versionsDir()) {
		c.infof("An install in %s was left alone (this command runs from %s); remove it with: %s uninstall", c.dataDir(), c.exe, c.currentExe())
	}
	c.infof("Kept the config in %s and the logs in %s; delete them to forget everything", c.configDir(), c.stateDir())
	return nil
}

// warnExposure prints one line whenever auth is off or the LAN can connect.
func (c *cli) warnExposure(o startOptions) {
	switch {
	case o.noAuth && (o.lan || o.tailscale != ""):
		c.warnf("Auth is OFF and other machines can reach this server: anyone on that network gets a shell. Drop it with --no-auth=false.")
	case o.noAuth:
		c.warnf("Auth is off: any program on this machine can open a shell through the server (turn it on: --no-auth=false)")
	case o.lan:
		c.warnf("LAN access is on: every device on this network can reach the login page (turn it off: --lan=false)")
	}
}

func (c *cli) showAccessInfo(o startOptions, pass string, reused bool) {
	c.heading("Access Info")
	if o.tailscale != "" {
		host, port := splitTailscale(o.tailscale)
		fmt.Fprintf(c.out, "Tailscale: %s\n", c.paint(ansiCyan, "https://"+host+":"+port))
	}
	fmt.Fprintf(c.out, "Local: %s\n", c.paint(ansiCyan, fmt.Sprintf("http://localhost:%d", o.port)))
	if o.lan {
		for _, ip := range c.localIPv4s() {
			fmt.Fprintf(c.out, "LAN: %s\n", c.paint(ansiCyan, fmt.Sprintf("http://%s:%d", ip, o.port)))
		}
	}
	fmt.Fprintf(c.out, "Backend: %s\n", o.mux)
	hosts := slices.Clone(loopbackHosts)
	if o.lan {
		hosts = append(hosts, "this machine's addresses")
	}
	if o.tailscale != "" {
		host, _ := splitTailscale(o.tailscale)
		hosts = append(hosts, host)
	}
	fmt.Fprintf(c.out, "Allowed hosts: %s\n", strings.Join(append(hosts, o.allowHosts...), ", "))
	fmt.Fprintf(c.out, "%s\n", c.paint(ansiDim, "  (another name? add it with: termote start --allow-host <name>)"))
	c.warnExposure(o)
	if pass == "" {
		return
	}
	if reused {
		c.infof("Using the saved password (show it with: termote show-password; new one: termote start --fresh)")
		return
	}
	c.showCredentials(pass)
}

func (c *cli) showCredentials(pass string) {
	line := c.paint(ansiBold, "============================================")
	fmt.Fprintf(c.out, "\n%s\n  %s\n  Username: %s\n  Password: %s\n%s\n%s\n", line,
		c.paint(ansiGreen, "TERMOTE CREDENTIALS"),
		c.paint(ansiCyan, adminUser), c.paint(ansiCyan, pass),
		c.paint(ansiDim, "  (view it again with: termote show-password)"), line)
}

// portFree reports an error when bind:port cannot be listened on.
func portFree(bind string, port int) error {
	ln, err := net.Listen("tcp", net.JoinHostPort(bind, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	return ln.Close()
}

// tailFile returns the last n lines of a file.
func tailFile(path string, n int) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return "(no log)"
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
