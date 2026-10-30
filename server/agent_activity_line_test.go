package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Screens "2.1.312-working-*" and "2.1.312-done" were recorded in tmux
// (capture-pane -p -e, 100x40) during one Claude Code turn, "0.164.0-working-*"
// during one Codex turn, paths sanitised.

func TestClaudeActivityScreens(t *testing.T) {
	for name, want := range map[string]*AgentActivity{
		"2.1.312-working-hooks-start":       {Label: "Bloviating", Phase: "hooks", Detail: "running SessionStart hooks… 2/3"},
		"2.1.312-working-no-parens":         {Label: "Bloviating"},
		"2.1.312-working-thinking":          {Label: "Incubating", Elapsed: 5, Phase: "thinking", Detail: "thinking"},
		"2.1.312-working-deep-thought":      {Label: "Incubating", Elapsed: 50, Phase: "thinking", Detail: "deep in thought"},
		"2.1.312-working-hooks-stop-tokens": {Label: "Incubating", Elapsed: 73, Phase: "hooks", Detail: "running Stop hooks… 0/3", Tokens: "15.8k"},
		"2.1.312-done":                      nil,
		// "running PostToolUse hook · 6s · ↓ 267 tokens · thought for 1s"
		"2.1.310-working-queued": {Label: "Coalescing", Elapsed: 6, Phase: "hooks", Detail: "running PostToolUse hook", Tokens: "267"},
	} {
		sc := readClaudeScreen(fixtureScreen(t, name))
		if sc.input != inputEmpty {
			t.Errorf("%s: input = %q, want the box read as empty", name, sc.input)
		}
		got := sc.activity
		if want == nil {
			if got != nil {
				t.Errorf("%s: activity = %+v, want none", name, got)
			}
			continue
		}
		if got == nil {
			t.Errorf("%s: no activity, want %+v", name, want)
			continue
		}
		// The elapsed count of a recorded screen is checked only when the
		// table names it; the recordings fix it.
		if want.Elapsed == 0 {
			got.Elapsed = 0
		}
		if *got != *want {
			t.Errorf("%s: activity = %+v, want %+v", name, *got, *want)
		}
	}
}

func TestClaudeActivityLines(t *testing.T) {
	rule := strings.Repeat("─", 40)
	for name, tc := range map[string]struct {
		above string
		want  *AgentActivity
	}{
		"tokens while writing":     {"✶ Pondering… (12s · ↓ 1.2k tokens)", &AgentActivity{Label: "Pondering", Elapsed: 12, Tokens: "1.2k"}},
		"hours":                    {"* Pondering… (1h 2m 3s · still thinking)", &AgentActivity{Label: "Pondering", Elapsed: 3723, Phase: "thinking", Detail: "still thinking"}},
		"custom words":             {"✻ Reading the docs… (3s)", &AgentActivity{Label: "Reading the docs", Elapsed: 3}},
		"unknown item kept":        {"✻ Pondering… (3s · reading files)", &AgentActivity{Label: "Pondering", Elapsed: 3, Detail: "reading files"}},
		"no esc hint":              {"✻ Pondering… (3s · esc to interrupt)", &AgentActivity{Label: "Pondering", Elapsed: 3}},
		"one hook, thought before": {"✽ Coalescing… (running PostToolUse hook · 6s · ↓ 267 tokens · thought for 1s)", &AgentActivity{Label: "Coalescing", Elapsed: 6, Phase: "hooks", Detail: "running PostToolUse hook", Tokens: "267"}},
		"writing after thinking":   {"✻ Pondering… (12s · ↓ 1.2k tokens · thought for 9s)", &AgentActivity{Label: "Pondering", Elapsed: 12, Tokens: "1.2k"}},
		"over effort row":          {"✻ Pondering… (3s)\n\n" + strings.Repeat(" ", 60) + "◐ medium · /effort", &AgentActivity{Label: "Pondering", Elapsed: 3}},
		"turn done":                {"✻ Sautéed for 1m 14s · done 4:17 AM", nil},
		"done, shells running":     {"✻ Cogitated for 5m 36s · done 12:26 AM · 2 shells still running", &AgentActivity{Label: "Cogitated", Elapsed: 336, Background: "2 shells"}},
		"done, shell and monitor":  {"✻ Brewed for 4s · 1 shell, 1 monitor still running", &AgentActivity{Label: "Brewed", Elapsed: 4, Background: "1 shell, 1 monitor"}},
		"done over effort row":     {"✻ Brewed for 1h 2m · done 9:01 PM · 3 background tasks still running\n\n" + strings.Repeat(" ", 60) + "◐ medium · /effort", &AgentActivity{Label: "Brewed", Elapsed: 3720, Background: "3 background tasks"}},
		"done, no duration":        {"✻ Brewed for a while · 2 shells still running", nil},
		"done, nothing named":      {"✻ Brewed for 4s ·  still running", nil},
		"answer still running":     {"* the build for 2s · it is still running", nil},
		"answer text":              {"* a bullet the answer ends with", nil},
		"answer ellipsis":          {"- Wait… (later)", nil},
		"indented":                 {"  ✻ Pondering… (3s)", nil},
		"too far up":               {"✻ Pondering… (3s)\n\n\n\n\n", nil},
	} {
		sc := readClaudeScreen(tc.above + "\n" + rule + "\n❯ \n" + rule + "\n")
		got := sc.activity
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Errorf("%s: activity = %+v, want %+v", name, got, tc.want)
		}
	}
	// A dialog has no input box, so no activity either.
	if sc := readClaudeScreen(fixtureScreen(t, "2.1.286-permission-bash")); sc.activity != nil {
		t.Errorf("dialog: activity = %+v", sc.activity)
	}
}

