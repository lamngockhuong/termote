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
	if err := tc.cmdMachine([]string{"add", "box", "--yes"}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("termote missing there: %v", err)
	}
	// ssh itself failed and printed nothing useful.
	tc.runner.onOutput = func(argv, _ []string) (string, bool) {
		if argv[0] == "ssh-keygen" {
			return "", true
		}
		return "", false
	}
	old := tc.run
	tc.run = failingInteract{tc.runner}
	defer func() { tc.run = old }()
	if err := tc.cmdMachine([]string{"add", "box", "--yes"}); err == nil || !strings.Contains(err.Error(), "--remote-exe") {
		t.Errorf("ssh failed: %v", err)
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

func TestMachineListRemoveStatus(t *testing.T) {
	tc := machineCLI(t, "y\n", nil)
	if err := tc.cmdMachine(nil); err != nil || !strings.Contains(tc.stdout.String(), "None") {
		t.Errorf("empty list: %v\n%s", err, tc.stdout)
	}
	saveMachines(tc.machinesFile(), []machineRecord{testMachine("0123456789abcdef", "Box", "box")})
	os.MkdirAll(tc.machineSSHDir(), 0o700)
	os.WriteFile(tc.machineSSHPaths().Key+".pub", []byte("ssh-ed25519 AAAAtest c\n"), 0o644)
	os.WriteFile(tc.machineSSHPaths().KnownHosts, []byte("x"), 0o600)

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
