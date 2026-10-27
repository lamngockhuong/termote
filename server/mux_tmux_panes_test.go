package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestParseTmuxPaneID(t *testing.T) {
	orig := tmuxSession
	t.Cleanup(func() { tmuxSession = orig })
	tmuxSession = "main"
	for _, tc := range []struct {
		id, target string
		ok         bool
	}{
		{"%7", "%7", true},
		{"0", "=main:=0", true},
		{"$3:2", "$3:=2", true},
		{"0.1", "", false},
		{"%", "", false},
		{"%7x", "", false},
		{"-t", "", false},
		{"@4", "", false},
	} {
		ref, ok := parseTmuxPaneID(tc.id)
		if ok != tc.ok || ok && ref.target() != tc.target {
			t.Errorf("parseTmuxPaneID(%q) = %+v %v, want %q %v", tc.id, ref, ok, tc.target, tc.ok)
		}
	}
	// psmux numbers panes per session: a %N there is no id.
	usePsmux(t, true)
	if _, ok := parseTmuxPaneID("%7"); ok {
		t.Error("psmux took a %N")
	}
	if ref, ok := parseTmuxPaneID("1"); !ok || ref.target() != "=main:1" {
		t.Errorf("psmux tab id = %+v %v", ref, ok)
	}
}

func TestTmuxPaneRefMatches(t *testing.T) {
	orig := tmuxSession
	t.Cleanup(func() { tmuxSession = orig })
	tmuxSession = "main"
	pane, _ := parseTmuxPaneID("%7")
	if !pane.matches("$9", "x", "4", "%7") || pane.matches("$0", "main", "0", "%8") || pane.matches("", "", "", "") {
		t.Error("a %N must match its own pane id only")
	}
	tab, _ := parseTmuxPaneID("1")
	if !tab.matches("$0", "main", "1", "%3") || tab.matches("$0", "main", "2", "%3") || tab.matches("$0", "mainx", "1", "%3") {
		t.Error("a tab id must match its window, whatever pane is active")
	}
}

func TestParseTmuxPaneList(t *testing.T) {
	out := "$0:0:1:1:%4:11\r\n$0:0:0:0:%3:10\n" + // out of order, CRLF
		"$0:1:0:1:%5:12\n" +
		"$4:2:0:1:%9:\n" + // no pid yet: still a pane
		"$1:0:0:1:%6:1\n$1:0:1:0:bad:1\n" + // a pane that cannot be read drops its window
		"$2:0:0:1:%7:1\n$2:0:0:0:%8:1\n" + // an index listed twice too
		"$3:0:0:1:%10:1\n$3:0:1:0:%10:1\n" + // and a pane id
		"$5:0:0:2:%11:1\n" + // pane_active neither 0 nor 1
		"junk\n$x:0:0:1:%12:1\n$0:0:0:1:%13\n\n"
	got := parseTmuxPaneList(out)
	w0 := got[tmuxWindowKey{"$0", "0"}]
	if len(w0) != 2 || w0[0] != (tmuxPaneInfo{0, false, "%3", "10"}) || w0[1] != (tmuxPaneInfo{1, true, "%4", "11"}) {
		t.Errorf("$0:0 = %+v", w0)
	}
	if w := got[tmuxWindowKey{"$4", "2"}]; len(w) != 1 || w[0].id != "%9" || w[0].pid != "" {
		t.Errorf("$4:2 = %+v", w)
	}
	for _, k := range []tmuxWindowKey{{"$1", "0"}, {"$2", "0"}, {"$3", "0"}, {"$5", "0"}} {
		if w, ok := got[k]; ok {
			t.Errorf("%v kept with a broken pane: %+v", k, w)
		}
	}
	if len(got) != 3 {
		t.Errorf("windows = %+v", got)
	}
}

