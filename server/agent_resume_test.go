package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// resumeMux is a historyMux whose new tabs open at any dir, recorded.
type resumeMux struct {
	*historyMux
	dirs     []string
	closeErr error
}

func (m *resumeMux) CloseTab(ctx context.Context, id, key string) error {
	if m.closeErr != nil {
		return m.closeErr
	}
	return m.historyMux.CloseTab(ctx, id, key)
}

// getAPI is a same-site GET of path with the test credentials.
func getAPI(t *testing.T, h http.Handler, path string) (int, map[string]any) {
	t.Helper()
	rec := serve(h, apiRequest("GET", path, ""))
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body
}

func (m *resumeMux) NewTaskTab(ctx context.Context, groupID, name, dir string) (taskTab, error) {
	m.mu.Lock()
	m.dirs = append(m.dirs, dir)
	m.mu.Unlock()
	return m.historyMux.NewTaskTab(ctx, groupID, name, m.taskFakeMux.dir)
}

type resumeFixture struct {
	*historyFixture
	m   *resumeMux
	h   http.Handler
	sub string
}

// newResumeFixture: a repo root with a Claude session at its root (histID1)
// and a Codex one in its "sub" dir (histID2).
func newResumeFixture(t *testing.T) *resumeFixture {
	t.Helper()
	shortTasks(t)
	fx := newHistoryFixture(t)
	gitInit(t, fx.root)
	sub := filepath.Join(fx.root, "sub")
	os.MkdirAll(sub, 0o755)
	now := time.Now()
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "first prompt", `{"type":"ai-title","aiTitle":"Login page"}`), now.Add(-time.Minute))
	writeHistoryRollout(t, fx.codex, histID2, sub, "codex prompt", now)
	m := &resumeMux{historyMux: newHistoryMux(t, fx.root)}
	return &resumeFixture{historyFixture: fx, m: m, h: historyServer(t, fx, m), sub: sub}
}

func (fx *resumeFixture) resume(t *testing.T, body map[string]any) (int, map[string]any) {
	t.Helper()
	rec := serve(fx.h, apiRequest("POST", "/api/mux/panes/0/agent/resume", templateJSON(t, body)))
	var res map[string]any
	json.Unmarshal(rec.Body.Bytes(), &res)
	return rec.Code, res
}

// setLive shows a pane "9" of tab "8" running id of agent.
func (fx *resumeFixture) setLive(agent, id string) {
	fx.m.mu.Lock()
	defer fx.m.mu.Unlock()
	fx.m.sessions["9"] = AgentSession{Agent: agent, ID: id}
	fx.m.sessions["7"] = AgentSession{Agent: agent, ID: "not-an-id"}
	fx.m.snap.Groups[0].Tabs = append(fx.m.snap.Groups[0].Tabs[:1], Tab{ID: "8", Panes: []Pane{
		{ID: "9", Agent: &AgentInfo{Name: agent}},
		{ID: "7", Agent: &AgentInfo{Name: agent}},
		{ID: "6", Agent: &AgentInfo{Name: "gemini"}},
		{ID: "5"},
	}})
}

func TestResumeCommand(t *testing.T) {
	id := histID1
	for _, tc := range []struct {
		kind, agent, dir, want string
		fork                   bool
	}{
		{shellPOSIX, "claude", "", "claude --resume " + id, false},
		{shellPOSIX, "claude", "", "claude --resume " + id + " --fork-session", true},
		{shellPOSIX, "codex", "", "codex resume --no-daemon " + id, false},
		{shellPOSIX, "claude", "/r/it's", `cd '/r/it'\''s' && claude --resume ` + id, false},
		{shellFish, "codex", `/r/a\b'c`, `cd '/r/a\\b\'c'; and codex resume --no-daemon ` + id, false},
		{shellPwsh, "claude", `C:\r\it's`, `Set-Location -LiteralPath 'C:\r\it''s'; claude --resume ` + id, false},
	} {
		if got := resumeCommand(tc.kind, tc.agent, id, tc.fork, tc.dir); got != tc.want {
			t.Errorf("resumeCommand(%s, %s, %q) = %q, want %q", tc.kind, tc.agent, tc.dir, got, tc.want)
		}
	}
}

