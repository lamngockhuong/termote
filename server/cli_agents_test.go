package main

import (
	"errors"
	"maps"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestAgentsUsage(t *testing.T) {
	for _, args := range [][]string{nil, {"bogus"}, {"list", "extra"}, {"list", "--nope"}, {"read"}, {"read", "a", "b"}, {"wait"}} {
		tc := newTestCLI(t, runtime.GOOS)
		if err := tc.dispatch("agents", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
	tc := newTestCLI(t, runtime.GOOS)
	tc.printHelp()
	for _, want := range []string{"agents <cmd>", "Options of agents", "--workspace <id|name>", "--timeout <duration>", "--after <seq>", "--text <answer>"} {
		if !strings.Contains(tc.stdout.String(), want) {
			t.Errorf("help misses %q", want)
		}
	}
}

// In container mode there is no local socket: every command says so before
// sending anything.
func TestAgentsContainer(t *testing.T) {
	tc := newTestCLI(t, runtime.GOOS)
	tc.saveConfig(savedConfig{Port: 7680, Password: "secret", Container: &containerConfig{Port: 7680}})
	for _, args := range [][]string{{"list"}, {"read", "%1"}, {"send", "%1", "hi"}, {"wait", "%1"}, {"answer", "%1"}, {"start", "--workspace", "w", "--kind", "claude"},
		{"job", "remove", "j1"}, {"jobs", "prune"}} {
		if err := tc.dispatch("agents", args); err == nil || !strings.Contains(err.Error(), "not supported in container mode") {
			t.Errorf("%v: %v", args, err)
		}
	}
}

func TestResolveGroup(t *testing.T) {
	s := twoGroupSnapshot()
	if g, err := resolveGroup(s, "$2"); err != nil || g.Name != "web" {
		t.Errorf("by id: %v %v", g, err)
	}
	if g, err := resolveGroup(s, "api"); err != nil || g.ID != "$3" {
		t.Errorf("by name: %v %v", g, err)
	}
	if _, err := resolveGroup(s, "web"); err == nil || !strings.Contains(err.Error(), "2 workspaces are named \"web\"; name one by its id: $1, $2") {
		t.Errorf("duplicate: %v", err)
	}
	if _, err := resolveGroup(s, "x"); err == nil || !strings.Contains(err.Error(), "no workspace") {
		t.Errorf("unknown: %v", err)
	}
}

func twoGroupSnapshot() Snapshot {
	return Snapshot{Groups: []Group{{ID: "$1", Name: "web"}, {ID: "$2", Name: "web"}, {ID: "$3", Name: "api"}}}
}

func TestGroupCwd(t *testing.T) {
	proc := func(cwd string) *ProcessInfo { return &ProcessInfo{Name: "zsh", Cwd: cwd} }
	for i, c := range []struct {
		g    Group
		want string
	}{
		{Group{}, ""},
		{Group{Tabs: []Tab{{Panes: []Pane{{Process: proc("/a")}, {}}}, {Panes: []Pane{{Process: proc("/a")}}}}}, "/a"},
		{Group{Tabs: []Tab{{Panes: []Pane{{Process: proc("/a")}}}, {Panes: []Pane{{Process: proc("/b")}}}}}, ""},
		{Group{Tabs: []Tab{{Processes: []ProcessInfo{{Cwd: "/c"}, {Cwd: ""}, {Cwd: "/c"}}}}}, "/c"},
		{Group{Tabs: []Tab{{Panes: []Pane{{Process: proc("/a")}}, Processes: []ProcessInfo{{Cwd: "/c"}}}}}, ""},
	} {
		if got := groupCwd(c.g); got != c.want {
			t.Errorf("%d: %q, want %q", i, got, c.want)
		}
	}
}

func TestLastTurn(t *testing.T) {
	es := []TranscriptEntry{{Role: "assistant"}, {Role: "user"}, {Role: "assistant"}, {Role: "note"}}
	if got := lastTurn(es); len(got) != 3 || got[0].Role != "user" {
		t.Errorf("%+v", got)
	}
	if got := lastTurn(es[:1]); len(got) != 1 {
		t.Errorf("no user: %+v", got)
	}
}

func TestPartText(t *testing.T) {
	long := strings.Repeat("é", 400)
	for _, c := range []struct {
		p    TranscriptPart
		want string
	}{
		{TranscriptPart{Kind: "text", Text: "a\x1b[2Jb\nc"}, "a[2Jb\nc"},
		{TranscriptPart{Kind: "thinking", Text: "hmm\n  ok"}, "(thinking) hmm ok"},
		{TranscriptPart{Kind: "tool", Tool: "Bash", Input: "ls", Result: "x"}, "[Bash] ls\n  → x"},
		{TranscriptPart{Kind: "tool", Tool: "Bash", IsError: true, Result: "no"}, "[Bash]\n  → error: no"},
		{TranscriptPart{Kind: "image"}, "[image]"},
		{TranscriptPart{Kind: "other"}, "[other]"},
	} {
		if got := partText(c.p); got != c.want {
			t.Errorf("%+v: %q, want %q", c.p, got, c.want)
		}
	}
	if got := partText(TranscriptPart{Kind: "thinking", Text: long}); len([]rune(got)) != len("(thinking) ")+300 || !strings.HasSuffix(got, "…") {
		t.Errorf("long thinking: %d runes", len([]rune(got)))
	}
}

func TestSinceText(t *testing.T) {
	now := time.Now()
	for _, c := range []struct {
		ago  time.Duration
		want string
	}{{5 * time.Second, "5s"}, {3 * time.Minute, "3m"}, {5 * time.Hour, "5h"}, {72 * time.Hour, "3d"}} {
		if got := sinceText(now.Add(-c.ago).UTC().Format(time.RFC3339)); got != c.want {
			t.Errorf("%v: %q, want %q", c.ago, got, c.want)
		}
	}
	if sinceText("soon") != "" || dash("") != "-" || dash("x") != "x" {
		t.Error("bad time or dash")
	}
}

func TestAgentsRefusal(t *testing.T) {
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{404, `{"error":"not found"}`, "termote update"},
		{502, `nope`, "the server answered HTTP 502"},
		{500, `{"error":"internal error"}`, "the server refused: internal error"},
		{409, `{"error":"the input box already holds a draft","code":"input_has_draft"}`, "(input_has_draft); the user typed"},
		{409, `{"error":"an earlier message","code":"input_busy"}`, "try again in a moment"},
		{409, `{"error":"x","code":"target_changed"}`, "termote agents list"},
		{409, `{"error":"the screen changed","code":"prompt_changed"}`, "read the dialog again"},
		{409, `{"error":"a dialog is open","code":"input_not_ready"}`, "answer it first"},
		{409, `{"error":"bad‮","code":"other"}`, "the server refused: bad (other)"},
	} {
		err := agentsRefusal(agentsReply{status: c.status, body: []byte(c.body)})
		if err == nil || !strings.Contains(err.Error(), c.want) || strings.Contains(err.Error(), "‮") {
			t.Errorf("%d %s: %v, want %q", c.status, c.body, err, c.want)
		}
	}
}

func exitCode(err error) int {
	var ee *exitError
	if errors.As(err, &ee) {
		return ee.code
	}
	if err != nil {
		return 1
	}
	return 0
}

func TestWaitVerdict(t *testing.T) {
	snap := func(statuses map[string]string) Snapshot {
		var panes []Pane
		for _, id := range []string{"%1", "%2", "%3"} {
			if st, ok := statuses[id]; ok {
				panes = append(panes, Pane{ID: id, Agent: &AgentInfo{Name: "claude", Status: st}})
			}
		}
		return Snapshot{Groups: []Group{{ID: "w", Tabs: []Tab{{ID: "w:0", Panes: panes}}}}}
	}
	seq := uint64(0)
	ev := func(id, from, to string) activityEvent {
		seq++
		return activityEvent{Seq: seq, Key: id, PaneID: id, From: from, To: to}
	}
	ids := []string{"%1", "%2", "%3"}
	for _, tc := range []struct {
		name   string
		events []activityEvent
		now    map[string]string
		want   map[string]waitEnd
	}{
		{"nothing after the mark", nil, map[string]string{"%1": "blocked", "%2": "done", "%3": "working"}, map[string]waitEnd{}},
		{"a turn that ended before the read is reported", []activityEvent{ev("%2", "working", "done")},
			map[string]string{"%1": "working", "%2": "done", "%3": "working"}, map[string]waitEnd{"%2": waitDone}},
		{"two in one read", []activityEvent{ev("%1", "working", "idle"), ev("%3", "working", "blocked")},
			map[string]string{"%1": "idle", "%2": "working", "%3": "blocked"}, map[string]waitEnd{"%1": waitDone, "%3": waitDialog}},
		{"a dialog answered since is not one", []activityEvent{ev("%1", "working", "blocked"), ev("%1", "blocked", "working")},
			map[string]string{"%1": "working", "%2": "working", "%3": "working"}, map[string]waitEnd{}},
		{"a dialog cancelled ends the turn", []activityEvent{ev("%1", "working", "blocked"), ev("%1", "blocked", "idle")},
			map[string]string{"%1": "idle", "%2": "working", "%3": "working"}, map[string]waitEnd{"%1": waitDone}},
		{"working again after a turn", []activityEvent{ev("%1", "working", "idle"), ev("%1", "idle", "working")},
			map[string]string{"%1": "working", "%2": "working", "%3": "working"}, map[string]waitEnd{"%1": waitDone}},
		{"the agent went", []activityEvent{ev("%2", "working", "")},
			map[string]string{"%1": "working", "%3": "working"}, map[string]waitEnd{"%2": waitGone}},
		{"gone from the snapshot", nil, map[string]string{"%1": "working", "%2": "working"}, map[string]waitEnd{"%3": waitGone}},
		{"another pane's change", []activityEvent{ev("%9", "working", "idle")},
			map[string]string{"%1": "working", "%2": "working", "%3": "working"}, map[string]waitEnd{}},
	} {
		got := waitVerdict(tc.events, ids, map[string]uint64{}, snap(tc.now))
		if !maps.Equal(got, tc.want) {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
	// Each pane counts the changes after its own mark only: %1 ended at 2,
	// after its mark 1 and before %2's mark 3, which a send to %2 printed;
	// %2's turn that ended at 2 too is before its mark.
	events := []activityEvent{{Seq: 2, Key: "%1", From: "working", To: "done"}, {Seq: 2, Key: "%2", From: "working", To: "idle"}}
	got := waitVerdict(events, []string{"%1", "%2"}, map[string]uint64{"%1": 1, "%2": 3},
		snap(map[string]string{"%1": "done", "%2": "working"}))
	if !maps.Equal(got, map[string]waitEnd{"%1": waitDone}) {
		t.Errorf("own marks: %v", got)
	}
	// A pane whose id is its tab's (tmux without pane ids) is followed by
	// its tab's key: after a move its id is another tab's old one.
	moved := Snapshot{Groups: []Group{{ID: "w", Tabs: []Tab{
		{ID: "w:0", Key: "@13", Panes: []Pane{{ID: "w:0", Agent: &AgentInfo{Name: "claude", Status: "working"}}}},
		{ID: "w:1", Key: "@12", Panes: []Pane{{ID: "w:1", Agent: &AgentInfo{Name: "claude", Status: "done"}}}},
	}}}}
	events = []activityEvent{{Seq: 1, Key: "@12", PaneID: "w:0", From: "working", To: "done"}}
	if got := waitVerdict(events, []string{"@12", "@13"}, map[string]uint64{}, moved); !maps.Equal(got, map[string]waitEnd{"@12": waitDone}) {
		t.Errorf("moved tab: %v", got)
	}
	for end, code := range map[waitEnd]int{waitDone: 0, waitDialog: agentsExitDialog, waitGone: agentsExitGone} {
		if end.exit() != code {
			t.Errorf("%s exits %d", end, end.exit())
		}
	}
}

func TestFormatDiff(t *testing.T) {
	for _, tc := range []struct {
		name string
		d    diffResponse
		want string
	}{
		{"sensitive", diffResponse{Sensitive: true}, "(sensitive file, diff not shown)\n"},
		{"binary", diffResponse{Binary: true}, "(binary)\n"},
		{"too large", diffResponse{Reason: "too-large"}, "(too-large)\n"},
		{"mode only", diffResponse{}, "(no content change)\n"},
		{"plain", diffResponse{Hunks: []diffHunk{{Header: "@@ -1 +1 @@", Lines: []diffLine{{Kind: "del", Text: "a"}, {Kind: "add", Text: "b", NoNewline: true}}}}},
			"```diff\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n```\n"},
		{"backticks inside", diffResponse{Hunks: []diffHunk{{Header: "@@ -0,0 +1 @@", Lines: []diffLine{{Kind: "add", Text: "```` x ``"}}}}},
			"`````diff\n@@ -0,0 +1 @@\n+```` x ``\n`````\n"},
		{"control characters", diffResponse{Truncated: true, Hunks: []diffHunk{{Header: "@@ -1 +1 @@\x1b[2J", Lines: []diffLine{{Kind: "ctx", Text: "a\x07b\u202ec"}}}}},
			"```diff\n@@ -1 +1 @@[2J\n abc\n```\n(the diff is cut short: too large)\n"},
	} {
		if got := formatDiff(tc.d); got != tc.want {
			t.Errorf("%s:\n%q\nwant\n%q", tc.name, got, tc.want)
		}
	}
}

func TestClipDiff(t *testing.T) {
	d := diffResponse{Truncated: true, Hunks: []diffHunk{{Header: "@@ -0,0 +3 @@", Lines: []diffLine{{Kind: "add", Text: "one"}, {Kind: "add", Text: "two"}, {Kind: "add", Text: "```"}}}}}
	text := formatDiff(d)
	for room, want := range map[int]string{
		0:         "````diff\n````\n",
		25:        "````diff\n@@ -0,0 +3 @@\n````\n",
		len(text): "````diff\n@@ -0,0 +3 @@\n+one\n+two\n+```\n````\n",
	} {
		if got := clipDiff(text, room); got != want {
			t.Errorf("room %d: %q, want %q", room, got, want)
		}
	}
	if got := clipDiff("(binary)\n", 1); got != "(binary)\n" {
		t.Errorf("note: %q", got)
	}
}

// The pane a command runs in is named only when its backend's variables
// match the snapshot of the server reached.
func TestSelfPaneID(t *testing.T) {
	agent := &AgentInfo{Name: "claude", Status: "working"}
	herdr := Snapshot{Backend: "herdr", Groups: []Group{{ID: "w1", Tabs: []Tab{{ID: "w1:t1", Panes: []Pane{{ID: "w1:p1", Agent: agent}, {ID: "w1:p2"}}}}}}}
	zg := zellijGroupID("main")
	zellij := Snapshot{Backend: "zellij", Groups: []Group{{ID: zg, Name: "main", Tabs: []Tab{{ID: zg + ":t0", Panes: []Pane{{ID: zellijPaneID("main", 3), Agent: agent}}}}}}}
	tmux := Snapshot{Backend: "tmux", Groups: []Group{{ID: "termote", Name: "termote", Tabs: []Tab{{ID: "termote:1", Key: "@4", Panes: []Pane{{ID: "%7", Agent: agent}}}}}}}
	for _, tc := range []struct {
		name string
		goos string
		snap Snapshot
		env  map[string]string
		tmux string // what tmux display-message prints, "" for a failure
		want string
	}{
		{"herdr", "linux", herdr, map[string]string{"HERDR_WORKSPACE_ID": "w1", "HERDR_TAB_ID": "w1:t1", "HERDR_PANE_ID": "w1:p1"}, "", "w1:p1"},
		{"herdr, another tab", "linux", herdr, map[string]string{"HERDR_WORKSPACE_ID": "w1", "HERDR_TAB_ID": "w1:t9", "HERDR_PANE_ID": "w1:p1"}, "", ""},
		{"herdr, no tab", "linux", herdr, map[string]string{"HERDR_WORKSPACE_ID": "w1", "HERDR_PANE_ID": "w1:p1"}, "", ""},
		{"herdr variables, tmux server", "linux", tmux, map[string]string{"HERDR_WORKSPACE_ID": "w1", "HERDR_TAB_ID": "w1:t1", "HERDR_PANE_ID": "w1:p1"}, "", ""},
		{"zellij", "linux", zellij, map[string]string{"ZELLIJ_SESSION_NAME": "main", "ZELLIJ_PANE_ID": "3"}, "", zellijPaneID("main", 3)},
		{"zellij, another session", "linux", zellij, map[string]string{"ZELLIJ_SESSION_NAME": "other", "ZELLIJ_PANE_ID": "3"}, "", ""},
		{"zellij, no number", "linux", zellij, map[string]string{"ZELLIJ_SESSION_NAME": "main", "ZELLIJ_PANE_ID": "x"}, "", ""},
		{"tmux", "linux", tmux, map[string]string{"TMUX": "/tmp/tmux-1000/default,1,0", "TMUX_PANE": "%7"}, "@4\ttermote\n", "%7"},
		{"tmux, another server's window", "linux", tmux, map[string]string{"TMUX": "/tmp/other,1,0", "TMUX_PANE": "%7"}, "@1\twork\n", ""},
		{"tmux, another session name", "linux", tmux, map[string]string{"TMUX": "/tmp/other,1,0", "TMUX_PANE": "%7"}, "@4\twork\n", ""},
		{"tmux does not answer", "linux", tmux, map[string]string{"TMUX": "/tmp/tmux-1000/default,1,0", "TMUX_PANE": "%7"}, "", ""},
		{"tmux, an answer of another shape", "linux", tmux, map[string]string{"TMUX": "/tmp/tmux-1000/default,1,0", "TMUX_PANE": "%7"}, "@4\n", ""},
		{"tmux, no TMUX", "linux", tmux, map[string]string{"TMUX_PANE": "%7"}, "@4\ttermote\n", ""},
		{"tmux, a pane not in the snapshot", "linux", tmux, map[string]string{"TMUX": "/tmp/tmux-1000/default,1,0", "TMUX_PANE": "%8"}, "@4\ttermote\n", ""},
		{"psmux", "windows", tmux, map[string]string{"TMUX": "x", "TMUX_PANE": "%7"}, "@4\ttermote\n", ""},
		{"herdr-core", "linux", Snapshot{Backend: "hc"}, map[string]string{"HERDR_PANE_ID": "w1:p1"}, "", ""},
	} {
		c := newTestCLI(t, tc.goos)
		maps.Copy(c.env, tc.env)
		if tc.tmux != "" {
			c.runner.outputs["tmux display-message -p -t "+tc.env["TMUX_PANE"]+" #{window_id}\t#{session_name}"] = tc.tmux
		}
		if got := c.selfPaneID(tc.snap); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}
