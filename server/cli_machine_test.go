package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

const testWhereami = `{"exe":"/home/u/.local/share/termote/current/bin/termote","socketDir":"/home/u/.local/state/termote/run","os":"linux","version":"2.0.0","apiVersion":2,"native":true}`

// machineCLI is a test CLI with ssh and ssh-keygen: ssh-keygen writes a key,
// ssh -G prints sshG, the user's ssh answers whereami, and the service
// check answers check.
func machineCLI(t *testing.T, input string, check error) *testCLI {
	t.Helper()
	tc := newTestCLI(t, "linux")
	tc.in = bufio.NewReader(strings.NewReader(input))
	tc.runner.paths["ssh"] = true
	tc.runner.paths["ssh-keygen"] = true
	tc.runner.onOutput = func(argv, _ []string) (string, bool) {
		switch {
		case argv[0] == "ssh-keygen" && slices.Contains(argv, "-t"):
			key := argv[len(argv)-1]
			os.WriteFile(key, []byte("PRIVATE"), 0o600)
			os.WriteFile(key+".pub", []byte("ssh-ed25519 AAAAtest termote@box\n"), 0o644)
			return "", true
		case argv[0] == "ssh-keygen":
			return "", true
		case argv[0] == "ssh" && slices.Contains(argv, "-G"):
			return "hostname box\nproxycommand none\n", true
		case argv[0] == "ssh" && argv[len(argv)-1] == whereamiScript:
			return testWhereami + "\n", true
		}
		return "", false
	}
	old := machineDial
	t.Cleanup(func() { machineDial = old })
	machineDial = func(context.Context, sshPaths, machineRecord) (net.Conn, string, error) {
		if check != nil {
			return nil, "", check
		}
		return newHealthConn(t, apiVersion), "", nil
	}
	return tc
}

// newHealthConn is the bridge side of a connection that answers health with
// the given apiVersion.
func newHealthConn(t *testing.T, v int) net.Conn {
	mine, theirs := net.Pipe()
	go func() {
		defer theirs.Close()
		rd := bufio.NewReader(theirs)
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		body, _ := json.Marshal(map[string]any{"status": "ok", "apiVersion": v})
		theirs.Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + itoa(len(body)) + "\r\n\r\n"))
		theirs.Write(body)
	}()
	return mine
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestMachineAddInstallsKeyAndSaves(t *testing.T) {
	tc := machineCLI(t, "y\n", nil)
	if err := tc.cmdMachine([]string{"add", "box", "--label", "Home box"}); err != nil {
		t.Fatalf("add: %v\n%s", err, tc.stderr)
	}
	list, err := loadMachines(tc.machinesFile())
	if err != nil || len(list) != 1 {
		t.Fatalf("store: %+v %v", list, err)
	}
	m := list[0]
	if m.Label != "Home box" || m.Alias != "box" || m.RemoteExe != "/home/u/.local/share/termote/current/bin/termote" || m.SocketDir != "/home/u/.local/state/termote/run" {
		t.Errorf("record: %+v", m)
	}
	// The key line went to the machine on stdin of the user's ssh, with the
	// forced command and restrict.
	var installed string
	for _, in := range tc.runner.inputs {
		if strings.HasPrefix(in, "command=") {
			installed = in
		}
	}
	if want := authorizedKeyLine(m, "ssh-ed25519 AAAAtest termote@box") + "\n"; installed != want {
		t.Errorf("installed %q, want %q", installed, want)
	}
	if fi, err := os.Stat(tc.machineSSHDir()); err != nil || (runtime.GOOS != "windows" && fi.Mode().Perm() != 0o700) {
		t.Errorf("ssh dir: %v %v", fi, err)
	}
	if strings.Contains(tc.stdout.String(), "PRIVATE") {
		t.Error("the private key was printed")
	}
	// A second add of the same alias or label is refused.
	if err := tc.cmdMachine([]string{"add", "box"}); err == nil {
		t.Error("the same alias was added twice")
	}
	if err := tc.cmdMachine([]string{"add", "other", "--label", "Home box"}); err == nil {
		t.Error("the same label was added twice")
	}
}

