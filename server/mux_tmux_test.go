package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestValidateTmuxTarget(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		// Valid targets - basic
		{"main", true},
		{"0", true},
		{"session:window", true},
		{"my-session", true},
		{"my_session", true},
		{"session.pane", true},
		{"Session123", true},

		// Valid targets - spaces and Unicode (tmux supports these)
		{"session name", true},   // space allowed
		{"tên tiếng việt", true}, // Vietnamese
		{"会话名称", true},           // Chinese
		{"セッション", true},          // Japanese
		{" leading", true},       // leading space
		{"trailing ", true},      // trailing space

		// Valid targets - special chars (safe with exec.Command, no shell injection)
		{"$(whoami)", true},   // not executed - passed literally to tmux
		{"; rm -rf /", true},  // not executed - passed literally to tmux
		{"session`id`", true}, // backticks safe with exec.Command
		{"session|cat", true}, // pipe safe with exec.Command

		// Invalid targets - empty or too long
		{"", false},
		{string(make([]byte, 65)), false}, // too long (65 chars)

		// Invalid targets - control characters
		{"session\nid", false},        // newline
		{"session\x00id", false},      // null byte
		{"session\tid", false},        // tab (control char)
		{"session\rid", false},        // carriage return
		{"\x1b[31mred\x1b[0m", false}, // ANSI escape
	}

	for _, tt := range tests {
		if got := validateTmuxTarget(tt.input); got != tt.want {
			t.Errorf("validateTmuxTarget(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestParseTmuxID(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, false)
	tests := []struct {
		input, target, sessionID string
		ok                       bool
	}{
		{"0", "=main:=0", "", true},
		{"12", "=main:=12", "", true},
		{"$3:1", "$3:=1", "$3", true},
		{"$30:0", "$30:=0", "$30", true},
		{"$3:x", "", "", false},
		{"$:1", "", "", false},
		{"3:1", "", "", false},
		{"$3", "", "", false},
		{"other:0", "", "", false}, // a session name is not an id
		{"main:0", "", "", false},  // the default session's tabs are bare
		{"a;:1", "", "", false},
		{"w*:0", "", "", false},
		{"=x:0", "", "", false},
		{"shell", "", "", false}, // a window name is not an id
		{"my-window", "", "", false},
		{"-t", "", "", false},
		{"0;", "", "", false},
		{"-1", "", "", false},
		{"$3:1\n", "", "", false},
		{"1234567890", "", "", false},
		{"", "", "", false},
	}
	for _, tt := range tests {
		w, ok := parseTmuxID(tt.input)
		if ok != tt.ok || ok && (w.target() != tt.target || w.sessionID != tt.sessionID) {
			t.Errorf("parseTmuxID(%q) = %+v, %v", tt.input, w, ok)
		}
	}
}

func TestParseTmuxGroupID(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	for in, want := range map[string]string{"": "=main", "main": "=main", "$3": "$3", "$0": "$0"} {
		if got, ok := parseTmuxGroupID(in); !ok || got != want {
			t.Errorf("parseTmuxGroupID(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"ma", "=main", "work", "$", "$3:0", "$x", "-t"} {
		if got, ok := parseTmuxGroupID(in); ok {
			t.Errorf("parseTmuxGroupID(%q) = %q, accepted", in, got)
		}
	}
}

func TestFormatTmuxID(t *testing.T) {
	if got := formatTmuxID("$0", true, "2"); got != "2" {
		t.Errorf("default session = %q", got)
	}
	if got := formatTmuxID("$3", false, "2"); got != "$3:2" {
		t.Errorf("other session = %q", got)
	}
}

func TestValidTmuxSessionName(t *testing.T) {
	for in, want := range map[string]bool{
		"main": true, "e2e": true, "my work": true,
		"a:b": false, "a.b": false, "=main": false, "$3": false, "-x": false, "": false, "x;": false,
	} {
		if got := validTmuxSessionName(in); got != want {
			t.Errorf("validTmuxSessionName(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestTmuxWindowMatches(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	def, _ := parseTmuxID("1")
	other, _ := parseTmuxID("$3:1")
	for _, tc := range []struct {
		w             tmuxWindow
		sid, name, ix string
		want          bool
	}{
		{def, "$0", "main", "1", true},
		{def, "$0", "main", "0", false}, // tmux answered with the current window
		{def, "$4", "main2", "1", false},
		{def, "", "", "", false}, // tmux answered nothing: the session is gone
		{other, "$3", "work", "1", true},
		{other, "$0", "main", "1", false}, // another session's window 1
		{other, "$3", "work", "0", false},
	} {
		if got := tc.w.matches(tc.sid, tc.name, tc.ix); got != tc.want {
			t.Errorf("%+v.matches(%q, %q, %q) = %v", tc.w, tc.sid, tc.name, tc.ix, got)
		}
	}
}

func TestIsTmuxAttachCmdline(t *testing.T) {
	origSocket, origSession, origBin := tmuxSocket, tmuxSession, tmuxBin
	defer func() { tmuxSocket, tmuxSession, tmuxBin = origSocket, origSession, origBin }()
	tmuxSocket, tmuxSession, tmuxBin = "/run/t.sock", "main", "tmux"
	for cmdline, want := range map[string]bool{
		"tmux -S /run/t.sock attach -E -t =main":    true,
		"tmux -S /run/t.sock attach -E -t $3":       true,
		"tmux -S /run/t.sock attach -t main":        true, // left by a release before several sessions
		"tmux -S /run/t.sock attach -t =main":       false,
		"tmux -S /run/t.sock attach -t =work":       false, // the user's own client
		"tmux -S /run/t.sock attach -E -t =ma":      false,
		"tmux -S /run/t.sock attach -E -t $3:1":     false,
		"tmux -S /run/t.sock attach -E -t $":        false,
		"tmux -S /run/t.sock attach -E -t $3 x":     false,
		"tmux -S /run/t.sock attach -t main2":       false,
		"tmux attach -E -t $3":                      false, // another server
		"tmux -S /run/t.sock attach -E -t":          false,
		"tmux -S /run/t.sock attach -E -r -t =main": true, // a view-only stream
		"tmux -S /run/t.sock attach -E -r -t $3":    true,
		"tmux -S /run/t.sock attach -r -t =main":    false,
		"tmux -S /run/t.sock attach -E -r -t =ma":   false,
		"tmux -S /run/t.sock attach -E -r -t $3:1":  false,
	} {
		if got := isTmuxAttachCmdline(cmdline); got != want {
			t.Errorf("isTmuxAttachCmdline(%q) = %v, want %v", cmdline, got, want)
		}
	}
	if got := strings.Join(tmuxAttachArgv("$3"), " "); got != "tmux -S /run/t.sock attach -E -t $3" {
		t.Errorf("tmuxAttachArgv = %q", got)
	}
	if got := strings.Join(tmuxViewAttachArgv("$3"), " "); got != "tmux -S /run/t.sock attach -E -r -t $3" {
		t.Errorf("tmuxViewAttachArgv = %q", got)
	}
}

func TestValidTmuxName(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"shell", true},
		{"a:b c", true}, // ':' is fine inside a name
		{"-dash", false},
		{"bad\tname", false},
		{"name;", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := validTmuxName(tt.input); got != tt.want {
			t.Errorf("validTmuxName(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestTmuxCmd(t *testing.T) {
	cmd := tmuxCmd(context.Background(), "list-windows")
	if cmd.Path == "" {
		t.Error("tmuxCmd should create a command")
	}
	if args := cmd.Args; args[0] != "tmux" || args[1] != "list-windows" {
		t.Errorf("tmuxCmd args = %v, want [tmux list-windows]", args)
	}
}

func TestTmuxCmdWithSocket(t *testing.T) {
	orig := tmuxSocket
	defer func() { tmuxSocket = orig }()

	tmuxSocket = "/tmp/test.sock"
	args := tmuxCmd(context.Background(), "list-windows").Args
	// Should have: tmux -S /tmp/test.sock list-windows
	if len(args) < 4 || args[1] != "-S" || args[2] != "/tmp/test.sock" {
		t.Errorf("tmuxCmd with socket args = %v, want [-S /tmp/test.sock ...]", args)
	}
}

func TestTmuxMuxCaps(t *testing.T) {
	m := tmuxMux{}
	if m.Name() != "tmux" {
		t.Errorf("Name() = %q, want tmux", m.Name())
	}
	if c := m.Caps(); !c.CopyMode || c.ClientSideSelect {
		t.Errorf("Caps() = %+v, want CopyMode only", c)
	}
	if err := m.Health(context.Background()); err != nil {
		t.Errorf("Health() = %v, want nil", err)
	}
}

// Invalid input must be rejected before any tmux process is started, so these
// cases run without tmux installed.
func TestTmuxClosePaneUnsupported(t *testing.T) {
	if err := (tmuxMux{}).ClosePane(context.Background(), "0"); !errors.Is(err, errUnsupported) {
		t.Errorf("ClosePane = %v, want errUnsupported", err)
	}
}

func TestTmuxMuxRejectsInvalidInput(t *testing.T) {
	m := tmuxMux{}
	ctx := context.Background()
	tests := []struct {
		name string
		call func() error
	}{
		{"select flag-like id", func() error { return m.SelectTab(ctx, "-t") }},
		{"select other session", func() error { return m.SelectTab(ctx, "other:0") }},
		{"select window name", func() error { return m.SelectTab(ctx, "shell") }},
		{"select bad session id", func() error { return m.SelectTab(ctx, "$3:x") }},
		{"select exact-name target", func() error { return m.SelectTab(ctx, "=main:0") }},
		{"close control char", func() error { return m.CloseTab(ctx, "a\x00b", "") }},
		{"rename bad id", func() error { return m.RenameTab(ctx, "x:1", "ok", "") }},
		{"rename empty name", func() error { return m.RenameTab(ctx, "0", "", "") }},
		{"rename flag-like name", func() error { return m.RenameTab(ctx, "0", "-n", "") }},
		{"rename control char name", func() error { return m.RenameTab(ctx, "0", "a\nb", "") }},
		{"new flag-like name", func() error { _, err := m.NewTab(ctx, "", "-d"); return err }},
		{"new unknown group", func() error { _, err := m.NewTab(ctx, "other", "x"); return err }},
		{"new group by exact name", func() error { _, err := m.NewTab(ctx, "="+tmuxSession, "x"); return err }},
		{"keys bad pane", func() error { return m.SendKeys(ctx, "other:1", "ls") }},
		{"keys session id alone", func() error { return m.SendKeys(ctx, "$3", "ls") }},
		{"keys flag-like", func() error { return m.SendKeys(ctx, "0", "-la") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var ie inputError
			if err := tt.call(); !errors.As(err, &ie) {
				t.Errorf("got %v, want inputError", err)
			}
		})
	}
}

func TestNewTabCreatesMissingSession(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil || runtime.GOOS == "windows" {
		t.Skip("needs tmux with a private socket")
	}
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = fmt.Sprintf("termote-newtab-%d", os.Getpid())
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})

	id, err := tmuxMux{}.NewTab(context.Background(), "", "first")
	if err != nil || id == "" {
		t.Fatalf("NewTab with no session = %q, %v", id, err)
	}
	if err := tmuxCmd(context.Background(), "has-session", "-t", tmuxSession).Run(); err != nil {
		t.Fatalf("session not created: %v", err)
	}
}

func TestScrubTmuxSecretsClearsAServerStartedWithThePassword(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil || runtime.GOOS == "windows" {
		t.Skip("needs tmux with a private socket")
	}
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = fmt.Sprintf("termote-scrub-%d", os.Getpid())
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})
	// A tmux server started from a shell with TERMOTE_PASS exported
	cmd := tmuxCmd(context.Background(), "-f", "/dev/null", "new-session", "-d", "-s", tmuxSession)
	cmd.Env = append(os.Environ(), "TERMOTE_PASS=old-secret")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	global := func() string {
		out, _ := tmuxCmd(context.Background(), "show-environment", "-g").Output()
		return string(out)
	}
	if !strings.Contains(global(), "TERMOTE_PASS=old-secret") {
		t.Fatal("setup: tmux did not capture TERMOTE_PASS")
	}
	scrubTmuxSecrets(context.Background())
	if strings.Contains(global(), "old-secret") {
		t.Fatal("TERMOTE_PASS still in the tmux global environment")
	}
}

// useFakeTmux points tmuxBin at a script that logs its arguments to a file
// and prints out; it returns a function reading the log.
func useFakeTmux(t *testing.T, out string) func() string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake tmux is a shell script")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args")
	script := filepath.Join(dir, "tmux")
	body := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + logPath + "'\ncat <<'OUT'\n" + out + "\nOUT\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	orig, origSocket := tmuxBin, tmuxSocket
	tmuxBin, tmuxSocket = script, ""
	resetTmuxVersion()
	t.Cleanup(func() { tmuxBin, tmuxSocket = orig, origSocket; resetTmuxVersion() })
	return func() string {
		b, _ := os.ReadFile(logPath)
		return string(b)
	}
}

// fakeTmuxReply is what the fake tmux does for one subcommand.
type fakeTmuxReply struct {
	out, stderr string
	code        int
}

// useFakeTmuxScript is useFakeTmux with a reply per subcommand ($1); a
// subcommand without one prints nothing and exits 0.
func useFakeTmuxScript(t *testing.T, replies map[string]fakeTmuxReply) func() string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake tmux is a shell script")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args")
	script := filepath.Join(dir, "tmux")
	var b strings.Builder
	b.WriteString("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + logPath + "'\n[ \"$1\" = -u ] && shift\ncase \"$1\" in\n")
	for sub, r := range replies {
		out, errf := filepath.Join(dir, sub+".out"), filepath.Join(dir, sub+".err")
		os.WriteFile(out, []byte(r.out), 0o644)
		os.WriteFile(errf, []byte(r.stderr), 0o644)
		fmt.Fprintf(&b, "%s) cat '%s'; cat '%s' >&2; exit %d;;\n", sub, out, errf, r.code)
	}
	b.WriteString("esac\n")
	if err := os.WriteFile(script, []byte(b.String()), 0o755); err != nil {
		t.Fatal(err)
	}
	orig, origSocket := tmuxBin, tmuxSocket
	tmuxBin, tmuxSocket = script, ""
	resetTmuxVersion()
	t.Cleanup(func() { tmuxBin, tmuxSocket = orig, origSocket; resetTmuxVersion() })
	return func() string {
		b, _ := os.ReadFile(logPath)
		return string(b)
	}
}

func TestTmuxSnapshotParsesPaneFields(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	// The default session is listed after another one, as tmux sorts by name.
	args := useFakeTmux(t, "$4:0:1:%9:1:@11:ma2:a:b\n$0:0:1:%3:1:@12:main:edit: main.go\n$0:1:0:%7:notapid:@13:main:logs\n"+
		"$5:2:0:%8:1:@14:wo_rk:x\nbad line\n$x:0:1:%1:1:z:y")
	snap, err := tmuxMux{}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Groups) != 3 {
		t.Fatalf("groups = %+v", snap.Groups)
	}
	def, ma2, work := snap.Groups[0], snap.Groups[1], snap.Groups[2]
	if def.ID != "main" || def.Name != "main" || ma2.ID != "$4" || ma2.Name != "ma2" || work.ID != "$5" || work.Name != "wo_rk" {
		t.Fatalf("groups = %+v", snap.Groups)
	}
	tabs := def.Tabs
	if len(tabs) != 2 || tabs[0].Name != "edit: main.go" || tabs[1].Name != "logs" || tabs[0].Panes[0].ID != "0" || !tabs[0].Active {
		t.Fatalf("tabs = %+v", tabs)
	}
	if ma2.Tabs[0].ID != "$4:0" || ma2.Tabs[0].Name != "a:b" || ma2.Tabs[0].Panes[0].ID != "$4:0" || work.Tabs[0].ID != "$5:2" {
		t.Fatalf("other tabs = %+v, %+v", ma2.Tabs, work.Tabs)
	}
	if tabs[0].Key != "@12" || tabs[1].Key != "@13" || ma2.Tabs[0].Key != "@11" || tabs[0].Panes[0].key != "%3" {
		t.Errorf("keys = %q %q %q, pane %q", tabs[0].Key, tabs[1].Key, ma2.Tabs[0].Key, tabs[0].Panes[0].key)
	}
	if tabs[0].Panes[0].Agent != nil || tabs[1].Panes[0].Agent != nil {
		t.Error("agent reported for panes without Claude Code")
	}
	if got := strings.TrimSpace(args()); got != "list-windows -a -F "+tmuxListFormat+"\n-u list-panes -a -F "+tmuxPaneFormat {
		t.Errorf("argv = %q", got)
	}
}

// Without the default session (no server yet, or only the user's own
// sessions), the snapshot creates it by its exact name, then lists again.
func TestTmuxSnapshotCreatesMissingDefaultSession(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"list-windows": {out: "$1:0:1:%2:1:@15:mainx:sh"},
		"has-session":  {stderr: "can't find session: =main", code: 1},
	})
	snap, err := tmuxMux{}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Groups) != 1 || snap.Groups[0].ID != "$1" {
		t.Errorf("groups = %+v", snap.Groups)
	}
	lines := strings.Split(strings.TrimSpace(args()), "\n")
	if len(lines) != 5 || lines[1] != "has-session -t =main" || lines[2] != "new-session -d -s main" || !strings.HasPrefix(lines[3], "list-windows -a") ||
		!strings.HasPrefix(lines[4], "-u list-panes -a") {
		t.Errorf("argv = %q", lines)
	}
}

