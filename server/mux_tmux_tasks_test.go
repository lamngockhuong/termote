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
)

// A real tmux on a private socket: a task tab opens at a directory whose
// name holds a format, its shell reads idle, busy while a command runs and
// in copy mode, a typed line runs with its exit status, and a closed pane
// is gone.
func TestTmuxTaskTabReal(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil || runtime.GOOS != "linux" {
		t.Skip("needs tmux on Linux")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("needs bash")
	}
	shortStart(t)
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = fmt.Sprintf("termote-task-%d", os.Getpid())
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})
	ctx := context.Background()
	if err := tmuxCmd(ctx, "-f", "/dev/null", "new-session", "-d", "-s", tmuxSession, "bash --norc --noprofile").Run(); err != nil {
		t.Fatal(err)
	}
	tmuxCmd(ctx, "set-option", "-g", "default-command", "bash --norc --noprofile").Run()
	base, _ := filepath.EvalSymlinks(t.TempDir())
	dir := filepath.Join(base, "a #{pane_id} #(touch x) dir")
	os.Mkdir(dir, 0o755)
	tm := tmuxMux{}
	tab, err := tm.NewTaskTab(ctx, tmuxSession, "task:t#x", dir)
	if err != nil {
		t.Fatal(err)
	}
	if tab.TabID != "1" || tab.PaneID != tab.Target || !tmuxPaneIDRe.MatchString(tab.Target) {
		t.Fatalf("tab = %+v", tab)
	}
	shortStart(t)
	agentStartIdleWait = 3e9
	shell, err := waitTaskShell(ctx, tm, tab.Target, true)
	if err != nil || shell != "bash" {
		t.Fatalf("shell = %q %v", shell, err)
	}
	// Read once the shell runs: before, the pane's process is tmux's fork.
	out, _ := tmuxCmd(ctx, "display-message", "-p", "-t", tab.Target, "#{window_name}|#{pane_current_path}|#{window_active}").Output()
	if got := strings.TrimSpace(string(out)); got != "task:t#x|"+dir+"|0" {
		t.Errorf("window = %q", got)
	}
	if _, err := os.Stat(filepath.Join(base, "x")); err == nil {
		t.Error("the directory's #() ran")
	}
	nonce := "0123456789abcdef"
	if err := tm.TypeLine(ctx, tab.Target, buildTaskLine(shellPOSIX, "eval 'echo hi; sleep 0.3; (exit 5)'", nonce)); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "busy", func() bool { _, idle, _ := tm.IdleShell(ctx, tab.Target); return !idle })
	waitUntil(t, "exit marker", func() bool {
		text, _ := tm.ReadTaskText(ctx, tab.Target, taskReadLines)
		code, ok := parseTaskExit(text, nonce)
		return ok && code == 5
	})
	// A half-typed line is cleared by C-c.
	tm.TypeLine(ctx, tab.Target, "sleep 30")
	waitUntil(t, "sleep runs", func() bool { _, idle, _ := tm.IdleShell(ctx, tab.Target); return !idle })
	if err := tm.Interrupt(ctx, tab.Target); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "idle after C-c", func() bool { _, idle, _ := tm.IdleShell(ctx, tab.Target); return idle })
	tmuxCmd(ctx, "copy-mode", "-t", tab.Target).Run()
	if _, idle, err := tm.IdleShell(ctx, tab.Target); idle || err != nil {
		t.Errorf("copy mode = %v %v", idle, err)
	}
	tmuxCmd(ctx, "kill-pane", "-t", tab.Target).Run()
	if _, _, err := tm.IdleShell(ctx, tab.Target); !errors.Is(err, errTaskTargetGone) {
		t.Errorf("killed pane = %v", err)
	}
}

