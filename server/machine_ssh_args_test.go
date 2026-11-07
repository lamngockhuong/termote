package main

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

var testSSHPaths = sshPaths{Key: "/cfg/ssh/id_ed25519", KnownHosts: "/cfg/my ssh/known_hosts"}

// argvTail checks the destination ends argv after "--", and that nothing
// before it but termote's own options can be an option.
func checkSSHArgv(t *testing.T, name string, argv []string, m machineRecord, tail ...string) {
	t.Helper()
	i := slices.Index(argv, "--")
	if i < 0 || argv[i+1] != m.Alias || !slices.Equal(argv[i+2:], tail) {
		t.Errorf("%s: destination not after --: %q", name, argv)
	}
	for _, a := range argv[:i] {
		if strings.Contains(a, m.Alias) && a != m.Alias {
			t.Errorf("%s: the alias reached an option: %q", name, a)
		}
	}
	for _, want := range []string{"ClearAllForwardings=yes", "ForwardAgent=no", "PermitLocalCommand=no", "RemoteCommand=none", "RequestTTY=no", "HostKeyAlias=termote-" + m.ID, `UserKnownHostsFile="/cfg/my ssh/known_hosts"`} {
		if !slices.Contains(argv[:i], want) {
			t.Errorf("%s: missing -o %s in %q", name, want, argv)
		}
	}
}

