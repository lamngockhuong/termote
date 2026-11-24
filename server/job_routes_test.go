package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// jobsTest is an agent API over a fake Claude Code in pane w1:pa, with a
// transcript, and a job ledger in a temporary dir.
type jobsTest struct {
	t     *testing.T
	f     *fakeWriter
	mux   *http.ServeMux
	agent *agentAPI
	dir   string // the ledger's
	path  string // the transcript's
}

const jobsTranscript = `{"type":"user","uuid":"00000000-0000-4000-8000-0000000000a1","timestamp":"2026-11-23T09:00:00.000Z","message":{"role":"user","content":"Tidy the parser"}}
{"type":"assistant","uuid":"00000000-0000-4000-8000-0000000000a2","timestamp":"2026-11-23T09:00:02.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Done."}]}}
`

func newJobsTest(t *testing.T) *jobsTest {
	t.Helper()
	f := newFakeWriter()
	claudeDir := t.TempDir()
	path := writeTranscript(t, claudeDir, testSessionID, jobsTranscript)
	f.session.ClaudeDir = claudeDir
	f.snap = agentPanes(1)
	setPaneStatus(f, "idle")
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, f, newStreamTokenStore(), nil, nil)
	agent.sessions = newTTLCache[agentLookup](0)
	agent.reads = newTTLCache[transcriptResponse](0)
	agent.input.captures = newTTLCache[string](0)
	dir := t.TempDir()
	store, err := newJobStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	agent.jobs = store
	jt := &jobsTest{t: t, f: f, mux: mux, agent: agent, dir: dir, path: path}
	jt.snapshot()
	return jt
}

// setPaneStatus sets the status the snapshot gives w1:pa's agent.
func setPaneStatus(f *fakeWriter, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snap.Groups[0].Tabs[0].Panes[0].Agent = &AgentInfo{Name: "claude", Status: status}
	f.session.Status = status
}

// snapshot has the tracker read the fake's snapshot.
func (jt *jobsTest) snapshot() {
	serve(jt.mux, httptest.NewRequest(http.MethodGet, "/api/mux/snapshot", nil))
}

// as: "socket" (the CLI), "full" (a browser signed in), "view" (a
// view-only device), "bridge" (another termote with the full role).
func (jt *jobsTest) do(as, method, path string, body any) (int, map[string]any) {
	jt.t.Helper()
	var rd *bytes.Reader
	if s, ok := body.(string); ok {
		rd = bytes.NewReader([]byte(s))
	} else if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("Content-Type", "application/json")
	switch as {
	case "socket":
		req = onLocalSocket(req)
	case "full":
		req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authSession, Role: roleFull, SessionID: "s"}))
	case "view":
		req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
	case "bridge":
		req = onBridge(req)
		req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authMachine, Role: roleFull}))
	}
	rec := serve(jt.mux, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out == nil {
		out = map[string]any{"raw": rec.Body.String()}
	}
	return rec.Code, out
}

func (jt *jobsTest) create(body map[string]any) map[string]any {
	jt.t.Helper()
	code, out := jt.do("socket", http.MethodPost, "/api/mux/jobs", body)
	if code != http.StatusCreated {
		jt.t.Fatalf("create = %d %v", code, out)
	}
	return out["job"].(map[string]any)
}

// list is the full GET's jobs (every one, finished too).
func (jt *jobsTest) list() []map[string]any {
	jt.t.Helper()
	code, out := jt.do("socket", http.MethodGet, "/api/mux/jobs?all=1", nil)
	if code != http.StatusOK {
		jt.t.Fatalf("list = %d %v", code, out)
	}
	var jobs []map[string]any
	for _, j := range out["jobs"].([]any) {
		jobs = append(jobs, j.(map[string]any))
	}
	return jobs
}

func live(j map[string]any) map[string]any { return j["live"].(map[string]any) }

func (jt *jobsTest) appendTranscript(line string) {
	jt.t.Helper()
	f, err := os.OpenFile(jt.path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		jt.t.Fatal(err)
	}
	defer f.Close()
	f.WriteString(line + "\n")
}

