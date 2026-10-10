package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// boxScreen draws Claude Code's input box holding draft.
func boxScreen(draft string) string {
	rule := strings.Repeat("─", 40)
	return "● Earlier answer.\n\n" + rule + "\n❯ " + draft + "\n" + rule + "\n  sonnet · main\n  ⏸ manual mode on\n"
}

func fixtureScreen(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/claude/screens/" + name + ".txt")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// fakeWriter is a backend whose screen follows a script: Paste and keys
// call the hooks, which set the next screen.
type fakeWriter struct {
	fakeMux
	mu       sync.Mutex
	session  AgentSession
	found    bool
	sessions []AgentSession // successive AgentSessionNow answers; the last repeats
	screen   string
	screens  []string // captured first, one each, before screen
	pasted   []string
	keys     [][]string
	keyErr   error
	pasteErr error
	nowErr   error
	onPaste  func(f *fakeWriter, text string)
	onKeys   func(f *fakeWriter, keys []string)
}

func (f *fakeWriter) AgentSession(context.Context, string) (AgentSession, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.session, f.found, nil
}

func (f *fakeWriter) AgentSessionNow(context.Context, string) (AgentSession, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.nowErr != nil {
		return AgentSession{}, false, f.nowErr
	}
	if len(f.sessions) > 0 {
		s := f.sessions[0]
		if len(f.sessions) > 1 {
			f.sessions = f.sessions[1:]
		}
		return s, true, nil
	}
	return f.session, f.found, nil
}

func (f *fakeWriter) Capture(context.Context, string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.screens) > 0 {
		s := f.screens[0]
		f.screens = f.screens[1:]
		return s, nil
	}
	return f.screen, nil
}

func (f *fakeWriter) Paste(_ context.Context, _ string, text string) error {
	f.mu.Lock()
	f.pasted = append(f.pasted, text)
	hook, err := f.onPaste, f.pasteErr
	f.mu.Unlock()
	if err != nil {
		return err
	}
	if hook != nil {
		hook(f, text)
	}
	return nil
}

func (f *fakeWriter) SendKeySequence(_ context.Context, _ string, keys []string) error {
	f.mu.Lock()
	f.keys = append(f.keys, keys)
	hook, err := f.onKeys, f.keyErr
	f.mu.Unlock()
	if err != nil {
		return err
	}
	if hook != nil {
		hook(f, keys)
	}
	return nil
}

func (f *fakeWriter) setScreen(s string) {
	f.mu.Lock()
	f.screen = s
	f.mu.Unlock()
}

// typing makes the box show what was pasted, and Enter submit it.
func typing(f *fakeWriter) {
	f.onPaste = func(f *fakeWriter, text string) { f.setScreen(boxScreen(strings.ReplaceAll(text, "\n", " "))) }
	f.onKeys = func(f *fakeWriter, keys []string) {
		if keys[0] == "Enter" {
			f.setScreen(boxScreen(""))
		}
	}
}

var labSession = AgentSession{Agent: "claude", ID: testSessionID, Status: "idle", Target: "%3", PID: 42, ProcStart: "7"}

func newFakeWriter() *fakeWriter {
	f := &fakeWriter{session: labSession, found: true, screen: boxScreen("")}
	typing(f)
	return f
}

func shortConfirm(t *testing.T) {
	orig, origPoll := agentConfirmWait, agentPollEvery
	agentConfirmWait, agentPollEvery = 150*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { agentConfirmWait, agentPollEvery = orig, origPoll })
}

