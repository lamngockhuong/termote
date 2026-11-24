package main

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// finishFake is a fake Claude Code backend that can run tasks (IdleShell)
// and closes tabs out of its snapshot.
type finishFake struct {
	*fakeWriter
	busy        map[string]bool // panes whose shell runs a program
	closed      []string
	closeErr    error
	onClose     func()
	capErr      error
	snapErr     error
	invalidated int
}

func (f *finishFake) Snapshot(context.Context) (Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap, f.snapErr
}

func (f *finishFake) invalidate() {
	f.mu.Lock()
	f.invalidated++
	f.mu.Unlock()
}

func (f *finishFake) Capture(ctx context.Context, target string) (string, error) {
	if f.capErr != nil {
		return "", f.capErr
	}
	return f.fakeWriter.Capture(ctx, target)
}

func (f *finishFake) CloseTab(_ context.Context, id, key string) error {
	f.mu.Lock()
	f.closed = append(f.closed, id+"@"+key)
	err, hook := f.closeErr, f.onClose
	if err == nil {
		f.dropLocked(func(g Group, t Tab) bool { return t.ID == id })
	}
	f.mu.Unlock()
	if err == nil && hook != nil {
		hook()
	}
	return err
}

// dropLocked removes the tabs drop names, and the groups left without one.
func (f *finishFake) dropLocked(drop func(Group, Tab) bool) {
	var groups []Group
	for _, g := range f.snap.Groups {
		var tabs []Tab
		for _, t := range g.Tabs {
			if !drop(g, t) {
				tabs = append(tabs, t)
			}
		}
		if len(tabs) > 0 {
			g.Tabs = tabs
			groups = append(groups, g)
		}
	}
	f.snap.Groups = groups
}

func (f *finishFake) IdleShell(_ context.Context, target string) (string, int, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if target == "gone" {
		return "", 0, false, errTaskTargetGone
	}
	return "bash", 1, !f.busy[target], nil
}
func (f *finishFake) NewTaskTab(context.Context, string, string, string) (taskTab, error) {
	return taskTab{}, errUnsupported
}
func (f *finishFake) Interrupt(context.Context, string) error                   { return nil }
func (f *finishFake) TypeLine(context.Context, string, string) error            { return nil }
func (f *finishFake) ReadTaskText(context.Context, string, int) (string, error) { return "", nil }

// finishWM is a worktree backend over finishFake: a remove closes the
// worktree's group out of the snapshot, then removes the checkout with git.
type finishWM struct {
	f         *finishFake
	list      WorktreeList
	listErr   error
	removed   []string
	removeErr error
	onRemove  func()
	checkout  func()
}

func (m *finishWM) ValidGroupID(id string) bool { return id != "" }
func (m *finishWM) ListWorktrees(context.Context, string) (WorktreeList, error) {
	return m.list, m.listErr
}
func (m *finishWM) CreateWorktree(context.Context, string, string, string, string) (string, error) {
	return "", errUnsupported
}
func (m *finishWM) OpenWorktree(context.Context, string, string) (string, bool, error) {
	return "", false, errUnsupported
}
func (m *finishWM) RemoveWorktree(_ context.Context, group string, force bool) error {
	m.removed = append(m.removed, group+" "+map[bool]string{true: "force", false: "no-force"}[force])
	m.f.mu.Lock()
	m.f.dropLocked(func(g Group, _ Tab) bool { return g.ID == group })
	m.f.mu.Unlock()
	if m.onRemove != nil {
		m.onRemove()
	}
	if m.removeErr != nil {
		return m.removeErr
	}
	m.checkout()
	return nil
}

type finishTest struct {
	*jobsTest
	ff   *finishFake
	wm   *finishWM
	repo finishRepo
	id   string
	head string // the worktree's HEAD
	// release ends a CI read a test holds
	release chan struct{}
}

// newFinishTest is a job in review started from pane w1:self: its agent in
// tab w1:t1 of workspace w1, or with worktree, in workspace w9 showing the
// worktree feat of a real repository.
func newFinishTest(t *testing.T, worktree bool) *finishTest {
	t.Helper()
	ft := &finishTest{}
	home := t.TempDir()
	if worktree {
		ft.repo = newFinishRepo(t)
		home = ft.repo.home
		ft.head = gitOut(t, ft.repo.wt, "rev-parse", "HEAD")
	}
	f := newFakeWriter()
	claudeDir := t.TempDir()
	path := writeTranscript(t, claudeDir, testSessionID, jobsTranscript)
	f.session.ClaudeDir = claudeDir
	f.caps = &Caps{CopyMode: true, Worktrees: true}
	main := filepath.Join(home, "repo")
	self := Tab{ID: "w1:t0", Key: "k0", Panes: []Pane{{ID: "w1:self", Process: &ProcessInfo{Name: "claude", Cwd: main}}}}
	agentPane := func(id, cwd string) Pane {
		return Pane{ID: id, Agent: &AgentInfo{Name: "claude", Status: "idle"}, Process: &ProcessInfo{Name: "claude", Cwd: cwd}}
	}
	f.snap = Snapshot{Groups: []Group{{ID: "w1", Name: "repo", Tabs: []Tab{self}}}}
	pane := "w1:pa"
	if worktree {
		pane = "w9:pa"
		f.snap.Groups = append(f.snap.Groups, Group{ID: "w9", Name: "feat",
			Tabs: []Tab{{ID: "w9:t1", Key: "k9", Panes: []Pane{agentPane("w9:pa", ft.repo.wt)}}}})
	} else {
		f.snap.Groups[0].Tabs = append(f.snap.Groups[0].Tabs, Tab{ID: "w1:t1", Key: "k1", Panes: []Pane{agentPane("w1:pa", main)}})
	}
	ff := &finishFake{fakeWriter: f, busy: map[string]bool{}}
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, ff, newStreamTokenStore(), nil, nil)
	agent.sessions = newTTLCache[agentLookup](0)
	agent.reads = newTTLCache[transcriptResponse](0)
	agent.input.captures = newTTLCache[string](0)
	agent.home = home
	agent.worktreeSlot = newWorktreeSlot()
	dir := t.TempDir()
	store, err := newJobStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	agent.jobs = store
	ft.jobsTest = &jobsTest{t: t, f: f, mux: mux, agent: agent, dir: dir, path: path}
	ft.ff = ff
	body := map[string]any{"title": "Parser", "pane": pane, "createdBy": "w1:self"}
	if worktree {
		rr := newTestRoots()
		agent.files = &filesAPI{git: rr.git, roots: rr}
		ft.wm = &finishWM{f: ff, list: WorktreeList{Worktrees: []Worktree{
			{Path: ft.repo.main, Branch: "main", GroupID: "w1"},
			{Path: ft.repo.wt, Branch: "feat", Linked: true, GroupID: "w9"},
		}}, checkout: func() { gitIn(t, ft.repo.main, "worktree", "remove", "--force", ft.repo.wt) }}
		agent.wm = ft.wm
		body["worktree"] = map[string]any{"source": "w1", "branch": "feat", "made": true}
	}
	ft.snapshot()
	ft.id = ft.create(body)["id"].(string)
	ft.set(func(j *job) { j.State = "review" })
	return ft
}