// Without a yes the key is not installed and nothing is saved; a failed
// check saves nothing either, unless --no-check.
func TestMachineAddRefusals(t *testing.T) {
	tc := machineCLI(t, "n\n", nil)
	if err := tc.cmdMachine([]string{"add", "box"}); err == nil {
		t.Error("added without installing the key")
	}
	if list, _ := loadMachines(tc.machinesFile()); len(list) != 0 {
		t.Errorf("saved without a key: %+v", list)
	}

	for _, e := range []error{errMachineUnauthorized, errMachineHostKey, errMachineIncompatible, errMachineNoServer, errMachineOffline} {
		tc := machineCLI(t, "", e)
		err := tc.cmdMachine([]string{"add", "box", "--yes"})
		if err == nil || !strings.Contains(err.Error(), "not added") {
			t.Errorf("%v: %v", e, err)
		}
		if list, _ := loadMachines(tc.machinesFile()); len(list) != 0 {
			t.Errorf("%v: saved after a failed check", e)
		}
	}
	tc = machineCLI(t, "", errMachineOffline)
	if err := tc.cmdMachine([]string{"add", "box", "--yes", "--no-check"}); err != nil {
		t.Errorf("--no-check: %v", err)
	}
}

func TestMachineAddUsageErrors(t *testing.T) {
	tc := machineCLI(t, "", nil)
	for _, args := range [][]string{
		{"add"}, {"add", "a", "b"}, {"add", "-oProxyCommand=x"}, {"add", "box", "--label", " x"}, {"add", "--bogus"},
		{"add", "box", "--remote-exe", "relative", "--yes"},
	} {
		if err := tc.cmdMachine(args); err == nil {
			t.Errorf("%q was taken", args)
		}
	}
	tc.runner.paths["ssh-keygen"] = false
	if err := tc.cmdMachine([]string{"add", "box"}); err == nil || !strings.Contains(err.Error(), "OpenSSH") {
		t.Errorf("without ssh-keygen: %v", err)
	}
}

// A Windows machine gets the line to install by hand, pointing at
// termote.exe, and a TOFU session that runs nothing but exit.
func TestMachineAddPrintKeyWindows(t *testing.T) {
	tc := machineCLI(t, "", nil)
	err := tc.cmdMachine([]string{"add", "winbox", "--remote-exe", `C:\Users\u\AppData\Local\termote\versions\2.0.0\bin\termote.exe`})
	if err != nil {
		t.Fatalf("add windows: %v", err)
	}
	out := tc.stdout.String()
	if !strings.Contains(out, `command="\"C:/Users/u/AppData/Local/termote/versions/2.0.0/bin/termote.exe\" bridge",restrict ssh-ed25519 AAAAtest`) ||
		!strings.Contains(out, "administrators_authorized_keys") {
		t.Errorf("printed key:\n%s", out)
	}
	if !tc.runner.called("ssh -o StrictHostKeyChecking=ask") {
		t.Errorf("no TOFU session: %v", tc.runner.calls)
	}
	list, _ := loadMachines(tc.machinesFile())
	if len(list) != 1 || list[0].RemoteOS != "windows" || list[0].SocketDir != "" {
		t.Errorf("windows record: %+v", list)
	}
}

