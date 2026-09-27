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
	containerName     = "termote"
	containerPort     = 7680 // tmux-api port inside the container
	adminUser         = "admin"
	updateRepo        = "lamngockhuong/termote"
	defaultLogLines   = 50
	serverStartWait   = 8 * time.Second
	legacyTtydPort    = "7681"
	legacyTmuxSession = "main"
)

// commandRunner runs external programs; tests replace it with a fake.
type commandRunner interface {
	LookPath(name string) (string, error)
	// Output runs a command and returns its stdout.
	Output(dir string, env []string, name string, args ...string) ([]byte, error)
	// Run runs a command attached to the user's terminal (sudo, compose, pnpm).
	Run(dir string, env []string, name string, args ...string) error
}

type execRunner struct{}

func (execRunner) LookPath(name string) (string, error) { return exec.LookPath(name) }

func (execRunner) Output(dir string, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = env
	return cmd.Output()
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
	// execShim replaces this process with the shim (update's last step).
	execShim func(path string, args []string) error
	// readPassword reads a line without echo from the terminal.
	readPassword func() (string, error)
	// procs lists running processes and terminate stops one, for stopping
	// services.
	procs     func() ([]procInfo, error)
	terminate func(pid int, wait time.Duration) error
	// localIPv4s lists this machine's LAN addresses.
	localIPv4s func() []string
	// pid of this process, never stopped.
	pid int
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
		execShim:     execReplace,
		procs:        listProcesses,
		terminate:    terminateProcess,
		localIPv4s:   localIPv4s,
		pid:          os.Getpid(),
	}
	c.readPassword = func() (string, error) { return readPasswordNoEcho(os.Stdin, c.in) }
	c.projectDir = findProjectDir(exe, os.Getenv("TERMOTE_PROJECT_DIR"))
	c.version = c.loadVersion()
	return c, nil
}

// findProjectDir locates the install (or checkout) root: the shim exports
// TERMOTE_PROJECT_DIR; otherwise a release binary sits in the root and a
// checkout build sits in tmux-api/.
func findProjectDir(exe, env string) string {
	if env != "" {
		if abs, err := filepath.Abs(env); err == nil {
			return abs
		}
		return env
	}
	dir := filepath.Dir(exe)
	if filepath.Base(dir) == "tmux-api" && isDir(filepath.Join(filepath.Dir(dir), "scripts")) {
		return filepath.Dir(dir)
	}
	return dir
}

func (c *cli) main(args []string) int {
	c.cleanupReplacedBinaries()
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
	case "install":
		return c.cmdInstall(args)
	case "uninstall":
		return c.cmdUninstall(args)
	case "update":
		return c.cmdUpdate(args)
	case "health":
		return c.cmdHealth(args)
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

// Output helpers, matching the [INFO]/[WARN]/[ERROR] lines of 0.x.
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

// Paths under ~/.termote. The config file and its format are the 0.x ones.
func (c *cli) configDir() string { return filepath.Join(c.home, ".termote") }
func (c *cli) logDir() string    { return filepath.Join(c.configDir(), "logs") }
func (c *cli) pidFile() string   { return filepath.Join(c.configDir(), "tmux-api.pid") }

func (c *cli) configFile() string {
	if c.goos == "windows" {
		return filepath.Join(c.configDir(), "config.json")
	}
	return filepath.Join(c.configDir(), "config")
}

// defaultPort is 7690 on Windows (0.x kept 7680 free for the container) and
// 7680 elsewhere.
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

// loadVersion prefers the .version file an install or update writes.
func (c *cli) loadVersion() string {
	if !c.isCheckout() {
		if b, err := os.ReadFile(filepath.Join(c.projectDir, ".version")); err == nil {
			if v := strings.TrimSpace(string(b)); v != "" {
				return v
			}
		}
	}
	return cliVersion
}

// shimPath is the script 0.x and `link` call; its path is a contract with 0.x.
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
	ps := c.goos == "windows"
	name := "termote.sh"
	if ps {
		name = "termote.ps1"
	}
	opt := func(unix, win string) string {
		if ps {
			return win
		}
		return unix
	}
	fmt.Fprintf(c.out, `Termote v%s - Terminal + Remote

Usage: %s [command] [options]

Commands:
  install <mode>    Install and start services (mode: native, container)
  uninstall <mode>  Remove installation (mode: native, container, all)
  update            Update to the latest release
  health            Check service health
  logs [service]    View logs (tmux-api, all, follow, clean)
  link              Create 'termote' global command
  unlink            Remove global command
  show-password     Show the saved admin password
  version           Show version
  help              Show this help
  (no command)      Interactive menu

Options:
  %-24s Host port (default: %d)
  %-24s Expose to LAN
  %-24s Enable Tailscale HTTPS
  %-24s Disable authentication
  %-24s Terminal backend, native only (default: tmux)
  %-24s Allow another Host name (repeatable)
  %-24s Allow herdr without auth
  %-24s Ignore saved config, set a new password
  %-24s Update to a specific version
  %-24s Reinstall the current version (with update)
`, c.version, name,
		opt("--port <port>", "-Port <port>"), c.defaultPort(),
		opt("--lan", "-Lan"),
		opt("--tailscale <host[:port]>", "-Tailscale <host[:port]>"),
		opt("--no-auth", "-NoAuth"),
		opt("--mux <tmux|herdr>", "-Mux <tmux|herdr>"),
		opt("--allow-host <name>", "-AllowHost <name>"),
		opt("--allow-herdr-no-auth", "-AllowHerdrNoAuth"),
		opt("--fresh", "-Fresh"),
		opt("--version <X.Y.Z>", "-Version <X.Y.Z>"),
		opt("--force", "-Force"))
}