func postJSON(t *testing.T, h http.Handler, path string, body any) (int, map[string]any) {
	t.Helper()
	var b []byte
	if s, ok := body.(string); ok {
		b = []byte(s)
	} else {
		b, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(b)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func agentMux(m Mux) *http.ServeMux {
	mux := http.NewServeMux()
	registerMuxRoutes(mux, m, newStreamTokenStore(), nil, nil)
	return mux
}

func cursorFor(session string) string {
	return encodeCursor(agentCursor{Session: session, Offset: 0})
}

func TestMessageSendsVerbatimAndSubmits(t *testing.T) {
	shortConfirm(t)
	f := newFakeWriter()
	text := "line one $HOME `x` \"q\";\n- second\ntiếng Việt\x1b[201~\u0085\x07\r\nend\t."
	code, body := postJSON(t, agentMux(f), "/api/mux/panes/0/agent/message", map[string]string{"text": text, "cursor": cursorFor(testSessionID)})
	if code != http.StatusNoContent {
		t.Fatalf("POST = %d %v", code, body)
	}
	want := "line one $HOME `x` \"q\";\n- second\ntiếng Việt[201~\nend\t."
	if len(f.pasted) != 1 || f.pasted[0] != want {
		t.Errorf("pasted %q, want %q", f.pasted, want)
	}
	if len(f.keys) != 1 || f.keys[0][0] != "Enter" {
		t.Errorf("keys = %v", f.keys)
	}
}

// A message sent while the agent redraws (the screen cleared after an
// answer, the box not back yet) goes once the empty box shows.
func TestMessageWaitsForRedraw(t *testing.T) {
	shortConfirm(t)
	f := newFakeWriter()
	f.screens = []string{"", ""}
	code, body := postJSON(t, agentMux(f), "/api/mux/panes/0/agent/message", map[string]string{"text": "hello", "cursor": cursorFor(testSessionID)})
	if code != http.StatusNoContent {
		t.Fatalf("POST = %d %v", code, body)
	}
	if len(f.pasted) != 1 || f.pasted[0] != "hello" || len(f.keys) != 1 {
		t.Errorf("pasted %q keys %v", f.pasted, f.keys)
	}
}

// What a redraw settles into is checked as before, and the session is read
// again after the wait: nothing is pasted unless the same agent is idle.
func TestMessageRedrawRefusals(t *testing.T) {
	shortConfirm(t)
	working := labSession
	working.Status = "working"
	moved := labSession
	moved.Target = "%9"
	dialog := fixtureScreen(t, "2.1.286-permission-bash")
	tests := []struct {
		name     string
		settled  string
		sessions []AgentSession
		code     string
		msg      string
	}{
		{"settles into a dialog", dialog, nil, "input_not_ready", "a dialog is open"},
		{"pane changed during the redraw", boxScreen(""), []AgentSession{labSession, moved}, "session_changed", "the pane runs another session now"},
		{"agent started working during the redraw", boxScreen(""), []AgentSession{labSession, working}, "input_not_ready", "the agent is working"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeWriter()
			f.screens = []string{"", ""}
			f.screen = tt.settled
			f.sessions = tt.sessions
			code, body := postJSON(t, agentMux(f), "/api/mux/panes/0/agent/message", map[string]string{"text": "hello", "cursor": cursorFor(testSessionID)})
			if code != http.StatusConflict || body["code"] != tt.code || body["error"] != tt.msg {
				t.Errorf("POST = %d %v, want 409 %s %q", code, body, tt.code, tt.msg)
			}
			if len(f.pasted) != 0 || len(f.keys) != 0 {
				t.Errorf("pasted=%v keys=%v", f.pasted, f.keys)
			}
		})
	}
}

func TestMessageRefusals(t *testing.T) {
	shortConfirm(t)
	working := labSession
	working.Status = "working"
	blocked := labSession
	blocked.Status = "blocked"
	moved := labSession
	moved.Target = "%9"
	tests := []struct {
		name   string
		setup  func(f *fakeWriter)
		cursor string
		status int
		code   string
		pasted bool
		enter  bool
	}{
		{"session changed", nil, cursorFor("99999999-2222-4333-8444-555555555555"), 409, "session_changed", false, false},
		{"cursor from before a restart", nil, "forged.cursor", 409, "session_changed", false, false},
		{"agent gone", func(f *fakeWriter) { f.found = false }, "", 409, "target_changed", false, false},
		{"working", func(f *fakeWriter) { f.session = working }, "", 409, "input_not_ready", false, false},
		{"waiting on a dialog", func(f *fakeWriter) { f.session = blocked }, "", 409, "input_not_ready", false, false},
		{"draft in the box", func(f *fakeWriter) { f.screen = boxScreen("half typed") }, "", 409, "input_not_ready", false, false},
		{"dialog open", func(f *fakeWriter) { f.screen = fixtureScreen(t, "2.1.286-permission-bash") }, "", 409, "input_not_ready", false, false},
		{"unknown screen", func(f *fakeWriter) { f.screen = "$ ls\nfile\n$ " }, "", 409, "input_not_ready", false, false},
		{"paste never shows", func(f *fakeWriter) { f.onPaste = nil }, "", 409, "paste_not_confirmed", true, false},
		// Read again right before the paste: an agent that exited since the
		// screen check leaves a shell, which runs each line of the text.
		{"pane changed before paste", func(f *fakeWriter) { f.sessions = []AgentSession{labSession, moved} }, "", 409, "session_changed", false, false},
		{"agent started working before paste", func(f *fakeWriter) { f.sessions = []AgentSession{labSession, working} }, "", 409, "input_not_ready", false, false},
		{"pane changed before enter", func(f *fakeWriter) { f.sessions = []AgentSession{labSession, labSession, moved} }, "", 502, "delivered_not_submitted", true, false},
		{"agent started working before enter", func(f *fakeWriter) { f.sessions = []AgentSession{labSession, labSession, working} }, "", 502, "delivered_not_submitted", true, false},
		{"copy mode", func(f *fakeWriter) { f.session.InMode = true }, "", 409, "input_not_ready", false, false},
		{"pane gone", func(f *fakeWriter) { f.nowErr = inputError("unknown pane") }, "", 409, "target_changed", false, false},
		{"enter fails", func(f *fakeWriter) { f.keyErr = errors.New("tmux gone") }, "", 502, "delivered_not_submitted", true, true},
		{"enter does not submit", func(f *fakeWriter) { f.onKeys = nil }, "", 502, "delivered_not_submitted", true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeWriter()
			if tt.setup != nil {
				tt.setup(f)
			}
			cursor := tt.cursor
			if cursor == "" {
				cursor = cursorFor(testSessionID)
			}
			code, body := postJSON(t, agentMux(f), "/api/mux/panes/0/agent/message", map[string]string{"text": "hello", "cursor": cursor})
			if code != tt.status || body["code"] != tt.code {
				t.Errorf("POST = %d %v, want %d %s", code, body, tt.status, tt.code)
			}
			if (len(f.pasted) > 0) != tt.pasted || (len(f.keys) > 0) != tt.enter {
				t.Errorf("pasted=%v keys=%v", f.pasted, f.keys)
			}
		})
	}
}

func TestMessageBadRequests(t *testing.T) {
	f := newFakeWriter()
	mux := agentMux(f)
	cur := cursorFor(testSessionID)
	big := strings.Repeat("tiếng việt ", 1900) // ~ 20 KB
	for name, tc := range map[string]struct {
		body   any
		status int
	}{
		"text over 16 KB":    {map[string]string{"text": big, "cursor": cur}, 413},
		"body over 64 KB":    {map[string]string{"text": strings.Repeat("x", 70*1024), "cursor": cur}, 413},
		"only control chars": {map[string]string{"text": "\x07\x1b ", "cursor": cur}, 400},
		"no cursor":          {map[string]string{"text": "hi"}, 400},
		"not json":           {"{", 400},
	} {
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", tc.body); code != tc.status {
			t.Errorf("%s: %d %v, want %d", name, code, body, tc.status)
		}
	}
	if len(f.pasted) != 0 {
		t.Errorf("pasted %v", f.pasted)
	}
	if _, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]string{"text": big, "cursor": cur}); body["limit"] != float64(agentMaxText) || body["code"] != "text_too_long" {
		t.Errorf("413 body = %v", body)
	}
	// 16 KB exactly is accepted.
	shortConfirm(t)
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]string{"text": strings.Repeat("a", agentMaxText), "cursor": cur}); code != http.StatusNoContent {
		t.Errorf("16 KB = %d %v", code, body)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/mux/panes/0/agent/message", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET message = %d", rec.Code)
	}
}

func TestAgentWriteRoutesNeedAWriter(t *testing.T) {
	mux := agentMux(&fakeLocator{s: labSession, found: true})
	for _, path := range []string{"message", "answer"} {
		if code, _ := postJSON(t, mux, "/api/mux/panes/0/agent/"+path, map[string]string{}); code != http.StatusNotFound {
			t.Errorf("%s = %d", path, code)
		}
	}
	if code, _ := getJSON(t, mux, "/api/mux/panes/0/agent/prompt"); code != http.StatusNotFound {
		t.Errorf("prompt = %d", code)
	}
}

func getPrompt(t *testing.T, mux http.Handler, pane string) map[string]any {
	t.Helper()
	code, body := getJSON(t, mux, "/api/mux/panes/"+pane+"/agent/prompt")
	if code != http.StatusOK {
		t.Fatalf("GET prompt = %d %v", code, body)
	}
	p, _ := body["prompt"].(map[string]any)
	return p
}