// set changes the job in the ledger.
func (ft *finishTest) set(op func(j *job)) {
	ft.t.Helper()
	if _, err := ft.agent.jobs.update(ft.id, "", func(j *job) error { op(j); return nil }); err != nil {
		ft.t.Fatal(err)
	}
}

func (ft *finishTest) job() job {
	ft.t.Helper()
	j, ok := ft.agent.jobs.job(ft.id)
	if !ok {
		ft.t.Fatal("no job")
	}
	return j
}

// finish posts a finish of the job as read now, by w1:self, with body.
func (ft *finishTest) finish(body map[string]any) (int, map[string]any) {
	ft.t.Helper()
	b := map[string]any{"updated": ft.job().Updated.Format(time.RFC3339Nano), "by": "w1:self"}
	maps.Copy(b, body)
	return ft.do("socket", http.MethodPost, "/api/mux/jobs/"+ft.id+"/finish", b)
}

// refused checks a refusal with code that closed and removed nothing and
// left the job as it was.
func (ft *finishTest) refused(name string, body map[string]any, status int, code string) {
	ft.t.Helper()
	before := ft.job()
	got, out := ft.finish(body)
	if got != status || out["code"] != code {
		ft.t.Errorf("%s = %d %v, want %d %s", name, got, out, status, code)
	}
	if len(ft.ff.closed) > 0 {
		ft.t.Errorf("%s closed %v", name, ft.ff.closed)
	}
	if ft.wm != nil && len(ft.wm.removed) > 0 {
		ft.t.Errorf("%s removed %v", name, ft.wm.removed)
	}
	if after := ft.job(); after.State != before.State || len(after.Events) != len(before.Events) {
		ft.t.Errorf("%s changed the job: %+v", name, after)
	}
}

func (ft *finishTest) push() { gitIn(ft.t, ft.repo.wt, "push", "-q", "-u", "origin", "feat") }

func (ft *finishTest) merged() { ft.set(func(j *job) { j.CI = mergedCI(ft.head) }) }

func lastEvent(j job) jobEvent { return j.Events[len(j.Events)-1] }

func hasEvent(j job, kind, text string) bool {
	return slices.ContainsFunc(j.Events, func(e jobEvent) bool { return e.Kind == kind && e.Text == text })
}

func TestJobFinishCloseTab(t *testing.T) {
	ft := newFinishTest(t, false)
	logs := captureLog(t)
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	ft.set(func(j *job) { j.Grants = append(j.Grants, grant{ID: "g1", Kind: "bash", Expires: later}) })
	code, out := ft.finish(map[string]any{"close": true})
	if code != http.StatusOK || out["closed"] != true || out["worktreeRemoved"] != false || out["jobUpdated"] != true || out["branch"] != "" {
		t.Fatalf("finish = %d %v", code, out)
	}
	if !slices.Equal(ft.ff.closed, []string{"w1:t1@k1"}) {
		t.Errorf("closed %v", ft.ff.closed)
	}
	j := ft.job()
	if j.State != "done" || !hasEvent(j, "state", "done") || lastEvent(j) != (jobEvent{At: lastEvent(j).At, Kind: "finished", Text: "tab closed"}) {
		t.Errorf("job %+v", j)
	}
	if j.Grants[0].Revoked == "" {
		t.Error("grant not revoked")
	}
	if ft.ff.invalidated == 0 {
		t.Error("the snapshot cache was never dropped")
	}
	for _, want := range []string{
		`audit: job_tab_closed job="` + ft.id + `" tab="w1:t1" pane="w1:pa" agent="claude" by="w1:self" peer_pid="0"`,
		`audit: grant_revoked grant="g1" job="` + ft.id + `" reason="job_finished" by="w1:self"`,
	} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("no %q in\n%s", want, logs)
		}
	}
	// The tab gone: a finish again closes nothing, and the job stays done.
	if code, out := ft.finish(map[string]any{"close": true}); code != http.StatusOK || out["closed"] != false || out["alreadyClosed"] != true {
		t.Errorf("again = %d %v", code, out)
	}
	if j := ft.job(); j.State != "done" || lastEvent(j).Text != "tab already closed" || len(ft.ff.closed) != 1 {
		t.Errorf("again: %+v %v", j, ft.ff.closed)
	}
}

