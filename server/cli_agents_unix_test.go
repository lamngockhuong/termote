//go:build !windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// agentsFake is a backend with agents in its panes: fakeWriter's screen and
// session for every pane, a snapshot the test changes, and starts.
type agentsFake struct {
	*fakeWriter
	snapMu  sync.Mutex
	snapNow Snapshot
	tabs    []string // NewTab calls
	starts  []string // StartAgent calls, as pane/kind
	state   string   // what AgentStartState reports
}

func (f *agentsFake) Caps() Caps   { return Caps{AgentStart: true, Files: true} }
func (f *agentsFake) Name() string { return "tmux" }

func (f *agentsFake) Snapshot(context.Context) (Snapshot, error) {
	f.snapMu.Lock()
	defer f.snapMu.Unlock()
	b, _ := json.Marshal(f.snapNow)
	var s Snapshot
	json.Unmarshal(b, &s)
	return s, nil
}

func (f *agentsFake) setStatus(pane, status string) {
	f.snapMu.Lock()
	defer f.snapMu.Unlock()
	for gi := range f.snapNow.Groups {
		for ti := range f.snapNow.Groups[gi].Tabs {
			for pi := range f.snapNow.Groups[gi].Tabs[ti].Panes {
				p := &f.snapNow.Groups[gi].Tabs[ti].Panes[pi]
				if p.ID != pane {
					continue
				}
				if status == "" {
					p.Agent = nil
				} else {
					p.Agent = &AgentInfo{Name: "claude", Status: status}
				}
			}
		}
	}
}

func (f *agentsFake) NewTab(_ context.Context, group, name string) (string, error) {
	f.snapMu.Lock()
	defer f.snapMu.Unlock()
	f.tabs = append(f.tabs, group+"/"+name)
	for gi := range f.snapNow.Groups {
		g := &f.snapNow.Groups[gi]
		if g.ID == group {
			id := "t" + strconv.Itoa(len(g.Tabs))
			g.Tabs = append(g.Tabs, Tab{ID: id, Name: name, Panes: []Pane{{ID: "%" + id}}})
			return id, nil
		}
	}
	return "", inputError("unknown group")
}

func (f *agentsFake) requirePane(_ context.Context, id string) (Size, error) {
	if _, ok := findAgentPane(f.snapNow, id); !ok {
		return Size{}, errStartNotFound
	}
	return Size{Cols: 80, Rows: 24}, nil
}

func (f *agentsFake) StartAgent(_ context.Context, paneID, kind string, _ []string) (string, error) {
	f.starts = append(f.starts, paneID+"/"+kind)
	f.setStatus(paneID, "idle")
	return "termote-" + kind + "-1", nil
}

func (f *agentsFake) AgentStartState(context.Context, string, string, string, time.Duration) (string, error) {
	return f.state, nil
}

// twoAgentSnapshot: two workspaces, the name "api" in both, one shell pane.
func twoAgentSnapshot() Snapshot {
	claude := func(status string) *AgentInfo { return &AgentInfo{Name: "claude", Status: status} }
	return Snapshot{Groups: []Group{
		{ID: "$1", Name: "web", Tabs: []Tab{
			{ID: "$1:0", Name: "api", Panes: []Pane{{ID: "%1", Agent: claude("idle"), Process: &ProcessInfo{Name: "claude", Cwd: "/src/web"}}}},
			{ID: "$1:1", Name: "ui", Panes: []Pane{{ID: "%2", Agent: claude("working"), Process: &ProcessInfo{Name: "claude", Cwd: "/src/web"}}}},
		}},
		{ID: "$2", Name: "orchestrator", Tabs: []Tab{
			{ID: "$2:0", Name: "api", Panes: []Pane{{ID: "%3", Agent: claude("done")}}},
			{ID: "$2:1", Name: "shell", Panes: []Pane{{ID: "%4", Process: &ProcessInfo{Name: "zsh", Cwd: "/src/a"}}}},
			{ID: "$2:2", Name: "other", Panes: []Pane{{ID: "%5", Process: &ProcessInfo{Name: "zsh", Cwd: "/src/b"}}}},
		}},
	}}
}

