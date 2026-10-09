package main

import (
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

const startPane = "wR:p3"

var startPath = "/api/mux/panes/" + startPane + "/agent/start"

// shortStart shortens the start's waits for tests.
func shortStart(t *testing.T) {
	t.Helper()
	idle, poll, clear, call := agentStartIdleWait, agentStartIdlePoll, agentStartClearWait, agentStartCallTimeout
	agentStartIdleWait, agentStartIdlePoll, agentStartClearWait = 60*time.Millisecond, 20*time.Millisecond, 5*time.Millisecond
	agentStartCallTimeout = 300 * time.Millisecond
	// The route's behaviour, not the Windows idle check
	// (TestHerdrPaneIdleShellWindows, TestAgentStartWindowsBusyChild)
	goos := herdrStartGOOS
	herdrStartGOOS = "linux"
	t.Cleanup(func() {
		agentStartIdleWait, agentStartIdlePoll, agentStartClearWait, agentStartCallTimeout = idle, poll, clear, call
		herdrStartGOOS = goos
	})
}

// startHandler serves the real routes over a Herdr backend talking to f.
func startHandler(t *testing.T, f *fakeHerdr) (http.Handler, *herdrMux) {
	t.Helper()
	shortStart(t)
	m := newTestHerdrMux(t, f)
	return newTestHandler(t, m), m
}

// startAPI serves the routes alone (no guards in front) and returns the
// agent API, for tests that look inside it.
func startAPI(t *testing.T, f *fakeHerdr) (http.Handler, *agentAPI) {
	t.Helper()
	shortStart(t)
	mux := http.NewServeMux()
	a := registerMuxRoutes(mux, newTestHerdrMux(t, f), newStreamTokenStore(), nil, nil)
	return mux, a
}

func postStart(t *testing.T, h http.Handler, body string) (int, string, map[string]any) {
	t.Helper()
	rec := serve(h, apiRequest(http.MethodPost, startPath, body))
	out := decodeBody(t, rec)
	code, _ := out["code"].(string)
	return rec.Code, code, out
}

func getStart(t *testing.T, h http.Handler) (int, map[string]any) {
	t.Helper()
	rec := serve(h, apiRequest(http.MethodGet, startPath, ""))
	return rec.Code, decodeBody(t, rec)
}

// startCalls is the call log without what the subscription and snapshots
// make.
func startCalls(f *fakeHerdr) []string {
	var out []string
	for _, c := range f.callLog() {
		if c == "ping" || c == "session.snapshot" || c == "events.subscribe" {
			continue
		}
		out = append(out, c)
	}
	return out
}

var vimProcs = fakeProcessInfo(startPane, 100, 200, fakeProc(200, "vim", "vim", "notes.txt"))

func TestAgentStartClaude(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	status, code, body := postStart(t, h, `{"kind":"claude"}`)
	if status != http.StatusOK || body["state"] != "starting" {
		t.Fatalf("POST = %d %q %v", status, code, body)
	}
	want := []string{"pane.process_info", "agent.get", "pane.send_text \x03", "pane.process_info", "agent.start"}
	if got := startCalls(f); !slices.Equal(got, want) {
		t.Errorf("calls = %q, want %q", got, want)
	}
	p := f.lastParams(t, "agent.start")
	if p["kind"] != "claude" || p["pane_id"] != startPane || p["timeout_ms"] != float64(30000) {
		t.Errorf("agent.start params = %v", p)
	}
	if args, _ := p["args"].([]any); len(args) != 0 || p["args"] == nil {
		t.Errorf("args = %v, want []", p["args"])
	}
	if name, _ := p["name"].(string); !regexp.MustCompile(`^termote-claude-[0-9a-f]{8}$`).MatchString(name) {
		t.Errorf("name = %q", name)
	}
}

// args and name in the body are never read: the kind's table and the
// server's alias go to Herdr.
func TestAgentStartIgnoresClientArgsAndName(t *testing.T) {
	kind := "codex" // Codex has arguments of its own
	if !codexProcSupported {
		kind = "claude"
	}
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	status, _, body := postStart(t, h, `{"kind":"`+kind+`","args":["--dangerously-bypass-approvals-and-sandbox"],"name":"reviewer"}`)
	if status != http.StatusOK {
		t.Fatalf("POST = %d %v", status, body)
	}
	p := f.lastParams(t, "agent.start")
	if args, _ := p["args"].([]any); fmt.Sprint(args) != fmt.Sprint(agentStartArgs[kind]) {
		t.Errorf("args = %v, want %v", p["args"], agentStartArgs[kind])
	}
	if name, _ := p["name"].(string); !strings.HasPrefix(name, "termote-"+kind+"-") {
		t.Errorf("name = %q", name)
	}
}

func TestAgentStartInvalidKind(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	for _, body := range []string{`{"kind":"bash"}`, `{"kind":""}`, `{}`, `{"kind":"Claude"}`} {
		if status, code, _ := postStart(t, h, body); status != http.StatusBadRequest || code != "invalid_kind" {
			t.Errorf("%s: %d %q", body, status, code)
		}
	}
	if status, code, _ := postStart(t, h, `{"kind":`); status != http.StatusBadRequest || code != "invalid_request" {
		t.Errorf("bad JSON: %d %q", status, code)
	}
	if calls := startCalls(f); len(calls) != 0 {
		t.Errorf("Herdr called: %q", calls)
	}
}

func TestAgentStartBusyPane(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	f.mu.Lock()
	f.procs = map[string]any{startPane: vimProcs}
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusConflict || code != "pane_busy" {
		t.Fatalf("POST = %d %q", status, code)
	}
	calls := startCalls(f)
	if len(calls) < 2 || slices.ContainsFunc(calls, func(c string) bool { return c != "pane.process_info" }) {
		t.Errorf("calls = %q, want only retried process reads", calls)
	}
}

// On Windows a shell with a child is busy although Herdr names only the
// shell: nothing is typed, not even the C-c.
func TestAgentStartWindowsBusyChild(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	children := herdrProcChildren
	t.Cleanup(func() { herdrProcChildren = children })
	herdrStartGOOS = "windows"
	herdrProcChildren = func() (func(int) []int, error) {
		return func(pid int) []int {
			if pid == 100 {
				return []int{23240}
			}
			return nil
		}, nil
	}
	f.mu.Lock()
	f.procs = map[string]any{startPane: fakeProcessInfo(startPane, 100, 100, fakeProc(100, "pwsh.exe", "pwsh.exe"))}
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusConflict || code != "pane_busy" {
		t.Fatalf("POST = %d %q", status, code)
	}
	if calls := startCalls(f); slices.ContainsFunc(calls, func(c string) bool { return c != "pane.process_info" }) {
		t.Errorf("calls = %q, want only process reads", calls)
	}
}

// The prompt redrawn after the C-c can run git for a moment: on Windows
// that child is waited for, not taken for a busy pane.
func TestAgentStartWindowsPromptChildAfterClear(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	children := herdrProcChildren
	t.Cleanup(func() { herdrProcChildren = children })
	herdrStartGOOS = "windows"
	reads := 0
	herdrProcChildren = func() (func(int) []int, error) {
		reads++
		read := reads
		return func(pid int) []int {
			if pid == 100 && read == 2 { // the first read after the C-c
				return []int{23240}
			}
			return nil
		}, nil
	}
	f.mu.Lock()
	f.procs = map[string]any{startPane: fakeProcessInfo(startPane, 100, 100, fakeProc(100, "pwsh.exe", "pwsh.exe"))}
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
		t.Fatalf("POST = %d %q", status, code)
	}
	if f.count("agent.start") != 1 {
		t.Error("agent.start not called")
	}
}

