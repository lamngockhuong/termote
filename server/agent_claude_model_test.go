package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// modelRow is a model row as Claude Code 2.1.272 writes it.
func modelRow(id string) string {
	return `{"isSidechain":false,"attachment":{"type":"model","identity":{"modelId":"` + id +
		`","marketingName":"Opus 5 (1M context)","knowledgeCutoff":"May 2026"}},"type":"attachment",` +
		`"uuid":"016fa461-c666-499e-a8f3-8bc755d68285","timestamp":"2026-09-15T09:14:01.733Z"}` + "\n"
}

func TestClaudeModelOf(t *testing.T) {
	for _, c := range []struct{ line, want string }{
		{modelRow("claude-opus-5[1m]"), "claude-opus-5[1m]"},
		{`{"type":"user","message":{"content":"no model here"}}`, ""},
		// The word alone, in a row of another kind or broken
		{`{"type":"user","message":{"content":"\"identity\""}}`, ""},
		{`{"type":"attachment","attachment":{"type":"skill","identity":{"modelId":"x"}}}`, ""},
		{`{"type":"attachment","attachment":{"type":"model","identity":`, ""},
	} {
		if got := claudeModelOf([]byte(c.line)); got != c.want {
			t.Errorf("claudeModelOf(%.60q) = %q, want %q", c.line, got, c.want)
		}
	}
}

func TestClaudeWindowOfModel(t *testing.T) {
	for _, c := range []struct {
		model  string
		window int64
		ok     bool
	}{
		{"", 0, false},
		{"claude-opus-5[1m]", claudeWindowLarge, true},
		{"claude-sonnet-4-6[1M]", claudeWindowLarge, true},
		// 1M of their own, without [1m]
		{"claude-opus-5", claudeWindowLarge, true},
		{"claude-opus-5-5", claudeWindowLarge, true},
		{"claude-sonnet-5-5", claudeWindowLarge, true},
		{"claude-haiku-5-5", claudeWindowLarge, true},
		{"claude-fable-5-1", claudeWindowLarge, true},
		{"claude-opus-4-7", claudeWindowLarge, true},
		{"Claude-Opus-6", claudeWindowLarge, true},
		// 200k unless opted in
		{"claude-opus-4-6", claudeWindowDefault, true},
		{"claude-opus-4-1-20250805", claudeWindowDefault, true},
		{"claude-opus-4-20250514", claudeWindowDefault, true},
		{"claude-sonnet-4-6", claudeWindowDefault, true},
		{"claude-haiku-4-5-20251001", claudeWindowDefault, true},
		{"us.anthropic.claude-sonnet-4-5-20250929-v1:0", claudeWindowDefault, true},
		// Nothing to read
		{"opus", 0, false},
		{"claude-3-5-sonnet-20241022", 0, false},
		{"<synthetic>", 0, false},
	} {
		if w, ok := claudeWindowOfModel(c.model); w != c.window || ok != c.ok {
			t.Errorf("claudeWindowOfModel(%q) = %d, %v; want %d, %v", c.model, w, ok, c.window, c.ok)
		}
	}
}