// startAgentsServer runs the real server over m on a free port, its local
// socket in dir, and saves that port for tc.
func startAgentsServer(t *testing.T, tc *testCLI, dir string, m Mux) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	cfg := testConfig(t)
	cfg.LocalSocketDir = dir
	h, hub, _, _, err := buildServerWith(cfg, m)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h, ConnContext: localSocketConnContext}
	go srv.Serve(ln)
	cleanup := serveLocalSocket(srv, cfg, ln)
	t.Cleanup(func() { srv.Close(); cleanup(); hub.shutdown(context.Background()) })
	sock := filepath.Join(dir, strconv.Itoa(port)+".sock")
	for deadline := time.Now().Add(5 * time.Second); ; {
		if _, err := os.Lstat(sock); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no local socket")
		}
		time.Sleep(10 * time.Millisecond)
	}
	tc.saveConfig(savedConfig{Port: port, Password: cfg.Pass})
}

// newAgentsFake is an agentsFake whose agent writes the transcript in a
// temporary Claude dir.
func newAgentsFake(t *testing.T, transcript string) *agentsFake {
	t.Helper()
	dir := t.TempDir()
	if transcript != "" {
		writeTranscript(t, dir, testSessionID, transcript)
	}
	w := newFakeWriter()
	w.session.ClaudeDir = dir
	return &agentsFake{fakeWriter: w, snapNow: twoAgentSnapshot(), state: startReady}
}

func agentsTest(t *testing.T, transcript string) (*testCLI, *agentsFake) {
	t.Helper()
	shortConfirm(t)
	tc, dir := socketCLI(t)
	f := newAgentsFake(t, transcript)
	startAgentsServer(t, tc, dir, f)
	return tc, f
}

func userLine(text string) string {
	b, _ := json.Marshal(map[string]any{"type": "user", "uuid": "user-1",
		"message": map[string]any{"role": "user", "content": text}})
	return string(b) + "\n"
}

func TestAgentsListOverLocalSocket(t *testing.T) {
	tc, _ := agentsTest(t, lines(0, 1))
	if err := tc.dispatch("agents", []string{"list", "--json"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	var l agentsListing
	if err := json.Unmarshal(tc.stdout.Bytes(), &l); err != nil {
		t.Fatalf("%v: %s", err, tc.stdout)
	}
	if l.Backend != "tmux" || !l.AgentStart || len(l.Agents) != 3 || len(l.Workspaces) != 2 {
		t.Fatalf("listing %+v", l)
	}
	a := l.Agents[1]
	if a.Pane != "%2" || a.Name != "ui" || a.Workspace != "web" || a.Status != "working" || a.Cwd != "/src/web" {
		t.Errorf("agent %+v", a)
	}
	if l.Workspaces[0].Cwd != "/src/web" || l.Workspaces[1].Cwd != "" {
		t.Errorf("workspaces %+v", l.Workspaces)
	}

	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"list"}); err != nil {
		t.Fatal(err)
	}
	out := tc.stdout.String()
	for _, want := range []string{"PANE", "web/ui", "working", "orchestrator/api", "Workspaces:", "$2"} {
		if !strings.Contains(out, want) {
			t.Errorf("list misses %q:\n%s", want, out)
		}
	}
}

func TestAgentsServerNotRunning(t *testing.T) {
	tc, _ := socketCLI(t)
	tc.saveConfig(savedConfig{Port: 7998, Password: "secret"})
	for _, args := range [][]string{{"list"}, {"read", "%1"}, {"send", "%1", "hi"}, {"wait", "%1"}, {"answer", "%1"}, {"start", "--workspace", "w", "--kind", "claude"}} {
		if err := tc.dispatch("agents", args); err == nil || !strings.Contains(err.Error(), "not running on port 7998") {
			t.Errorf("%v: err = %v", args, err)
		}
	}
}

func TestAgentsPaneNames(t *testing.T) {
	tc, _ := agentsTest(t, lines(0, 1))
	err := tc.dispatch("agents", []string{"read", "api"})
	if err == nil || !strings.Contains(err.Error(), "2 panes are named \"api\"") || !strings.Contains(err.Error(), "web/api (id %1)") {
		t.Errorf("duplicate name: %v", err)
	}
	if err := tc.dispatch("agents", []string{"read", "nope"}); err == nil || !strings.Contains(err.Error(), "no pane is named") {
		t.Errorf("unknown: %v", err)
	}
	if err := tc.dispatch("agents", []string{"send", "shell", "hi"}); err == nil || !strings.Contains(err.Error(), "runs no agent") {
		t.Errorf("shell pane: %v", err)
	}
	if err := tc.dispatch("agents", []string{"read", "web/api"}); err != nil {
		t.Errorf("workspace/name: %v", err)
	}
	if err := tc.dispatch("agents", []string{"read", "ui"}); err != nil {
		t.Errorf("unique name: %v", err)
	}
}