func TestPromptRoute(t *testing.T) {
	f := newFakeWriter()
	f.screen = fixtureScreen(t, "2.1.286-permission-bash")
	mux := agentMux(f)
	p := getPrompt(t, mux, "0")
	if p == nil || p["kind"] != "permission" || p["promptId"] != nil {
		t.Fatalf("prompt while the session file says idle = %v, want no id", p)
	}
	f.mu.Lock()
	f.session.Status = "blocked"
	f.mu.Unlock()
	time.Sleep(agentCacheTTL)
	p = getPrompt(t, mux, "0")
	if p == nil || p["promptId"] == nil || len(p["options"].([]any)) != 3 {
		t.Fatalf("prompt = %v", p)
	}
	// Every poll of the same dialog gets the same id.
	time.Sleep(agentCacheTTL)
	if again := getPrompt(t, mux, "0"); again["promptId"] != p["promptId"] {
		t.Errorf("id changed: %v → %v", p["promptId"], again["promptId"])
	}
	f.setScreen(fixtureScreen(t, "2.1.286-trust-unnumbered"))
	time.Sleep(agentCacheTTL)
	if u := getPrompt(t, mux, "0"); u["kind"] != "unsupported" || u["promptId"] != nil {
		t.Errorf("unsupported = %v", u)
	}
	f.setScreen(boxScreen(""))
	time.Sleep(agentCacheTTL)
	if n := getPrompt(t, mux, "0"); n != nil {
		t.Errorf("no dialog = %v", n)
	}
	f.found = false
	if code, _ := getJSON(t, mux, "/api/mux/panes/7/agent/prompt"); code != http.StatusNotFound {
		t.Errorf("no agent = %d", code)
	}
}

func TestPromptRouteSharesCapture(t *testing.T) {
	f := &countingWriter{fakeWriter: newFakeWriter()}
	mux := agentMux(f)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); getPrompt(t, mux, "0") }()
	}
	wg.Wait()
	if f.captures != 1 {
		t.Errorf("3 clients made %d captures, want 1", f.captures)
	}
}

type countingWriter struct {
	*fakeWriter
	cmu      sync.Mutex
	captures int
}

func (c *countingWriter) Capture(ctx context.Context, target string) (string, error) {
	c.cmu.Lock()
	c.captures++
	c.cmu.Unlock()
	time.Sleep(20 * time.Millisecond)
	return c.fakeWriter.Capture(ctx, target)
}

// answering closes the dialog on any key.
func answering(f *fakeWriter) {
	f.onKeys = func(f *fakeWriter, keys []string) { f.setScreen(boxScreen("")) }
}

func TestAnswer(t *testing.T) {
	shortConfirm(t)
	dialog := fixtureScreen(t, "2.1.286-permission-bash")
	setup := func() (*fakeWriter, *http.ServeMux, string) {
		f := newFakeWriter()
		f.session.Status = "blocked"
		f.screen = dialog
		answering(f)
		mux := agentMux(f)
		return f, mux, getPrompt(t, mux, "0")["promptId"].(string)
	}

	t.Run("option", func(t *testing.T) {
		f, mux, id := setup()
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 2}); code != http.StatusNoContent {
			t.Fatalf("answer = %d %v", code, body)
		}
		if len(f.keys) != 1 || f.keys[0][0] != "2" {
			t.Errorf("keys = %v", f.keys)
		}
		// The id is spent.
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != 409 || body["code"] != "prompt_expired" {
			t.Errorf("reuse = %d %v", code, body)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		f, mux, id := setup()
		if code, _ := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": "cancel"}); code != http.StatusNoContent || f.keys[0][0] != "Escape" {
			t.Errorf("cancel = %d %v", code, f.keys)
		}
	})
	t.Run("bad choice keeps the id", func(t *testing.T) {
		f, mux, id := setup()
		for _, c := range []any{7, "yes", -1, 1.5, nil} {
			if code, _ := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": c}); code != http.StatusBadRequest {
				t.Errorf("choice %v = %d", c, code)
			}
		}
		if len(f.keys) != 0 {
			t.Errorf("keys = %v", f.keys)
		}
		if code, _ := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != http.StatusNoContent {
			t.Errorf("valid choice after bad ones = %d", code)
		}
	})
	t.Run("other pane", func(t *testing.T) {
		f, mux, id := setup()
		if code, _ := postJSON(t, mux, "/api/mux/panes/1/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != 409 || len(f.keys) != 0 {
			t.Errorf("other pane = %d %v", code, f.keys)
		}
	})
	t.Run("screen changed", func(t *testing.T) {
		f, mux, id := setup()
		f.setScreen(strings.ReplaceAll(dialog, "touch scratch-one.txt", "rm -rf build"))
		code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1})
		if code != 409 || body["code"] != "prompt_changed" || len(f.keys) != 0 {
			t.Fatalf("changed = %d %v %v", code, body, f.keys)
		}
		// The reply carries the dialog now on screen, with a new id.
		p, _ := body["prompt"].(map[string]any)
		if p == nil || p["promptId"] == id || !strings.Contains(p["body"].(string), "rm -rf build") {
			t.Errorf("new prompt = %v", p)
		}
	})
	t.Run("dialog closed", func(t *testing.T) {
		f, mux, id := setup()
		f.setScreen(boxScreen(""))
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != 409 || body["prompt"] != nil || len(f.keys) != 0 {
			t.Errorf("closed = %d %v", code, body)
		}
	})
	t.Run("agent restarted", func(t *testing.T) {
		f, mux, id := setup()
		other := f.session
		other.ProcStart = "8"
		f.sessions = []AgentSession{other}
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != 409 || body["code"] != "target_changed" || len(f.keys) != 0 {
			t.Errorf("restarted = %d %v", code, body)
		}
	})
	t.Run("dialog stays open", func(t *testing.T) {
		f, mux, id := setup()
		f.onKeys = nil
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != 502 || body["code"] != "answer_not_confirmed" {
			t.Errorf("stuck = %d %v", code, body)
		}
	})
	t.Run("two devices", func(t *testing.T) {
		f, mux, id := setup()
		var wg sync.WaitGroup
		codes := make([]int, 2)
		for i := range codes {
			wg.Add(1)
			go func() {
				defer wg.Done()
				codes[i], _ = postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": i + 1})
			}()
		}
		wg.Wait()
		if len(f.keys) != 1 || !((codes[0] == 204 && codes[1] == 409) || (codes[0] == 409 && codes[1] == 204)) {
			t.Errorf("codes = %v keys = %v", codes, f.keys)
		}
	})
	t.Run("status no longer blocked", func(t *testing.T) {
		f, mux, id := setup()
		idle := f.session
		idle.Status = "idle"
		f.sessions = []AgentSession{idle}
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != 409 || body["code"] != "prompt_changed" || len(f.keys) != 0 {
			t.Errorf("idle = %d %v", code, body)
		}
	})
	t.Run("copy mode", func(t *testing.T) {
		f, mux, id := setup()
		inMode := f.session
		inMode.InMode = true
		f.sessions = []AgentSession{inMode}
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1}); code != 409 || body["code"] != "input_not_ready" || len(f.keys) != 0 {
			t.Errorf("copy mode = %d %v", code, body)
		}
	})
	t.Run("identical dialog right after an answer", func(t *testing.T) {
		// Claude closes the dialog and opens the same one again before a
		// second device that fetched in between can answer.
		f, mux, id := setup()
		f.onKeys = nil // the same dialog stays on screen
		postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": 1})
		time.Sleep(agentCacheTTL)
		if p := getPrompt(t, mux, "0"); p == nil || p["promptId"] != nil {
			t.Fatalf("right after an answer = %v, want the card without an id", p)
		}
		// Once the screen leaves the dialog, the next one gets an id.
		f.setScreen(boxScreen(""))
		time.Sleep(agentCacheTTL)
		getPrompt(t, mux, "0")
		f.setScreen(dialog)
		time.Sleep(agentCacheTTL)
		if p := getPrompt(t, mux, "0"); p == nil || p["promptId"] == nil || p["promptId"] == id {
			t.Errorf("next dialog = %v", p)
		}
	})
	t.Run("unsupported dialog", func(t *testing.T) {
		f := newFakeWriter()
		f.screen = fixtureScreen(t, "2.1.286-trust-unnumbered")
		mux := agentMux(f)
		getPrompt(t, mux, "0")
		if code, _ := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": "", "choice": 1}); code != 409 || len(f.keys) != 0 {
			t.Errorf("unsupported = %d", code)
		}
	})
}