// Every command addresses its session exactly: "$N" for another session,
// "=name" for the default one.
func TestTmuxTargetsAreExact(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {out: "$3:4:work\n"}})
	ctx := context.Background()
	m := tmuxMux{}
	m.SelectTab(ctx, "$3:1")
	m.SelectTab(ctx, "1")
	m.CloseTab(ctx, "$3:2", "")
	m.RenameTab(ctx, "0", "x", "")
	m.SendKeys(ctx, "$3:0", "ls")
	if id, err := m.NewTab(ctx, "$3", ""); err != nil || id != "$3:4" {
		t.Errorf("NewTab($3) = %q, %v", id, err)
	}
	want := []string{
		"select-window -t $3:=1",
		"select-window -t =main:=1",
		"kill-window -t $3:=2",
		"rename-window -t =main:=0 x",
		"send-keys -t $3:=0 ls",
		"new-window -t $3: -P -F #{session_id}:#{window_index}:#{session_name}",
	}
	if got := strings.Split(strings.TrimSpace(args()), "\n"); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("argv = %q", got)
	}
}

func TestTmuxNewTabIDs(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	ctx := context.Background()

	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {out: "$0:5:main\n"}})
	if id, err := (tmuxMux{}).NewTab(ctx, "main", "x"); err != nil || id != "5" {
		t.Errorf("NewTab(main) = %q, %v", id, err)
	}
	if got := strings.TrimSpace(args()); got != "new-window -t =main: -P -F #{session_id}:#{window_index}:#{session_name} -n x" {
		t.Errorf("argv = %q", got)
	}
	// The default session named by its session id still gets a bare id.
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {out: "$0:6:main\n"}})
	if id, err := (tmuxMux{}).NewTab(ctx, "$0", ""); err != nil || id != "6" {
		t.Errorf("NewTab($0) = %q, %v", id, err)
	}

	// A session that is gone: unknown group, with no retry through ensureSession.
	args = useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {stderr: "can't find session: $9", code: 1}})
	var ie inputError
	if _, err := (tmuxMux{}).NewTab(ctx, "$9", ""); !errors.As(err, &ie) || ie != "unknown group" {
		t.Errorf("NewTab($9) = %v", err)
	}
	if strings.Contains(args(), "has-session") {
		t.Errorf("argv = %q", args())
	}

	// Any other failure is not the client's.
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {stderr: "server exited", code: 1}})
	if _, err := (tmuxMux{}).NewTab(ctx, "$9", ""); err == nil || errors.As(err, &ie) {
		t.Errorf("NewTab failure = %v", err)
	}
	// A reply that is not the session asked for, or not an index.
	for _, out := range []string{"$4:1:x", "$3:x:work", "$3:1", ""} {
		useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {out: out}})
		if id, err := (tmuxMux{}).NewTab(ctx, "$3", ""); err == nil {
			t.Errorf("NewTab with reply %q = %q", out, id)
		}
	}
}