// A shell still starting (not yet alone in its group) is waited for.
func TestAgentStartWaitsForShell(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	f.mu.Lock()
	f.procSeq = map[string][]any{startPane: {vimProcs, fakeProcessInfo(startPane, 100, 100, fakeProc(100, "zsh", "-zsh"))}}
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
		t.Fatalf("POST = %d %q", status, code)
	}
}

func TestAgentStartBusyAfterClear(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	f.mu.Lock()
	f.procSeq = map[string][]any{startPane: {fakeProcessInfo(startPane, 100, 100, fakeProc(100, "bash", "bash")), vimProcs}}
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusConflict || code != "pane_busy" {
		t.Fatalf("POST = %d %q", status, code)
	}
	if f.count("agent.start") != 0 {
		t.Error("agent.start called")
	}
}

func TestAgentStartWhileStarting(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	f.mu.Lock()
	f.agentGet = map[string]any{"agent": "claude", "agent_status": "unknown", "launch_pending": true, "interactive_ready": false}
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
		t.Fatalf("first POST = %d %q", status, code)
	}
	before := len(startCalls(f))
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusConflict || code != "starting" {
		t.Fatalf("second POST = %d %q", status, code)
	}
	if after := startCalls(f)[before:]; !slices.Equal(after, []string{"agent.get"}) {
		t.Errorf("second POST called %q, want only agent.get", after)
	}
	// Once that start is over, another one may go.
	f.mu.Lock()
	f.agentGet = map[string]any{"agent": "claude", "agent_status": "idle", "launch_pending": false, "interactive_ready": false}
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
		t.Fatalf("third POST = %d %q", status, code)
	}
}

