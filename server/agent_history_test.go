package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	histID1 = "aaaaaaaa-0000-4000-8000-000000000001"
	histID2 = "aaaaaaaa-0000-4000-8000-000000000002"
	histID3 = "aaaaaaaa-0000-4000-8000-000000000003"
)

// claudeRows makes a transcript: a user prompt in cwd on branch, then the
// extra rows given.
func claudeRows(cwd, branch, prompt string, extra ...string) string {
	q := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	rows := []string{
		`{"type":"mode","mode":"normal"}`,
		`{"type":"user","cwd":` + q(cwd) + `,"gitBranch":` + q(branch) + `,"uuid":"u1","message":{"role":"user","content":` + q(prompt) + `}}`,
		`{"type":"assistant","cwd":` + q(cwd) + `,"gitBranch":` + q(branch) + `,"uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}`,
	}
	return strings.Join(append(rows, extra...), "\n") + "\n"
}

// writeClaudeSession writes a transcript under claudeDir's project dir for
// dir and sets its mtime.
func writeClaudeSession(t *testing.T, claudeDir, projectDir, id, body string, mtime time.Time) string {
	t.Helper()
	p := filepath.Join(claudeDir, "projects", claudeProjectName(projectDir), id+".jsonl")
	writeFile(t, p, body)
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return p
}

func setPathsFold(t *testing.T, v bool) {
	t.Helper()
	old := pathsFold
	pathsFold = v
	t.Cleanup(func() { pathsFold = old })
}

func realTemp(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestClaudeProjectName(t *testing.T) {
	for in, want := range map[string]string{
		"/home/u/.herdr/x":     "-home-u--herdr-x",
		"/home/u/my_app.v2":    "-home-u-my-app-v2",
		`C:\Users\u\proj`:      "C--Users-u-proj",
		"/home/u/dự án":        "-home-u-d---n",
		"/home/u/\U0001F600ok": "-home-u---ok",
	} {
		if got := claudeProjectName(in); got != want {
			t.Errorf("claudeProjectName(%q) = %q, want %q", in, got, want)
		}
	}
	enc := claudeProjectName("/r/app")
	for name, want := range map[string]bool{
		enc: true, enc + "-sub": true, enc + "x": false, "-r-other": false,
		strings.Repeat("a", claudeLongDirName): true,
	} {
		if got := claudeProjectMatch(name, enc); got != want {
			t.Errorf("claudeProjectMatch(%q) = %v", name, got)
		}
	}
	setPathsFold(t, true)
	if !claudeProjectMatch(strings.ToUpper(enc), enc) {
		t.Error("a name differing only in case should match where paths fold")
	}
}

func TestHistoryTitleAndBranch(t *testing.T) {
	if got := historyTitle("  fix\tthe\x1b[31m bug\x07\u200b\nnow  "); got != "fix the bug now" {
		t.Errorf("title = %q", got)
	}
	long := historyTitle(strings.Repeat("é", 300))
	if !strings.HasSuffix(long, "…") || len(long) > historyTitleMax+len("…") {
		t.Errorf("long title = %d bytes", len(long))
	}
	if historyBranch("main") != "main" || historyBranch("a\x00b") != "" || historyBranch(strings.Repeat("b", 300)) != "" {
		t.Error("historyBranch")
	}
}

func parseClaudeFile(t *testing.T, body string) (historyFile, bool) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "s.jsonl")
	writeFile(t, p, body)
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, _ := f.Stat()
	return parseClaudeHistory(f, fi.Size(), histID1)
}