func TestAgentsRead(t *testing.T) {
	tc, _ := agentsTest(t, lines(0, 2)+userLine("fix the bug")+line(9, "done, fixed"))
	if err := tc.dispatch("agents", []string{"read", "%1"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	out := tc.stdout.String()
	if !strings.Contains(out, "## user") || !strings.Contains(out, "fix the bug") || !strings.Contains(out, "done, fixed") ||
		strings.Contains(out, "message 0") || !strings.Contains(out, "[status: idle]") {
		t.Errorf("read:\n%s", out)
	}
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"read", "%1", "--all", "--json"}); err != nil {
		t.Fatal(err)
	}
	var r struct {
		Pane    string            `json:"pane"`
		Entries []TranscriptEntry `json:"entries"`
	}
	if err := json.Unmarshal(tc.stdout.Bytes(), &r); err != nil || r.Pane != "%1" || len(r.Entries) != 4 {
		t.Errorf("read --all --json: %v %+v", err, r)
	}
}

func TestAgentsReadEmpty(t *testing.T) {
	tc, _ := agentsTest(t, "")
	if err := tc.dispatch("agents", []string{"read", "%1"}); err != nil || !strings.Contains(tc.stdout.String(), "has no messages yet") {
		t.Errorf("%v %s", err, tc.stdout)
	}
}

func TestAgentsSend(t *testing.T) {
	tc, f := agentsTest(t, lines(0, 1))
	if err := tc.dispatch("agents", []string{"send", "ui", "hello\x1b[2J there"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	if len(f.pasted) != 1 || f.pasted[0] != "hello[2J there" || !strings.Contains(tc.stdout.String(), "Sent to web/ui (%2)") {
		t.Errorf("pasted %q, out %s", f.pasted, tc.stdout)
	}
	// From standard input.
	tc.cli.in = bufio.NewReader(strings.NewReader("from stdin\n"))
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"send", "%2", "-"}); err != nil || f.pasted[len(f.pasted)-1] != "from stdin" {
		t.Errorf("stdin: %v %q", err, f.pasted)
	}
}