func TestTmuxAgentSessionArgv(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	args := useFakeTmux(t, "$0:2:0:%5:1:main")
	if _, ok, err := (tmuxMux{}).AgentSession(context.Background(), "2"); ok || err != nil {
		t.Errorf("AgentSession = %v, %v", ok, err)
	}
	if got := strings.TrimSpace(args()); got != "display-message -p -t =main:=2 #{session_id}:#{window_index}:#{pane_in_mode}:#{pane_id}:#{pane_pid}:#{session_name}" {
		t.Errorf("argv = %q", got)
	}
	// tmux answers a missing window with the current one.
	if _, _, err := (tmuxMux{}).AgentSession(context.Background(), "3"); err == nil {
		t.Error("reply for another window accepted")
	}
	// ... and a missing session's window with the default session's.
	if _, _, err := (tmuxMux{}).AgentSession(context.Background(), "$3:2"); err == nil {
		t.Error("reply for another session accepted")
	}
	for _, bad := range []string{"-t", "other:1", "", "name"} {
		var ie inputError
		if _, _, err := (tmuxMux{}).AgentSession(context.Background(), bad); !errors.As(err, &ie) {
			t.Errorf("AgentSession(%q) err = %v", bad, err)
		}
	}
	if !(tmuxMux{}).Caps().AgentChat {
		t.Error("Caps().AgentChat = false")
	}
	if (tmuxMux{}).Caps().Files != tmuxFilesSupported {
		t.Error("Caps().Files does not follow tmuxFilesSupported")
	}
}