func TestParseClaudeHistoryTitles(t *testing.T) {
	// The first prompt, when nothing else names the session.
	got, ok := parseClaudeFile(t, claudeRows("/r", "main", "add a login page"))
	if !ok || got.title != "add a login page" || got.src != titlePrompt || got.cwd != "/r" || got.branch != "main" {
		t.Fatalf("prompt = %+v %v", got, ok)
	}
	// The agent's title beats the prompt; the user's beats both, wherever
	// it is in the file; the latest of each kind counts.
	got, _ = parseClaudeFile(t, claudeRows("/r", "main", "p",
		`{"type":"custom-title","customTitle":"old name"}`,
		`{"type":"ai-title","aiTitle":"Login page"}`,
		`{"type":"custom-title","customTitle":"mine"}`,
		`{"type":"ai-title","aiTitle":"Later title"}`))
	if got.title != "mine" || got.src != titleCustom {
		t.Errorf("custom = %+v", got)
	}
	got, _ = parseClaudeFile(t, claudeRows("/r", "main", "p", `{"type":"ai-title","aiTitle":"Login page"}`))
	if got.title != "Login page" || got.src != titleAI {
		t.Errorf("ai = %+v", got)
	}
	// Meta and sidechain prompts, reminders and blank texts are no prompt.
	got, _ = parseClaudeFile(t, strings.Join([]string{
		`{"type":"user","cwd":"/r","isMeta":true,"message":{"content":"meta"}}`,
		`{"type":"user","cwd":"/r","isSidechain":true,"message":{"content":"side"}}`,
		`{"type":"user","cwd":"/r","message":{"content":"<system-reminder>x</system-reminder>"}}`,
		`{"type":"user","cwd":"/r","message":{"content":[{"type":"text","text":"  "},{"type":"text","text":"real one"}]}}`,
	}, "\n")+"\n")
	if got.title != "real one" {
		t.Errorf("prompt after plumbing = %+v", got)
	}
	// A branch is kept from the latest row; HEAD (detached) is not one.
	got, _ = parseClaudeFile(t, claudeRows("/r", "main", "p", `{"type":"assistant","cwd":"/r","gitBranch":"HEAD"}`, `{"type":"user","cwd":"/r","gitBranch":"feat"}`))
	if got.branch != "feat" {
		t.Errorf("branch = %q", got.branch)
	}
}

func TestParseClaudeHistoryRefuses(t *testing.T) {
	for name, body := range map[string]string{
		"no cwd":    `{"type":"user","message":{"content":"hi"}}` + "\n",
		"no prompt": `{"type":"assistant","cwd":"/r","message":{"content":[{"type":"text","text":"x"}]}}` + "\n",
		"empty":     "",
	} {
		if got, ok := parseClaudeFile(t, body); ok {
			t.Errorf("%s: kept %+v", name, got)
		}
	}
	// A broken row naming a cwd is skipped.
	if got, ok := parseClaudeFile(t, `{"cwd":`+"\n"+claudeRows("/r", "", "p")); !ok || got.cwd != "/r" {
		t.Errorf("broken row = %+v %v", got, ok)
	}
	// A file shorter than its size said (cut meanwhile).
	p := filepath.Join(t.TempDir(), "s.jsonl")
	writeFile(t, p, "x")
	f, _ := os.Open(p)
	defer f.Close()
	if _, ok := parseClaudeHistory(f, 10, histID1); ok {
		t.Error("short file parsed")
	}
	// A first prompt too long for the head: kept untitled, the file being
	// larger than what was read.
	huge := claudeRows("/r", "main", strings.Repeat("x", historyHead*2))
	got, ok := parseClaudeFile(t, `{"type":"system","cwd":"/r"}`+"\n"+huge)
	if !ok || got.title != "" || got.cwd != "/r" {
		t.Errorf("long first line = %+v %v", got, ok)
	}
	// A title in the tail of a large file still names it.
	got, _ = parseClaudeFile(t, `{"type":"system","cwd":"/r"}`+"\n"+huge+`{"type":"ai-title","aiTitle":"Big one"}`+"\n")
	if got.title != "Big one" {
		t.Errorf("tail title = %+v", got)
	}
}

func TestReadEnds(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "aaaa\nbbbb\ncccc\ndddd\n")
	f, _ := os.Open(p)
	defer f.Close()
	h, tl, err := readEnds(f, 20, 7, 7)
	if err != nil || string(h) != "aaaa\n" || string(tl) != "dddd\n" {
		t.Fatalf("ends = %q %q %v", h, tl, err)
	}
	f.Seek(0, 0)
	if h, tl, _ := readEnds(f, 20, 64, 64); string(h) != "aaaa\nbbbb\ncccc\ndddd\n" || tl != nil {
		t.Errorf("whole = %q %q", h, tl)
	}
	f.Seek(0, 0)
	if h, tl, _ := readEnds(f, 20, 3, 3); len(h) != 0 || len(tl) != 0 {
		t.Errorf("no whole line = %q %q", h, tl)
	}
	f.Seek(0, 0)
	if _, _, err := readEnds(f, 40, 30, 0); err == nil {
		t.Error("short file read without an error")
	}
	// A last line with no end, longer than the tail: no whole line there.
	writeFile(t, p, "aaaa\nbbbbbbbbbb")
	g, _ := os.Open(p)
	if h, tl, _ := readEnds(g, 15, 5, 3); string(h) != "aaaa\n" || tl != nil {
		t.Errorf("open last line = %q %q", h, tl)
	}
	g.Close()
	if _, _, err := readEnds(g, 15, 0, 3); err == nil {
		t.Error("read of a closed file without an error")
	}
}