// Each window's panes come from the pane list, with their own process and
// agent; a window the list lacks keeps its active pane.
func TestTmuxSnapshotListsEveryPane(t *testing.T) {
	orig := tmuxSession
	t.Cleanup(func() { tmuxSession = orig })
	tmuxSession = "main"
	resetTmuxProcs(t)
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"list-windows": {out: "$0:0:1:%4:1:@16:main:edit\n$0:1:0:%5:1:@17:main:logs\n"},
		"list-panes":   {out: "$0:0:0:0:%3:1\n$0:0:1:1:%4:1\n"},
		"-u list-panes": {out: tmuxPaneLine("$0", "0", "0", "0", "bash", "/a") + tmuxPaneLine("$0", "0", "1", "1", "vim", "/b") +
			tmuxPaneLine("$0", "1", "0", "1", "top", "/c")},
	})
	snap, err := tmuxMux{}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	edit, logs := snap.Groups[0].Tabs[0], snap.Groups[0].Tabs[1]
	if len(edit.Panes) != 2 || edit.Panes[0].ID != "%3" || edit.Panes[0].Active || edit.Panes[1].ID != "%4" || !edit.Panes[1].Active {
		t.Fatalf("edit panes = %+v", edit.Panes)
	}
	if p := edit.Panes[0].Process; p == nil || p.Name != "bash" {
		t.Errorf("first pane process = %+v", p)
	}
	if p := edit.Panes[1].Process; p == nil || p.Name != "vim" {
		t.Errorf("second pane process = %+v", p)
	}
	if len(logs.Panes) != 1 || logs.Panes[0].ID != "%5" || !logs.Panes[0].Active {
		t.Errorf("logs panes = %+v", logs.Panes)
	}
	if p := logs.Panes[0].Process; p == nil || p.Name != "top" {
		t.Errorf("unlisted window's pane process = %+v", p)
	}
	if !strings.Contains(args(), "list-panes -a -F "+tmuxPaneListFormat) {
		t.Errorf("argv = %q", args())
	}

	// A failing pane list leaves each tab its active pane.
	useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"list-windows": {out: "$0:0:1:%4:1:@16:main:edit\n"},
		"list-panes":   {stderr: "boom", code: 1},
	})
	snap, err = tmuxMux{}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if p := snap.Groups[0].Tabs[0].Panes; len(p) != 1 || p[0].ID != "%4" {
		t.Errorf("panes after a failed list = %+v", p)
	}
	listTmuxPanes(context.Background()) // logged once a minute: no second line
}

// The agent lookup runs on every listed pane, so each pane reports its own.
func TestTmuxSnapshotAgentPerPane(t *testing.T) {
	orig := tmuxSession
	t.Cleanup(func() { tmuxSession = orig })
	tmuxSession = "main"
	useFakeTmuxScript(t, map[string]fakeTmuxReply{
		"list-windows": {out: "$0:0:1:%4:1:@16:main:edit\n"},
		"list-panes":   {out: "$0:0:0:1:%3:101\n$0:0:1:0:%4:102\n"},
	})
	lastAgents.Lock()
	saved := lastAgents.panes
	lastAgents.Unlock()
	t.Cleanup(func() { lastAgents.Lock(); lastAgents.panes = saved; lastAgents.Unlock() })
	var asked []string
	got := lookupAgentsWith(context.Background(), []agentPane{{paneID: "%3", panePID: "101"}, {pane: 1, paneID: "%4", panePID: "102"}},
		func(p agentPane) (AgentSession, bool) {
			asked = append(asked, p.paneID)
			return AgentSession{Agent: "claude", Status: "idle"}, p.paneID == "%4"
		})
	if len(got) != 2 || got[0] != nil || got[1] == nil || strings.Join(asked, ",") != "%3,%4" {
		t.Errorf("agents = %+v, asked %v", got, asked)
	}
	snap, err := tmuxMux{}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n := len(snap.Groups[0].Tabs[0].Panes); n != 2 {
		t.Errorf("panes = %d", n)
	}
}