func TestTmuxPaneDirChecksTheSession(t *testing.T) {
	if !tmuxFilesSupported {
		t.Skip("no Files on this platform")
	}
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	useFakeTmux(t, "$3:1:%5:work:/srv/a:b")
	if dir, key, err := (tmuxMux{}).PaneDir(context.Background(), "$3:1"); err != nil || dir != "/srv/a:b" || key != "%5" {
		t.Errorf("PaneDir($3:1) = %q, %q, %v", dir, key, err)
	}
	var ie inputError
	for _, id := range []string{"1", "$4:1", "$3:0"} {
		if _, _, err := (tmuxMux{}).PaneDir(context.Background(), id); !errors.As(err, &ie) {
			t.Errorf("PaneDir(%q) = %v, want unknown pane", id, err)
		}
	}
	useFakeTmux(t, "$0:1:%5:main:/home/u")
	if dir, _, err := (tmuxMux{}).PaneDir(context.Background(), "1"); err != nil || dir != "/home/u" {
		t.Errorf("PaneDir(1) = %q, %v", dir, err)
	}
	useFakeTmux(t, "$0:1:%5:main:")
	if _, _, err := (tmuxMux{}).PaneDir(context.Background(), "1"); !errors.Is(err, errUnsupported) {
		t.Errorf("PaneDir without a path = %v", err)
	}
	if _, _, err := (tmuxMux{}).PaneDir(context.Background(), "shell"); !errors.As(err, &ie) {
		t.Errorf("PaneDir(shell) = %v", err)
	}
}

func TestTmuxPaneAgentRejectsBadFields(t *testing.T) {
	for _, tc := range [][2]string{{"5", "1"}, {"%5", "x"}, {"", ""}, {"%5", "-1"}} {
		if _, ok := tmuxPaneAgent(tc[0], tc[1]); ok {
			t.Errorf("tmuxPaneAgent(%q, %q) accepted", tc[0], tc[1])
		}
	}
}

// A real tmux on a private socket: a window whose pane runs a process with a
// valid Claude session file reports the agent; splitting the window makes
// the new (active) pane the one the locator answers for.
func TestTmuxAgentInRealSession(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil || runtime.GOOS != "linux" {
		t.Skip("needs tmux on Linux")
	}
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = fmt.Sprintf("termote-agent-%d", os.Getpid())
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})
	dir := t.TempDir()
	ctx := context.Background()
	if err := tmuxCmd(ctx, "-f", "/dev/null", "new-session", "-d", "-s", tmuxSession,
		"-e", "CLAUDE_CONFIG_DIR="+dir, "exec sleep 60").Run(); err != nil {
		t.Fatal(err)
	}
	out, err := tmuxCmd(ctx, "display-message", "-p", "-t", tmuxSession+":0", "#{pane_id} #{pane_pid}").Output()
	if err != nil {
		t.Fatal(err)
	}
	var first string
	var pid int
	fmt.Sscanf(string(out), "%s %d", &first, &pid)
	// The pane process is read before tmux's fork has exec'd sleep, with the
	// server's environment; wait for the exec.
	waitUntil(t, "pane exec", func() bool {
		b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
		return strings.TrimSpace(string(b)) == "sleep"
	})
	start, _ := procStartTime(pid)
	writeSessionFile(t, dir, pid, start, claudePIDDomain(), "idle")

	snap, err := tmuxMux{}.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	a := snap.Groups[0].Tabs[0].Panes[0].Agent
	if a == nil || a.Name != "claude" || a.Status != "idle" {
		t.Fatalf("agent = %+v", a)
	}
	s, ok, err := tmuxMux{}.AgentSession(ctx, "0")
	if !ok || err != nil || s.Target != first || s.PID != pid {
		t.Fatalf("AgentSession = %+v, %v, %v", s, ok, err)
	}
	// The uncached lookup a write checks with sees the same session.
	if now, ok, err := (tmuxMux{}).AgentSessionNow(ctx, "0"); !ok || err != nil || !sameAgent(now, s) {
		t.Fatalf("AgentSessionNow = %+v, %v, %v", now, ok, err)
	}

	// Split: the new pane (no Claude session file) is active, so the window has no agent.
	if err := tmuxCmd(ctx, "split-window", "-t", tmuxSession+":0", "exec sleep 60").Run(); err != nil {
		t.Fatal(err)
	}
	if s, ok, _ := (tmuxMux{}).AgentSession(ctx, "0"); ok || s.Target == first {
		t.Errorf("after split = %+v, %v; want the new pane, without agent", s, ok)
	}
	// Back on the first pane, the locator answers for it again.
	tmuxCmd(ctx, "select-pane", "-t", first).Run()
	if s, ok, _ := (tmuxMux{}).AgentSession(ctx, "0"); !ok || s.Target != first {
		t.Errorf("after select-pane = %+v, %v", s, ok)
	}
	if _, ok, err := (tmuxMux{}).AgentSession(ctx, "9"); ok || err == nil {
		t.Errorf("missing window = %v, %v", ok, err)
	}
}