func TestSSHArgv(t *testing.T) {
	m := testMachine("0123456789abcdef", "Box", "box")
	ctl := "/state/run/ssh/0123456789abcdef"

	b := sshBridgeArgv(testSSHPaths, m, ctl)
	checkSSHArgv(t, "bridge", b, m, "bridge")
	if b[1] != "-S" || b[2] != ctl {
		t.Errorf("bridge through the master: %q", b)
	}
	for _, want := range []string{"BatchMode=yes", "StrictHostKeyChecking=yes", "IdentitiesOnly=yes", "IdentityAgent=none"} {
		if !slices.Contains(b, want) {
			t.Errorf("bridge: missing %s", want)
		}
	}
	if slices.Contains(sshBridgeArgv(testSSHPaths, m, ""), "-S") {
		t.Error("a bridge without a master names one")
	}

	ms := sshMasterArgv(testSSHPaths, m, ctl)
	checkSSHArgv(t, "master", ms, m)
	if !slices.Equal(ms[:7], []string{"ssh", "-M", "-N", "-S", ctl, "-o", "ControlPersist=no"}) {
		t.Errorf("master: %q", ms)
	}
	ex := sshMasterExitArgv(testSSHPaths, m, ctl)
	checkSSHArgv(t, "exit", ex, m)
	if !slices.Equal(ex[:5], []string{"ssh", "-S", ctl, "-O", "exit"}) {
		t.Errorf("exit: %q", ex)
	}

	u := sshUserArgv(testSSHPaths.KnownHosts, m, "exit")
	checkSSHArgv(t, "user", u, m, "exit")
	if !slices.Contains(u, "StrictHostKeyChecking=ask") || slices.Contains(u, "BatchMode=yes") || slices.Contains(u, "-i") {
		t.Errorf("user ssh: %q", u)
	}
	if got := sshForgetHostArgv("/kh", m.ID); !slices.Equal(got, []string{"ssh-keygen", "-R", "termote-" + m.ID, "-f", "/kh"}) {
		t.Errorf("forget: %q", got)
	}
	if got := sshKeygenArgv("/k", "termote@h"); !slices.Equal(got, []string{"ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "termote@h", "-f", "/k"}) {
		t.Errorf("keygen: %q", got)
	}
	if got := sshOptValue(`C:\Users\A B\kh`); got != `"C:/Users/A B/kh"` {
		t.Errorf("sshOptValue = %s", got)
	}
}

func TestForcedCommandAndKeyLine(t *testing.T) {
	m := testMachine("0123456789abcdef", "Box", "box")
	line := authorizedKeyLine(m, "ssh-ed25519 AAAAC3Nz termote@h\n")
	want := `command="'/home/u/.local/share/termote/current/bin/termote' bridge --socket-dir '/home/u/.local/state/termote/run'",restrict ssh-ed25519 AAAAC3Nz termote@h`
	if line != want {
		t.Errorf("key line:\n%s\nwant\n%s", line, want)
	}
	w := machineRecord{RemoteExe: "C:/Users/u/AppData/Local/termote/versions/1.0.0/bin/termote.exe", RemoteOS: "windows"}
	if got := forcedCommand(w); got != `\"C:/Users/u/AppData/Local/termote/versions/1.0.0/bin/termote.exe\" bridge` {
		t.Errorf("windows forced command: %s", got)
	}
	m.SocketDir = ""
	if got := forcedCommand(m); strings.Contains(got, "socket-dir") {
		t.Errorf("no socket dir: %s", got)
	}
	if publicKeyBlob("ssh-ed25519 AAAA c") != "AAAA" || publicKeyBlob("x") != "" {
		t.Error("publicKeyBlob")
	}
}

func TestValidRemotePath(t *testing.T) {
	for p, ok := range map[string]bool{"/usr/bin/termote": true, "/a b/termote": true, "rel": false, `/a"b`: false, "/a'b": false, `/a\b`: false, "/a$b": false, "/a`b": false, "/a\nb": false, "/a\x7fb": false} {
		if (validRemotePath(p, "linux") == nil) != ok {
			t.Errorf("validRemotePath(%q, linux) ok=%v", p, !ok)
		}
	}
	for p, ok := range map[string]bool{"C:/x/termote.exe": true, "/x": false, `C:\x`: false} {
		if (validRemotePath(p, "windows") == nil) != ok {
			t.Errorf("validRemotePath(%q, windows) ok=%v", p, !ok)
		}
	}
}

func TestParseWhereami(t *testing.T) {
	w, err := parseWhereami([]byte("motd line\n" + `{"exe":"/opt/termote/bin/termote","socketDir":"/s/run","os":"linux","version":"2.0.0","apiVersion":2,"native":true}` + "\n"))
	if err != nil || w.Exe != "/opt/termote/bin/termote" || w.SocketDir != "/s/run" || !w.Native {
		t.Fatalf("whereami: %+v %v", w, err)
	}
	w, err = parseWhereami([]byte(`{"exe":"C:\\Users\\u\\termote.exe","socketDir":"C:\\x","os":"windows"}`))
	if err != nil || w.Exe != "C:/Users/u/termote.exe" || w.SocketDir != "" {
		t.Fatalf("windows whereami: %+v %v", w, err)
	}
	// Too old for whereami: its path and version, a path the forced command
	// could not hold dropped.
	w, err = parseWhereami([]byte("TERMOTE-OLD\nexe=/home/u/.local/bin/termote\nTermote v2.22.0\n"))
	if !errors.Is(err, errTermoteTooOld) || w.Exe != "/home/u/.local/bin/termote" || w.Version != "2.22.0" {
		t.Fatalf("old: %+v %v", w, err)
	}
	w, err = parseWhereami([]byte("TERMOTE-OLD\nexe=/a'b\n"))
	if !errors.Is(err, errTermoteTooOld) || w.Exe != "" || w.Version != "" {
		t.Fatalf("old, bad exe: %+v %v", w, err)
	}
	for name, out := range map[string]string{
		"missing":   "TERMOTE-NOT-FOUND\n",
		"garbage":   "sh: termote: not found",
		"no exe":    `{"os":"linux"}`,
		"bad exe":   `{"exe":"/a'b","os":"linux"}`,
		"bad sock":  `{"exe":"/a","socketDir":"rel","os":"linux"}`,
		"empty out": "",
	} {
		if _, err := parseWhereami([]byte(out)); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
}