func TestJobFinishRequestRefused(t *testing.T) {
	ft := newFinishTest(t, false)
	path := "/api/mux/jobs/" + ft.id + "/finish"
	updated := ft.job().Updated.Format(time.RFC3339Nano)
	ok := map[string]any{"updated": updated, "by": "w1:self", "close": true}
	cases := []struct {
		name, as, method string
		body             any
		status           int
		code             string
	}{
		{"browser", "full", http.MethodPost, ok, http.StatusForbidden, "socket_only"},
		{"view-only", "view", http.MethodPost, ok, http.StatusForbidden, "view_only"},
		{"bridge", "bridge", http.MethodPost, ok, http.StatusForbidden, "socket_only"},
		{"bad json", "socket", http.MethodPost, "{", http.StatusBadRequest, "invalid_request"},
		{"too large", "socket", http.MethodPost, `{"by":"` + strings.Repeat("x", jobFinishBody) + `"}`, http.StatusRequestEntityTooLarge, "too_large"},
		{"nothing to do", "socket", http.MethodPost, map[string]any{"updated": updated, "by": "w1:self"}, http.StatusBadRequest, "invalid_request"},
		{"no updated", "socket", http.MethodPost, map[string]any{"by": "w1:self", "close": true}, http.StatusBadRequest, "invalid_request"},
		{"no self", "socket", http.MethodPost, map[string]any{"updated": updated, "close": true}, http.StatusConflict, "finish_self_unknown"},
		{"stale", "socket", http.MethodPost, map[string]any{"updated": "2020-01-01T00:00:00Z", "by": "w1:self", "close": true}, http.StatusConflict, "job_conflict"},
		{"not mine", "socket", http.MethodPost, map[string]any{"updated": updated, "by": "w1:other", "close": true}, http.StatusForbidden, "finish_not_mine"},
	}
	for _, c := range cases {
		code, out := ft.do(c.as, c.method, path, c.body)
		if code != c.status || out["code"] != c.code {
			t.Errorf("%s = %d %v", c.name, code, out)
		}
	}
	if code, _ := ft.do("socket", http.MethodGet, path, nil); code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", code)
	}
	if code, out := ft.do("socket", http.MethodPost, "/api/mux/jobs/nope/finish", ok); code != http.StatusNotFound || out["code"] != "job_not_found" {
		t.Errorf("bad id = %d %v", code, out)
	}
	if code, out := ft.do("socket", http.MethodPost, "/api/mux/jobs/0123456789abcdef/finish", ok); code != http.StatusNotFound || out["code"] != "job_not_found" {
		t.Errorf("no such job = %d %v", code, out)
	}
	if _, out := ft.do("socket", http.MethodPost, path, map[string]any{"updated": "x", "by": "w1:self", "close": true}); out["job"] == nil {
		t.Errorf("a conflict without the job: %v", out)
	}
	if len(ft.ff.closed) > 0 {
		t.Errorf("closed %v", ft.ff.closed)
	}
	ft.agent.jobs = nil
	if code, out := ft.do("socket", http.MethodPost, path, ok); code != http.StatusServiceUnavailable || out["code"] != "jobs_unavailable" {
		t.Errorf("no ledger = %d %v", code, out)
	}
	if !machineForbiddenPath("/api/mux/jobs/x/finish") || machineForbiddenPath("/api/mux/jobs/x/finished") {
		t.Error("the bridge reaches finish")
	}
}