func TestTmuxClosePane(t *testing.T) {
	orig := tmuxSession
	t.Cleanup(func() { tmuxSession = orig })
	tmuxSession = "main"
	ctx := context.Background()
	m := tmuxMux{}

	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$0:1:%7:2:main\n"}})
	if err := m.ClosePane(ctx, "%7"); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(args()); got != "display-message -p -t %7 "+tmuxPaneInfoFormat+"\nkill-pane -t %7" {
		t.Errorf("argv = %q", got)
	}
	// A tab id closes its window's active pane, by the %N tmux names.
	args = useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$0:1:%8:3:main\n"}})
	if err := m.ClosePane(ctx, "1"); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(args()); got != "display-message -p -t =main:=1 "+tmuxPaneInfoFormat+"\nkill-pane -t %8" {
		t.Errorf("argv = %q", got)
	}

	for _, tc := range []struct {
		name, id string
		replies  map[string]fakeTmuxReply
		want     error
	}{
		{"last pane", "%7", map[string]fakeTmuxReply{"display-message": {out: "$0:1:%7:1:main\n"}}, errLastPane},
		// tmux answers a missing %N with nothing and exit 0
		{"missing pane", "%7", map[string]fakeTmuxReply{"display-message": {}}, errTmuxUnknownPane},
		{"another pane", "%7", map[string]fakeTmuxReply{"display-message": {out: "$0:1:%9:2:main\n"}}, errTmuxUnknownPane},
		// and a missing window with the current one
		{"another window", "2", map[string]fakeTmuxReply{"display-message": {out: "$0:1:%9:2:main\n"}}, errTmuxUnknownPane},
		{"gone before the kill", "%7", map[string]fakeTmuxReply{"display-message": {out: "$0:1:%7:2:main\n"},
			"kill-pane": {stderr: "can't find pane: %7", code: 1}}, errTmuxUnknownPane},
	} {
		args := useFakeTmuxScript(t, tc.replies)
		if err := m.ClosePane(ctx, tc.id); !errors.Is(err, tc.want) {
			t.Errorf("%s: ClosePane = %v, want %v", tc.name, err, tc.want)
		}
		if tc.want != errTmuxUnknownPane || tc.name != "gone before the kill" {
			if strings.Contains(args(), "kill-pane") {
				t.Errorf("%s: killed a pane: %q", tc.name, args())
			}
		}
	}

	if err := m.ClosePane(ctx, "0.1"); err == nil || err.Error() != "invalid pane id" {
		t.Errorf("ClosePane(0.1) = %v", err)
	}
	usePsmux(t, true)
	if err := m.ClosePane(ctx, "0"); !errors.Is(err, errUnsupported) {
		t.Errorf("psmux ClosePane = %v, want errUnsupported", err)
	}
}

// Selecting a pane (%N) switches its window, then gives it the focus.
func TestTmuxSelectPane(t *testing.T) {
	ctx := context.Background()
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{})
	if err := (tmuxMux{}).SelectTab(ctx, "%4"); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(args()); got != "select-window -t %4\nselect-pane -t %4" {
		t.Errorf("argv = %q", got)
	}
	args = useFakeTmuxScript(t, map[string]fakeTmuxReply{"select-window": {stderr: "can't find pane: %4", code: 1}})
	if err := (tmuxMux{}).SelectTab(ctx, "%4"); !errors.Is(err, errTmuxUnknownPane) {
		t.Errorf("missing pane = %v", err)
	}
	if strings.Contains(args(), "select-pane") {
		t.Errorf("selected a pane after the window failed: %q", args())
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"select-window": {stderr: "lost server", code: 1}})
	if err := (tmuxMux{}).SelectTab(ctx, "%4"); err == nil || errors.Is(err, errTmuxUnknownPane) {
		t.Errorf("failure = %v, want the tmux error", err)
	}
}

// Every pane route takes a %N; a reply naming another pane is refused.
func TestTmuxPaneRoutesTakeAPaneID(t *testing.T) {
	ctx := context.Background()
	m := tmuxMux{}
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{})
	if err := m.SendKeys(ctx, "%4", "ls"); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(args()); got != "send-keys -t %4 ls" {
		t.Errorf("argv = %q", got)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"send-keys": {stderr: "can't find pane: %4", code: 1}})
	if err := m.SendKeys(ctx, "%4", "ls"); !errors.Is(err, errTmuxUnknownPane) {
		t.Errorf("SendKeys to a missing pane = %v", err)
	}

	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$0:1:0:%5:1:main\n"}})
	if _, _, err := m.AgentSession(ctx, "%4"); err == nil || err.Error() != "unknown pane" {
		t.Errorf("AgentSession with another pane's reply = %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$0:1:%5:main:/tmp\n"}})
	if _, _, err := m.PaneDir(ctx, "%4"); err == nil || err.Error() != "unknown pane" {
		t.Errorf("PaneDir with another pane's reply = %v", err)
	}
	args = useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$9:1:%4:main:/tmp\n"}})
	if dir, key, err := m.PaneDir(ctx, "%4"); err != nil || dir != "/tmp" || key != "%4" {
		t.Errorf("PaneDir = %q %q %v", dir, key, err)
	}
	if !strings.Contains(args(), "-t %4 ") {
		t.Errorf("argv = %q", args())
	}

	if s, err := tmuxPaneSession(ctx, "1"); err != nil || s != "="+tmuxSession {
		t.Errorf("tab session = %q %v", s, err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {out: "$3:1:%4:1:work\n"}})
	if s, err := tmuxPaneSession(ctx, "%4"); err != nil || s != "$3" {
		t.Errorf("pane session = %q %v", s, err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {}})
	if _, err := tmuxPaneSession(ctx, "%4"); !errors.Is(err, errTmuxUnknownPane) {
		t.Errorf("missing pane session = %v", err)
	}
	if _, err := m.AttachView(ctx, "%4", Size{Cols: 80, Rows: 24}); !errors.Is(err, errTmuxUnknownPane) {
		t.Errorf("AttachView on a missing pane = %v", err)
	}
	// Closed between its selection and the attach
	if _, err := m.Attach(ctx, "%4", Size{Cols: 80, Rows: 24}); !errors.Is(err, errTmuxUnknownPane) {
		t.Errorf("Attach on a missing pane = %v", err)
	}
	if _, err := tmuxPaneSession(ctx, "x"); err == nil {
		t.Error("tmuxPaneSession took a bad id")
	}
}

