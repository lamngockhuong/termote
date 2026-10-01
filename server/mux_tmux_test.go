package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

func TestValidTmuxID(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"0", true},
		{"12", true},
		{"my-window", true},
		{"tên", true},
		{"-x", false},      // would be parsed as a flag
		{"-t", false},      // would be parsed as a flag
		{"other:0", false}, // would address another session
		{"main:0", false},  // qualified targets are built server-side only
		{"a\nb", false},    // control character
		{"", false},
	}
	for _, tt := range tests {
		if got := validTmuxID(tt.input); got != tt.want {
			t.Errorf("validTmuxID(%q) = %v, want %v", tt.input, got, tt.want)
		}
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
		{"", false},
	}
	for _, tt := range tests {
		if got := validTmuxName(tt.input); got != tt.want {
			t.Errorf("validTmuxName(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestQualifyTarget(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()

	tmuxSession = "main"
	if got := qualifyTarget("0"); got != "main:0" {
		t.Errorf("qualifyTarget(0) = %q, want main:0", got)
	}
	tmuxSession = "custom"
	if got := qualifyTarget("win"); got != "custom:win" {
		t.Errorf("qualifyTarget(win) = %q, want custom:win", got)
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
func TestTmuxMuxRejectsInvalidInput(t *testing.T) {
	m := tmuxMux{}
	ctx := context.Background()
	tests := []struct {
		name string
		call func() error
	}{
		{"select flag-like id", func() error { return m.SelectTab(ctx, "-t") }},
		{"select other session", func() error { return m.SelectTab(ctx, "other:0") }},
		{"close control char", func() error { return m.CloseTab(ctx, "a\x00b") }},
		{"rename bad id", func() error { return m.RenameTab(ctx, "x:1", "ok") }},
		{"rename empty name", func() error { return m.RenameTab(ctx, "0", "") }},
		{"rename flag-like name", func() error { return m.RenameTab(ctx, "0", "-n") }},
		{"rename control char name", func() error { return m.RenameTab(ctx, "0", "a\nb") }},
		{"new flag-like name", func() error { _, err := m.NewTab(ctx, "", "-d"); return err }},
		{"new unknown group", func() error { _, err := m.NewTab(ctx, "other", "x"); return err }},
		{"keys bad pane", func() error { return m.SendKeys(ctx, "other:1", "ls") }},
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
	t.Cleanup(func() { tmuxBin, tmuxSocket = orig, origSocket })
	return func() string {
		b, _ := os.ReadFile(logPath)
		return string(b)
	}
}

func TestTmuxSnapshotParsesPaneFields(t *testing.T) {
	args := useFakeTmux(t, "0:1:%3:1:edit: main.go\n1:0:%7:notapid:logs")
	snap, err := tmuxMux{}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	tabs := snap.Groups[0].Tabs
	if len(tabs) != 2 || tabs[0].Name != "edit: main.go" || tabs[1].Name != "logs" || tabs[0].Panes[0].ID != "0" || !tabs[0].Active {
		t.Fatalf("tabs = %+v", tabs)
	}
	if tabs[0].Panes[0].Agent != nil || tabs[1].Panes[0].Agent != nil {
		t.Error("agent reported for panes without Claude Code")
	}
	if !strings.Contains(args(), "#{window_index}:#{window_active}:#{pane_id}:#{pane_pid}:#{window_name}") {
		t.Errorf("list-windows format: %s", args())
	}
}

func TestTmuxAgentSessionArgv(t *testing.T) {
	args := useFakeTmux(t, "2:%5:1")
	if _, ok, err := (tmuxMux{}).AgentSession(context.Background(), "2"); ok || err != nil {
		t.Errorf("AgentSession = %v, %v", ok, err)
	}
	if got := strings.TrimSpace(args()); got != "display-message -p -t "+tmuxSession+":2 #{window_index}:#{pane_id}:#{pane_pid}" {
		t.Errorf("argv = %q", got)
	}
	// tmux answers a missing window with the current one.
	if _, _, err := (tmuxMux{}).AgentSession(context.Background(), "3"); err == nil {
		t.Error("reply for another window accepted")
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
	out := lookupAgents(context.Background(), []agentPane{{0, "%999", "424242"}})
	if d := time.Since(start); d > agentLookupWait+500*time.Millisecond {
		t.Errorf("lookupAgents waited %v", d)
	}
	if len(out) != 1 || out[0] != nil {
		t.Errorf("out = %v", out)
	}
}
