package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// subagentsFixture copies testdata/claude/subagents-session into a new
// Claude dir as the session testSessionID, every file written now, and
// returns the dir and the session's subagents directory.
func subagentsFixture(t *testing.T) (dir, subs string) {
	t.Helper()
	dir = t.TempDir()
	src := "testdata/claude/subagents-session"
	b, err := os.ReadFile(filepath.Join(src, "transcript.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	p := writeTranscript(t, dir, testSessionID, string(b))
	subs = filepath.Join(filepath.Dir(p), testSessionID, "subagents")
	if err := os.MkdirAll(subs, 0o755); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(src, "subagents"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(src, "subagents", e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(subs, e.Name()), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir, subs
}

func claudeSession(dir string) AgentSession {
	return AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir, Status: "working"}
}

// subagentsServer serves the agent routes for a pane running s, every tree
// read again.
func subagentsServer(t *testing.T, s AgentSession) (*http.ServeMux, *agentAPI) {
	t.Helper()
	mux := http.NewServeMux()
	a := registerMuxRoutes(mux, &fakeLocator{s: s, found: true}, newStreamTokenStore(), nil, nil)
	a.subagents = newTTLCache[subagentsResponse](0)
	a.subagentWrites = newTTLCache[time.Time](0)
	return mux, a
}

func getSubagents(t *testing.T, mux http.Handler) (subagentsResponse, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/subagents", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("subagents = %d %s", rec.Code, rec.Body)
	}
	var res subagentsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	return res, rec.Body.String()
}

func nodeByID(nodes []subagentNode, id string) *subagentNode {
	for i := range nodes {
		if nodes[i].ID == id {
			return &nodes[i]
		}
		if n := nodeByID(nodes[i].Children, id); n != nil {
			return n
		}
	}
	return nil
}

func TestSubagentTree(t *testing.T) {
	dir, _ := subagentsFixture(t)
	mux, _ := subagentsServer(t, claudeSession(dir))
	res, body := getSubagents(t, mux)

	// Three subagents of the session, the nested one under its parent; the
	// broken meta without a file and the odd name are not listed.
	var roots []string
	for _, n := range res.Nodes {
		roots = append(roots, n.ID)
	}
	if strings.Join(roots, ",") != "aaa1,aaa2,aaa3" || res.Truncated {
		t.Fatalf("roots = %v truncated=%v", roots, res.Truncated)
	}
	one := nodeByID(res.Nodes, "aaa1")
	if one.Status != "done" || one.EndTS != "2026-10-13T10:04:00.000Z" || one.StartTS != "2026-10-13T10:00:02.500Z" ||
		one.Type != "code-reviewer" || one.Description != "Review parser" || one.LastTool != "Read" || one.Depth != 1 {
		t.Errorf("aaa1 = %+v", one)
	}
	two := nodeByID(res.Nodes, "aaa2")
	if two.Status != "running" || two.EndTS != "" || two.LastTool != "Agent" || two.Description != "Trace the lexer" {
		t.Errorf("aaa2 = %+v", two)
	}
	if len(two.Children) != 1 || two.Children[0].ID != "aaa4" || two.Children[0].Depth != 2 || two.Children[0].Status != "running" {
		t.Errorf("aaa2 children = %+v", two.Children)
	}
	// failed is not completed
	if three := nodeByID(res.Nodes, "aaa3"); three.Status != "error" || three.LastTool != "" {
		t.Errorf("aaa3 = %+v", three)
	}
	if nodeByID(res.Nodes, "bv90bdvih") != nil || nodeByID(res.Nodes, "aaa5") != nil {
		t.Error("a background command or a broken meta was listed")
	}
	// Nothing but names and times: no prompt, tool input or result, no path.
	for _, s := range []string{"SECRET", dir, filepath.ToSlash(dir), "/work", "toolu_", "Never listed"} {
		if strings.Contains(body, s) {
			t.Errorf("response has %q: %s", s, body)
		}
	}
}

func TestSubagentTreeNoLinks(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "meta.json"), []byte(`{"agentType":"linked","description":"Linked"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Run("file", func(t *testing.T) {
		dir, subs := subagentsFixture(t)
		symlinkOrSkip(t, filepath.Join(outside, "meta.json"), filepath.Join(subs, "agent-aaa9.meta.json"))
		mux, _ := subagentsServer(t, claudeSession(dir))
		if res, _ := getSubagents(t, mux); nodeByID(res.Nodes, "aaa9") != nil || len(res.Nodes) != 3 {
			t.Errorf("a linked file was read: %+v", res.Nodes)
		}
	})
	for _, level := range []string{"subagents", "session"} {
		t.Run(level, func(t *testing.T) {
			dir, subs := subagentsFixture(t)
			// The real directory moves out of the Claude dir and a link
			// takes its place.
			from := subs
			if level == "session" {
				from = filepath.Dir(subs)
			}
			moved := filepath.Join(t.TempDir(), "moved")
			if err := os.Rename(from, moved); err != nil {
				t.Fatal(err)
			}
			symlinkOrSkip(t, moved, from)
			mux, _ := subagentsServer(t, claudeSession(dir))
			if res, _ := getSubagents(t, mux); len(res.Nodes) != 0 {
				t.Errorf("a linked %s directory was followed: %+v", level, res.Nodes)
			}
		})
	}
	t.Run("link inside", func(t *testing.T) {
		// Even a link to a directory inside the Claude dir is not followed.
		dir, subs := subagentsFixture(t)
		inside := filepath.Join(dir, "elsewhere")
		if err := os.Rename(subs, inside); err != nil {
			t.Fatal(err)
		}
		symlinkOrSkip(t, inside, subs)
		mux, _ := subagentsServer(t, claudeSession(dir))
		if res, _ := getSubagents(t, mux); len(res.Nodes) != 0 {
			t.Errorf("a link inside the Claude dir was followed: %+v", res.Nodes)
		}
	})
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink: %v", err)
	}
}

// setMtime dates every file of subs ago in the past.
func setMtime(t *testing.T, subs string, ago time.Duration) {
	t.Helper()
	at := time.Now().Add(-ago)
	entries, _ := os.ReadDir(subs)
	for _, e := range entries {
		if err := os.Chtimes(filepath.Join(subs, e.Name()), at, at); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSubagentStatusGuessed(t *testing.T) {
	dir, subs := subagentsFixture(t)
	// A transcript format without queue-operation rows: nothing reports an
	// end, so a subagent quiet long enough is taken as done.
	if err := os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(subs)), testSessionID+".jsonl"), []byte(lines(0, 3)), 0o600); err != nil {
		t.Fatal(err)
	}
	mux, _ := subagentsServer(t, claudeSession(dir))
	res, _ := getSubagents(t, mux)
	if n := nodeByID(res.Nodes, "aaa1"); n.Status != "running" || n.StatusGuessed {
		t.Errorf("a recent subagent = %+v", n)
	}
	setMtime(t, subs, subagentGuessIdle+time.Minute)
	res, _ = getSubagents(t, mux)
	for _, id := range []string{"aaa1", "aaa2", "aaa3", "aaa4"} {
		if n := nodeByID(res.Nodes, id); n.Status != "done" || !n.StatusGuessed || n.EndTS != "" {
			t.Errorf("%s = %+v", id, n)
		}
	}

	// With queue-operation rows read from the start, a quiet subagent is
	// still running: the transcript would have said.
	dir, subs = subagentsFixture(t)
	setMtime(t, subs, subagentGuessIdle+time.Minute)
	mux, _ = subagentsServer(t, claudeSession(dir))
	res, _ = getSubagents(t, mux)
	if n := nodeByID(res.Nodes, "aaa2"); n.Status != "running" || n.StatusGuessed {
		t.Errorf("aaa2 = %+v", n)
	}
}

func TestSubagentEndsReadOnward(t *testing.T) {
	dir, subs := subagentsFixture(t)
	mux, a := subagentsServer(t, claudeSession(dir))
	if res, _ := getSubagents(t, mux); nodeByID(res.Nodes, "aaa2").Status != "running" {
		t.Fatal("aaa2 ended early")
	}
	path := filepath.Join(filepath.Dir(filepath.Dir(subs)), testSessionID+".jsonl")
	ss := a.subagentState.session(testSessionID + "\x00" + dir)
	before := ss.offset
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	// The end of aaa2, then a line still being written
	fmt.Fprint(f, `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-13T10:09:00Z","content":"<task-notification><task-id>aaa2</task-id><status>stopped</status></task-notification>"}`+"\n")
	fmt.Fprint(f, `{"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>aaa4</task-id><status>completed</status>`)
	f.Close()
	res, _ := getSubagents(t, mux)
	if n := nodeByID(res.Nodes, "aaa2"); n.Status != "error" || n.EndTS != "2026-10-13T10:09:00.000Z" {
		t.Errorf("aaa2 = %+v", n)
	}
	if n := nodeByID(res.Nodes, "aaa4"); n.Status != "running" {
		t.Errorf("aaa4 ended from a partial line: %+v", n)
	}
	if ss.offset <= before || !ss.covered {
		t.Errorf("offset %d → %d, covered %v", before, ss.offset, ss.covered)
	}

	// A new file (a rewrite, a cleared session) is read again from the end.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(lines(0, 2)), 0o600); err != nil {
		t.Fatal(err)
	}
	if fileIdentity(mustStat(t, path)) == "" {
		t.Skip("no file identity on this system")
	}
	res, _ = getSubagents(t, mux)
	if n := nodeByID(res.Nodes, "aaa1"); n.Status != "running" {
		t.Errorf("an end from the old file was kept: %+v", n)
	}
}

func TestSubagentScanTail(t *testing.T) {
	// A transcript longer than agentTailMax is read from its last
	// agentTailMax bytes only: its start is not covered, and the line cut
	// at that point is skipped. A line longer than the read buffer is too.
	dir := t.TempDir()
	long := `{"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>aaa1</task-id><status>completed</status></task-notification>","pad":"` +
		strings.Repeat("x", 128*1024) + "\"}\n"
	end := `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-13T10:00:00Z","content":"<task-notification><task-id>aaa3</task-id><status>completed</status></task-notification>"}` + "\n"
	body := strings.Repeat(`{"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>aaa2</task-id><status>completed</status></task-notification>"}`+"\n", agentTailMax/150) +
		long + end
	p := writeTranscript(t, dir, testSessionID, body)
	ss := &subagentSession{ends: map[string]subagentEnd{}, files: map[string]subagentFile{}, metas: map[string]subagentMetaFile{}}
	ss.scan(p)
	if ss.covered || !ss.sawQueue || ss.offset != int64(len(body)) {
		t.Errorf("covered=%v sawQueue=%v offset=%d/%d", ss.covered, ss.sawQueue, ss.offset, len(body))
	}
	// The end row carrying a long report is read from its head.
	if e := ss.ends["aaa1"]; e.status != "completed" {
		t.Errorf("long end row = %+v", e)
	}
	if e := ss.ends["aaa3"]; e.status != "completed" || e.ts != "2026-10-13T10:00:00.000Z" {
		t.Errorf("aaa3 = %+v", e)
	}
	// Rows that are not an enqueue, or name no id or status, add nothing.
	for _, line := range []string{
		`{"type":"queue-operation","operation":"remove","content":"<task-notification><task-id>bbb1</task-id><status>completed</status></task-notification>"}`,
		`{"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>bbb2</task-id></task-notification>"}`,
		`{"type":"queue-operation","operation":"enqueue","content":"<task-notification><status>failed</status></task-notification>"}`,
		`{"type":"queue-operation",`,
	} {
		ss.addEnd([]byte(line))
	}
	if len(ss.ends) != 3 {
		t.Errorf("ends = %+v", ss.ends)
	}
	// A missing transcript leaves what was read.
	ss.scan(filepath.Join(dir, "gone.jsonl"))
	if len(ss.ends) != 3 {
		t.Error("a missing transcript cleared the ends")
	}
}

func TestSubagentLimits(t *testing.T) {
	dir, subs := subagentsFixture(t)
	writeMeta := func(id, parent string, start time.Time) {
		meta := fmt.Sprintf(`{"agentType":"general-purpose","description":"%s","parentAgentId":%q}`, id, parent)
		p := filepath.Join(subs, "agent-"+id+".meta.json")
		if err := os.WriteFile(p, []byte(meta), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, start, start); err != nil {
			t.Fatal(err)
		}
	}
	// A chain six deep: four levels are shown.
	base := time.Now().Add(-time.Hour)
	parent := ""
	for i := range 6 {
		id := fmt.Sprintf("chain%d", i)
		writeMeta(id, parent, base.Add(time.Duration(i)*time.Second))
		parent = id
	}
	// Two subagents naming each other are never reached from the session.
	writeMeta("loopa", "loopb", base)
	writeMeta("loopb", "loopa", base)
	mux, _ := subagentsServer(t, claudeSession(dir))
	res, _ := getSubagents(t, mux)
	if !res.Truncated || nodeByID(res.Nodes, "chain3") == nil || nodeByID(res.Nodes, "chain4") != nil || nodeByID(res.Nodes, "loopa") != nil {
		t.Errorf("depth: truncated=%v", res.Truncated)
	}
	if n := nodeByID(res.Nodes, "chain3"); n.Depth != 4 || len(n.Children) != 0 {
		t.Errorf("chain3 = %+v", n)
	}

	// More than subagentsMaxNodes: the newest are kept.
	for i := range subagentsMaxNodes + 5 {
		writeMeta(fmt.Sprintf("many%03d", i), "", time.Now().Add(time.Duration(i)*time.Second))
	}
	res, _ = getSubagents(t, mux)
	if !res.Truncated || len(res.Nodes) != subagentsMaxNodes || nodeByID(res.Nodes, "many000") != nil || nodeByID(res.Nodes, "many204") == nil {
		t.Errorf("max nodes: truncated=%v roots=%d", res.Truncated, len(res.Nodes))
	}
}

func TestSubagentsRoute(t *testing.T) {
	dir, _ := subagentsFixture(t)
	for name, s := range map[string]AgentSession{
		"codex":            {Agent: "codex", ID: testSessionID},
		"no transcript":    claudeSession(t.TempDir()),
		"relative dir":     {Agent: "claude", ID: testSessionID, ClaudeDir: "relative"},
		"no subagents dir": claudeSession(func() string { d := t.TempDir(); writeTranscript(t, d, testSessionID, lines(0, 1)); return d }()),
	} {
		mux, _ := subagentsServer(t, s)
		if res, body := getSubagents(t, mux); len(res.Nodes) != 0 || !strings.Contains(body, `"nodes":[]`) {
			t.Errorf("%s = %s", name, body)
		}
	}

	mux, _ := subagentsServer(t, claudeSession(dir))
	serve := func(req *http.Request) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	if rec := serve(httptest.NewRequest(http.MethodPost, "/api/mux/panes/p1/agent/subagents", nil)); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/subagents", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
	// A view-only client reads the tree too: it carries no tool output.
	req = httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/subagents", nil)
	req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
	if rec := serve(req); rec.Code != http.StatusOK {
		t.Errorf("view-only = %d", rec.Code)
	}

	none := http.NewServeMux()
	registerMuxRoutes(none, &fakeLocator{}, newStreamTokenStore(), nil, nil)
	rec := httptest.NewRecorder()
	none.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/subagents", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("no agent = %d", rec.Code)
	}
}

