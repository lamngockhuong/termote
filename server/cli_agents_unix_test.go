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
	"slices"
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
	prompts []string // their prompts
	newTabs []bool   // their newTab
	// interrupts: C-c sent by a start through the shell path
	interrupts int
	// typed: lines typed by a start with a prompt (the shell path), as
	// pane + " " + line; promptText: the prompt files' text then.
	typed      []string
	promptText []string
	promptDir  string
	state      string // what AgentStartState reports
}

var _ agentStarter = (*agentsFake)(nil)

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

func (f *agentsFake) StartAgent(_ context.Context, paneID, kind string, _ []string, prompt string, newTab bool) (string, error) {
	f.starts = append(f.starts, paneID+"/"+kind)
	f.prompts = append(f.prompts, prompt)
	f.newTabs = append(f.newTabs, newTab)
	f.setStatus(paneID, "idle")
	return "termote-" + kind + "-1", nil
}

// A start with a prompt takes the shell path: every pane is an idle zsh,
// and a typed line is recorded with the prompt files' text.
func (f *agentsFake) NewTaskTab(context.Context, string, string, string) (taskTab, error) {
	return taskTab{}, errors.New("no task tabs")
}
func (f *agentsFake) IdleShell(context.Context, string) (string, int, bool, error) {
	return "zsh", 1, true, nil
}
func (f *agentsFake) Interrupt(context.Context, string) error {
	f.snapMu.Lock()
	defer f.snapMu.Unlock()
	f.interrupts++
	return nil
}

// ReadTaskText: a prompt that does not change, so a new tab's shell is
// ready at the second read.
func (f *agentsFake) ReadTaskText(context.Context, string, int) (string, error) { return "% ", nil }
func (f *agentsFake) TypeLine(_ context.Context, target, line string) error {
	f.snapMu.Lock()
	defer f.snapMu.Unlock()
	f.typed = append(f.typed, target+" "+line)
	entries, _ := os.ReadDir(f.promptDir)
	for _, e := range entries {
		if p := filepath.Join(f.promptDir, e.Name()); strings.Contains(line, p) {
			b, _ := os.ReadFile(p)
			f.promptText = append(f.promptText, string(b))
		}
	}
	return nil
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
		if err := tc.dispatch("agents", args); err == nil || !strings.Contains(err.Error(), "did not answer on port 7998") {
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
		Cursor  string            `json:"cursor"`
		Entries []TranscriptEntry `json:"entries"`
	}
	if err := json.Unmarshal(tc.stdout.Bytes(), &r); err != nil || r.Pane != "%1" || len(r.Entries) != 4 || r.Cursor == "" {
		t.Errorf("read --all --json: %v %+v", err, r)
	}
}