func TestJobCreateAndRoles(t *testing.T) {
	jt := newJobsTest(t)
	j := jt.create(map[string]any{"title": "Fix\x1b[2J the parser​", "prompt": "Tidy the parser", "pane": "w1:pa", "createdBy": "w1:orch"})
	agent := j["agent"].(map[string]any)
	if j["title"] != "Fix[2J the parser" || j["state"] != "active" || j["createdBy"] != "w1:orch" || j["workspace"] != "w1" ||
		agent["pid"] != float64(42) || agent["start"] != "7" || agent["key"] != "w1:pa" || agent["kind"] != "claude" {
		t.Errorf("job %v", j)
	}
	if l := live(j); l["status"] != "idle" || l["unread"] != nil {
		t.Errorf("live %v", l)
	}

	// A browser's job is the user's, without a worktree it names.
	code, out := jt.do("full", http.MethodPost, "/api/mux/jobs", map[string]any{"title": "Review docs", "createdBy": "w1:x",
		"worktree": map[string]string{"source": "w1", "branch": "b"}})
	if code != http.StatusCreated {
		t.Fatalf("browser create = %d %v", code, out)
	}
	if b := out["job"].(map[string]any); b["createdBy"] != "pwa" || b["worktree"] != nil || b["state"] != "todo" {
		t.Errorf("browser job %v", b)
	}
	for name, tc := range map[string]struct {
		as   string
		body any
		code int
		err  string
	}{
		"no title":      {"full", map[string]any{"prompt": "x"}, http.StatusBadRequest, "job_invalid"},
		"blank title":   {"full", map[string]any{"title": " ​ "}, http.StatusBadRequest, "job_invalid"},
		"long title":    {"full", map[string]any{"title": strings.Repeat("é", maxJobTitle+1)}, http.StatusBadRequest, "job_invalid"},
		"long note":     {"full", map[string]any{"title": "t", "note": strings.Repeat("x", maxJobNote+1)}, http.StatusBadRequest, "job_invalid"},
		"bad state":     {"full", map[string]any{"title": "t", "state": "doing"}, http.StatusBadRequest, "job_invalid"},
		"view-only":     {"view", map[string]any{"title": "t"}, http.StatusForbidden, "view_only"},
		"body too long": {"full", `{"title":"` + strings.Repeat("x", jobBody) + `"}`, http.StatusRequestEntityTooLarge, "too_large"},
	} {
		if code, out := jt.do(tc.as, http.MethodPost, "/api/mux/jobs", tc.body); code != tc.code || out["code"] != tc.err {
			t.Errorf("%s: %d %v", name, code, out)
		}
	}

	// A pane whose agent lookup finds none.
	jt.f.mu.Lock()
	jt.f.found = false
	jt.f.mu.Unlock()
	if code, out := jt.do("socket", http.MethodPost, "/api/mux/jobs", map[string]any{"title": "t", "pane": "w1:pa"}); code != http.StatusConflict || out["code"] != "job_no_agent" {
		t.Errorf("no agent: %d %v", code, out)
	}
	jt.f.mu.Lock()
	jt.f.found = true
	jt.f.mu.Unlock()

	// A view-only client sees titles, states, panes: never the prompt, the
	// note, a directory or the history.
	code, out = jt.do("view", http.MethodGet, "/api/mux/jobs", nil)
	raw, _ := json.Marshal(out)
	if code != http.StatusOK || len(out["jobs"].([]any)) != 2 {
		t.Fatalf("view list = %d %v", code, out)
	}
	for _, leak := range []string{"Tidy the parser", "events", "createdBy", "agent", "w1:orch", `"pid"`} {
		if strings.Contains(string(raw), leak) {
			t.Errorf("view-only sees %q: %s", leak, raw)
		}
	}
	if code, out := jt.do("full", http.MethodGet, "/api/mux/jobs", nil); code != http.StatusOK || !strings.Contains(out["jobs"].([]any)[1].(map[string]any)["prompt"].(string), "Tidy") {
		t.Errorf("full list = %d %v", code, out)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/mux/jobs", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(jt.mux, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}

	// The history is the CLI's alone.
	id := j["id"].(string)
	if code, out := jt.do("full", http.MethodPost, "/api/mux/jobs/"+id+"/event", map[string]any{"kind": "sent", "text": "x"}); code != http.StatusForbidden || out["code"] != "socket_only" {
		t.Errorf("browser event = %d %v", code, out)
	}
	if code, out := jt.do("socket", http.MethodPost, "/api/mux/jobs/"+id+"/event", map[string]any{"kind": "delegated"}); code != http.StatusBadRequest {
		t.Errorf("unknown event = %d %v", code, out)
	}
	if code, out := jt.do("socket", http.MethodPost, "/api/mux/jobs/"+id+"/event", map[string]any{"kind": "sent", "text": "go on\nplease"}); code != http.StatusOK {
		t.Errorf("event = %d %v", code, out)
	}
	j = jt.list()[1]
	ev := j["events"].([]any)
	if last := ev[len(ev)-1].(map[string]any); last["kind"] != "sent" || last["text"] != "go on please" {
		t.Errorf("events %v", ev)
	}
	if code, _ := jt.do("socket", http.MethodPost, "/api/mux/jobs/nope/event", map[string]any{"kind": "sent"}); code != http.StatusNotFound {
		t.Errorf("unknown job = %d", code)
	}
}

func TestJobUnreadFromTranscript(t *testing.T) {
	jt := newJobsTest(t)
	j := jt.create(map[string]any{"title": "Parser", "pane": "w1:pa"})
	id := j["id"].(string)
	// What the agent wrote before it was given the job counts as read.
	if live(jt.list()[0])["unread"] != nil {
		t.Fatal("unread at creation")
	}
	// A turn ends: unread, while nobody waited for it.
	jt.appendTranscript(`{"type":"assistant","uuid":"00000000-0000-4000-8000-0000000000a3","timestamp":"2026-11-23T09:05:00.000Z","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"Fixed."}]}}`)
	l := live(jt.list()[0])
	if l["unread"] != true || l["lastTs"] != "2026-11-23T09:05:00.000Z" {
		t.Fatalf("after a turn: %v", l)
	}
	// Still unread on a server that starts again: the ledger is on disk,
	// the turn in the transcript.
	store, err := newJobStore(jt.dir)
	if err != nil {
		t.Fatal(err)
	}
	jt.agent.jobs = store
	if live(jt.list()[0])["unread"] != true {
		t.Fatal("unread lost on restart")
	}
	// While it works or waits on a dialog, nothing is unread.
	for _, st := range []string{"working", "blocked"} {
		setPaneStatus(jt.f, st)
		jt.snapshot()
		if l := live(jt.list()[0]); l["unread"] != nil || l["status"] != st {
			t.Errorf("%s: %v", st, l)
		}
	}
	// Its answer written, only background work left: reported as such,
	// never as a turn to read while its subagents write.
	setPaneStatus(jt.f, "working")
	jt.f.mu.Lock()
	jt.f.screen = fixtureScreen(t, "2.1.330-wait-background-agent")
	jt.f.mu.Unlock()
	jt.snapshot()
	if l := live(jt.list()[0]); l["unread"] != nil || l["status"] != "background" || l["background"] != "1 background agent" {
		t.Errorf("background: %v", l)
	}
	setPaneStatus(jt.f, "idle")
	jt.snapshot()

	// The orchestrator reads it. A read of less, sent later, changes nothing.
	cursor := encodeCursor(agentCursor{Session: testSessionID})
	read := func(ts string) {
		t.Helper()
		if code, out := jt.do("socket", http.MethodPost, "/api/mux/jobs/"+id+"/event", map[string]any{"kind": "read", "lastTs": ts, "cursor": cursor}); code != http.StatusOK {
			t.Fatalf("read = %d %v", code, out)
		}
	}
	read("2026-11-23T09:05:00.000Z")
	if live(jt.list()[0])["unread"] != nil {
		t.Fatal("unread after the read")
	}
	read("2026-11-23T09:00:02.000Z")
	if got := jt.list()[0]["readTs"]; got != "2026-11-23T09:05:00.000Z" {
		t.Errorf("an older read moved the mark back: %v", got)
	}
	// A message of the user's is not a turn to read.
	jt.appendTranscript(`{"type":"user","uuid":"00000000-0000-4000-8000-0000000000a9","timestamp":"2026-11-23T09:07:00.000Z","message":{"role":"user","content":"next please"}}`)
	if l := live(jt.list()[0]); l["unread"] != nil || l["lastTs"] != "2026-11-23T09:05:00.000Z" {
		t.Errorf("the user's message: %v", l)
	}
	if code, _ := jt.do("socket", http.MethodPost, "/api/mux/jobs/"+id+"/event", map[string]any{"kind": "read", "cursor": "forged.x"}); code != http.StatusBadRequest {
		t.Errorf("unsigned cursor = %d", code)
	}
	// The read mark is a time, never text of any length.
	for _, ts := range []string{"later", "2026-11-23T09:05:00.000Z" + strings.Repeat("<", 64)} {
		if code, _ := jt.do("socket", http.MethodPost, "/api/mux/jobs/"+id+"/event", map[string]any{"kind": "read", "lastTs": ts, "cursor": cursor}); code != http.StatusBadRequest {
			t.Errorf("lastTs %.30q = %d", ts, code)
		}
	}
	// A new conversation in the same agent (/clear) is a turn not read.
	jt.f.mu.Lock()
	jt.f.session.ID = "22222222-2222-4333-8444-555555555555"
	jt.f.mu.Unlock()
	writeTranscript(t, jt.f.session.ClaudeDir, "22222222-2222-4333-8444-555555555555", jsonsTranscriptAt("2026-11-23T09:10:00.000Z"))
	if l := live(jt.list()[0]); l["unread"] != true || l["status"] != "idle" {
		t.Errorf("new conversation: %v", l)
	}
	// A read from the PWA (the transcript route) is not the orchestrator's.
	serve(jt.mux, httptest.NewRequest(http.MethodGet, "/api/mux/panes/w1:pa/agent/transcript", nil))
	if live(jt.list()[0])["unread"] != true {
		t.Error("a PWA read marked the turn read")
	}
}

func jsonsTranscriptAt(ts string) string {
	return `{"type":"assistant","uuid":"00000000-0000-4000-8000-0000000000b1","timestamp":"` + ts + `","message":{"id":"m9","role":"assistant","content":[{"type":"text","text":"New."}]}}` + "\n"
}

// Another agent at the job's pane address is not the job's: the job reads
// gone.
func TestJobAgentIdentity(t *testing.T) {
	jt := newJobsTest(t)
	jt.create(map[string]any{"title": "Parser", "pane": "w1:pa"})
	status := func() string { return live(jt.list()[0])["status"].(string) }
	if s := status(); s != "idle" {
		t.Fatalf("status %s", s)
	}
	for name, change := range map[string]func(s *AgentSession){
		"tmux restarted, same %N": func(s *AgentSession) { s.PID, s.ProcStart = 99, "1" },
		"pid reused":              func(s *AgentSession) { s.ProcStart = "8" },
		"another agent":           func(s *AgentSession) { s.Agent = "codex" },
	} {
		jt.f.mu.Lock()
		orig := jt.f.session
		change(&jt.f.session)
		jt.f.mu.Unlock()
		if s := status(); s != "gone" {
			t.Errorf("%s: %s", name, s)
		}
		jt.f.mu.Lock()
		jt.f.session = orig
		jt.f.mu.Unlock()
	}
	// The pane gone from the snapshot.
	jt.f.mu.Lock()
	jt.f.snap.Groups[0].Tabs[0].Panes[0].Agent = nil
	jt.f.mu.Unlock()
	jt.snapshot()
	if s := status(); s != "gone" {
		t.Errorf("no agent in the pane: %s", s)
	}
}

func TestJobAgentMatches(t *testing.T) {
	p := snapPane{group: Group{ID: "w1", Name: "web"}, tab: Tab{ID: "w1:t1", Name: "ui"}, pane: Pane{ID: "w1:pa"}}
	s := AgentSession{Agent: "claude", ID: "s1", PID: 5, ProcStart: "9"}
	a := jobAgentOf(p, s)
	if a.Ref != "web/ui" || !a.matches(p, s) {
		t.Fatalf("%+v", a)
	}
	other := p
	other.pane.ID = "w1:pb"
	if a.matches(other, s) {
		t.Error("another key")
	}
	cleared := s
	cleared.ID = "s2"
	if !a.matches(p, cleared) {
		t.Error("a new conversation of the same process is the same agent")
	}
	// No process known: the session decides.
	noPID := AgentSession{Agent: "claude", ID: "s1"}
	b := jobAgentOf(p, noPID)
	if !b.matches(p, noPID) || b.matches(p, AgentSession{Agent: "claude", ID: "s2"}) || b.matches(p, s) {
		t.Error("without a pid")
	}
	if (jobAgent{Key: "w1:pa", Kind: "claude"}).matches(p, AgentSession{Agent: "claude"}) {
		t.Error("nothing recorded matches nothing")
	}
}

func TestJobPatchAndDelete(t *testing.T) {
	jt := newJobsTest(t)
	j := jt.create(map[string]any{"title": "Parser", "pane": "w1:pa"})
	id := j["id"].(string)
	// A grant in force, as the PWA would have made it.
	_, err := jt.agent.jobs.update(id, "", func(j *job) error {
		j.Grants = append(j.Grants, grant{ID: "g1", Agent: *j.Agent, Kind: "bash", Prefix: "pnpm test"})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	updated := jt.list()[0]["updated"].(string)
	if code, out := jt.do("full", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"note": "x"}); code != http.StatusBadRequest {
		t.Errorf("browser without updated = %d %v", code, out)
	}
	code, out := jt.do("full", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"note": "look at the tests", "state": "review", "updated": updated})
	if code != http.StatusOK || out["job"].(map[string]any)["state"] != "review" {
		t.Fatalf("patch = %d %v", code, out)
	}
	// The other device's stale edit gets the job as it is now.
	code, out = jt.do("full", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"title": "x", "updated": updated})
	if code != http.StatusConflict || out["code"] != "job_conflict" || out["job"].(map[string]any)["note"] != "look at the tests" {
		t.Errorf("stale = %d %v", code, out)
	}
	if g := jt.list()[0]["grants"].([]any)[0].(map[string]any); g["revoked"] != nil {
		t.Errorf("revoked by a note: %v", g)
	}
	// The same pane again (same agent): the grant stays; another agent
	// there: it ends.
	jt.do("socket", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"pane": "w1:pa"})
	if g := jt.list()[0]["grants"].([]any)[0].(map[string]any); g["revoked"] != nil {
		t.Errorf("revoked by the same agent: %v", g)
	}
	jt.f.mu.Lock()
	jt.f.session.PID = 77
	jt.f.mu.Unlock()
	if code, out := jt.do("socket", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"pane": "w1:pa"}); code != http.StatusOK {
		t.Fatalf("set pane = %d %v", code, out)
	}
	got := jt.list()[0]
	if g := got["grants"].([]any)[0].(map[string]any); g["revoked"] == nil || got["agent"].(map[string]any)["pid"] != float64(77) {
		t.Errorf("another agent kept the grant: %v", got)
	}
	if code, _ := jt.do("view", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"note": "x"}); code != http.StatusForbidden {
		t.Errorf("view patch = %d", code)
	}
	if code, _ := jt.do("full", http.MethodPatch, "/api/mux/jobs/nope", map[string]any{"note": "x", "updated": "u"}); code != http.StatusNotFound {
		t.Errorf("unknown = %d", code)
	}
	if code, _ := jt.do("full", http.MethodDelete, "/api/mux/jobs/"+id, nil); code != http.StatusBadRequest {
		t.Errorf("delete without updated = %d", code)
	}
	updated = jt.list()[0]["updated"].(string)
	if code, out := jt.do("full", http.MethodDelete, "/api/mux/jobs/"+id+"?updated="+updated, nil); code != http.StatusOK {
		t.Errorf("delete = %d %v", code, out)
	}
	if len(jt.list()) != 0 {
		t.Error("still listed")
	}
	if code, _ := jt.do("full", http.MethodPut, "/api/mux/jobs/"+id, nil); code != http.StatusMethodNotAllowed {
		t.Errorf("PUT = %d", code)
	}
}