func TestHistoryTranscriptRoute(t *testing.T) {
	fx := newResumeFixture(t)
	path := func(id, q string) string { return "/api/mux/panes/0/agent/history/" + id + "/transcript" + q }
	code, body := getAPI(t, fx.h, path(histID1, "?agent=claude&cursor=junk"))
	if code != 200 || body["sessionId"] != histID1 || len(body["entries"].([]any)) != 2 {
		t.Fatalf("claude = %d %v", code, body)
	}
	// An older page through before.
	if b, _ := body["before"].(string); b == "" {
		if code, _ := getAPI(t, fx.h, path(histID1, "?agent=claude&before="+url.QueryEscape(encodeCursor(agentCursor{Session: histID1})))); code != 200 {
			t.Errorf("before = %d", code)
		}
	}
	if code, body := getAPI(t, fx.h, path(histID2, "?agent=codex")); code != 200 || len(body["entries"].([]any)) != 1 {
		t.Errorf("codex = %d %v", code, body)
	}
	for _, tc := range []struct {
		path   string
		status int
		code   string
	}{
		{path(histID1, "?agent=gemini"), 400, "invalid_request"},
		{path("NOT-AN-ID", "?agent=claude"), 400, "invalid_request"},
		{path(histID1, "?agent=claude&before=junk"), 400, ""},
		// Another agent's id, or one never run here, reads as missing.
		{path(histID1, "?agent=codex"), 404, "session_not_found"},
		{path(histID3, "?agent=claude"), 404, "session_not_found"},
	} {
		code, body := getAPI(t, fx.h, tc.path)
		if code != tc.status || (tc.code != "" && body["code"] != tc.code) {
			t.Errorf("%s = %d %v", tc.path, code, body)
		}
	}
	if rec := serve(fx.h, viewRequest("GET", path(histID1, "?agent=claude"), "")); rec.Code != 200 {
		t.Errorf("view-only = %d", rec.Code)
	}
	req := apiRequest("GET", path(histID1, "?agent=claude"), "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(fx.h, req); rec.Code != 403 {
		t.Errorf("cross-site = %d", rec.Code)
	}
	if rec := serve(fx.h, apiRequest("POST", path(histID1, ""), "{}")); rec.Code != 405 {
		t.Errorf("POST = %d", rec.Code)
	}
	// A view-only client outside a repo reads nothing.
	plain := newHistoryFixture(t)
	writeClaudeSession(t, plain.claude, plain.root, histID1, claudeRows(plain.root, "main", "p"), time.Now())
	ph := historyServer(t, plain, newHistoryMux(t, plain.root))
	assertViewOnly(t, "no repo", serve(ph, viewRequest("GET", path(histID1, "?agent=claude"), "")))
}

// A view-only client reads an old session as it reads the Chat view: the
// words only, no tool call and no output.
func TestHistoryTranscriptViewOnlyText(t *testing.T) {
	fx := newResumeFixture(t)
	writeClaudeSession(t, fx.claude, fx.root, histID3, claudeRows(fx.root, "main", "run it",
		`{"type":"assistant","cwd":"`+fx.root+`","uuid":"t1","message":{"role":"assistant","content":[{"type":"tool_use","id":"x1","name":"Bash","input":{"command":"cat secret"}}]}}`,
		`{"type":"user","cwd":"`+fx.root+`","uuid":"t2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x1","content":"s3cret"}]}}`,
	), time.Now().Add(time.Minute))
	path := "/api/mux/panes/0/agent/history/" + histID3 + "/transcript?agent=claude"
	full := serve(fx.h, apiRequest("GET", path, ""))
	view := serve(fx.h, viewRequest("GET", path, ""))
	if !strings.Contains(full.Body.String(), "s3cret") || view.Code != 200 {
		t.Fatalf("full = %s, view = %d", full.Body, view.Code)
	}
	if strings.Contains(view.Body.String(), "s3cret") || strings.Contains(view.Body.String(), "cat secret") || !strings.Contains(view.Body.String(), "run it") {
		t.Errorf("view-only = %s", view.Body)
	}
}