// --print-key on a Unix machine prints the line and installs nothing.
func TestMachineAddPrintKey(t *testing.T) {
	tc := machineCLI(t, "", nil)
	if err := tc.cmdMachine([]string{"add", "box", "--print-key"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tc.stdout.String(), "~/.ssh/authorized_keys") {
		t.Errorf("print-key:\n%s", tc.stdout)
	}
	for _, in := range tc.runner.inputs {
		if strings.HasPrefix(in, "command=") {
			t.Error("--print-key installed the key")
		}
	}
}

func TestMachineAddDiscoveryFailures(t *testing.T) {
	tc := machineCLI(t, "", nil)
	tc.runner.onOutput = func(argv, _ []string) (string, bool) {
		if argv[0] == "ssh" && argv[len(argv)-1] == whereamiScript {
			return "TERMOTE-NOT-FOUND\n", true
		}
		if argv[0] == "ssh-keygen" {
			key := argv[len(argv)-1]
			os.WriteFile(key+".pub", []byte("ssh-ed25519 AAAAtest c\n"), 0o644)
			return "", true
		}
		return "", false
	}
	// No terminal and no --yes: nothing is installed there.
	if err := tc.cmdMachine([]string{"add", "box"}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("termote missing there: %v", err)
	}
	// The real script exits 3 after saying so: still "not found", not the
	// Windows hint for an ssh that failed.
	old := tc.run
	tc.run = notFoundInteract{tc.runner}
	err := tc.cmdMachine([]string{"add", "box"})
	tc.run = old
	if err == nil || !strings.Contains(err.Error(), "box: termote was not found") || strings.Contains(err.Error(), "Windows") {
		t.Errorf("termote missing there, exit 3: %v", err)
	}
	if tc.runner.called("ssh") && slices.ContainsFunc(tc.runner.calls, func(c string) bool { return strings.Contains(c, "install.sh") }) {
		t.Error("installed termote without a yes")
	}
	// ssh itself failed and printed nothing useful.
	tc.runner.onOutput = func(argv, _ []string) (string, bool) {
		if argv[0] == "ssh-keygen" {
			return "", true
		}
		return "", false
	}
	tc.run = failingInteract{tc.runner}
	defer func() { tc.run = old }()
	if err := tc.cmdMachine([]string{"add", "box", "--yes"}); err == nil || !strings.Contains(err.Error(), "--remote-exe") {
		t.Errorf("ssh failed: %v", err)
	}
}

// notFoundInteract answers every Interact call as whereamiScript does on a
// machine without termote: the marker, then exit status 3.
type notFoundInteract struct{ *fakeRunner }

func (f notFoundInteract) Interact(string, string, ...string) ([]byte, error) {
	return []byte("TERMOTE-NOT-FOUND\n"), errors.New("exit status 3")
}

// scriptedInteract answers the user's ssh by the remote command it runs:
// whereamiScript gets the next of whereamis, every other one fn.
type scriptedInteract struct {
	*fakeRunner
	whereamis []string
	fn        func(command string) error
}

func (f *scriptedInteract) Interact(input string, name string, args ...string) ([]byte, error) {
	f.record(name, args)
	cmd := args[len(args)-1]
	if cmd != whereamiScript {
		return nil, f.fn(cmd)
	}
	if len(f.whereamis) == 0 {
		return nil, errors.New("no more whereami")
	}
	out := f.whereamis[0]
	f.whereamis = f.whereamis[1:]
	if out == "TERMOTE-NOT-FOUND" {
		return []byte(out + "\n"), errors.New("exit status 3")
	}
	if strings.HasPrefix(out, "TERMOTE-OLD") {
		return []byte(out + "\n"), errors.New("exit status 4")
	}
	return []byte(out + "\n"), nil
}

const testWhereamiNoConfig = `{"exe":"/home/u/.local/share/termote/current/bin/termote","socketDir":"/home/u/.local/state/termote/run","os":"linux","version":"1.0.0","apiVersion":2,"native":false}`

// Without termote there, add installs this release, starts it and adds it.
func TestMachineAddInstallsTermote(t *testing.T) {
	tc := machineCLI(t, "y\ny\n", nil)
	var cmds []string
	tc.run = &scriptedInteract{fakeRunner: tc.runner,
		whereamis: []string{"TERMOTE-NOT-FOUND", testWhereamiNoConfig, testWhereami},
		fn:        func(c string) error { cmds = append(cmds, c); return nil }}
	if err := tc.cmdMachine([]string{"add", "box"}); err != nil {
		t.Fatalf("%v\n%s", err, tc.stdout)
	}
	if len(cmds) != 3 || cmds[0] != remoteInstallScript("1.0.0") || !strings.Contains(cmds[0], "TERMOTE_VERSION=1.0.0 ") ||
		cmds[1] != remoteExeScript("/home/u/.local/share/termote/current/bin/termote", "start") || cmds[2] != installKeyScript {
		t.Errorf("commands: %q", cmds)
	}
	if !strings.Contains(tc.stdout.String(), "Install Termote 1.0.0 there and start it?") {
		t.Errorf("asked:\n%s", tc.stdout)
	}
	list, _ := loadMachines(tc.machinesFile())
	if len(list) != 1 || list[0].RemoteExe != "/home/u/.local/share/termote/current/bin/termote" {
		t.Errorf("saved: %+v", list)
	}

	// A config left by an earlier install (uninstall without --purge):
	// started all the same, since nothing runs. A checkout's version that
	// is no release installs the latest one.
	tc = machineCLI(t, "", nil)
	tc.version = "dev"
	cmds = nil
	tc.run = &scriptedInteract{fakeRunner: tc.runner,
		whereamis: []string{"TERMOTE-NOT-FOUND", testWhereami, testWhereami},
		fn:        func(c string) error { cmds = append(cmds, c); return nil }}
	if err := tc.cmdMachine([]string{"add", "box", "--yes"}); err != nil {
		t.Fatal(err)
	}
	if len(cmds) != 3 || cmds[0] != remoteInstallScript("") || strings.Contains(cmds[0], "TERMOTE_VERSION") ||
		cmds[1] != remoteExeScript("/home/u/.local/share/termote/current/bin/termote", "start") {
		t.Errorf("commands: %q", cmds)
	}
}

func TestMachineAddInstallFailures(t *testing.T) {
	for _, tt := range []struct {
		name      string
		whereamis []string
		failOn    string
		want      string
	}{
		{"install", []string{"TERMOTE-NOT-FOUND"}, "install.sh", "installing termote on box failed"},
		{"still missing", []string{"TERMOTE-NOT-FOUND", "TERMOTE-NOT-FOUND"}, "", "box: termote was not found"},
		{"start", []string{"TERMOTE-NOT-FOUND", testWhereamiNoConfig}, "' start", "starting termote on box failed"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			tc := machineCLI(t, "", nil)
			tc.run = &scriptedInteract{fakeRunner: tc.runner, whereamis: tt.whereamis, fn: func(c string) error {
				if tt.failOn != "" && strings.Contains(c, tt.failOn) {
					return errors.New("exit status 1")
				}
				return nil
			}}
			if err := tc.cmdMachine([]string{"add", "box", "--yes"}); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("got %v, want %q", err, tt.want)
			}
		})
	}
}