func TestJobFinishStateAndAgent(t *testing.T) {
	ft := newFinishTest(t, false)
	ft.set(func(j *job) { j.State = "active" })
	ft.refused("active", map[string]any{"close": true}, http.StatusConflict, "finish_job_active")
	ft.set(func(j *job) { j.State = "review" })
	ft.set(func(j *job) { j.Agent.PID = 7 })
	ft.refused("another agent", map[string]any{"close": true}, http.StatusConflict, "finish_agent_changed")
	ft.set(func(j *job) { j.Agent.PID = 42 })
	ft.f.mu.Lock()
	ft.f.snap.Groups[0].Tabs[1].Panes[0].Agent.Status = "working"
	ft.f.mu.Unlock()
	ft.refused("working in the snapshot", map[string]any{"close": true}, http.StatusConflict, "finish_agent_working")
	ft.f.mu.Lock()
	ft.f.snap.Groups[0].Tabs[1].Panes[0].Agent.Status = "idle"
	ft.f.mu.Unlock()
	ft.refused("no worktree", map[string]any{"close": true, "removeWorktree": true}, http.StatusConflict, "finish_no_worktree")
	// The command's own pane in the job's tab.
	ft.f.mu.Lock()
	ft.f.snap.Groups[0].Tabs[1].Panes = append(ft.f.snap.Groups[0].Tabs[1].Panes, Pane{ID: "w1:me"})
	ft.f.mu.Unlock()
	ft.set(func(j *job) { j.CreatedBy = "w1:me" })
	before := ft.job()
	if code, out := ft.do("socket", http.MethodPost, "/api/mux/jobs/"+ft.id+"/finish",
		map[string]any{"updated": before.Updated.Format(time.RFC3339Nano), "by": "w1:me", "close": true}); code != http.StatusConflict || out["code"] != "finish_self" {
		t.Errorf("self = %d %v", code, out)
	}
	// Another pane of the tab runs a program, or one the snapshot does not
	// carry.
	ft.set(func(j *job) { j.CreatedBy = "w1:self" })
	ft.ff.busy["w1:me"] = true
	ft.refused("busy pane", map[string]any{"close": true}, http.StatusConflict, "finish_tab_busy")
	ft.ff.busy["w1:me"] = false
	ft.f.mu.Lock()
	ft.f.snap.Groups[0].Tabs[1].Processes = make([]ProcessInfo, 3)
	ft.f.mu.Unlock()
	ft.refused("unlisted pane", map[string]any{"close": true}, http.StatusConflict, "finish_tab_busy")
	ft.f.mu.Lock()
	ft.f.snap.Groups[0].Tabs[1].Processes = nil
	ft.f.snap.Groups[0].Tabs[1].Panes[1].ID = "gone" // closed meanwhile
	ft.f.mu.Unlock()
	// An open question of the job's.
	if _, err := ft.agent.jobs.addAsk(ask{Text: "Merge?", Job: ft.id, CreatedBy: "w1:self", State: askOpen}); err != nil {
		t.Fatal(err)
	}
	ft.refused("open ask", map[string]any{"close": true}, http.StatusConflict, "finish_open_ask")
	// Dismissed in the PWA, it holds the finish no more
	q, _ := ft.agent.jobs.askByID("Q1")
	if _, err := ft.agent.jobs.dismissAsk(q.ID, q.Updated.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	if code, out := ft.finish(map[string]any{"close": true}); code != http.StatusOK || out["closed"] != true {
		t.Errorf("finish with a dismissed ask = %d %v", code, out)
	}
}

func TestJobFinishSnapshotFails(t *testing.T) {
	ft := newFinishTest(t, false)
	ft.ff.snapErr = errors.New("tmux gone")
	ft.refused("snapshot", map[string]any{"close": true}, http.StatusInternalServerError, "finish_failed")
}

// The checks right before the close, under the pane's lock and past every
// cache.
func TestJobFinishAgentAtRest(t *testing.T) {
	working := labSession
	working.Status = "working"
	blocked := labSession
	blocked.Status = "blocked"
	other := labSession
	other.PID = 9
	cases := []struct {
		name   string
		setup  func(ft *finishTest)
		status int
		code   string
	}{
		{"working now", func(ft *finishTest) { ft.f.sessions = []AgentSession{working} }, http.StatusConflict, "finish_agent_working"},
		{"blocked now", func(ft *finishTest) { ft.f.sessions = []AgentSession{blocked} }, http.StatusConflict, "agent_blocked"},
		{"another agent now", func(ft *finishTest) { ft.f.sessions = []AgentSession{other} }, http.StatusConflict, "finish_agent_changed"},
		{"session unreadable", func(ft *finishTest) { ft.f.nowErr = errors.New("gone") }, http.StatusConflict, "finish_agent_changed"},
		{"dialog", func(ft *finishTest) { ft.f.screen = fixtureScreen(ft.t, "2.1.286-ask-single") }, http.StatusConflict, "agent_blocked"},
		{"background shell", func(ft *finishTest) { ft.f.screen = shellScreen() }, http.StatusConflict, "finish_agent_background"},
		{"capture fails", func(ft *finishTest) { ft.ff.capErr = errors.New("capture") }, http.StatusInternalServerError, "finish_failed"},
		{"unread turn", func(ft *finishTest) {
			ft.appendTranscript(`{"type":"assistant","uuid":"00000000-0000-4000-8000-0000000000a3","timestamp":"2026-11-23T09:05:00.000Z","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"More."}]}}`)
		}, http.StatusConflict, "finish_unread"},
		{"transcript unreadable", func(ft *finishTest) {
			os.Remove(ft.path)
			os.Mkdir(ft.path, 0o700)
		}, http.StatusInternalServerError, "finish_failed"},
		{"codex working line", func(ft *finishTest) {
			codex := labSession
			codex.Agent = "codex"
			ft.f.session = codex
			ft.set(func(j *job) { j.Agent.Kind = "codex" })
			ft.f.screen = codexRows("• Working (3s • esc to interrupt)", "", "› ", "", codexModelRow)
		}, http.StatusConflict, "finish_agent_working"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ft := newFinishTest(t, false)
			c.setup(ft)
			ft.refused(c.name, map[string]any{"close": true}, c.status, c.code)
		})
	}
}

// Nothing written yet (Codex before its first message): nothing to read.
func TestJobFinishTranscriptNotWritten(t *testing.T) {
	ft := newFinishTest(t, false)
	ft.f.session.ClaudeDir = t.TempDir()
	if code, out := ft.finish(map[string]any{"close": true}); code != http.StatusOK || out["closed"] != true {
		t.Errorf("finish = %d %v", code, out)
	}
}

// The agent's pane lock stays taken past the wait: nothing closes.
func TestJobFinishInputBusy(t *testing.T) {
	ft := newFinishTest(t, false)
	orig := jobFinishLockWait
	jobFinishLockWait = 10 * time.Millisecond
	t.Cleanup(func() { jobFinishLockWait = orig })
	unlock := ft.agent.input.lock(labSession.Target)
	defer unlock()
	ft.refused("locked", map[string]any{"close": true}, http.StatusConflict, "input_busy")
}

func TestJobFinishCloseFails(t *testing.T) {
	ft := newFinishTest(t, false)
	ft.ff.closeErr = errTabChanged
	code, out := ft.finish(map[string]any{"close": true})
	if code != http.StatusConflict || out["code"] != "changed" || out["closed"] != nil {
		t.Errorf("finish = %d %v", code, out)
	}
	if ft.job().State != "review" {
		t.Error("the job moved on")
	}
	ft.ff.closeErr = errTabConfirmRequired
	if code, out := ft.finish(map[string]any{"close": true}); code != http.StatusConflict || out["code"] != "tab_confirm_required" {
		t.Errorf("confirm = %d %v", code, out)
	}
}

// The agent exited: the shell it left closes, and a failed job stays failed.
func TestJobFinishShellLeft(t *testing.T) {
	ft := newFinishTest(t, false)
	logs := captureLog(t)
	ft.set(func(j *job) { j.State = "failed" })
	ft.f.mu.Lock()
	ft.f.snap.Groups[0].Tabs[1].Panes[0].Agent = nil
	ft.f.mu.Unlock()
	ft.ff.busy["w1:pa"] = true
	ft.refused("vim", map[string]any{"close": true}, http.StatusConflict, "finish_tab_busy")
	ft.ff.busy["w1:pa"] = false
	if code, out := ft.finish(map[string]any{"close": true}); code != http.StatusOK || out["closed"] != true {
		t.Fatalf("finish = %d %v", code, out)
	}
	if j := ft.job(); j.State != "failed" || lastEvent(j).Kind != "finished" {
		t.Errorf("job %+v", j)
	}
	if !strings.Contains(logs.String(), `agent="shell"`) {
		t.Errorf("audit: %s", logs)
	}
}