func TestTmuxTaskArgvAndErrors(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	ctx := context.Background()
	tm := tmuxMux{}

	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {out: "$3:2:%7:work\n"}})
	tab, err := tm.NewTaskTab(ctx, "$3", "task:a#b", "/r/#{x}")
	if err != nil || tab != (taskTab{TabID: "$3:2", PaneID: "%7", Target: "%7"}) {
		t.Fatalf("NewTaskTab = %+v %v", tab, err)
	}
	if got := strings.TrimSpace(args()); got != "new-window -d -t $3: -c /r/##{x} -P -F #{session_id}:#{window_index}:#{pane_id}:#{session_name} -n task:a##b" {
		t.Errorf("argv = %q", got)
	}
	// A name tmux cannot take is left out; the default session's tab
	// keeps a bare id.
	args = useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {out: "$0:4:%9:main\n"}})
	if tab, err := tm.NewTaskTab(ctx, "main", "-bad", "/r"); err != nil || tab.TabID != "4" || strings.Contains(args(), " -n ") {
		t.Errorf("default session = %+v %v %q", tab, err, args())
	}
	var ie inputError
	if _, err := tm.NewTaskTab(ctx, "bad id", "x", "/r"); !errors.As(err, &ie) {
		t.Errorf("bad group = %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {stderr: "can't find session: $9", code: 1}})
	if _, err := tm.NewTaskTab(ctx, "$9", "x", "/r"); !errors.As(err, &ie) {
		t.Errorf("missing session = %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {stderr: "server exited", code: 1}})
	if _, err := tm.NewTaskTab(ctx, "$9", "x", "/r"); err == nil || errors.As(err, &ie) {
		t.Errorf("failure = %v", err)
	}
	for _, out := range []string{"$4:1:%1:x", "$3:x:%1:w", "$3:1:7:w", "$3:1:%1", ""} {
		useFakeTmuxScript(t, map[string]fakeTmuxReply{"new-window": {out: out}})
		if tab, err := tm.NewTaskTab(ctx, "$3", "", "/r"); err == nil {
			t.Errorf("reply %q = %+v", out, tab)
		}
	}

	pid := os.Getpid()
	for _, tc := range []struct {
		reply fakeTmuxReply
		gone  bool
		fails bool
	}{
		{fakeTmuxReply{stderr: "can't find pane: %7", code: 1}, true, false},
		{fakeTmuxReply{stderr: "lost server", code: 1}, false, true},
		{fakeTmuxReply{out: fmt.Sprintf("%%8:0:0:%d\n", pid)}, true, false},
		{fakeTmuxReply{out: fmt.Sprintf("%%7:1:0:%d\n", pid)}, true, false},
		{fakeTmuxReply{out: "%7:0:0:x\n"}, false, true},
		{fakeTmuxReply{out: fmt.Sprintf("%%7:0:1:%d\n", pid)}, false, false},
	} {
		args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": tc.reply})
		_, idle, err := tm.IdleShell(ctx, "%7")
		if errors.Is(err, errTaskTargetGone) != tc.gone || (err != nil && !tc.gone) != tc.fails || idle {
			t.Errorf("%+v = %v %v", tc.reply, idle, err)
		}
		if got := strings.TrimSpace(args()); got != "display-message -p -t %7 #{pane_id}:#{pane_dead}:#{pane_in_mode}:#{pane_pid}" {
			t.Errorf("argv = %q", got)
		}
	}

	args = useFakeTmuxScript(t, map[string]fakeTmuxReply{"capture-pane": {out: "text\n"}})
	if text, err := tm.ReadTaskText(ctx, "%7", 400); err != nil || text != "text\n" {
		t.Errorf("read = %q %v", text, err)
	}
	tm.Interrupt(ctx, "%7")
	tm.TypeLine(ctx, "%7", "-x ; y")
	if got := strings.TrimSpace(args()); got != "capture-pane -p -J -S -400 -t %7\nsend-keys -t %7 C-c\nsend-keys -l -t %7 -- -x ; y\nsend-keys -t %7 Enter" {
		t.Errorf("argv = %q", got)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"send-keys": {code: 1}})
	if err := tm.TypeLine(ctx, "%7", "x"); err == nil {
		t.Error("a failed send-keys typed")
	}
	for _, bad := range []string{"7", "$1:2", "%7;x", ""} {
		_, _, err1 := tm.IdleShell(ctx, bad)
		_, err2 := tm.ReadTaskText(ctx, bad, 1)
		if !errors.As(err1, &ie) || !errors.As(err2, &ie) || !errors.As(tm.Interrupt(ctx, bad), &ie) || !errors.As(tm.TypeLine(ctx, bad, "x"), &ie) {
			t.Errorf("target %q accepted", bad)
		}
	}

	// psmux has no Files, so no tasks.
	origPsmux := tmuxIsPsmux
	tmuxIsPsmux = true
	defer func() { tmuxIsPsmux = origPsmux }()
	if _, err := tm.NewTaskTab(ctx, "$3", "", "/r"); !errors.Is(err, errUnsupported) {
		t.Errorf("psmux tab = %v", err)
	}
	if _, _, err := tm.IdleShell(ctx, "%7"); !errors.Is(err, errUnsupported) {
		t.Errorf("psmux idle = %v", err)
	}
}
