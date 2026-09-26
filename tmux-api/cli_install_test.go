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
	o, set, err := tc.parseInstallArgs([]string{"--lan", "docker", "--allow-host", "a.lan", "--allow-host", "b.lan", "--ttyd", "fork"})
	if err != nil {
		t.Fatal(err)
	}
	if o.mode != "container" || !o.lan || !set["lan"] || set["port"] || !o.ttydGiven ||
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

func TestServerAndLegacyTtydMatchers(t *testing.T) {
	tc := newTestCLI(t, "linux")
	server := filepath.Join(tc.projectDir, "tmux-api", "tmux-api")
	yes := []procInfo{
		{Cmdline: server},
		{Cmdline: filepath.Join(tc.projectDir, "tmux-api", "tmux-api-native")},
	}
	no := []procInfo{
		{Cmdline: server + " install native"},
		{Cmdline: "/usr/local/bin/tmux-api"},
		{Cmdline: "tmux-api"},
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
	for _, cmd := range []string{
		"ttyd -W -i lo -p 7681 tmux new-session -A -s main",
		"ttyd -i lo0 -p 7681 tmux new-session -A -s main",
		"/usr/bin/ttyd -W -i lo0 -p 7681 tmux new-session -A -s main",
	} {
		if !tc.isLegacyTtyd(procInfo{Cmdline: cmd}) {
			t.Errorf("0.x ttyd %q not matched", cmd)
		}
	}
	for _, cmd := range []string{
		"ttyd -p 7681 bash",
		"ttyd -W -i lo -p 7681 tmux new-session -A -s work",
		"ttyd -W -p 7681 -t fontSize=14 tmux new-session -A -s main",
	} {
		if tc.isLegacyTtyd(procInfo{Cmdline: cmd}) {
			t.Errorf("user ttyd %q matched", cmd)
		}
	}

	win := newTestCLI(t, "windows")
	if !win.isServerProcess(procInfo{Exe: strings.ToUpper(filepath.Join(win.projectDir, "tmux-api", "tmux-api.exe"))}) {
		t.Error("windows server not matched case-insensitively")
	}
	if win.isServerProcess(procInfo{Exe: filepath.Join(win.projectDir, "tmux-api-windows-amd64.exe")}) {
		t.Error("windows CLI binary matched as server")
	}
	if !win.isLegacyTtyd(procInfo{Exe: filepath.Join(win.projectDir, "scripts", "ttyd.exe")}) ||
		win.isLegacyTtyd(procInfo{Exe: `C:\tools\ttyd.exe`}) {
		t.Error("windows ttyd matcher wrong")
	}
}

func TestStopNativeStopsOnlyTermoteProcesses(t *testing.T) {
	tc := newTestCLI(t, "linux")
	server := filepath.Join(tc.projectDir, "tmux-api", "tmux-api")
	writeFile(t, tc.pidFile(), "40\n")
	tc.procs = func() ([]procInfo, error) {
		return []procInfo{
			{PID: 10, Cmdline: server},
			{PID: 11, Cmdline: "ttyd -W -i lo -p 7681 tmux new-session -A -s main"},
			{PID: 12, Cmdline: "ttyd -p 9000 bash"},
			{PID: 13, Cmdline: "/opt/other/tmux-api"},
			{PID: 40, Cmdline: "/somewhere/else/tmux-api"}, // started by 1.0, found via PID file
			{PID: 41, Cmdline: "vim notes.txt"},
			{PID: tc.pid, Cmdline: server},
		}, nil
	}
	tc.stopNative()
	slices.Sort(tc.killed)
	if want := []int{10, 11, 40}; !slices.Equal(tc.killed, want) {
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
	// 0.x config with auth on and no password: 1.0 sets one instead of
	// running without auth.
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
	tc.interactive = true
	tc.readPassword = func() (string, error) { return "typed-in", nil }
	if pass, _, _ := tc.setupAuth(installOptions{}, nil); pass != "typed-in" {
		t.Fatalf("typed password ignored: %q", pass)
	}
}

func TestMigrateLegacyRemovesWindowsTtyd(t *testing.T) {
	tc := newTestCLI(t, "windows")
	for _, f := range []string{"ttyd.exe", "ttyd.source"} {
		writeFile(t, filepath.Join(tc.projectDir, "scripts", f), "x")
	}
	tc.migrateLegacy()
	if fileExists(filepath.Join(tc.projectDir, "scripts", "ttyd.exe")) || fileExists(filepath.Join(tc.projectDir, "scripts", "ttyd.source")) {
		t.Fatal("ttyd files left")
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
	writeFile(t, filepath.Join(tc.projectDir, "pwa-dist", "index.html"), "<html>")
	writeFile(t, filepath.Join(tc.projectDir, "tmux-api-linux-amd64"), "ELF")
	writeFile(t, filepath.Join(tc.projectDir, "docker-compose.yml"), "services: {}")
	if code := tc.main([]string{"install", "container", "--lan", "--port", "1"}); code != 0 {
		t.Fatalf("code %d, stderr %s", code, tc.stderr.String())
	}
	if !tc.runner.called("docker compose --profile docker up -d --build") {
		t.Fatalf("compose not run: %v", tc.runner.calls)
	}
	if b, _ := os.ReadFile(filepath.Join(tc.projectDir, "tmux-api", "tmux-api")); string(b) != "ELF" {
		t.Fatal("linux binary not copied for the image")
	}
	if !fileExists(filepath.Join(tc.projectDir, "pwa", "dist", "index.html")) || fileExists(filepath.Join(tc.projectDir, "pwa-dist")) {
		t.Fatal("pwa-dist not moved into pwa/dist")
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
	writeFile(t, filepath.Join(tc.projectDir, "pwa-dist", "index.html"), "<html>")
	writeFile(t, filepath.Join(tc.projectDir, "tmux-api-linux-amd64"), "ELF")
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

// TestInstallNativeEndToEnd installs a real server binary from a release
// layout, checks it serves with auth, then uninstalls and checks it is gone.
func TestInstallNativeEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered on Unix; Windows process handling has its own tests")
	}
	tc := newTestCLI(t, runtime.GOOS)
	tc.goarch = runtime.GOARCH
	prebuilt := filepath.Join(tc.projectDir, "tmux-api-"+runtime.GOOS+"-"+runtime.GOARCH)
	build := exec.Command("go", "build", "-o", prebuilt, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	tc.exe = prebuilt
	writeFile(t, filepath.Join(tc.projectDir, "pwa-dist", "index.html"), "<html>termote</html>")
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
	writeFile(t, filepath.Join(tc.projectDir, "pwa-dist", "index.html"), "<html>")
	writeFile(t, filepath.Join(tc.projectDir, "tmux-api-linux-amd64"), "ELF")
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
	real := filepath.Join(tc.projectDir, "tmux-api", "tmux-api")
	writeFile(t, real, "ELF")
	link := filepath.Join(t.TempDir(), "link")
	os.Symlink(tc.projectDir, link)
	resolved, _ := filepath.EvalSymlinks(real)
	logical := filepath.Join(link, "tmux-api", "tmux-api")
	if !tc.isServerProcess(procInfo{Cmdline: logical, Exe: resolved}) {
		t.Fatal("0.x server started through a symlinked path not matched")
	}
	if tc.isServerProcess(procInfo{Cmdline: logical + " install native", Exe: resolved}) {
		t.Fatal("CLI invocation matched as server")
	}
}
