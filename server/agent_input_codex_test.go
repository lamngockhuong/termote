package main

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// codexBox is a Codex screen with its composer at the bottom holding draft
// ("" shows the placeholder).
func codexBox(draft string) string {
	row := codexEmptyRow
	if draft != "" {
		row = "\x1b[1m›\x1b[0m " + strings.ReplaceAll(draft, "\n", "\n  ")
	}
	return codexRows("• Earlier answer.", "", row, "", codexModelRow, codexHintsRow)
}

// codexSession is a Codex found on tmux: its process, and the rollout it
// writes.
var codexSession = AgentSession{
	Agent: "codex", ID: testCodexID, Status: "idle", Target: "%5", PID: 77, ProcStart: "9",
	CodexHome: "/home/u/.codex", Rollout: "/home/u/.codex/sessions/r.jsonl", RolloutID: "1:2",
}

// newCodexWriter is a pane running Codex: the composer shows what is pasted
// (Codex's token past 1000 characters), and Enter submits it.
func newCodexWriter() *fakeWriter {
	f := &fakeWriter{session: codexSession, found: true, screen: codexBox("")}
	f.onPaste = func(f *fakeWriter, text string) {
		if n := utf8.RuneCountInString(text); n > 1000 {
			text = "[Pasted Content " + strconv.Itoa(n) + " chars]"
		}
		f.setScreen(codexBox(text))
	}
	f.onKeys = func(f *fakeWriter, keys []string) {
		if keys[0] == "Enter" {
			f.setScreen(codexBox(""))
		}
	}
	return f
}

func codexCursor() string { return cursorFor(testCodexID) }

func TestCodexMessageSends(t *testing.T) {
	shortConfirm(t)
	for name, text := range map[string]string{
		"short":      "xin chào, sửa lỗi này",
		"lines":      "line one\nline two",
		"long paste": strings.Repeat("é", 1001),
	} {
		t.Run(name, func(t *testing.T) {
			f := newCodexWriter()
			code, body := postJSON(t, agentMux(f), "/api/mux/panes/0/agent/message", map[string]string{"text": text, "cursor": codexCursor()})
			if code != http.StatusNoContent {
				t.Fatalf("POST = %d %v", code, body)
			}
			if len(f.pasted) != 1 || f.pasted[0] != text || len(f.keys) != 1 || f.keys[0][0] != "Enter" {
				t.Errorf("pasted %q keys %v", f.pasted, f.keys)
			}
		})
	}
}

func TestCodexMessageRefusals(t *testing.T) {
	shortConfirm(t)
	with := func(change func(*AgentSession)) AgentSession {
		s := codexSession
		change(&s)
		return s
	}
	unknown := with(func(s *AgentSession) { s.Status = "unknown" })
	otherRollout := with(func(s *AgentSession) { s.Rollout = "/home/u/.codex/sessions/other.jsonl" })
	otherFile := with(func(s *AgentSession) { s.RolloutID = "1:3" })
	working := codexRows("• Working (3s • esc to interrupt)", "", codexEmptyRow, "", codexModelRow)
	tests := []struct {
		name   string
		setup  func(f *fakeWriter)
		cursor string
		status int
		code   string
		pasted bool
	}{
		{"draft in the composer", func(f *fakeWriter) { f.screen = codexBox("half typed") }, "", 409, "input_not_ready", false},
		// The rollout lags; the screen already shows the turn running.
		{"working, composer empty", func(f *fakeWriter) { f.screen = working }, "", 409, "input_not_ready", false},
		{"status unknown", func(f *fakeWriter) { f.session = unknown }, "", 409, "input_not_ready", false},
		{"dialog open", func(f *fakeWriter) { f.screen = codexCapture(t, "0.159.3-approval-exec") }, "", 409, "input_not_ready", false},
		{"session changed", nil, cursorFor(testSessionID), 409, "session_changed", false},
		{"rollout changed before enter", func(f *fakeWriter) { f.sessions = []AgentSession{codexSession, otherRollout} }, "", 502, "delivered_not_submitted", true},
		{"rollout file replaced before enter", func(f *fakeWriter) { f.sessions = []AgentSession{codexSession, otherFile} }, "", 502, "delivered_not_submitted", true},
		// Read with Claude Code's reader, a Codex draft would never show.
		{"paste never shows", func(f *fakeWriter) { f.onPaste = nil }, "", 409, "paste_not_confirmed", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newCodexWriter()
			if tt.setup != nil {
				tt.setup(f)
			}
			cursor := tt.cursor
			if cursor == "" {
				cursor = codexCursor()
			}
			code, body := postJSON(t, agentMux(f), "/api/mux/panes/0/agent/message", map[string]string{"text": "hello", "cursor": cursor})
			if code != tt.status || body["code"] != tt.code {
				t.Errorf("POST = %d %v, want %d %s", code, body, tt.status, tt.code)
			}
			if (len(f.pasted) > 0) != tt.pasted || len(f.keys) != 0 {
				t.Errorf("pasted=%v keys=%v", f.pasted, f.keys)
			}
		})
	}
}