// Over the local socket a DELETE removes a finished job only, checked under
// the store's lock; a browser, and another termote's bridge (not the local
// socket), remove any job they read.
func TestJobDeleteFinishedOnlyOnSocket(t *testing.T) {
	jt := newJobsTest(t)
	id := jt.create(map[string]any{"title": "Parser", "state": "active"})["id"].(string)
	if code, out := jt.do("socket", http.MethodDelete, "/api/mux/jobs/"+id, nil); code != http.StatusConflict || out["code"] != "job_unfinished" {
		t.Errorf("socket delete active = %d %v", code, out)
	}
	if len(jt.list()) != 1 {
		t.Fatal("an unfinished job was removed")
	}
	// A stale updated is a conflict first, whatever the state.
	if code, out := jt.do("socket", http.MethodDelete, "/api/mux/jobs/"+id+"?updated="+url.QueryEscape("2026-11-23T09:00:00+07:00"), nil); code != http.StatusConflict || out["code"] != "job_conflict" {
		t.Errorf("socket delete stale = %d %v", code, out)
	}
	if code, out := jt.do("socket", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"state": "abandoned"}); code != http.StatusOK {
		t.Fatalf("abandon = %d %v", code, out)
	}
	if code, out := jt.do("socket", http.MethodDelete, "/api/mux/jobs/"+id, nil); code != http.StatusOK {
		t.Errorf("socket delete abandoned without updated = %d %v", code, out)
	}
	for _, as := range []string{"full", "bridge"} {
		id := jt.create(map[string]any{"title": as, "state": "active"})["id"].(string)
		updated := jt.list()[0]["updated"].(string)
		if code, out := jt.do(as, http.MethodDelete, "/api/mux/jobs/"+id+"?updated="+updated, nil); code != http.StatusOK {
			t.Errorf("%s delete active = %d %v", as, code, out)
		}
	}
	if n := len(jt.list()); n != 0 {
		t.Errorf("%d jobs left", n)
	}
}

