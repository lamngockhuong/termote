package main

import (
	"bufio"
	"context"
	"errors"
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

func TestParseStartArgs(t *testing.T) {
	tc := newTestCLI(t, "linux")
	o, set, err := tc.parseStartArgs([]string{"--lan", "--allow-host", "a.lan", "--allow-host", "b.lan", "--remove-host", "c.lan", "--no-auth=false"})
	if err != nil {
		t.Fatal(err)
	}
	if !o.lan || !set["lan"] || set["port"] || !set["no-auth"] || o.noAuth ||
		strings.Join(o.allowHosts, ",") != "a.lan,b.lan" || strings.Join(o.removeHosts, ",") != "c.lan" {
		t.Fatalf("got %+v set %v", o, set)
	}
	if o, set, err := tc.parseStartArgs([]string{"--user", "bob"}); err != nil || o.user != "bob" || !set["user"] {
		t.Fatalf("--user: %+v %v %v", o, set, err)
	}
	for _, bad := range [][]string{{"native"}, {"--bogus"}, {"--tailscale", "x.ts.net", "--no-tailscale"}, {"--user"}} {
		if _, _, err := tc.parseStartArgs(bad); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
}

func TestMergeSaved(t *testing.T) {
	saved := &savedConfig{LAN: true, NoAuth: true, Port: 7700, Tailscale: "t.ts.net", Mux: "herdr",
		AllowHosts: []string{"saved.lan", "old.lan"}, HerdrAllowNoAuth: true, User: "bob"}

	o := startOptions{allowHosts: []string{"new.lan"}, removeHosts: []string{"OLD.lan"}}
	mergeSaved(&o, map[string]bool{}, saved)
	if !o.lan || !o.noAuth || o.port != 7700 || o.tailscale != "t.ts.net" || o.mux != "herdr" || !o.herdrNoAuth ||
		o.user != "bob" || strings.Join(o.allowHosts, ",") != "new.lan,saved.lan" {
		t.Fatalf("saved values not kept: %+v", o)
	}
	// A flag given as =false turns the saved value off.
	o = startOptions{}
	mergeSaved(&o, map[string]bool{"lan": true, "no-auth": true, "mux": true}, saved)
	if o.lan || o.noAuth || o.mux != "" {
		t.Fatalf("=false did not override: %+v", o)
	}
	o = startOptions{noTailscale: true}
	mergeSaved(&o, map[string]bool{"no-tailscale": true}, saved)
	if o.tailscale != "" {
		t.Fatalf("--no-tailscale kept %q", o.tailscale)
	}
	// --user replaces the saved name; none saved (or no config) is admin.
	o = startOptions{user: "carol"}
	mergeSaved(&o, map[string]bool{"user": true}, saved)
	if o.user != "carol" {
		t.Fatalf("--user did not override: %+v", o)
	}
	o = startOptions{}
	mergeSaved(&o, map[string]bool{}, &savedConfig{Port: 7700})
	if o.user != adminUser {
		t.Fatalf("config without a username: %+v", o)
	}
	o = startOptions{}
	mergeSaved(&o, map[string]bool{}, nil)
	if o.port != 0 || o.lan || o.user != adminUser {
		t.Fatalf("nil saved config changed options: %+v", o)
	}
}

func TestValidateStart(t *testing.T) {
	tc := newTestCLI(t, "linux")
	o := startOptions{user: adminUser}
	if err := tc.validateStart(&o); err != nil || o.port != 7680 {
		t.Fatalf("defaults: %v %+v", err, o)
	}
	for name, o := range map[string]startOptions{
		"herdr without auth": {mux: "herdr", noAuth: true, user: adminUser},
		"wildcard host":      {allowHosts: []string{"*"}, user: adminUser},
		"bad remove-host":    {removeHosts: []string{"a b"}, user: adminUser},
		"bad tailscale port": {tailscale: "box.ts.net:0", user: adminUser},
		"unknown mux":        {mux: "screen", user: adminUser},
		"port":               {port: 70000, user: adminUser},
		"empty user":         {user: ""},
		"user with colon":    {user: "bob:x"},
	} {
		if err := tc.validateStart(&o); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	ok := startOptions{mux: "herdr", noAuth: true, herdrNoAuth: true, user: "bob"}
	if err := tc.validateStart(&ok); err != nil {
		t.Errorf("herdr no-auth with --allow-herdr-no-auth refused: %v", err)
	}
	win := newTestCLI(t, "windows")
	if err := win.validateStart(&startOptions{mux: "herdr", user: adminUser}); err != nil {
		t.Errorf("herdr refused on Windows: %v", err)
	}
	if err := win.validateStart(&startOptions{mux: "herdr", noAuth: true, user: adminUser}); err == nil {
		t.Error("herdr --no-auth without --allow-herdr-no-auth accepted on Windows")
	}
}

func TestDetectMux(t *testing.T) {
	cases := []struct {
		name        string
		goos        string
		herdr, tmux bool
		interactive bool
		answer      string
		want        string
	}{
		{"herdr only", "linux", true, false, false, "", "herdr"},
		{"tmux only", "darwin", false, true, false, "", "tmux"},
		{"both, no terminal", "linux", true, true, false, "", "tmux"},
		{"both, asked, herdr first", "linux", true, true, true, "1\n", "herdr"},
		{"both, asked, tmux", "linux", true, true, true, "2\n", "tmux"},
		{"windows herdr only", "windows", true, false, false, "", "herdr"},
		{"windows both, no terminal", "windows", true, true, false, "", "tmux"},
		{"windows both, asked, herdr first", "windows", true, true, true, "1\n", "herdr"},
		{"windows both, asked, psmux", "windows", true, true, true, "2\n", "tmux"},
		{"none", "linux", false, false, false, "", ""},
		{"windows none", "windows", false, false, false, "", ""},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			tc := newTestCLI(t, tt.goos)
			tc.herdrRunning = func() bool { return tt.herdr }
			tc.runner.paths["tmux"] = tt.tmux
			tc.interactive = tt.interactive
			tc.in = bufio.NewReader(strings.NewReader(tt.answer))
			got, err := tc.detectMux()
			if got != tt.want || (tt.want == "") != (err != nil) {
				t.Fatalf("detectMux = %q, %v; want %q", got, err, tt.want)
			}
			if err != nil && !strings.Contains(err.Error(), "herdr") {
				t.Errorf("error does not mention herdr: %v", err)
			}
		})
	}
}

func TestSetupAuth(t *testing.T) {
	tc := newTestCLI(t, "linux")
	pass, reused, _ := tc.setupAuth(startOptions{}, &savedConfig{Password: "kept"})
	if pass != "kept" || !reused {
		t.Fatalf("saved password not reused: %q %v", pass, reused)
	}
	pass, reused, _ = tc.setupAuth(startOptions{fresh: true}, &savedConfig{Password: "kept"})
	if pass == "kept" || reused || len(pass) != 12 {
		t.Fatalf("--fresh reused password: %q", pass)
	}
	// Auth on and no saved password: a new one is set, never no auth.
	if pass, _, _ = tc.setupAuth(startOptions{}, &savedConfig{}); len(pass) != 12 {
		t.Fatalf("empty saved password: %q", pass)
	}
	tc.stdout.Reset()
	tc.setupAuth(startOptions{}, &savedConfig{PasswordUnreadable: true})
	if !strings.Contains(tc.stdout.String(), "cannot be decrypted") {
		t.Fatalf("unreadable password not reported: %q", tc.stdout.String())
	}
	if pass, _, _ := tc.setupAuth(startOptions{noAuth: true}, &savedConfig{Password: "x"}); pass != "" {
		t.Fatalf("--no-auth returned password %q", pass)
	}
	tc.interactive = true
	tc.readPassword = func() (string, error) { return "typed-in", nil }
	if pass, _, _ := tc.setupAuth(startOptions{}, nil); pass != "typed-in" {
		t.Fatalf("typed password ignored: %q", pass)
	}
}

func TestWarnExposure(t *testing.T) {
	tc := newTestCLI(t, "linux")
	for _, tt := range []struct {
		o    startOptions
		want string
	}{
		{startOptions{noAuth: true, lan: true}, "Auth is OFF"},
		{startOptions{noAuth: true, tailscale: "box"}, "Auth is OFF"},
		{startOptions{noAuth: true}, "Auth is off"},
		{startOptions{lan: true}, "LAN access is on"},
		{startOptions{tailscale: "box"}, ""},
	} {
		tc.stdout.Reset()
		tc.warnExposure(tt.o)
		if got := tc.stdout.String(); (tt.want == "") != (got == "") || !strings.Contains(got, tt.want) {
			t.Errorf("%+v: %q, want %q", tt.o, got, tt.want)
		}
	}
}

func TestStartRejectsBeforeTouchingServices(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.procs = func() ([]procInfo, error) { t.Fatal("services touched"); return nil, nil }
	writeFile(t, tc.pidFile(), "123\n")
	for _, args := range [][]string{
		{"--mux", "herdr", "--no-auth"},
		{"--allow-host", "*"},
		{"--mux", "tmux"}, // tmux is not in PATH: preflight fails
	} {
		tc.stderr.Reset()
		if code := tc.main(append([]string{"start"}, args...)); code == 0 {
			t.Fatalf("%v: code 0", args)
		}
	}
	if fileExists(tc.configFile()) {
		t.Fatal("config saved for a refused start")
	}
	if code := tc.main([]string{"install", "native"}); code != 2 || !strings.Contains(tc.stderr.String(), "termote start") {
		t.Fatalf("install: code %d stderr %q", code, tc.stderr.String())
	}
}

func TestStartRefusesBusyPort(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.runner.paths["tmux"] = true
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	// The saved port is another one, so the busy port is not "ours".
	tc.saveConfig(savedConfig{Port: freePort(t), Password: "p"})
	if code := tc.main([]string{"start", "--port", strconv.Itoa(port)}); code != 1 || !strings.Contains(tc.stderr.String(), "in use") {
		t.Fatalf("code %d stderr %q", code, tc.stderr.String())
	}
	if cfg, _ := tc.loadConfig(); cfg.Port == port {
		t.Fatal("config saved for a failed start")
	}
}

func TestStartRefusesBadUser(t *testing.T) {
	for _, bad := range []string{"", "bob:x", "a b"} {
		tc := newTestCLI(t, "linux")
		if code := tc.main([]string{"start", "--user", bad}); code != 2 || !strings.Contains(tc.stderr.String(), "invalid --user") {
			t.Errorf("--user %q: code %d\n%s", bad, code, tc.stderr.String())
		}
		if fileExists(tc.configFile()) {
			t.Errorf("--user %q saved a config", bad)
		}
	}
}

func TestStartRefusesUnreadableConfig(t *testing.T) {
	tc := newTestCLI(t, "windows")
	writeFile(t, tc.configFile(), "{not json")
	if code := tc.main([]string{"start"}); code != 1 {
		t.Fatalf("code %d", code)
	}
	if b, _ := os.ReadFile(tc.configFile()); string(b) != "{not json" {
		t.Fatal("unreadable config overwritten")
	}
}

// Whatever the environment says, a saved config decides: without LAN the
// server listens on loopback and auth stays on.
func TestServeConfigIgnoresEnvWhenConfigExists(t *testing.T) {
	tc := newTestCLI(t, "linux")
	t.Setenv("TERMOTE_BIND", "0.0.0.0")
	t.Setenv("TERMOTE_NO_AUTH", "true")
	t.Setenv("TERMOTE_PORT", "9999")
	t.Setenv("TERMOTE_PWA_DIR", "/tmp")
	tc.saveConfig(savedConfig{Password: "pw", AllowHosts: []string{"box.lan"}, Tailscale: "Box.ts.net:8443"})
	cfg, err := tc.loadServeConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Bind != "127.0.0.1" || cfg.NoAuth || cfg.Pass != "pw" || cfg.Port != "7680" || cfg.PWADir != "" ||
		cfg.AllowLocalAddr || cfg.MuxBackend != "tmux" || cfg.AllowedHosts != "box.ts.net,box.lan" || cfg.Tailscale != "Box.ts.net:8443" ||
		cfg.User != adminUser {
		t.Fatalf("serve config %+v", cfg)
	}
	t.Setenv("TERMOTE_USER", "env-user") // ignored as well
	tc.saveConfig(savedConfig{Password: "pw", LAN: true, Port: 7700, User: "bob"})
	if cfg, _ = tc.loadServeConfig(); cfg.Bind != "0.0.0.0" || !cfg.AllowLocalAddr || cfg.Port != "7700" || cfg.User != "bob" {
		t.Fatalf("LAN serve config %+v", cfg)
	}
	// No config: the environment configures the server (the container).
	os.Remove(tc.configFile())
	t.Setenv("TERMOTE_NO_AUTH", "true")
	if cfg, _ = tc.loadServeConfig(); cfg.Bind != "0.0.0.0" || !cfg.NoAuth || cfg.Port != "9999" {
		t.Fatalf("env serve config %+v", cfg)
	}
}

func TestServeConfigUnusableWithoutSecret(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Password: "pw"})
	os.Remove(tc.secretFile())
	_, err := tc.loadServeConfig()
	if !errors.Is(err, errConfigUnusable) || !strings.Contains(err.Error(), "start --fresh") {
		t.Fatalf("err = %v", err)
	}
}

