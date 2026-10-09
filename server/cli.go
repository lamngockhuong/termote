package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Defaults shared by every subcommand.
const (
	containerName   = "termote"
	containerPort   = 7680 // server port inside the container
	adminUser       = "admin"
	updateRepo      = "lamngockhuong/termote"
	defaultLogLines = 50
)

// commandRunner runs external programs; tests replace it with a fake.
type commandRunner interface {
	LookPath(name string) (string, error)
	// Output runs a command and returns its stdout.
	Output(dir string, env []string, name string, args ...string) ([]byte, error)
	// Run runs a command attached to the user's terminal (sudo, compose, pnpm).
	Run(dir string, env []string, name string, args ...string) error
	// RunQuiet runs a command with input on its stdin and its output
	// discarded, so a child it leaves running (a browser) holds no pipe open
	// and the call returns when the command itself exits.
	RunQuiet(input string, name string, args ...string) error
}

type execRunner struct{}

func (execRunner) LookPath(name string) (string, error) { return exec.LookPath(name) }

func (execRunner) Output(dir string, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = env
	return cmd.Output()
}

func (execRunner) RunQuiet(input string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdin = strings.NewReader(input)
	return cmd.Run()
}

func (execRunner) Run(dir string, env []string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// cli carries everything a subcommand touches outside the process, so tests
// can point it at temp dirs, fake commands and a fake GitHub.
type cli struct {
	out, errOut io.Writer
	in          *bufio.Reader
	// interactive is true when stdin is a terminal: prompts are allowed.
	interactive bool
	color       bool
	// outTTY is true when stdout is a terminal (OSC 52 copy, panel redraws).
	outTTY bool
	// readKey reads one key press from the terminal without waiting for Enter.
	readKey func() (byte, error)

	home       string
	projectDir string
	exe        string // path of the running binary
	goos       string
	goarch     string
	version    string

	run  commandRunner
	http *http.Client
	// apiBase and downloadBase point at api.github.com and github.com.
	apiBase      string
	downloadBase string
	// readPassword reads a line without echo from the terminal.
	readPassword func() (string, error)
	// procs lists running processes and terminate stops one, for stopping
	// services.
	procs     func() ([]procInfo, error)
	terminate func(pid int, wait time.Duration) error
	// localIPv4s lists this machine's LAN addresses.
	localIPv4s func() []string
	// herdrRunning reports whether herdr's server answers on its socket.
	herdrRunning func() bool
	// detachedExited closes when a server this CLI started detached exits.
	detachedExited <-chan struct{}
	// degradedWarned is set once waitForServer has warned that the backend
	// does not answer, so update's later checks do not repeat it.
	degradedWarned bool
	// startHidden runs a PowerShell script in a detached process with no
	// window that outlives this one (Windows only; uninstall's late cleanup).
	startHidden func(script string) error
	// testSupervisors replaces the OS supervisors in tests.
	testSupervisors []supervisor
	// pid of this process, never stopped.
	pid int
	// getenv reads the environment (XDG and Windows profile dirs).
	getenv func(string) string
}

// exitError ends the CLI with a status code; msg may be empty when the
// command already printed what went wrong.
type exitError struct {
	code int
	msg  string
}

func (e *exitError) Error() string { return e.msg }

// usageError is an invalid invocation; it exits with status 2.
func usageError(format string, a ...any) error {
	return &exitError{code: 2, msg: fmt.Sprintf(format, a...)}
}

// runCLI dispatches a subcommand and returns the process exit status.
func runCLI(args []string) int {
	c, err := newCLI()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[ERROR] %v\n", err)
		return 1
	}
	return c.main(args)
}

func newCLI() (*cli, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	c := &cli{
		out:         os.Stdout,
		errOut:      os.Stderr,
		in:          bufio.NewReader(os.Stdin),
		interactive: isTerminal(os.Stdin),
		color:       isTerminal(os.Stdout) && enableTerminalColor(),
		outTTY:      isTerminal(os.Stdout),
		readKey:     func() (byte, error) { return readKeyRaw(os.Stdin) },
		home:        home,
		exe:         exe,
		goos:        runtime.GOOS,
		goarch:      runtime.GOARCH,
		run:         execRunner{},
		// Bound the wait for headers only; a large tarball on a slow link
		// may take longer than any fixed total timeout.
		http: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ResponseHeaderTimeout: 30 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
		}},
		apiBase:      "https://api.github.com",
		downloadBase: "https://github.com",
		procs:        listProcesses,
		terminate:    terminateProcess,
		localIPv4s:   localIPv4s,
		herdrRunning: herdrReachable,
		startHidden:  startHiddenPowerShell,
		pid:          os.Getpid(),
		getenv:       os.Getenv,
	}
	c.readPassword = func() (string, error) { return readPasswordNoEcho(os.Stdin, c.in) }
	c.projectDir = findProjectDir(exe, os.Getenv("TERMOTE_PROJECT_DIR"))
	c.version = cliVersion
	return c, nil
}