func TestChatSkipsQueueOperations(t *testing.T) {
	b, err := os.ReadFile("testdata/claude/subagents-session/transcript.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	entries, _ := claudeJournal{}.Parse(strings.NewReader(string(b)), 0)
	for _, e := range foldToolResults(entries) {
		for _, p := range e.Parts {
			if strings.Contains(p.Text, "task-notification") || strings.Contains(p.Text, "SECRET-RESULT") {
				t.Errorf("chat shows %q", p.Text)
			}
		}
	}
	if len(entries) != 4 {
		t.Errorf("entries = %d", len(entries))
	}
}

func TestOverviewLastTSFromSubagents(t *testing.T) {
	dir, subs := subagentsFixture(t)
	_, a := subagentsServer(t, claudeSession(dir))
	a.sessions = newTTLCache[agentLookup](0)
	// The transcript last wrote at 10:06:01; aaa2 and aaa4 still run and
	// wrote later.
	at := time.Date(2026, 10, 13, 11, 0, 0, 0, time.UTC)
	for _, name := range []string{"agent-aaa2.jsonl", "agent-aaa4.jsonl"} {
		if err := os.Chtimes(filepath.Join(subs, name), at, at); err != nil {
			t.Fatal(err)
		}
	}
	sum, err := a.summarizePane("p1")
	if err != nil || sum.lastTS != "2026-10-13T11:00:00.000Z" {
		t.Errorf("lastTs = %q, %v", sum.lastTS, err)
	}
	// An older subagent write leaves the transcript's time.
	old := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	for _, name := range []string{"agent-aaa2.jsonl", "agent-aaa4.jsonl"} {
		os.Chtimes(filepath.Join(subs, name), old, old)
	}
	if sum, _ := a.summarizePane("p1"); sum.lastTS != "2026-10-13T10:06:01.000Z" {
		t.Errorf("lastTs = %q", sum.lastTS)
	}
}

func TestSubagentFileReads(t *testing.T) {
	dir := t.TempDir()
	// A first line too long to read: no start time from it.
	p := filepath.Join(dir, "long.jsonl")
	os.WriteFile(p, []byte(`{"timestamp":"2026-10-13T10:00:00Z","x":"`+strings.Repeat("y", subagentHeadMax)+"\"}\n"), 0o600)
	f, _ := os.Open(p)
	if got := firstLineTime(f); !got.IsZero() {
		t.Errorf("long first line = %v", got)
	}
	f.Close()
	for _, body := range []string{"", "not json\n", `{"timestamp":"yesterday"}` + "\n"} {
		os.WriteFile(p, []byte(body), 0o600)
		f, _ := os.Open(p)
		if got := firstLineTime(f); !got.IsZero() {
			t.Errorf("%q = %v", body, got)
		}
		f.Close()
	}

	// The last tool of a file longer than the tail read, its cut first line
	// skipped; a call on the line still being written is not counted.
	call := func(name string) string {
		return `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"` + name + `"}]}}` + "\n"
	}
	body := call("Old") + strings.Repeat(`{"type":"user","message":{"content":"pad"}}`+"\n", subagentTailRead/40) +
		call("Bash") + `{"type":"user","message":{"content":"tool_use"}}` + "\n" + `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Partial"}`
	os.WriteFile(p, []byte(body), 0o600)
	f, _ = os.Open(p)
	defer f.Close()
	if got := lastToolName(f, int64(len(body))); got != "Bash" {
		t.Errorf("last tool = %q", got)
	}
	// A tail with no line start at all
	os.WriteFile(p, []byte(strings.Repeat("z", subagentTailRead+10)), 0o600)
	f2, _ := os.Open(p)
	defer f2.Close()
	if got := lastToolName(f2, subagentTailRead+10); got != "" {
		t.Errorf("no line = %q", got)
	}

	// readPlainFile refuses a file over its limit.
	d, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if _, _, ok := readPlainFile(d, e, 10); ok {
			t.Errorf("%s over the limit was read", e.Name())
		}
	}
}

