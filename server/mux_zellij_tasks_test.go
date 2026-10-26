package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fakeZellijClient = "0\nCLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 terminal_0 zsh\n"

func TestZellijTaskTabArgv(t *testing.T) {
	log := useFakeZellij(t, map[string]string{
		"list-tabs":    "0\n" + `[{"tab_id":0,"position":0}]`,
		"list-tabs.3":  "0\n" + `[{"tab_id":0,"position":0},{"tab_id":5,"position":1}]`,
		"list-clients": fakeZellijClient,
		"new-tab":      "0\n5\n",
		"list-panes":   "0\n" + `[{"id":0,"is_plugin":false,"tab_id":0},{"id":4,"tab_id":5,"is_plugin":true},{"id":3,"is_plugin":false,"tab_id":5}]`,
	})
	m := newTestZellijMux()
	ctx := t.Context()
	tab, err := m.NewTaskTab(ctx, zellijGroupID("main"), "task:x", "/r/a b")
	want := taskTab{TabID: zellijTabID("main", 5), PaneID: zellijPaneID("main", 3), Target: zellijPaneID("main", 3)}
	if err != nil || tab != want {
		t.Fatalf("NewTaskTab = %+v %v", tab, err)
	}
	if !strings.Contains(log(), "new-tab --no-focus --name=task:x --cwd=/r/a b") {
		t.Errorf("argv:\n%s", log())
	}
	var ie inputError
	if _, err := m.NewTaskTab(ctx, "nope", "x", "/r"); !errors.As(err, &ie) {
		t.Errorf("bad group = %v", err)
	}
}

func TestZellijTaskTabNameAndClient(t *testing.T) {
	log := useFakeZellij(t, map[string]string{
		"list-tabs":    "0\n" + `[{"tab_id":0,"position":0}]`,
		"list-clients": "0\nCLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n",
	})
	m := newTestZellijMux()
	if _, err := m.NewTaskTab(t.Context(), zellijGroupID("main"), "bad\x1bname", "/r"); !errors.Is(err, errZellijNoClient) {
		t.Fatalf("no client = %v", err)
	}
	if strings.Contains(log(), "new-tab") {
		t.Fatal("new-tab ran without a client")
	}
}

func TestZellijTaskShellFake(t *testing.T) {
	useFakeZellij(t, map[string]string{
		"list-panes":  "0\n" + `[{"id":3,"is_plugin":false,"tab_id":5},{"id":6,"is_plugin":false,"tab_id":5,"exited":true}]`,
		"dump-screen": "0\nout\n[termote-task x]\n",
	})
	m := newTestZellijMux()
	ctx := t.Context()
	// No server owns the session's socket here: the shell is not found,
	// so not idle.
	if shell, idle, err := m.IdleShell(ctx, zellijPaneID("main", 3)); shell != "" || idle || err != nil {
		t.Errorf("no shell = %q %v %v", shell, idle, err)
	}
	for _, n := range []int{6, 9} {
		if _, _, err := m.IdleShell(ctx, zellijPaneID("main", n)); !errors.Is(err, errTaskTargetGone) {
			t.Errorf("pane %d = %v", n, err)
		}
	}
	if text, err := m.ReadTaskText(ctx, zellijPaneID("main", 3), 400); err != nil || !strings.Contains(text, "[termote-task x]") {
		t.Errorf("read = %q %v", text, err)
	}
	var ie inputError
	for _, bad := range []string{"main", "x:t1", ""} {
		_, _, err := m.IdleShell(ctx, bad)
		if !errors.As(err, &ie) || !errors.As(m.Interrupt(ctx, bad), &ie) || !errors.As(m.TypeLine(ctx, bad, "x"), &ie) {
			t.Errorf("target %q accepted", bad)
		}
	}
}

func TestZellijTaskShellListFails(t *testing.T) {
	useFakeZellij(t, map[string]string{"list-panes": "1\nboom\n"})
	m := newTestZellijMux()
	if _, _, err := m.IdleShell(t.Context(), zellijPaneID("main", 3)); err == nil || errors.Is(err, errTaskTargetGone) {
		t.Errorf("failed listing = %v", err)
	}
}

// A real Zellij: a task tab opens at the directory, its shell is found and
// reads idle, a typed line runs with its exit status, C-c reaches it.
func TestZellijRealTaskTab(t *testing.T) {
	t.Setenv("SHELL", "/bin/bash")
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("needs bash")
	}
	m := realZellij(t)
	ctx := t.Context()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	g := zellijGroupNamed(t, snap, "main")
	userClient(t, "main")
	dir := filepath.Join(t.TempDir(), "a b")
	os.Mkdir(dir, 0o755)
	tab, err := m.NewTaskTab(ctx, g.ID, "task:x", dir)
	if err != nil {
		t.Fatal(err)
	}
	session, n, _ := parseZellijPaneID(tab.Target)
	if p, err := zellijFindPane(ctx, session, n); err != nil || p.Cwd != dir {
		t.Errorf("pane = %+v %v", p, err)
	}
	shortStart(t)
	agentStartIdleWait = 5 * time.Second
	if shell, err := waitTaskShell(ctx, m, tab.Target, true); err != nil || shell != "bash" {
		t.Fatalf("shell = %q %v", shell, err)
	}
	nonce := "0123456789abcdef"
	if err := m.TypeLine(ctx, tab.Target, buildTaskLine(shellPOSIX, "eval 'echo hi; (exit 4)'", nonce)); err != nil {
		t.Fatal(err)
	}
	zellijWaitFor(t, "exit marker", func() bool {
		text, _ := m.ReadTaskText(ctx, tab.Target, taskReadLines)
		code, ok := parseTaskExit(text, nonce)
		return ok && code == 4
	})
	if err := m.TypeLine(ctx, tab.Target, "sleep 30"); err != nil {
		t.Fatal(err)
	}
	zellijWaitFor(t, "busy", func() bool { _, idle, _ := m.IdleShell(ctx, tab.Target); return !idle })
	if err := m.Interrupt(ctx, tab.Target); err != nil {
		t.Fatal(err)
	}
	zellijWaitFor(t, "idle after C-c", func() bool { _, idle, _ := m.IdleShell(ctx, tab.Target); return idle })
}