func TestLookupAgentsDoesNotBlockSnapshot(t *testing.T) {
	// A pane whose lookup blocks (a hung mount) is held in the walk cache.
	key := "%999|424242"
	release := make(chan struct{})
	started := make(chan struct{})
	go agentTrees.do(key, func() (claudeProcResult, error) {
		close(started)
		<-release
		return claudeProcResult{}, nil
	})
	<-started
	defer close(release)
	start := time.Now()
	out := lookupAgents(context.Background(), []agentPane{{0, 0, "%999", "424242"}})
	if d := time.Since(start); d > agentLookupWait+500*time.Millisecond {
		t.Errorf("lookupAgents waited %v", d)
	}
	if len(out) != 1 || out[0] != nil {
		t.Errorf("out = %v", out)
	}
}

func TestTmuxAgentWriterArgv(t *testing.T) {
	args := useFakeTmux(t, "")
	ctx := context.Background()
	m := tmuxMux{}
	if _, err := m.Capture(ctx, "%3"); err != nil {
		t.Fatal(err)
	}
	if err := m.SendKeySequence(ctx, "%3", []string{"2", "Enter", "C-c"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Paste(ctx, "%3", "-flag-like text"); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(args()), "\n")
	if len(lines) != 4 || lines[0] != "capture-pane -p -e -t %3" || lines[1] != "send-keys -t %3 2 Enter C-c" {
		t.Fatalf("argv = %q", lines)
	}
	// The text goes through stdin, never argv; the buffer has its own name.
	load, paste := strings.Fields(lines[2]), strings.Fields(lines[3])
	if len(load) != 4 || load[0] != "load-buffer" || load[1] != "-b" || !strings.HasPrefix(load[2], "termote-") || load[3] != "-" {
		t.Errorf("load = %q", lines[2])
	}
	if strings.Join(paste, " ") != "paste-buffer -b "+load[2]+" -p -d -t %3" {
		t.Errorf("paste = %q", lines[3])
	}
	var ie inputError
	for name, err := range map[string]error{
		"window id as target": m.Paste(ctx, "3", "x"),
		"flag as target":      m.SendKeySequence(ctx, "-t", []string{"1"}),
		"key name injection":  m.SendKeySequence(ctx, "%3", []string{"C-d"}),
		"flag as key":         m.SendKeySequence(ctx, "%3", []string{"-X"}),
		"capture bad target":  func() error { _, err := m.Capture(ctx, "main:0"); return err }(),
	} {
		if !errors.As(err, &ie) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Two pastes into two panes at once land each in its own pane, and the
// user's own paste buffer is left alone.
func TestTmuxPasteConcurrentRealPanes(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil || runtime.GOOS == "windows" {
		t.Skip("needs tmux with a private socket")
	}
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = fmt.Sprintf("termote-paste-%d", os.Getpid())
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})
	ctx := context.Background()
	dir := t.TempDir()
	out := func(i int) string { return filepath.Join(dir, fmt.Sprintf("out%d", i)) }
	if err := tmuxCmd(ctx, "-f", "/dev/null", "new-session", "-d", "-s", tmuxSession, "stty raw -echo; cat > "+out(0)).Run(); err != nil {
		t.Fatal(err)
	}
	tmuxCmd(ctx, "new-window", "-t", tmuxSession, "stty raw -echo; cat > "+out(1)).Run()
	tmuxCmd(ctx, "set-buffer", "user clipboard").Run()
	var targets [2]string
	for i := range targets {
		b, _ := tmuxCmd(ctx, "display-message", "-p", "-t", fmt.Sprintf("%s:%d", tmuxSession, i), "#{pane_id}").Output()
		targets[i] = strings.TrimSpace(string(b))
	}
	texts := [2]string{strings.Repeat("alpha ", 500), strings.Repeat("omega ", 500)}
	var wg sync.WaitGroup
	for i := range targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := (tmuxMux{}).Paste(ctx, targets[i], texts[i]); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	for i := range texts {
		waitUntil(t, "paste in pane", func() bool {
			b, _ := os.ReadFile(out(i))
			return len(b) >= len(texts[i])
		})
		b, _ := os.ReadFile(out(i))
		if got := strings.TrimSuffix(string(b), "\r"); !strings.Contains(got, texts[i]) || strings.Contains(got, texts[1-i][:6]) {
			t.Errorf("pane %d got %q…", i, got[:min(40, len(got))])
		}
	}
	bufs, _ := tmuxCmd(ctx, "list-buffers", "-F", "#{buffer_name}=#{buffer_sample}").Output()
	if strings.Contains(string(bufs), "termote-") || !strings.Contains(string(bufs), "user clipboard") {
		t.Errorf("buffers after paste: %q", bufs)
	}
}

// tmux expands formats in a window name it is given, #() jobs included: a
// tab name is kept as typed, so no '#' sequence in it runs or changes anything.
func TestTabNameIsNotAFormat(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil || runtime.GOOS == "windows" {
		t.Skip("needs tmux with a private socket")
	}
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = fmt.Sprintf("termote-tabname-%d", os.Getpid())
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})
	ctx := context.Background()
	name := func(id string) string {
		w, _ := parseTmuxID(id)
		out, err := tmuxCmd(ctx, "display-message", "-p", "-t", w.target(), "#{window_name}").Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSuffix(string(out), "\n")
	}
	const typed = "a#b ##c #{session_name} #[fg=red] ##[x] #(true) #"
	id, err := tmuxMux{}.NewTab(ctx, "", typed)
	if err != nil {
		t.Fatal(err)
	}
	if got := name(id); got != typed {
		t.Errorf("NewTab name = %q, want %q", got, typed)
	}
	if err := (tmuxMux{}).RenameTab(ctx, id, "x"+typed, ""); err != nil {
		t.Fatal(err)
	}
	if got := name(id); got != "x"+typed {
		t.Errorf("RenameTab name = %q, want %q", got, "x"+typed)
	}
}

