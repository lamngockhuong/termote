package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// opencodeHistoryFixture is a resume fixture (a Claude session at the root,
// a Codex one in sub) with an OpenCode service whose root sessions are:
// sesRoot at the root, sesSub in sub, sesOut in another directory,
// sesSibling in a directory whose name starts with the root's, and a
// subagent's session of sesRoot (listed by the service only without
// parentID=null).
type opencodeHistoryFixture struct {
	*resumeFixture
	oc *fakeOpencode
}

func newOpencodeHistoryFixture(t *testing.T) *opencodeHistoryFixture {
	t.Helper()
	fx := newResumeFixture(t)
	oc := newFakeOpencode(t)
	now := time.Now().UnixMilli()
	out := realTemp(t)
	sibling := fx.root + "-x"
	os.MkdirAll(sibling, 0o755)
	t.Cleanup(func() { os.RemoveAll(sibling) })
	msgs := testOpencodeMessages(t, "message-list-after-tool.json")
	oc.set(func() {
		oc.list = []json.RawMessage{
			testOpencodeSession("sesRoot", "", "Fix the login\nbug", fx.root, now-1000),
			testOpencodeSession("ses_child1", "sesRoot", "Explore files", fx.root, now-1500),
			testOpencodeSession("sesSub", "", "", fx.sub, now-2000),
			testOpencodeSession("sesOut", "", "Elsewhere", out, now-3000),
			testOpencodeSession("sesSibling", "", "Sibling", sibling, now-4000),
			testOpencodeSession("../etc", "", "Bad id", fx.root, now-5000),
		}
		for _, id := range []string{"sesRoot", "ses_child1", "sesSub", "sesOut", "sesSibling"} {
			oc.messages[id] = msgs
		}
	})
	return &opencodeHistoryFixture{resumeFixture: fx, oc: oc}
}

func TestOpencodeHistoryList(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	code, res, raw := listHistory(t, fx.h, "?agent=opencode")
	if code != 200 {
		t.Fatalf("list = %d %v", code, raw)
	}
	var got []string
	for _, s := range res.Sessions {
		got = append(got, s.ID+"|"+s.Cwd+"|"+s.Title+"|"+s.TitleSource)
		if s.Agent != "opencode" || s.UpdatedAt == "" {
			t.Errorf("row %+v", s)
		}
	}
	// Root sessions in the root or under it only, newest first; titles on
	// one line.
	want := []string{"sesRoot||Fix the login bug|ai", "sesSub|sub||ai"}
	if !slices.Equal(got, want) {
		t.Errorf("sessions = %q, want %q", got, want)
	}
	// No absolute path reaches the client.
	data, _ := json.Marshal(raw)
	if strings.Contains(string(data), fx.root) {
		t.Errorf("reply holds the root: %s", data)
	}
	// Every root session is read (the service's directory filter is exact),
	// asking for root sessions only.
	reqs := fx.oc.reqs()
	if !slices.ContainsFunc(reqs, func(r string) bool {
		return strings.HasPrefix(r, "GET /api/session?") && strings.Contains(r, "parentID=null") && !strings.Contains(r, "directory")
	}) {
		t.Errorf("requests = %q", reqs)
	}
	// Mixed with the other agents', in one listing.
	_, all, _ := listHistory(t, fx.h, "")
	agents := map[string]int{}
	for _, s := range all.Sessions {
		agents[s.Agent]++
	}
	if agents["claude"] != 1 || agents["codex"] != 1 || agents["opencode"] != 2 {
		t.Errorf("agents = %v", agents)
	}
	if code, _, raw := listHistory(t, fx.h, "?agent=gemini"); code != 400 {
		t.Errorf("gemini = %d %v", code, raw)
	}
}