func TestAgentsSendQueued(t *testing.T) {
	tc, f := agentsTest(t, lines(0, 1))
	f.session.Status = "working"
	f.setScreen(fixtureScreen(t, "2.1.310-working"))
	if err := tc.dispatch("agents", []string{"send", "%2", "next task"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	if !strings.Contains(tc.stdout.String(), "Queued for web/ui (%2)") {
		t.Errorf("out %s", tc.stdout)
	}
}

func TestAgentsSendRefused(t *testing.T) {
	tc, f := agentsTest(t, lines(0, 1))
	f.setScreen(boxScreen("half typed"))
	err := tc.dispatch("agents", []string{"send", "%2", "hi"})
	if err == nil || !strings.Contains(err.Error(), "(input_has_draft)") || !strings.Contains(err.Error(), "ask them") {
		t.Errorf("draft: %v", err)
	}
	for _, args := range [][]string{{"send", "%2"}, {"send", "%2", "  "}} {
		var ee *exitError
		if err := tc.dispatch("agents", args); !errors.As(err, &ee) || ee.code != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
	if err := tc.dispatch("agents", []string{"send", "%2", strings.Repeat("x", agentMaxText+1)}); err == nil || !strings.Contains(err.Error(), "longer than 16 KB") {
		t.Errorf("too long: %v", err)
	}
}

func shortWait(t *testing.T) {
	every, grace := agentsWaitEvery, agentsWaitGrace
	agentsWaitEvery, agentsWaitGrace = 20*time.Millisecond, 200*time.Millisecond
	t.Cleanup(func() { agentsWaitEvery, agentsWaitGrace = every, grace })
}

func TestAgentsWait(t *testing.T) {
	shortWait(t)
	tc, f := agentsTest(t, lines(0, 1))
	// Working, then done.
	go func() { time.Sleep(100 * time.Millisecond); f.setStatus("%2", "done") }()
	if err := tc.dispatch("agents", []string{"wait", "%2"}); err != nil || !strings.Contains(tc.stdout.String(), "is done") {
		t.Errorf("done: %v %s", err, tc.stdout)
	}
	// Idle and never starting: done after the grace.
	start := time.Now()
	if err := tc.dispatch("agents", []string{"wait", "%1"}); err != nil || time.Since(start) < agentsWaitGrace {
		t.Errorf("idle: %v after %v", err, time.Since(start))
	}
	// A dialog.
	f.setStatus("%2", "blocked")
	if err := tc.dispatch("agents", []string{"wait", "%2"}); exitCode(err) != agentsExitDialog || !strings.Contains(tc.stdout.String(), "agents answer %2") {
		t.Errorf("blocked: %v %s", err, tc.stdout)
	}
	// Still working at the timeout.
	f.setStatus("%2", "working")
	if err := tc.dispatch("agents", []string{"wait", "%2", "--timeout", "100ms"}); exitCode(err) != agentsExitTimeout {
		t.Errorf("timeout: %v", err)
	}
	// The agent leaves.
	go func() { time.Sleep(60 * time.Millisecond); f.setStatus("%2", "") }()
	if err := tc.dispatch("agents", []string{"wait", "%2"}); exitCode(err) != agentsExitGone {
		t.Errorf("gone: %v", err)
	}
	if err := tc.dispatch("agents", []string{"wait", "%1", "--timeout", "0s"}); exitCode(err) != 2 {
		t.Errorf("zero timeout: %v", err)
	}
}

func TestAgentsAnswer(t *testing.T) {
	tc, f := agentsTest(t, lines(0, 1))
	f.session.Status = "blocked"
	f.setScreen(fixtureScreen(t, "2.1.286-permission-bash"))
	if err := tc.dispatch("agents", []string{"answer", "%2"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	out := tc.stdout.String()
	if !strings.Contains(out, "Dialog (permission)") || !strings.Contains(out, "  1. Yes") || !strings.Contains(out, "termote agents answer %2 <number> | cancel") {
		t.Errorf("dialog:\n%s", out)
	}
	f.onKeys = func(f *fakeWriter, keys []string) { f.setScreen(boxScreen("")) }
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"answer", "%2", "1"}); err != nil || !strings.Contains(tc.stdout.String(), "Answered the dialog of web/ui") {
		t.Fatalf("answer: %v %s %s", err, tc.stdout, tc.stderr)
	}
	if last := f.keys[len(f.keys)-1]; last[0] != "1" {
		t.Errorf("keys %v", f.keys)
	}
	// Answered within the screen cache: not answerable again.
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"answer", "%2", "1"}); err == nil || !strings.Contains(err.Error(), "cannot be answered right now") {
		t.Errorf("just answered: %v", err)
	}
	// No dialog any more.
	f.mu.Lock()
	f.session.Status = "idle"
	f.mu.Unlock()
	time.Sleep(agentCacheTTL + 50*time.Millisecond)
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"answer", "%2", "1"}); exitCode(err) != 1 || !strings.Contains(tc.stdout.String(), "shows no dialog") {
		t.Errorf("no dialog: %v %s", err, tc.stdout)
	}
	if err := tc.dispatch("agents", []string{"answer", "%2"}); err != nil {
		t.Errorf("show without dialog: %v", err)
	}
	for _, args := range [][]string{{"answer"}, {"answer", "%2", "yes"}, {"answer", "%2", "1", "--text", "x"}} {
		if err := tc.dispatch("agents", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
}

func TestAgentsStart(t *testing.T) {
	tc, f := agentsTest(t, "")
	every := agentsStartEvery
	agentsStartEvery = 10 * time.Millisecond
	t.Cleanup(func() { agentsStartEvery = every })
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "claude", "--name", "worker", "write tests"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	if len(f.tabs) != 1 || f.tabs[0] != "$1/worker" || len(f.starts) != 1 || f.starts[0] != "%t2/claude" {
		t.Errorf("tabs %v starts %v", f.tabs, f.starts)
	}
	out := tc.stdout.String()
	if !strings.Contains(out, "Started claude in pane %t2 (web)") || !strings.Contains(out, "Sent the prompt to pane %t2") || f.pasted[len(f.pasted)-1] != "write tests" {
		t.Errorf("out %s, pasted %q", out, f.pasted)
	}
	// A start that does not become ready.
	f.state = startExited
	if err := tc.dispatch("agents", []string{"start", "--workspace", "$2", "--kind", "codex"}); err == nil || !strings.Contains(err.Error(), "did not start") {
		t.Errorf("exited: %v", err)
	}
	if err := tc.dispatch("agents", []string{"start", "--workspace", "none", "--kind", "claude"}); err == nil || !strings.Contains(err.Error(), "no workspace is named") {
		t.Errorf("unknown workspace: %v", err)
	}
	for _, args := range [][]string{{"start", "--kind", "claude"}, {"start", "--workspace", "web"}, {"start", "--workspace", "web", "--kind", "vim"}} {
		if err := tc.dispatch("agents", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
}