// A shell at the agent's address in another workspace or tab is not the
// one it left (tmux reuses %N and $N once restarted): nothing is closed.
func TestJobFinishShellElsewhere(t *testing.T) {
	for name, move := range map[string]func(g *Group){
		"workspace": func(g *Group) { g.ID = "w2" },
		"tab":       func(g *Group) { g.Tabs[1].Name = "other" },
	} {
		t.Run(name, func(t *testing.T) {
			ft := newFinishTest(t, false)
			ft.f.mu.Lock()
			ft.f.snap.Groups[0].Tabs[1].Panes[0].Agent = nil
			move(&ft.f.snap.Groups[0])
			ft.f.mu.Unlock()
			if code, out := ft.finish(map[string]any{"close": true}); code != http.StatusOK || out["alreadyClosed"] != true || len(ft.ff.closed) > 0 {
				t.Errorf("finish = %d %v %v", code, out, ft.ff.closed)
			}
		})
	}
}

// The job gone from the ledger while its tab closed: the finish is done,
// the ledger not updated.
func TestJobFinishLedgerFails(t *testing.T) {
	ft := newFinishTest(t, false)
	ft.ff.onClose = func() {
		ft.set(func(j *job) { j.State = "done" })
		if _, err := ft.agent.jobs.remove(ft.id, "", true); err != nil {
			t.Error(err)
		}
	}
	code, out := ft.finish(map[string]any{"close": true})
	if code != http.StatusOK || out["jobUpdated"] != false || out["closed"] != true || out["job"] == nil {
		t.Errorf("finish = %d %v", code, out)
	}
}

func TestJobFinishWorktreeMerged(t *testing.T) {
	ft := newFinishTest(t, true)
	logs := captureLog(t)
	ft.merged()
	code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusOK || out["closed"] != true || out["worktreeRemoved"] != true || out["branch"] != "deleted" || out["branchReason"] != "" {
		t.Fatalf("finish = %d %v", code, out)
	}
	if !slices.Equal(ft.wm.removed, []string{"w9 no-force"}) || len(ft.ff.closed) > 0 {
		t.Errorf("removed %v, closed %v", ft.wm.removed, ft.ff.closed)
	}
	if _, err := os.Stat(ft.repo.wt); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("worktree still there: %v", err)
	}
	if out, err := exec.Command("git", "-C", ft.repo.main, "show-ref", "--verify", "--quiet", "refs/heads/feat").CombinedOutput(); err == nil {
		t.Errorf("branch still there: %s", out)
	}
	j := ft.job()
	if j.State != "done" || lastEvent(j).Text != "tab closed; worktree removed; branch deleted" {
		t.Errorf("job %+v", j)
	}
	for _, want := range []string{
		`audit: job_tab_closed job="` + ft.id + `" tab="w9:t1" pane="w9:pa"`,
		`audit: job_worktree_removed job="` + ft.id + `" group="w9" branch="feat" by="w1:self"`,
		`audit: job_branch_deleted job="` + ft.id + `" branch="feat" sha="` + ft.head[:12] + `" by="w1:self"`,
	} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("no %q in\n%s", want, logs)
		}
	}
}

// Pushed, with no merged pull request known: the worktree goes, the branch
// stays, with why.
func TestJobFinishWorktreeBranchKept(t *testing.T) {
	ft := newFinishTest(t, true)
	ft.push()
	code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusOK || out["worktreeRemoved"] != true || out["branch"] != "kept" || out["branchReason"] != "ci_unavailable" {
		t.Fatalf("finish = %d %v", code, out)
	}
	if gitOut(t, ft.repo.main, "rev-parse", "feat") != ft.head {
		t.Error("branch moved")
	}
	if j := ft.job(); lastEvent(j).Text != "tab closed; worktree removed; branch kept: ci_unavailable" {
		t.Errorf("event %+v", lastEvent(j))
	}
}