func TestAnswerWizard(t *testing.T) {
	shortConfirm(t)
	// Each key moves Claude Code to the screen recorded after it.
	next := map[string]map[string]string{
		"2.1.286-ask-wizard":        {"1": "2.1.286-ask-wizard-tab2"},
		"2.1.286-ask-wizard-tab2":   {"2": "2.1.286-ask-wizard-submit"},
		"2.1.286-ask-wizard-submit": {"1": "2.1.286-ask-wizard-after-submit", "Escape": "2.1.286-ask-wizard-submit-esc"},
		"2.1.286-ask-single":        {"5": "2.1.286-ask-chat-after"},
		// The mixed wizard: Size, Extras (multiSelect), Drink, Submit.
		"2.1.286-ask-wizard-mixed":         {"Right": "2.1.286-ask-wizard-multi-open"},
		"2.1.286-ask-wizard-multi-open":    {"2": "2.1.286-ask-wizard-multi-toggled", "Left": "2.1.286-ask-wizard-mixed"},
		"2.1.286-ask-wizard-multi-toggled": {"Right": "2.1.286-ask-wizard-after-multi"},
		"2.1.286-ask-wizard-after-multi":   {"Right": "2.1.286-ask-wizard-submit-partial"},
		// Previews: a digit moves the pointer, Enter picks.
		"2.1.286-ask-preview":                  {"2": "2.1.286-ask-preview-pointer-2", "Enter": "2.1.286-ask-preview-after"},
		"2.1.286-ask-preview-pointer-2":        {"Enter": "2.1.286-ask-preview-after"},
		"2.1.286-ask-wizard-preview":           {"2": "2.1.286-ask-wizard-preview-pointer-2"},
		"2.1.286-ask-wizard-preview-pointer-2": {"Enter": "2.1.286-ask-wizard-preview-next"},
	}
	setup := func(first string) (*fakeWriter, *http.ServeMux, *string) {
		f := newFakeWriter()
		f.session.Status = "blocked"
		f.screen = fixtureScreen(t, first)
		on := first
		f.onKeys = func(f *fakeWriter, keys []string) {
			if to, ok := next[on][keys[0]]; ok {
				on = to
				f.setScreen(fixtureScreen(t, to))
			}
		}
		return f, agentMux(f), &on
	}
	answer := func(mux *http.ServeMux, id string, choice any) (int, map[string]any) {
		return postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": choice})
	}

	t.Run("to the end, one tab at a time", func(t *testing.T) {
		f, mux, on := setup("2.1.286-ask-wizard")
		seen := map[any]bool{}
		for _, step := range []struct {
			title  string
			choice int
		}{{"What size do you want?", 1}, {"Which drink do you prefer?", 2}, {"Review your answers", 1}} {
			time.Sleep(agentCacheTTL)
			p := getPrompt(t, mux, "0")
			if p == nil || p["kind"] != "select" || p["title"] != step.title || p["promptId"] == nil || p["steps"] == nil || seen[p["promptId"]] {
				t.Fatalf("on %s: prompt = %v", *on, p)
			}
			seen[p["promptId"]] = true
			if code, body := answer(mux, p["promptId"].(string), step.choice); code != http.StatusNoContent {
				t.Fatalf("on %s: answer = %d %v", *on, code, body)
			}
		}
		if *on != "2.1.286-ask-wizard-after-submit" || len(f.keys) != 3 {
			t.Errorf("ended on %s, keys %v", *on, f.keys)
		}
		time.Sleep(agentCacheTTL)
		if p := getPrompt(t, mux, "0"); p != nil {
			t.Errorf("after submit = %v", p)
		}
	})
	t.Run("another device moved the wizard on", func(t *testing.T) {
		f, mux, _ := setup("2.1.286-ask-wizard")
		id := getPrompt(t, mux, "0")["promptId"].(string)
		f.setScreen(fixtureScreen(t, "2.1.286-ask-wizard-tab2"))
		code, body := answer(mux, id, 1)
		p, _ := body["prompt"].(map[string]any)
		if code != 409 || body["code"] != "prompt_changed" || len(f.keys) != 0 || p == nil || p["title"] != "Which drink do you prefer?" {
			t.Errorf("moved on = %d %v keys %v", code, body, f.keys)
		}
	})
	t.Run("the user went back a tab in the terminal", func(t *testing.T) {
		f, mux, _ := setup("2.1.286-ask-wizard-tab2")
		id := getPrompt(t, mux, "0")["promptId"].(string)
		f.setScreen(fixtureScreen(t, "2.1.286-ask-wizard-back"))
		if code, body := answer(mux, id, 1); code != 409 || body["code"] != "prompt_changed" || len(f.keys) != 0 {
			t.Errorf("went back = %d %v keys %v", code, body, f.keys)
		}
	})
	t.Run("Esc on the Submit tab declines", func(t *testing.T) {
		_, mux, on := setup("2.1.286-ask-wizard-submit")
		id := getPrompt(t, mux, "0")["promptId"].(string)
		if code, body := answer(mux, id, "cancel"); code != http.StatusNoContent || *on != "2.1.286-ask-wizard-submit-esc" {
			t.Errorf("cancel = %d %v on %s", code, body, *on)
		}
	})
	idOf := func(mux *http.ServeMux) string {
		time.Sleep(agentCacheTTL)
		p := getPrompt(t, mux, "0")
		if p == nil || p["promptId"] == nil {
			t.Fatalf("no id: %v", p)
		}
		return p["promptId"].(string)
	}
	t.Run("multiSelect: toggle, then next", func(t *testing.T) {
		f, mux, on := setup("2.1.286-ask-wizard-multi-open")
		if p := getPrompt(t, mux, "0"); p["kind"] != "multiselect" {
			t.Fatalf("multiSelect tab = %v", p)
		}
		if code, body := answer(mux, idOf(mux), 2); code != http.StatusNoContent || *on != "2.1.286-ask-wizard-multi-toggled" {
			t.Fatalf("toggle = %d %v on %s", code, body, *on)
		}
		if code, body := answer(mux, idOf(mux), "next"); code != http.StatusNoContent || *on != "2.1.286-ask-wizard-after-multi" {
			t.Fatalf("next = %d %v on %s", code, body, *on)
		}
		if got := f.keys; len(got) != 2 || got[0][0] != "2" || got[1][0] != "Right" {
			t.Errorf("keys = %v", got)
		}
	})
	t.Run("previews: the digit, then Enter once the pointer is there", func(t *testing.T) {
		f, mux, on := setup("2.1.286-ask-preview")
		if code, body := answer(mux, idOf(mux), 2); code != http.StatusNoContent || *on != "2.1.286-ask-preview-after" {
			t.Fatalf("preview = %d %v on %s", code, body, *on)
		}
		if got := f.keys; len(got) != 2 || got[0][0] != "2" || got[1][0] != "Enter" {
			t.Errorf("keys = %v", got)
		}
		// The pointer already on the option: Enter alone.
		f2, mux2, on2 := setup("2.1.286-ask-preview")
		if code, body := answer(mux2, idOf(mux2), 1); code != http.StatusNoContent || *on2 != "2.1.286-ask-preview-after" || len(f2.keys) != 1 || f2.keys[0][0] != "Enter" {
			t.Errorf("pointer there = %d %v on %s keys %v", code, body, *on2, f2.keys)
		}
		// In a wizard, Enter moves on to the next tab.
		_, mux3, on3 := setup("2.1.286-ask-wizard-preview")
		if code, body := answer(mux3, idOf(mux3), 2); code != http.StatusNoContent || *on3 != "2.1.286-ask-wizard-preview-next" {
			t.Errorf("wizard preview = %d %v on %s", code, body, *on3)
		}
	})
	t.Run("previews: no Enter unless the pointer reached the option", func(t *testing.T) {
		// The pointer does not move.
		f, mux, _ := setup("2.1.286-ask-preview")
		f.onKeys = nil
		if code, body := answer(mux, idOf(mux), 2); code != 502 || body["code"] != "answer_not_confirmed" || len(f.keys) != 1 {
			t.Errorf("stuck = %d %v keys %v", code, body, f.keys)
		}
		// The digit lands on another question.
		f2, mux2, _ := setup("2.1.286-ask-preview")
		f2.onKeys = func(f *fakeWriter, keys []string) {
			f.setScreen(strings.Replace(fixtureScreen(t, "2.1.286-ask-preview-pointer-2"), "☐ Layout ", "☐ Colour ", 1))
		}
		if code, body := answer(mux2, idOf(mux2), 2); code != 409 || body["code"] != "prompt_changed" || len(f2.keys) != 1 {
			t.Errorf("other question = %d %v keys %v", code, body, f2.keys)
		}
		// The key cannot be sent.
		f3, mux3, _ := setup("2.1.286-ask-preview")
		f3.keyErr = errors.New("pane gone")
		if code, _ := answer(mux3, idOf(mux3), 2); code < 500 {
			t.Errorf("send error = %d", code)
		}
	})
	t.Run("next only on a multiSelect tab", func(t *testing.T) {
		f, mux, _ := setup("2.1.286-ask-wizard-mixed")
		if code, _ := answer(mux, idOf(mux), "next"); code != http.StatusBadRequest || len(f.keys) != 0 {
			t.Errorf("next on single-choice = %d keys %v", code, f.keys)
		}
	})
	t.Run("a step opens that tab, one arrow at a time", func(t *testing.T) {
		f, mux, on := setup("2.1.286-ask-wizard-mixed")
		// Size → Extras, then back.
		if code, body := answer(mux, idOf(mux), map[string]int{"step": 1}); code != http.StatusNoContent || *on != "2.1.286-ask-wizard-multi-open" {
			t.Fatalf("step 1 = %d %v on %s", code, body, *on)
		}
		if code, body := answer(mux, idOf(mux), map[string]int{"step": 0}); code != http.StatusNoContent || *on != "2.1.286-ask-wizard-mixed" {
			t.Fatalf("back to step 0 = %d %v on %s", code, body, *on)
		}
		if got := f.keys; len(got) != 2 || got[0][0] != "Right" || got[1][0] != "Left" {
			t.Errorf("keys = %v", got)
		}
	})
	t.Run("several steps, each one checked", func(t *testing.T) {
		// Extras (ticked) → Drink → Submit: Extras turns ☒ on the way, still the same wizard.
		f, mux, on := setup("2.1.286-ask-wizard-multi-toggled")
		if code, body := answer(mux, idOf(mux), map[string]int{"step": 3}); code != http.StatusNoContent || *on != "2.1.286-ask-wizard-submit-partial" || len(f.keys) != 2 {
			t.Errorf("to Submit = %d %v on %s keys %v", code, body, *on, f.keys)
		}
	})
	t.Run("a step that lands elsewhere stops", func(t *testing.T) {
		f, mux, _ := setup("2.1.286-ask-wizard-mixed")
		// Right opens another wizard's tab: no second key.
		f.onKeys = func(f *fakeWriter, keys []string) { f.setScreen(fixtureScreen(t, "2.1.286-ask-wizard-tab2")) }
		code, body := answer(mux, idOf(mux), map[string]int{"step": 2})
		p, _ := body["prompt"].(map[string]any)
		if code != 409 || body["code"] != "prompt_changed" || len(f.keys) != 1 || p == nil || p["title"] != "Which drink do you prefer?" {
			t.Errorf("elsewhere = %d %v keys %v", code, body, f.keys)
		}
		// A wizard with as many tabs, another one.
		f3, mux3, _ := setup("2.1.286-ask-wizard-mixed")
		f3.onKeys = func(f *fakeWriter, keys []string) {
			f.setScreen(strings.ReplaceAll(fixtureScreen(t, "2.1.286-ask-wizard-multi-open"), "Extras", "Extrax"))
		}
		if code, body := answer(mux3, idOf(mux3), map[string]int{"step": 2}); code != 409 || body["code"] != "prompt_changed" || len(f3.keys) != 1 {
			t.Errorf("other wizard = %d %v keys %v", code, body, f3.keys)
		}
		// The key cannot be sent.
		f4, mux4, _ := setup("2.1.286-ask-wizard-mixed")
		f4.keyErr = errors.New("pane gone")
		if code, _ := answer(mux4, idOf(mux4), map[string]int{"step": 1}); code < 500 {
			t.Errorf("send error = %d", code)
		}
		// The screen does not move at all.
		f2, mux2, _ := setup("2.1.286-ask-wizard-mixed")
		f2.onKeys = nil
		if code, body := answer(mux2, idOf(mux2), map[string]int{"step": 1}); code != 502 || body["code"] != "step_not_confirmed" || body["prompt"] == nil {
			t.Errorf("stuck = %d %v", code, body)
		}
		// A tab passed on the way with text being typed into it: no key on it.
		f5, mux5, _ := setup("2.1.286-ask-wizard-mixed")
		f5.onKeys = func(f *fakeWriter, keys []string) {
			f.setScreen(fixtureScreen(t, "2.1.286-ask-wizard-multi-cursor-free-text"))
		}
		if code, body := answer(mux5, idOf(mux5), map[string]int{"step": 2}); code != 409 || body["code"] != "prompt_changed" || len(f5.keys) != 1 {
			t.Errorf("passing a typing tab = %d %v keys %v", code, body, f5.keys)
		}
		// It can be the tab opened, though: the card shows it read-only.
		f6, mux6, _ := setup("2.1.286-ask-wizard-mixed")
		f6.onKeys = f5.onKeys
		if code, body := answer(mux6, idOf(mux6), map[string]int{"step": 1}); code != http.StatusNoContent || len(f6.keys) != 1 {
			t.Errorf("opening a typing tab = %d %v keys %v", code, body, f6.keys)
		}
	})
	t.Run("bad steps keep the id", func(t *testing.T) {
		f, mux, _ := setup("2.1.286-ask-wizard-mixed")
		id := idOf(mux)
		for _, c := range []any{map[string]int{"step": 0}, map[string]int{"step": 4}, map[string]int{"step": -1}, map[string]any{"step": "1"}, map[string]any{}} {
			if code, _ := answer(mux, id, c); code != http.StatusBadRequest {
				t.Errorf("choice %v = %d", c, code)
			}
		}
		if len(f.keys) != 0 {
			t.Errorf("keys = %v", f.keys)
		}
		// A single question has no steps.
		_, mux2, _ := setup("2.1.286-ask-single")
		if code, _ := answer(mux2, idOf(mux2), map[string]int{"step": 1}); code != http.StatusBadRequest {
			t.Errorf("step on a single question = %d", code)
		}
	})
	t.Run("chat about this", func(t *testing.T) {
		f, mux, on := setup("2.1.286-ask-single")
		id := getPrompt(t, mux, "0")["promptId"].(string)
		if code, body := answer(mux, id, 5); code != http.StatusNoContent || *on != "2.1.286-ask-chat-after" || f.keys[0][0] != "5" {
			t.Errorf("chat = %d %v on %s", code, body, *on)
		}
		// "Type something" is not an option the route sends.
		f2, mux2, _ := setup("2.1.286-ask-single")
		id2 := getPrompt(t, mux2, "0")["promptId"].(string)
		if code, _ := answer(mux2, id2, 4); code != http.StatusBadRequest || len(f2.keys) != 0 {
			t.Errorf("type something = %d keys %v", code, f2.keys)
		}
	})
}

