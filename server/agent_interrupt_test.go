package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// resetInterrupts forgets every interrupt made, so each case starts with no
// pane in its gap.
func resetInterrupts(t *testing.T) {
	t.Helper()
	agentInterruptLastMu.Lock()
	clear(agentInterruptLast)
	agentInterruptLastMu.Unlock()
	t.Cleanup(func() {
		agentInterruptLastMu.Lock()
		clear(agentInterruptLast)
		agentInterruptLastMu.Unlock()
	})
}

func postInterrupt(t *testing.T, mux http.Handler, cursor string) (int, map[string]any) {
	t.Helper()
	return postJSON(t, mux, "/api/mux/panes/0/agent/interrupt", map[string]string{"cursor": cursor})
}

// workingClaude is Claude Code in a turn: busy, and its screen shows the
// working line.
func workingClaude(t *testing.T) *fakeWriter {
	t.Helper()
	f := newFakeWriter()
	f.session.Status = "working"
	f.screen = fixtureScreen(t, "2.1.310-working")
	return f
}

func TestInterruptSendsOneEscape(t *testing.T) {
	resetInterrupts(t)
	f := workingClaude(t)
	mux := agentMux(f)
	if code, body := postInterrupt(t, mux, cursorFor(testSessionID)); code != http.StatusNoContent {
		t.Fatalf("interrupt = %d %v", code, body)
	}
	if len(f.keys) != 1 || len(f.keys[0]) != 1 || f.keys[0][0] != "Escape" {
		t.Errorf("keys = %v", f.keys)
	}
	// A second one within the gap sends nothing: a second Escape would open
	// the rewind.
	if code, body := postInterrupt(t, mux, cursorFor(testSessionID)); code != http.StatusConflict || body["code"] != "interrupt_pending" {
		t.Errorf("again = %d %v", code, body)
	}
	if len(f.keys) != 1 {
		t.Errorf("keys = %v", f.keys)
	}
}

func TestInterruptGap(t *testing.T) {
	resetInterrupts(t)
	gap := agentInterruptGap
	agentInterruptGap = 30 * time.Millisecond
	t.Cleanup(func() { agentInterruptGap = gap })
	if interruptRecent("%1", time.Now()) || !interruptRecent("%1", time.Now()) {
		t.Fatal("the first is not recent, the second is")
	}
	if interruptRecent("%2", time.Now()) {
		t.Error("another pane shares the gap")
	}
	if interruptRecent("%1", time.Now().Add(agentInterruptGap)) {
		t.Error("still in the gap after it")
	}
	forgetInterrupt("%1")
	if interruptRecent("%1", time.Now()) {
		t.Error("a forgotten interrupt still counts")
	}
}

// Every refusal sends no key.
func TestInterruptRefusals(t *testing.T) {
	for name, tc := range map[string]struct {
		setup  func(t *testing.T, f *fakeWriter)
		cursor string
		status int
		code   string
	}{
		"idle":             {func(t *testing.T, f *fakeWriter) { f.session.Status = "idle" }, "", http.StatusConflict, "agent_not_working"},
		"blocked":          {func(t *testing.T, f *fakeWriter) { f.session.Status = "blocked" }, "", http.StatusConflict, "agent_blocked"},
		"dialog on screen": {func(t *testing.T, f *fakeWriter) { f.screen = fixtureScreen(t, "2.1.286-permission-bash") }, "", http.StatusConflict, "agent_blocked"},
		"copy mode":        {func(t *testing.T, f *fakeWriter) { f.session.InMode = true }, "", http.StatusConflict, "input_not_ready"},
		"copy mode since": {func(t *testing.T, f *fakeWriter) {
			s := f.session
			s.InMode = true
			f.sessions = []AgentSession{f.session, s}
		}, "", http.StatusConflict, "input_not_ready"},
		"another session": {nil, cursorFor("00000000-0000-4000-8000-000000000999"), http.StatusConflict, "session_changed"},
		"another process since": {func(t *testing.T, f *fakeWriter) {
			s := f.session
			s.PID++
			f.sessions = []AgentSession{f.session, s}
		}, "", http.StatusConflict, "session_changed"},
		"unsigned cursor": {nil, "abc.def", http.StatusConflict, "session_changed"},
		"no cursor":       {nil, "-", http.StatusBadRequest, "invalid_request"},
		"agent gone":      {func(t *testing.T, f *fakeWriter) { f.found = false }, "", http.StatusConflict, "target_changed"},
		// Busy in its session file, its answer written, waiting on a
		// background agent: Escape would stop nothing.
		"background agents only": {func(t *testing.T, f *fakeWriter) { f.screen = fixtureScreen(t, "2.1.330-wait-background-agent") }, "", http.StatusConflict, "agent_no_turn"},
		"no working line":        {func(t *testing.T, f *fakeWriter) { f.screen = fixtureScreen(t, "2.1.286-idle-after-turn") }, "", http.StatusConflict, "agent_no_turn"},
		"no input box":           {func(t *testing.T, f *fakeWriter) { f.screen = "some other screen\n" }, "", http.StatusConflict, "agent_no_turn"},
	} {
		t.Run(name, func(t *testing.T) {
			resetInterrupts(t)
			f := workingClaude(t)
			if tc.setup != nil {
				tc.setup(t, f)
			}
			cursor := tc.cursor
			switch cursor {
			case "":
				cursor = cursorFor(testSessionID)
			case "-":
				cursor = ""
			}
			code, body := postInterrupt(t, agentMux(f), cursor)
			if code != tc.status || body["code"] != tc.code {
				t.Errorf("= %d %v, want %d %s", code, body, tc.status, tc.code)
			}
			if len(f.keys) != 0 {
				t.Errorf("keys sent: %v", f.keys)
			}
		})
	}
}

