package main

import (
	"errors"
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
	for _, want := range []string{"agents <cmd>", "Options of agents", "--workspace <id|name>", "--timeout <duration>", "--text <answer>"} {
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
	for _, args := range [][]string{{"list"}, {"read", "%1"}, {"send", "%1", "hi"}, {"wait", "%1"}, {"answer", "%1"}, {"start", "--workspace", "w", "--kind", "claude"}} {
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