// findProjectDir locates the install (or checkout) root: the shim exports
// TERMOTE_PROJECT_DIR; otherwise a release binary sits in the root and a
// checkout build sits in server/.
func findProjectDir(exe, env string) string {
	if env != "" {
		if abs, err := filepath.Abs(env); err == nil {
			return abs
		}
		return env
	}
	dir := filepath.Dir(exe)
	if filepath.Base(dir) == "server" && isDir(filepath.Join(filepath.Dir(dir), "scripts")) {
		return filepath.Dir(dir)
	}
	return dir
}

func (c *cli) main(args []string) int {
	if len(args) == 0 {
		args = []string{"help"}
	}
	err := c.dispatch(args[0], args[1:])
	if err == nil {
		return 0
	}
	var ee *exitError
	if errors.As(err, &ee) {
		if ee.msg != "" {
			c.errorf("%s", ee.msg)
		}
		return ee.code
	}
	c.errorf("%v", err)
	return 1
}

func (c *cli) dispatch(cmd string, args []string) error {
	switch cmd {
	case "start":
		return c.cmdStart(args)
	case "stop":
		return c.cmdStop(args)
	case "restart":
		return c.cmdRestart(args)
	case "status", "health":
		return c.cmdStatus(args)
	case "url":
		return c.cmdURL(args)
	case "panel":
		return c.cmdPanel(args)
	case "container":
		return c.cmdContainer(args)
	case "uninstall":
		return c.cmdUninstall(args)
	case "update":
		return c.cmdUpdate(args)
	case "logs":
		return c.cmdLogs(args)
	case "link":
		return c.cmdLink()
	case "unlink":
		return c.cmdUnlink()
	case "show-password":
		return c.cmdShowPassword()
	case "menu":
		return c.cmdMenu()
	case "version", "-v", "--version":
		fmt.Fprintf(c.out, "Termote v%s\n", c.version)
		return nil
	case "help", "-h", "--help":
		c.printHelp()
		return nil
	case "install":
		c.printHelp()
		return usageError("install was replaced by: termote start [options] (native) and termote container up (container)")
	}
	c.printHelp()
	return usageError("unknown command: %s", cmd)
}

// parseArgs parses flags that may appear before, between or after positional
// arguments ("install --lan native" and "install native --lan" both work).
func parseArgs(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		rest := fs.Args()
		if len(rest) == 0 {
			return pos, nil
		}
		if rest[0] == "--" {
			return append(pos, rest[1:]...), nil
		}
		pos = append(pos, rest[0])
		args = rest[1:]
	}
}

// newFlagSet returns a FlagSet whose errors come back as usage errors.
func (c *cli) newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func flagErr(err error) error {
	if errors.Is(err, flag.ErrHelp) {
		return usageError("see: termote help")
	}
	return usageError("%v", err)
}

// stringList is a repeatable string flag.
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

// Output helpers: [INFO]/[WARN]/[ERROR] lines.
const (
	ansiRed    = "\033[0;31m"
	ansiGreen  = "\033[0;32m"
	ansiYellow = "\033[1;33m"
	ansiCyan   = "\033[0;36m"
	ansiBold   = "\033[1m"
	ansiDim    = "\033[2m"
	ansiReset  = "\033[0m"
)

func (c *cli) paint(color, s string) string {
	if !c.color {
		return s
	}
	return color + s + ansiReset
}

func (c *cli) infof(format string, a ...any) {
	fmt.Fprintf(c.out, "%s %s\n", c.paint(ansiGreen, "[INFO]"), fmt.Sprintf(format, a...))
}

func (c *cli) warnf(format string, a ...any) {
	fmt.Fprintf(c.out, "%s %s\n", c.paint(ansiYellow, "[WARN]"), fmt.Sprintf(format, a...))
}

func (c *cli) errorf(format string, a ...any) {
	fmt.Fprintf(c.errOut, "%s %s\n", c.paint(ansiRed, "[ERROR]"), fmt.Sprintf(format, a...))
}

func (c *cli) stepf(step, format string, a ...any) {
	fmt.Fprintf(c.out, "%s %s\n", c.paint(ansiCyan, "["+step+"]"), fmt.Sprintf(format, a...))
}

func (c *cli) heading(s string) {
	fmt.Fprintf(c.out, "\n%s\n\n", c.paint(ansiBold, "=== "+s+" ==="))
}

// configDir holds the config file: $XDG_CONFIG_HOME/termote (default
// ~/.config/termote), or %APPDATA%\termote on Windows.
func (c *cli) configDir() string {
	if c.goos == "windows" {
		return filepath.Join(c.envDir("APPDATA", filepath.Join(c.home, "AppData", "Roaming")), "termote")
	}
	return filepath.Join(c.envDir("XDG_CONFIG_HOME", filepath.Join(c.home, ".config")), "termote")
}

// stateDir holds logs and the PID file: $XDG_STATE_HOME/termote (default
// ~/.local/state/termote), or %LOCALAPPDATA%\termote\state on Windows.
func (c *cli) stateDir() string {
	if c.goos == "windows" {
		return filepath.Join(c.envDir("LOCALAPPDATA", filepath.Join(c.home, "AppData", "Local")), "termote", "state")
	}
	return filepath.Join(c.envDir("XDG_STATE_HOME", filepath.Join(c.home, ".local", "state")), "termote")
}