// A server that answers with an error while the default session exists:
// nothing is created and the error is reported.
func TestTmuxSnapshotReportsListFailure(t *testing.T) {
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"list-windows": {stderr: "lost server", code: 1},
	})
	if _, err := (tmuxMux{}).Snapshot(context.Background()); err == nil {
		t.Fatal("Snapshot succeeded")
	}
	if strings.Contains(args(), "new-session") {
		t.Errorf("argv = %q", args())
	}
}

// A tmux (psmux) that does not know the list format prints lines none of
// which can be read: an error, never an empty snapshot.
func TestTmuxSnapshotRefusesUnreadableList(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"list-windows": {out: "0:1:%3:1:shell"},
		"has-session":  {},
	})
	if snap, err := (tmuxMux{}).Snapshot(context.Background()); err == nil {
		t.Fatalf("Snapshot = %+v", snap)
	}
}

func TestTmuxMissingNeedsTmuxsOwnError(t *testing.T) {
	if tmuxMissing(errors.New("can't find session: x")) {
		t.Error("an error that is not tmux's exit status counted as missing")
	}
}

func TestTmuxAttachRejectsBadID(t *testing.T) {
	var ie inputError
	if _, err := (tmuxMux{}).Attach(context.Background(), "other:0", Size{Cols: 80, Rows: 24}); !errors.As(err, &ie) {
		t.Errorf("Attach(other:0) = %v", err)
	}
}

func TestValidTmuxGroupName(t *testing.T) {
	usePsmux(t, false)
	for name, want := range map[string]bool{
		"api": true, "my work": true, "a#b": true, "-x": false, "": false, "a:b": false, "a.b": false,
		"w*": false, "w?": false, "w[1]": false, "=main": false, "x;": false, `a\b`: false, "é😀": true,
	} {
		if got := validTmuxGroupName(name); got != want {
			t.Errorf("validTmuxGroupName(%q) = %v, want %v", name, got, want)
		}
	}
	usePsmux(t, true)
	if validTmuxGroupName("a#b") {
		t.Error("psmux accepted a '#' in a session name")
	}
}

func TestTmuxGroupArgv(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, false)
	ctx := context.Background()
	m := tmuxMux{}
	sessions := fakeTmuxReply{out: "$0:main\n$3:work\n"}

	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"list-sessions":   {out: "$0:main\n$3:work\n$7:a#b\n"},
		"new-session":     {out: "$7\n"},
		"display-message": {out: "$7:/srv/x##y\n"},
	})
	if _, err := m.NewGroup(ctx, "a#b", "/srv/x##y"); err == nil || !errors.Is(err, errGroupExists) {
		t.Errorf("NewGroup with a taken name = %v", err)
	}
	if strings.Contains(args(), "new-session") {
		t.Errorf("argv = %q", args())
	}

	args = useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"list-sessions":   sessions,
		"new-session":     {out: "$7\n"},
		"display-message": {out: "$7:/srv/x\n"},
	})
	// The session read back under another name (a tmux that expanded it).
	if _, err := m.NewGroup(ctx, "a#b", "/srv/x"); err == nil {
		t.Error("NewGroup accepted a session that came out wrong")
	}
	lines := strings.Split(strings.TrimSpace(args()), "\n")
	if lines[1] != "new-session -d -s a##b -P -F #{session_id} -c /srv/x" || lines[len(lines)-1] != "kill-session -t $7" {
		t.Errorf("argv = %q", lines)
	}

	args = useFakeTmuxScript(t, map[string]fakeTmuxReply{"list-sessions": sessions})
	if err := m.CloseGroup(ctx, "$3"); err != nil {
		t.Fatal(err)
	}
	if err := m.CloseGroup(ctx, "main"); err != nil {
		t.Fatal(err)
	}
	if err := m.RenameGroup(ctx, "$3", "x#y"); err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSpace(args()), "\n")
	want := []string{
		"list-sessions -F #{session_id}:#{session_name}", "kill-session -t $3",
		"list-sessions -F #{session_id}:#{session_name}", "kill-session -t $0",
		"list-sessions -F #{session_id}:#{session_name}", "rename-session -t $3 x##y",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("argv = %q", got)
	}

	for name, c := range map[string]struct {
		err  error
		want error
	}{
		"close unknown":        {m.CloseGroup(ctx, "$9"), errUnknownGroup},
		"close by name":        {m.CloseGroup(ctx, "work"), errInvalidGroupID},
		"close empty":          {m.CloseGroup(ctx, ""), errInvalidGroupID},
		"rename default":       {m.RenameGroup(ctx, "main", "x"), errDefaultSession},
		"rename default by id": {m.RenameGroup(ctx, "$0", "x"), errDefaultSession},
		"rename taken":         {m.RenameGroup(ctx, "$3", "main"), errGroupExists},
		"rename bad name":      {m.RenameGroup(ctx, "$3", "a:b"), errInvalidGroupName},
		"rename to its own":    {m.RenameGroup(ctx, "$3", "work"), nil},
		"create bad name":      {func() error { _, err := m.NewGroup(ctx, "=x", ""); return err }(), errInvalidGroupName},
	} {
		if !errors.Is(c.err, c.want) {
			t.Errorf("%s = %v, want %v", name, c.err, c.want)
		}
	}

	// The session went away between the check and the command, or the name
	// was taken meanwhile.
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"list-sessions": sessions,
		"kill-session": {stderr: "can't find session: $3", code: 1}})
	if err := m.CloseGroup(ctx, "$3"); !errors.Is(err, errUnknownGroup) {
		t.Errorf("close of a vanished session = %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"list-sessions": sessions,
		"rename-session": {stderr: "duplicate session: x", code: 1},
		"new-session":    {stderr: "duplicate session: x", code: 1}})
	if err := m.RenameGroup(ctx, "$3", "x"); !errors.Is(err, errGroupExists) {
		t.Errorf("rename onto a name taken meanwhile = %v", err)
	}
	if _, err := m.NewGroup(ctx, "x", ""); !errors.Is(err, errGroupExists) {
		t.Errorf("create onto a name taken meanwhile = %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"list-sessions": sessions,
		"kill-session": {stderr: "lost server", code: 1}, "new-session": {out: "nonsense"}})
	if err := m.CloseGroup(ctx, "$3"); err == nil || errors.Is(err, errUnknownGroup) {
		t.Errorf("other kill failure = %v", err)
	}
	if _, err := m.NewGroup(ctx, "y", ""); err == nil {
		t.Error("NewGroup accepted a reply that is no session id")
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"list-sessions": sessions, "new-session": {stderr: "lost server", code: 1}})
	if _, err := m.NewGroup(ctx, "y", ""); err == nil || errors.Is(err, errGroupExists) {
		t.Errorf("other new-session failure = %v", err)
	}
	if tmuxNoServer(errors.New("no server running")) {
		t.Error("an error that is not tmux's exit status counted as no server")
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"list-sessions": {stderr: "lost server", code: 1}})
	if _, err := m.NewGroup(ctx, "y", ""); err == nil {
		t.Error("NewGroup ignored a failed list")
	}
	if err := m.CloseGroup(ctx, "$3"); err == nil {
		t.Error("CloseGroup ignored a failed list")
	}
}