func TestServiceEnvHasNoTermoteVariables(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.env = map[string]string{"PATH": "/home/u/.local/bin:/usr/bin", "HERDR_SOCKET_PATH": "/run/h.sock", "TERMOTE_PASS": "x", "HOME": "/home/u"}
	env := tc.serviceEnv()
	if env["PATH"] != "/home/u/.local/bin:/usr/bin" || env["HERDR_SOCKET_PATH"] != "/run/h.sock" || len(env) != 2 {
		t.Fatalf("service env %v", env)
	}
	got := withoutTermoteEnv([]string{"A=1", "TERMOTE_PASS=x", "termote_port=1", "TERMOTEX=2"})
	if strings.Join(got, " ") != "A=1 TERMOTEX=2" {
		t.Fatalf("withoutTermoteEnv = %v", got)
	}
}

func TestSystemdUnit(t *testing.T) {
	unit := systemdUnitFile("/home/u/.local/share/termote/current/bin/termote", "/home/u/.local/state/termote/termote.log",
		map[string]string{"PATH": "/home/u/bin:/usr/bin", "HERDR_SOCKET_PATH": "/tmp/100%/h.sock"})
	for _, want := range []string{
		`ExecStart="/home/u/.local/share/termote/current/bin/termote" serve`,
		"KillMode=process", "Restart=on-failure", "RestartSec=2", "StartLimitIntervalSec=60", "StartLimitBurst=5",
		"RestartPreventExitStatus=78", `Environment="HERDR_SOCKET_PATH=/tmp/100%%/h.sock"`,
		`Environment="PATH=/home/u/bin:/usr/bin"`, "WantedBy=default.target",
		"StandardOutput=append:/home/u/.local/state/termote/termote.log",
	} {
		if !strings.Contains(unit, want+"\n") {
			t.Errorf("unit misses %q:\n%s", want, unit)
		}
	}
	if strings.Contains(unit, "TERMOTE_") {
		t.Errorf("unit carries a TERMOTE_ variable:\n%s", unit)
	}
	if got := systemdQuote(`/a b/$x"y`, true); got != `"/a b/$$x\"y"` {
		t.Errorf("systemdQuote = %s", got)
	}
}