// An older termote there is updated to this release after a yes.
func TestMachineAddUpdatesOlderTermote(t *testing.T) {
	newer := strings.Replace(testWhereami, `"2.0.0"`, `"3.0.0"`, 1)
	exe := "/home/u/.local/share/termote/current/bin/termote"
	for _, tt := range []struct {
		name, input string
		flags       []string
		fail        bool
		updated     bool
	}{
		{"yes", "y\ny\n", nil, false, true},
		{"--yes", "", []string{"--yes"}, false, true},
		{"declined", "n\ny\n", nil, false, false},
		{"update fails", "", []string{"--yes"}, true, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			tc := machineCLI(t, tt.input, nil)
			tc.version = "3.0.0"
			var cmds []string
			tc.run = &scriptedInteract{fakeRunner: tc.runner, whereamis: []string{testWhereami, newer},
				fn: func(c string) error {
					cmds = append(cmds, c)
					if tt.fail && c != installKeyScript {
						return errors.New("exit status 1")
					}
					return nil
				}}
			if err := tc.cmdMachine(append([]string{"add", "box"}, tt.flags...)); err != nil {
				t.Fatal(err)
			}
			if got := slices.Contains(cmds, remoteExeScript(exe, "update", "--version", "3.0.0")); got != tt.updated {
				t.Errorf("updated %v, commands %q", got, cmds)
			}
			if tt.fail && !strings.Contains(tc.stderr.String()+tc.stdout.String(), "updating termote on box failed") {
				t.Errorf("no warning:\n%s%s", tc.stdout, tc.stderr)
			}
		})
	}
	// Same or newer there: nothing to update.
	tc := machineCLI(t, "", nil)
	var cmds []string
	tc.run = &scriptedInteract{fakeRunner: tc.runner, whereamis: []string{testWhereami},
		fn: func(c string) error { cmds = append(cmds, c); return nil }}
	if err := tc.cmdMachine([]string{"add", "box", "--yes"}); err != nil {
		t.Fatal(err)
	}
	if len(cmds) != 1 || cmds[0] != installKeyScript {
		t.Errorf("commands: %q", cmds)
	}
}

