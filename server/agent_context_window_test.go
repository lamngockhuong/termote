package main

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestClaudeWindowFromArgs(t *testing.T) {
	for _, c := range []struct {
		args []string
		want int64
	}{
		{[]string{"node", "/usr/bin/claude", "--model", "opus[1m]"}, claudeWindowLarge},
		{[]string{"claude", "--model=sonnet[1M]"}, claudeWindowLarge},
		{[]string{"claude", "--model=sonnet"}, claudeWindowDefault},
		{[]string{"claude", "--model", "claude-opus-4-1"}, claudeWindowDefault},
		{[]string{"claude", "--model", " haiku "}, claudeWindowDefault},
		{[]string{"claude", "--resume", "x"}, 0},
		{[]string{"claude", "--model"}, 0},
		{[]string{"claude", "--model="}, 0},
		{[]string{"claude", "--model", "--resume"}, 0},
		{[]string{"claude", "--", "--model", "opus[1m]"}, 0},
		{nil, 0},
	} {
		if got := claudeWindowFromArgs(c.args); got != c.want {
			t.Errorf("claudeWindowFromArgs(%q) = %d, want %d", c.args, got, c.want)
		}
	}
}

func TestContextShare(t *testing.T) {
	for _, c := range []struct {
		name                         string
		agent                        string
		tokens, sessionWin, entryWin int64
		window                       int64
		pct                          float64
		exact                        bool
	}{
		{"claude argv 200k", "claude", 144_000, claudeWindowDefault, 0, claudeWindowDefault, 72, true},
		{"claude argv 1m", "claude", 144_000, claudeWindowLarge, 0, claudeWindowLarge, 14.4, true},
		{"claude unknown", "claude", 144_000, 0, 0, claudeWindowDefault, 72, false},
		{"claude unknown past 200k", "claude", 300_000, 0, 0, claudeWindowLarge, 30, true},
		{"claude argv 200k then /model 1m", "claude", 250_000, claudeWindowDefault, 0, claudeWindowLarge, 25, true},
		{"claude rounding", "claude", 1, claudeWindowDefault, 0, claudeWindowDefault, 0, true},
		{"claude full", "claude", claudeWindowLarge * 2, claudeWindowLarge, 0, claudeWindowLarge, 100, true},
		{"codex", "codex", 50_307, 0, 258_400, 258_400, 15.5, true},
		{"codex under baseline", "codex", 9_000, 0, 258_400, 258_400, 0, true},
		{"codex over window", "codex", 300_000, 0, 258_400, 258_400, 100, true},
		{"codex tiny window", "codex", 5_000, 0, codexBaselineTokens, codexBaselineTokens, 100, true},
		{"codex no window", "codex", 50_000, 0, 0, 0, 0, false},
	} {
		w, pct, exact := contextShare(c.agent, c.tokens, c.sessionWin, c.entryWin)
		if w != c.window || pct != c.pct || exact != c.exact {
			t.Errorf("%s: = %d, %v, %v; want %d, %v, %v", c.name, w, pct, exact, c.window, c.pct, c.exact)
		}
	}
	// Codex shows round(100 - used) as "% context left": 84% for the
	// fixture's last request, within 1 of what the overview sends.
	if _, pct, _ := contextShare("codex", 50_307, 0, 258_400); 100-pct < 83.5 || 100-pct > 84.5 {
		t.Errorf("codex left = %v, want 84", 100-pct)
	}
}

func TestCodexAccountHome(t *testing.T) {
	env := map[string]string{}
	getenv := func(k string) string { return env[k] }
	if got := codexAccountHome(AgentSession{CodexHome: "/h/.codex-work"}, getenv, "/h"); got != "/h/.codex-work" {
		t.Errorf("own home = %q", got)
	}
	if got := codexAccountHome(AgentSession{}, getenv, "/h"); got != filepath.Join("/h", ".codex") {
		t.Errorf("default = %q", got)
	}
	env["CODEX_HOME"] = "/srv/codex"
	if got := codexAccountHome(AgentSession{}, getenv, "/h"); got != "/srv/codex" {
		t.Errorf("server CODEX_HOME = %q", got)
	}
}

func TestAccountKey(t *testing.T) {
	a, b := accountKey("/home/someone/.codex"), accountKey("/home/someone/.codex-work")
	if !regexp.MustCompile(`^[0-9a-f]{12}$`).MatchString(a) || a == b {
		t.Errorf("keys = %q, %q", a, b)
	}
	if accountKey("/home/someone/.codex/") != a {
		t.Error("a trailing slash changed the key")
	}
	if strings.Contains(a, "someone") {
		t.Errorf("key names the path: %q", a)
	}
}

