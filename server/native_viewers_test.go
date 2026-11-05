package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestTmuxViewedWindows(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	at := func(ago time.Duration) string { return strconv.FormatInt(now.Add(-ago).Unix(), 10) }
	out := "10:" + at(time.Minute) + ":@1\n" + // the user's, active
		"11:" + at(nativeViewerIdle+time.Second) + ":@2\n" + // left the desk
		"12:" + at(0) + ":@3\r\n" + // Termote's own
		"13:" + at(nativeViewerIdle) + ":@4\n" + // just within
		"x:" + at(0) + ":@5\n" + "14:soon:@6\n" + "15:" + at(0) + ":%1\n" + "garbage\n\n"
	got := tmuxViewedWindows(out, now, func(pid int) bool { return pid == 12 })
	if len(got) != 2 || !got["@1"] || !got["@4"] {
		t.Errorf("windows = %v", got)
	}
}

func TestPanesOfWindows(t *testing.T) {
	groups := tmuxTabs(0, []string{"%1", "%2"}, []string{"%3"}).Groups
	if got := panesOfWindows(groups, nil); got != nil {
		t.Errorf("no window = %v", got)
	}
	got := panesOfWindows(groups, map[string]bool{"@0": true})
	if len(got) != 2 || !got["%1"] || !got["%2"] {
		t.Errorf("panes = %v", got)
	}
}

func TestOwnTerminals(t *testing.T) {
	addOwnTerminal(-7)
	addOwnTerminal(-7)
	removeOwnTerminal(-7)
	if !isOwnTerminal(-7) {
		t.Error("forgotten while one start is left")
	}
	removeOwnTerminal(-7)
	if isOwnTerminal(-7) {
		t.Error("still own")
	}
}

func TestPanesOfTabsShowing(t *testing.T) {
	groups := tmuxTabs(0, []string{"%1", "%2"}, []string{"%3"}).Groups
	if got := panesOfTabsShowing(groups, nil); got != nil {
		t.Errorf("none shown = %v", got)
	}
	got := panesOfTabsShowing(groups, map[string]bool{"%2": true})
	if len(got) != 2 || !got["%1"] || !got["%2"] {
		t.Errorf("panes = %v", got)
	}
}

func TestZellijNativeViewers(t *testing.T) {
	viewers := map[string]bool{}
	clients := map[string]string{"1": "terminal_0", "2": "terminal_3", "3": "plugin_1", "4": "terminal_x"}
	zellijNativeViewers(viewers, "main", clients, map[string]bool{"2": true})
	if len(viewers) != 1 || !viewers[zellijPaneKey("main", 0)] {
		t.Errorf("viewers = %v", viewers)
	}
}

func TestZellijReadClients(t *testing.T) {
	log := useFakeZellij(t, map[string]string{
		"--version":     fakeZellijVersion,
		"list-sessions": "0\nmain [Created 1m ago] \nother [Created 1m ago] \n",
		"list-tabs":     fakeZellijTabs,
		"list-panes":    fakeZellijPanes,
		"list-clients":  "0\nCLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 terminal_3 zsh\n2 terminal_1 zsh\n5 terminal_2 zsh\n",
	})
	m := newTestZellijMux()
	// Termote runs client 2 in main, and closed 5 there a moment ago.
	m.addClient(&zellijClient{m: m, session: "main", id: "2", pane: 1})
	m.departed["main"] = map[string]time.Time{"5": time.Now()}
	snap, err := m.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	// A client shows its whole tab: pane 1 beside the focused 3 in main; a
	// pane no tab has (terminal_2) adds nothing.
	want := map[string]bool{zellijPaneKey("main", 3): true, zellijPaneKey("main", 1): true,
		zellijPaneKey("other", 3): true, zellijPaneKey("other", 1): true}
	if len(snap.viewers) != len(want) {
		t.Fatalf("viewers = %v", snap.viewers)
	}
	for k := range want {
		if !snap.viewers[k] {
			t.Errorf("missing %s in %v", k, snap.viewers)
		}
	}
	if b, _ := json.Marshal(snap); strings.Contains(string(b), "viewers") {
		t.Errorf("viewers in the JSON: %s", b)
	}
	if !strings.Contains(log(), "list-clients") {
		t.Error("no list-clients")
	}
	// A client starting holds the slot: no one counts in that session.
	slot := m.sessionSlot("other")
	slot <- struct{}{}
	snap, _ = m.Snapshot(t.Context())
	<-slot
	if len(snap.viewers) != 2 || !snap.viewers[zellijPaneKey("main", 3)] || !snap.viewers[zellijPaneKey("main", 1)] {
		t.Errorf("while a client starts = %v", snap.viewers)
	}
}

func TestZellijReadClientsFails(t *testing.T) {
	useFakeZellij(t, map[string]string{
		"--version":  fakeZellijVersion,
		"list-tabs":  fakeZellijTabs,
		"list-panes": fakeZellijPanes,
	})
	m := newTestZellijMux()
	snap, err := m.Snapshot(t.Context())
	if err != nil || len(snap.viewers) != 0 {
		t.Errorf("failed list-clients = %v, %v", snap.viewers, err)
	}
	if !m.clientErrs["main"] {
		t.Error("failing session not noted")
	}
	// Logged once: a second failure keeps the note; a success clears it.
	m.Snapshot(t.Context())
	m.noteClientErrs(t.Context(), []string{"main"}, []error{nil})
	if len(m.clientErrs) != 0 {
		t.Errorf("clientErrs = %v", m.clientErrs)
	}
	// Cancelled: nothing logged, nothing counted.
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if v := m.readClients(ctx, []string{"main"}); len(v) != 0 {
		t.Errorf("cancelled = %v", v)
	}
}