func TestPromptStoreBounds(t *testing.T) {
	in := newAgentInput()
	for i := 0; i < agentMaxPrompts+10; i++ {
		in.issuePrompt("p", labSession, strings.Repeat("s", i+1), AgentPrompt{})
	}
	if len(in.prompts) > agentMaxPrompts {
		t.Errorf("%d prompts kept", len(in.prompts))
	}
	id := in.issuePrompt("p", labSession, "x", AgentPrompt{})
	in.prompts[id].expires = time.Now().Add(-time.Second)
	if _, err := in.consumePrompt("p", id, func(*promptRecord) error { return nil }); err == nil {
		t.Error("expired id accepted")
	}
}

func TestCleanText(t *testing.T) {
	if got := cleanText("a\r\nb\rc\x00\x1b[201~\u009b1m ok\t"); got != "a\nb\nc[201~1m ok\t" {
		t.Errorf("cleanText = %q", got)
	}
}

func TestSameQuestion(t *testing.T) {
	q := AgentPrompt{Kind: "select", Title: "Layout", Options: []PromptOption{{Index: 1, Label: "Stacked"}, {Index: 2, Label: "Row"}}}
	same := q
	if !sameQuestion(&same, &q) {
		t.Error("same question")
	}
	for name, edit := range map[string]func(p *AgentPrompt){
		"kind":         func(p *AgentPrompt) { p.Kind = "permission" },
		"text":         func(p *AgentPrompt) { p.Body = "Another question?" },
		"option count": func(p *AgentPrompt) { p.Options = p.Options[:1] },
		"option label": func(p *AgentPrompt) {
			p.Options = []PromptOption{{Index: 1, Label: "Stacked"}, {Index: 2, Label: "Grid"}}
		},
		"option index": func(p *AgentPrompt) {
			p.Options = []PromptOption{{Index: 1, Label: "Stacked"}, {Index: 3, Label: "Row"}}
		},
	} {
		other := q
		edit(&other)
		if sameQuestion(&other, &q) {
			t.Errorf("%s changed, still the same question", name)
		}
	}
	if sameQuestion(nil, &q) {
		t.Error("no dialog is not the same question")
	}
}