func parseCodexUsageFixture(t *testing.T) []TranscriptEntry {
	t.Helper()
	b, err := os.ReadFile("testdata/codex/rollout-usage-0.162.1.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	entries, _ := codexJournal{}.Parse(bytes.NewReader(b), 0)
	return entries
}

func TestCodexTokenCountUsage(t *testing.T) {
	entries := parseCodexUsageFixture(t)
	// token_count rows add no entry and leave the transcript as it was.
	if len(entries) != 3 || entries[0].Role != "user" || entries[0].usage != nil {
		t.Fatalf("entries = %+v", entries)
	}
	first, last := entries[1].usage, entries[2].usage
	if first == nil || first.contextTokens != 20_120 || first.window != 258_400 || first.noContext {
		t.Errorf("first = %+v", first)
	}
	// The last turn's request, then a limits-only row that keeps it.
	if last == nil || last.contextTokens != 50_307 || last.window != 258_400 || last.noContext {
		t.Fatalf("last = %+v", last)
	}
	l := last.limits
	if l == nil || l.plan != "team" || l.ts != "2026-10-14T01:06:10.000Z" || len(l.windows) != 2 {
		t.Fatalf("limits = %+v", l)
	}
	want := []usageWindow{
		{UsedPercent: 3.5, WindowMinutes: 300, ResetsAt: "2026-10-14T06:04:30Z"},
		{UsedPercent: 0.5, WindowMinutes: 10080, ResetsAt: "2026-10-21T01:04:30Z"},
	}
	for i, w := range want {
		if l.windows[i] != w {
			t.Errorf("window %d = %+v, want %+v", i, l.windows[i], w)
		}
	}
}

func TestAddCodexTokenCount(t *testing.T) {
	row := func(payload string) []byte {
		return []byte(`{"timestamp":"2026-10-14T01:00:00Z","type":"event_msg","payload":{"type":"token_count",` + payload + "}}\n")
	}
	ctx := `"info":{"last_token_usage":{"total_tokens":30000},"model_context_window":100000}`
	limits := func(windows string) string {
		return `"rate_limits":{` + windows + `,"plan_type":null}`
	}
	fresh := func() []TranscriptEntry {
		return []TranscriptEntry{{Role: "assistant"}, {Role: "user"}}
	}

	// No assistant entry before the row: skipped.
	user := []TranscriptEntry{{Role: "user"}}
	addCodexTokenCount(user, row(ctx))
	addCodexTokenCount(nil, row(ctx))
	if user[0].usage != nil {
		t.Error("usage on a user entry")
	}
	for name, line := range map[string][]byte{
		"bad json":         []byte(`{"type":"event_msg","payload":{"type":"token_count"`),
		"not an event":     []byte(`{"type":"response_item","payload":{"type":"token_count"}}`),
		"other payload":    []byte(`{"type":"event_msg","payload":{"type":"agent_message","message":"token_count"}}`),
		"nothing in it":    row(`"info":null,"rate_limits":null`),
		"no window":        row(`"info":{"last_token_usage":{"total_tokens":5},"model_context_window":0}`),
		"no last usage":    row(`"info":{"model_context_window":100000}`),
		"no limit windows": row(limits(`"primary":null,"secondary":{"used_percent":5,"window_minutes":0,"resets_at":1}`)),
	} {
		e := fresh()
		addCodexTokenCount(e, line)
		if e[0].usage != nil {
			t.Errorf("%s: usage = %+v", name, e[0].usage)
		}
	}

	// Context only, then limits only: the second keeps the first's context.
	e := fresh()
	addCodexTokenCount(e, row(ctx))
	if u := e[0].usage; u == nil || u.contextTokens != 30_000 || u.window != 100_000 || u.limits != nil {
		t.Fatalf("context = %+v", u)
	}
	addCodexTokenCount(e, row(`"info":null,`+limits(`"primary":{"used_percent":140,"window_minutes":300,"resets_at":0},"secondary":null`)))
	u := e[0].usage
	if u.contextTokens != 30_000 || u.limits == nil || u.limits.plan != "" || len(u.limits.windows) != 1 {
		t.Fatalf("limits = %+v", u)
	}
	// Clamped to 100, no reset time when none was recorded.
	if w := u.limits.windows[0]; w.UsedPercent != 100 || w.ResetsAt != "" {
		t.Errorf("window = %+v", w)
	}

	// Limits without context make a usage that names no context.
	e = fresh()
	addCodexTokenCount(e, row(`"info":null,`+limits(`"primary":{"used_percent":-3,"window_minutes":300,"resets_at":1}`)))
	if u := e[0].usage; u == nil || !u.noContext || u.limits.windows[0].UsedPercent != 0 {
		t.Errorf("limits only = %+v", u)
	}

	// A time that cannot be read: no limits, the context still counts.
	e = fresh()
	bad := bytes.Replace(row(ctx+","+limits(`"primary":{"used_percent":1,"window_minutes":300,"resets_at":1}`)),
		[]byte("2026-10-14T01:00:00Z"), []byte("yesterday"), 1)
	addCodexTokenCount(e, bad)
	if u := e[0].usage; u == nil || u.limits != nil || u.contextTokens != 30_000 {
		t.Errorf("bad time = %+v", u)
	}
}
