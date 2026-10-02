package main

import (
	"bufio"
	"bytes"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRunner stands in for external commands. Commands are keyed by their
// joined argv; unknown commands fail.
type fakeRunner struct {
	mu      sync.Mutex
	paths   map[string]bool   // LookPath succeeds for these
	outputs map[string]string // Output results
	fail    map[string]bool   // Run/Output fail for these
	calls   []string
	inputs  []string // stdin of RunQuiet calls
	// onOutput, when set, answers Output calls not in outputs (commands
	// with generated arguments such as temp file names).
	onOutput func(argv, env []string) (string, bool)
}

func newFakeRunner(available ...string) *fakeRunner {
	f := &fakeRunner{paths: map[string]bool{}, outputs: map[string]string{}, fail: map[string]bool{}}
	for _, p := range available {
		f.paths[p] = true
	}
	return f
}

func (f *fakeRunner) LookPath(name string) (string, error) {
	if f.paths[name] {
		return "/usr/bin/" + name, nil
	}
	return "", errors.New("not found")
}

func (f *fakeRunner) record(name string, args []string) string {
	key := strings.TrimSpace(name + " " + strings.Join(args, " "))
	f.mu.Lock()
	f.calls = append(f.calls, key)
	f.mu.Unlock()
	return key
}

func (f *fakeRunner) Output(dir string, env []string, name string, args ...string) ([]byte, error) {
	key := f.record(name, args)
	if out, ok := f.outputs[key]; ok {
		return []byte(out), nil
	}
	if f.onOutput != nil {
		if out, ok := f.onOutput(append([]string{name}, args...), env); ok {
			return []byte(out), nil
		}
	}
	return nil, errors.New("fake: no output for " + key)
}

func (f *fakeRunner) Run(dir string, env []string, name string, args ...string) error {
	key := f.record(name, args)
	if f.fail[key] {
		return errors.New("fake: " + key + " failed")
	}
	return nil
}

func (f *fakeRunner) RunQuiet(input string, name string, args ...string) error {
	key := f.record(name, args)
	f.mu.Lock()
	f.inputs = append(f.inputs, input)
	f.mu.Unlock()
	if f.fail[key] {
		return errors.New("fake: " + key + " failed")
	}
	return nil
}

func (f *fakeRunner) called(prefix string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

// testCLI builds a cli rooted in temp dirs: a home for the config and state dirs and a
// project dir laid out like an installed release.
type testCLI struct {
	*cli
	stdout, stderr *bytes.Buffer
	runner         *fakeRunner
	killed         []int
	// env is what c.getenv sees.
	env map[string]string
}

func newTestCLI(t *testing.T, goos string) *testCLI {
	t.Helper()
	root := t.TempDir()
	tc := &testCLI{stdout: &bytes.Buffer{}, stderr: &bytes.Buffer{}, runner: newFakeRunner()}
	tc.runner.outputs["hostname"] = "termote-box\n"
	tc.runner.outputs["whoami"] = "tester\n"
	tc.cli = &cli{
		out:        tc.stdout,
		errOut:     tc.stderr,
		in:         bufio.NewReader(strings.NewReader("")),
		home:       filepath.Join(root, "home"),
		projectDir: filepath.Join(root, "install"),
		exe:        filepath.Join(root, "install", "termote-"+goos+"-amd64"),
		goos:       goos,
		goarch:     "amd64",
		version:    "1.0.0",
		run:        tc.runner,
		readPassword: func() (string, error) {
			return "", errors.New("no terminal")
		},
		procs:        func() ([]procInfo, error) { return nil, nil },
		localIPv4s:   func() []string { return []string{"192.168.1.20", "10.0.0.5"} },
		herdrRunning: func() bool { return false },
		pid:          os.Getpid(),
	}
	tc.env = map[string]string{"PATH": "/usr/bin:/bin"}
	tc.cli.getenv = func(k string) string { return tc.env[k] }
	tc.cli.terminate = func(pid int, _ time.Duration) error {
		tc.killed = append(tc.killed, pid)
		return nil
	}
	for _, d := range []string{tc.home, filepath.Join(tc.projectDir, "scripts")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return tc
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchVersionHelpUnknown(t *testing.T) {
	tc := newTestCLI(t, runtime.GOOS)
	if code := tc.main([]string{"version"}); code != 0 || tc.stdout.String() != "Termote v1.0.0\n" {
		t.Fatalf("version: code %d, out %q", code, tc.stdout.String())
	}
	tc.stdout.Reset()
	if code := tc.main([]string{"help"}); code != 0 || !strings.Contains(tc.stdout.String(), "show-password") {
		t.Fatalf("help: code %d, out %q", code, tc.stdout.String())
	}
	if code := tc.main([]string{"bogus"}); code != 2 || !strings.Contains(tc.stderr.String(), "unknown command: bogus") {
		t.Fatalf("unknown: code %d, err %q", code, tc.stderr.String())
	}
}

func TestHelpShowsWindowsDefaultPort(t *testing.T) {
	tc := newTestCLI(t, "windows")
	tc.printHelp()
	out := tc.stdout.String()
	for _, want := range []string{"Usage: termote", "--allow-host", "(default: 7690)"} {
		if !strings.Contains(out, want) {
			t.Errorf("windows help misses %q", want)
		}
	}
}

func TestParseArgsInterleaved(t *testing.T) {
	var lan bool
	var port int
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.BoolVar(&lan, "lan", false, "")
	fs.IntVar(&port, "port", 0, "")
	pos, err := parseArgs(fs, []string{"--lan", "native", "--port", "9000", "extra"})
	if err != nil {
		t.Fatal(err)
	}
	if !lan || port != 9000 || strings.Join(pos, ",") != "native,extra" {
		t.Fatalf("lan=%v port=%d pos=%v", lan, port, pos)
	}
}

func TestFindProjectDir(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "scripts"), 0o755)
	os.MkdirAll(filepath.Join(root, "server"), 0o755)
	other := t.TempDir()
	cases := []struct{ exe, env, want string }{
		{filepath.Join(root, "termote-linux-amd64"), "", root},     // release: binary in the root
		{filepath.Join(root, "server", "termote-dev"), "", root},   // checkout build
		{filepath.Join(root, "termote-linux-amd64"), other, other}, // shim override
	}
	for _, c := range cases {
		if got := findProjectDir(c.exe, c.env); got != c.want {
			t.Errorf("findProjectDir(%q, %q) = %q, want %q", c.exe, c.env, got, c.want)
		}
	}
}

func TestConfigAndStateDirs(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if got, want := tc.configFile(), filepath.Join(tc.home, ".config", "termote", "config"); got != want {
		t.Errorf("configFile = %q, want %q", got, want)
	}
	if got, want := tc.pidFile(), filepath.Join(tc.home, ".local", "state", "termote", "termote.pid"); got != want {
		t.Errorf("pidFile = %q, want %q", got, want)
	}
	cfg, state := filepath.Join(tc.home, "cfg"), filepath.Join(tc.home, "st")
	env := map[string]string{"XDG_CONFIG_HOME": cfg, "XDG_STATE_HOME": state}
	tc.getenv = func(k string) string { return env[k] }
	if got := tc.configDir(); got != filepath.Join(cfg, "termote") {
		t.Errorf("configDir with XDG_CONFIG_HOME = %q", got)
	}
	if got := tc.logDir(); got != filepath.Join(state, "termote") {
		t.Errorf("logDir with XDG_STATE_HOME = %q", got)
	}
	// A relative XDG path is ignored, as the spec requires.
	env["XDG_CONFIG_HOME"] = "relative"
	if got := tc.configDir(); got != filepath.Join(tc.home, ".config", "termote") {
		t.Errorf("configDir with relative XDG_CONFIG_HOME = %q", got)
	}

	win := newTestCLI(t, "windows")
	if got, want := win.configFile(), filepath.Join(win.home, "AppData", "Roaming", "termote", "config.json"); got != want {
		t.Errorf("windows configFile = %q, want %q", got, want)
	}
	if got, want := win.stateDir(), filepath.Join(win.home, "AppData", "Local", "termote", "state"); got != want {
		t.Errorf("windows stateDir = %q, want %q", got, want)
	}
	appData := filepath.Join(win.home, "roaming")
	win.getenv = func(k string) string {
		if k == "APPDATA" {
			return appData
		}
		return ""
	}
	if got := win.configDir(); got != filepath.Join(appData, "termote") {
		t.Errorf("windows configDir with APPDATA = %q", got)
	}
}