// A service that does not run, or fails, lists no OpenCode session and
// fails nothing else.
func TestOpencodeHistoryServiceDown(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	fx.oc.set(func() { fx.oc.status = http.StatusInternalServerError })
	code, res, _ := listHistory(t, fx.h, "")
	if code != 200 || len(res.Sessions) != 2 || slices.ContainsFunc(res.Sessions, func(s historySession) bool { return s.Agent == "opencode" }) {
		t.Errorf("failing service = %d %+v", code, res.Sessions)
	}
	fx2 := newOpencodeHistoryFixture(t)
	stubOpencodeStateDir(t, t.TempDir())
	if code, res, _ := listHistory(t, fx2.h, ""); code != 200 || len(res.Sessions) != 2 {
		t.Errorf("no service = %d %+v", code, res.Sessions)
	}
}

func TestOpencodeRootSessionsPaging(t *testing.T) {
	oc := newFakeOpencode(t)
	var list []json.RawMessage
	for i := range 250 {
		id := "ses_" + strconv.Itoa(i)
		list = append(list, testOpencodeSession(id, "", "t", "/work/proj", int64(10_000-i)))
		if i%50 == 0 {
			list = append(list, testOpencodeSession(id+"_sub", id, "t", "/work/proj", int64(10_000-i)))
		}
	}
	oc.set(func() { oc.list = list })
	c, err := opencodeConnect()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	got, err := c.rootSessions(ctx, 1000)
	if err != nil || len(got.sessions) != 250 || got.truncated || got.sessions[0].ID != "ses_0" || got.sessions[249].ID != "ses_249" {
		t.Fatalf("all = %d %v %v", len(got.sessions), got.truncated, err)
	}
	pages := 0
	for _, r := range oc.reqs() {
		if strings.HasPrefix(r, "GET /api/session?") {
			pages++
		}
	}
	if pages != 3 {
		t.Errorf("pages = %d, want 3", pages)
	}
	// Stopped at max: the rest is not read.
	got, err = c.rootSessions(ctx, 150)
	if err != nil || len(got.sessions) != 150 || !got.truncated {
		t.Errorf("max = %d %v %v", len(got.sessions), got.truncated, err)
	}
	// A page the service refuses fails the read.
	oc.set(func() { oc.status = http.StatusBadRequest })
	if _, err := c.rootSessions(ctx, 10); err == nil {
		t.Error("refused page: no error")
	}
}

// The shapes recorded from OpenCode 2.3.0: a subagent's session is not a
// root one, and the directory needs no drive letter to be read.
func TestOpencodeRootSessionsRecorded(t *testing.T) {
	oc := newFakeOpencode(t)
	var page struct{ Data []json.RawMessage }
	json.Unmarshal(testOpencodeFixture(t, "session-list.json"), &page)
	oc.set(func() { oc.list = page.Data })
	c, _ := opencodeConnect()
	got, err := c.rootSessions(context.Background(), 100)
	if err != nil || len(got.sessions) != 2 || got.sessions[0].ID != "sesFixT1" || got.sessions[1].ID != "sesFixP2" ||
		got.sessions[0].Location.Directory != "/work/proj" || got.sessions[0].Title != "Spike title" || got.sessions[0].Time.Updated != 1794712614497 {
		t.Errorf("sessions = %+v %v", got.sessions, err)
	}
	if e, ok := opencodeHistoryEntry("/work", got.sessions[0]); !ok || e.Cwd != "proj" || e.updated.UnixMilli() != 1794712614497 {
		t.Errorf("entry = %+v %v", e, ok)
	}
	for _, root := range []string{"/work/pro", "/other"} {
		if _, ok := opencodeHistoryEntry(root, got.sessions[0]); ok {
			t.Errorf("placed under %s", root)
		}
	}
	for _, dir := range []string{"", "proj", "work/proj"} {
		s := opencodeSessionInfo{ID: "sesA"}
		s.Location.Directory = dir
		if _, ok := opencodeHistoryEntry("/work", s); ok {
			t.Errorf("directory %q placed", dir)
		}
	}
}