// Finished jobs are listed with all=1 only; every grant ends with the job.
func TestJobFinishedEndsGrants(t *testing.T) {
	jt := newJobsTest(t)
	id := jt.create(map[string]any{"title": "Parser", "pane": "w1:pa"})["id"].(string)
	jt.agent.jobs.update(id, "", func(j *job) error {
		j.Grants = append(j.Grants, grant{ID: "g1", Kind: "bash"})
		return nil
	})
	jt.do("socket", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"state": "done"})
	if _, out := jt.do("socket", http.MethodGet, "/api/mux/jobs", nil); len(out["jobs"].([]any)) != 0 {
		t.Errorf("a finished job listed by default: %v", out)
	}
	if g := jt.list()[0]["grants"].([]any)[0].(map[string]any); g["revoked"] == nil {
		t.Errorf("grant kept past the job: %v", g)
	}
	if _, out := jt.do("socket", http.MethodGet, "/api/mux/jobs?all=1&workspace=w2", nil); len(out["jobs"].([]any)) != 0 {
		t.Errorf("another workspace's: %v", out)
	}
}

func TestJobsUnavailable(t *testing.T) {
	jt := newJobsTest(t)
	jt.agent.jobs = nil
	for _, m := range []string{http.MethodGet, http.MethodPost} {
		if code, out := jt.do("full", m, "/api/mux/jobs", map[string]any{"title": "t"}); code != http.StatusServiceUnavailable || out["code"] != "jobs_unavailable" {
			t.Errorf("%s = %d %v", m, code, out)
		}
	}
}