func TestCodexAnswer(t *testing.T) {
	shortConfirm(t)
	dialog := codexCapture(t, "0.159.3-approval-exec")
	// Codex on herdr: herdr reports it blocked while a dialog is open.
	setup := func() (*fakeWriter, *http.ServeMux, map[string]any) {
		f := newCodexWriter()
		f.session.Status = "blocked"
		f.screen = dialog
		f.onKeys = func(f *fakeWriter, keys []string) { f.setScreen(codexBox("")) }
		mux := agentMux(f)
		return f, mux, getPrompt(t, mux, "0")
	}

	t.Run("option", func(t *testing.T) {
		f, mux, p := setup()
		if p["kind"] != "permission" || p["promptId"] == nil || len(p["options"].([]any)) != 3 {
			t.Fatalf("prompt = %v", p)
		}
		id := p["promptId"].(string)
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != http.StatusNoContent {
			t.Fatalf("answer = %d %v", code, body)
		}
		if len(f.keys) != 1 || f.keys[0][0] != "1" {
			t.Errorf("keys = %v", f.keys)
		}
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != 409 || body["code"] != "prompt_expired" {
			t.Errorf("reuse = %d %v", code, body)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		f, mux, p := setup()
		if code, _ := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": "cancel"}); code != http.StatusNoContent || f.keys[0][0] != "Escape" {
			t.Errorf("cancel = %d %v", code, f.keys)
		}
	})
	t.Run("another command on screen", func(t *testing.T) {
		f, mux, p := setup()
		f.setScreen(strings.ReplaceAll(dialog, "touch", "rm -rf"))
		code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 1})
		if code != 409 || body["code"] != "prompt_changed" || len(f.keys) != 0 {
			t.Fatalf("changed = %d %v %v", code, body, f.keys)
		}
	})
	t.Run("rollout changed", func(t *testing.T) {
		f, mux, p := setup()
		s := f.session
		s.RolloutID = "9:9"
		f.sessions = []AgentSession{s}
		code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 1})
		if code != 409 || body["code"] != "target_changed" || len(f.keys) != 0 {
			t.Fatalf("rollout changed = %d %v %v", code, body, f.keys)
		}
	})
}