const testWhereamiOld = "TERMOTE-OLD\nexe=/home/u/.local/bin/termote\nTermote v2.22.0"

// A termote too old for whereami (and the bridge) is updated to this release
// after a yes, then asked again; otherwise add stops and says why.
func TestMachineAddUpdatesTooOldTermote(t *testing.T) {
	update := remoteExeScript("/home/u/.local/bin/termote", "update", "--version", "3.0.0")
	for _, tt := range []struct {
		name, input, version string
		flags                []string
		whereamis            []string
		fail                 bool
		want                 string // "" when added
		updated              bool
	}{
		{"yes", "y\ny\n", "3.0.0", nil, []string{testWhereamiOld, testWhereami}, false, "", true},
		{"--yes", "", "3.0.0", []string{"--yes"}, []string{testWhereamiOld, testWhereami}, false, "", true},
		{"declined", "n\n", "3.0.0", nil, []string{testWhereamiOld}, false, "box: termote there is 2.22.0, too old", false},
		{"no version said", "n\n", "3.0.0", nil, []string{"TERMOTE-OLD\nexe=/home/u/.local/bin/termote"}, false, "an older version, too old", false},
		{"checkout", "", "dev", []string{"--yes"}, []string{testWhereamiOld}, false, "too old to be reached: update it there", false},
		{"update fails", "", "3.0.0", []string{"--yes"}, []string{testWhereamiOld}, true, "updating termote on box failed", true},
		{"still old", "", "3.0.0", []string{"--yes"}, []string{testWhereamiOld, testWhereamiOld}, false, "box: termote on the machine is too old", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			tc := machineCLI(t, tt.input, nil)
			tc.version = tt.version
			var cmds []string
			tc.run = &scriptedInteract{fakeRunner: tc.runner, whereamis: tt.whereamis, fn: func(c string) error {
				cmds = append(cmds, c)
				if tt.fail {
					return errors.New("exit status 1")
				}
				return nil
			}}
			err := tc.cmdMachine(append([]string{"add", "box"}, tt.flags...))
			if tt.want == "" && err != nil || tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want)) {
				t.Errorf("got %v, want %q", err, tt.want)
			}
			if err != nil && strings.Contains(err.Error(), "Windows") {
				t.Errorf("Windows hint for an old termote: %v", err)
			}
			if got := slices.Contains(cmds, update); got != tt.updated {
				t.Errorf("updated %v, commands %q", got, cmds)
			}
		})
	}
}

// failingInteract fails every Interact call.
type failingInteract struct{ *fakeRunner }

func (f failingInteract) Interact(string, string, ...string) ([]byte, error) {
	return nil, errors.New("exit status 255")
}

func TestMachineAddWarnings(t *testing.T) {
	tc := machineCLI(t, "", nil)
	tc.runner.onOutput = func(argv, _ []string) (string, bool) {
		switch {
		case argv[0] == "ssh-keygen":
			os.WriteFile(argv[len(argv)-1]+".pub", []byte("ssh-ed25519 AAAAtest c\n"), 0o644)
			return "", true
		case slices.Contains(argv, "-G"):
			return "proxyjump bastion\n", true
		case argv[len(argv)-1] == whereamiScript:
			return `{"exe":"/t","socketDir":"/s","os":"linux","apiVersion":1,"native":false}`, true
		}
		return "", false
	}
	if err := tc.cmdMachine([]string{"add", "box", "--yes"}); err != nil {
		t.Fatal(err)
	}
	out := tc.stdout.String()
	for _, want := range []string{"proxyjump", "no saved config", "speaks API 1"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing warning %q:\n%s", want, out)
		}
	}
}

