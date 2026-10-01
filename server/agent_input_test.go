package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
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
	pasted   []string
	keys     [][]string
	keyErr   error
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
	return f.screen, nil
}

func (f *fakeWriter) Paste(_ context.Context, _ string, text string) error {
	f.mu.Lock()
	f.pasted = append(f.pasted, text)
	hook := f.onPaste
	f.mu.Unlock()
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
	registerMuxRoutes(mux, m, newStreamTokenStore())
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
		{"pane changed before enter", func(f *fakeWriter) { f.sessions = []AgentSession{labSession, moved} }, "", 502, "delivered_not_submitted", true, false},
		{"agent started working before enter", func(f *fakeWriter) { f.sessions = []AgentSession{labSession, working} }, "", 502, "delivered_not_submitted", true, false},
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
	f.setScreen(fixtureScreen(t, "2.1.286-ask-wizard"))
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
		f.screen = fixtureScreen(t, "2.1.286-ask-multi")
		mux := agentMux(f)
		getPrompt(t, mux, "0")
		if code, _ := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": "", "choice": 1}); code != 409 || len(f.keys) != 0 {
			t.Errorf("unsupported = %d", code)
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