// newSystemdCLI is a Linux CLI whose fake systemctl answers.
func newSystemdCLI(t *testing.T) *testCLI {
	tc := newTestCLI(t, "linux")
	tc.runner.paths["systemctl"] = true
	for _, k := range []string{"show-environment", "daemon-reload", "enable termote.service", "reset-failed termote.service",
		"restart termote.service", "stop termote.service", "disable --now termote.service"} {
		tc.runner.outputs["systemctl --user "+k] = ""
	}
	return tc
}

func TestRegisterServicePrefersSystemd(t *testing.T) {
	tc := newSystemdCLI(t)
	tc.env["USER"] = "u"
	tc.runner.outputs["loginctl show-user u -p Linger --value"] = "no\n"
	// A Unix path whatever OS runs the test: the unit escapes backslashes.
	tc.exe = "/opt/termote/bin/termote"
	sup, err := tc.registerService()
	if err != nil || sup.Name() != "systemd --user" || !sup.AutoStart() {
		t.Fatalf("supervisor %v, %v", sup, err)
	}
	unit := string(mustRead(t, filepath.Join(tc.home, ".config", "systemd", "user", "termote.service")))
	if !strings.Contains(unit, `ExecStart="`+tc.exe+`" serve`) || !strings.Contains(unit, `Environment="PATH=/usr/bin:/bin"`) {
		t.Fatalf("unit:\n%s", unit)
	}
	if !isDir(tc.stateDir()) {
		t.Fatal("state dir (the log systemd opens) not created")
	}
	if !tc.runner.called("systemctl --user daemon-reload") || !tc.runner.called("systemctl --user enable termote.service") {
		t.Fatalf("calls %v", tc.runner.calls)
	}
	if !strings.Contains(tc.stdout.String(), "loginctl enable-linger u") {
		t.Fatalf("no linger hint:\n%s", tc.stdout.String())
	}
	// An unchanged unit is not reloaded again.
	tc.runner.calls = nil
	tc.registerService()
	if tc.runner.called("systemctl --user daemon-reload") {
		t.Fatal("daemon-reload for an unchanged unit")
	}
	if err := sup.Start(); err != nil {
		t.Fatal(err)
	}
	if i, j := slices.Index(tc.runner.calls, "systemctl --user reset-failed termote.service"), slices.Index(tc.runner.calls, "systemctl --user restart termote.service"); i < 0 || j < i {
		t.Fatalf("start must reset-failed before restart: %v", tc.runner.calls)
	}
	tc.runner.outputs["systemctl --user show termote.service -p ActiveState -p MainPID"] = "ActiveState=active\nMainPID=321\n"
	if running, pid, _ := sup.Status(); !running || pid != 321 {
		t.Fatalf("status %v %d", running, pid)
	}
	if err := sup.Uninstall(); err != nil || sup.Installed() {
		t.Fatalf("uninstall: %v", err)
	}
}