func TestSubagentStoreForgets(t *testing.T) {
	now := time.Now()
	st := newSubagentStore(func() time.Time { return now })
	a := st.session("a")
	st.session("b")
	now = now.Add(subagentsKeep)
	// Asking for a drops b; a stays even though it was asked as long ago.
	if st.session("a") != a {
		t.Error("the session asked for was dropped")
	}
	if _, ok := st.sessions["b"]; ok {
		t.Error("a session not asked for was kept")
	}
}

func TestOpenSubagentsDirErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := openSubagentsDir(filepath.Join(dir, "missing"), "p", testSessionID); err == nil {
		t.Error("a missing root opened")
	}
	if _, err := openSubagentsDir(dir, "p", testSessionID); !os.IsNotExist(err) {
		t.Errorf("missing projects = %v", err)
	}
	// A file where a directory should be
	os.MkdirAll(filepath.Join(dir, "projects", "p", testSessionID), 0o755)
	os.WriteFile(filepath.Join(dir, "projects", "p", testSessionID, "subagents"), nil, 0o600)
	if _, err := openSubagentsDir(dir, "p", testSessionID); err != errSubagentsLink {
		t.Errorf("file = %v", err)
	}
}

func TestSubagentTreeEdges(t *testing.T) {
	// An empty subagents directory
	dir, subs := subagentsFixture(t)
	entries, _ := os.ReadDir(subs)
	for _, e := range entries {
		os.Remove(filepath.Join(subs, e.Name()))
	}
	mux, a := subagentsServer(t, claudeSession(dir))
	if res, _ := getSubagents(t, mux); len(res.Nodes) != 0 {
		t.Errorf("empty dir = %+v", res.Nodes)
	}

	// A subagent file removed between two reads is forgotten.
	dir, subs = subagentsFixture(t)
	mux, a = subagentsServer(t, claudeSession(dir))
	getSubagents(t, mux)
	ss := a.subagentState.session(testSessionID + "\x00" + dir)
	if _, ok := ss.files["aaa3"]; !ok {
		t.Fatal("aaa3's file was not read")
	}
	os.Remove(filepath.Join(subs, "agent-aaa3.jsonl"))
	res, _ := getSubagents(t, mux)
	if _, ok := ss.files["aaa3"]; ok {
		t.Error("a removed file is still known")
	}
	if n := nodeByID(res.Nodes, "aaa3"); n == nil || n.LastTool != "" {
		t.Errorf("aaa3 from its meta alone = %+v", n)
	}

	// A transcript that is a link to another place in the Claude dir has no
	// subagents directory beside it.
	dir, subs = subagentsFixture(t)
	path := filepath.Join(filepath.Dir(filepath.Dir(subs)), testSessionID+".jsonl")
	other := filepath.Join(dir, "other")
	os.MkdirAll(other, 0o755)
	if err := os.Rename(path, filepath.Join(other, testSessionID+".jsonl")); err != nil {
		t.Fatal(err)
	}
	symlinkOrSkip(t, filepath.Join(other, testSessionID+".jsonl"), path)
	mux, _ = subagentsServer(t, claudeSession(dir))
	if res, _ := getSubagents(t, mux); len(res.Nodes) != 0 {
		t.Errorf("linked transcript = %+v", res.Nodes)
	}
}