// imageAgent makes the box behave like Claude Code's: a path pasted alone
// becomes "[Image #N]" (N keeps counting), anything else is typed as is,
// Enter submits and C-c clears. delay holds each image token back.
func imageAgent(f *fakeWriter, delay time.Duration) {
	var mu sync.Mutex
	draft, count := "", 0
	f.onPaste = func(f *fakeWriter, text string) {
		mu.Lock()
		defer mu.Unlock()
		if filepath.IsAbs(strings.Trim(text, `"`)) { // C:\... on Windows
			count++
			if draft != "" {
				draft += " "
			}
			draft += "[Image #" + strconv.Itoa(count) + "]"
		} else {
			draft += strings.ReplaceAll(text, "\n", " ")
		}
		d := draft
		if delay > 0 {
			go func() { time.Sleep(delay); f.setScreen(boxScreen(d)) }()
			return
		}
		f.setScreen(boxScreen(d))
	}
	f.onKeys = func(f *fakeWriter, keys []string) {
		mu.Lock()
		defer mu.Unlock()
		if keys[0] == "Enter" || keys[0] == "C-c" {
			draft = ""
			f.setScreen(boxScreen(""))
		}
	}
}

func shortImageWait(t *testing.T) {
	shortConfirm(t)
	orig := agentImageWait
	agentImageWait = 150 * time.Millisecond
	t.Cleanup(func() { agentImageWait = orig })
}