func TestJobFinishWorktreeRefused(t *testing.T) {
	both := map[string]any{"close": true, "removeWorktree": true}
	cases := []struct {
		name   string
		setup  func(ft *finishTest)
		body   map[string]any
		status int
		code   string
	}{
		{"not pushed", func(ft *finishTest) {}, both, http.StatusConflict, "worktree_not_pushed"},
		{"dirty", func(ft *finishTest) {
			ft.push()
			os.WriteFile(filepath.Join(ft.repo.wt, "new.txt"), []byte("x"), 0o600)
		}, both, http.StatusConflict, "dirty"},
		{"env file", func(ft *finishTest) {
			ft.push()
			os.WriteFile(filepath.Join(ft.repo.wt, ".env.local"), []byte("K=v"), 0o600)
		}, both, http.StatusConflict, "finish_worktree_env"},
		{"not made", func(ft *finishTest) { ft.set(func(j *job) { j.Worktree.Made = false }) }, both, http.StatusConflict, "finish_worktree_not_made"},
		{"second tab", func(ft *finishTest) {
			ft.f.snap.Groups[1].Tabs = append(ft.f.snap.Groups[1].Tabs, Tab{ID: "w9:t2", Key: "k92", Panes: []Pane{{ID: "w9:sh"}}})
		}, both, http.StatusConflict, "finish_worktree_shared"},
		{"second workspace", func(ft *finishTest) {
			ft.f.snap.Groups = append(ft.f.snap.Groups, Group{ID: "w5", Tabs: []Tab{{ID: "w5:t1", Key: "k5",
				Processes: []ProcessInfo{{Name: "zsh", Cwd: filepath.Join(ft.repo.wt, "src")}}}}})
		}, both, http.StatusConflict, "finish_worktree_shared"},
		{"listed elsewhere", func(ft *finishTest) {
			ft.f.snap.Groups = append(ft.f.snap.Groups, Group{ID: "w5", Tabs: []Tab{{ID: "w5:t1", Key: "k5", Panes: []Pane{{ID: "w5:p"}}}}})
			ft.wm.list.Worktrees[1].groups = "w9\x00w5"
		}, both, http.StatusConflict, "finish_worktree_shared"},
		{"self in the worktree", func(ft *finishTest) { ft.f.snap.Groups[0].Tabs[0].Panes[0].Process.Cwd = ft.repo.wt }, both, http.StatusConflict, "finish_self"},
		{"no close", func(ft *finishTest) {}, map[string]any{"removeWorktree": true}, http.StatusBadRequest, "finish_needs_close"},
		{"close only", func(ft *finishTest) {}, map[string]any{"close": true}, http.StatusBadRequest, "finish_needs_remove"},
		{"no worktree backend", func(ft *finishTest) { ft.agent.wm = nil }, both, http.StatusNotImplemented, "unsupported"},
		{"first pane in another worktree", func(ft *finishTest) {
			// tmux: the group's worktree is its first pane's folder, which a
			// remove would take for the job's.
			other := Pane{ID: "w9:sh", Process: &ProcessInfo{Name: "zsh", Cwd: ft.repo.main}}
			ft.f.snap.Groups[1].Tabs[0].Panes = append([]Pane{other}, ft.f.snap.Groups[1].Tabs[0].Panes...)
		}, both, http.StatusConflict, "finish_worktree_shared"},
		{"Herdr list without the worktree", func(ft *finishTest) {
			ft.wm.list.Worktrees = ft.wm.list.Worktrees[:1]
			ft.agent.m = finishHerdr{ft.ff, ft.wm}
		}, both, http.StatusConflict, "changed"},
		{"Herdr shows it elsewhere", func(ft *finishTest) {
			ft.wm.list.Worktrees[1].GroupID = "w1"
			ft.agent.m = finishHerdr{ft.ff, ft.wm}
		}, both, http.StatusConflict, "finish_self"},
		{"list fails", func(ft *finishTest) {
			ft.wm.listErr = errors.New("herdr")
			ft.agent.m = finishHerdr{ft.ff, ft.wm}
		}, both, http.StatusServiceUnavailable, "busy"},
		{"branch changed", func(ft *finishTest) { gitIn(ft.t, ft.repo.wt, "checkout", "-q", "-b", "other") }, both, http.StatusConflict, "changed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ft := newFinishTest(t, true)
			ft.f.mu.Lock()
			c.setup(ft)
			ft.f.mu.Unlock()
			ft.refused(c.name, c.body, c.status, c.code)
			if _, err := os.Stat(ft.repo.wt); err != nil {
				t.Errorf("worktree gone: %v", err)
			}
		})
	}
}

// The worktree slot stays taken (another worktree change) past the wait.
func TestJobFinishWorktreeSlotBusy(t *testing.T) {
	ft := newFinishTest(t, true)
	ft.merged()
	orig := worktreeLockWait
	worktreeLockWait = 10 * time.Millisecond
	t.Cleanup(func() { worktreeLockWait = orig })
	release, ok := ft.agent.worktreeSlot.take(context.Background())
	if !ok {
		t.Fatal("slot")
	}
	defer release()
	ft.refused("slot", map[string]any{"close": true, "removeWorktree": true}, http.StatusServiceUnavailable, "busy")
}

// The remove fails after the workspace closed: the error says the tab is
// closed, and a finish again removes the checkout with git alone.
func TestJobFinishPartialThenAgain(t *testing.T) {
	ft := newFinishTest(t, true)
	logs := captureLog(t)
	ft.merged()
	ft.wm.removeErr = errWorktreeInUse
	code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusConflict || out["code"] != "in_use" || out["closed"] != true {
		t.Fatalf("finish = %d %v", code, out)
	}
	j := ft.job()
	if j.State != "review" || !hasEvent(j, "finish_partial", "tab closed; worktree not removed") {
		t.Errorf("job %+v", j)
	}
	if !strings.Contains(logs.String(), `audit: job_tab_closed job="`+ft.id+`" tab="w9:t1"`) {
		t.Errorf("no tab audit: %s", logs)
	}
	ft.wm.removeErr = nil
	code, out = ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusOK || out["alreadyClosed"] != true || out["worktreeRemoved"] != true || out["branch"] != "deleted" {
		t.Fatalf("again = %d %v", code, out)
	}
	if len(ft.wm.removed) != 1 {
		t.Errorf("removed %v", ft.wm.removed)
	}
	if _, err := os.Stat(ft.repo.wt); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("worktree still there: %v", err)
	}
	if j := ft.job(); j.State != "done" || lastEvent(j).Text != "tab already closed; worktree removed; branch deleted" {
		t.Errorf("job %+v", j)
	}
}

// A remove that fails with the workspace still open closed nothing; one
// whose snapshot cannot be read after says nothing of the tab either.
func TestJobFinishRemoveFails(t *testing.T) {
	ft := newFinishTest(t, true)
	ft.merged()
	ft.wm.removeErr = errWorktreeDirty
	ft.wm.onRemove = func() {
		ft.f.mu.Lock()
		ft.ff.snapErr = errors.New("gone")
		ft.f.mu.Unlock()
	}
	code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusConflict || out["code"] != "dirty" || out["closed"] != nil {
		t.Errorf("finish = %d %v", code, out)
	}
	if hasEvent(ft.job(), "finish_partial", "tab closed; worktree not removed") {
		t.Error("a partial event without a closed tab")
	}
}