func TestHistoryTranscriptFileGone(t *testing.T) {
	fx := newResumeFixture(t)
	// Listed, then removed before it is read.
	if _, ok := fx.findHistoryOf(t, histID2); !ok {
		t.Fatal("not listed")
	}
	os.Remove(fx.m.rolloutPath(t, fx.codex, histID2))
	if code, body := getAPI(t, fx.h, "/api/mux/panes/0/agent/history/"+histID2+"/transcript?agent=codex"); code != 404 || body["code"] != "session_not_found" {
		t.Errorf("gone = %d %v", code, body)
	}
}

func (fx *resumeFixture) findHistoryOf(t *testing.T, id string) (historySession, bool) {
	t.Helper()
	_, res, _ := listHistory(t, fx.h, "")
	for _, s := range res.Sessions {
		if s.ID == id {
			return s, true
		}
	}
	return historySession{}, false
}

func (m *resumeMux) rolloutPath(t *testing.T, codexHome, id string) string {
	t.Helper()
	matches, _ := filepath.Glob(filepath.Join(codexHome, "sessions", "*", "*", "*", "rollout-*-"+id+".jsonl"))
	if len(matches) != 1 {
		t.Fatalf("rollouts of %s: %v", id, matches)
	}
	return matches[0]
}

func TestResumeInTab(t *testing.T) {
	fx := newResumeFixture(t)
	code, body := fx.resume(t, map[string]any{"agent": "claude", "session": histID1, "where": "tab"})
	if code != 200 || body["tabId"] != "t1" || body["paneId"] != "p1" {
		t.Fatalf("resume = %d %v", code, body)
	}
	if got := fx.m.typedLines(); !slices.Equal(got, []string{"%1 claude --resume " + histID1}) {
		t.Errorf("typed %q", got)
	}
	// Named after the title, opened where the session ran.
	code, _ = fx.resume(t, map[string]any{"agent": "codex", "session": histID2, "where": "tab"})
	if code != 200 || !slices.Equal(fx.m.dirs, []string{fx.root, fx.sub}) {
		t.Errorf("codex = %d, dirs %v", code, fx.m.dirs)
	}
	if fx.m.tabNames[0] != "Login page" || fx.m.tabNames[1] != "codex prompt" {
		t.Errorf("tab names = %q", fx.m.tabNames)
	}
	if got := fx.m.typedLines(); got[1] != "%2 codex resume --no-daemon "+histID2 {
		t.Errorf("typed %q", got)
	}
}

func TestResumeTabFailures(t *testing.T) {
	fx := newResumeFixture(t)
	// An unsupported shell: the tab is closed again, nothing typed.
	fx.m.shell = "nu"
	code, body := fx.resume(t, map[string]any{"agent": "claude", "session": histID1, "where": "tab"})
	if code != 409 || body["code"] != "unsupported_shell" || !slices.Contains(fx.m.calls, "close t1") {
		t.Errorf("nu = %d %v %v", code, body, fx.m.calls)
	}
	// A shell that never waits at its prompt: the tab stays.
	fx.m.shell, fx.m.neverIdle = "bash", true
	code, body = fx.resume(t, map[string]any{"agent": "claude", "session": histID1, "where": "tab"})
	if code != 409 || body["code"] != "shell_busy" || slices.Contains(fx.m.calls, "close t2") {
		t.Errorf("busy = %d %v", code, body)
	}
	// A tab the backend cannot open; one closed that fails to close.
	fx.m.neverIdle, fx.m.tabErr = false, errors.New("boom")
	if code, _ := fx.resume(t, map[string]any{"agent": "claude", "session": histID1, "where": "tab"}); code != 500 {
		t.Errorf("tab error = %d", code)
	}
	fx.m.tabErr, fx.m.shell, fx.m.closeErr = nil, "nu", errors.New("close failed")
	if code, body := fx.resume(t, map[string]any{"agent": "claude", "session": histID1, "where": "tab"}); code != 409 || body["code"] != "unsupported_shell" {
		t.Errorf("close failure = %d %v", code, body)
	}
	if len(fx.m.typedLines()) != 0 {
		t.Errorf("typed %q", fx.m.typedLines())
	}
}