func TestAgentStartHerdrRefusals(t *testing.T) {
	for _, c := range []struct {
		fail    []string
		message string
		status  int
		code    string
	}{
		{[]string{"agent_pane_busy"}, "", 409, "pane_busy"},
		{[]string{"agent_pane_not_found"}, "", 404, "not_found"},
		{[]string{"agent_pane_unavailable"}, "", 404, "not_found"},
		{[]string{"unsupported_agent_kind"}, "", 501, "unsupported"},
		{[]string{"invalid_request"}, "invalid request: unknown variant `agent.start`, expected one of `ping`, `server.stop`", 501, "unsupported"},
		{[]string{"invalid_request"}, "invalid request: missing field `kind`", 500, "start_failed"},
		{[]string{"agent_start_input_failed"}, "", 500, "start_failed"},
		{[]string{"agent_name_taken", "agent_name_taken"}, "", 500, "start_failed"},
	} {
		t.Run(strings.Join(c.fail, ",")+c.message, func(t *testing.T) {
			f := newFakeHerdr(t)
			h, _ := startHandler(t, f)
			f.mu.Lock()
			f.startFail, f.startMessage = c.fail, c.message
			f.mu.Unlock()
			status, code, body := postStart(t, h, `{"kind":"claude"}`)
			if status != c.status || code != c.code {
				t.Fatalf("POST = %d %q, want %d %q", status, code, c.status, c.code)
			}
			if msg, _ := body["error"].(string); strings.Contains(msg, "herdr") || strings.Contains(msg, "variant") {
				t.Errorf("error message leaks Herdr's: %q", msg)
			}
			// No start is followed after a refusal.
			if status, _ := getStart(t, h); status != http.StatusNotFound {
				t.Errorf("GET after refusal = %d", status)
			}
		})
	}
}

// A taken alias gets one more try with a new one, without a second C-c.
func TestAgentStartNameTakenRetries(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	f.mu.Lock()
	f.startFail = []string{"agent_name_taken"}
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
		t.Fatalf("POST = %d %q", status, code)
	}
	want := []string{"pane.process_info", "agent.get", "pane.send_text \x03", "pane.process_info", "agent.start", "agent.start"}
	if got := startCalls(f); !slices.Equal(got, want) {
		t.Errorf("calls = %q, want %q", got, want)
	}
	f.mu.Lock()
	first, second := string(f.params["agent.start"][0]), string(f.params["agent.start"][1])
	f.mu.Unlock()
	if first == second {
		t.Error("the retry used the same alias")
	}
}

