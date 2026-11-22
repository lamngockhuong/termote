//go:build !windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// scripted serves the local socket for a port with an answer per route
// ("GET /api/mux/snapshot"); a route without one answers 404 not found.
type scripted struct {
	mu     sync.Mutex
	routes map[string]http.HandlerFunc
	posts  []string // bodies of the POSTs, in order
}

func (s *scripted) set(route string, h http.HandlerFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.routes[route] = h
}

func answer(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}
}

func jsonAnswer(v any) http.HandlerFunc {
	b, _ := json.Marshal(v)
	return answer(http.StatusOK, string(b))
}

// hangUp reads the request and drops the connection unanswered.
func hangUp(w http.ResponseWriter, r *http.Request) {
	conn, _, _ := http.NewResponseController(w).Hijack()
	conn.Close()
}

// shortBody promises more than it sends, so reading the body fails.
func shortBody(w http.ResponseWriter, r *http.Request) {
	conn, buf, _ := http.NewResponseController(w).Hijack()
	buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"x\"")
	buf.Flush()
	conn.Close()
}

var scriptedPort = 7400

func scriptedCLI(t *testing.T) (*testCLI, *scripted) {
	t.Helper()
	tc, dir := socketCLI(t)
	scriptedPort++
	port := scriptedPort
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	s := &scripted{routes: map[string]http.HandlerFunc{}}
	ln, cleanup, err := openLocalSocket(dir, strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var b strings.Builder
			bufio.NewReader(r.Body).WriteTo(&b)
			s.mu.Lock()
			s.posts = append(s.posts, r.URL.Path+" "+b.String())
			s.mu.Unlock()
		}
		s.mu.Lock()
		h := s.routes[r.Method+" "+r.URL.Path]
		s.mu.Unlock()
		if h == nil {
			h = answer(http.StatusNotFound, `{"error":"not found"}`)
		}
		h(w, r)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close(); cleanup() })
	return tc, s
}

// oneAgent: pane %1 named api runs Claude Code, %2 a shell, in workspace w.
func oneAgent(status string) Snapshot {
	return Snapshot{Backend: "tmux", Caps: Caps{AgentStart: true}, Groups: []Group{{ID: "w", Name: "w", Tabs: []Tab{
		{ID: "w:0", Name: "api", Panes: []Pane{{ID: "%1", Agent: &AgentInfo{Name: "claude", Status: status}}}},
		{ID: "w:1", Name: "sh", Panes: []Pane{{ID: "%2"}}},
	}}}}
}

const okTranscript = `{"agent":"claude","cursor":"c1","entries":[]}`

func TestAgentsCallFailures(t *testing.T) {
	tc, s := scriptedCLI(t)
	port := scriptedPort
	if _, err := tc.agentsCall(port, http.MethodPost, "/x", map[string]any{"c": make(chan int)}, time.Second); err == nil {
		t.Error("a body that is not JSON was sent")
	}
	s.set("POST /x", hangUp)
	if _, err := tc.agentsCall(port, http.MethodPost, "/x", map[string]string{}, time.Second); err == nil || !strings.Contains(err.Error(), "may have been made") {
		t.Errorf("hang up: %v", err)
	}
	s.set("GET /y", shortBody)
	if _, err := tc.agentsCall(port, http.MethodGet, "/y", nil, time.Second); err == nil || !strings.Contains(err.Error(), "reading the server's answer") {
		t.Errorf("short body: %v", err)
	}
	s.set("GET /api/mux/snapshot", answer(http.StatusOK, "nope"))
	if err := tc.dispatch("agents", []string{"list"}); err == nil || !strings.Contains(err.Error(), "unexpected answer") {
		t.Errorf("bad JSON: %v", err)
	}
}