func TestResumeHere(t *testing.T) {
	fx := newResumeFixture(t)
	code, body := fx.resume(t, map[string]any{"agent": "claude", "session": histID1, "where": "here"})
	if code != 200 || body["tabId"] != "0" || body["paneId"] != "0" {
		t.Fatalf("here = %d %v", code, body)
	}
	// In the pane's dir no cd is typed; the Codex session ran in sub.
	fx.m.busy["0"] = false
	fx.resume(t, map[string]any{"agent": "codex", "session": histID2, "where": "here"})
	want := []string{"0 claude --resume " + histID1, "0 cd " + shellQuote(shellPOSIX, fx.sub) + " && codex resume --no-daemon " + histID2}
	if got := fx.m.typedLines(); !slices.Equal(got, want) {
		t.Errorf("typed %q, want %q", got, want)
	}
	if len(fx.m.interrupts) != 2 {
		t.Errorf("interrupts = %v", fx.m.interrupts)
	}
}

func TestResumeHereRefuses(t *testing.T) {
	fx := newResumeFixture(t)
	req := map[string]any{"agent": "claude", "session": histID1, "where": "here"}
	// A busy pane: nothing cleared, nothing typed.
	fx.m.busy["0"] = true
	if code, body := fx.resume(t, req); code != 409 || body["code"] != "pane_busy" || len(fx.m.interrupts) != 0 {
		t.Errorf("busy = %d %v", code, body)
	}
	// Busy once its line is cleared (a program started meanwhile).
	fx.m.busy["0"] = false
	fx.m.interrupt = func() error { fx.m.busy["0"] = true; return nil }
	if code, body := fx.resume(t, req); code != 409 || body["code"] != "pane_busy" {
		t.Errorf("busy after clear = %d %v", code, body)
	}
	fx.m.busy["0"] = false
	fx.m.interrupt = func() error { return errors.New("no") }
	if code, _ := fx.resume(t, req); code != 500 {
		t.Errorf("interrupt error = %d", code)
	}
	// The pane closed while its line was cleared.
	fx.m.interrupt = func() error { fx.m.idleErr = errTaskTargetGone; return nil }
	if code, body := fx.resume(t, req); code != 409 || body["code"] != "tab_gone" {
		t.Errorf("gone after clear = %d %v", code, body)
	}
	fx.m.interrupt, fx.m.idleErr = nil, nil
	fx.m.shell = "nu"
	if code, body := fx.resume(t, req); code != 409 || body["code"] != "unsupported_shell" {
		t.Errorf("nu = %d %v", code, body)
	}
	fx.m.shell, fx.m.idleErr = "bash", errTaskTargetGone
	if code, body := fx.resume(t, req); code != 409 || body["code"] != "tab_gone" {
		t.Errorf("gone = %d %v", code, body)
	}
	fx.m.idleErr = nil
	// Another request holds the pane's input.
	old := agentRequestMost
	agentRequestMost = 0
	t.Cleanup(func() { agentRequestMost = old })
	agent := fx.agentAPI(t)
	unlock := agent.input.lock("0")
	code, body := fx.resume(t, req)
	unlock()
	if code != 409 || body["code"] != "input_busy" {
		t.Errorf("locked = %d %v", code, body)
	}
	if len(fx.m.typedLines()) != 0 {
		t.Errorf("typed %q", fx.m.typedLines())
	}
}