func TestSystemdUnavailableFallsBackToDetached(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.runner.paths["systemctl"] = true // but no user manager answers (WSL2)
	if sup := tc.preferredSupervisor(); sup.Name() != "detached" || sup.AutoStart() {
		t.Fatalf("preferred = %s", sup.Name())
	}
}

func TestLaunchdPlist(t *testing.T) {
	plist := launchdPlist("/Users/u/.local/share/termote/current/bin/termote", "/Users/u/.local/state/termote/termote.log",
		map[string]string{"PATH": "/opt/homebrew/bin:/usr/bin", "LANG": "en_US.UTF-8"})
	for _, want := range []string{
		"<string>app.ohnice.termote</string>",
		"<string>/Users/u/.local/share/termote/current/bin/termote</string>\n\t\t<string>serve</string>",
		"<key>AbandonProcessGroup</key>\n\t<true/>", "<key>SuccessfulExit</key>\n\t\t<false/>",
		"<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin</string>", "<key>RunAtLoad</key>\n\t<true/>",
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("plist misses %q", want)
		}
	}
	if strings.Contains(plist, "TERMOTE_") {
		t.Error("plist carries a TERMOTE_ variable")
	}
	running, pid, _ := parseLaunchctlPrint("gui/501/app.ohnice.termote = {\n\tstate = running\n\tpid = 777\n\tendpoints = {\n\t\tstate = active\n\t}\n}")
	if !running || pid != 777 {
		t.Fatalf("parse print: %v %d", running, pid)
	}
}