// A partial whose job went meanwhile: the event is logged as not written.
func TestJobFinishPartialLedgerGone(t *testing.T) {
	ft := newFinishTest(t, true)
	logs := captureLog(t)
	ft.merged()
	ft.wm.removeErr = errWorktreeInUse
	ft.wm.onRemove = func() {
		ft.set(func(j *job) { j.State = "done" })
		ft.agent.jobs.remove(ft.id, "", true)
	}
	if code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true}); code != http.StatusConflict || out["closed"] != true {
		t.Errorf("finish = %d %v", code, out)
	}
	if !strings.Contains(logs.String(), "job finish: "+ft.id) {
		t.Errorf("not logged: %s", logs)
	}
}

// The job's pull requests are read before a remove that needs a merged
// one at HEAD: what the read says decides the branch, a slow read none.
func TestJobFinishCIRead(t *testing.T) {
	cases := []struct {
		name   string
		read   func(ft *finishTest) (job, error)
		branch string
		reason string
	}{
		{"merged", func(ft *finishTest) (job, error) {
			ft.merged()
			return ft.job(), nil
		}, "deleted", ""},
		{"none merged", func(ft *finishTest) (job, error) { return ft.job(), nil }, "kept", "no_merged_pr"},
		{"read failed", func(ft *finishTest) (job, error) {
			ft.set(func(j *job) { j.CI = &jobCI{Error: "ci_gh_auth"} })
			return ft.job(), nil
		}, "kept", "ci_failed"},
		{"busy", func(*finishTest) (job, error) { return job{}, errCIBusy }, "kept", "ci_busy"},
		{"unavailable", func(*finishTest) (job, error) { return job{}, errCIUnavailable }, "kept", "ci_unavailable"},
		{"error", func(*finishTest) (job, error) { return job{}, errJobNotFound }, "kept", "ci_failed"},
		{"slow", func(ft *finishTest) (job, error) {
			<-ft.release
			return job{}, errCIBusy
		}, "kept", "ci_timeout"},
	}
	orig, origWait := jobFinishRefresh, jobFinishCIWait
	t.Cleanup(func() { jobFinishRefresh, jobFinishCIWait = orig, origWait })
	jobFinishCIWait = 50 * time.Millisecond
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ft := newFinishTest(t, true)
			ft.push()
			ft.agent.ci = &ciPoller{}
			ft.release = make(chan struct{})
			defer close(ft.release)
			var reads atomic.Int32
			jobFinishRefresh = func(_ *ciPoller, _ context.Context, id string) (job, error) {
				reads.Add(1)
				return c.read(ft)
			}
			code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
			if code != http.StatusOK || out["branch"] != c.branch || out["branchReason"] != c.reason || reads.Load() != 1 {
				t.Errorf("finish = %d %v (%d reads)", code, out, reads.Load())
			}
		})
	}
}

// No read for a job finished already, nor one with a merged pull request
// at HEAD known.
func TestJobFinishCINotRead(t *testing.T) {
	orig := jobFinishRefresh
	t.Cleanup(func() { jobFinishRefresh = orig })
	jobFinishRefresh = func(*ciPoller, context.Context, string) (job, error) {
		t.Error("read")
		return job{}, nil
	}
	ft := newFinishTest(t, true)
	ft.push()
	ft.agent.ci = &ciPoller{}
	ft.set(func(j *job) { j.State = "abandoned" })
	code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusOK || out["branchReason"] != "job_finished" {
		t.Errorf("finish = %d %v", code, out)
	}
	if j := ft.job(); j.State != "abandoned" {
		t.Errorf("state %s", j.State)
	}

	ft = newFinishTest(t, true)
	ft.agent.ci = &ciPoller{}
	ft.merged()
	if code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true}); code != http.StatusOK || out["branch"] != "deleted" {
		t.Errorf("merged known = %d %v", code, out)
	}
}

// What changed during the CI read is caught by the checks under the locks.
func TestJobFinishRecheck(t *testing.T) {
	orig := jobFinishRefresh
	t.Cleanup(func() { jobFinishRefresh = orig })
	for name, c := range map[string]struct {
		change func(ft *finishTest)
		code   string
	}{
		"dirty meanwhile": {func(ft *finishTest) {
			os.WriteFile(filepath.Join(ft.repo.wt, "new.txt"), []byte("x"), 0o600)
		}, "dirty"},
		"job moved back meanwhile": {func(ft *finishTest) {
			ft.set(func(j *job) { j.State = "active" })
		}, "job_conflict"},
		"job removed meanwhile": {func(ft *finishTest) {
			ft.set(func(j *job) { j.State = "done" })
			ft.agent.jobs.remove(ft.id, "", true)
		}, "job_not_found"},
		"tab opened meanwhile": {func(ft *finishTest) {
			ft.f.mu.Lock()
			ft.f.snap.Groups[1].Tabs = append(ft.f.snap.Groups[1].Tabs, Tab{ID: "w9:t2", Key: "k92", Panes: []Pane{{ID: "w9:sh"}}})
			ft.f.mu.Unlock()
		}, "finish_worktree_shared"},
	} {
		t.Run(name, func(t *testing.T) {
			ft := newFinishTest(t, true)
			ft.push()
			ft.agent.ci = &ciPoller{}
			jobFinishRefresh = func(*ciPoller, context.Context, string) (job, error) {
				c.change(ft)
				j, _ := ft.agent.jobs.job(ft.id)
				return j, nil
			}
			code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
			if out["code"] != c.code || len(ft.wm.removed) > 0 || len(ft.ff.closed) > 0 {
				t.Errorf("%s = %d %v; removed %v, closed %v", name, code, out, ft.wm.removed, ft.ff.closed)
			}
			if _, err := os.Stat(ft.repo.wt); err != nil {
				t.Errorf("worktree gone: %v", err)
			}
		})
	}
}