// historyFixture is a root with a Claude dir and a Codex home of its own.
type historyFixture struct {
	root, claude, codex string
	h                   *historyAPI
}

func newHistoryFixture(t *testing.T) *historyFixture {
	t.Helper()
	fx := &historyFixture{root: realTemp(t), claude: realTemp(t), codex: realTemp(t)}
	fx.h = newHistoryAPI()
	fx.h.dirs = func() historyDirs { return historyDirs{claude: fx.claude, codex: fx.codex} }
	return fx
}

func TestScanClaude(t *testing.T) {
	fx := newHistoryFixture(t)
	now := time.Now().Truncate(time.Second)
	sub := filepath.Join(fx.root, "pkg", "web")
	os.MkdirAll(sub, 0o755)
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "root one"), now.Add(-time.Hour))
	writeClaudeSession(t, fx.claude, sub, histID2, claudeRows(sub, "feat", "sub one"), now)
	// Named like the root, run elsewhere: its recorded cwd decides.
	writeClaudeSession(t, fx.claude, fx.root, histID3, claudeRows("/somewhere/else", "main", "other"), now)
	// A sibling sharing the root's prefix.
	writeClaudeSession(t, fx.claude, fx.root+"-other", "aaaaaaaa-0000-4000-8000-000000000004", claudeRows(fx.root+"-other", "main", "sibling"), now)
	// A subagent's transcript and non-session files are not listed.
	writeFile(t, filepath.Join(fx.claude, "projects", claudeProjectName(fx.root), histID1, "subagents", "agent-x.jsonl"), claudeRows(fx.root, "", "sub"))
	writeFile(t, filepath.Join(fx.claude, "projects", claudeProjectName(fx.root), "notes.jsonl"), claudeRows(fx.root, "", "x"))
	// An id in capitals is no session id (a new one: on a file system that
	// ignores case, the capitals of histID3 would name histID3's own file).
	writeFile(t, filepath.Join(fx.claude, "projects", claudeProjectName(fx.root), "AAAAAAAA-0000-4000-8000-000000000008.jsonl"), claudeRows(fx.root, "", "x"))

	writeFile(t, filepath.Join(fx.claude, "projects", claudeProjectName(fx.root)+"-file"), "not a dir")
	writeFile(t, filepath.Join(fx.claude, "projects", claudeProjectName(fx.root), "aaaaaaaa-0000-4000-8000-000000000005.jsonl"), `{"type":"user","message":{"content":"no cwd"}}`+"\n")
	os.MkdirAll(filepath.Join(fx.claude, "projects", claudeProjectName(fx.root), "aaaaaaaa-0000-4000-8000-000000000006.jsonl"), 0o755)
	got, truncated := fx.h.scanClaude(fx.claude, fx.root)
	ids := map[string]historySession{}
	for _, s := range got {
		ids[s.ID] = s
	}
	if truncated || len(got) != 2 || ids[histID1].Cwd != "" || ids[histID2].Cwd != "pkg/web" || ids[histID2].Branch != "feat" {
		t.Fatalf("scan = %+v %v", got, truncated)
	}
	if ids[histID1].UpdatedAt != now.Add(-time.Hour).UTC().Format(time.RFC3339) || ids[histID1].path == "" {
		t.Errorf("session = %+v", ids[histID1])
	}
	// A dir that is not there, or not absolute.
	if got, _ := fx.h.scanClaude(filepath.Join(fx.root, "none"), fx.root); got != nil {
		t.Errorf("missing dir = %v", got)
	}
	if got, _ := fx.h.scanClaude("rel", fx.root); got != nil {
		t.Errorf("relative dir = %v", got)
	}
	if got, _ := fx.h.scanClaude(fx.root, fx.root); got != nil {
		t.Errorf("no projects dir = %v", got)
	}
}

func TestScanClaudeSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	fx := newHistoryFixture(t)
	outside := realTemp(t)
	target := filepath.Join(outside, histID1+".jsonl")
	writeFile(t, target, claudeRows(fx.root, "main", "outside"))
	dir := filepath.Join(fx.claude, "projects", claudeProjectName(fx.root))
	os.MkdirAll(dir, 0o755)
	if err := os.Symlink(target, filepath.Join(dir, histID1+".jsonl")); err != nil {
		t.Fatal(err)
	}
	// A link to a dir is no file either.
	os.Symlink(outside, filepath.Join(dir, histID2+".jsonl"))
	// A link to a dir inside the Claude dir opens, but is no file.
	os.MkdirAll(filepath.Join(fx.claude, "adir"), 0o755)
	os.Symlink(filepath.Join(fx.claude, "adir"), filepath.Join(dir, "aaaaaaaa-0000-4000-8000-000000000007.jsonl"))
	// A link inside the Claude dir is followed.
	inside := filepath.Join(fx.claude, "kept.jsonl")
	writeFile(t, inside, claudeRows(fx.root, "main", "inside"))
	os.Symlink(inside, filepath.Join(dir, histID3+".jsonl"))
	got, _ := fx.h.scanClaude(fx.claude, fx.root)
	if len(got) != 1 || got[0].ID != histID3 || got[0].Title != "inside" {
		t.Fatalf("scan = %+v", got)
	}
	// A session started through a symlink of the root counts.
	link := filepath.Join(outside, "link")
	os.Symlink(fx.root, link)
	writeClaudeSession(t, fx.claude, link, histID2, claudeRows(link, "main", "via link"), time.Now())
	got, _ = fx.h.scanClaude(fx.claude, fx.root)
	if len(got) != 1 {
		// The link's project dir is not named like the root, so it is not
		// read: the scan misses it rather than shows a wrong one.
		t.Fatalf("via link = %+v", got)
	}
	if rel, ok := inHistoryRoot(fx.root, link); !ok || rel != "" {
		t.Errorf("inHistoryRoot(link) = %q %v", rel, ok)
	}
}

func TestInHistoryRoot(t *testing.T) {
	root := realTemp(t)
	for cwd, want := range map[string]string{
		root:                          "",
		filepath.Join(root, "a", "b"): "a/b",
		root + "/./a/../c":            "c",
	} {
		if got, ok := inHistoryRoot(root, cwd); !ok || got != want {
			t.Errorf("inHistoryRoot(%q) = %q %v, want %q", cwd, got, ok, want)
		}
	}
	for _, cwd := range []string{"", "rel/dir", filepath.Dir(root), root + "-x", filepath.Join(root, "..", "x")} {
		if _, ok := inHistoryRoot(root, cwd); ok {
			t.Errorf("inHistoryRoot(%q) accepted", cwd)
		}
	}
	setPathsFold(t, true)
	if got, ok := inHistoryRoot(strings.ToUpper(root), filepath.Join(root, "Missing", "Dir")); !ok || got != "Missing/Dir" {
		t.Errorf("case-folded = %q %v", got, ok)
	}
}

func TestScanClaudeLimit(t *testing.T) {
	fx := newHistoryFixture(t)
	old := historyMaxScan
	historyMaxScan = 2
	t.Cleanup(func() { historyMaxScan = old })
	for _, id := range []string{histID1, histID2, histID3} {
		writeClaudeSession(t, fx.claude, fx.root, id, claudeRows(fx.root, "main", "p"), time.Now())
	}
	got, truncated := fx.h.scanClaude(fx.claude, fx.root)
	if len(got) != 2 || !truncated {
		t.Errorf("scan = %d %v", len(got), truncated)
	}
}

func TestHistoryIndexReusesUnchanged(t *testing.T) {
	x := newHistoryIndex()
	p := filepath.Join(t.TempDir(), "f")
	writeFile(t, p, "x")
	fi, _ := os.Stat(p)
	reads := 0
	parse := func() (historyFile, bool) { reads++; return historyFile{id: "x"}, true }
	x.get(p, fi, parse)
	x.get(p, fi, parse)
	if reads != 1 {
		t.Errorf("reads = %d", reads)
	}
	writeFile(t, p, "xy")
	fi, _ = os.Stat(p)
	if f, ok := x.get(p, fi, parse); !ok || f.id != "x" || reads != 2 {
		t.Errorf("changed file: reads = %d", reads)
	}
	// Past the limit, the least recently used go first.
	base := time.Now()
	tick := 0
	x.now = func() time.Time { tick++; return base.Add(time.Duration(tick) * time.Second) }
	for i := range historyIndexMax + 1 {
		x.get(fmt.Sprintf("p%d", i), fi, parse)
	}
	if len(x.files) > historyIndexMax || x.files[p] != nil || x.files[fmt.Sprintf("p%d", historyIndexMax)] == nil {
		t.Errorf("index holds %d, first kept = %v", len(x.files), x.files[p] != nil)
	}
}