func TestLaunchdStartBootstrapsOrKickstarts(t *testing.T) {
	tc := newTestCLI(t, "darwin")
	tc.runner.paths["launchctl"] = true
	l := &launchdSupervisor{c: tc.cli}
	if err := l.Install(tc.exe, tc.serviceEnv()); err != nil || !l.Installed() {
		t.Fatalf("install: %v", err)
	}
	svc := "gui/" + strconv.Itoa(os.Getuid()) + "/app.ohnice.termote"
	tc.runner.outputs["launchctl bootstrap gui/"+strconv.Itoa(os.Getuid())+" "+l.plistPath()] = ""
	if err := l.Start(); err != nil {
		t.Fatal(err)
	}
	tc.runner.outputs["launchctl print "+svc] = "state = running\npid = 5\n"
	tc.runner.outputs["launchctl kickstart -k "+svc] = ""
	if err := l.Start(); err != nil || !tc.runner.called("launchctl kickstart -k "+svc) {
		t.Fatalf("restart: %v %v", err, tc.runner.calls)
	}
}

func TestWindowsTaskAndStartupFallback(t *testing.T) {
	xml := windowsTaskXML(`BOX\u`, `C:\Users\u\AppData\Local\termote\state\termote-task.vbs`)
	for _, want := range []string{"<LogonTrigger>", `<UserId>BOX\u</UserId>`, "<LogonType>InteractiveToken</LogonType>",
		"<RunLevel>LeastPrivilege</RunLevel>", "<MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>",
		"<Count>3</Count>", "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
		"<Command>wscript.exe</Command>", `<Arguments>&#34;C:\Users\u\AppData\Local\termote\state\termote-task.vbs&#34;</Arguments>`} {
		if !strings.Contains(xml, want) {
			t.Errorf("task XML misses %q", want)
		}
	}
	if b := utf16File("A"); len(b) != 4 || b[0] != 0xFF || b[1] != 0xFE || b[2] != 'A' {
		t.Errorf("utf16File = %v", b)
	}

	tc := newTestCLI(t, "windows")
	tc.runner.paths["schtasks"] = true
	tc.runner.outputs["whoami"] = `BOX\u` + "\n"
	// schtasks /Create is refused (policy): start falls back to Startup.
	sup, err := tc.registerService()
	if err != nil || sup.Name() != "startup folder" {
		t.Fatalf("fallback: %v %v", sup, err)
	}
	launcher := string(mustRead(t, (&startupSupervisor{c: tc.cli}).launcherPath()))
	if !strings.Contains(launcher, `"""`+tc.exe+`"" serve --service", 0, False`) {
		t.Fatalf("launcher %q", launcher)
	}
	if !strings.Contains(tc.stdout.String(), "Startup folder") {
		t.Fatalf("fallback not reported:\n%s", tc.stdout.String())
	}
}