func TestTmuxNewGroupOnPsmuxRefusesHash(t *testing.T) {
	usePsmux(t, true)
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{})
	if _, err := (tmuxMux{}).NewGroup(context.Background(), "ok", `C:\a#b`); !errors.Is(err, errInvalidCwd) {
		t.Errorf("NewGroup with '#' in cwd on psmux = %v", err)
	}
	if args() != "" {
		t.Errorf("argv = %q", args())
	}
}

// tmuxPaneLine is one tmuxPaneFormat entry as tmux prints it.
func tmuxPaneLine(sid, win, pane, active, cmd, path string) string {
	return fmt.Sprintf("%s:%s:%s:%s:%d:%s%d:%s\n", sid, win, pane, active, len(cmd), cmd, len(path), path)
}

func TestParseTmuxPanes(t *testing.T) {
	w := func(sid, idx string) tmuxWindowKey { return tmuxWindowKey{sid, idx} }
	names := func(panes []tmuxPaneProc) string {
		var s []string
		for _, p := range panes {
			s = append(s, p.proc.Name+"@"+p.proc.Cwd)
		}
		return strings.Join(s, ",")
	}

	// Plain, out of pane order, a command and a path holding ':'.
	got := parseTmuxPanes([]byte(tmuxPaneLine("$0", "0", "1", "1", "python3", "/a:b") +
		tmuxPaneLine("$0", "0", "0", "0", "bash", "/home/u") + tmuxPaneLine("$0", "1", "0", "1", "npm: dev", "/x")))
	if s := names(got[w("$0", "0")]); s != "bash@/home/u,python3@/a:b" || !got[w("$0", "0")][1].active {
		t.Errorf("window 0 = %q %+v", s, got[w("$0", "0")])
	}
	if s := names(got[w("$0", "1")]); s != "npm@/x" {
		t.Errorf("window 1 = %q", s)
	}

	// A path holding a newline that spells another pane's entry forges nothing.
	fake := "/tmp/x\n$9:9:0:1:3:vim1:/"
	got = parseTmuxPanes([]byte(tmuxPaneLine("$0", "0", "0", "1", "bash", fake)))
	if len(got) != 1 || got[w("$0", "0")][0].proc.Name != "bash" || got[w("$9", "9")] != nil {
		t.Errorf("forged entry: %+v", got)
	}

	// Stops at what it cannot read, keeping the windows before but not the
	// one it stopped in, which would be missing panes.
	head := tmuxPaneLine("$0", "0", "0", "1", "bash", "/h") + tmuxPaneLine("$0", "1", "0", "1", "vim", "/h")
	for name, c := range map[string]struct {
		tail string
		want []tmuxWindowKey
	}{
		"length past the end":  {"$0:1:1:0:40:bash", []tmuxWindowKey{w("$0", "0")}},
		"n: not expanded":      {"$0:1:1:0:#{n:pane_current_command}:bash#{n:pane_current_path}:/x\n", []tmuxWindowKey{w("$0", "0")}},
		"short multibyte (_)":  {"$0:1:1:0:4:bash4:/_x\n$0:2:0:1:3:vim2:/y\n", []tmuxWindowKey{w("$0", "0")}},
		"another window":       {"$0:2:0:1:40:bash", []tmuxWindowKey{w("$0", "0"), w("$0", "1")}},
		"unreadable window id": {"%1:1:0:1:4:bash2:/x\n", []tmuxWindowKey{w("$0", "0")}},
	} {
		got := parseTmuxPanes([]byte(head + c.tail))
		if len(got) != len(c.want) {
			t.Errorf("%s: %+v", name, got)
		}
		for _, k := range c.want {
			if len(got[k]) != 1 {
				t.Errorf("%s: window %v = %+v", name, k, got[k])
			}
		}
	}
	if got := parseTmuxPanes([]byte("#{session_id}:#{window_index}:...\n")); len(got) != 0 {
		t.Errorf("psmux without formats: %+v", got)
	}

	// A pane listed twice is dropped, its window's other panes kept.
	got = parseTmuxPanes([]byte(tmuxPaneLine("$0", "0", "0", "1", "bash", "/a") +
		tmuxPaneLine("$0", "0", "0", "1", "vim", "/a") + tmuxPaneLine("$0", "0", "1", "0", "top", "/a")))
	if s := names(got[w("$0", "0")]); s != "top@/a" {
		t.Errorf("duplicate kept: %q", s)
	}

	// psmux numbers panes per session: two sessions with the same pane and
	// window index stay apart. CRLF line ends are read too.
	got = parseTmuxPanes([]byte(strings.ReplaceAll(tmuxPaneLine("$1", "0", "0", "1", "vim", "/a")+
		tmuxPaneLine("$2", "0", "0", "1", "htop", "/b"), "\n", "\r\n")))
	if names(got[w("$1", "0")]) != "vim@/a" || names(got[w("$2", "0")]) != "htop@/b" {
		t.Errorf("sessions mixed: %+v", got)
	}

	// No name: no entry. A relative path: no cwd.
	got = parseTmuxPanes([]byte(tmuxPaneLine("$0", "0", "0", "1", "", "/a") + tmuxPaneLine("$0", "0", "1", "1", "sh", "rel")))
	if s := names(got[w("$0", "0")]); s != "sh@" {
		t.Errorf("window = %q", s)
	}
}