// imageMux serves the agent routes with an upload store holding n images.
func imageMux(t *testing.T, f *fakeWriter, n int) (*http.ServeMux, []string, []string) {
	t.Helper()
	store := newTestUploadStore(t)
	var ids, paths []string
	for range n {
		u, err := store.save(bytes.NewReader(testImage(t, "image/png")), "image/png")
		if err != nil {
			t.Fatal(err)
		}
		ids, paths = append(ids, u.ID), append(paths, u.Path)
	}
	mux := http.NewServeMux()
	registerMuxRoutes(mux, f, newStreamTokenStore(), store, nil)
	return mux, ids, paths
}

func postMessage(t *testing.T, mux http.Handler, text string, ids []string) (int, map[string]any) {
	t.Helper()
	return postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": text, "cursor": cursorFor(testSessionID), "images": ids})
}

func TestMessageWithImages(t *testing.T) {
	shortImageWait(t)
	f := newFakeWriter()
	imageAgent(f, 0)
	mux, ids, paths := imageMux(t, f, 2)
	if code, body := postMessage(t, mux, "what is this?", ids); code != http.StatusNoContent {
		t.Fatalf("POST = %d %v", code, body)
	}
	want := []string{paths[0], paths[1], " what is this?"}
	if strings.Join(f.pasted, "|") != strings.Join(want, "|") {
		t.Errorf("pasted %q, want %q", f.pasted, want)
	}
	if len(f.keys) != 1 || f.keys[0][0] != "Enter" {
		t.Errorf("keys = %v", f.keys)
	}
}

func TestMessageImagesOnly(t *testing.T) {
	shortImageWait(t)
	f := newFakeWriter()
	imageAgent(f, 0)
	mux, ids, paths := imageMux(t, f, 1)
	if code, body := postMessage(t, mux, " \n", ids); code != http.StatusNoContent {
		t.Fatalf("POST = %d %v", code, body)
	}
	if len(f.pasted) != 1 || f.pasted[0] != paths[0] || len(f.keys) != 1 {
		t.Errorf("pasted %q keys %v", f.pasted, f.keys)
	}
}

// Five images, each token showing just inside the wait, still submit: the
// request's budget grows with the number of images.
func TestMessageFiveSlowImages(t *testing.T) {
	shortImageWait(t)
	f := newFakeWriter()
	imageAgent(f, 100*time.Millisecond)
	mux, ids, _ := imageMux(t, f, agentMaxImages)
	if code, body := postMessage(t, mux, "all of them", ids); code != http.StatusNoContent {
		t.Fatalf("POST = %d %v", code, body)
	}
	if len(f.pasted) != agentMaxImages+1 {
		t.Errorf("pasted %q", f.pasted)
	}
}

func TestMessageBudget(t *testing.T) {
	if got := messageBudget(0); got != 4*agentConfirmWait+muxTimeout {
		t.Errorf("no images = %v", got)
	}
	if got := messageBudget(5); got != 8*agentImageWait+muxTimeout {
		t.Errorf("5 images = %v", got)
	}
}

func TestMessageImageRequests(t *testing.T) {
	f := newFakeWriter()
	mux, ids, _ := imageMux(t, f, 1)
	missing := strings.Repeat("ab", 16)
	code, body := postMessage(t, mux, "hi", []string{ids[0], missing, "../../etc/passwd"})
	if code != http.StatusBadRequest || body["code"] != "invalid_request" {
		t.Errorf("bad ids = %d %v", code, body)
	}
	if bad, _ := body["images"].([]any); len(bad) != 2 || bad[0] != missing || bad[1] != "../../etc/passwd" {
		t.Errorf("bad ids returned = %v", body["images"])
	}
	six := []string{ids[0], ids[0], ids[0], ids[0], ids[0], ids[0]}
	if code, body := postMessage(t, mux, "hi", six); code != http.StatusBadRequest || body["code"] != "invalid_request" {
		t.Errorf("six images = %d %v", code, body)
	}
	// A server without an upload store never drops the images silently.
	if code, body := postMessage(t, agentMux(f), "hi", ids); code != http.StatusServiceUnavailable || body["code"] != "uploads_unavailable" {
		t.Errorf("no store = %d %v", code, body)
	}
	if len(f.pasted) != 0 {
		t.Errorf("pasted %q", f.pasted)
	}
}