func TestDetachedServerProcessNeedsServeCmdline(t *testing.T) {
	tc := newTestCLI(t, "linux")
	writeFile(t, tc.pidFile(), "40\n")
	procs := []procInfo{{PID: 40, Cmdline: "/home/u/.local/share/termote/current/bin/termote serve"}}
	tc.procs = func() ([]procInfo, error) { return procs, nil }
	d := &detachedSupervisor{c: tc.cli}
	if running, pid, _ := d.Status(); !running || pid != 40 {
		t.Fatalf("status %v %d", running, pid)
	}
	// The PID was reused by a CLI invocation or another program.
	for _, cmd := range []string{"/home/u/bin/termote status", "vim notes", "/opt/x/termote-dev serve-other"} {
		procs[0].Cmdline = cmd
		if d.Installed() {
			t.Errorf("%q taken for the server", cmd)
		}
	}
	procs[0].Cmdline = "/src/termote/server/termote-dev serve"
	if err := d.Stop(); err != nil || !slices.Equal(tc.killed, []int{40}) || fileExists(tc.pidFile()) {
		t.Fatalf("stop: %v killed %v", err, tc.killed)
	}
	win := newTestCLI(t, "windows")
	if !win.isServeProcess(procInfo{Exe: `C:\x\versions\1.0.0\bin\TERMOTE.EXE`}) || win.isServeProcess(procInfo{Exe: `C:\x\other.exe`}) ||
		!win.isServeProcess(procInfo{Exe: `C:\src\server\termote-dev.exe~`}) || win.isServeProcess(procInfo{Exe: `C:\x\other.exe~`}) {
		t.Error("windows serve matcher wrong")
	}
}

func TestStableExeFollowsInstallLayout(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.exe = filepath.Join(tc.home, ".local", "share", "termote", "versions", "1.0.0", "bin", "termote")
	if got := tc.stableExe(); got != filepath.Join(tc.home, ".local", "share", "termote", "current", "bin", "termote") {
		t.Fatalf("installed stableExe = %s", got)
	}
	tc.exe = "/src/termote/server/termote-dev"
	if got := tc.stableExe(); got != tc.exe {
		t.Fatalf("checkout stableExe = %s", got)
	}
	win := newTestCLI(t, "windows")
	win.exe = filepath.Join(win.home, "AppData", "Local", "termote", "versions", "1.0.0", "bin", "termote.exe")
	if got := win.stableExe(); got != filepath.Join(win.home, "AppData", "Local", "termote", "bin", "termote.cmd") {
		t.Fatalf("windows stableExe = %s", got)
	}
}

func TestTailscaleMapping(t *testing.T) {
	status := []byte(`{"TCP":{"8443":{"HTTPS":true}},"Web":{"box.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7680"}}}}}`)
	if !tailscaleMapped(status, "8443", "http://127.0.0.1:7680") || tailscaleMapped(status, "443", "http://127.0.0.1:7680") ||
		tailscaleMapped(status, "8443", "http://127.0.0.1:7681") || tailscaleMapped([]byte("{"), "8443", "x") {
		t.Fatal("tailscaleMapped wrong")
	}

	var calls []string
	old := tailscaleRun
	t.Cleanup(func() { tailscaleRun = old })
	tailscaleRun = func(_ context.Context, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))
		if args[1] == "status" {
			return []byte(`{}`), nil
		}
		return nil, nil
	}
	applyTailscale(context.Background(), "box.ts.net:8443", 7700)
	if strings.Join(calls, "|") != "serve status --json|serve --bg --https=8443 http://127.0.0.1:7700" {
		t.Fatalf("calls %v", calls)
	}
	calls = nil
	tailscaleRun = func(_ context.Context, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))
		return status, nil
	}
	applyTailscale(context.Background(), "box.ts.net:8443", 7680)
	if len(calls) != 1 {
		t.Fatalf("mapping already there, still applied: %v", calls)
	}

	tc := newTestCLI(t, "linux")
	tc.runner.paths["tailscale"] = true
	tc.runner.outputs["tailscale serve --https=8443 off"] = ""
	tc.runner.outputs["tailscale serve status --json"] = string(status) // https:8443 -> :7680
	// Only a mapping that still points at this server goes.
	tc.removeTailscale("box.ts.net:8443", 7681)
	tc.removeTailscale("", 7680)
	if tc.runner.called("tailscale serve --https=8443 off") {
		t.Fatal("removed a mapping that serves another port")
	}
	tc.removeTailscale("box.ts.net:8443", 7680)
	if !tc.runner.called("tailscale serve --https=8443 off") {
		t.Fatalf("remove calls %v", tc.runner.calls)
	}
	// An HTTPS port serving something else is not taken over; the same
	// server moving ports (prevPort) is.
	if err := tc.setupTailscale("box.ts.net:8443", 7681, 0); err == nil || !strings.Contains(err.Error(), "already serves") {
		t.Fatalf("takeover allowed: %v", err)
	}
	tc.runner.outputs["tailscale serve --bg --https=8443 http://127.0.0.1:7681"] = ""
	if err := tc.setupTailscale("box.ts.net:8443", 7681, 7680); err != nil {
		t.Fatalf("port change refused: %v", err)
	}
	delete(tc.runner.outputs, "tailscale serve status --json")
	err := tc.setupTailscale("box.ts.net", 7680, 0) // fake refuses: no output configured
	if err == nil || !strings.Contains(err.Error(), "tailscale set --operator") {
		t.Fatalf("setup error %v", err)
	}
	for _, call := range tc.runner.calls {
		if strings.HasPrefix(call, "sudo") || strings.Contains(call, "reset") {
			t.Fatalf("forbidden call %q", call)
		}
	}
}