// agentAPI is the fixture server's agent routes, found through the lock
// they share: a resume holding pane "0" locks this one.
func (fx *resumeFixture) agentAPI(t *testing.T) *agentAPI {
	t.Helper()
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass, cfg.TasksDir = true, "", t.TempDir()
	h, hub, _, agent, err := buildServerWith(cfg, fx.m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	fx.h = asRole(h, true)
	return agent
}

func TestResumeLiveSession(t *testing.T) {
	fx := newResumeFixture(t)
	fx.setLive("claude", histID1)
	_, res, _ := listHistory(t, fx.h, "")
	var live *historyLive
	for _, s := range res.Sessions {
		if s.ID == histID1 {
			live = s.Live
		} else if s.Live != nil {
			t.Errorf("%s marked live", s.ID)
		}
	}
	if live == nil || live.TabID != "8" || live.PaneID != "9" {
		t.Fatalf("live = %+v", live)
	}
	code, body := fx.resume(t, map[string]any{"agent": "claude", "session": histID1, "where": "tab"})
	if code != 409 || body["code"] != "session_live" || body["tabId"] != "8" || body["paneId"] != "9" {
		t.Errorf("live = %d %v", code, body)
	}
	// Forking makes a new session: allowed.
	code, _ = fx.resume(t, map[string]any{"agent": "claude", "session": histID1, "where": "tab", "fork": true})
	if code != 200 || fx.m.typedLines()[0] != "%1 claude --resume "+histID1+" --fork-session" {
		t.Errorf("fork = %d %q", code, fx.m.typedLines())
	}
}

func TestResumeGuards(t *testing.T) {
	fx := newResumeFixture(t)
	path := "/api/mux/panes/0/agent/resume"
	good := templateJSON(t, map[string]any{"agent": "claude", "session": histID1, "where": "tab"})
	for _, tc := range []struct {
		name   string
		req    *http.Request
		status int
	}{
		{"GET", apiRequest("GET", path, ""), 405},
		{"view-only tab", viewRequest("POST", path, good), 403},
		{"view-only here", viewRequest("POST", path, strings.Replace(good, "tab", "here", 1)), 403},
		{"cross-site", func() *http.Request {
			r := apiRequest("POST", path, good)
			r.Header.Set("Sec-Fetch-Site", "cross-site")
			r.Header.Set("Origin", "https://evil.test")
			return r
		}(), 403},
		{"bad JSON", apiRequest("POST", path, "{"), 400},
		{"too large", apiRequest("POST", path, `{"agent":"`+strings.Repeat("a", maxJSONBody)+`"}`), 413},
		{"agent", apiRequest("POST", path, strings.Replace(good, "claude", "gemini", 1)), 400},
		{"id", apiRequest("POST", path, strings.Replace(good, histID1, "x", 1)), 400},
		{"where", apiRequest("POST", path, strings.Replace(good, "tab", "window", 1)), 400},
		{"codex fork", apiRequest("POST", path, templateJSON(t, map[string]any{"agent": "codex", "session": histID2, "where": "tab", "fork": true})), 400},
		{"unknown session", apiRequest("POST", path, strings.Replace(good, histID1, histID3, 1)), 404},
		{"unknown pane", apiRequest("POST", "/api/mux/panes/zz/agent/resume", good), 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if rec := serve(fx.h, tc.req); rec.Code != tc.status {
				t.Fatalf("= %d %s", rec.Code, rec.Body)
			}
		})
	}
	if len(fx.m.typedLines()) != 0 {
		t.Fatalf("typed %q", fx.m.typedLines())
	}
	// The handler refuses a view-only client itself too.
	assertViewOnly(t, "in handler", serve(asRole(fx.h, false), viewRequest("POST", path, good)))
	// A backend that cannot run tasks.
	plain := historyServer(t, fx.historyFixture, &commandsFakeMux{filesFakeMux: filesFakeMux{dir: fx.root, files: true}})
	if rec := serve(plain, apiRequest("POST", path, good)); rec.Code != http.StatusNotImplemented {
		t.Errorf("no taskMux = %d", rec.Code)
	}
	// A snapshot that fails.
	fx.m.err = errors.New("down")
	if rec := serve(fx.h, apiRequest("POST", path, good)); rec.Code < 500 {
		t.Errorf("snapshot error = %d", rec.Code)
	}
}

