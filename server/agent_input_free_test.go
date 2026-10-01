package main

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

// freeScript drives a fakeWriter through recorded screens: a key or a
// pasted text moves it from the screen it is on to the one recorded after.
type freeScript struct {
	t      *testing.T
	f      *fakeWriter
	mux    *http.ServeMux
	on     string
	keys   map[string]map[string]string
	pastes map[string]map[string]string
	extra  map[string]string // screens made by hand, by name
}

func (s *freeScript) screen(name string) string {
	if sc, ok := s.extra[name]; ok {
		return sc
	}
	return fixtureScreen(s.t, name)
}

func (s *freeScript) move(table map[string]map[string]string, in string) {
	if to, ok := table[s.on][in]; ok {
		s.on = to
		s.f.setScreen(s.screen(to))
	}
}

func newFreeScript(t *testing.T, first string, keys, pastes map[string]map[string]string, extra map[string]string) *freeScript {
	s := &freeScript{t: t, f: newFakeWriter(), on: first, keys: keys, pastes: pastes, extra: extra}
	s.f.session.Status = "blocked"
	s.f.screen = s.screen(first)
	s.f.onKeys = func(_ *fakeWriter, k []string) { s.move(s.keys, k[0]) }
	s.f.onPaste = func(_ *fakeWriter, text string) { s.move(s.pastes, text) }
	s.mux = agentMux(s.f)
	return s
}

func (s *freeScript) promptID() string {
	s.t.Helper()
	p := getPrompt(s.t, s.mux, "0")
	if p == nil || p["promptId"] == nil || p["freeText"] == nil {
		s.t.Fatalf("on %s: prompt = %v", s.on, p)
	}
	return p["promptId"].(string)
}

