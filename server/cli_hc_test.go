package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// relRunner finds hc at a path relative to the current directory, as
// exec.LookPath does for an entry like "." in PATH: with exec.ErrDot.
type relRunner struct{ *fakeRunner }

func (relRunner) LookPath(string) (string, error) { return "./hc", exec.ErrDot }

// testHcBin is an absolute path to hc on the host running the test: on
// Windows filepath.IsAbs needs a volume, so /usr/bin/hc is not one there.
var testHcBin = func() string {
	if runtime.GOOS == "windows" {
		return `C:\hc\hc.exe`
	}
	return "/usr/bin/hc"
}()

// absHcRunner finds hc, once on the fake PATH, at testHcBin.
type absHcRunner struct{ *fakeRunner }

func (r absHcRunner) LookPath(name string) (string, error) {
	if !r.paths[name] {
		return "", exec.ErrNotFound
	}
	return testHcBin, nil
}

func TestValidateMuxHc(t *testing.T) {
	if err := validateMux("hc", false, false, false); err != nil {
		t.Errorf("hc with auth refused: %v", err)
	}
	if err := validateMux("hc", true, false, false); err == nil || !strings.Contains(err.Error(), "--allow-hc-no-auth") {
		t.Errorf("hc --no-auth without --allow-hc-no-auth: %v", err)
	}
	// herdr's flag does not allow hc, nor hc's herdr.
	if err := validateMux("hc", true, true, false); err == nil {
		t.Error("--allow-herdr-no-auth let hc run without auth")
	}
	if err := validateMux("herdr", true, false, true); err == nil {
		t.Error("--allow-hc-no-auth let herdr run without auth")
	}
	if err := validateMux("hc", true, false, true); err != nil {
		t.Errorf("hc --no-auth --allow-hc-no-auth refused: %v", err)
	}
	if err := validateMux("screen", false, false, false); err == nil || !strings.Contains(err.Error(), "hc") {
		t.Errorf("unknown backend does not list hc: %v", err)
	}
}

func TestFindHc(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.run = absHcRunner{tc.runner}
	if _, err := tc.findHc(); err == nil || !strings.Contains(err.Error(), "herdr.dev/core") {
		t.Fatalf("missing = %v", err)
	}
	tc.runner.paths["hc"] = true
	if _, err := tc.findHc(); err == nil || !strings.Contains(err.Error(), "could not read the hc version") {
		t.Fatalf("no version = %v", err)
	}
	tc.runner.outputs[testHcBin+" --version"] = "hc 0.1.15\n"
	if _, err := tc.findHc(); err == nil || !strings.Contains(err.Error(), "hc update") {
		t.Fatalf("0.1.15 = %v", err)
	}
	tc.runner.outputs[testHcBin+" --version"] = "hc 0.1.16 (built 2026-11-01)\n"
	if bin, err := tc.findHc(); err != nil || bin != testHcBin {
		t.Fatalf("0.1.16 = %q, %v", bin, err)
	}
	if err := tc.preflight("hc"); err != nil {
		t.Fatalf("preflight = %v", err)
	}
	tc.run = relRunner{tc.runner}
	if _, err := tc.findHc(); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("relative hc = %v", err)
	}
}

// --no-auth with hc is refused before anything is saved, and the flag that
// allows it is kept like herdr's.
func TestStartHcNoAuth(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.procs = func() ([]procInfo, error) { t.Fatal("services touched"); return nil, nil }
	if code := tc.main([]string{"start", "--mux", "hc", "--no-auth"}); code != 2 || !strings.Contains(tc.stderr.String(), "--allow-hc-no-auth") {
		t.Fatalf("code %d stderr %s", code, tc.stderr.String())
	}
	if fileExists(tc.configFile()) {
		t.Fatal("config saved for a refused start")
	}
	// hc missing: refused by its preflight, not started.
	tc.stderr.Reset()
	if code := tc.main([]string{"start", "--mux", "hc"}); code == 0 || !strings.Contains(tc.stderr.String(), "hc not found") {
		t.Fatalf("missing hc: code %d stderr %s", code, tc.stderr.String())
	}

	var o startOptions
	mergeSaved(&o, map[string]bool{}, &savedConfig{HcAllowNoAuth: true, HcEnv: hcEnv{Session: "work"}})
	if !o.hcNoAuth || o.hcEnv.Session != "work" {
		t.Errorf("saved hc options not kept: %+v", o)
	}
	// The shell's session wins; one it lacks stays as saved.
	tc.env = map[string]string{"HC_SOCKET": "/run/hc.sock"}
	if got := tc.shellHcEnv(hcEnv{Session: "work", Socket: "/old.sock"}); got != (hcEnv{Session: "work", Socket: "/run/hc.sock"}) {
		t.Errorf("shell hc env %+v", got)
	}
	o = startOptions{hcNoAuth: false}
	mergeSaved(&o, map[string]bool{"allow-hc-no-auth": true}, &savedConfig{HcAllowNoAuth: true})
	if o.hcNoAuth {
		t.Error("--allow-hc-no-auth=false did not replace the saved value")
	}
}