// A start whose request timed out may have been typed: it is followed.
func TestAgentStartUnknown(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	f.mu.Lock()
	f.startHang = true
	f.agentGet = map[string]any{"agent": "claude", "agent_status": "unknown", "launch_pending": true}
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusGatewayTimeout || code != "start_unknown" {
		t.Fatalf("POST = %d %q", status, code)
	}
	if status, body := getStart(t, h); status != http.StatusOK || body["state"] != "starting" || body["kind"] != "claude" {
		t.Errorf("GET = %d %v", status, body)
	}
}

// While the POST is still on its way (here: agent.start not answering), a
// GET reports the start as starting, not no_start.
func TestAgentStartStateDuringPost(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	f.mu.Lock()
	f.startHang = true
	f.mu.Unlock()
	done := make(chan int)
	go func() {
		status, _, _ := postStart(t, h, `{"kind":"claude"}`)
		done <- status
	}()
	waitUntil(t, "agent.start", func() bool { return f.count("agent.start") == 1 })
	if status, body := getStart(t, h); status != http.StatusOK || body["state"] != "starting" {
		t.Errorf("GET during the POST = %d %v", status, body)
	}
	if status := <-done; status != http.StatusGatewayTimeout {
		t.Errorf("POST = %d", status)
	}
}

// An id that is not a pane of this Herdr is refused before the pane lock,
// so the locks map never holds it.
func TestAgentStartUnknownPane(t *testing.T) {
	f := newFakeHerdr(t)
	h, a := startAPI(t, f)
	for _, id := range []string{"wR:p999", "bogus", "wR:t3"} {
		rec := serve(h, apiRequest(http.MethodPost, "/api/mux/panes/"+id+"/agent/start", `{"kind":"claude"}`))
		if out := decodeBody(t, rec); rec.Code != http.StatusNotFound || out["code"] != "not_found" {
			t.Errorf("%s: %d %v", id, rec.Code, out)
		}
	}
	if calls := startCalls(f); len(calls) != 0 {
		t.Errorf("Herdr called: %q", calls)
	}
	a.input.locksMu.Lock()
	defer a.input.locksMu.Unlock()
	if len(a.input.locks) != 0 {
		t.Errorf("locks = %v", a.input.locks)
	}
}

func TestAgentStartState(t *testing.T) {
	for _, c := range []struct {
		name  string
		info  map[string]any
		fail  string
		state string
	}{
		{"ready", map[string]any{"agent": "claude", "agent_status": "idle", "launch_pending": false, "interactive_ready": true}, "", "ready"},
		{"blocked", map[string]any{"agent": "claude", "agent_status": "blocked", "launch_pending": true}, "", "blocked"},
		{"exited", map[string]any{"agent_status": "unknown", "launch_pending": false}, "", "exited"},
		{"alias dropped", nil, "agent_not_found", "exited"},
		{"another agent", map[string]any{"agent": "codex", "agent_status": "idle", "launch_pending": true}, "", "exited"},
		{"starting", map[string]any{"agent_status": "unknown", "launch_pending": true}, "", "starting"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeHerdr(t)
			h, _ := startHandler(t, f)
			if status, _ := getStart(t, h); status != http.StatusNotFound {
				t.Fatalf("GET before a start = %d", status)
			}
			if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
				t.Fatalf("POST = %d %q", status, code)
			}
			name := f.lastParams(t, "agent.start")["name"]
			f.mu.Lock()
			if c.info != nil {
				c.info["name"] = name
			}
			f.agentGet, f.agentGetFail = c.info, c.fail
			f.mu.Unlock()
			status, body := getStart(t, h)
			if status != http.StatusOK || body["state"] != c.state || body["kind"] != "claude" {
				t.Fatalf("GET = %d %v, want %s", status, body, c.state)
			}
			if c.state == "starting" {
				return
			}
			// A final state is kept without asking Herdr again.
			n := f.count("agent.get")
			if _, body := getStart(t, h); body["state"] != c.state || f.count("agent.get") != n {
				t.Errorf("second GET = %v after %d agent.get", body, f.count("agent.get")-n)
			}
		})
	}
}