func TestInterruptRequest(t *testing.T) {
	resetInterrupts(t)
	f := workingClaude(t)
	mux := agentMux(f)
	for name, body := range map[string]string{"not JSON": "{", "too large": `{"cursor":"` + strings.Repeat("x", agentInterruptBody) + `"}`} {
		if code, out := postJSON(t, mux, "/api/mux/panes/0/agent/interrupt", body); code != http.StatusBadRequest || out["code"] != "invalid_request" {
			t.Errorf("%s = %d %v", name, code, out)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/api/mux/panes/0/agent/interrupt", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", rec.Code)
	}
	// A view-only device is refused before anything is read.
	req = viewOnlyRequest(httptest.NewRequest(http.MethodPost, "/api/mux/panes/0/agent/interrupt", strings.NewReader(`{"cursor":"`+cursorFor(testSessionID)+`"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "view_only") {
		t.Errorf("view-only = %d %s", rec.Code, rec.Body)
	}
	// A key the backend could not send is no interrupt: the next is not
	// held back.
	f.keyErr = inputError("pane gone")
	if code, _ := postInterrupt(t, mux, cursorFor(testSessionID)); code == http.StatusNoContent {
		t.Error("a failed key answered 204")
	}
	f.keyErr = nil
	if code, body := postInterrupt(t, mux, cursorFor(testSessionID)); code != http.StatusNoContent {
		t.Errorf("after a failed key = %d %v", code, body)
	}
}

// Codex's rollout lags its screen: a working line on the screen is enough,
// whatever the status says.
func TestInterruptCodexByScreen(t *testing.T) {
	resetInterrupts(t)
	f := newCodexWriter()
	f.screen = codexCapture(t, "0.159.3-working-empty")
	if code, body := postInterrupt(t, agentMux(f), codexCursor()); code != http.StatusNoContent {
		t.Fatalf("interrupt = %d %v", code, body)
	}
	if len(f.keys) != 1 || f.keys[0][0] != "Escape" {
		t.Errorf("keys = %v", f.keys)
	}
	resetInterrupts(t)
	f = newCodexWriter()
	if code, body := postInterrupt(t, agentMux(f), codexCursor()); code != http.StatusConflict || body["code"] != "agent_not_working" {
		t.Errorf("idle = %d %v", code, body)
	}
}

// OpenCode is interrupted through its service, never with a key.
func TestInterruptOpencode(t *testing.T) {
	resetInterrupts(t)
	oc, f := opencodePane(t, "sesFixP1", "working")
	oc.active = []string{"sesFixP1"}
	mux := agentMux(f)
	if code, body := postInterrupt(t, mux, opencodeCursor("sesFixP1")); code != http.StatusNoContent {
		t.Fatalf("interrupt = %d %v", code, body)
	}
	if w := oc.writes(); len(w) != 1 || w[0] != "POST /api/session/sesFixP1/interrupt" {
		t.Errorf("writes = %v", w)
	}
	if len(f.keys) != 0 || len(f.pasted) != 0 {
		t.Errorf("typed into the pane: %v %q", f.keys, f.pasted)
	}
	if code, body := postInterrupt(t, mux, opencodeCursor("sesFixP1")); code != http.StatusConflict || body["code"] != "interrupt_pending" {
		t.Errorf("again = %d %v", code, body)
	}
	// No turn ran: not working, and the next try is not held back.
	resetInterrupts(t)
	oc.active = nil
	if code, body := postInterrupt(t, mux, opencodeCursor("sesFixP1")); code != http.StatusConflict || body["code"] != "agent_not_working" {
		t.Errorf("not running = %d %v", code, body)
	}
	if interruptRecent(f.session.Target, time.Now()) {
		t.Error("a refused interrupt holds back the next")
	}
	resetInterrupts(t)
	if code, body := postInterrupt(t, mux, opencodeCursor("sesOther1")); code != http.StatusConflict || body["code"] != "session_changed" {
		t.Errorf("other session = %d %v", code, body)
	}
	f.session.Status = "blocked"
	if code, body := postInterrupt(t, mux, opencodeCursor("sesFixP1")); code != http.StatusConflict || body["code"] != "agent_blocked" {
		t.Errorf("blocked = %d %v", code, body)
	}
	f.session.Status = "working"
	logs := captureLogs(t)
	oc.writeStatus = http.StatusInternalServerError
	if code, body := postInterrupt(t, mux, opencodeCursor("sesFixP1")); code != http.StatusBadGateway || body["code"] != "agent_unavailable" ||
		strings.Contains(body["error"].(string), "words") {
		t.Errorf("service fails = %d %v", code, body)
	}
	if !strings.Contains(logs.String(), "opencode interrupt") {
		t.Errorf("not logged: %s", logs)
	}
}

// viewOnlyRequest is req from a device paired view-only.
func viewOnlyRequest(req *http.Request) *http.Request {
	return req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d1"}))
}