func TestJobDirTooWide(t *testing.T) {
	// Absolute on every OS: a volume's root (C:\ on Windows).
	root := filepath.VolumeName(os.TempDir()) + string(filepath.Separator)
	home := filepath.Join(root, "home", "u")
	for dir, want := range map[string]bool{
		home: true, filepath.Dir(home): true, root: true, "rel/dir": true,
		filepath.Join(home, "src", "wt"): false, filepath.Join(root, "srv", "x"): false,
	} {
		if got := jobDirTooWide(dir, home); got != want {
			t.Errorf("%s: %v", dir, got)
		}
	}
	// No home dir to compare with: refused, not let through.
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	t.Setenv("home", "")
	if !jobDirTooWide(filepath.Join(root, "srv", "x"), "") {
		t.Error("a dir passed without a home dir")
	}
}

// The worktree of a job is the server's own list's, never a path the
// request names, and never the home dir or above.
func TestJobWorktreeFromServerList(t *testing.T) {
	jt := newJobsTest(t)
	wtDir := t.TempDir()
	jt.agent.wm = &fakeWorktreeMux{list: WorktreeList{Worktrees: []Worktree{{Path: "/repo", Branch: "main"},
		{Path: wtDir, Branch: "feat/x", Linked: true, GroupID: "w9"}}}}
	j := jt.create(map[string]any{"title": "X", "worktree": map[string]string{"source": "w1", "branch": "feat/x", "base": "main", "dir": "/etc"}})
	if w := j["worktree"].(map[string]any); w["dir"] != wtDir || w["groupId"] != "w9" || w["base"] != "main" {
		t.Errorf("worktree %v", w)
	}
	for name, wt := range map[string]map[string]string{
		"main checkout":  {"source": "w1", "branch": "main"},
		"unknown branch": {"source": "w1", "branch": "nope"},
		"bad branch":     {"source": "w1", "branch": "-x"},
		"bad source":     {"source": "", "branch": "feat/x"},
	} {
		if code, out := jt.do("socket", http.MethodPost, "/api/mux/jobs", map[string]any{"title": "X", "worktree": wt}); code != http.StatusBadRequest {
			t.Errorf("%s = %d %v", name, code, out)
		}
	}
	jt.agent.home = wtDir
	if code, _ := jt.do("socket", http.MethodPost, "/api/mux/jobs", map[string]any{"title": "X", "worktree": map[string]string{"source": "w1", "branch": "feat/x"}}); code != http.StatusBadRequest {
		t.Errorf("home dir = %d", code)
	}
}