// A start never seen ready past Herdr's deadline is reported timed out.
func TestAgentStartStateTimeout(t *testing.T) {
	f := newFakeHerdr(t)
	h, a := startAPI(t, f)
	f.mu.Lock()
	f.agentGet = map[string]any{"agent_status": "unknown", "launch_pending": true}
	f.mu.Unlock()
	if status, _, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
		t.Fatal("POST failed")
	}
	a.starts.mu.Lock()
	a.starts.panes[startPane].started = time.Now().Add(-agentStartTimeout - agentStartGrace - time.Second)
	a.starts.mu.Unlock()
	// The agent runs but never got ready.
	f.mu.Lock()
	f.procs = map[string]any{startPane: fakeProcessInfo(startPane, 100, 300, fakeProc(300, "claude", "claude"))}
	f.mu.Unlock()
	if _, body := getStart(t, h); body["state"] != "timeout" {
		t.Errorf("GET = %v, want timeout", body)
	}
}

// A command that ended before any agent showed (not installed) leaves the
// pane at its shell: told once the start has settled, not at Herdr's
// deadline. A pane running something (the agent, before Herdr names it) is
// still starting.
func TestAgentStartStateCommandEnded(t *testing.T) {
	f := newFakeHerdr(t)
	h, a := startAPI(t, f)
	f.mu.Lock()
	f.agentGet = map[string]any{"agent_status": "unknown", "launch_pending": true}
	f.mu.Unlock()
	if status, _, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
		t.Fatal("POST failed")
	}
	// The shell is back at once, but the start has not settled yet.
	if _, body := getStart(t, h); body["state"] != "starting" {
		t.Fatalf("GET before settling = %v", body)
	}
	a.starts.mu.Lock()
	a.starts.panes[startPane].started = time.Now().Add(-agentStartSettle)
	a.starts.mu.Unlock()
	f.mu.Lock()
	f.procs = map[string]any{startPane: fakeProcessInfo(startPane, 100, 300, fakeProc(300, "claude", "claude"))}
	f.mu.Unlock()
	if _, body := getStart(t, h); body["state"] != "starting" {
		t.Fatalf("GET with the agent running = %v", body)
	}
	f.mu.Lock()
	f.procs = nil // a bash shell
	f.mu.Unlock()
	if _, body := getStart(t, h); body["state"] != "exited" {
		t.Fatalf("GET with the shell back = %v", body)
	}
	// Herdr holds the failed start until its deadline: a new one is refused
	// before anything is typed.
	f.mu.Lock()
	f.paneAgent = map[string]any{"agent_status": "unknown", "launch_pending": true}
	f.mu.Unlock()
	before := len(startCalls(f))
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusConflict || code != "start_pending" {
		t.Fatalf("POST while Herdr holds the start = %d %q", status, code)
	}
	if after := startCalls(f)[before:]; !slices.Equal(after, []string{"pane.process_info", "agent.get"}) {
		t.Errorf("calls = %q, want no input", after)
	}
	if p := f.lastParams(t, "agent.get"); p["target"] != startPane {
		t.Errorf("agent.get target = %v, want the pane", p["target"])
	}
	// The refused start leaves the last one's state for a client still
	// following it.
	if status, body := getStart(t, h); status != http.StatusOK || body["state"] != "exited" || body["kind"] != "claude" {
		t.Errorf("GET after a refused start = %d %v, want the exited claude start", status, body)
	}
	// Once Herdr let it go, a start goes ahead.
	f.mu.Lock()
	f.paneAgent = nil
	f.mu.Unlock()
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
		t.Fatalf("POST after Herdr let go = %d %q", status, code)
	}
}

func TestAgentStartCaps(t *testing.T) {
	if (tmuxMux{}).Caps().AgentStart {
		t.Error("tmux AgentStart = true")
	}
	for _, c := range []struct {
		version string
		want    bool
	}{
		{"0.8.1", false},
		{"0.8.2", true},
		{"0.9.3", true},
		{"1.0.0", true},
		{"0.8.2-rc.1", false},
		// The Windows build checked for #357.
		{"0.9.2-preview.2026-09-29-8e78f929d8f0", true},
		{"", false},
		{"dev", false},
		{"0.9", false},
	} {
		if got := herdrCanStartAgents(c.version); got != c.want {
			t.Errorf("herdrCanStartAgents(%q) = %v", c.version, got)
		}
	}
}

