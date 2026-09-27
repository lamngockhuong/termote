package main

import (
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParseInstallArgs(t *testing.T) {
	tc := newTestCLI(t, "linux")
	o, set, err := tc.parseInstallArgs([]string{"--lan", "docker", "--allow-host", "a.lan", "--allow-host", "b.lan"})
	if err != nil {
		t.Fatal(err)
	}
	if o.mode != "container" || !o.lan || !set["lan"] || set["port"] ||
		strings.Join(o.allowHosts, ",") != "a.lan,b.lan" {
		t.Fatalf("got %+v set %v", o, set)
	}
	if _, _, err := tc.parseInstallArgs(nil); err == nil {
		t.Fatal("missing mode accepted")
	}
	if _, _, err := tc.parseInstallArgs([]string{"native", "--bogus"}); err == nil {
		t.Fatal("unknown flag accepted")
	}
}

func TestMergeSaved(t *testing.T) {
	saved := &savedConfig{LAN: true, NoAuth: true, Port: 7700, Tailscale: "t.ts.net", Mux: "herdr",
		AllowHosts: []string{"saved.lan"}, HerdrAllowNoAuth: true}

	o := installOptions{mode: "native", allowHosts: []string{"new.lan"}}
	mergeSaved(&o, map[string]bool{}, saved)
	if !o.lan || !o.noAuth || o.port != 7700 || o.tailscale != "t.ts.net" || o.mux != "herdr" || !o.herdrNoAuth ||
		strings.Join(o.allowHosts, ",") != "new.lan,saved.lan" {
		t.Fatalf("saved values not applied: %+v", o)
	}

	// Explicit flags win, including --lan=false.
	o = installOptions{mode: "native", port: 9000, mux: "tmux"}
	mergeSaved(&o, map[string]bool{"lan": true, "port": true, "mux": true}, saved)
	if o.lan || o.port != 9000 || o.mux != "tmux" {
		t.Fatalf("explicit flags overridden: %+v", o)
	}

	// A saved herdr backend does not follow a switch to container mode.
	o = installOptions{mode: "container"}
	mergeSaved(&o, map[string]bool{}, saved)
	if o.mux != "" {
		t.Fatalf("container inherited mux %q", o.mux)
	}
}

func TestValidateInstall(t *testing.T) {
	tc := newTestCLI(t, "linux")
	cases := []struct {
		name string
		o    installOptions
		ok   bool
	}{
		{"defaults", installOptions{mode: "native"}, true},
		{"bad mode", installOptions{mode: "vm"}, false},
		{"bad port", installOptions{mode: "native", port: 70000}, false},
		{"herdr in container", installOptions{mode: "container", mux: "herdr"}, false},
		{"herdr no auth", installOptions{mode: "native", mux: "herdr", noAuth: true}, false},
		{"herdr no auth accepted", installOptions{mode: "native", mux: "herdr", noAuth: true, herdrNoAuth: true}, true},
		{"unknown mux", installOptions{mode: "native", mux: "zellij"}, false},
		{"wildcard host", installOptions{mode: "native", allowHosts: []string{"*"}}, false},
		{"tailscale port", installOptions{mode: "native", tailscale: "h.ts.net:abc"}, false},
		{"tailscale ok", installOptions{mode: "native", tailscale: "h.ts.net:8443"}, true},
	}
	for _, c := range cases {
		o := c.o
		err := tc.validateInstall(&o)
		if (err == nil) != c.ok {
			t.Errorf("%s: err = %v, want ok=%v", c.name, err, c.ok)
		}
		if err == nil && (o.port != 7680 && c.o.port == 0 || o.mux == "") {
			t.Errorf("%s: defaults not applied: %+v", c.name, o)
		}
	}
	win := newTestCLI(t, "windows")
	o := installOptions{mode: "native"}
	if err := win.validateInstall(&o); err != nil || o.port != 7690 {
		t.Fatalf("windows default port = %d, %v", o.port, err)
	}
}

func TestComputeAllowedHosts(t *testing.T) {
	ips := []string{"192.168.1.20", "10.0.0.5"}
	got := computeAllowedHosts(installOptions{lan: true, tailscale: "Box.ts.net:8443", allowHosts: []string{"mybox.local", "192.168.1.20"}}, ips)
	if want := "192.168.1.20,10.0.0.5,box.ts.net,mybox.local"; strings.Join(got, ",") != want {
		t.Fatalf("got %v, want %s", got, want)
	}
	if got := computeAllowedHosts(installOptions{}, ips); len(got) != 0 {
		t.Fatalf("local-only install allows %v", got)
	}
}

// A Windows install reached through another spelling of the same directory
// (an 8.3 short name on NTFS; a symlink stands in for it here) still matches.
func TestWindowsMatchersFollowTheFileNotTheSpelling(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows; cli_windows_test.go covers 8.3 names")
	}
	win := newTestCLI(t, "windows")
	for _, f := range []string{win.serverBinary("native"), filepath.Join(win.projectDir, "scripts", "other.exe")} {
		if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f, nil, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	alias := filepath.Join(t.TempDir(), "INSTAL~1")
	if err := os.Symlink(win.projectDir, alias); err != nil {
		t.Fatal(err)
	}
	if !win.isServerProcess(procInfo{Exe: filepath.Join(alias, "server", "termote-server.exe")}) {
		t.Error("server under an alias of the install dir not matched")
	}
	// Same directory, different file: never a match.
	if win.isServerProcess(procInfo{Exe: filepath.Join(alias, "scripts", "other.exe")}) {
		t.Error("another program matched as server")
	}
}

func TestServerMatchers(t *testing.T) {
	tc := newTestCLI(t, "linux")
	server := filepath.Join(tc.projectDir, "server", "termote-server")
	yes := []procInfo{
		{Cmdline: server},
		{Cmdline: filepath.Join(tc.projectDir, "server", "termote-dev")},
	}
	no := []procInfo{
		{Cmdline: server + " install native"},
		{Cmdline: "/usr/local/bin/termote-server"},
		{Cmdline: "termote-server"},
	}
	for _, p := range yes {
		if !tc.isServerProcess(p) {
			t.Errorf("server %q not matched", p.Cmdline)
		}
	}
	for _, p := range no {
		if tc.isServerProcess(p) {
			t.Errorf("%q matched as server", p.Cmdline)
		}
	}

	win := newTestCLI(t, "windows")
	if !win.isServerProcess(procInfo{Exe: strings.ToUpper(filepath.Join(win.projectDir, "server", "termote-server.exe"))}) {
		t.Error("windows server not matched case-insensitively")
	}
	if win.isServerProcess(procInfo{Exe: filepath.Join(win.projectDir, "termote-windows-amd64.exe")}) {
		t.Error("windows CLI binary matched as server")
	}
}

func TestStopNativeStopsOnlyTermoteProcesses(t *testing.T) {
	tc := newTestCLI(t, "linux")
	server := filepath.Join(tc.projectDir, "server", "termote-server")
	writeFile(t, tc.pidFile(), "40\n")
	tc.procs = func() ([]procInfo, error) {
		return []procInfo{
			{PID: 10, Cmdline: server},
			{PID: 12, Cmdline: "python3 -m http.server 9000"},
			{PID: 13, Cmdline: "/opt/other/termote-server"},
			{PID: 40, Cmdline: "/somewhere/else/termote-server"}, // found via PID file
			{PID: 41, Cmdline: "vim notes.txt"},
			{PID: tc.pid, Cmdline: server},
		}, nil
	}
	tc.stopNative()
	slices.Sort(tc.killed)
	if want := []int{10, 40}; !slices.Equal(tc.killed, want) {
		t.Fatalf("stopped %v, want %v", tc.killed, want)
	}
	if fileExists(tc.pidFile()) {
		t.Fatal("PID file left behind")
	}
}

func TestSetupAuth(t *testing.T) {
	tc := newTestCLI(t, "linux")
	pass, reused, _ := tc.setupAuth(installOptions{}, &savedConfig{Password: "kept"})
	if pass != "kept" || !reused {
		t.Fatalf("saved password not reused: %q %v", pass, reused)
	}
	pass, reused, _ = tc.setupAuth(installOptions{fresh: true}, &savedConfig{Password: "kept"})
	if pass == "kept" || reused || len(pass) != 12 {
		t.Fatalf("--fresh reused password: %q", pass)
	}
	// Auth on and no saved password: a new one is set, never no auth.
	tc.stdout.Reset()
	pass, _, _ = tc.setupAuth(installOptions{}, &savedConfig{})
	if len(pass) != 12 || !strings.Contains(tc.stdout.String(), "no password") {
		t.Fatalf("empty saved password: %q, out %q", pass, tc.stdout.String())
	}
	tc.stdout.Reset()
	tc.setupAuth(installOptions{}, &savedConfig{PasswordUnreadable: true})
	if !strings.Contains(tc.stdout.String(), "cannot be decrypted") {
		t.Fatalf("unreadable password not reported: %q", tc.stdout.String())
	}
	if pass, _, _ := tc.setupAuth(installOptions{noAuth: true}, &savedConfig{Password: "x"}); pass != "" {
		t.Fatalf("--no-auth returned password %q", pass)
	}
	if strings.Contains(tc.stdout.String(), "Auth is off") {
		t.Fatal("local --no-auth warned about network exposure")
	}
	for _, o := range []installOptions{{noAuth: true, lan: true}, {noAuth: true, tailscale: "box"}} {
		tc.stdout.Reset()
		tc.setupAuth(o, nil)
		if !strings.Contains(tc.stdout.String(), "Auth is off") {
			t.Errorf("no warning for --no-auth with %+v", o)
		}
	}
	tc.interactive = true
	tc.readPassword = func() (string, error) { return "typed-in", nil }
	if pass, _, _ := tc.setupAuth(installOptions{}, nil); pass != "typed-in" {
		t.Fatalf("typed password ignored: %q", pass)
	}
}

func TestInstallRejectsBeforeTouchingServices(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.procs = func() ([]procInfo, error) { t.Fatal("services touched"); return nil, nil }
	if code := tc.main([]string{"install", "container", "--mux", "herdr"}); code != 2 {
		t.Fatalf("code %d, stderr %q", code, tc.stderr.String())
	}
	if code := tc.main([]string{"install", "native", "--allow-host", "*"}); code != 2 || !strings.Contains(tc.stderr.String(), "cannot be switched off") {
		t.Fatalf("wildcard: code %d, stderr %q", code, tc.stderr.String())
	}
}

func TestInstallContainerRunsCompose(t *testing.T) {
	tc := newTestCLI(t, "linux")
	old := containerStartWait
	containerStartWait = 0
	t.Cleanup(func() { containerStartWait = old })
	tc.runner.paths["docker"] = true
	// A checkout: the PWA is built and the image's binary compiled.
	writeFile(t, filepath.Join(tc.projectDir, "pwa", "package.json"), "{}")
	writeFile(t, filepath.Join(tc.projectDir, "pwa", "dist", "index.html"), "<html>")
	writeFile(t, filepath.Join(tc.webuiDist(), "stale.js"), "old")
	writeFile(t, filepath.Join(tc.webuiDist(), ".gitkeep"), "")
	writeFile(t, filepath.Join(tc.projectDir, "docker-compose.yml"), "services: {}")
	if code := tc.main([]string{"install", "container", "--lan", "--port", "1"}); code != 0 {
		t.Fatalf("code %d, stderr %s", code, tc.stderr.String())
	}
	if !tc.runner.called("docker compose --profile docker up -d --build") {
		t.Fatalf("compose not run: %v", tc.runner.calls)
	}
	if !tc.runner.called("go build -ldflags=-s -w -o termote-linux-amd64 .") {
		t.Fatalf("image binary not built: %v", tc.runner.calls)
	}
	if !fileExists(filepath.Join(tc.webuiDist(), "index.html")) || !fileExists(filepath.Join(tc.webuiDist(), ".gitkeep")) ||
		fileExists(filepath.Join(tc.webuiDist(), "stale.js")) {
		t.Fatal("PWA build not synced into server/webui/dist")
	}
	if fileExists(filepath.Join(tc.projectDir, "docker-compose.override.yml")) {
		t.Fatal("override file left behind")
	}
	cfg, _ := tc.loadConfig()
	if cfg == nil || cfg.Mode != "container" || !cfg.LAN || cfg.Mux != "tmux" || len(cfg.Password) != 12 {
		t.Fatalf("saved config %+v", cfg)
	}
	if !strings.Contains(tc.stdout.String(), "Allowed hosts: localhost, 127.0.0.1, ::1, 192.168.1.20, 10.0.0.5") {
		t.Fatalf("allowed hosts not printed:\n%s", tc.stdout.String())
	}
}

func TestInstallNativeRequiresTmux(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if code := tc.main([]string{"install", "native"}); code != 1 || !strings.Contains(tc.stderr.String(), "tmux not found") {
		t.Fatalf("code %d stderr %q", code, tc.stderr.String())
	}
	if fileExists(tc.configFile()) {
		t.Fatal("config saved for a failed install")
	}
}

func TestTailscaleSetupAndReset(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.runner.paths["tailscale"] = true
	tc.setupTailscale("box.ts.net:8443", 7700, false)
	want := "tailscale serve --bg --https=8443 http://127.0.0.1:7700"
	if !tc.runner.called("sudo "+want) && !tc.runner.called(want) {
		t.Fatalf("serve not run: %v", tc.runner.calls)
	}
	tc.runner.calls = nil
	tc.setupTailscale("", 7700, false)
	if len(tc.runner.calls) != 0 {
		t.Fatalf("reset run without a saved Tailscale config: %v", tc.runner.calls)
	}
	tc.setupTailscale("", 7700, true)
	if !tc.runner.called("sudo tailscale serve reset") && !tc.runner.called("tailscale serve reset") {
		t.Fatalf("reset not run: %v", tc.runner.calls)
	}
}

func TestUninstallAllRemovesConfig(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Mode: "native", Password: "p"})
	if code := tc.main([]string{"uninstall", "all"}); code != 0 {
		t.Fatalf("code %d %s", code, tc.stderr.String())
	}
	if fileExists(tc.configFile()) {
		t.Fatal("config kept by uninstall all")
	}
	if code := tc.main([]string{"uninstall", "bogus"}); code != 2 {
		t.Fatalf("bad mode code %d", code)
	}
}