type fakeWorktreeMux struct {
	list WorktreeList
}

func (m *fakeWorktreeMux) ValidGroupID(id string) bool { return id != "" }
func (m *fakeWorktreeMux) ListWorktrees(_ context.Context, _ string) (WorktreeList, error) {
	return m.list, nil
}
func (m *fakeWorktreeMux) CreateWorktree(context.Context, string, string, string, string) (string, error) {
	return "", nil
}
func (m *fakeWorktreeMux) OpenWorktree(context.Context, string, string) (string, bool, error) {
	return "", false, nil
}
func (m *fakeWorktreeMux) RemoveWorktree(context.Context, string, bool) error { return nil }

type stubDirer struct{}

func (stubDirer) PaneDir(context.Context, string) (string, string, error) {
	return "/src/web", "w1:pa", nil
}

// A job made without a worktree shows its pane's folder and branch now:
// the folder to full clients only, the branch as the overview read it (none
// to a view-only client when it is a home dir's).
func TestJobLiveFolderAndBranch(t *testing.T) {
	jt := newJobsTest(t)
	jt.f.mu.Lock()
	jt.f.snap.Groups[0].Tabs[0].Panes[0].Process = &ProcessInfo{Name: "claude", Cwd: "/src/web"}
	jt.f.caps = &Caps{CopyMode: true, Files: true}
	jt.f.mu.Unlock()
	jt.snapshot()
	jt.create(map[string]any{"title": "Parser", "pane": "w1:pa"})
	// Not read yet: the folder, no branch.
	if l := live(jt.list()[0]); l["dir"] != "/src/web" || l["branch"] != nil {
		t.Errorf("before the read: %v", l)
	}
	jt.agent.files = &filesAPI{dirs: stubDirer{}}
	// No git here: a read queued in the background finds nothing.
	jt.agent.changes.mu.Lock()
	jt.agent.changes.runJob = func(*filesAPI, overviewJob) (overviewChange, bool) { return overviewChange{}, false }
	jt.agent.changes.mu.Unlock()
	seed := func(hidden bool) {
		jt.agent.changes.mu.Lock()
		jt.agent.changes.byKey["w1:pa"] = overviewChange{status: true, branch: "feat/x", at: time.Now(), asked: time.Now(), viewHidden: hidden}
		jt.agent.changes.mu.Unlock()
	}
	seed(false)
	if l := live(jt.list()[0]); l["dir"] != "/src/web" || l["branch"] != "feat/x" {
		t.Errorf("full: %v", l)
	}
	_, out := jt.do("view", http.MethodGet, "/api/mux/jobs", nil)
	b := out["jobs"].([]any)[0].(map[string]any)
	if b["branch"] != "feat/x" || b["live"].(map[string]any)["dir"] != nil {
		t.Errorf("view-only: %v", b)
	}
	seed(true)
	_, out = jt.do("view", http.MethodGet, "/api/mux/jobs", nil)
	b = out["jobs"].([]any)[0].(map[string]any)
	if b["branch"] != nil || b["live"].(map[string]any)["branch"] != nil {
		t.Errorf("view-only, home dir: %v", b)
	}
}