func TestOpencodeHistoryTranscript(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	path := func(id string) string {
		return "/api/mux/panes/0/agent/history/" + id + "/transcript?agent=opencode"
	}
	code, body := getAPI(t, fx.h, path("sesRoot"))
	if code != 200 || body["sessionId"] != "sesRoot" || body["agent"] != "opencode" || len(body["entries"].([]any)) == 0 {
		t.Fatalf("root = %d %v", code, body)
	}
	if code, _ := getAPI(t, fx.h, path("sesSub")); code != 200 {
		t.Errorf("sub = %d", code)
	}
	for _, tc := range []struct {
		path   string
		status int
	}{
		// Another directory, a sibling, a subagent's or an unknown session:
		// missing, and the service is never asked for its messages.
		{path("sesOut"), 404},
		{path("sesSibling"), 404},
		{path("ses_child1"), 404},
		{path("sesNone"), 404},
		// Not an OpenCode id, or a Claude Code id named as OpenCode's.
		{path("..%2Fetc"), 400},
		{path(histID1), 400},
		{"/api/mux/panes/0/agent/history/sesRoot/transcript?agent=claude", 400},
	} {
		if code, body := getAPI(t, fx.h, tc.path); code != tc.status {
			t.Errorf("%s = %d %v", tc.path, code, body)
		}
	}
	for _, r := range fx.oc.reqs() {
		if strings.Contains(r, "/message") && !strings.Contains(r, "/sesRoot/") && !strings.Contains(r, "/sesSub/") {
			t.Errorf("asked %s", r)
		}
	}
	// A view-only client reads the words only.
	rec := serve(fx.h, viewRequest("GET", path("sesRoot"), ""))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), `"kind":"tool"`) {
		t.Errorf("view-only = %d %s", rec.Code, rec.Body)
	}
}

// A fork's messages are copies whose ids end in _<n> (OpenCode 2.3.0): its
// transcript is read whole, with no part of its parent added.
func TestOpencodeForkTranscript(t *testing.T) {
	oc := newFakeOpencode(t)
	msgs := testOpencodeMessages(t, "message-list-fork.json")
	oc.set(func() { oc.messages["sesFork"] = msgs })
	res, err := readOpencodeTranscript(AgentSession{Agent: "opencode", ID: "sesFork"}, "", "")
	if err != nil || len(res.Entries) != 4 {
		t.Fatalf("fork = %d entries, %v", len(res.Entries), err)
	}
	if res.Entries[0].Role != "user" || res.Entries[1].Role != "assistant" {
		t.Errorf("entries = %+v", res.Entries)
	}
	// The cursor names the last copy, so the next read finds it.
	c, _ := decodeCursor(res.Cursor)
	if !strings.HasSuffix(c.File, "_23") {
		t.Errorf("cursor = %+v", c)
	}
	next, err := readOpencodeTranscript(AgentSession{Agent: "opencode", ID: "sesFork"}, res.Cursor, "")
	if err != nil || next.Reset || len(next.Entries) != 0 {
		t.Errorf("next = %+v %v", next, err)
	}
}

func TestOpencodeResume(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	code, body := fx.resume(t, map[string]any{"agent": "opencode", "session": "sesRoot", "where": "tab"})
	if code != 200 || body["tabId"] != "t1" {
		t.Fatalf("tab = %d %v", code, body)
	}
	// In the pane's dir no cd; sesSub ran in sub.
	fx.resume(t, map[string]any{"agent": "opencode", "session": "sesSub", "where": "here"})
	want := []string{"%1 opencode --session sesRoot", "0 cd " + shellQuote(shellPOSIX, fx.sub) + " && opencode --session sesSub"}
	if got := fx.m.typedLines(); !slices.Equal(got, want) {
		t.Errorf("typed %q, want %q", got, want)
	}
	if fx.m.tabNames[0] != "Fix the login bug" {
		t.Errorf("tab name = %q", fx.m.tabNames)
	}
	// Outside the root, a subagent's, or not an id: nothing typed.
	for _, id := range []string{"sesOut", "ses_child1", "sesSibling"} {
		if code, body := fx.resume(t, map[string]any{"agent": "opencode", "session": id, "where": "tab"}); code != 404 || body["code"] != "session_not_found" {
			t.Errorf("%s = %d %v", id, code, body)
		}
	}
	if code, _ := fx.resume(t, map[string]any{"agent": "opencode", "session": "x; rm -rf ~", "where": "tab"}); code != 400 {
		t.Errorf("bad id = %d", code)
	}
	if len(fx.m.typedLines()) != 2 {
		t.Errorf("typed %q", fx.m.typedLines())
	}
}