// resetTmuxProcs empties the last processes read, before and after a test.
func resetTmuxProcs(t *testing.T) {
	reset := func() {
		tmuxProcs.Lock()
		tmuxProcs.windows = nil
		tmuxProcs.Unlock()
	}
	reset()
	t.Cleanup(reset)
}

func TestTmuxSnapshotProcesses(t *testing.T) {
	orig := tmuxSession
	t.Cleanup(func() { tmuxSession = orig })
	tmuxSession = "main"
	resetTmuxProcs(t)
	panes := tmuxPaneLine("$0", "0", "0", "0", "bash", "/home/u") + tmuxPaneLine("$0", "0", "1", "1", "vim", "/home/u/p") +
		tmuxPaneLine("$4", "0", "0", "1", "top", "/")
	useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"list-windows": {out: "$0:0:1:%3:1:@16:main:edit\n$0:1:0:%5:1:@17:main:logs\n$4:0:1:%1:1:@18:other:x\n"},
		"list-panes":   {out: panes},
	})
	snap, err := tmuxMux{}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	edit, logs, other := snap.Groups[0].Tabs[0], snap.Groups[0].Tabs[1], snap.Groups[1].Tabs[0]
	if p := edit.Panes[0].Process; p == nil || p.Name != "vim" || p.Cwd != "/home/u/p" {
		t.Errorf("active pane process = %+v", p)
	}
	if len(edit.Processes) != 2 || edit.Processes[0].Name != "bash" || edit.Processes[1].Name != "vim" {
		t.Errorf("tab processes = %+v", edit.Processes)
	}
	if logs.Panes[0].Process != nil || logs.Processes != nil {
		t.Errorf("window missing from list-panes got %+v / %+v", logs.Panes[0].Process, logs.Processes)
	}
	if p := other.Panes[0].Process; p == nil || p.Name != "top" {
		t.Errorf("other session process = %+v", p)
	}

	// An empty reply (psmux) reuses what was just read; a failure never
	// fails the snapshot.
	for _, r := range []fakeTmuxReply{{}, {stderr: "boom", code: 1}} {
		useFakeTmuxScript(t, map[string]fakeTmuxReply{
			"list-windows": {out: "$0:0:1:%3:1:@19:main:edit\n"},
			"list-panes":   r,
		})
		snap, err := tmuxMux{}.Snapshot(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if p := snap.Groups[0].Tabs[0].Panes[0].Process; p == nil || p.Name != "vim" {
			t.Errorf("reply %+v: process = %+v, want the last one read", r, p)
		}
	}
	// Past tmuxProcKeep the last read is forgotten.
	tmuxProcs.Lock()
	for k, w := range tmuxProcs.windows {
		w.at = w.at.Add(-tmuxProcKeep)
		tmuxProcs.windows[k] = w
	}
	tmuxProcs.Unlock()
	snap, _ = tmuxMux{}.Snapshot(context.Background())
	if p := snap.Groups[0].Tabs[0].Panes[0].Process; p != nil {
		t.Errorf("process = %+v after %v", p, tmuxProcKeep)
	}
}

// A real tmux server: the snapshot names every pane's command, never its
// arguments.
func TestTmuxProcessesInRealSession(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil || runtime.GOOS != "linux" {
		t.Skip("needs tmux on Linux")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("needs python3")
	}
	resetTmuxProcs(t)
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = fmt.Sprintf("termote-proc-%d", os.Getpid())
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})
	ctx := context.Background()
	if err := tmuxCmd(ctx, "-f", "/dev/null", "new-session", "-d", "-s", tmuxSession, "bash --norc").Run(); err != nil {
		t.Fatal(err)
	}
	if err := tmuxCmd(ctx, "split-window", "-t", "="+tmuxSession+":=0",
		"exec python3 -c 'import time; time.sleep(60)' --password=SECRET-123").Run(); err != nil {
		t.Fatal(err)
	}
	var body []byte
	waitUntil(t, "both panes' commands", func() bool {
		resetTmuxProcs(t)
		snap, err := tmuxMux{}.Snapshot(ctx)
		if err != nil {
			return false
		}
		body, _ = json.Marshal(snap)
		tab := snap.Groups[0].Tabs[0]
		return len(tab.Processes) == 2 && tab.Processes[0].Name == "bash" && tab.Processes[1].Name == "python3" &&
			tab.Panes[0].Process != nil && tab.Panes[0].Process.Name == "python3"
	})
	if strings.Contains(string(body), "SECRET") || strings.Contains(string(body), "time.sleep") {
		t.Errorf("argv in the snapshot: %s", body)
	}
}

func TestParseTmuxVersion(t *testing.T) {
	for in, want := range map[string][3]int{
		"3.2a": {3, 2, 1}, "3.1c": {3, 1, 1}, "next-3.6": {3, 6, 1}, "3.4": {3, 4, 1}, "2.7": {2, 7, 1},
		"master": {0, 0, 0}, "": {0, 0, 0}, "3": {0, 0, 0}, "tmux 3.4": {0, 0, 0},
	} {
		major, minor, ok := parseTmuxVersion(in)
		if [3]int{major, minor, map[bool]int{true: 1}[ok]} != want {
			t.Errorf("parseTmuxVersion(%q) = %d, %d, %v", in, major, minor, ok)
		}
	}
}

// The server's version decides, read once it parses; a failed read is tried
// again later, never cached as the answer.
func TestTmuxReorderCap(t *testing.T) {
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {stderr: "no server running", code: 1}})
	if (tmuxMux{}).Caps().ReorderTabs {
		t.Error("ReorderTabs without a server")
	}
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "3.2a\n"}})
	tmuxVersion.failedAt = time.Now().Add(-tmuxVersionRetry)
	if !(tmuxMux{}).Caps().ReorderTabs || !(tmuxMux{}).Caps().ReorderTabs {
		t.Error("ReorderTabs off on 3.2a")
	}
	if got := strings.TrimSpace(args()); got != "display-message -p #{version}" {
		t.Errorf("argv = %q, want one read", got)
	}
	for v, want := range map[string]bool{"3.1c": false, "next-3.6": true, "master": false} {
		useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: v + "\n"}})
		if got := (tmuxMux{}).Caps().ReorderTabs; got != want {
			t.Errorf("%s: ReorderTabs = %v", v, got)
		}
	}
	if (tmuxMux{}).Caps().ReorderGroups {
		t.Error("ReorderGroups on tmux")
	}
	if err := (tmuxMux{}).MoveGroup(context.Background(), "main", 0); !errors.Is(err, errUnsupported) {
		t.Errorf("MoveGroup = %v", err)
	}
}