// A host the user's own known_hosts already holds is not a new TOFU: its
// keys go into termote's known_hosts under the machine's name before the
// first connection, so that ssh checks the key instead of asking. A machine
// not added takes them out again.
func TestMachineAddSeedsKnownHostKeys(t *testing.T) {
	for _, check := range []error{nil, errMachineOffline} {
		t.Run(map[bool]string{true: "added", false: "not added"}[check == nil], func(t *testing.T) {
			tc := machineCLI(t, "y\n", check)
			dir := t.TempDir()
			user, global := filepath.Join(dir, "known_hosts"), filepath.Join(dir, "ssh_known_hosts")
			os.WriteFile(user, []byte("# the user's\n"), 0o600)
			base := tc.runner.onOutput
			var atFirstSSH, id string
			tc.runner.onOutput = func(argv, env []string) (string, bool) {
				switch {
				case slices.Contains(argv, "-G"):
					return "hostname box.lan\nport 2222\nuserknownhostsfile " + user + " " + filepath.Join(dir, "missing") + "\nglobalknownhostsfile " + global + "\nproxycommand none\n", true
				case argv[0] == "ssh-keygen" && slices.Contains(argv, "-F"):
					if !slices.Equal(argv[1:], []string{"-F", "[box.lan]:2222", "-f", user}) {
						t.Errorf("ssh-keygen %v", argv[1:])
						return "", false
					}
					return "# Host [box.lan]:2222 found: line 2\n|1|c2FsdA==|aGFzaA== ssh-ed25519 AAAAhost\n@revoked [box.lan]:2222 ssh-rsa AAAAold\n@cert-authority *.lan ssh-ed25519 AAAAca\n", true
				case argv[0] == "ssh" && argv[len(argv)-1] == whereamiScript && atFirstSSH == "":
					b, _ := os.ReadFile(tc.machineSSHPaths().KnownHosts)
					atFirstSSH = string(b) + "\x00"
					if f := strings.Fields(string(b)); len(f) > 0 {
						id = strings.TrimPrefix(f[0], "termote-")
					}
				}
				return base(argv, env)
			}
			err := tc.cmdMachine([]string{"add", "box"})
			name := "termote-" + id
			if want := name + " ssh-ed25519 AAAAhost\n@revoked " + name + " ssh-rsa AAAAold\n\x00"; atFirstSSH != want {
				t.Errorf("termote's known_hosts at the first ssh = %q, want %q", atFirstSSH, want)
			}
			list, _ := loadMachines(tc.machinesFile())
			if check == nil {
				if err != nil || len(list) != 1 || list[0].ID != id {
					t.Fatalf("add: %v %+v\n%s", err, list, tc.stderr)
				}
				return
			}
			b, _ := os.ReadFile(tc.machineSSHPaths().KnownHosts)
			if err == nil || len(list) != 0 || strings.Contains(string(b), "@revoked") || !tc.runner.called("ssh-keygen -R "+name+" -f "+tc.machineSSHPaths().KnownHosts) {
				t.Errorf("not added: %v %+v, known_hosts %q", err, list, b)
			}
		})
	}
}

