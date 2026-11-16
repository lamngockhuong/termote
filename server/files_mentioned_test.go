package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

// mentionedMux is a pane with files and a Claude Code session.
type mentionedMux struct {
	filesFakeMux
	s AgentSession
}

func (m *mentionedMux) AgentSession(context.Context, string) (AgentSession, bool, error) {
	return m.s, m.s.ID != "", nil
}

type mentionedFixture struct {
	base, scratch, note string
	h                   http.Handler
}

// newMentionedFixture is a server whose pane 0 runs in pane/ with an agent
// whose transcript names transcript's paths. The scratchpad, outside the
// pane, holds note.md, secret.env and other.md (never named).
func newMentionedFixture(t *testing.T, transcript func(fx *mentionedFixture) string) *mentionedFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fx := &mentionedFixture{base: base, scratch: filepath.Join(base, "tmp", "claude-1000", "proj", "sess", "scratchpad")}
	fx.note = filepath.Join(fx.scratch, "note.md")
	writeFile(t, filepath.Join(base, "pane", "a.txt"), "a\n")
	writeFile(t, fx.note, "# Draft\n")
	writeFile(t, filepath.Join(fx.scratch, "other.md"), "other\n")
	writeFile(t, filepath.Join(fx.scratch, ".env"), "TOKEN=x\n")
	claude := filepath.Join(base, "claude")
	writeTranscript(t, claude, testSessionID, transcript(fx))
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass = true, ""
	m := &mentionedMux{filesFakeMux: filesFakeMux{dir: filepath.Join(base, "pane"), files: true},
		s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: claude}}
	h, hub, _, err := buildServer(cfg, m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	fx.h = asRole(h, true)
	return fx
}

// transcriptLine is a Claude Code assistant line saying text.
func transcriptLine(text string) string {
	b, _ := json.Marshal(map[string]any{
		"type": "assistant", "uuid": "u1", "timestamp": "2026-01-01T00:00:00Z",
		"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}},
	})
	return string(b) + "\n"
}

