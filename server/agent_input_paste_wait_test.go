package main

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// shortPasteWait shortens the scaled wait of a pasted text.
func shortPasteWait(t *testing.T, perChar, most time.Duration) {
	orig, origMax := agentPasteWaitPerChar, agentPasteWaitMax
	agentPasteWaitPerChar, agentPasteWaitMax = perChar, most
	t.Cleanup(func() { agentPasteWaitPerChar, agentPasteWaitMax = orig, origMax })
}

func withPsmux(t *testing.T, on bool) {
	orig := tmuxIsPsmux
	tmuxIsPsmux = on
	t.Cleanup(func() { tmuxIsPsmux = orig })
}

func TestPasteConfirmWait(t *testing.T) {
	long, huge := strings.Repeat("é", 3000), strings.Repeat("a", 10000)
	scaled := agentConfirmWait + 3000*agentPasteWaitPerChar
	tests := []struct {
		name  string
		wr    agentWriter
		psmux bool
		agent string
		text  string
		want  time.Duration
	}{
		{"codex scales by characters", newFakeWriter(), false, "codex", long, scaled},
		{"codex short", newFakeWriter(), false, "codex", "hi", agentConfirmWait + 2*agentPasteWaitPerChar},
		{"codex capped", newFakeWriter(), false, "codex", huge, agentPasteWaitMax},
		{"codex on psmux", tmuxMux{}, true, "codex", long, scaled},
		{"claude on psmux scales", tmuxMux{}, true, "claude", long, scaled},
		{"claude on psmux pointer", &tmuxMux{}, true, "claude", huge, agentPasteWaitMax},
		{"claude on tmux fixed", tmuxMux{}, false, "claude", huge, agentConfirmWait},
		{"claude on herdr fixed", newFakeWriter(), true, "claude", huge, agentConfirmWait},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			withPsmux(t, tt.psmux)
			if got := pasteConfirmWait(tt.wr, tt.agent, tt.text); got != tt.want {
				t.Errorf("wait = %v, want %v", got, tt.want)
			}
		})
	}
	if scaled != 20*time.Second {
		t.Errorf("3000 characters = %v, want 20s", scaled)
	}
}

// The route's budget outlasts every wait of a text-only message, the
// scaled one included, and keeps the images' budget.
func TestMessageBudgetCoversTextWait(t *testing.T) {
	if got := messageBudget(0, agentConfirmWait); got != 4*agentConfirmWait+muxTimeout {
		t.Errorf("short text = %v", got)
	}
	if got := messageBudget(0, agentPasteWaitMax); got != 3*agentConfirmWait+agentPasteWaitMax+muxTimeout {
		t.Errorf("long text = %v", got)
	}
	if got := messageBudget(5, agentConfirmWait); got != 8*agentImageWait+muxTimeout {
		t.Errorf("5 images = %v", got)
	}
	if got := messageBudget(1, agentPasteWaitMax); got != 3*agentImageWait+agentPasteWaitMax+muxTimeout {
		t.Errorf("1 image and a long text = %v", got)
	}
	// The longest text may keep arriving at the rate Codex took under load
	// (17 ms a character), and the route's budget covers that wait.
	longest := strings.Repeat("a", agentMaxText)
	if got := pasteGrowMost(longest); got < time.Duration(agentMaxText)*17*time.Millisecond {
		t.Errorf("longest text grows for %v", got)
	}
	if got := messageBudget(0, pasteGrowMost(longest)); got < pasteGrowMost(longest)+3*agentConfirmWait {
		t.Errorf("longest text budget = %v", got)
	}
	if got := pasteGrowMost("hi"); got != textConfirmWait("hi")+2*agentPasteGrowPerChar-2*agentPasteWaitPerChar {
		t.Errorf("short text grows for %v", got)
	}
}

// A pasted text that shows past agentConfirmWait: Codex waits for it, Claude
// Code on tmux or herdr does not.
func TestMessageSlowPasteShows(t *testing.T) {
	shortConfirm(t)
	shortPasteWait(t, 2*time.Millisecond, time.Second)
	withPsmux(t, false)
	text := strings.Repeat("a", 300) // Codex: 150 ms + 600 ms
	const delay = 400 * time.Millisecond
	slow := func(f *fakeWriter, shown string) {
		time.AfterFunc(delay, func() { f.setScreen(shown) })
	}

	codex := newCodexWriter()
	codex.onPaste = func(f *fakeWriter, text string) { slow(f, codexBox(text)) }
	if code, body := postJSON(t, agentMux(codex), "/api/mux/panes/0/agent/message", map[string]string{"text": text, "cursor": codexCursor()}); code != http.StatusNoContent {
		t.Fatalf("codex POST = %d %v", code, body)
	}
	if len(codex.keys) != 1 || codex.keys[0][0] != "Enter" {
		t.Errorf("codex keys %v", codex.keys)
	}

	claude := newFakeWriter()
	claude.onPaste = func(f *fakeWriter, text string) { slow(f, boxScreen(text)) }
	code, body := postJSON(t, agentMux(claude), "/api/mux/panes/0/agent/message", map[string]string{"text": text, "cursor": cursorFor(testSessionID)})
	if code != http.StatusConflict || body["code"] != "paste_not_confirmed" || len(claude.keys) != 0 {
		t.Fatalf("claude POST = %d %v keys %v", code, body, claude.keys)
	}
	time.Sleep(delay) // the late redraw lands before the test ends
}

// growingPaste makes Codex's box show text a step characters at a time,
// every 20 ms, the way Codex on Windows takes a long paste, then fold it
// into its token; stopAt > 0 stalls the growth after that many characters.
func growingPaste(f *fakeWriter, text string, step, stopAt int) {
	runes := []rune(text)
	go func() {
		for n := step; ; n += step {
			if stopAt > 0 && n > stopAt {
				return
			}
			if n >= len(runes) {
				f.setScreen(codexBox("[Pasted Content " + strconv.Itoa(len(runes)) + " chars]"))
				return
			}
			f.setScreen(codexBox(string(runes[:n])))
			time.Sleep(20 * time.Millisecond)
		}
	}()
}

// A paste still arriving past the scaled wait is waited for while the box
// keeps growing (#410: a long message to Codex on Windows, or under load),
// and refused once the box stalls.
func TestMessagePasteWaitsWhileGrowing(t *testing.T) {
	shortConfirm(t)
	shortPasteWait(t, time.Millisecond, 300*time.Millisecond)
	withPsmux(t, false)
	text := strings.Repeat("a", 1200) // 40 steps of 30: about 800 ms

	f := newCodexWriter()
	f.onPaste = func(f *fakeWriter, text string) { growingPaste(f, text, 30, 0) }
	if code, body := postJSON(t, agentMux(f), "/api/mux/panes/0/agent/message", map[string]string{"text": text, "cursor": codexCursor()}); code != http.StatusNoContent {
		t.Fatalf("growing POST = %d %v", code, body)
	}
	if len(f.keys) != 1 || f.keys[0][0] != "Enter" {
		t.Errorf("keys %v", f.keys)
	}

	stalled := newCodexWriter()
	stalled.onPaste = func(f *fakeWriter, text string) { growingPaste(f, text, 30, 600) }
	start := time.Now()
	code, body := postJSON(t, agentMux(stalled), "/api/mux/panes/0/agent/message", map[string]string{"text": text, "cursor": codexCursor()})
	if code != http.StatusConflict || body["code"] != "paste_not_confirmed" || len(stalled.keys) != 0 {
		t.Fatalf("stalled POST = %d %v keys %v", code, body, stalled.keys)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("stalled paste refused after %v, want soon after it stalls", took)
	}
}