// The agent's pane outside the worktree: its tab closes on its own, then
// the worktree no workspace shows goes with git.
func TestJobFinishTabOutsideWorktree(t *testing.T) {
	ft := newFinishTest(t, true)
	ft.merged()
	ft.f.mu.Lock()
	ft.f.snap.Groups = ft.f.snap.Groups[:1]
	ft.f.snap.Groups[0].Tabs = append(ft.f.snap.Groups[0].Tabs, Tab{ID: "w1:t1", Key: "k1", Panes: []Pane{{ID: "w9:pa",
		Agent: &AgentInfo{Name: "claude", Status: "idle"}, Process: &ProcessInfo{Name: "claude", Cwd: ft.repo.main}}}})
	ft.f.mu.Unlock()
	ft.set(func(j *job) { j.Agent.GroupID = "w1" })
	code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusOK || out["closed"] != true || out["worktreeRemoved"] != true || out["branch"] != "deleted" {
		t.Fatalf("finish = %d %v", code, out)
	}
	if !slices.Equal(ft.ff.closed, []string{"w1:t1@k1"}) || len(ft.wm.removed) > 0 {
		t.Errorf("closed %v, removed %v", ft.ff.closed, ft.wm.removed)
	}
	if _, err := os.Stat(ft.repo.wt); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("worktree still there: %v", err)
	}
}

// The tab closed on its own, then the remove failed: the job says so.
func TestJobFinishTabThenRemoveFails(t *testing.T) {
	ft := newFinishTest(t, true)
	ft.merged()
	ft.f.mu.Lock()
	ft.f.snap.Groups = ft.f.snap.Groups[:1]
	ft.f.snap.Groups[0].Tabs = append(ft.f.snap.Groups[0].Tabs, Tab{ID: "w1:t1", Key: "k1", Panes: []Pane{{ID: "w9:pa",
		Agent: &AgentInfo{Name: "claude", Status: "idle"}, Process: &ProcessInfo{Name: "claude", Cwd: ft.repo.main}}}})
	ft.f.mu.Unlock()
	ft.ff.onClose = func() { gitIn(t, ft.repo.main, "worktree", "lock", ft.repo.wt) }
	code, out := ft.finish(map[string]any{"close": true, "removeWorktree": true})
	if code != http.StatusInternalServerError || out["closed"] != true {
		t.Fatalf("finish = %d %v", code, out)
	}
	if !hasEvent(ft.job(), "finish_partial", "tab closed; worktree not removed") {
		t.Errorf("no partial event: %+v", ft.job().Events)
	}
}

// tmux, Zellij and herdr-core: no list to ask (no group of the repository
// open) is no refusal, the panes' folders tell.
func TestJobFinishGitBackendWithoutList(t *testing.T) {
	ft := newFinishTest(t, true)
	ft.merged()
	ft.wm.listErr = errors.New("no group")
	plan, err := ft.agent.finishCheck(context.Background(), ft.job(), jobFinishInput{Close: true, RemoveWorktree: true, By: "w1:self"})
	if err != nil || plan.removeGroup != "w9" {
		t.Errorf("plan %+v %v", plan, err)
	}
}

// finishHerdr is finishFake with worktrees of its own, as Herdr has.
type finishHerdr struct {
	*finishFake
	*finishWM
}

func TestJobFinishTabIdleUnsupported(t *testing.T) {
	a := &agentAPI{m: &fakeMux{}}
	if err := a.finishTabIdle(context.Background(), snapPane{}, false); err != errFinishTabBusy {
		t.Errorf("no task backend: %v", err)
	}
	if err := a.finishAgentAtRest(context.Background(), job{}, finishPlan{}); err != errFinishTabBusy {
		t.Errorf("no agent writer: %v", err)
	}
}

func TestFinishError(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{context.DeadlineExceeded, http.StatusGatewayTimeout, "unknown"},
		{errUnsupported, http.StatusNotImplemented, "unsupported"},
		{errors.New("boom"), http.StatusInternalServerError, "finish_failed"},
		{errInputBusy, http.StatusConflict, "input_busy"},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		finishError(rec, c.err, true)
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), `"code":"`+c.code+`"`) || !strings.Contains(rec.Body.String(), `"closed":true`) {
			t.Errorf("%v = %d %s", c.err, rec.Code, rec.Body)
		}
	}
}

func TestFinishedText(t *testing.T) {
	if s := finishedText(false, false, true, "kept", "branch_moved"); s != "worktree removed; branch kept: branch_moved" {
		t.Error(s)
	}
	if s := finishedText(false, false, false, "", ""); s != "" {
		t.Error(s)
	}
}

// A job made before the made flag, or given another worktree, has none; a
// start going on in the worktree it made keeps it.
func TestJobWorktreeMadeFlag(t *testing.T) {
	ft := newFinishTest(t, true)
	if !ft.job().Worktree.Made {
		t.Fatal("made not recorded")
	}
	patch := func(made bool) {
		t.Helper()
		if code, out := ft.do("socket", http.MethodPatch, "/api/mux/jobs/"+ft.id,
			map[string]any{"worktree": map[string]any{"source": "w1", "branch": "feat", "made": made}}); code != http.StatusOK {
			t.Fatalf("patch = %d %v", code, out)
		}
	}
	patch(false)
	if !ft.job().Worktree.Made {
		t.Error("a start again dropped made")
	}
	ft.wm.list.Worktrees[1].Path = filepath.Join(ft.repo.home, "wt", "other")
	patch(false)
	if ft.job().Worktree.Made {
		t.Error("another worktree kept made")
	}
	// A browser names no worktree.
	if code, out := ft.do("full", http.MethodPatch, "/api/mux/jobs/"+ft.id, map[string]any{"updated": ft.job().Updated.Format(time.RFC3339Nano),
		"worktree": map[string]any{"source": "w1", "branch": "feat", "made": true}}); code != http.StatusOK || ft.job().Worktree.Made {
		t.Errorf("browser = %d %v", code, out)
	}
}