func TestResumeDir(t *testing.T) {
	root := realTemp(t)
	sub := filepath.Join(root, "sub")
	os.MkdirAll(sub, 0o755)
	writeFile(t, filepath.Join(root, "file"), "x")
	for cwd, want := range map[string]string{
		sub:                         sub,
		root:                        root,
		filepath.Join(root, "gone"): root,
		filepath.Join(root, "file"): root,
		"/elsewhere":                root,
		filepath.Join(root, "a\nb"): root,
	} {
		if got := resumeDir(root, historySession{absCwd: cwd}); got != want {
			t.Errorf("resumeDir(%q) = %q, want %q", cwd, got, want)
		}
	}
}

func TestResumeTabName(t *testing.T) {
	if got := resumeTabName(historySession{Title: strings.Repeat("é", 40)}); got != strings.Repeat("é", 32) {
		t.Errorf("long = %q", got)
	}
	if got := resumeTabName(historySession{Agent: "codex", ID: histID1}); got != "codex:aaaaaaaa" {
		t.Errorf("untitled = %q", got)
	}
}

// Files the server user cannot read are passed over, or fail the read.
func TestHistoryUnreadable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs Unix permissions and a user they apply to")
	}
	fx := newResumeFixture(t)
	p := fx.m.rolloutPath(t, fx.codex, histID2)
	// Listed while readable, then the read fails.
	if _, ok := fx.findHistoryOf(t, histID2); !ok {
		t.Fatal("not listed")
	}
	os.Chmod(p, 0)
	t.Cleanup(func() { os.Chmod(p, 0o600) })
	if code, _ := getAPI(t, fx.h, "/api/mux/panes/0/agent/history/"+histID2+"/transcript?agent=codex"); code != 500 {
		t.Errorf("unreadable transcript = %d", code)
	}
	// A new scan skips it, and a day dir it cannot list.
	h := newHistoryAPI()
	if got, _ := h.scanCodex(fx.codex, fx.root); len(got) != 0 {
		t.Errorf("unreadable rollout listed: %+v", got)
	}
	day := filepath.Dir(p)
	os.Chmod(day, 0)
	t.Cleanup(func() { os.Chmod(day, 0o755) })
	if got, _ := h.scanCodex(fx.codex, fx.root); len(got) != 0 {
		t.Errorf("unreadable day listed: %+v", got)
	}
}

func TestResumeRootProblems(t *testing.T) {
	fx := newResumeFixture(t)
	req := map[string]any{"agent": "claude", "session": histID1, "where": "tab"}
	// The pane's directory is gone.
	gone := &resumeMux{historyMux: newHistoryMux(t, filepath.Join(fx.root, "gone"))}
	fx.h = historyServer(t, fx.historyFixture, gone)
	if code, _ := fx.resume(t, req); code < 400 {
		t.Errorf("gone dir = %d", code)
	}
	if runtime.GOOS == "windows" {
		return
	}
	// A root no shell line can name.
	odd := filepath.Join(realTemp(t), "a\nb")
	os.MkdirAll(odd, 0o755)
	writeClaudeSession(t, fx.claude, odd, histID3, claudeRows(odd, "main", "p"), time.Now())
	fx.h = historyServer(t, fx.historyFixture, &resumeMux{historyMux: newHistoryMux(t, odd)})
	if code, body := fx.resume(t, map[string]any{"agent": "claude", "session": histID3, "where": "tab"}); code != 400 || body["code"] != "invalid_root" {
		t.Errorf("odd root = %d %v", code, body)
	}
}