func TestSubagentLastWrite(t *testing.T) {
	dir, subs := subagentsFixture(t)
	st := newSubagentStore(time.Now)
	key := testSessionID + "\x00" + dir
	// Ended subagents' writes do not count, only running ones'.
	run := time.Date(2026, 10, 13, 11, 0, 0, 0, time.UTC)
	ended := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	os.Chtimes(filepath.Join(subs, "agent-aaa2.jsonl"), run, run)
	os.Chtimes(filepath.Join(subs, "agent-aaa4.jsonl"), run.Add(-time.Minute), run.Add(-time.Minute))
	for _, n := range []string{"agent-aaa1.jsonl", "agent-aaa3.jsonl"} {
		os.Chtimes(filepath.Join(subs, n), ended, ended)
	}
	last, err := st.lastWrite(key, claudeSession(dir))
	if err != nil || !last.Equal(run) {
		t.Errorf("lastWrite = %v, %v", last, err)
	}
	// The background command's end, which names no subagent, is dropped.
	if _, ok := st.session(key).ends["bv90bdvih"]; ok {
		t.Error("a background command's end was kept")
	}
	// Nothing reports ends and the files are quiet: none counts as running.
	if err := os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(subs)), testSessionID+".jsonl"), []byte(lines(0, 2)), 0o600); err != nil {
		t.Fatal(err)
	}
	if fileIdentity(mustStat(t, filepath.Join(filepath.Dir(filepath.Dir(subs)), testSessionID+".jsonl"))) == "" {
		t.Skip("no file identity on this system")
	}
	setMtime(t, subs, subagentGuessIdle+time.Minute)
	if last, _ := (newSubagentStore(time.Now)).lastWrite(key, claudeSession(dir)); !last.IsZero() {
		t.Errorf("guessed done still running: %v", last)
	}
	// No transcript, another agent: nothing.
	if last, err := st.lastWrite("k", claudeSession(t.TempDir())); err != nil || !last.IsZero() {
		t.Errorf("no transcript = %v, %v", last, err)
	}
	_, a := subagentsServer(t, AgentSession{Agent: "codex"})
	if last, err := a.subagentLastWrite(AgentSession{Agent: "codex"}); err != nil || !last.IsZero() {
		t.Errorf("codex = %v, %v", last, err)
	}
}