func TestHistoryCursor(t *testing.T) {
	c := historyCursor{Agent: "claude", Updated: 42, Of: "claude", ID: histID1}
	got, ok := decodeHistoryCursor(encodeHistoryCursor(c))
	if !ok || got != c {
		t.Fatalf("round trip = %+v %v", got, ok)
	}
	// A transcript cursor is signed with the same key but is no history
	// cursor; a forged or broken one is refused.
	tc := encodeCursor(agentCursor{Session: histID1})
	for _, s := range []string{tc, "x", "a.b", "!!.!!", strings.Replace(encodeHistoryCursor(c), "e", "f", 1)} {
		if _, ok := decodeHistoryCursor(s); ok {
			t.Errorf("accepted %q", s)
		}
	}
}

func TestHistoryPageOf(t *testing.T) {
	base := time.Now()
	var scan historyScan
	for i := range 70 {
		agent := "claude"
		if i%2 == 1 {
			agent = "codex"
		}
		// Pairs share a time, so the order falls back to agent and id.
		scan.sessions = append(scan.sessions, historySession{Agent: agent, ID: fmt.Sprintf("id-%02d", i), updated: base.Add(-time.Duration(i/2) * time.Minute)})
	}
	scan.truncated = true
	var all []string
	var after *historyCursor
	for range 5 {
		page := historyPageOf(scan, "", after)
		if !page.Truncated {
			t.Error("truncated lost")
		}
		for _, s := range page.Sessions {
			all = append(all, s.ID)
		}
		if page.Next == "" {
			break
		}
		c, _ := decodeHistoryCursor(page.Next)
		after = &c
	}
	if len(all) != 70 || all[0] != "id-00" || all[69] != "id-69" {
		t.Fatalf("pages = %d %v", len(all), all)
	}
	page := historyPageOf(scan, "codex", nil)
	if len(page.Sessions) != 30 || page.Sessions[0].ID != "id-01" || page.Next == "" {
		t.Errorf("codex page = %d %+v", len(page.Sessions), page.Sessions[0])
	}
}

// historyMux is a pane at dir in group "g" (tab "0", pane "0") whose tabs
// run tasks, with an agent locator answering per pane.
type historyMux struct {
	*taskFakeMux
	mu       sync.Mutex
	sessions map[string]AgentSession
}

func (m *historyMux) Caps() Caps { return Caps{Files: true, AgentChat: true} }
func (m *historyMux) AgentSession(_ context.Context, pane string) (AgentSession, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[pane]
	return s, ok, nil
}

func newHistoryMux(t *testing.T, dir string) *historyMux {
	t.Helper()
	return &historyMux{taskFakeMux: newTaskFake(t, dir), sessions: map[string]AgentSession{}}
}

// historyServer serves every route over m, reading the agent dirs of fx.
func historyServer(t *testing.T, fx *historyFixture, m Mux) http.Handler {
	t.Helper()
	t.Setenv("CLAUDE_CONFIG_DIR", fx.claude)
	t.Setenv("CODEX_HOME", fx.codex)
	return tasksHandler(t, m)
}

func listHistory(t *testing.T, h http.Handler, q string) (int, historyResponse, map[string]any) {
	t.Helper()
	rec := serve(h, apiRequest("GET", "/api/mux/panes/0/agent/history"+q, ""))
	var res historyResponse
	json.Unmarshal(rec.Body.Bytes(), &res)
	var raw map[string]any
	json.Unmarshal(rec.Body.Bytes(), &raw)
	return rec.Code, res, raw
}