func TestOpencodeResumeFork(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	fx.setLive("opencode", "sesRoot")
	// Running in a pane: opened again only as a fork.
	code, body := fx.resume(t, map[string]any{"agent": "opencode", "session": "sesRoot", "where": "tab"})
	if code != 409 || body["code"] != "session_live" || body["paneId"] != "9" {
		t.Fatalf("live = %d %v", code, body)
	}
	code, body = fx.resume(t, map[string]any{"agent": "opencode", "session": "sesRoot", "where": "tab", "fork": true})
	if code != 200 {
		t.Fatalf("fork = %d %v", code, body)
	}
	if got := fx.m.typedLines(); !slices.Equal(got, []string{"%1 opencode --session ses_fork1"}) {
		t.Errorf("typed %q", got)
	}
	if !slices.Contains(fx.oc.reqs(), "POST /api/session/sesRoot/fork") {
		t.Errorf("requests = %q", fx.oc.reqs())
	}
	// Here, in the pane's shell.
	fx.m.busy["0"] = false
	if code, body := fx.resume(t, map[string]any{"agent": "opencode", "session": "sesSub", "where": "here", "fork": true}); code != 200 {
		t.Fatalf("fork here = %d %v", code, body)
	}
	if got := fx.m.typedLines(); got[1] != "0 cd "+shellQuote(shellPOSIX, fx.sub)+" && opencode --session ses_fork2" {
		t.Errorf("typed %q", got)
	}
	// A session outside the root is never forked.
	if code, _ := fx.resume(t, map[string]any{"agent": "opencode", "session": "sesOut", "where": "tab", "fork": true}); code != 404 {
		t.Errorf("fork outside = %d", code)
	}
	if slices.Contains(fx.oc.reqs(), "POST /api/session/sesOut/fork") {
		t.Error("forked a session outside the root")
	}
}

func TestOpencodeResumeForkFails(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	// The service fails the fork: its words never reach the client, the new
	// tab is closed again and nothing is typed.
	fx.oc.set(func() { fx.oc.writeStatus = http.StatusInternalServerError })
	code, body := fx.resume(t, map[string]any{"agent": "opencode", "session": "sesRoot", "where": "tab", "fork": true})
	if code != http.StatusBadGateway || body["code"] != "agent_unavailable" || !slices.Contains(fx.m.calls, "close t1") {
		t.Errorf("tab = %d %v %v", code, body, fx.m.calls)
	}
	if data, _ := json.Marshal(body); strings.Contains(string(data), "write words") {
		t.Errorf("service text: %s", data)
	}
	if code, body := fx.resume(t, map[string]any{"agent": "opencode", "session": "sesRoot", "where": "here", "fork": true}); code != http.StatusBadGateway {
		t.Errorf("here = %d %v", code, body)
	}
	// The session gone from the service since the listing.
	fx.oc.set(func() { fx.oc.writeStatus = 0; fx.oc.list = fx.oc.list[1:] })
	if code, body := fx.resume(t, map[string]any{"agent": "opencode", "session": "sesRoot", "where": "tab", "fork": true}); code != 404 || body["code"] != "session_not_found" {
		t.Errorf("gone = %d %v", code, body)
	}
	// No service at all.
	stubOpencodeStateDir(t, t.TempDir())
	if code, body := fx.resume(t, map[string]any{"agent": "opencode", "session": "sesRoot", "where": "tab", "fork": true}); code != http.StatusBadGateway {
		t.Errorf("no service = %d %v", code, body)
	}
	if len(fx.m.typedLines()) != 0 {
		t.Errorf("typed %q", fx.m.typedLines())
	}
}