func TestAgentsListScripted(t *testing.T) {
	tc, s := scriptedCLI(t)
	snap := oneAgent("working")
	snap.Groups[0].Tabs[0].Panes[0].Name = "lead"
	s.set("GET /api/mux/snapshot", jsonAnswer(snap))
	pct := 42.0
	s.set("GET /api/mux/overview", jsonAnswer(overviewResponse{Panes: []overviewPane{{PaneID: "%1", Usage: &overviewUsage{ContextPercent: &pct}}}}))
	if err := tc.dispatch("agents", []string{"list", "--json"}); err != nil {
		t.Fatal(err)
	}
	var l agentsListing
	json.Unmarshal(tc.stdout.Bytes(), &l)
	if len(l.Agents) != 1 || l.Agents[0].Name != "lead" || l.Agents[0].ContextPercent == nil || *l.Agents[0].ContextPercent != 42 {
		t.Errorf("listing %+v", l)
	}
	// The overview failing leaves the list whole; no agent at all.
	s.set("GET /api/mux/overview", answer(http.StatusInternalServerError, `{"error":"internal error"}`))
	s.set("GET /api/mux/snapshot", jsonAnswer(Snapshot{Groups: []Group{{ID: "w", Name: "w"}}}))
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"list"}); err != nil || !strings.Contains(tc.stdout.String(), "No agent runs in any pane.") {
		t.Errorf("no agent: %v %s", err, tc.stdout)
	}
}