// A job keeps the worktree made for it, but shows it as its branch and
// folder only while its agent's pane is in it: given a pane in another
// folder (its worktree removed, say), the job shows that pane's.
func TestJobOutsideWorktree(t *testing.T) {
	jt := newJobsTest(t)
	wtDir := t.TempDir()
	jt.agent.wm = &fakeWorktreeMux{list: WorktreeList{Worktrees: []Worktree{{Path: "/repo", Branch: "main"},
		{Path: wtDir, Branch: "job-ledger-case", Linked: true, GroupID: "w9"}}}}
	at := func(cwd string) {
		jt.f.mu.Lock()
		jt.f.snap.Groups[0].Tabs[0].Panes[0].Process = &ProcessInfo{Name: "claude", Cwd: cwd}
		jt.f.caps = &Caps{CopyMode: true, Files: true}
		jt.f.mu.Unlock()
		jt.snapshot()
	}
	at(filepath.Join(wtDir, "src"))
	jt.create(map[string]any{"title": "Case worktree", "pane": "w1:pa",
		"worktree": map[string]string{"source": "w1", "branch": "job-ledger-case", "base": "main"}})
	jt.agent.files = &filesAPI{dirs: stubDirer{}}
	jt.agent.changes.mu.Lock()
	jt.agent.changes.runJob = func(*filesAPI, overviewJob) (overviewChange, bool) { return overviewChange{}, false }
	jt.agent.changes.byKey["w1:pa"] = overviewChange{status: true, branch: "main", at: time.Now(), asked: time.Now()}
	jt.agent.changes.mu.Unlock()
	viewBranch := func() any {
		_, out := jt.do("view", http.MethodGet, "/api/mux/jobs", nil)
		b := out["jobs"].([]any)[0].(map[string]any)
		if b["live"].(map[string]any)["outsideWorktree"] != nil {
			t.Errorf("view-only gets the flag: %v", b)
		}
		return b["branch"]
	}
	// In the worktree (a folder inside it): the worktree's branch.
	if l := live(jt.list()[0]); l["outsideWorktree"] != nil {
		t.Errorf("inside: %v", l)
	}
	if b := viewBranch(); b != "job-ledger-case" {
		t.Errorf("view-only inside: %v", b)
	}
	// The worktree removed, the pane in the main checkout: the pane's.
	os.RemoveAll(wtDir)
	at("/src/web")
	if l := live(jt.list()[0]); l["outsideWorktree"] != true || l["dir"] != "/src/web" || l["branch"] != "main" {
		t.Errorf("elsewhere: %v", l)
	}
	if b := viewBranch(); b != "main" {
		t.Errorf("view-only elsewhere: %v", b)
	}
	// The record of the worktree stays.
	if w := jt.list()[0]["worktree"].(map[string]any); w["branch"] != "job-ledger-case" {
		t.Errorf("worktree %v", w)
	}
}

