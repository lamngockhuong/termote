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

// useRealTmux points the backend at a tmux server of its own on a private
// socket, with default session name (not yet created).
func useRealTmux(t *testing.T, name string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil || runtime.GOOS == "windows" {
		t.Skip("needs tmux with a private socket")
	}
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = name
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})
}

// tmuxNewSession starts a detached session the way a user would, outside
// Termote, and returns its session id.
func tmuxNewSession(t *testing.T, name, dir string) string {
	t.Helper()
	out, err := tmuxCmd(context.Background(), "-f", "/dev/null", "new-session", "-d", "-s", name,
		"-c", dir, "-P", "-F", "#{session_id}", "exec sleep 60").Output()
	if err != nil {
		t.Fatalf("new-session %q: %v", name, err)
	}
	return strings.TrimSpace(string(out))
}

func findGroup(snap Snapshot, id string) *Group {
	for i := range snap.Groups {
		if snap.Groups[i].ID == id {
			return &snap.Groups[i]
		}
	}
	return nil
}

// Every session on the server is a group. The default one keeps its name as
// id and bare tab ids; another one is "$N", which a rename does not change.
// Each command reaches the session it names and no other.
func TestTmuxSessionsInRealServer(t *testing.T) {
	useRealTmux(t, fmt.Sprintf("termote-sessions-%d", os.Getpid()))
	ctx := context.Background()
	m := tmuxMux{}
	work, _ := filepath.EvalSymlinks(t.TempDir())
	// A session whose name starts with the default one's must never be taken
	// for it.
	tmuxNewSession(t, tmuxSession+"x", work)
	sid := tmuxNewSession(t, "work", work)

	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Groups) != 3 || snap.Groups[0].ID != tmuxSession || snap.Groups[0].Tabs[0].ID != "0" {
		t.Fatalf("groups = %+v", snap.Groups)
	}
	g := findGroup(snap, sid)
	if g == nil || g.Name != "work" || g.Tabs[0].ID != sid+":0" || g.Tabs[0].Panes[0].ID != sid+":0" {
		t.Fatalf("work group = %+v", g)
	}

	if err := tmuxCmd(ctx, "rename-session", "-t", sid, "renamed").Run(); err != nil {
		t.Fatal(err)
	}
	snap, _ = m.Snapshot(ctx)
	if g := findGroup(snap, sid); g == nil || g.Name != "renamed" || g.Tabs[0].ID != sid+":0" {
		t.Fatalf("after rename = %+v", snap.Groups)
	}

	tab, err := m.NewTab(ctx, sid, "second")
	if err != nil || tab != sid+":1" {
		t.Fatalf("NewTab(%s) = %q, %v", sid, tab, err)
	}
	if err := m.SelectTab(ctx, sid+":0"); err != nil {
		t.Fatal(err)
	}
	if dir := waitPaneDir(t, sid+":0", work); dir != work {
		t.Errorf("PaneDir(%s:0) = %q, want %q", sid, dir, work)
	}
	if _, _, err := m.AgentSession(ctx, sid+":0"); err != nil {
		t.Errorf("AgentSession(%s:0) = %v", sid, err)
	}
	if err := m.RenameTab(ctx, sid+":1", "x"); err != nil {
		t.Fatal(err)
	}
	if err := m.CloseTab(ctx, sid+":1"); err != nil {
		t.Fatal(err)
	}
	snap, _ = m.Snapshot(ctx)
	if g := findGroup(snap, sid); g == nil || len(g.Tabs) != 1 {
		t.Fatalf("after CloseTab = %+v", g)
	}

	// A missing index never reaches a window whose name starts with it.
	if err := tmuxCmd(ctx, "new-window", "-d", "-t", sid+":", "-n", "9x").Run(); err != nil {
		t.Fatal(err)
	}
	if err := m.CloseTab(ctx, sid+":9"); err == nil {
		t.Error("CloseTab of a missing index succeeded")
	}
	if err := m.RenameTab(ctx, "9", "y"); err == nil {
		t.Error("RenameTab of a missing index succeeded")
	}
	snap, _ = m.Snapshot(ctx)
	if g := findGroup(snap, sid); g == nil || len(g.Tabs) != 2 || g.Tabs[1].Name != "9x" {
		t.Fatalf("after closing a missing index = %+v", g)
	}
	// New tab lands in the session asked for, even with a window named like
	// the default session in the current one.
	if err := tmuxCmd(ctx, "rename-window", "-t", sid+":=0", tmuxSession).Run(); err != nil {
		t.Fatal(err)
	}
	if id, err := m.NewTab(ctx, "", ""); err != nil || strings.Contains(id, ":") {
		t.Fatalf("NewTab(default) = %q, %v", id, err)
	}

	// A terminal on the session's window attaches to that session.
	ts, err := m.Attach(ctx, sid+":0", Size{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "client attached", func() bool {
		out, _ := tmuxCmd(ctx, "list-clients", "-F", "#{session_id}").Output()
		return strings.TrimSpace(string(out)) == sid
	})
	ts.Close()

	// Once the session is gone, its ids answer nothing: never the default
	// session's window of the same index.
	if err := tmuxCmd(ctx, "kill-session", "-t", sid).Run(); err != nil {
		t.Fatal(err)
	}
	var ie inputError
	if _, _, err := m.PaneDir(ctx, sid+":0"); tmuxFilesSupported && !errors.As(err, &ie) {
		t.Errorf("PaneDir of a closed session = %v", err)
	}
	if _, _, err := m.AgentSession(ctx, sid+":0"); !errors.As(err, &ie) {
		t.Errorf("AgentSession of a closed session = %v", err)
	}
	if err := m.SelectTab(ctx, sid+":0"); err == nil {
		t.Error("SelectTab of a closed session succeeded")
	}
	if _, err := m.NewTab(ctx, sid, ""); !errors.As(err, &ie) || ie != "unknown group" {
		t.Errorf("NewTab of a closed session = %v", err)
	}

	// The default session closed: the next snapshot makes it again, even
	// though a session whose name starts with it is still there.
	if err := tmuxCmd(ctx, "kill-session", "-t", "="+tmuxSession).Run(); err != nil {
		t.Fatal(err)
	}
	snap, err = m.Snapshot(ctx)
	if err != nil || len(snap.Groups) != 2 || snap.Groups[0].ID != tmuxSession || snap.Groups[1].Name != tmuxSession+"x" {
		t.Fatalf("after closing the default session = %+v, %v", snap.Groups, err)
	}
}

func waitPaneDir(t *testing.T, id, want string) string {
	t.Helper()
	if !tmuxFilesSupported {
		return want
	}
	var got string
	waitUntil(t, "pane directory", func() bool {
		got, _, _ = tmuxMux{}.PaneDir(context.Background(), id)
		return got == want
	})
	return got
}