func TestMachineListRemoveStatus(t *testing.T) {
	tc := machineCLI(t, "y\n", nil)
	if err := tc.cmdMachine(nil); err != nil || !strings.Contains(tc.stdout.String(), "None") {
		t.Errorf("empty list: %v\n%s", err, tc.stdout)
	}
	saveMachines(tc.machinesFile(), []machineRecord{testMachine("0123456789abcdef", "Box", "box")})
	os.MkdirAll(tc.machineSSHDir(), 0o700)
	os.WriteFile(tc.machineSSHPaths().Key+".pub", []byte("ssh-ed25519 AAAAtest c\n"), 0o644)
	os.WriteFile(tc.machineSSHPaths().KnownHosts, []byte("other ssh-ed25519 AAAAo\n@revoked termote-0123456789abcdef ssh-rsa AAAAold\n"), 0o600)

	tc.stdout.Reset()
	if err := tc.cmdMachine([]string{"list"}); err != nil || !strings.Contains(tc.stdout.String(), "Box") {
		t.Errorf("list: %v\n%s", err, tc.stdout)
	}
	tc.stdout.Reset()
	if err := tc.cmdMachine([]string{"list", "--json"}); err != nil || !strings.Contains(tc.stdout.String(), `"alias":"box"`) {
		t.Errorf("list --json: %v\n%s", err, tc.stdout)
	}
	tc.stdout.Reset()
	if err := tc.cmdMachine([]string{"status", "--json"}); err != nil || !strings.Contains(tc.stdout.String(), `"status":"online"`) || strings.Contains(tc.stdout.String(), "box\"") {
		t.Errorf("status --json: %v\n%s", err, tc.stdout)
	}
	tc.stdout.Reset()
	if err := tc.cmdMachine([]string{"status"}); err != nil || !strings.Contains(tc.stdout.String(), "online") {
		t.Errorf("status: %v\n%s", err, tc.stdout)
	}

	if err := tc.cmdMachine([]string{"remove", "nope"}); err == nil {
		t.Error("an unknown machine was removed")
	}
	if err := tc.cmdMachine([]string{"remove", "Box"}); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if list, _ := loadMachines(tc.machinesFile()); len(list) != 0 {
		t.Errorf("still stored: %+v", list)
	}
	if !slices.Contains(tc.runner.inputs, "AAAAtest\n") {
		t.Errorf("the key was not removed from the machine: %q", tc.runner.inputs)
	}
	if !tc.runner.called("ssh-keygen -R termote-0123456789abcdef -f " + tc.machineSSHPaths().KnownHosts) {
		t.Errorf("the host key was not forgotten: %v", tc.runner.calls)
	}
	if b, _ := os.ReadFile(tc.machineSSHPaths().KnownHosts); string(b) != "other ssh-ed25519 AAAAo\n" {
		t.Errorf("known_hosts after remove = %q", b)
	}
	tc.stdout.Reset()
	if err := tc.cmdMachine([]string{"status"}); err != nil || !strings.Contains(tc.stdout.String(), "None") {
		t.Errorf("empty status: %v\n%s", err, tc.stdout)
	}
	for _, args := range [][]string{{"remove"}, {"list", "x"}, {"status", "x"}, {"bogus"}, {"import"}, {"remove", "--bogus"}, {"list", "--bogus"}, {"status", "--bogus"}, {"import", "--bogus"}} {
		if err := tc.cmdMachine(args); err == nil {
			t.Errorf("%q was taken", args)
		}
	}
}

func TestMachineStatusUnreachable(t *testing.T) {
	tc := machineCLI(t, "", errMachineUnauthorized)
	saveMachines(tc.machinesFile(), []machineRecord{testMachine("0123456789abcdef", "Box", "box")})
	if err := tc.cmdMachine([]string{"status"}); err != nil || !strings.Contains(tc.stdout.String(), "unauthorized") {
		t.Errorf("status: %v\n%s", err, tc.stdout)
	}
	tc2 := machineCLI(t, "", nil)
	old := machineDial
	machineDial = func(context.Context, sshPaths, machineRecord) (net.Conn, string, error) {
		return newHealthConn(t, apiVersion+1), "", nil
	}
	defer func() { machineDial = old }()
	saveMachines(tc2.machinesFile(), []machineRecord{testMachine("0123456789abcdef", "Box", "box")})
	if err := tc2.cmdMachine([]string{"status"}); err != nil || !strings.Contains(tc2.stdout.String(), "incompatible") {
		t.Errorf("other apiVersion: %v\n%s", err, tc2.stdout)
	}
}

func TestMachineImportHerdr(t *testing.T) {
	tc := machineCLI(t, "y\nn\n", nil)
	if err := tc.cmdMachine([]string{"import", "--herdr"}); err == nil || !strings.Contains(err.Error(), "herdr was not found") {
		t.Errorf("without herdr: %v", err)
	}
	tc.runner.paths["herdr"] = true
	inner := tc.runner.onOutput
	tc.runner.onOutput = func(argv, env []string) (string, bool) {
		if argv[0] == "herdr" {
			return `{"machines":[{"ssh":"box"},"pi",{"name":"-bad"},{"x":1},5]}`, true
		}
		return inner(argv, env)
	}
	tc.in = bufio.NewReader(strings.NewReader("y\ny\nn\n"))
	if err := tc.cmdMachine([]string{"import", "--herdr"}); err != nil {
		t.Fatalf("import: %v\n%s", err, tc.stderr)
	}
	list, _ := loadMachines(tc.machinesFile())
	if len(list) != 1 || list[0].Alias != "box" {
		t.Errorf("imported: %+v", list)
	}
	if !strings.Contains(tc.stdout.String(), `skipped "-bad"`) {
		t.Errorf("bad alias not reported:\n%s", tc.stdout)
	}
	// A second import fails on the duplicate and says so.
	tc.in = bufio.NewReader(strings.NewReader("y\ny\ny\n"))
	if err := tc.cmdMachine([]string{"import", "--herdr"}); err == nil {
		t.Error("a duplicate import reported success")
	}
	tc.runner.onOutput = func(argv, env []string) (string, bool) {
		if argv[0] == "herdr" {
			return `[]`, true
		}
		return inner(argv, env)
	}
	if err := tc.cmdMachine([]string{"import", "--herdr"}); err != nil {
		t.Errorf("empty herdr list: %v", err)
	}
	tc.runner.onOutput = func(argv, env []string) (string, bool) {
		if argv[0] == "herdr" {
			return `nope`, true
		}
		return inner(argv, env)
	}
	if err := tc.cmdMachine([]string{"import", "--herdr"}); err == nil {
		t.Error("garbage from herdr was taken")
	}
	tc.runner.onOutput = inner
	if err := tc.cmdMachine([]string{"import", "--herdr"}); err == nil || !strings.Contains(err.Error(), "herdr machine list failed") {
		t.Errorf("herdr failing: %v", err)
	}
}