func (c *cli) logDir() string  { return c.stateDir() }
func (c *cli) pidFile() string { return filepath.Join(c.stateDir(), "termote.pid") }

// envDir returns the directory in env var key, or fallback when it is unset
// or relative (the XDG spec says to ignore a relative path).
func (c *cli) envDir(key, fallback string) string {
	if c.getenv != nil {
		if v := c.getenv(key); v != "" && filepath.IsAbs(v) {
			return v
		}
	}
	return fallback
}

func (c *cli) configFile() string {
	if c.goos == "windows" {
		return filepath.Join(c.configDir(), "config.json")
	}
	return filepath.Join(c.configDir(), "config")
}

// defaultPort is 7690 on Windows, which keeps 7680 free for the container,
// and 7680 elsewhere.
func (c *cli) defaultPort() int {
	if c.goos == "windows" {
		return 7690
	}
	return containerPort
}

func (c *cli) exeSuffix() string {
	if c.goos == "windows" {
		return ".exe"
	}
	return ""
}

// isCheckout reports a git checkout (dev mode) rather than an installed release.
func (c *cli) isCheckout() bool {
	return fileExists(filepath.Join(c.projectDir, "pwa", "package.json")) ||
		fileExists(filepath.Join(c.projectDir, ".git"))
}

// shimPath is the checkout shim `link` points the global command at.
func (c *cli) shimPath() string {
	if c.goos == "windows" {
		return filepath.Join(c.projectDir, "scripts", "termote.ps1")
	}
	return filepath.Join(c.projectDir, "scripts", "termote.sh")
}

// environ returns the current environment with overrides applied.
func environ(overrides map[string]string) []string {
	env := make([]string, 0, len(os.Environ())+len(overrides))
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if _, ok := overrides[k]; ok {
			continue
		}
		env = append(env, kv)
	}
	for k, v := range overrides {
		env = append(env, k+"="+v)
	}
	return env
}

// prompt asks a question and returns the trimmed answer.
func (c *cli) prompt(question string) string {
	fmt.Fprint(c.out, question)
	line, _ := c.in.ReadString('\n')
	return strings.TrimSpace(line)
}

// confirm asks a yes/no question; the default is no.
func (c *cli) confirm(question string) bool {
	a := strings.ToLower(c.prompt(question + " [y/N]: "))
	return a == "y" || a == "yes"
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func isDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

func (c *cli) printHelp() {
	fmt.Fprintf(c.out, `Termote v%s - Terminal + Remote

Usage: termote [command] [options]

Commands:
  start [options]      Save the options, register the service and start it
  stop                 Stop the server (it starts again at the next login)
  restart              Stop and start with the saved options
  status [--json]      Show what the running server reports (alias: health)
  url [options]        Print the link to open, or to one session (see below)
  panel                Status, links and a QR code; keys open, copy, start, stop, restart
  container <cmd>      Run the server in a container: up, down, logs [-f], status
  update               Update to the latest release
  uninstall [--purge]  Remove the service, the command, the install and uploaded images
                       (config, logs and deleted files stay; --purge removes them too)
  logs [service]       View logs (server, all, follow, clean)
  link / unlink        Create or remove the 'termote' command in ~/.local/bin
  show-password        Show the saved username and password
  version              Show version
  serve                Run the server in the foreground (what the service runs)
  (no command)         Interactive menu

Options of start (saved; a flag not given keeps its saved value):
  --port <port>              Port (default: %d)
  --lan[=false]              Listen on every interface, not only this machine
  --tailscale <host[:port]>  Publish over Tailscale HTTPS (default port 443)
  --no-tailscale             Stop publishing over Tailscale
  --no-auth[=false]          Disable authentication
  --mux <tmux|herdr>         Terminal backend (default: herdr when it runs, else tmux)
  --allow-host <name>        Allow another Host name (repeatable)
  --remove-host <name>       Remove an allowed Host name (repeatable)
  --allow-herdr-no-auth      Allow herdr without auth
  --user <name>              Login username (default: admin; shared with the container)
  --fresh                    Set a new password

Options of container up (saved apart from start's; the username and password are shared):
  --port --lan --tailscale --no-tailscale --no-auth --allow-host --remove-host --user --fresh
  --workspace <dir>          Directory mounted at /workspace (default: ~/termote-workspace)
  --mux <tmux|herdr>         Backend inside the container (asked the first time, else tmux)
  --allow-herdr-no-auth      Allow herdr without auth
  --build                    Build the image from a checkout instead of pulling it

Options of url (the Herdr plugin runs: url --herdr --open):
  --herdr                    The session the Herdr plugin was invoked on
  --group <id> --tab <id> [--pane <id>]   Select a session (ids of /api/mux/snapshot)
  --view <terminal|chat|files|changes>    The view to open on it
  --open / --copy / --qr     Open it in the browser, copy it, print a QR code

Options of update:
  --version <X.Y.Z>          Update to a specific version
  --force                    Reinstall the current version
`, c.version, c.defaultPort())
}