func TestHistoryRoute(t *testing.T) {
	fx := newHistoryFixture(t)
	gitInit(t, fx.root)
	now := time.Now()
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "first", `{"type":"ai-title","aiTitle":"Login"}`), now.Add(-time.Minute))
	writeHistoryRollout(t, fx.codex, histID2, fx.root, "codex prompt", now)
	h := historyServer(t, fx, newHistoryMux(t, fx.root))

	code, res, raw := listHistory(t, h, "")
	if code != 200 || len(res.Sessions) != 2 || res.Sessions[0].Agent != "codex" || res.Sessions[1].Title != "Login" || res.Sessions[1].TitleSource != "ai" {
		t.Fatalf("list = %d %+v", code, res)
	}
	if strings.Contains(fmt.Sprint(raw), fx.root) || strings.Contains(fmt.Sprint(raw), fx.claude) {
		t.Errorf("an absolute path was sent: %v", raw)
	}
	if code, res, _ := listHistory(t, h, "?agent=claude"); code != 200 || len(res.Sessions) != 1 || res.Sessions[0].ID != histID1 {
		t.Errorf("claude only = %d %+v", code, res)
	}
	// After the newest one (a cursor as a next page would give).
	c := encodeHistoryCursor(historyCursor{Updated: now.UnixNano(), Of: "codex", ID: histID2})
	if code, res, _ := listHistory(t, h, "?cursor="+url.QueryEscape(c)); code != 200 || len(res.Sessions) != 1 || res.Sessions[0].ID != histID1 {
		t.Errorf("after cursor = %d %+v", code, res)
	}
	for _, q := range []string{"?agent=gemini", "?cursor=junk", "?agent=codex&cursor=" + url.QueryEscape(encodeHistoryCursor(historyCursor{Agent: "claude"}))} {
		if code, _, raw := listHistory(t, h, q); code != 400 || raw["code"] != "invalid_request" {
			t.Errorf("%s = %d %v", q, code, raw)
		}
	}
	// A view-only client reads it in a repo; never cross-site, never with
	// another method.
	if rec := serve(h, viewRequest("GET", "/api/mux/panes/0/agent/history", "")); rec.Code != 200 {
		t.Errorf("view-only = %d %s", rec.Code, rec.Body)
	}
	req := apiRequest("GET", "/api/mux/panes/0/agent/history", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != 403 {
		t.Errorf("cross-site = %d", rec.Code)
	}
	if rec := serve(h, apiRequest("POST", "/api/mux/panes/0/agent/history", "{}")); rec.Code != 405 {
		t.Errorf("POST = %d", rec.Code)
	}
}

func TestHistoryRouteRoots(t *testing.T) {
	fx := newHistoryFixture(t)
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "first"), time.Now())
	// Outside a repo: the pane's dir is the root; a view-only client may
	// not read it, as in Files.
	h := historyServer(t, fx, newHistoryMux(t, fx.root))
	if code, res, _ := listHistory(t, h, ""); code != 200 || len(res.Sessions) != 1 {
		t.Errorf("no repo = %d %+v", code, res)
	}
	assertViewOnly(t, "no repo", serve(h, viewRequest("GET", "/api/mux/panes/0/agent/history", "")))
	// A backend without an agent locator lists nothing as live; an empty
	// history is an empty list.
	if code, res, _ := listHistory(t, historyServer(t, fx, &filesFakeMux{dir: fx.root, files: true}), ""); code != 200 || len(res.Sessions) != 1 || res.Sessions[0].Live != nil {
		t.Errorf("no locator = %d %+v", code, res)
	}
	empty := newHistoryFixture(t)
	if code, res, raw := listHistory(t, historyServer(t, empty, newHistoryMux(t, empty.root)), ""); code != 200 || res.Sessions == nil || raw["truncated"] != false {
		t.Errorf("empty = %d %v", code, raw)
	}
	// A pane whose directory is gone.
	if code, _, _ := listHistory(t, historyServer(t, fx, newHistoryMux(t, filepath.Join(fx.root, "gone"))), ""); code < 400 {
		t.Errorf("gone dir = %d", code)
	}
	// A backend without pane dirs.
	plain := historyServer(t, fx, &fakeLocator{})
	if code, _, _ := listHistory(t, plain, ""); code != http.StatusNotImplemented {
		t.Errorf("no files = %d", code)
	}
	// The routes mounted without the files routes.
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, newHistoryMux(t, fx.root), newStreamTokenStore(), nil, nil)
	agent.registerCommandsRoute(mux, nil, parseAllowedHosts("", false))
	if code, _, _ := listHistory(t, mux, ""); code != http.StatusNotImplemented {
		t.Errorf("no files API = %d", code)
	}
}

func TestHistoryScanCached(t *testing.T) {
	fx := newHistoryFixture(t)
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "first"), time.Now())
	a := fx.h.scan(fx.root)
	writeClaudeSession(t, fx.claude, fx.root, histID2, claudeRows(fx.root, "main", "second"), time.Now())
	b := fx.h.scan(fx.root)
	if len(a.sessions) != 1 || len(b.sessions) != 1 {
		t.Errorf("a scan within the TTL read again: %d %d", len(a.sessions), len(b.sessions))
	}
}