func TestCodexActivityScreens(t *testing.T) {
	for name, want := range map[string]AgentActivity{
		"0.164.0-working-mcp-start": {Label: "Starting MCP servers (1/2): codex_apps"},
		"0.164.0-working-plain":     {Label: "Working"},
		"0.164.0-working-hooks":     {Label: "Working", Phase: "hooks", Detail: "Running hooks"},
	} {
		sc := readCodexScreen(codexCapture(t, name))
		if !sc.working || sc.activity == nil {
			t.Errorf("%s: working %v, activity %+v", name, sc.working, sc.activity)
			continue
		}
		got := *sc.activity
		got.Elapsed = 0
		if got != want {
			t.Errorf("%s: activity = %+v, want %+v", name, got, want)
		}
	}
	if sc := readCodexScreen(codexCapture(t, "0.159.3-input-empty")); sc.working || sc.activity != nil {
		t.Errorf("idle: working %v, activity %+v", sc.working, sc.activity)
	}
}

func TestCodexActivityLine(t *testing.T) {
	for line, want := range map[string]*AgentActivity{
		"• Working (1m 5s • esc to interrupt)":                                {Label: "Working", Elapsed: 65},
		"• Working (2s • esc to interrupt) · 1 background terminal running":   {Label: "Working", Elapsed: 2, Detail: "1 background terminal running"},
		"• Booting MCP server: codex_apps (3s • esc to interrupt)":            {Label: "Booting MCP server: codex_apps", Elapsed: 3},
		"• Working (esc to interrupt)":                                        nil,
		"• Working (2s • esc to interrupt) · Running hooks · something after": {Label: "Working", Elapsed: 2, Phase: "hooks", Detail: "Running hooks"},
	} {
		got := codexActivityOf(line)
		if (got == nil) != (want == nil) || (got != nil && *got != *want) {
			t.Errorf("%q = %+v, want %+v", line, got, want)
		}
	}
	// A line of another shape still says Codex works.
	working, a := codexWorking([]screenLine{{text: "• Working (esc to interrupt)"}})
	if !working || a != nil {
		t.Errorf("unparsed working line = %v %+v", working, a)
	}
}

func TestParseElapsed(t *testing.T) {
	for s, want := range map[string]int{"0s": 0, "59s": 59, "1m 0s": 60, "1m 14s": 74, "2m": 120, "1h 2m 3s": 3723} {
		if got, ok := parseElapsed(s); !ok || got != want {
			t.Errorf("%q = %d %v, want %d", s, got, ok, want)
		}
	}
	for _, s := range []string{"", "thinking", "5", "1x", "s", "99999999999999999999s", "2000000h"} {
		if got, ok := parseElapsed(s); ok {
			t.Errorf("%q = %d, want no duration", s, got)
		}
	}
}

func TestClipActivity(t *testing.T) {
	if got := clipActivity(" a\x1b\x07b "); got != "ab" {
		t.Errorf("control chars = %q", got)
	}
	long := strings.Repeat("ạ", activityMaxText+5)
	if got := clipActivity(long); len([]rune(got)) != activityMaxText || !strings.HasSuffix(got, "…") {
		t.Errorf("long = %d runes %q", len([]rune(got)), got)
	}
}

func TestPromptRouteActivity(t *testing.T) {
	f := newFakeWriter()
	f.screen = fixtureScreen(t, "2.1.312-working-hooks-stop-tokens")
	mux := agentMux(f)
	activityOf := func(h http.Handler, r *http.Request) map[string]any {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		var body map[string]any
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &body) != nil {
			t.Fatalf("GET prompt = %d %s", rec.Code, rec.Body)
		}
		if _, ok := body["activity"]; !ok {
			t.Fatalf("no activity field in %v", body)
		}
		a, _ := body["activity"].(map[string]any)
		return a
	}
	get := func() *http.Request {
		return httptest.NewRequest(http.MethodGet, "/api/mux/panes/0/agent/prompt", nil)
	}
	a := activityOf(mux, get())
	if a["label"] != "Incubating" || a["tokens"] != "15.8k" || a["phase"] != "hooks" {
		t.Errorf("activity = %v", a)
	}
	// A view-only client reads the same line.
	r := get()
	r = r.WithContext(withAuth(r.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
	if v := activityOf(mux, r); v["label"] != "Incubating" {
		t.Errorf("view-only activity = %v", v)
	}
	f.setScreen(boxScreen(""))
	time.Sleep(agentCacheTTL)
	if a := activityOf(mux, get()); a != nil {
		t.Errorf("idle activity = %v, want null", a)
	}
}