// A fork's reply without a session id of OpenCode's form opens nothing.
func TestOpencodeForkReply(t *testing.T) {
	newFakeOpencode(t)
	c, _ := opencodeConnect()
	if _, err := c.fork(context.Background(), "../x"); err == nil {
		t.Error("forked a bad id")
	}
	if _, err := c.fork(context.Background(), "sesNone"); err == nil {
		t.Error("forked an unknown session")
	}
	oc := newFakeOpencode(t)
	oc.set(func() { oc.list = []json.RawMessage{testOpencodeSession("sesA", "", "t", "/w", 1)} })
	c, _ = opencodeConnect()
	if id, err := c.fork(context.Background(), "sesA"); err != nil || id != "ses_fork1" {
		t.Errorf("fork = %q %v", id, err)
	}
}

func TestOpencodeSessionTarget(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	for _, tc := range []struct {
		q      string
		status int
	}{
		{"?agent=opencode&session=..%2Fx", 400},
		{"?agent=opencode&session=" + histID1, 400},
		{"?agent=opencode&session=sesOut", 404},
		// Found: the service holds no such session yet, which has used
		// nothing.
		{"?agent=opencode&session=sesRoot", 200},
	} {
		code, body := getAPI(t, fx.h, "/api/mux/panes/0/agent/usage"+tc.q)
		if code != tc.status {
			t.Errorf("%s = %d %v", tc.q, code, body)
		}
		if tc.status == 404 && strings.Contains(tc.q, "sesOut") && body["code"] != "session_not_found" {
			t.Errorf("%s: %v", tc.q, body)
		}
	}
}

func TestResumeCommandOpencode(t *testing.T) {
	// The fork is made before: the line opens a session either way.
	for _, fork := range []bool{false, true} {
		if got := resumeCommand(shellPOSIX, "opencode", "ses_AB12", fork, ""); got != "opencode --session ses_AB12" {
			t.Errorf("fork %v = %q", fork, got)
		}
	}
	if got := resumeCommand(shellPwsh, "opencode", "sesA", false, `C:\r`); got != `Set-Location -LiteralPath 'C:\r'; opencode --session sesA` {
		t.Errorf("pwsh = %q", got)
	}
	if shortSessionID("sesA") != "sesA" || shortSessionID("ses_0123456789") != "ses_0123" {
		t.Error("shortSessionID")
	}
	if s := resumeTabName(historySession{Agent: "opencode", ID: "sesA"}); s != "opencode:sesA" {
		t.Errorf("tab name = %q", s)
	}
}

func TestHistorySessionID(t *testing.T) {
	for _, tc := range []struct {
		agent, id string
		ok        bool
	}{
		{"claude", histID1, true}, {"codex", histID1, true}, {"opencode", "sesA", true},
		{"opencode", histID1, false}, {"claude", "sesA", false}, {"gemini", histID1, false},
		{"opencode", "ses/../x", false},
	} {
		if historySessionID(tc.agent, tc.id) != tc.ok {
			t.Errorf("%s %s", tc.agent, tc.id)
		}
	}
}