func TestHcConfigRoundTrip(t *testing.T) {
	in := savedConfig{Port: 7680, Mux: "hc", HcBin: "/home/u/.local/bin/hc", HcAllowNoAuth: true, NoAuth: true,
		HcEnv: hcEnv{Session: "work", Socket: "/run/hc.sock"}}
	data, err := formatUnixConfig(in, strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	out, err := parseUnixConfig(data, func() string { return "" })
	if err != nil || out.HcBin != in.HcBin || !out.HcAllowNoAuth || out.Mux != "hc" || out.HcEnv != in.HcEnv {
		t.Fatalf("unix round trip %+v %v", out, err)
	}
	// Another backend saves no hc keys.
	data, _ = formatUnixConfig(savedConfig{Port: 7680, Mux: "tmux"}, strings.Repeat("ab", 32))
	if strings.Contains(string(data), "TERMOTE_HC_") {
		t.Errorf("tmux config holds hc keys:\n%s", data)
	}
	// A path that would break the file is refused.
	if _, err := formatUnixConfig(savedConfig{Mux: "hc", HcBin: "/x\"y"}, strings.Repeat("ab", 32)); err == nil {
		t.Error("a quote in the hc path was saved")
	}

	fakeDPAPI(t)
	win := savedConfig{Port: 7690, Mux: "hc", HcBin: `C:\Users\u\bin\hc.exe`, HcAllowNoAuth: true, HcEnv: hcEnv{Session: "work"}}
	wdata, err := formatWindowsConfig(win, time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	wout, err := parseWindowsConfig(wdata)
	if err != nil || wout.HcBin != win.HcBin || !wout.HcAllowNoAuth || wout.HcEnv != win.HcEnv {
		t.Fatalf("windows round trip %+v %v", wout, err)
	}

	sc := serveConfigFromSaved(*out, 7680)
	if sc.MuxBackend != "hc" || sc.HcBin != in.HcBin || !sc.HcAllowNoAuth || sc.HcEnv != in.HcEnv {
		t.Errorf("serve config %+v", sc)
	}
}

func TestServeRefusesHcWithoutAuth(t *testing.T) {
	cfg := serveConfig{NoAuth: true, MuxBackend: "hc"}
	if err := validateConfig(cfg); err == nil || !strings.Contains(err.Error(), "TERMOTE_HC_ALLOW_NO_AUTH") {
		t.Errorf("hc no-auth: %v", err)
	}
	cfg.HerdrAllowNoAuth = true
	if err := validateConfig(cfg); err == nil {
		t.Error("herdr's allow let hc run without auth")
	}
	cfg.HcAllowNoAuth = true
	if err := validateConfig(cfg); err != nil {
		t.Errorf("hc no-auth allowed: %v", err)
	}
}

func TestNewMuxHc(t *testing.T) {
	if runningInContainer() {
		t.Skip("the container refusal is what runs here")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := newMux(ctx, serveConfig{MuxBackend: "hc", HcBin: "hc"}); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Errorf("relative hc: %v", err)
	}
	// The saved session, never the serve process's own HC_* variables.
	t.Setenv("HC_SESSION", "other")
	t.Setenv("HC_TERMINAL_ID", "t9")
	m, err := newMux(ctx, serveConfig{MuxBackend: "hc", HcBin: testHcBin, HcEnv: hcEnv{Session: "work"}})
	if err != nil || m.Name() != "hc" {
		t.Fatalf("newMux(hc) = %v, %v", m, err)
	}
	env := m.(*hcMux).client.env
	if hcEnvValue(env, "HC_SESSION") != "work" || hcEnvValue(env, "HC_TERMINAL_ID") != "" {
		t.Errorf("hc connect env: session %q, terminal id %q", hcEnvValue(env, "HC_SESSION"), hcEnvValue(env, "HC_TERMINAL_ID"))
	}
	if maxStreamsFor(m) != maxHerdrStreams {
		t.Errorf("hc stream limit %d", maxStreamsFor(m))
	}
	// Without a saved config: hc from PATH, absolute.
	t.Setenv("PATH", filepath.Join(t.TempDir(), "none"))
	if _, err := newMux(ctx, serveConfig{MuxBackend: "hc"}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("hc missing from PATH: %v", err)
	}
}

func TestContainerUpRefusesHc(t *testing.T) {
	cc := newContainerCLI(t)
	for _, args := range [][]string{{"--mux", "hc"}, {"--mux", "hc", "--no-auth"}} {
		cc.stderr.Reset()
		if code := cc.main(append([]string{"container", "up"}, args...)); code != 2 || !strings.Contains(cc.stderr.String(), "not available in a container") || cc.runArgs != nil {
			t.Fatalf("%v: code %d stderr %s", args, code, cc.stderr.String())
		}
	}
}

func TestHcCLIMessages(t *testing.T) {
	if msg := degradedBackendMsg("hc"); !strings.Contains(msg, "herdr-core") {
		t.Errorf("degraded hc: %s", msg)
	}
	tc := newTestCLI(t, "linux")
	tc.env = map[string]string{"PATH": "/usr/bin", "HC_SESSION": "work", "HC_SOCKET": "/run/hc.sock", "HC_TERMINAL_ID": "t3"}
	// The config carries the core's session, not the service's environment.
	env := tc.serviceEnv()
	if env["HC_SESSION"] != "" || env["HC_SOCKET"] != "" || env["HC_TERMINAL_ID"] != "" {
		t.Errorf("service env %v", env)
	}
	var help strings.Builder
	tc.out = &help
	tc.printHelp()
	if !strings.Contains(help.String(), "--allow-hc-no-auth") || !strings.Contains(help.String(), "tmux|herdr|zellij|hc") {
		t.Errorf("help lacks hc:\n%s", help.String())
	}
}

// The menu asks before running hc without auth; declining starts nothing.
func TestMenuStartHcNoAuth(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.procs = func() ([]procInfo, error) { t.Fatal("services touched"); return nil, nil }
	// hc, no LAN, no auth, then decline exposing every terminal.
	tc.in = bufio.NewReader(strings.NewReader("5\nn\ny\nn\n"))
	if err := tc.menuStart(); err == nil || err.Error() != "cancelled" {
		t.Fatalf("declined: %v", err)
	}
	// Accepted: start runs with --allow-hc-no-auth (and fails on the
	// missing hc, before any service is touched).
	tc.in = bufio.NewReader(strings.NewReader("5\nn\ny\ny\nn\n"))
	if err := tc.menuStart(); err == nil || !strings.Contains(err.Error(), "hc not found") {
		t.Fatalf("accepted: %v", err)
	}
}

// A new hc group takes no name: herdr-app names a space after its folder.
func TestHcGroupCreateTakesNoName(t *testing.T) {
	s := newHcSim(t)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	cfg := testConfig(t)
	cfg.RecentGroupsDir = t.TempDir()
	h, err := newServeHandler(cfg, s.m)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", "ignored name"} {
		rec := serve(h, apiRequest("POST", "/api/mux/groups", jsonBody(map[string]string{"name": name, "cwd": dir})))
		if rec.Code != 200 {
			t.Fatalf("name %q: %d %s", name, rec.Code, rec.Body)
		}
	}
	runs := s.runCalls()
	if len(runs) != 2 {
		t.Fatalf("runs %v", runs)
	}
	for _, r := range runs {
		b, _ := json.Marshal(r)
		if strings.Contains(string(b), "ignored name") {
			t.Errorf("the name reached the core: %s", b)
		}
	}
	// Listed in the recent groups under its folder's name, as herdr-app
	// names the space.
	rec := serve(h, apiRequest("GET", "/api/mux/recent-groups", ""))
	if !strings.Contains(rec.Body.String(), `"name":"`+filepath.Base(dir)+`"`) {
		t.Errorf("recent groups: %s", rec.Body)
	}
	if s.m.Caps().RenameGroup {
		t.Error("hc offers renaming a group")
	}
	if !(tmuxMux{}).Caps().RenameGroup {
		t.Error("tmux lost group renaming")
	}
}