func TestPortProxyScript(t *testing.T) {
	s := portProxyScript(7690, true)
	for _, want := range []string{"listenport=7690", "connectaddress=127.0.0.1", "name='Termote LAN'", "add rule"} {
		if !strings.Contains(s, want) {
			t.Errorf("script misses %q: %s", want, s)
		}
	}
	if strings.Contains(portProxyScript(7690, false), "add v4tov4") {
		t.Error("removal script adds a rule")
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// TestInstallNativeEndToEnd installs a real release binary, checks it serves
// with auth, then uninstalls and checks it is gone.
func TestInstallNativeEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered on Unix; Windows process handling has its own tests")
	}
	tc := newTestCLI(t, runtime.GOOS)
	tc.goarch = runtime.GOARCH
	prebuilt := filepath.Join(tc.projectDir, "termote-"+runtime.GOOS+"-"+runtime.GOARCH)
	build := exec.Command("go", "build", "-o", prebuilt, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	tc.exe = prebuilt
	tc.runner.paths["tmux"] = true
	tc.procs = listProcesses
	tc.terminate = terminateProcess
	// Keep the server off the user's tmux server.
	t.Setenv("TMUX_SOCKET", filepath.Join(t.TempDir(), "tmux.sock"))
	port := freePort(t)

	if code := tc.main([]string{"install", "native", "--port", strconv.Itoa(port), "--allow-host", "box.lan"}); code != 0 {
		t.Fatalf("install: code %d\nstdout:\n%s\nstderr:\n%s", code, tc.stdout.String(), tc.stderr.String())
	}
	t.Cleanup(func() { tc.stopNative() })

	pid, _ := strconv.Atoi(strings.TrimSpace(string(mustRead(t, tc.pidFile()))))
	if pid == 0 {
		t.Fatal("no PID file")
	}
	cfg, err := tc.loadConfig()
	if err != nil || cfg.Mode != "native" || cfg.Port != port || len(cfg.Password) != 12 || strings.Join(cfg.AllowHosts, ",") != "box.lan" {
		t.Fatalf("config %+v %v", cfg, err)
	}
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	if status := httpStatus(http.DefaultClient, base+"/"); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET / = %d, want 401", status)
	}
	req, _ := http.NewRequest("GET", base+"/", nil)
	req.SetBasicAuth(adminUser, cfg.Password)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("authenticated GET / = %d", resp.StatusCode)
	}
	// The allowlisted name passes the Host check; a random one does not.
	for host, want := range map[string]int{"box.lan": http.StatusUnauthorized, "evil.example": http.StatusForbidden} {
		req, _ := http.NewRequest("GET", base+"/", nil)
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("Host %s: %d, want %d", host, resp.StatusCode, want)
		}
	}

	// A second install reuses the password and replaces the server.
	tc.stdout.Reset()
	if code := tc.main([]string{"install", "native"}); code != 0 {
		t.Fatalf("reinstall: %s", tc.stderr.String())
	}
	if !strings.Contains(tc.stdout.String(), "Using saved password") {
		t.Fatalf("reinstall did not reuse the password:\n%s", tc.stdout.String())
	}
	pid2, _ := strconv.Atoi(strings.TrimSpace(string(mustRead(t, tc.pidFile()))))
	if pid2 == pid || pidRunning(pid) {
		t.Fatalf("old server %d still running (new %d)", pid, pid2)
	}

	if code := tc.main([]string{"uninstall", "native"}); code != 0 {
		t.Fatalf("uninstall: %s", tc.stderr.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for pidRunning(pid2) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if pidRunning(pid2) {
		t.Fatalf("server %d still running after uninstall", pid2)
	}
	if httpStatus(&http.Client{Timeout: time.Second}, base+"/") != 0 {
		t.Fatal("port still answers after uninstall")
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// pidRunning reports whether pid is listed as a live process.
func pidRunning(pid int) bool {
	procs, err := listProcesses()
	if err != nil {
		return false
	}
	for _, p := range procs {
		if p.PID == pid {
			return true
		}
	}
	return false
}

func TestInstallNativeRefusesBusyPort(t *testing.T) {
	tc := newTestCLI(t, "linux")
	writeFile(t, tc.exe, "ELF")
	tc.runner.paths["tmux"] = true
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	if code := tc.main([]string{"install", "native", "--port", strconv.Itoa(port)}); code != 1 || !strings.Contains(tc.stderr.String(), "in use") {
		t.Fatalf("code %d stderr %q", code, tc.stderr.String())
	}
	if fileExists(tc.pidFile()) || fileExists(tc.configFile()) {
		t.Fatal("PID file or config written for a failed start")
	}
}

func TestInstallRefusesUnreadableConfig(t *testing.T) {
	tc := newTestCLI(t, "windows")
	writeFile(t, tc.configFile(), "{not json")
	if code := tc.main([]string{"install", "native"}); code != 1 {
		t.Fatalf("code %d", code)
	}
	if b, _ := os.ReadFile(tc.configFile()); string(b) != "{not json" {
		t.Fatal("unreadable config overwritten")
	}
}

func TestServerMatcherFollowsSymlinkedInstallDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	tc := newTestCLI(t, "linux")
	real := filepath.Join(tc.projectDir, "server", "termote-server")
	writeFile(t, real, "ELF")
	link := filepath.Join(t.TempDir(), "link")
	os.Symlink(tc.projectDir, link)
	resolved, _ := filepath.EvalSymlinks(real)
	logical := filepath.Join(link, "server", "termote-server")
	if !tc.isServerProcess(procInfo{Cmdline: logical, Exe: resolved}) {
		t.Fatal("server started through a symlinked path not matched")
	}
	if tc.isServerProcess(procInfo{Cmdline: logical + " install native", Exe: resolved}) {
		t.Fatal("CLI invocation matched as server")
	}
}