// A TUI started or resumed by termote (always with --session) has a session
// on Herdr even when no integration of Herdr reports one: its argv's.
func TestHerdrOpencodeSessionFromProcess(t *testing.T) {
	newFakeOpencode(t)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	var walked []int
	under := "ses_started"
	orig := herdrPaneOpencodeSession
	herdrPaneOpencodeSession = func(key string, pid int) string {
		walked = append(walked, pid)
		return under
	}
	t.Cleanup(func() { herdrPaneOpencodeSession = orig })
	f.mu.Lock()
	f.agent, f.paneExtra = "opencode", map[string]any{"agent_status": "idle"}
	f.procs = map[string]any{"wR:p3": fakeProcessInfo("wR:p3", 4242, 4300, fakeProc(4300, "opencode", "opencode", "--session", under))}
	f.mu.Unlock()
	s, ok, err := m.AgentSession(ctx, "wR:p3")
	if err != nil || !ok || s.ID != under || s.Status != "idle" || s.Target != "wR:p3" || len(walked) != 1 || walked[0] != 4242 {
		t.Fatalf("session = %+v %v %v (walked %v)", s, ok, err, walked)
	}
	// What Herdr reports comes first.
	f.mu.Lock()
	f.paneExtra = map[string]any{"agent_status": "working", "agent_session": map[string]any{
		"agent": "opencode", "kind": "id", "value": "sesReported", "source": "herdr:opencode"}}
	f.mu.Unlock()
	if s, _, _ := m.AgentSession(ctx, "wR:p3"); s.ID != "sesReported" || len(walked) != 1 {
		t.Errorf("reported = %+v (walked %v)", s, walked)
	}
	// No TUI with --session, or no service: no session.
	f.mu.Lock()
	f.paneExtra = map[string]any{"agent_status": "idle"}
	f.mu.Unlock()
	under = ""
	if s, ok, _ := m.AgentSession(ctx, "wR:p3"); !ok || s.ID != "" {
		t.Errorf("no --session = %+v", s)
	}
	under = "ses_started"
	stubOpencodeStateDir(t, t.TempDir())
	if s, ok, _ := m.AgentSession(ctx, "wR:p3"); !ok || s.ID != "" {
		t.Errorf("no service = %+v", s)
	}
}

func TestFindOpencodeUnder(t *testing.T) {
	if id := findOpencodeUnder("k", 0); id != "" {
		t.Errorf("no pid = %q", id)
	}
}

// countModelReads counts the reads of a session's last answer.
func countModelReads(oc *fakeOpencode) map[string]int {
	n := map[string]int{}
	for _, r := range oc.reqs() {
		if strings.Contains(r, "/message?") && strings.Contains(r, "type=assistant") && strings.Contains(r, "limit=1&") {
			id := strings.TrimPrefix(r, "GET /api/session/")
			n[id[:strings.Index(id, "/")]]++
		}
	}
	return n
}