func (s *freeScript) answer(id string, choice any) (int, map[string]any) {
	return postJSON(s.t, s.mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": choice})
}

func (s *freeScript) sent() string {
	var out []string
	for _, k := range s.f.keys {
		out = append(out, k[0])
	}
	return strings.Join(out, " ")
}

const (
	freeOpen      = "2.1.286-ask-free-open"
	wizardOpen    = "2.1.286-ask-wizard-free-open"
	multiOpen     = "2.1.286-ask-wizard-multi-free-open"
	multiPointer2 = "multi-pointer-2"
	multiOnChat   = "multi-pointer-chat"
)

var (
	freeKeys = map[string]map[string]string{
		freeOpen:                              {"4": "2.1.286-ask-free-pointer"},
		"2.1.286-ask-free-typed":              {"Enter": "2.1.286-ask-free-after-enter"},
		"2.1.286-ask-free-typed-vi":           {"Enter": "2.1.286-ask-free-after-enter"},
		wizardOpen:                            {"3": "2.1.286-ask-wizard-free-pointer"},
		"2.1.286-ask-wizard-free-typed":       {"Enter": "2.1.286-ask-wizard-free-after-enter"},
		multiOpen:                             {"Down": multiPointer2},
		multiPointer2:                         {"Down": "2.1.286-ask-wizard-multi-free-pointer"},
		"2.1.286-ask-wizard-multi-free-typed": {"Up": "2.1.286-ask-wizard-multi-free-up"},
	}
	freePastes = map[string]map[string]string{
		"2.1.286-ask-free-pointer":              {"Purple please": "2.1.286-ask-free-typed", "Tím nhạt": "2.1.286-ask-free-typed-vi"},
		"2.1.286-ask-wizard-free-pointer":       {"Medium": "2.1.286-ask-wizard-free-typed"},
		"2.1.286-ask-wizard-multi-free-pointer": {"Honey": "2.1.286-ask-wizard-multi-free-typed"},
	}
)

// freeExtra moves the pointer of the recorded multiSelect tab, for the row
// between two recorded screens and for a pointer below the free option.
func freeExtra(t *testing.T) map[string]string {
	open := fixtureScreen(t, multiOpen)
	off := strings.Replace(open, "\x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1.", "  \x1b[38;5;246m1.", 1)
	two := strings.Replace(off, "  \x1b[38;5;246m2.", "❯ \x1b[38;5;246m2.", 1)
	chat := strings.Replace(off, "  4. Chat about this", "❯ 4. Chat about this", 1)
	if off == open || two == off || chat == off {
		t.Fatal("pointer move did not apply")
	}
	return map[string]string{multiPointer2: two, multiOnChat: chat}
}

func TestAnswerFreeText(t *testing.T) {
	shortConfirm(t)
	run := func(first string) *freeScript {
		return newFreeScript(t, first, freeKeys, freePastes, freeExtra(t))
	}

	t.Run("single choice", func(t *testing.T) {
		for _, text := range []string{"Purple please", "Tím nhạt"} {
			s := run(freeOpen)
			if code, body := s.answer(s.promptID(), map[string]string{"text": text}); code != http.StatusNoContent {
				t.Fatalf("%q: answer = %d %v (on %s)", text, code, body, s.on)
			}
			if s.sent() != "4 Enter" || len(s.f.pasted) != 1 || s.f.pasted[0] != text || s.on != "2.1.286-ask-free-after-enter" {
				t.Errorf("%q: keys=%q pasted=%q on=%s", text, s.sent(), s.f.pasted, s.on)
			}
		}
	})
	t.Run("wizard tab moves to the next", func(t *testing.T) {
		s := run(wizardOpen)
		if code, body := s.answer(s.promptID(), map[string]string{"text": "Medium"}); code != http.StatusNoContent {
			t.Fatalf("answer = %d %v (on %s)", code, body, s.on)
		}
		if s.sent() != "3 Enter" {
			t.Errorf("keys = %q", s.sent())
		}
		time.Sleep(agentCacheTTL)
		p := getPrompt(t, s.mux, "0")
		if p == nil || p["title"] != "What drink do you prefer?" || p["promptId"] == nil || p["freeText"] == nil {
			t.Errorf("next tab = %v", p)
		}
	})
	t.Run("multiSelect tab keeps the text ticked", func(t *testing.T) {
		s := run(multiOpen)
		if code, body := s.answer(s.promptID(), map[string]string{"text": "Honey"}); code != http.StatusNoContent {
			t.Fatalf("answer = %d %v (on %s)", code, body, s.on)
		}
		if s.sent() != "Down Down Up" || s.on != "2.1.286-ask-wizard-multi-free-up" {
			t.Errorf("keys = %q on %s", s.sent(), s.on)
		}
		// The tab is answerable again right away: Next, or untick the text.
		time.Sleep(agentCacheTTL)
		p := getPrompt(t, s.mux, "0")
		opts, _ := p["options"].([]any)
		if p == nil || p["kind"] != "multiselect" || p["promptId"] == nil || p["freeText"] != nil || len(opts) != 4 {
			t.Fatalf("tab after = %v", p)
		}
		if o := opts[2].(map[string]any); o["label"] != "Honey" || o["checked"] != true {
			t.Errorf("free option = %v", o)
		}
	})

	t.Run("refused text sends nothing and keeps the id", func(t *testing.T) {
		s := run(freeOpen)
		id := s.promptID()
		for _, c := range []struct {
			text   string
			status int
			code   string
		}{
			{"", 400, "invalid_text"},
			{"   ", 400, "invalid_text"},
			{"two\nlines", 400, "invalid_text"},
			{"tab\there", 400, "invalid_text"},
			{"esc\x1b[201~", 400, "invalid_text"},
			{"c1\u0085", 400, "invalid_text"},
			{strings.Repeat("ạ", agentMaxFreeText/3+1), 413, "text_too_long"},
		} {
			code, body := s.answer(id, map[string]string{"text": c.text})
			if code != c.status || body["code"] != c.code {
				t.Errorf("%q = %d %v", c.text, code, body)
			}
			if c.code == "text_too_long" && body["limit"] != float64(agentMaxFreeText) {
				t.Errorf("limit = %v", body["limit"])
			}
		}
		if len(s.f.keys) != 0 || len(s.f.pasted) != 0 {
			t.Errorf("sent keys=%v pasted=%v", s.f.keys, s.f.pasted)
		}
		if code, _ := s.answer(id, map[string]string{"text": strings.Repeat("a", agentMaxFreeText)}); code == 400 || code == 413 {
			t.Errorf("text at the limit refused: %d", code)
		}
	})
	t.Run("a dialog without a free-text option refuses text", func(t *testing.T) {
		f := newFakeWriter()
		f.session.Status = "blocked"
		f.screen = fixtureScreen(t, "2.1.286-permission-bash")
		mux := agentMux(f)
		id := getPrompt(t, mux, "0")["promptId"].(string)
		code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": id, "choice": map[string]string{"text": "yes"}})
		if code != 400 || body["code"] != "invalid_choice" || len(f.keys) != 0 {
			t.Errorf("permission = %d %v %v", code, body, f.keys)
		}
	})

	t.Run("pointer does not move", func(t *testing.T) {
		s := newFreeScript(t, freeOpen, map[string]map[string]string{}, freePastes, nil)
		code, body := s.answer(s.promptID(), map[string]string{"text": "Purple please"})
		if code != 502 || body["code"] != "answer_not_confirmed" || len(s.f.pasted) != 0 || s.sent() != "4" {
			t.Errorf("= %d %v keys=%q pasted=%v", code, body, s.sent(), s.f.pasted)
		}
	})
	t.Run("another dialog after the digit", func(t *testing.T) {
		s := newFreeScript(t, freeOpen, map[string]map[string]string{freeOpen: {"4": "2.1.286-permission-bash"}}, freePastes, nil)
		code, body := s.answer(s.promptID(), map[string]string{"text": "Purple please"})
		p, _ := body["prompt"].(map[string]any)
		if code != 409 || body["code"] != "prompt_changed" || p == nil || p["kind"] != "permission" || len(s.f.pasted) != 0 {
			t.Errorf("= %d %v pasted=%v", code, body, s.f.pasted)
		}
	})
	t.Run("field not empty under the pointer", func(t *testing.T) {
		s := newFreeScript(t, freeOpen, map[string]map[string]string{freeOpen: {"4": "2.1.286-ask-free-typed"}}, freePastes, nil)
		code, body := s.answer(s.promptID(), map[string]string{"text": "Purple please"})
		if code != 502 || body["code"] != "answer_not_confirmed" || len(s.f.pasted) != 0 {
			t.Errorf("= %d %v pasted=%v", code, body, s.f.pasted)
		}
	})
	t.Run("text never shows", func(t *testing.T) {
		s := newFreeScript(t, freeOpen, freeKeys, map[string]map[string]string{}, nil)
		code, body := s.answer(s.promptID(), map[string]string{"text": "Purple please"})
		if code != 502 || body["code"] != "text_not_confirmed" || s.sent() != "4" {
			t.Errorf("= %d %v keys=%q", code, body, s.sent())
		}
	})
	t.Run("other text shows", func(t *testing.T) {
		s := newFreeScript(t, freeOpen, freeKeys, map[string]map[string]string{"2.1.286-ask-free-pointer": {"Purple": "2.1.286-ask-free-typed"}}, nil)
		code, body := s.answer(s.promptID(), map[string]string{"text": "Purple"})
		if code != 502 || body["code"] != "text_not_confirmed" || s.sent() != "4" {
			t.Errorf("= %d %v keys=%q", code, body, s.sent())
		}
	})
	moved := labSession
	moved.Status = "blocked"
	moved.PID = 43
	blocked := labSession
	blocked.Status = "blocked"
	t.Run("agent changes before the text", func(t *testing.T) {
		s := run(freeOpen)
		id := s.promptID()
		s.f.sessions = []AgentSession{blocked, moved}
		code, body := s.answer(id, map[string]string{"text": "Purple please"})
		if code != 409 || body["code"] != "target_changed" || len(s.f.pasted) != 0 || s.sent() != "4" {
			t.Errorf("= %d %v keys=%q pasted=%v", code, body, s.sent(), s.f.pasted)
		}
	})
	t.Run("agent changes before Enter", func(t *testing.T) {
		s := run(freeOpen)
		id := s.promptID()
		s.f.sessions = []AgentSession{blocked, blocked, moved}
		code, body := s.answer(id, map[string]string{"text": "Purple please"})
		if code != 502 || body["code"] != "text_not_confirmed" || s.sent() != "4" || len(s.f.pasted) != 1 {
			t.Errorf("= %d %v keys=%q", code, body, s.sent())
		}
	})
	t.Run("Enter does not close", func(t *testing.T) {
		keys := map[string]map[string]string{freeOpen: freeKeys[freeOpen]}
		s := newFreeScript(t, freeOpen, keys, freePastes, nil)
		code, body := s.answer(s.promptID(), map[string]string{"text": "Purple please"})
		if code != 502 || body["code"] != "answer_not_confirmed" || s.sent() != "4 Enter" {
			t.Errorf("= %d %v keys=%q", code, body, s.sent())
		}
	})
	t.Run("multiSelect pointer moved below the option", func(t *testing.T) {
		s := run(multiOpen)
		id := s.promptID()
		s.f.setScreen(freeExtra(t)[multiOnChat]) // the same signature
		code, body := s.answer(id, map[string]string{"text": "Honey"})
		if code != 409 || body["code"] != "prompt_changed" || len(s.f.keys) != 0 {
			t.Errorf("= %d %v keys=%q", code, body, s.sent())
		}
	})
	t.Run("multiSelect pointer skips a row", func(t *testing.T) {
		keys := map[string]map[string]string{multiOpen: {"Down": "2.1.286-ask-wizard-multi-free-pointer"}}
		s := newFreeScript(t, multiOpen, keys, freePastes, freeExtra(t))
		code, body := s.answer(s.promptID(), map[string]string{"text": "Honey"})
		if code != 502 || body["code"] != "answer_not_confirmed" || s.sent() != "Down" || len(s.f.pasted) != 0 {
			t.Errorf("= %d %v keys=%q", code, body, s.sent())
		}
	})
	t.Run("multiSelect Up does not leave the text", func(t *testing.T) {
		keys := map[string]map[string]string{multiOpen: freeKeys[multiOpen], multiPointer2: freeKeys[multiPointer2]}
		s := newFreeScript(t, multiOpen, keys, freePastes, freeExtra(t))
		code, body := s.answer(s.promptID(), map[string]string{"text": "Honey"})
		if code != 502 || body["code"] != "answer_not_confirmed" || s.sent() != "Down Down Up" {
			t.Errorf("= %d %v keys=%q", code, body, s.sent())
		}
	})
	t.Run("backend errors stop the answer", func(t *testing.T) {
		gone := errors.New("pane gone")
		for name, setup := range map[string]func(s *freeScript){
			"digit": func(s *freeScript) { s.f.keyErr = gone },
			"paste": func(s *freeScript) { s.f.pasteErr = gone },
			"enter": func(s *freeScript) {
				hook := s.f.onPaste
				s.f.onPaste = func(f *fakeWriter, text string) {
					hook(f, text)
					f.mu.Lock()
					f.keyErr = gone
					f.mu.Unlock()
				}
			},
		} {
			s := run(freeOpen)
			id := s.promptID()
			setup(s)
			if code, _ := s.answer(id, map[string]string{"text": "Purple please"}); code < 500 {
				t.Errorf("%s: = %d", name, code)
			}
		}
	})
	t.Run("a promptId reused for the same tab holds the latest read", func(t *testing.T) {
		// The pointer is not part of the signature: on "Chat about this"
		// the tab has no FreeText, back on an option above it has.
		extra := freeExtra(t)
		s := run(multiOpen)
		s.f.setScreen(extra[multiOnChat])
		first := getPrompt(t, s.mux, "0")
		if first == nil || first["promptId"] == nil || first["freeText"] != nil {
			t.Fatalf("on chat = %v", first)
		}
		s.f.setScreen(fixtureScreen(t, multiOpen))
		time.Sleep(agentCacheTTL)
		id := s.promptID()
		if id != first["promptId"] {
			t.Fatalf("id %v, want the same %v", id, first["promptId"])
		}
		if code, body := s.answer(id, map[string]string{"text": "Honey"}); code != http.StatusNoContent {
			t.Errorf("answer = %d %v", code, body)
		}
	})
	t.Run("a paste token is not the text", func(t *testing.T) {
		token := strings.Replace(fixtureScreen(t, "2.1.286-ask-free-typed"), "Purple please", "[Pasted text #1]", 1)
		s := newFreeScript(t, freeOpen, freeKeys, map[string]map[string]string{"2.1.286-ask-free-pointer": {"Purple please": "token"}}, map[string]string{"token": token})
		code, body := s.answer(s.promptID(), map[string]string{"text": "Purple please"})
		if code != 502 || body["code"] != "text_not_confirmed" || s.sent() != "4" {
			t.Errorf("= %d %v keys=%q", code, body, s.sent())
		}
	})
}