func TestClaudeModelsScan(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	user := `{"type":"user","message":{"content":"hi"}}` + "\n"
	writeFile(t, path, user+modelRow("claude-opus-5[1m]")+user)
	cm := newClaudeModels()
	model := func() string {
		t.Helper()
		m, err := cm.model(path)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	if got := model(); got != "claude-opus-5[1m]" {
		t.Fatalf("start = %q", got)
	}
	sc := cm.files[path]
	end := sc.off

	// A row still being written is left for later; a /model switch, once
	// whole, is read on from where the last scan ended.
	row := modelRow("claude-opus-5")
	appendFile(t, path, row[:40])
	if got := model(); got != "claude-opus-5[1m]" || sc.off != end {
		t.Errorf("partial row = %q at %d", got, sc.off)
	}
	appendFile(t, path, row[40:])
	if got := model(); got != "claude-opus-5" || sc.off != end+int64(len(row)) {
		t.Errorf("switch = %q at %d", got, sc.off)
	}

	// A line longer than the buffer is skipped undecoded, even a model
	// row, and only once it is whole.
	long := modelRow("claude-long[1m]" + strings.Repeat("x", claudeModelRowMax))
	end = sc.off
	appendFile(t, path, long[:claudeModelRowMax+10])
	if got := model(); got != "claude-opus-5" || sc.off != end {
		t.Errorf("partial long line = %q at %d", got, sc.off)
	}
	appendFile(t, path, long[claudeModelRowMax+10:]+modelRow("claude-sonnet-5"))
	if got := model(); got != "claude-sonnet-5" {
		t.Errorf("after a long line = %q", got)
	}

	// A file cut short, or another file in its place, is read again.
	writeFile(t, path, modelRow("claude-cut[1m]"))
	if got := model(); got != "claude-cut[1m]" {
		t.Errorf("cut short = %q", got)
	}
	other := filepath.Join(t.TempDir(), "o.jsonl")
	writeFile(t, other, user+user+user+user+user+user)
	if err := os.Rename(other, path); err != nil {
		t.Fatal(err)
	}
	if got := model(); got != "" && runtime.GOOS != "windows" {
		// Windows has no inode: the same name is the same file.
		t.Errorf("replaced = %q", got)
	}

	if _, err := cm.model(filepath.Join(t.TempDir(), "none")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing = %v", err)
	}
}

func TestClaudeModelsBusy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	writeFile(t, path, modelRow("claude-opus-5[1m]"))
	cm := newClaudeModels()
	if m, _ := cm.model(path); m == "" {
		t.Fatal("no model")
	}
	// A read while another scans does without the model, never waits.
	sc := cm.files[path]
	sc.mu.Lock()
	m, err := cm.model(path)
	sc.mu.Unlock()
	if m != "" || !errors.Is(err, errClaudeModelBusy) {
		t.Errorf("busy = %q, %v", m, err)
	}
}

func TestClaudeModelsForget(t *testing.T) {
	cm := newClaudeModels()
	for i := range claudeModelFilesMax {
		cm.files[strings.Repeat("p", i+1)] = &claudeModelScan{}
	}
	path := filepath.Join(t.TempDir(), "s.jsonl")
	writeFile(t, path, modelRow("m"))
	if m, _ := cm.model(path); m != "m" || len(cm.files) != 1 {
		t.Errorf("past the cap: %q, %d files", m, len(cm.files))
	}
}

// The overview takes the window from the transcript's model row, over what
// argv chose, and from argv when the transcript names none.
func TestOverviewClaudeModelRow(t *testing.T) {
	dir := t.TempDir()
	usage, _ := os.ReadFile("testdata/claude/transcript-usage.jsonl")
	path := writeTranscript(t, dir, testSessionID, modelRow("claude-opus-5[1m]")+string(usage))
	m := &overviewFakeMux{filesFakeMux: filesFakeMux{fakeMux: fakeMux{snap: agentPanes(1)}},
		s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir, ClaudeWindow: claudeWindowDefault}, found: true}
	mux, agent := newOverviewServer(t, m)
	serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/snapshot", nil))
	usageOf := func() *overviewUsage {
		t.Helper()
		agent.reads = newTTLCache[transcriptResponse](0)
		rec := serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/overview", nil))
		var res overviewResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
			t.Fatal(err)
		}
		return res.Panes[0].Usage
	}
	if u := usageOf(); u == nil || u.ContextWindow != claudeWindowLarge || !u.Exact {
		t.Errorf("model row = %+v", u)
	}

	writeFile(t, path, string(usage))
	m.s.ClaudeWindow = claudeWindowLarge
	if u := usageOf(); u == nil || u.ContextWindow != claudeWindowLarge || !u.Exact {
		t.Errorf("argv only = %+v", u)
	}

	if runtime.GOOS != "windows" && os.Getuid() != 0 {
		// A transcript the scan cannot open: argv still counts.
		if err := os.Chmod(path, 0); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(path, 0o600) })
		if w := agent.claudeWindow(m.s); w != claudeWindowLarge {
			t.Errorf("unreadable = %d", w)
		}
	}
	// A scan still running elsewhere: argv counts, nothing is logged.
	real, _ := filepath.EvalSymlinks(path)
	sc := agent.claudeModels.files[real]
	sc.mu.Lock()
	w := agent.claudeWindow(m.s)
	sc.mu.Unlock()
	if w != claudeWindowLarge {
		t.Errorf("busy = %d", w)
	}
	if w := agent.claudeWindow(AgentSession{Agent: "claude", ClaudeWindow: 7}); w != 7 {
		t.Errorf("no transcript = %d", w)
	}
}