// stop takes the cursor read gives and sends one Escape to the agent that
// works in that session.
func TestAgentsStopOverLocalSocket(t *testing.T) {
	resetInterrupts(t)
	tc, f := agentsTest(t, lines(0, 1))
	if err := tc.dispatch("agents", []string{"read", "%2", "--json"}); err != nil {
		t.Fatal(err)
	}
	var r struct {
		Cursor string `json:"cursor"`
	}
	json.Unmarshal(tc.stdout.Bytes(), &r)
	// Busy, its answer written, waiting on a background agent: no key.
	f.mu.Lock()
	f.session.Status = "working"
	f.screen = fixtureScreen(t, "2.1.330-wait-background-agent")
	f.mu.Unlock()
	if err := tc.dispatch("agents", []string{"stop", "%2", "--cursor", r.Cursor}); err == nil || !strings.Contains(err.Error(), "(agent_no_turn); its answer may be written already") || len(f.keys) != 0 {
		t.Errorf("background only: %v, keys %v", err, f.keys)
	}
	f.setScreen(fixtureScreen(t, "2.1.310-working"))
	// Esc ends the turn: the CLI sees it end.
	f.mu.Lock()
	f.onKeys = func(w *fakeWriter, _ []string) {
		w.mu.Lock()
		w.session.Status = "idle"
		w.screen = fixtureScreen(t, "2.1.312-done")
		w.mu.Unlock()
		f.setStatus("%2", "idle")
	}
	f.mu.Unlock()
	time.Sleep(agentCacheTTL) // the screen read last
	if err := tc.dispatch("agents", []string{"stop", "%2", "--cursor", r.Cursor}); err != nil ||
		!strings.Contains(tc.stdout.String(), "Stopped the turn of") {
		t.Fatalf("%v (%s)", err, tc.stdout)
	}
	if len(f.keys) != 1 || f.keys[0][0] != "Escape" {
		t.Errorf("keys %v", f.keys)
	}
	// Working again at once: a second Esc within the gap is refused.
	f.mu.Lock()
	f.onKeys = nil
	f.session.Status = "working"
	f.screen = fixtureScreen(t, "2.1.310-working")
	f.mu.Unlock()
	f.setStatus("%2", "working")
	time.Sleep(agentCacheTTL)
	if err := tc.dispatch("agents", []string{"stop", "%2", "--cursor", r.Cursor}); err == nil || !strings.Contains(err.Error(), "(interrupt_pending)") {
		t.Errorf("again: %v", err)
	}
	if err := tc.dispatch("agents", []string{"stop", "%2", "--cursor", cursorFor("00000000-0000-4000-8000-000000000999")}); err == nil ||
		!strings.Contains(err.Error(), "(session_changed)") {
		t.Errorf("another session: %v", err)
	}
	if len(f.keys) != 1 {
		t.Errorf("keys %v", f.keys)
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
	if len(f.pasted) != 1 || f.pasted[0] != "hello[2J there" || !strings.Contains(tc.stdout.String(), "Sent to web/ui (%2); wait for it: termote agents wait %2@") {
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

// waitMark is the mark of the first pane the last wait's next line names.
func waitMark(t *testing.T, out string) string {
	t.Helper()
	const next = "next: termote agents wait "
	i := strings.LastIndex(out, next)
	if i < 0 {
		t.Fatalf("no mark in %q", out)
	}
	_, mark, ok := splitWaitMark(strings.Fields(out[i+len(next):])[0])
	if !ok {
		t.Fatalf("no pane@seq in %q", out)
	}
	return strconv.FormatUint(mark, 10)
}

func TestAgentsWait(t *testing.T) {
	shortWait(t)
	tc, f := agentsTest(t, lines(0, 1))
	// Working, then done.
	go func() { time.Sleep(100 * time.Millisecond); f.setStatus("%2", "done") }()
	if err := tc.dispatch("agents", []string{"wait", "%2"}); err != nil || !strings.Contains(tc.stdout.String(), "is done") {
		t.Errorf("done: %v %s", err, tc.stdout)
	}
	// Idle and never starting: nothing to wait for, after the grace.
	start := time.Now()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "%1"}); exitCode(err) != agentsExitIdle || time.Since(start) < agentsWaitGrace ||
		!strings.Contains(tc.stdout.String(), "web/api (%1) is idle") {
		t.Errorf("idle: %v after %v: %s", err, time.Since(start), tc.stdout)
	}
	// A dialog shown before the wait ends nothing; one shown during it does.
	f.setStatus("%2", "blocked")
	if err := tc.dispatch("agents", []string{"wait", "%2"}); exitCode(err) != agentsExitIdle {
		t.Errorf("blocked before: %v", err)
	}
	f.setStatus("%2", "working")
	go func() { time.Sleep(60 * time.Millisecond); f.setStatus("%2", "blocked") }()
	if err := tc.dispatch("agents", []string{"wait", "%2"}); exitCode(err) != agentsExitDialog || !strings.Contains(tc.stdout.String(), "agents answer %2") {
		t.Errorf("blocked: %v %s", err, tc.stdout)
	}
	// Still working at the timeout.
	f.setStatus("%2", "working")
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "%2", "--timeout", "100ms"}); exitCode(err) != agentsExitTimeout ||
		!strings.Contains(tc.stdout.String(), "still working after 100ms: web/ui (%2)") {
		t.Errorf("timeout: %v %s", err, tc.stdout)
	}
	// The agent leaves.
	go func() { time.Sleep(60 * time.Millisecond); f.setStatus("%2", "") }()
	if err := tc.dispatch("agents", []string{"wait", "%2"}); exitCode(err) != agentsExitGone {
		t.Errorf("gone: %v", err)
	}
	for _, args := range [][]string{{"wait", "%1", "--timeout", "0s"}, {"wait"}, {"wait", "%1", "--after", "x"}} {
		if err := tc.dispatch("agents", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
	if err := tc.dispatch("agents", append([]string{"wait"}, slices.Repeat([]string{"%1"}, agentsWaitMost+1)...)); exitCode(err) != 2 {
		t.Errorf("too many: %v", err)
	}
	if err := tc.dispatch("agents", []string{"wait", "%1", "nope"}); err == nil || !strings.Contains(err.Error(), "no pane is named") {
		t.Errorf("unknown: %v", err)
	}
}

// A tab that moves while a wait follows its pane is still the same agent
// (tmux without pane ids: the pane's id is its window's, which a move
// renumbers), and the id printed is the one it has now.
func TestAgentsWaitTabMoved(t *testing.T) {
	shortWait(t)
	tc, f := agentsTest(t, lines(0, 1))
	claude := func(status string) *AgentInfo { return &AgentInfo{Name: "claude", Status: status} }
	f.snapMu.Lock()
	f.snapNow = Snapshot{Groups: []Group{{ID: "$1", Name: "web", Tabs: []Tab{
		{ID: "$1:0", Key: "@11", Name: "api", Panes: []Pane{{ID: "$1:0", Agent: claude("working")}}},
		{ID: "$1:1", Key: "@12", Name: "ui", Panes: []Pane{{ID: "$1:1", Agent: claude("working")}}},
	}}}}
	f.snapMu.Unlock()
	go func() {
		time.Sleep(60 * time.Millisecond)
		f.snapMu.Lock()
		g := &f.snapNow.Groups[0]
		g.Tabs[0], g.Tabs[1] = g.Tabs[1], g.Tabs[0]
		for i := range g.Tabs {
			id := "$1:" + strconv.Itoa(i)
			g.Tabs[i].ID, g.Tabs[i].Panes[0].ID = id, id
		}
		f.snapMu.Unlock()
		time.Sleep(60 * time.Millisecond)
		f.setStatus("$1:0", "done") // ui, now first
	}()
	err := tc.dispatch("agents", []string{"wait", "web/ui", "web/api"})
	out := tc.stdout.String()
	if err != nil || !strings.Contains(out, "web/ui ($1:0) is done") || strings.Contains(out, "no longer runs an agent") ||
		!strings.Contains(out, "next: termote agents wait $1:1@") {
		t.Errorf("moved: %v\n%s", err, out)
	}
}

// A turn that ended while the caller was busy elsewhere is still reported
// by a wait from the mark before it, beside the panes that still work.
func TestAgentsWaitSeveral(t *testing.T) {
	shortWait(t)
	tc, f := agentsTest(t, lines(0, 1))
	f.setStatus("%1", "idle")
	f.setStatus("%2", "idle")
	tc.dispatch("agents", []string{"wait", "%1"})
	mark := waitMark(t, tc.stdout.String())
	f.setStatus("%1", "working")
	f.setStatus("%2", "working")
	tc.dispatch("agents", []string{"list"}) // a snapshot read records the change
	f.setStatus("%2", "done")
	tc.dispatch("agents", []string{"list"})
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "%1", "web/ui", "%2", "--after", mark}); err != nil {
		t.Fatalf("%v %s", err, tc.stdout)
	}
	out := tc.stdout.String()
	if !strings.Contains(out, "web/ui (%2) is done") || strings.Contains(out, "(%1) is done") || !strings.Contains(out, "next: termote agents wait %1@"+mark+"\n") {
		t.Errorf("one done:\n%s", out)
	}
	// Both end before the wait reads: both are printed, the gravest exit
	// wins.
	port, _ := tc.agentsPort()
	f.setStatus("%1", "working")
	f.setStatus("%2", "working")
	tc.dispatch("agents", []string{"list"})
	m, err := tc.activityLatest(port)
	if err != nil {
		t.Fatal(err)
	}
	f.setStatus("%1", "blocked")
	f.setStatus("%2", "idle")
	tc.dispatch("agents", []string{"list"})
	tc.stdout.Reset()
	err = tc.dispatch("agents", []string{"wait", "%1", "%2", "--after", strconv.FormatUint(m, 10)})
	out = tc.stdout.String()
	if exitCode(err) != agentsExitDialog || !strings.Contains(out, "web/api (%1) waits on a dialog") || !strings.Contains(out, "web/ui (%2) is done") ||
		!strings.Contains(out, "next: termote agents wait %1@") || strings.Contains(out, "%2@") {
		// The pane on a dialog stays, from the latest mark; the done one goes.
		t.Errorf("both: %v\n%s", err, out)
	}
	// A mark from before a restart: the history is reset.
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "%1", "%2", "--after", "999999"}); exitCode(err) != agentsExitReset ||
		!strings.Contains(tc.stdout.String(), "history was reset") || !strings.Contains(tc.stdout.String(), "web/api (%1) waits on a dialog") {
		t.Errorf("reset: %v %s", err, tc.stdout)
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
	f.promptDir = useStartPromptDir(t, "start-prompts")
	every := agentsStartEvery
	agentsStartEvery = 10 * time.Millisecond
	t.Cleanup(func() { agentsStartEvery = every })
	// A prompt is handed to the agent at its start, through the line the
	// server types, never typed itself.
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "claude", "--name", "worker", "write 'tests'"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	if len(f.tabs) != 1 || f.tabs[0] != "$1/worker" || len(f.starts) != 0 || len(f.typed) != 1 ||
		!strings.HasPrefix(f.typed[0], `%t2 claude -- "$(command cat -- `) || strings.Contains(f.typed[0], "tests") {
		t.Errorf("tabs %v starts %v typed %q", f.tabs, f.starts, f.typed)
	}
	if !slices.Equal(f.promptText, []string{"write 'tests'"}) || len(f.pasted) != 0 {
		t.Errorf("prompt %q, pasted %q", f.promptText, f.pasted)
	}
	// The tab is new: its shell may still run its rc files, so no C-c.
	if f.interrupts != 0 {
		t.Errorf("C-c sent to the new tab %d times", f.interrupts)
	}
	if out := tc.stdout.String(); !strings.Contains(out, "Started claude in pane %t2 (web, in -) with the prompt") {
		t.Errorf("out %s", out)
	}
	// Codex and OpenCode take one too, from stdin, line breaks and all;
	// Codex is found by its process, before it has a session.
	f.mu.Lock()
	f.found = false
	f.mu.Unlock()
	setShellStartProc(t, "codex")
	tc.in = bufio.NewReader(strings.NewReader("first line\nsecond 'line' $(x)\n"))
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "codex", "-"}); err != nil {
		t.Fatalf("codex: %v (%s)", err, tc.stderr)
	}
	if last := f.typed[len(f.typed)-1]; !strings.Contains(last, ` codex '--no-daemon' -- "$(command cat -- `) ||
		f.promptText[len(f.promptText)-1] != "first line\nsecond 'line' $(x)" {
		t.Errorf("codex typed %q, prompt %q", last, f.promptText)
	}
	setShellStartProc(t, "opencode")
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "opencode", "plan it"}); err != nil {
		t.Fatalf("opencode: %v (%s)", err, tc.stderr)
	}
	if last := f.typed[len(f.typed)-1]; !strings.Contains(last, ` --prompt="$(command cat -- `) {
		t.Errorf("opencode typed %q", last)
	}
	// Without a prompt the backend's own start runs, as the PWA's does.
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "claude"}); err != nil ||
		len(f.starts) != 1 || f.prompts[0] != "" || strings.Contains(tc.stdout.String(), "with the prompt") {
		t.Errorf("no prompt: %v starts %v prompts %q %s", err, f.starts, f.prompts, tc.stdout)
	}
	if !slices.Equal(f.newTabs, []bool{true}) {
		t.Errorf("newTab %v, want the new tab told", f.newTabs)
	}
	// A start that does not become ready.
	f.state = startExited
	if err := tc.dispatch("agents", []string{"start", "--workspace", "$2", "--kind", "codex"}); err == nil || !strings.Contains(err.Error(), "did not start") {
		t.Errorf("exited: %v", err)
	}
	if err := tc.dispatch("agents", []string{"start", "--workspace", "none", "--kind", "claude"}); err == nil || !strings.Contains(err.Error(), "no workspace is named") {
		t.Errorf("unknown workspace: %v", err)
	}
	for _, args := range [][]string{{"start", "--kind", "claude"}, {"start", "--workspace", "web"}, {"start", "--workspace", "web", "--kind", "vim"},
		{"start", "--workspace", "web", "--kind", "codex", " \n "}} {
		if err := tc.dispatch("agents", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "codex", strings.Repeat("a", agentMaxText+1)}); err == nil || !strings.Contains(err.Error(), "longer than") {
		t.Errorf("long prompt: %v", err)
	}
}

// An answer without prompt: true is a server older than the command, which
// started the agent without the prompt.
func TestStartTookPrompt(t *testing.T) {
	for body, want := range map[string]bool{
		`{"ok":true,"state":"starting","prompt":true}`:  true,
		`{"ok":true,"state":"starting","prompt":false}`: false,
		`{"ok":true,"state":"starting"}`:                false,
		`not json`:                                      false,
	} {
		if got := startTookPrompt(agentsReply{status: http.StatusOK, body: []byte(body)}); got != want {
			t.Errorf("%s: %v", body, got)
		}
	}
}