func TestMachineWhereami(t *testing.T) {
	// Read as printed: the paths are this test host's, which parseWhereami
	// (TestParseWhereami) would refuse for a linux machine on Windows.
	tc := newTestCLI(t, "linux")
	if err := tc.cmdMachine([]string{"whereami"}); err != nil {
		t.Fatal(err)
	}
	var w whereami
	err := json.Unmarshal(tc.stdout.Bytes(), &w)
	if err != nil || w.Exe != tc.exe || w.SocketDir != tc.localSocketDir() || w.OS != "linux" || w.Native || w.APIVersion != apiVersion {
		t.Errorf("whereami: %+v %v", w, err)
	}
	win := newTestCLI(t, "windows")
	win.exe = `C:\Users\u\AppData\Local\termote\versions\2.0.0\bin\termote.exe`
	win.home = `C:\Users\u`
	win.saveConfig(savedConfig{Port: 7690, Password: "x"})
	if err := win.cmdMachine([]string{"whereami"}); err != nil {
		t.Fatal(err)
	}
	var ww whereami
	json.Unmarshal(win.stdout.Bytes(), &ww)
	if strings.Contains(ww.Exe, `\`) || ww.SocketDir != "" || ww.OS != "windows" {
		t.Errorf("windows whereami: %+v", ww)
	}
}

func TestMachineCheckHint(t *testing.T) {
	for _, e := range []error{errMachineUnauthorized, errMachineHostKey, errMachineIncompatible, errMachineNoServer, errMachineOffline} {
		if machineCheckHint(e) == "" {
			t.Errorf("no hint for %v", e)
		}
	}
}

func TestParseHerdrMachines(t *testing.T) {
	got, err := parseHerdrMachines([]byte(`["a",{"host":"b"},{"alias":"c"}]`))
	if err != nil || !slices.Equal(got, []string{"a", "b", "c"}) {
		t.Errorf("bare list: %q %v", got, err)
	}
}

func TestEnsureMachineKeyErrors(t *testing.T) {
	tc := machineCLI(t, "", nil)
	tc.runner.onOutput = nil
	if _, err := tc.ensureMachineKey(); err == nil || !strings.Contains(err.Error(), "ssh-keygen failed") {
		t.Errorf("keygen failing: %v", err)
	}
	os.WriteFile(tc.machineSSHPaths().Key, []byte("k"), 0o600)
	os.WriteFile(tc.machineSSHPaths().Key+".pub", []byte("junk"), 0o600)
	if _, err := tc.ensureMachineKey(); err == nil {
		t.Error("a junk public key was taken")
	}
	os.Remove(tc.machineSSHPaths().Key + ".pub")
	if _, err := tc.ensureMachineKey(); err == nil {
		t.Error("a missing public key was taken")
	}
	file := filepath.Join(t.TempDir(), "f")
	os.WriteFile(file, nil, 0o600)
	tc.env["XDG_CONFIG_HOME"] = file
	if _, err := tc.ensureMachineKey(); err == nil {
		t.Error("an ssh dir under a file was made")
	}
}
