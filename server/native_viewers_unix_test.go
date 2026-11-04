//go:build !windows

package main

import (
	"context"
	"testing"
	"time"
)

// A real tmux: Termote's own attach is never a viewer; the same client as
// the user's is, while active; psmux and a failed listing count no one.
func TestTmuxNativeViewersReal(t *testing.T) {
	useRealTmux(t, "badge")
	ctx := context.Background()
	sid := tmuxNewSession(t, "user", t.TempDir())
	ts, err := startTerminal(tmuxAttachArgv(sid), Size{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	waitUntil(t, "client attached", func() bool {
		out, _ := tmuxCmd(ctx, "list-clients", "-F", "#{client_pid}").Output()
		return len(out) > 0
	})
	snap, err := tmuxSnapshot(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.viewers) != 0 {
		t.Errorf("Termote's client counted: %v", snap.viewers)
	}
	pid := ts.(*ptyStream).cmd.Process.Pid
	removeOwnTerminal(pid)
	defer addOwnTerminal(pid) // its end removes it again
	snap, _ = tmuxSnapshot(ctx, false)
	g := findGroup(snap, sid)
	if g == nil || len(snap.viewers) != 1 || !snap.viewers[paneKey(g.Tabs[0].Panes[0])] {
		t.Errorf("the user's client = %v", snap.viewers)
	}
	// Idle for longer than nativeViewerIdle.
	if v := tmuxNativeViewers(ctx, snap.Groups, time.Now().Add(nativeViewerIdle+time.Minute)); len(v) != 0 {
		t.Errorf("idle client counted: %v", v)
	}
	tmuxIsPsmux = true
	v := tmuxNativeViewers(ctx, snap.Groups, time.Now())
	tmuxIsPsmux = false
	if v != nil {
		t.Errorf("psmux = %v", v)
	}
	sock := tmuxSocket
	tmuxSocket += ".gone"
	v = tmuxNativeViewers(ctx, snap.Groups, time.Now())
	tmuxSocket = sock
	if v != nil {
		t.Errorf("failed list-clients = %v", v)
	}
}