func TestAgentsFlagErrors(t *testing.T) {
	tc, _ := scriptedCLI(t)
	for _, args := range [][]string{{"read", "%1", "--nope"}, {"wait", "%1", "--nope"}, {"answer", "%1", "--nope"}, {"start", "--nope"}} {
		if err := tc.dispatch("agents", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
	for _, args := range [][]string{{"install", "--nope"}, {"status", "--nope"}} {
		if err := tc.dispatch("skills", args); exitCode(err) != 2 {
			t.Errorf("skills %v: %v", args, err)
		}
	}
}

func TestAgentsReadScripted(t *testing.T) {
	tc, s := scriptedCLI(t)
	s.set("GET /api/mux/snapshot", jsonAnswer(oneAgent("idle")))
	if err := tc.dispatch("agents", []string{"read", "%1"}); err == nil || !strings.Contains(err.Error(), "update it") {
		t.Errorf("no transcript route: %v", err)
	}
	s.set("GET /api/mux/panes/%1/agent/transcript", answer(http.StatusOK,
		`{"agent":"claude","entries":[{"role":"user","ts":"2026-11-22T09:00:00Z","parts":[{"kind":"text","text":"hi"}]}]}`))
	if err := tc.dispatch("agents", []string{"read", "api"}); err != nil || !strings.Contains(tc.stdout.String(), "## user (2026-11-22T09:00:00Z)") {
		t.Errorf("ts: %v %s", err, tc.stdout)
	}
}

func TestAgentsSendScripted(t *testing.T) {
	tc, s := scriptedCLI(t)
	tc.cli.in = bufio.NewReader(failingReader{r: strings.NewReader("")})
	if err := tc.dispatch("agents", []string{"send", "%1", "-"}); err == nil || !strings.Contains(err.Error(), "reading the message") {
		t.Errorf("read error: %v", err)
	}
	tc.cli.in = bufio.NewReader(strings.NewReader(strings.Repeat("x", agentMessageBody+10)))
	if err := tc.dispatch("agents", []string{"send", "%1", "-"}); err == nil || !strings.Contains(err.Error(), "longer than") {
		t.Errorf("too long: %v", err)
	}
	if err := tc.dispatch("agents", []string{"send", "%1", "hi"}); err == nil || !strings.Contains(err.Error(), "update it") {
		t.Errorf("no snapshot: %v", err)
	}
	s.set("GET /api/mux/snapshot", jsonAnswer(oneAgent("idle")))
	if err := tc.dispatch("agents", []string{"send", "%1", "hi"}); err == nil {
		t.Error("send without a transcript route")
	}
	// session_changed once: read again and sent.
	s.set("GET /api/mux/panes/%1/agent/transcript", answer(http.StatusOK, okTranscript))
	n := 0
	s.set("POST /api/mux/panes/%1/agent/message", func(w http.ResponseWriter, r *http.Request) {
		n++
		if n == 1 {
			answer(http.StatusConflict, `{"error":"the pane runs another session now","code":"session_changed"}`)(w, r)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := tc.dispatch("agents", []string{"send", "%1", "hi"}); err != nil || n != 2 {
		t.Errorf("session changed: %v after %d posts", err, n)
	}
	// No answer to the message: never sent again.
	s.set("POST /api/mux/panes/%1/agent/message", hangUp)
	if err := tc.dispatch("agents", []string{"send", "%1", "hi"}); err == nil || !strings.Contains(err.Error(), "may have been made") {
		t.Errorf("hang up: %v", err)
	}
	// Twice: refused.
	s.set("POST /api/mux/panes/%1/agent/message", answer(http.StatusConflict, `{"error":"the pane runs another session now","code":"session_changed"}`))
	if err := tc.dispatch("agents", []string{"send", "%1", "hi"}); err == nil || !strings.Contains(err.Error(), "(session_changed)") {
		t.Errorf("changed twice: %v", err)
	}
}

func TestAgentsWaitScripted(t *testing.T) {
	shortWait(t)
	tc, s := scriptedCLI(t)
	s.set("GET /api/mux/snapshot", jsonAnswer(oneAgent("working")))
	n := 0
	s.set("GET /api/mux/snapshot", func(w http.ResponseWriter, r *http.Request) {
		n++
		if n == 1 {
			jsonAnswer(oneAgent("working"))(w, r)
			return
		}
		answer(http.StatusInternalServerError, `{"error":"internal error"}`)(w, r)
	})
	if err := tc.dispatch("agents", []string{"wait", "%1"}); err == nil || !strings.Contains(err.Error(), "internal error") {
		t.Errorf("snapshot fails: %v", err)
	}
	// The pane leaves the snapshot.
	n = 0
	s.set("GET /api/mux/snapshot", func(w http.ResponseWriter, r *http.Request) {
		n++
		if n == 1 {
			jsonAnswer(oneAgent("working"))(w, r)
			return
		}
		jsonAnswer(Snapshot{})(w, r)
	})
	if err := tc.dispatch("agents", []string{"wait", "%1"}); exitCode(err) != agentsExitGone {
		t.Errorf("pane gone: %v", err)
	}
}

func TestAgentsAnswerScripted(t *testing.T) {
	tc, s := scriptedCLI(t)
	if err := tc.dispatch("agents", []string{"answer", "%1", "--text", "x"}); err == nil {
		t.Error("answered without a server")
	}
	s.set("GET /api/mux/snapshot", jsonAnswer(oneAgent("blocked")))
	if err := tc.dispatch("agents", []string{"answer", "%1"}); err == nil || !strings.Contains(err.Error(), "update it") {
		t.Errorf("no prompt route: %v", err)
	}
	multi := AgentPrompt{PromptID: "p1", Kind: "multiselect", Title: "Pick", Body: "Which?",
		Options:  []PromptOption{{Index: 1, Label: "Milk", Checked: true, Detail: "warm"}, {Index: 2, Label: "Sugar"}},
		FreeText: &PromptFreeText{Index: 3, Label: "Type something"}}
	s.set("GET /api/mux/panes/%1/agent/prompt", jsonAnswer(promptResponse{Prompt: &multi}))
	if err := tc.dispatch("agents", []string{"answer", "%1"}); err != nil {
		t.Fatal(err)
	}
	out := tc.stdout.String()
	for _, want := range []string{"Dialog (multiselect): Pick", "Which?", "1. Milk [x] - warm", "3. Type something (answer with --text)", "| next | --text <answer>"} {
		if !strings.Contains(out, want) {
			t.Errorf("dialog misses %q:\n%s", want, out)
		}
	}
	// The answers sent: text, cancel, next.
	s.set("POST /api/mux/panes/%1/agent/answer", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	for _, args := range [][]string{{"--text", "oat milk"}, {"cancel"}, {"next"}} {
		if err := tc.dispatch("agents", append([]string{"answer", "%1"}, args...)); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
	for i, want := range []string{`"choice":{"text":"oat milk"}`, `"choice":"cancel"`, `"choice":"next"`} {
		if i >= len(s.posts) || !strings.Contains(s.posts[i], want) || !strings.Contains(s.posts[i], `"promptId":"p1"`) {
			t.Errorf("post %d = %v, want %s", i, s.posts, want)
		}
	}
	// The dialog changed meanwhile: the new one is shown.
	changed, _ := json.Marshal(map[string]any{"error": "the screen changed", "code": "prompt_changed", "prompt": AgentPrompt{Kind: "permission", Title: "Edit file", PromptID: "p2", Options: []PromptOption{{Index: 1, Label: "Yes"}}}})
	s.set("POST /api/mux/panes/%1/agent/answer", answer(http.StatusConflict, string(changed)))
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"answer", "%1", "1"}); err == nil || !strings.Contains(tc.stdout.String(), "The dialog changed; it now reads:") || !strings.Contains(tc.stdout.String(), "Edit file") {
		t.Errorf("changed: %v %s", err, tc.stdout)
	}
	s.set("POST /api/mux/panes/%1/agent/answer", hangUp)
	if err := tc.dispatch("agents", []string{"answer", "%1", "1"}); err == nil || !strings.Contains(err.Error(), "may have been made") {
		t.Errorf("hang up: %v", err)
	}
	// A dialog termote cannot answer.
	s.set("GET /api/mux/panes/%1/agent/prompt", jsonAnswer(promptResponse{Prompt: &AgentPrompt{Kind: "unsupported", Title: "Trust this folder?"}}))
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"answer", "%1", "1"}); err == nil || !strings.Contains(err.Error(), "ask the user to answer it in the terminal") ||
		!strings.Contains(tc.stdout.String(), "the user answers it in the terminal") {
		t.Errorf("unsupported: %v %s", err, tc.stdout)
	}
}

func TestAgentsStartScripted(t *testing.T) {
	every := agentsStartEvery
	agentsStartEvery = 5 * time.Millisecond
	t.Cleanup(func() { agentsStartEvery = every })
	tc, s := scriptedCLI(t)
	start := func(args ...string) error {
		tc.stdout.Reset()
		return tc.dispatch("agents", append([]string{"start", "--workspace", "w", "--kind", "claude"}, args...))
	}
	tc.cli.in = bufio.NewReader(failingReader{r: strings.NewReader("")})
	if err := start("-"); err == nil || !strings.Contains(err.Error(), "reading the message") {
		t.Errorf("stdin: %v", err)
	}
	if err := start(strings.Repeat("x", agentMaxText+1)); err == nil || !strings.Contains(err.Error(), "longer than 16 KB") {
		t.Errorf("long prompt: %v", err)
	}
	if err := start(); err == nil || !strings.Contains(err.Error(), "update it") {
		t.Errorf("no snapshot: %v", err)
	}
	snap := oneAgent("idle")
	snap.Caps.AgentStart = false
	s.set("GET /api/mux/snapshot", jsonAnswer(snap))
	if err := start(); err == nil || !strings.Contains(err.Error(), "backend of this server cannot start agents") {
		t.Errorf("no agent start: %v", err)
	}
	s.set("GET /api/mux/snapshot", jsonAnswer(oneAgent("idle")))
	if err := start(); err == nil || !strings.Contains(err.Error(), "update it") {
		t.Errorf("tabs refused: %v", err)
	}
	s.set("POST /api/mux/tabs", hangUp)
	if err := start(); err == nil || !strings.Contains(err.Error(), "may have been made") {
		t.Errorf("tabs hang up: %v", err)
	}
	s.set("POST /api/mux/tabs", answer(http.StatusOK, `{"ok":true}`))
	if err := start(); err == nil || !strings.Contains(err.Error(), "unexpected answer from the server to the new tab") {
		t.Errorf("no tab id: %v", err)
	}
	// The new tab: w:1 with pane %2. A snapshot failing right after it.
	s.set("POST /api/mux/tabs", answer(http.StatusOK, `{"ok":true,"id":"w:1"}`))
	n := 0
	s.set("GET /api/mux/snapshot", func(w http.ResponseWriter, r *http.Request) {
		n++
		if n%2 == 0 {
			answer(http.StatusInternalServerError, `{"error":"internal error"}`)(w, r)
			return
		}
		jsonAnswer(oneAgent("idle"))(w, r)
	})
	if err := start(); err == nil || !strings.Contains(err.Error(), "internal error") {
		t.Errorf("second snapshot: %v", err)
	}
	s.set("GET /api/mux/snapshot", jsonAnswer(oneAgent("idle")))
	s.set("POST /api/mux/tabs", answer(http.StatusOK, `{"ok":true,"id":"w:9"}`))
	if err := start(); err == nil || !strings.Contains(err.Error(), "the new tab w:9 is not in the snapshot") {
		t.Errorf("tab missing: %v", err)
	}
	s.set("POST /api/mux/tabs", answer(http.StatusOK, `{"ok":true,"id":"w:1"}`))
	if err := start(); err == nil || !strings.Contains(err.Error(), "update it") {
		t.Errorf("start refused: %v", err)
	}
	s.set("POST /api/mux/panes/%2/agent/start", hangUp)
	if err := start(); err == nil || !strings.Contains(err.Error(), "may have been made") {
		t.Errorf("start hang up: %v", err)
	}
	s.set("POST /api/mux/panes/%2/agent/start", answer(http.StatusOK, `{"ok":true,"state":"starting"}`))
	if err := start(); err == nil || !strings.Contains(err.Error(), "update it") {
		t.Errorf("start state refused: %v", err)
	}
	// Starting, then ready; no prompt.
	polls := 0
	s.set("GET /api/mux/panes/%2/agent/start", func(w http.ResponseWriter, r *http.Request) {
		polls++
		state := startStarting
		if polls > 2 {
			state = startReady
		}
		jsonAnswer(map[string]string{"kind": "claude", "state": state})(w, r)
	})
	if err := start(); err != nil || polls != 3 || !strings.Contains(tc.stdout.String(), "Started claude in pane %2 (w, in -)") {
		t.Errorf("ready: %v after %d polls %s", err, polls, tc.stdout)
	}
	// With a prompt: it goes in the start's body. A server older than the
	// command answers without prompt: true (it started the agent without
	// it); one that took it does.
	if err := start("go 'now'"); err == nil || !strings.Contains(err.Error(), "older than this command and started claude in pane %2 without the prompt") {
		t.Errorf("older server: %v", err)
	}
	if last := s.posts[len(s.posts)-1]; !strings.Contains(last, `/agent/start {"kind":"claude","prompt":"go 'now'"}`) {
		t.Errorf("start body: %s", last)
	}
	s.set("POST /api/mux/panes/%2/agent/start", answer(http.StatusOK, `{"ok":true,"state":"starting","prompt":true}`))
	if err := start("go"); err != nil || !strings.Contains(tc.stdout.String(), "Started claude in pane %2 (w, in -) with the prompt") {
		t.Errorf("with the prompt: %v %s", err, tc.stdout)
	}
	for _, p := range s.posts {
		if strings.Contains(p, "/agent/message") {
			t.Errorf("the prompt was sent as a message: %v", s.posts)
		}
	}
}

// A start that never becomes final is given up at its deadline.
func TestFollowAgentStartTimeout(t *testing.T) {
	tc, s := scriptedCLI(t)
	every := agentsStartEvery
	agentsStartEvery = time.Millisecond
	t.Cleanup(func() { agentsStartEvery = every })
	s.set("GET /api/mux/panes/%2/agent/start", jsonAnswer(map[string]string{"state": startStarting}))
	done := make(chan string)
	go func() {
		st, _ := tc.followAgentStartWithin(scriptedPort, "%2", 50*time.Millisecond)
		done <- st
	}()
	select {
	case st := <-done:
		if st != startTimeout {
			t.Errorf("state %q", st)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never gave up")
	}
	s.set("GET /api/mux/panes/%2/agent/start", answer(http.StatusNotFound, `{"error":"no agent was started in this pane","code":"no_start"}`))
	if _, err := tc.followAgentStartWithin(scriptedPort, "%2", time.Second); err == nil || !strings.Contains(err.Error(), "(no_start)") {
		t.Errorf("refused: %v", err)
	}
}

func TestSnapPaneAccessors(t *testing.T) {
	p := snapPane{tab: Tab{Name: "t"}, pane: Pane{ID: "%1", Name: "n"}}
	if p.label() != "n" || p.status() != "" || p.cwd() != "" {
		t.Errorf("%q %q %q", p.label(), p.status(), p.cwd())
	}
	if _, ok := findAgentPane(Snapshot{}, "%1"); ok {
		t.Error("found a pane in an empty snapshot")
	}
}

// startScript: workspace w with an agent in /src/w and a shell; a new tab
// w:1 opens with pane %2 in dir.
func startScript(t *testing.T, s *scripted, dir string) *[]string {
	t.Helper()
	before := oneAgent("idle")
	before.Groups[0].Tabs = before.Groups[0].Tabs[:1]
	before.Groups[0].Tabs[0].Panes[0].Process = &ProcessInfo{Name: "claude", Cwd: "/src/w"}
	after := oneAgent("idle")
	after.Groups[0].Tabs[0].Panes[0].Process = &ProcessInfo{Name: "claude", Cwd: "/src/w"}
	after.Groups[0].Tabs[1].Key = "@7"
	after.Groups[0].Tabs[1].Panes[0].Process = &ProcessInfo{Name: "bash", Cwd: dir}
	var mu sync.Mutex
	opened := false
	s.set("GET /api/mux/snapshot", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		o := opened
		mu.Unlock()
		if o {
			jsonAnswer(after)(w, r)
		} else {
			jsonAnswer(before)(w, r)
		}
	})
	s.set("POST /api/mux/tabs", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		opened = true
		mu.Unlock()
		answer(http.StatusOK, `{"ok":true,"id":"w:1"}`)(w, r)
	})
	var closed []string
	s.set("DELETE /api/mux/tabs/w:1", func(w http.ResponseWriter, r *http.Request) {
		closed = append(closed, r.URL.RawQuery)
		answer(http.StatusOK, `{"ok":true}`)(w, r)
	})
	return &closed
}

func TestAgentsStartChecks(t *testing.T) {
	every := agentsStartEvery
	agentsStartEvery = time.Millisecond
	t.Cleanup(func() { agentsStartEvery = every })
	tc, s := scriptedCLI(t)
	start := func(args ...string) error {
		tc.stdout.Reset()
		return tc.dispatch("agents", append([]string{"start", "--workspace", "w"}, args...))
	}
	// The new tab opens elsewhere than the workspace's panes: closed, nothing started.
	closed := startScript(t, s, "/home/u")
	if err := start("--kind", "claude"); err == nil || !strings.Contains(err.Error(), "opens in /home/u, not in /src/w") || len(*closed) != 1 || (*closed)[0] != "key=%407" {
		t.Errorf("other dir: %v, closed %v", err, *closed)
	}
	for _, p := range s.posts {
		if strings.Contains(p, "/agent/start") {
			t.Errorf("started anyway: %v", s.posts)
		}
	}
	// In the workspace's dir: a refused start closes the tab.
	closed = startScript(t, s, "/src/w")
	s.set("POST /api/mux/panes/%2/agent/start", answer(http.StatusConflict, `{"error":"the pane is running something other than its shell","code":"pane_busy"}`))
	if err := start("--kind", "claude"); err == nil || !strings.Contains(err.Error(), "(pane_busy)") || len(*closed) != 1 {
		t.Errorf("refused: %v, closed %v", err, *closed)
	}
	// start_unknown is followed: blocked on a dialog, the tab stays.
	closed = startScript(t, s, "/src/w")
	s.set("POST /api/mux/panes/%2/agent/start", answer(http.StatusGatewayTimeout, `{"error":"the start did not answer in time","code":"start_unknown"}`))
	s.set("GET /api/mux/panes/%2/agent/start", jsonAnswer(map[string]string{"state": startBlocked}))
	if err := start("--kind", "claude"); exitCode(err) != agentsExitDialog || !strings.Contains(tc.stdout.String(), "in /src/w); it waits on a dialog") || len(*closed) != 0 {
		t.Errorf("blocked: %v %s, closed %v", err, tc.stdout, *closed)
	}
	// Its command ended: the tab is closed.
	s.set("POST /api/mux/panes/%2/agent/start", answer(http.StatusOK, `{"ok":true}`))
	s.set("GET /api/mux/panes/%2/agent/start", jsonAnswer(map[string]string{"state": startExited}))
	if err := start("--kind", "claude"); err == nil || !strings.Contains(err.Error(), "is it installed?") || len(*closed) != 1 {
		t.Errorf("exited: %v, closed %v", err, *closed)
	}
	// Timed out: the tab stays, the agent may still come.
	s.set("GET /api/mux/panes/%2/agent/start", jsonAnswer(map[string]string{"state": startTimeout}))
	if err := start("--kind", "claude"); err == nil || !strings.Contains(err.Error(), "(timeout)") || len(*closed) != 1 {
		t.Errorf("timeout: %v, closed %v", err, *closed)
	}
}

func TestAgentsWaitToleratesHiccups(t *testing.T) {
	shortWait(t)
	tc, s := scriptedCLI(t)
	n := 0
	s.set("GET /api/mux/snapshot", func(w http.ResponseWriter, r *http.Request) {
		n++
		switch {
		case n == 1:
			jsonAnswer(oneAgent("working"))(w, r)
		case n <= 4:
			answer(http.StatusInternalServerError, `{"error":"internal error"}`)(w, r)
		default:
			jsonAnswer(oneAgent("done"))(w, r)
		}
	})
	if err := tc.dispatch("agents", []string{"wait", "%1"}); err != nil || !strings.Contains(tc.stdout.String(), "is done") {
		t.Errorf("hiccups: %v %s", err, tc.stdout)
	}
}

func TestAgentsAnswerTooLarge(t *testing.T) {
	tc, s := scriptedCLI(t)
	max := agentsReadMax
	t.Cleanup(func() { agentsReadMax = max })
	agentsReadMax = 64
	s.set("GET /api/mux/snapshot", answer(http.StatusOK, strings.Repeat(" ", 100)+"{}"))
	if err := tc.dispatch("agents", []string{"list"}); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Errorf("too large: %v", err)
	}
}

// A shell pane beside an agent in its tab does not make the tab's name
// ambiguous.
func TestResolvePrefersAgents(t *testing.T) {
	s := Snapshot{Groups: []Group{{ID: "w", Name: "w", Tabs: []Tab{{ID: "w:0", Name: "api", Panes: []Pane{
		{ID: "%1", Agent: &AgentInfo{Name: "claude"}}, {ID: "%2"}}}}}}}
	if p, err := resolvePane(s, "api"); err != nil || p.pane.ID != "%1" {
		t.Errorf("api: %v %v", p.pane.ID, err)
	}
	s.Groups[0].Tabs[0].Panes[0].Agent = nil
	if _, err := resolvePane(s, "api"); err == nil || !strings.Contains(err.Error(), "2 panes") {
		t.Errorf("no agent: %v", err)
	}
}