// On tmux Codex's rollout records no approval request, so the status never
// says a dialog is open: the card has no id and cannot be answered.
func TestCodexDialogOnTmuxIsReadOnly(t *testing.T) {
	f := newCodexWriter()
	f.session.Status = "working"
	f.session.DialogsReadOnly = true
	f.screen = codexCapture(t, "0.159.3-approval-exec")
	p := getPrompt(t, agentMux(f), "0")
	if p == nil || p["kind"] != "unsupported" || p["promptId"] != nil || p["options"] != nil ||
		p["title"] != "Would you like to run the following command?" || !strings.Contains(p["body"].(string), "$ touch c.txt") {
		t.Fatalf("prompt = %v", p)
	}
	// Even were the status to say blocked.
	f.mu.Lock()
	f.session.Status = "blocked"
	f.mu.Unlock()
	time.Sleep(agentCacheTTL)
	if p := getPrompt(t, agentMux(f), "0"); p["promptId"] != nil {
		t.Fatalf("blocked = %v", p)
	}
	f.screen = codexCapture(t, "0.159.3-dialog-rate-limit-model")
	time.Sleep(agentCacheTTL)
	if p := getPrompt(t, agentMux(f), "0"); p == nil || p["kind"] != "unsupported" || p["promptId"] != nil {
		t.Fatalf("unsupported = %v", p)
	}
}

func TestDialogStatusByAgent(t *testing.T) {
	for _, c := range []struct {
		s    AgentSession
		want bool
	}{
		{AgentSession{Agent: "claude", PID: 0, Status: "idle"}, true},
		{AgentSession{Agent: "claude", PID: 4, Status: "idle"}, false},
		{AgentSession{Agent: "claude", PID: 4, Status: "blocked"}, true},
		{AgentSession{Agent: "codex", PID: 4, Status: "blocked"}, true},
		{AgentSession{Agent: "codex", PID: 0, Status: "idle"}, false},
		{AgentSession{Agent: "codex", PID: 4, Status: "working"}, false},
		{AgentSession{Agent: "opencode", Status: "blocked"}, false},
	} {
		if got := dialogStatus(c.s); got != c.want {
			t.Errorf("dialogStatus(%+v) = %v", c.s, got)
		}
	}
}

// An agent without a screen reader gets nothing typed into it.
func TestWriteRoutesRefuseAnAgentWithoutAReader(t *testing.T) {
	f := newFakeWriter()
	f.session = AgentSession{Agent: "opencode", ID: testCodexID, Target: "%1", Status: "idle"}
	mux := agentMux(f)
	for _, path := range []string{"message", "answer"} {
		code, body := postJSON(t, mux, "/api/mux/panes/0/agent/"+path, map[string]string{"text": "hi", "cursor": codexCursor(), "promptId": "p"})
		if code != http.StatusNotFound || body["error"] != errAgentUnsupported.Error() {
			t.Errorf("%s = %d %v", path, code, body)
		}
	}
	if code, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt"); code != http.StatusNotFound || body["error"] != errAgentUnsupported.Error() {
		t.Errorf("prompt = %d %v", code, body)
	}
	// Claude Code when the request came, another agent right before the write.
	f = newFakeWriter()
	f.sessions = []AgentSession{{Agent: "opencode", ID: f.session.ID, Target: f.session.Target}}
	code, body := postJSON(t, agentMux(f), "/api/mux/panes/0/agent/message", map[string]string{"text": "hi", "cursor": cursorFor(f.session.ID)})
	if code != http.StatusNotFound || body["error"] != errAgentUnsupported.Error() || len(f.pasted) != 0 || len(f.keys) != 0 {
		t.Errorf("message = %d %v, pasted %v", code, body, f.pasted)
	}
}

// The write lock is the pane's, whichever agent runs in it.
func TestWriteLockIsThePanes(t *testing.T) {
	f := newCodexWriter()
	a := newAgentAPI(f)
	unlock, err := a.lockPane("0")
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.session = labSession
	f.session.Target = codexSession.Target
	f.mu.Unlock()
	time.Sleep(agentCacheTTL)
	got := make(chan struct{})
	go func() {
		u, err := a.lockPane("0")
		if err == nil {
			u()
		}
		close(got)
	}()
	select {
	case <-got:
		t.Fatal("another agent on the same pane took the lock while it was held")
	case <-time.After(50 * time.Millisecond):
	}
	unlock()
	select {
	case <-got:
	case <-time.After(time.Second):
		t.Fatal("the lock was not released")
	}
}