func TestUninstallKeepsConfig(t *testing.T) {
	tc := newSystemdCLI(t)
	tc.registerService()
	tc.runner.paths["tailscale"] = true
	tc.runner.outputs["tailscale serve --https=443 off"] = ""
	tc.runner.outputs["tailscale serve status --json"] = `{"Web":{"box.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7680"}}}}}`
	tc.saveConfig(savedConfig{Password: "p", Tailscale: "box.ts.net"})
	if code := tc.main([]string{"uninstall"}); code != 0 {
		t.Fatalf("code %d %s", code, tc.stderr.String())
	}
	if (&systemdSupervisor{c: tc.cli}).Installed() || !fileExists(tc.configFile()) || !tc.runner.called("tailscale serve --https=443 off") {
		t.Fatalf("uninstall left the unit, dropped the config or kept Tailscale: %v", tc.runner.calls)
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

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestStartEndToEnd starts a real server detached (no service manager in the
// fake runner), checks it serves with auth and the Host check, restarts it
// with the saved config, then stops it.
func TestStartEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered on Unix; the Windows supervisors have their own tests")
	}
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	tc := newTestCLI(t, runtime.GOOS)
	tc.version = cliVersion
	tc.exe = filepath.Join(t.TempDir(), "termote")
	build := exec.Command("go", "build", "-o", tc.exe, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	// The server finds its config through HOME, as a service would.
	t.Setenv("HOME", tc.home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("TERMOTE_NO_AUTH", "true") // must be ignored: the config decides
	// Keep the server off the user's tmux server.
	t.Setenv("TMUX_SOCKET", filepath.Join(t.TempDir(), "tmux.sock"))
	tc.env["PATH"] = os.Getenv("PATH")
	tc.runner.paths["tmux"] = true
	tc.procs = listProcesses
	tc.terminate = terminateProcess
	port := freePort(t)
	// A container config is there: it shares the new username.
	tc.saveConfig(savedConfig{Container: &containerConfig{Port: 7681, Mux: "tmux"}})

	if code := tc.main([]string{"start", "--port", strconv.Itoa(port), "--allow-host", "box.lan", "--user", "bob"}); code != 0 {
		t.Fatalf("start: code %d\nstdout:\n%s\nstderr:\n%s\nlog:\n%s", code, tc.stdout.String(), tc.stderr.String(), tailFile(tc.serverLog(), 20))
	}
	t.Cleanup(func() { tc.main([]string{"stop"}) })
	if !strings.Contains(tc.stdout.String(), "will not start again after a reboot") {
		t.Errorf("detached start not reported:\n%s", tc.stdout.String())
	}
	if !strings.Contains(tc.stdout.String(), "The container shares this username") {
		t.Errorf("shared username not reported:\n%s", tc.stdout.String())
	}
	cfg, err := tc.loadConfig()
	if err != nil || cfg.Port != port || len(cfg.Password) != 12 || cfg.Mux != "tmux" || strings.Join(cfg.AllowHosts, ",") != "box.lan" || cfg.User != "bob" {
		t.Fatalf("config %+v %v", cfg, err)
	}
	pid := tc.readPIDFile()
	if pid == 0 {
		t.Fatal("serve wrote no PID file")
	}
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	for host, want := range map[string]int{"127.0.0.1": http.StatusUnauthorized, "box.lan": http.StatusUnauthorized, "evil.example": http.StatusForbidden} {
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
	if h, code := fetchHealth(port, "bob", cfg.Password); code != http.StatusOK || h.PID != pid || h.Version != cliVersion {
		t.Fatalf("health %+v %d", h, code)
	}
	if _, code := fetchHealth(port, adminUser, cfg.Password); code != http.StatusUnauthorized {
		t.Fatalf("admin still accepted after --user bob: %d", code)
	}

	tc.stdout.Reset()
	if code := tc.main([]string{"restart"}); code != 0 {
		t.Fatalf("restart: %s", tc.stderr.String())
	}
	if pid2 := tc.readPIDFile(); pid2 == pid || pidRunning(pid) {
		t.Fatalf("old server %d still running (new %d)", pid, pid2)
	}
	if code := tc.main([]string{"status"}); code != 0 {
		t.Fatalf("status after restart:\n%s", tc.stdout.String())
	}

	pid = tc.readPIDFile()
	if code := tc.main([]string{"stop"}); code != 0 {
		t.Fatalf("stop: %s", tc.stderr.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for pidRunning(pid) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if pidRunning(pid) || portFree("127.0.0.1", port) != nil {
		t.Fatalf("server %d still running after stop", pid)
	}
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

// A start that fails on Tailscale or a busy new port leaves the running
// server alone: the user may be connected through it.
func TestStartChecksBeforeStoppingTheServer(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.runner.paths["tmux"] = true
	port := freePort(t)
	tc.saveConfig(savedConfig{Port: port, Password: "p", Mux: "tmux"})
	svc := &fakeService{c: tc.cli, port: port, broken: map[string]string{}}
	tc.testSupervisors = []supervisor{svc}

	if code := tc.main([]string{"start", "--tailscale", "box.ts.net"}); code != 1 || !strings.Contains(tc.stderr.String(), "tailscale") {
		t.Fatalf("code %d stderr %q", code, tc.stderr.String())
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	busy := ln.Addr().(*net.TCPAddr).Port
	tc.stderr.Reset()
	if code := tc.main([]string{"start", "--port", strconv.Itoa(busy)}); code != 1 || !strings.Contains(tc.stderr.String(), "in use") {
		t.Fatalf("busy port: code %d stderr %q", code, tc.stderr.String())
	}
	if slices.Contains(svc.calls, "stop") {
		t.Fatalf("server stopped by a start that failed: %v", svc.calls)
	}
	if cfg, _ := tc.loadConfig(); cfg.Tailscale != "" || cfg.Port != port {
		t.Fatalf("config changed by a failed start: %+v", cfg)
	}
}

func TestHiddenLauncherQuoting(t *testing.T) {
	got := hiddenLauncher(`C:\Program Files\a"b\termote.cmd`, true)
	want := `WScript.Quit CreateObject("WScript.Shell").Run("""C:\Program Files\a""b\termote.cmd"" serve --service", 0, True)`
	if !strings.Contains(got, want) {
		t.Fatalf("launcher:\n%s\nwant:\n%s", got, want)
	}
}

// The state dir (the server log, the PID file) is the owner's alone, also
// when an older version created it 0755.
func TestEnsureStateDirPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permissions")
	}
	tc := newTestCLI(t, runtime.GOOS)
	if err := os.MkdirAll(tc.stateDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	os.Chmod(tc.stateDir(), 0o755)
	if err := tc.ensureStateDir(); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(tc.stateDir())
	if err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("state dir = %v, %v; want 0700", fi.Mode().Perm(), err)
	}
}

// A server whose backend does not answer (Herdr not started yet) runs: start
// warns instead of failing after the whole wait. Another version that is
// degraded is still not taken for the new server.
func TestWaitForServerDegraded(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"degraded","backend":"herdr","version":"1.0.0"}`))
	})}
	go srv.Serve(ln)
	defer srv.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	old := degradedGrace
	degradedGrace = 300 * time.Millisecond
	defer func() { degradedGrace = old }()

	tc := newTestCLI(t, "linux")
	if err := tc.waitForServer(port, "", "", "1.0.0", 5*time.Second, nil); err != nil {
		t.Fatalf("degraded server of the right version: %v", err)
	}
	// update's stability checks wait less than the grace: still running.
	if err := tc.waitForServer(port, "", "", "1.0.0", 400*time.Millisecond, nil); err != nil {
		t.Fatalf("degraded server, short wait: %v", err)
	}
	if out := tc.stderr.String() + tc.stdout.String(); strings.Count(out, "herdr backend does not answer") != 1 {
		t.Errorf("want one warning about the backend: %q", out)
	}
	if err := tc.waitForServer(port, "", "", "2.0.0", time.Second, nil); err == nil {
		t.Error("a degraded server of another version was taken for the new one")
	}
}