// A real server: every pane is listed by its %N, which keeps naming the same
// pane after another one is killed or the panes are swapped; a closed one
// is unknown, never another pane.
func TestTmuxPanesInRealServer(t *testing.T) {
	useRealTmux(t, "termote-panes")
	resetTmuxProcs(t)
	ctx := context.Background()
	m := tmuxMux{}
	if err := tmuxCmd(ctx, "-f", "/dev/null", "new-session", "-d", "-s", tmuxSession, "exec sleep 60").Run(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := tmuxCmd(ctx, "split-window", "-d", "-t", "="+tmuxSession+":=0", "exec sleep 60").Run(); err != nil {
			t.Fatal(err)
		}
	}
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	panes := snap.Groups[0].Tabs[0].Panes
	if len(panes) != 3 || !panes[0].Active {
		t.Fatalf("panes = %+v", panes)
	}
	first, second, third := panes[0].ID, panes[1].ID, panes[2].ID
	idOf := func(target string) string {
		out, _ := tmuxCmd(ctx, "display-message", "-p", "-t", target, "#{pane_id}").Output()
		return strings.TrimSpace(string(out))
	}

	if err := m.SelectTab(ctx, third); err != nil {
		t.Fatal(err)
	}
	if got := idOf("=" + tmuxSession + ":=0"); got != third {
		t.Errorf("active pane = %s, want %s", got, third)
	}
	// A tab id is its active pane.
	if dir, key, err := m.PaneDir(ctx, "0"); err != nil || key != third || dir == "" {
		t.Errorf("PaneDir(0) = %q %q %v", dir, key, err)
	}

	if err := m.ClosePane(ctx, second); err != nil {
		t.Fatal(err)
	}
	if err := tmuxCmd(ctx, "swap-pane", "-s", first, "-t", third).Run(); err != nil {
		t.Fatal(err)
	}
	if _, key, err := m.PaneDir(ctx, third); err != nil || key != third {
		t.Errorf("PaneDir(%s) after a swap = %q %v", third, key, err)
	}
	if err := m.SendKeys(ctx, second, "x"); !errors.Is(err, errTmuxUnknownPane) {
		t.Errorf("SendKeys to a closed pane = %v", err)
	}
	if _, _, err := m.PaneDir(ctx, second); err == nil {
		t.Error("PaneDir found a closed pane")
	}
	if err := m.ClosePane(ctx, second); !errors.Is(err, errTmuxUnknownPane) {
		t.Errorf("ClosePane on a closed pane = %v", err)
	}

	if err := m.ClosePane(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := m.ClosePane(ctx, third); !errors.Is(err, errLastPane) {
		t.Errorf("ClosePane on the last pane = %v, want errLastPane", err)
	}
	snap, err = m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if p := snap.Groups[0].Tabs[0].Panes; len(p) != 1 || p[0].ID != third {
		t.Errorf("panes = %+v", p)
	}
	if s, err := tmuxPaneSession(ctx, third); err != nil || !tmuxSessionIDRe.MatchString(s) {
		t.Errorf("session of %s = %q %v", third, s, err)
	}
}