func TestDirInTree(t *testing.T) {
	tree := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(tree, link); err != nil {
		t.Skip(err) // Windows without the privilege
	}
	for _, c := range []struct {
		tree, dir string
		want      bool
	}{
		{tree, tree, true},
		{tree, tree + "/", true},
		{tree, filepath.Join(tree, "a", "b"), true},
		{link, tree, true},
		{tree, filepath.Dir(tree), false},
		{tree, tree + "-other", false},
		{"/gone/wt", "/src/web", false},
	} {
		if got := dirInTree(c.tree, c.dir); got != c.want {
			t.Errorf("dirInTree(%q, %q) = %v", c.tree, c.dir, got)
		}
	}
}

// An idle Claude Code whose turn ended while a shell it started still runs
// says so in live.background; its status stays idle, its turn readable.
func TestJobLiveIdleBackground(t *testing.T) {
	jt := newJobsTest(t)
	jt.create(map[string]any{"title": "Tests", "pane": "w1:pa"})
	jt.f.setScreen(shellScreen())
	if l := live(jt.list()[0]); l["status"] != "idle" || l["background"] != "1 shell" {
		t.Errorf("shell running: %v", l)
	}
	jt.f.setScreen(boxScreen(""))
	jt.agent.input.captures = newTTLCache[string](0)
	if l := live(jt.list()[0]); l["status"] != "idle" || l["background"] != nil {
		t.Errorf("shell ended: %v", l)
	}
	// Only the mode row under the input box names it (Claude Code 2.1.330).
	jt.f.setScreen(footerShellScreen())
	jt.agent.input.captures = newTTLCache[string](0)
	if l := live(jt.list()[0]); l["status"] != "idle" || l["background"] != "1 shell" {
		t.Errorf("mode row: %v", l)
	}
}

// A grant a change ends without a revoke of its own (another agent, the
// job finished or removed) is logged as revoked, with the reason; one that
// had expired is not.
func TestJobImplicitRevocationsAudited(t *testing.T) {
	jt := newJobsTest(t)
	logs := captureLog(t)
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	earlier := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	addGrant := func(id, gid, expires string) {
		t.Helper()
		if _, err := jt.agent.jobs.update(id, "", func(j *job) error {
			j.Grants = append(j.Grants, grant{ID: gid, Kind: "bash", Expires: expires})
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	id := jt.create(map[string]any{"title": "Parser", "pane": "w1:pa"})["id"].(string)
	addGrant(id, "g0", earlier)
	addGrant(id, "g1", later)
	// The job's agent is another one than the pane's now.
	jt.agent.jobs.update(id, "", func(j *job) error { j.Agent.PID = 7; return nil })
	if code, out := jt.do("socket", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"pane": "w1:pa"}); code != http.StatusOK {
		t.Fatalf("give = %d %v", code, out)
	}
	addGrant(id, "g2", later)
	if code, out := jt.do("socket", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"state": "done"}); code != http.StatusOK {
		t.Fatalf("done = %d %v", code, out)
	}
	other := jt.create(map[string]any{"title": "Lexer", "state": "active"})["id"].(string)
	addGrant(other, "g3", later)
	var updated string
	for _, j := range jt.list() {
		if j["id"] == other {
			updated = j["updated"].(string)
		}
	}
	if code, out := jt.do("full", http.MethodDelete, "/api/mux/jobs/"+other+"?updated="+url.QueryEscape(updated), nil); code != http.StatusOK {
		t.Fatalf("remove = %d %v", code, out)
	}
	text := logs.String()
	for _, want := range []string{
		`audit: grant_revoked grant="g1" job="` + id + `" reason="agent_changed" by=`,
		`audit: grant_revoked grant="g2" job="` + id + `" reason="job_finished" by=`,
		`audit: grant_revoked grant="g3" job="` + other + `" reason="job_removed" by=`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("no %q in\n%s", want, text)
		}
	}
	if strings.Contains(text, `grant="g0"`) {
		t.Errorf("an expired grant logged as revoked:\n%s", text)
	}
}