// Codex is offered only where it has a Chat view (codexProcSupported):
// elsewhere a codex start answers 501 before anything reaches Herdr, and Claude Code
// still starts.
func TestAgentStartCodexKind(t *testing.T) {
	f := newFakeHerdr(t)
	h, m := startHandler(t, f)
	if c := m.Caps(); !c.AgentStart || c.AgentStartCodex != codexProcSupported {
		t.Fatalf("Caps() AgentStart %v, AgentStartCodex %v, want true, %v", c.AgentStart, c.AgentStartCodex, codexProcSupported)
	}
	if !codexProcSupported {
		if status, code, _ := postStart(t, h, `{"kind":"codex"}`); status != http.StatusNotImplemented || code != "unsupported" {
			t.Errorf("POST codex = %d %q", status, code)
		}
		if calls := startCalls(f); len(calls) != 0 {
			t.Errorf("POST codex called %q, want nothing", calls)
		}
	}
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusOK {
		t.Errorf("POST claude = %d %q", status, code)
	}
}

// Too old a Herdr: the snapshot says so and the route answers 501 without a
// call.
func TestAgentStartOldHerdr(t *testing.T) {
	f := newFakeHerdr(t)
	f.version = "0.8.1"
	h, m := startHandler(t, f)
	if m.Caps().AgentStart {
		t.Fatal("Caps().AgentStart on 0.8.1")
	}
	if status, code, _ := postStart(t, h, `{"kind":"claude"}`); status != http.StatusNotImplemented || code != "unsupported" {
		t.Errorf("POST = %d %q", status, code)
	}
	if status, _ := getStart(t, h); status != http.StatusNotImplemented {
		t.Errorf("GET = %d", status)
	}
	if calls := startCalls(f); len(calls) != 0 {
		t.Errorf("Herdr called: %q", calls)
	}
}

func TestAgentStartNotOnTmux(t *testing.T) {
	h := newTestHandler(t, &fakeMux{})
	if rec := serve(h, apiRequest(http.MethodPost, "/api/mux/panes/0/agent/start", `{"kind":"claude"}`)); rec.Code != http.StatusNotImplemented {
		t.Errorf("POST = %d", rec.Code)
	}
}

func TestAgentStartGuards(t *testing.T) {
	f := newFakeHerdr(t)
	h, _ := startHandler(t, f)
	for _, g := range []struct {
		name   string
		mod    func(*http.Request)
		status int
	}{
		{"cross-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		{"foreign origin", func(r *http.Request) { r.Header.Del("Sec-Fetch-Site"); r.Header.Set("Origin", "https://evil.example") }, 403},
		{"not JSON", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{"no auth", func(r *http.Request) { r.Header.Del("Authorization") }, 401},
	} {
		req := apiRequest(http.MethodPost, startPath, `{"kind":"claude"}`)
		g.mod(req)
		if rec := serve(h, req); rec.Code != g.status {
			t.Errorf("%s: %d, want %d", g.name, rec.Code, g.status)
		}
	}
	get := apiRequest(http.MethodGet, startPath, "")
	get.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, get); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site GET: %d", rec.Code)
	}
	big := `{"kind":"claude","pad":"` + strings.Repeat("a", maxJSONBody) + `"}`
	if rec := serve(h, apiRequest(http.MethodPost, startPath, big)); rec.Code != http.StatusRequestEntityTooLarge && rec.Code != http.StatusBadRequest {
		t.Errorf("large body: %d", rec.Code)
	}
	if rec := serve(h, apiRequest(http.MethodDelete, startPath, "")); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE: %d", rec.Code)
	}
	if calls := startCalls(f); len(calls) != 0 {
		t.Errorf("Herdr called: %q", calls)
	}
}