func (fx *mentionedFixture) open(t *testing.T, path string, view bool) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(map[string]string{"path": path})
	req := apiRequest("POST", "/api/mux/panes/0/files/mentioned", string(b))
	if view {
		req.Header.Set(viewDeviceHeader, "dev1")
	}
	rec := serve(fx.h, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (fx *mentionedFixture) get(t *testing.T, pane, route string, q url.Values) (int, string) {
	t.Helper()
	rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/"+pane+"/files/"+route+"?"+q.Encode(), ""))
	return rec.Code, rec.Body.String()
}

func TestMentionedFileOpensReadOnly(t *testing.T) {
	fx := newMentionedFixture(t, func(fx *mentionedFixture) string {
		return transcriptLine("The draft is at `"+fx.note+"`.") + transcriptLine("Keys in "+filepath.Join(fx.scratch, ".env"))
	})
	code, out := fx.open(t, fx.note, false)
	if code != http.StatusOK || out["root"] != fx.scratch || out["path"] != "note.md" {
		t.Fatalf("open = %d %v", code, out)
	}
	id, _ := out["place"].(string)
	if !strings.HasPrefix(id, mentionedPrefix) {
		t.Fatalf("id %q", id)
	}
	// The same file again: the same id
	if _, again := fx.open(t, fx.note, false); again["place"] != id {
		t.Fatalf("second id %v, want %s", again["place"], id)
	}
	code, body := fx.get(t, "0", "content", url.Values{"place": {id}, "path": {"note.md"}})
	if code != http.StatusOK || !strings.Contains(body, "# Draft") {
		t.Fatalf("content = %d %s", code, body)
	}
	// Another file of the folder, a listing, a search or a write: refused
	if code, body := fx.get(t, "0", "content", url.Values{"place": {id}, "path": {"other.md"}}); code != http.StatusForbidden {
		t.Fatalf("other file = %d %s", code, body)
	}
	for _, route := range []string{"tree", "find", "search"} {
		if code, body := fx.get(t, "0", route, url.Values{"place": {id}, "path": {"note.md"}, "q": {"x"}}); code != http.StatusBadRequest || errCode(body) != "place_not_supported" {
			t.Fatalf("%s = %d %s", route, code, body)
		}
	}
	put := apiRequest("PUT", "/api/mux/panes/0/files/content?"+url.Values{"place": {id}, "root": {fx.scratch}}.Encode(), `{"path":"note.md","text":"x","baseHash":""}`)
	if rec := serve(fx.h, put); rec.Code != http.StatusBadRequest || errCode(rec.Body.String()) != "place_not_supported" {
		t.Fatalf("save = %d %s", rec.Code, rec.Body.String())
	}
	if b, _ := os.ReadFile(fx.note); string(b) != "# Draft\n" {
		t.Fatalf("note changed: %q", b)
	}
	// Another pane cannot use the id
	if code, body := fx.get(t, "1", "content", url.Values{"place": {id}, "path": {"note.md"}}); code != http.StatusNotFound || errCode(body) != "unknown_place" {
		t.Fatalf("other pane = %d %s", code, body)
	}
	// A sensitive file the agent named is opened, but not shown unasked
	code, out = fx.open(t, filepath.Join(fx.scratch, ".env"), false)
	if code != http.StatusOK {
		t.Fatalf("open .env = %d %v", code, out)
	}
	code, body = fx.get(t, "0", "content", url.Values{"place": {out["place"].(string)}, "path": {".env"}})
	if code != http.StatusOK || strings.Contains(body, "TOKEN") || !strings.Contains(body, `"sensitive":true`) {
		t.Fatalf(".env = %d %s", code, body)
	}
}

func TestMentionedFileRefusals(t *testing.T) {
	fx := newMentionedFixture(t, func(fx *mentionedFixture) string {
		return transcriptLine("Wrote " + fx.note + " and " + fx.scratch)
	})
	cases := []struct {
		name, path string
		status     int
		code       string
	}{
		{"never named", filepath.Join(fx.scratch, "other.md"), http.StatusNotFound, "not_mentioned"},
		{"start of a named path", filepath.Join(fx.scratch, "note"), http.StatusNotFound, "not_mentioned"},
		{"relative", "scratchpad/note.md", http.StatusBadRequest, ""},
		{"dot dot", fx.scratch + "/../scratchpad/note.md", http.StatusBadRequest, ""},
		{"a folder", fx.scratch, http.StatusNotFound, ""},
	}
	for _, c := range cases {
		code, out := fx.open(t, c.path, false)
		if code != c.status || (c.code != "" && out["code"] != c.code) {
			t.Errorf("%s: %d %v", c.name, code, out)
		}
	}
	if code, _ := fx.open(t, fx.note, true); code != http.StatusForbidden {
		t.Fatalf("view-only open = %d", code)
	}
	// An id the server never handed out
	if code, body := fx.get(t, "0", "content", url.Values{"place": {mentionedPrefix + "00"}, "path": {"note.md"}}); code != http.StatusNotFound || errCode(body) != "unknown_place" {
		t.Fatalf("unknown id = %d %s", code, body)
	}
}

func TestMentionedFileRefusesGitDir(t *testing.T) {
	var cfg string
	fx := newMentionedFixture(t, func(fx *mentionedFixture) string {
		cfg = filepath.Join(fx.base, "repo", ".git", "config")
		writeFile(t, cfg, "[core]\n")
		return transcriptLine("see " + cfg)
	})
	if code, out := fx.open(t, cfg, false); code != http.StatusForbidden {
		t.Fatalf("git config = %d %v", code, out)
	}
}

func TestMentionsIn(t *testing.T) {
	needle := mentionNeedles("/tmp/a.md")
	cases := map[string]bool{
		`"/tmp/a.md"`:           true,
		"see /tmp/a.md.":        true,
		"see `/tmp/a.md`, done": true,
		`text\n/tmp/a.md\n`:     true,
		"/tmp/a.md":             true,
		"/tmp/a.mdx":            false,
		"/tmp/a.md.bak":         false,
		"/x/tmp/a.md":           false,
		"/tmp/a.md/b":           false,
		`C:\\x\\n/tmp/a.md`:     false,
		`\\n/tmp/a.md`:          false,
		"nothing here":          false,
	}
	for in, want := range cases {
		got, err := mentionsIn(strings.NewReader(in), needle)
		if err != nil || got != want {
			t.Errorf("%q: %v %v, want %v", in, got, err, want)
		}
	}
	// A Windows path is found in its JSON form
	win := mentionNeedles(`C:\Users\u\AppData\Local\Temp\x.md`)
	if len(win) != 2 {
		t.Fatalf("needles %q", win)
	}
	if ok, _ := mentionsIn(strings.NewReader(`{"file_path":"C:\\Users\\u\\AppData\\Local\\Temp\\x.md"}`), win); !ok {
		t.Fatal("JSON-escaped Windows path not found")
	}
	if ok, _ := mentionsIn(strings.NewReader(`{"file_path":"C:\\Users\\u\\AppData\\Local\\Temp\\x.md\\y"}`), win); ok {
		t.Fatal("a path below the file taken for it")
	}
	// Cut across chunks, a byte at a time
	long := strings.Repeat("x", mentionedChunk-4) + " /tmp/a.md " + strings.Repeat("y", 10)
	if ok, err := mentionsIn(iotest.OneByteReader(strings.NewReader(long)), needle); !ok || err != nil {
		t.Fatalf("across chunks: %v %v", ok, err)
	}
	cut := strings.Repeat("x", mentionedChunk-4) + " /tmp/a.mdx"
	if ok, _ := mentionsIn(strings.NewReader(cut), needle); ok {
		t.Fatal("a longer name cut at the chunk's end taken for the path")
	}
	if ok, _ := mentionsIn(strings.NewReader("abc"), nil); ok {
		t.Fatal("no needle matched")
	}
}

func TestMentionedFilesExpireAndEvict(t *testing.T) {
	m := newMentionedFiles()
	now := time.Unix(0, 0)
	m.now = func() time.Time { return now }
	id := m.add("0", "/a")
	if p, ok := m.get(id, "0"); !ok || p != "/a" {
		t.Fatal("not found")
	}
	now = now.Add(mentionedTTL + time.Second)
	if _, ok := m.get(id, "0"); ok {
		t.Fatal("kept past its TTL")
	}
	first := m.add("0", "/first")
	for i := range mentionedMax {
		now = now.Add(time.Second)
		m.add("0", "/f"+string(rune('a'+i%26))+strings.Repeat("x", i))
	}
	if _, ok := m.get(first, "0"); ok || len(m.files) != mentionedMax {
		t.Fatalf("oldest kept, %d ids", len(m.files))
	}
}

func TestMentionedPath(t *testing.T) {
	for _, p := range []string{"", "/", "a/b", "/a/\x00b", "/a/./b", "/" + strings.Repeat("a", mentionedMaxPath)} {
		if _, err := mentionedPath(p); err == nil {
			t.Errorf("%q accepted", p)
		}
	}
	dir := t.TempDir()
	sep := string(filepath.Separator)
	if p, err := mentionedPath(dir + sep + sep + "a.md"); err != nil || p != filepath.Join(dir, "a.md") {
		t.Fatalf("got %q %v", p, err)
	}
}

func TestTranscriptMentionsWithoutTranscript(t *testing.T) {
	dir := t.TempDir()
	for name, s := range map[string]AgentSession{
		"no session":   {},
		"opencode":     {Agent: "opencode", ID: testSessionID},
		"no file":      {Agent: "claude", ID: testSessionID, ClaudeDir: dir},
		"unknown kind": {Agent: "other", ID: testSessionID},
	} {
		a := newAgentAPI(&fakeLocator{s: s, found: s.ID != ""})
		if ok, err := a.transcriptMentions(context.Background(), "0", "", "", "/tmp/a"); ok || err != nil {
			t.Errorf("%s: %v %v", name, ok, err)
		}
	}
	// A backend without agents, and a failing lookup
	if ok, err := newAgentAPI(&fakeMux{}).transcriptMentions(context.Background(), "0", "", "", "/tmp/a"); ok || err != nil {
		t.Errorf("no locator: %v %v", ok, err)
	}
	a := newAgentAPI(&fakeLocator{err: os.ErrDeadlineExceeded})
	if _, err := a.transcriptMentions(context.Background(), "0", "", "", "/tmp/a"); err == nil {
		t.Error("lookup error lost")
	}
}

func TestMentionedRoutesWithoutAgent(t *testing.T) {
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: t.TempDir(), files: true}, parseAllowedHosts("", false), nil)
	// An absolute path on this OS, of a file that does not exist
	body, _ := json.Marshal(map[string]string{"path": filepath.Join(t.TempDir(), "a.md")})
	post := func() (int, string) {
		rec := serve(mux, apiRequest("POST", "/api/mux/panes/0/files/mentioned", string(body)))
		return rec.Code, rec.Body.String()
	}
	if code, body := post(); code != http.StatusNotImplemented {
		t.Fatalf("no agent reads = %d %s", code, body)
	}
	if rec := serve(mux, apiRequest("GET", "/api/mux/panes/0/files/mentioned", "")); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET = %d", rec.Code)
	}
	f.mentions = func(context.Context, string, string, string, string) (bool, error) {
		return false, os.ErrDeadlineExceeded
	}
	if code, _ := post(); code != http.StatusInternalServerError {
		t.Fatalf("failed lookup = %d", code)
	}
	f.mentions = func(context.Context, string, string, string, string) (bool, error) { return true, nil }
	if code, body := post(); code != http.StatusNotFound {
		t.Fatalf("missing file = %d %s", code, body)
	}
	rec := serve(mux, apiRequest("POST", "/api/mux/panes/0/files/mentioned", `{"path":"rel"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("relative = %d", rec.Code)
	}
	f.mentioned = nil
	r := apiRequest("GET", "/api/mux/panes/0/files/content?place=m-1&path=a", "")
	r.SetPathValue("id", "0")
	if _, err := f.mentionedRoot(r, "m-1"); err != errUnknownPlace {
		t.Fatalf("no ids = %v", err)
	}
}

func TestMentionedRootRefusesGitDirLater(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	note := filepath.Join(base, "s", "n.md")
	writeFile(t, note, "x")
	f := &filesAPI{mentioned: newMentionedFiles()}
	id := f.mentioned.add("0", note)
	// The folder is now a symlink into a git dir
	os.RemoveAll(filepath.Join(base, "s"))
	writeFile(t, filepath.Join(base, "r", ".git", "n.md"), "x")
	if err := os.Symlink(filepath.Join(base, "r", ".git"), filepath.Join(base, "s")); err != nil {
		t.Skip(err)
	}
	r := apiRequest("GET", "/api/mux/panes/0/files/content?path=n.md", "")
	r.SetPathValue("id", "0")
	if _, err := f.mentionedRoot(r, id); err != errPathNotAllowed {
		t.Fatalf("got %v", err)
	}
}

func TestMentionsInReadError(t *testing.T) {
	if _, err := mentionsIn(iotest.ErrReader(os.ErrClosed), mentionNeedles("/a")); err == nil {
		t.Fatal("read error lost")
	}
}

func TestMentionedRouteGuards(t *testing.T) {
	mux := http.NewServeMux()
	registerFilesRoutes(mux, &filesFakeMux{dir: t.TempDir(), files: true}, parseAllowedHosts("", false), nil)
	cross := apiRequest("POST", "/api/mux/panes/0/files/mentioned", `{"path":"/tmp/a"}`)
	cross.Header.Set("Origin", "https://evil.test")
	if rec := serve(mux, cross); rec.Code != http.StatusForbidden {
		t.Fatalf("cross-site = %d", rec.Code)
	}
	view := apiRequest("POST", "/api/mux/panes/0/files/mentioned", `{"path":"/tmp/a"}`)
	view.Header.Set(viewDeviceHeader, "dev1")
	if rec := serve(asRole(mux, false), view); rec.Code != http.StatusForbidden {
		t.Fatalf("view-only = %d", rec.Code)
	}
	if rec := serve(mux, apiRequest("POST", "/api/mux/panes/0/files/mentioned", `{`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad JSON = %d", rec.Code)
	}
}

func TestMentionsInAtChunkEnd(t *testing.T) {
	needle := mentionNeedles("/tmp/a.md")
	// The path ends a byte before the chunk does: what follows it is read
	// with the next chunk
	for _, tail := range []string{" ok", "x"} {
		in := strings.Repeat("x", mentionedChunk-len("/tmp/a.md")-2) + " /tmp/a.md" + tail
		ok, err := mentionsIn(strings.NewReader(in), needle)
		if err != nil || ok != (tail == " ok") {
			t.Errorf("tail %q: %v %v", tail, ok, err)
		}
	}
}

func TestTranscriptMentionsUnreadable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("no mode bit keeps the file from this user")
	}
	dir := t.TempDir()
	p := writeTranscript(t, dir, testSessionID, transcriptLine("/tmp/a"))
	if err := os.Chmod(p, 0); err != nil {
		t.Skip(err)
	}
	a := newAgentAPI(&fakeLocator{s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}, found: true})
	if ok, err := a.transcriptMentions(context.Background(), "0", "", "", "/tmp/a"); ok || err != nil {
		t.Fatalf("%v %v", ok, err)
	}
}

func TestMentionedFileOfPastSession(t *testing.T) {
	shortTasks(t)
	fx := newHistoryFixture(t)
	gitInit(t, fx.root)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	note := filepath.Join(dir, "note.md")
	writeFile(t, note, "# old\n")
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "read "+note), time.Now())
	h := historyServer(t, fx, newHistoryMux(t, fx.root))
	open := func(agent, session string) (int, map[string]any) {
		b, _ := json.Marshal(map[string]string{"path": note, "agent": agent, "session": session})
		rec := serve(h, apiRequest("POST", "/api/mux/panes/0/files/mentioned", string(b)))
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	// The pane's live session never named it
	if code, out := open("", ""); code != http.StatusNotFound || out["code"] != "not_mentioned" {
		t.Fatalf("live = %d %v", code, out)
	}
	code, out := open("claude", histID1)
	if code != http.StatusOK || out["root"] != dir || out["path"] != "note.md" {
		t.Fatalf("past = %d %v", code, out)
	}
	rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/content?"+url.Values{"place": {out["place"].(string)}, "path": {"note.md"}}.Encode(), ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "# old") {
		t.Fatalf("content = %d %s", rec.Code, rec.Body.String())
	}
	// Another session, another agent's id, or no valid id: not named
	for _, c := range [][2]string{{"claude", histID3}, {"codex", histID1}, {"gemini", histID1}, {"claude", ""}} {
		if code, out := open(c[0], c[1]); code != http.StatusNotFound || out["code"] != "not_mentioned" {
			t.Errorf("%v = %d %v", c, code, out)
		}
	}
}

func TestTranscriptMentionsPastSessionWithoutFiles(t *testing.T) {
	a := newAgentAPI(&fakeMux{})
	if ok, err := a.transcriptMentions(context.Background(), "0", "claude", testSessionID, "/tmp/a"); ok || err != nil {
		t.Fatalf("%v %v", ok, err)
	}
	a.files = registerFilesRoutes(http.NewServeMux(), &filesFakeMux{}, hostAllowlist{}, nil)
	a.history = newHistoryAPI()
	if _, err := a.transcriptMentions(context.Background(), "0", "claude", testSessionID, "/tmp/a"); err == nil {
		t.Fatal("pane root error lost")
	}
}