func TestMessageImageFailures(t *testing.T) {
	working := labSession
	working.Status = "working"
	moved := labSession
	moved.Target = "%9"
	tests := []struct {
		name   string
		setup  func(f *fakeWriter)
		status int
		code   string
		clear  bool // C-c sent
		enter  bool
	}{
		{"first image never shows", func(f *fakeWriter) { f.onPaste = nil }, 409, "paste_not_confirmed", false, false},
		{"second image never shows: our token cleared", func(f *fakeWriter) {
			agent := f.onPaste
			f.onPaste = func(f *fakeWriter, text string) {
				if len(f.pasted) == 1 {
					agent(f, text)
				}
			}
		}, 409, "paste_not_confirmed", true, false},
		{"agent leaves the path as text", func(f *fakeWriter) {
			f.onPaste = func(f *fakeWriter, text string) { f.setScreen(boxScreen(text)) }
		}, 409, "partial_paste", false, false},
		{"someone typed meanwhile", func(f *fakeWriter) {
			agent := f.onPaste
			f.onPaste = func(f *fakeWriter, text string) {
				if len(f.pasted) == 1 {
					agent(f, text)
					return
				}
				f.setScreen(boxScreen("[Image #1] mine"))
			}
		}, 409, "partial_paste", false, false},
		{"text never shows: images cleared", func(f *fakeWriter) {
			agent := f.onPaste
			f.onPaste = func(f *fakeWriter, text string) {
				if !strings.HasPrefix(text, " ") {
					agent(f, text)
				}
			}
		}, 409, "paste_not_confirmed", true, false},
		{"session changes between images", func(f *fakeWriter) { f.sessions = []AgentSession{labSession, moved} }, 409, "partial_paste", false, false},
		{"agent starts working between images", func(f *fakeWriter) { f.sessions = []AgentSession{labSession, working} }, 409, "partial_paste", false, false},
		{"paste fails", func(f *fakeWriter) { f.pasteErr = errors.New("tmux gone") }, 502, "paste_not_confirmed", false, false},
		{"C-c does not clear", func(f *fakeWriter) {
			agent := f.onPaste
			f.onPaste = func(f *fakeWriter, text string) {
				if len(f.pasted) == 1 {
					agent(f, text)
				}
			}
			f.onKeys = nil
		}, 409, "partial_paste", true, false},
		{"C-c fails", func(f *fakeWriter) {
			agent := f.onPaste
			f.onPaste = func(f *fakeWriter, text string) {
				if len(f.pasted) == 1 {
					agent(f, text)
				}
			}
			f.keyErr = errors.New("tmux gone")
		}, 409, "partial_paste", true, false},
		{"enter does not submit", func(f *fakeWriter) {
			f.onKeys = func(*fakeWriter, []string) {}
		}, 502, "delivered_not_submitted", false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			shortImageWait(t)
			f := newFakeWriter()
			imageAgent(f, 0)
			tt.setup(f)
			mux, ids, _ := imageMux(t, f, 2)
			code, body := postMessage(t, mux, "hello", ids)
			if code != tt.status || body["code"] != tt.code {
				t.Errorf("POST = %d %v, want %d %s", code, body, tt.status, tt.code)
			}
			var clear, enter bool
			for _, k := range f.keys {
				clear = clear || k[0] == "C-c"
				enter = enter || k[0] == "Enter"
			}
			if clear != tt.clear || enter != tt.enter {
				t.Errorf("keys = %v", f.keys)
			}
		})
	}
}

// The screen changes behind abandon's back: nothing is cleared.
func TestAbandonChecksBeforeClearing(t *testing.T) {
	shortImageWait(t)
	a := newAgentAPI(nil)
	failure := fail(http.StatusConflict, "paste_not_confirmed", "x")
	f := newFakeWriter()
	f.nowErr = errors.New("gone")
	if err := a.abandon(context.Background(), f, "0", labSession, 1, "", failure); err != errPartialPaste {
		t.Errorf("session read fails = %v", err)
	}
	c := &captureErrWriter{fakeWriter: newFakeWriter()}
	if err := a.abandon(context.Background(), c, "0", labSession, 1, "", failure); err != errPartialPaste {
		t.Errorf("capture fails = %v", err)
	}
	f = newFakeWriter()
	f.screen = fixtureScreen(t, "2.1.286-permission-bash")
	if err := a.abandon(context.Background(), f, "0", labSession, 1, "", failure); err != errPartialPaste || len(f.keys) != 0 {
		t.Errorf("dialog open = %v keys %v", err, f.keys)
	}
}

type captureErrWriter struct{ *fakeWriter }

func (captureErrWriter) Capture(context.Context, string) (string, error) {
	return "", errors.New("capture failed")
}

// textPasteFails fails the paste of the text after the images.
type textPasteFails struct{ *fakeWriter }

func (w textPasteFails) Paste(ctx context.Context, target, text string) error {
	if strings.HasPrefix(text, " ") {
		return errors.New("tmux gone")
	}
	return w.fakeWriter.Paste(ctx, target, text)
}

func TestMessageTextPasteFailsAfterImages(t *testing.T) {
	shortImageWait(t)
	f := newFakeWriter()
	imageAgent(f, 0)
	_, _, paths := imageMux(t, f, 1)
	err := newAgentAPI(nil).sendMessage(context.Background(), textPasteFails{f}, "0", testSessionID, "hello", paths)
	var af *agentFailure
	if !errors.As(err, &af) || af.code != "paste_not_confirmed" || len(f.keys) != 1 || f.keys[0][0] != "C-c" {
		t.Errorf("err = %v keys = %v", err, f.keys)
	}
}

// The agent turns busy after the last image: the text is not pasted.
func TestMessageRechecksBeforeText(t *testing.T) {
	shortImageWait(t)
	working := labSession
	working.Status = "working"
	f := newFakeWriter()
	imageAgent(f, 0)
	f.sessions = []AgentSession{labSession, working}
	mux, ids, paths := imageMux(t, f, 1)
	code, body := postMessage(t, mux, "hello", ids)
	if code != http.StatusConflict || body["code"] != "partial_paste" {
		t.Errorf("POST = %d %v", code, body)
	}
	if len(f.pasted) != 1 || f.pasted[0] != paths[0] || len(f.keys) != 0 {
		t.Errorf("pasted %q keys %v", f.pasted, f.keys)
	}
}

// With images, the session read after a redraw is the only check before the
// first paste: an agent that started working meanwhile gets nothing.
func TestMessageImagesRecheckAfterRedraw(t *testing.T) {
	shortImageWait(t)
	working := labSession
	working.Status = "working"
	f := newFakeWriter()
	imageAgent(f, 0)
	f.screens = []string{"", ""}
	f.sessions = []AgentSession{labSession, working}
	mux, ids, _ := imageMux(t, f, 1)
	code, body := postMessage(t, mux, "hello", ids)
	if code != http.StatusConflict || body["code"] != "input_not_ready" {
		t.Errorf("POST = %d %v", code, body)
	}
	if len(f.pasted) != 0 || len(f.keys) != 0 {
		t.Errorf("pasted %q keys %v", f.pasted, f.keys)
	}
}

// A message with images may take longer than requestReadTimeout; the
// answer still arrives over a real connection (the work runs on a context
// the request's cancellation does not reach, and the deadline grows).
func TestMessageWithImagesOutlastsReadDeadline(t *testing.T) {
	shortImageWait(t)
	orig := requestReadTimeout
	requestReadTimeout = 150 * time.Millisecond
	t.Cleanup(func() { requestReadTimeout = orig })
	f := newFakeWriter()
	imageAgent(f, 100*time.Millisecond)
	mux, ids, _ := imageMux(t, f, 3)
	srv := httptest.NewServer(readDeadline(mux))
	defer srv.Close()
	b, _ := json.Marshal(map[string]any{"text": "hi", "cursor": cursorFor(testSessionID), "images": ids})
	res, err := http.Post(srv.URL+"/api/mux/panes/0/agent/message", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Errorf("POST = %d", res.StatusCode)
	}
}
