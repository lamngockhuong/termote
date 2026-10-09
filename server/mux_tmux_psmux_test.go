package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// usePsmux sets tmuxIsPsmux for one test.
func usePsmux(t *testing.T, on bool) {
	t.Helper()
	orig := tmuxIsPsmux
	tmuxIsPsmux = on
	t.Cleanup(func() { tmuxIsPsmux = orig })
}

// psmux has no "=" before a window index and never matches a window name,
// so its window targets carry the bare index; sessions stay exact.
func TestParseTmuxIDPsmux(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, true)
	for id, want := range map[string]string{"0": "=main:0", "12": "=main:12", "$3:1": "$3:1"} {
		if w, ok := parseTmuxID(id); !ok || w.target() != want {
			t.Errorf("parseTmuxID(%q).target() = %q, %v; want %q", id, w.target(), ok, want)
		}
	}
}

// On psmux every window command uses the bare index, and a tab is selected
// only once display-message has answered for that very window: psmux
// answers select-window on a missing one with exit 0.
func TestPsmuxTargets(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, true)
	ctx := context.Background()
	m := tmuxMux{}
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$3:1:work\n"}})
	if err := m.SelectTab(ctx, "$3:1"); err != nil {
		t.Fatal(err)
	}
	m.CloseTab(ctx, "$3:2", "")
	m.RenameTab(ctx, "0", "x", "")
	m.SendKeys(ctx, "$3:0", "ls")
	want := []string{
		"display-message -p -t $3:1 #{session_id}:#{window_index}:#{session_name}",
		"select-window -t $3:1",
		"kill-window -t $3:2",
		"rename-window -t =main:0 x",
		"send-keys -t $3:0 ls",
	}
	if got := strings.Split(strings.TrimSpace(args()), "\n"); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("argv = %q", got)
	}

	// psmux prints its error on stdout with exit 0, or answers for another
	// window: no select-window then.
	for _, out := range []string{"ERROR: can't find window: 9\n", "$3:0:work\n", "$4:1:work\n", ""} {
		args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: out}})
		var ie inputError
		if err := m.SelectTab(ctx, "$3:1"); !errors.As(err, &ie) {
			t.Errorf("SelectTab with reply %q = %v", out, err)
		}
		if strings.Contains(args(), "select-window") {
			t.Errorf("reply %q: argv = %q", out, args())
		}
	}
	// The default session is checked by name.
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$0:1:main\n"}})
	if err := m.SelectTab(ctx, "1"); err != nil {
		t.Errorf("SelectTab(1) = %v", err)
	}
}

// The agent routes address a pane by its window on psmux, where every
// session has a %1, and by tmux's own pane id on tmux. The target comes
// from tmux's reply, so a window named "2" or "$0:2" has one target (the
// pane lock's key).
func TestTmuxAgentTarget(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	find := func(string, int) (AgentSession, bool) { return AgentSession{Agent: "claude"}, true }
	ctx := context.Background()
	for _, tc := range []struct {
		psmux       bool
		id, reply   string
		wantTarget  string
		wantDisplay string
	}{
		{false, "2", "$0:2:0:%5:1:main", "%5", "-t =main:=2 "},
		{true, "2", "$0:2:0:%1:1:main", "$0:2", "-t =main:2 "},
		{true, "$0:2", "$0:2:0:%1:1:main", "$0:2", "-t $0:2 "},
		{true, "$3:1", "$3:1:0:%1:1:work", "$3:1", "-t $3:1 "},
	} {
		usePsmux(t, tc.psmux)
		args := useFakeTmux(t, tc.reply)
		s, ok, err := tmuxAgentSession(ctx, tc.id, find)
		if !ok || err != nil || s.Target != tc.wantTarget {
			t.Errorf("psmux=%v %q: %+v, %v, %v; want target %q", tc.psmux, tc.id, s, ok, err, tc.wantTarget)
		}
		if !strings.Contains(args(), tc.wantDisplay) {
			t.Errorf("psmux=%v argv = %q", tc.psmux, args())
		}
	}
}

func TestPsmuxAgentWriterTargets(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, true)
	args := useFakeTmux(t, "")
	ctx := context.Background()
	m := tmuxMux{}
	if _, err := m.Capture(ctx, "$3:1"); err != nil {
		t.Fatal(err)
	}
	if err := m.SendKeySequence(ctx, "$0:0", []string{"Enter"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Paste(ctx, "$3:1", "x"); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(args()), "\n")
	if len(lines) != 4 || lines[0] != "capture-pane -p -e -t $3:1" || lines[1] != "send-keys -t $0:0 Enter" ||
		!strings.HasSuffix(lines[3], " -p -d -t $3:1") {
		t.Fatalf("argv = %q", lines)
	}
	// A pane id is ambiguous on psmux; anything but "$N:i", the form
	// agentTarget builds, is refused before tmux runs.
	var ie inputError
	for _, bad := range []string{"%1", "main:0", "=main:0", "=other:0", "$3", "$3:x", "$3:=0", "-t", "$3:1;"} {
		if _, err := m.Capture(ctx, bad); !errors.As(err, &ie) {
			t.Errorf("Capture(%q) = %v", bad, err)
		}
		if err := m.SendKeySequence(ctx, bad, []string{"Enter"}); !errors.As(err, &ie) {
			t.Errorf("SendKeySequence(%q) = %v", bad, err)
		}
	}
}

// psmux keys a tab by its id (whether its window ids are unique on the
// server is unchecked), so a close or rename with that key acts on the id's
// target with nothing listed first.
func TestPsmuxTabKeys(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()
	tmuxSession = "main"
	usePsmux(t, true)
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"list-windows": {out: "$0:0:1:%1:1:@4:main:sh\n"}})
	snap, err := (tmuxMux{}).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if tab := snap.Groups[0].Tabs[0]; tab.Key != "0" || tab.Panes[0].key != "0" {
		t.Errorf("tab key %q, pane key %q; want the id", tab.Key, tab.Panes[0].key)
	}
	before := len(strings.Split(strings.TrimSpace(args()), "\n"))
	if err := (tmuxMux{}).CloseTab(context.Background(), "0", "0"); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(args()), "\n")
	if len(lines) != before+1 || lines[before] != "kill-window -t =main:0" {
		t.Errorf("argv = %q", lines[before:])
	}
}