// The model of an OpenCode session is its last answer's: read only for the
// sessions of the page sent, kept until the session changes, and left out
// when it cannot be read.
func TestOpencodeHistoryModel(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	models := func(q string) map[string]string {
		t.Helper()
		code, res, raw := listHistory(t, fx.h, q)
		if code != 200 {
			t.Fatalf("list = %d %v", code, raw)
		}
		out := map[string]string{}
		for _, s := range res.Sessions {
			out[s.ID] = s.Model
		}
		return out
	}
	if got := models(""); got["sesRoot"] != "fake/m1" || got["sesSub"] != "fake/m1" || len(got) != 4 {
		t.Errorf("models = %v", got)
	}
	// Claude Code and Codex rows have none; sessions outside the root are
	// never asked.
	if reads := countModelReads(fx.oc); len(reads) != 2 || reads["sesRoot"] != 1 || reads["sesSub"] != 1 {
		t.Errorf("reads = %v", reads)
	}
	_, _, raw := listHistory(t, fx.h, "")
	for _, s := range raw["sessions"].([]any) {
		row := s.(map[string]any)
		if _, has := row["model"]; has != (row["agent"] == "opencode") {
			t.Errorf("row %v", row)
		}
	}
	if reads := countModelReads(fx.oc); reads["sesRoot"] != 1 {
		t.Errorf("read again within the cache: %v", reads)
	}

	// A session that changed is read again; one whose last answer names no
	// usable model, or none at all, has none.
	h := newHistoryAPI()
	now := time.Now()
	page := func() []historySession {
		t.Helper()
		rows := []historySession{
			{Agent: "opencode", ID: "sesRoot", updated: now},
			{Agent: "claude", ID: "sesRoot", updated: now},
			{Agent: "opencode", ID: "sesSub", updated: now},
		}
		h.opencodeHistoryModels(context.Background(), rows)
		if rows[1].Model != "" {
			t.Errorf("claude row = %+v", rows[1])
		}
		return rows
	}
	if rows := page(); rows[0].Model != "fake/m1" || rows[2].Model != "fake/m1" {
		t.Errorf("rows = %+v", rows)
	}
	odd, _ := json.Marshal(map[string]any{"data": []any{
		map[string]any{"id": "msg_x", "type": "assistant", "time": map[string]any{"created": now.UnixMilli()},
			"model": map[string]any{"id": "m<script>", "providerID": "fake"}},
	}})
	fx.oc.set(func() {
		fx.oc.messages["sesRoot"] = testOpencodeMessagesOf(t, odd)
		fx.oc.messages["sesSub"] = fx.oc.messages["sesSub"][:1] // its question only
	})
	if rows := page(); rows[0].Model != "fake/m1" {
		t.Errorf("unchanged session read again: %+v", rows)
	}
	now = now.Add(time.Second)
	if rows := page(); rows[0].Model != "" || rows[2].Model != "" {
		t.Errorf("changed = %+v", rows)
	}

	// A read that fails leaves the model out and is not kept.
	var logs strings.Builder
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	now = now.Add(time.Second)
	fx.oc.set(func() {
		fx.oc.big = 1
		delete(fx.oc.messages, "sesSub")
	})
	if rows := page(); rows[0].Model != "" || rows[2].Model != "" {
		t.Errorf("failing reads = %+v", rows)
	}
	if !strings.Contains(logs.String(), "opencode history model") || strings.Contains(logs.String(), "sesSub") {
		t.Errorf("logs = %q", logs.String())
	}
	fx.oc.set(func() {
		fx.oc.big = 0
		fx.oc.messages["sesRoot"] = fx.oc.messages["sesOut"]
	})
	if rows := page(); rows[0].Model != "fake/m1" {
		t.Errorf("after the failure = %+v", rows)
	}
	// No service: no model, nothing asked.
	stubOpencodeStateDir(t, t.TempDir())
	now = now.Add(time.Second)
	if rows := page(); rows[0].Model != "" {
		t.Errorf("no service = %+v", rows)
	}
	if _, err := (&opencodeClient{}).lastModel(context.Background(), "../x"); err == nil {
		t.Error("bad id: no error")
	}
}

// Only the sessions of the page sent have their model read.
func TestOpencodeHistoryModelPage(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	now := time.Now().UnixMilli()
	msgs := testOpencodeMessages(t, "message-list-after-tool.json")
	fx.oc.set(func() {
		fx.oc.list = nil
		for i := range historyPage + 5 {
			id := "sesP" + strconv.Itoa(i)
			fx.oc.list = append(fx.oc.list, testOpencodeSession(id, "", "t", fx.root, now-int64(i)))
			fx.oc.messages[id] = msgs
		}
	})
	_, res, _ := listHistory(t, fx.h, "?agent=opencode")
	if len(res.Sessions) != historyPage || res.Next == "" || res.Sessions[historyPage-1].Model != "fake/m1" {
		t.Fatalf("page = %d %q", len(res.Sessions), res.Next)
	}
	if n := len(countModelReads(fx.oc)); n != historyPage {
		t.Errorf("models read = %d, want %d", n, historyPage)
	}
	_, res, _ = listHistory(t, fx.h, "?agent=opencode&cursor="+url.QueryEscape(res.Next))
	if len(res.Sessions) != 5 || res.Sessions[4].Model != "fake/m1" || len(countModelReads(fx.oc)) != historyPage+5 {
		t.Errorf("next page = %d, reads %d", len(res.Sessions), len(countModelReads(fx.oc)))
	}
}