func TestSubagentMetaCached(t *testing.T) {
	dir, subs := subagentsFixture(t)
	mux, a := subagentsServer(t, claudeSession(dir))
	getSubagents(t, mux)
	ss := a.subagentState.session(testSessionID + "\x00" + dir)
	if m := ss.metas["aaa1"]; !m.ok || m.m.AgentType != "code-reviewer" {
		t.Fatalf("aaa1 meta = %+v", m)
	}
	// Read again only once it changed
	p := filepath.Join(subs, "agent-aaa1.meta.json")
	os.WriteFile(p, []byte(`{"agentType":"renamed-type","description":"Review parser"}`), 0o600)
	later := time.Now().Add(time.Minute)
	os.Chtimes(p, later, later)
	res, _ := getSubagents(t, mux)
	if n := nodeByID(res.Nodes, "aaa1"); n.Type != "renamed-type" {
		t.Errorf("aaa1 = %+v", n)
	}
	// A broken meta stays known as broken; a removed one is forgotten.
	if m, ok := ss.metas["aaa5"]; !ok || m.ok {
		t.Errorf("aaa5 meta = %+v", m)
	}
	os.Remove(filepath.Join(subs, "agent-aaa5.meta.json"))
	getSubagents(t, mux)
	if _, ok := ss.metas["aaa5"]; ok {
		t.Error("a removed meta is still known")
	}
	// A meta over the size limit is not read.
	os.WriteFile(p, []byte(strings.Repeat(" ", subagentMetaMax+1)), 0o600)
	res, _ = getSubagents(t, mux)
	if n := nodeByID(res.Nodes, "aaa1"); n == nil || n.Type != "agent" {
		t.Errorf("oversized meta = %+v", n)
	}
}

func TestSubagentFileGone(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"gone", "locked"} {
		os.WriteFile(filepath.Join(dir, n), []byte("{}"), 0o600)
	}
	rt, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	entries := listSubagentDir(rt)
	os.Remove(filepath.Join(dir, "gone"))
	os.Chmod(filepath.Join(dir, "locked"), 0)
	for _, e := range entries {
		if e.Name() == "locked" && (os.Getuid() == 0 || runtime.GOOS == "windows") {
			continue // root, and Windows, open it anyway
		}
		if f, _, ok := openPlainFile(rt, e); ok {
			f.Close()
			t.Errorf("%s opened", e.Name())
		}
	}
	// An end without a readable time keeps no time.
	ss := &subagentSession{ends: map[string]subagentEnd{}}
	ss.addEnd([]byte(`{"type":"queue-operation","operation":"enqueue","timestamp":"soon","content":"<task-notification><task-id>x1</task-id><status>completed</status></task-notification>"}`))
	if e := ss.ends["x1"]; e.status != "completed" || e.ts != "" {
		t.Errorf("x1 = %+v", e)
	}
}
