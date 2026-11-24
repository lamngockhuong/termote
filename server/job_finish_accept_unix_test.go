//go:build !windows

package main

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The finish end to end: termote agents job finish over the real local
// socket to the real server, a Herdr-like backend whose worktree workspace
// w9 shows the worktree feat of a real repository, its agent at rest in
// pane w9:pa, the orchestrator in pane w1:self.
type finishAccept struct {
	tc   *testCLI
	ff   *finishFake
	wm   *finishWM
	repo finishRepo
	port int
	id   string
}

func newFinishAccept(t *testing.T) *finishAccept {
	t.Helper()
	fa := &finishAccept{repo: newFinishRepo(t)}
	f := newFakeWriter()
	claudeDir := t.TempDir()
	writeTranscript(t, claudeDir, testSessionID, jobsTranscript)
	f.session.ClaudeDir = claudeDir
	f.caps = &Caps{CopyMode: true, Worktrees: true}
	f.name = "herdr"
	f.snap = Snapshot{Groups: []Group{
		{ID: "w1", Name: "repo", Tabs: []Tab{{ID: "w1:t0", Key: "w1:t0", Panes: []Pane{{ID: "w1:self",
			Process: &ProcessInfo{Name: "claude", Cwd: fa.repo.main}}}}}},
		{ID: "w9", Name: "feat", Tabs: []Tab{{ID: "w9:t1", Key: "w9:t1", Panes: []Pane{{ID: "w9:pa",
			Agent: &AgentInfo{Name: "claude", Status: "idle"}, Process: &ProcessInfo{Name: "claude", Cwd: fa.repo.wt}}}}}},
	}}
	fa.ff = &finishFake{fakeWriter: f, busy: map[string]bool{}}
	fa.wm = &finishWM{f: fa.ff, list: WorktreeList{Worktrees: []Worktree{
		{Path: fa.repo.main, Branch: "main", GroupID: "w1"},
		{Path: fa.repo.wt, Branch: "feat", Linked: true, GroupID: "w9"},
	}}, checkout: func() { gitIn(t, fa.repo.main, "worktree", "remove", "--force", fa.repo.wt) }}
	tc, dir := socketCLI(t)
	startAgentsServer(t, tc, dir, finishHerdr{fa.ff, fa.wm})
	fa.tc = tc
	tc.env["HERDR_WORKSPACE_ID"], tc.env["HERDR_TAB_ID"], tc.env["HERDR_PANE_ID"] = "w1", "w1:t0", "w1:self"
	port, err := tc.agentsPort()
	if err != nil {
		t.Fatal(err)
	}
	fa.port = port
	if _, err := tc.agentsSnapshot(port); err != nil {
		t.Fatal(err)
	}
	r, err := tc.agentsCall(port, http.MethodPost, "/api/mux/jobs", map[string]any{"title": "Parser", "pane": "w9:pa",
		"createdBy": "w1:self", "worktree": map[string]any{"source": "w1", "branch": "feat", "made": true}}, agentsReadTimeout)
	if err != nil || r.status != http.StatusCreated {
		t.Fatalf("job: %v %d %s", err, r.status, r.body)
	}
	j, err := jobReply(r)
	if err != nil {
		t.Fatal(err)
	}
	fa.id = j.ID
	if err := tc.dispatch("agents", []string{"job", "set", fa.id, "--state", "review"}); err != nil {
		t.Fatalf("review: %v (%s)", err, tc.stderr)
	}
	// The pull request read, as gh would answer it: merged, at HEAD.
	head := gitOut(t, fa.repo.wt, "rev-parse", "HEAD")
	orig := jobFinishRefresh
	t.Cleanup(func() { jobFinishRefresh = orig })
	jobFinishRefresh = func(p *ciPoller, _ context.Context, id string) (job, error) {
		j, err := p.a.jobs.update(id, "", func(j *job) error { j.CI = mergedCI(head); return nil })
		return j, err
	}
	return fa
}

func (fa *finishAccept) run(args ...string) error {
	fa.tc.stdout.Reset()
	fa.tc.stderr.Reset()
	return fa.tc.dispatch("agents", append([]string{"job", "finish", fa.id}, args...))
}

func (fa *finishAccept) job(t *testing.T) jobView {
	t.Helper()
	list, err := fa.tc.jobsGet(fa.port, true)
	if err != nil {
		t.Fatal(err)
	}
	j, ok := findJob(list, fa.id)
	if !ok {
		t.Fatal("no job")
	}
	return j
}

func TestJobFinishAcceptMerged(t *testing.T) {
	fa := newFinishAccept(t)
	logs := captureLog(t)
	if err := fa.run("--close", "--remove-worktree"); err != nil {
		t.Fatalf("%v (%s)", err, fa.tc.stderr)
	}
	if out := fa.tc.stdout.String(); !strings.Contains(out, "Finished job "+fa.id+": tab closed; worktree "+fa.repo.wt+
		" removed (ignored files too); branch feat deleted; the job is done") {
		t.Errorf("out: %s", out)
	}
	if len(fa.wm.removed) != 1 || fa.wm.removed[0] != "w9 no-force" {
		t.Errorf("removed %v", fa.wm.removed)
	}
	if _, err := os.Stat(fa.repo.wt); !os.IsNotExist(err) {
		t.Errorf("worktree: %v", err)
	}
	if err := exec.Command("git", "-C", fa.repo.main, "show-ref", "--verify", "--quiet", "refs/heads/feat").Run(); err == nil {
		t.Error("branch still there")
	}
	j := fa.job(t)
	if j.State != "done" || !hasEvent(j.job, "finished", "tab closed; worktree removed; branch deleted") {
		t.Errorf("job %+v", j.job)
	}
	for _, want := range []string{"audit: job_worktree_removed", "audit: job_branch_deleted", "peer_pid="} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("no %q in %s", want, logs)
		}
	}
}

// Refused by the server: nothing closes, the job stays in review.
func TestJobFinishAcceptRefused(t *testing.T) {
	fa := newFinishAccept(t)
	if err := os.WriteFile(filepath.Join(fa.repo.wt, "new.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fa.run("--close", "--remove-worktree"); err == nil || exitCode(err) != 1 || !strings.Contains(err.Error(), "(dirty)") ||
		!strings.Contains(err.Error(), "never discard them") {
		t.Errorf("dirty: %v", err)
	}
	os.Remove(filepath.Join(fa.repo.wt, "new.txt"))
	fa.ff.mu.Lock()
	fa.ff.snap.Groups[1].Tabs[0].Panes[0].Agent.Status = "working"
	fa.ff.mu.Unlock()
	time.Sleep(agentCacheTTL)
	if err := fa.run("--close", "--remove-worktree"); err == nil || !strings.Contains(err.Error(), "(finish_agent_working)") {
		t.Errorf("working: %v", err)
	}
	if len(fa.wm.removed) > 0 || len(fa.ff.closed) > 0 {
		t.Errorf("closed %v removed %v", fa.ff.closed, fa.wm.removed)
	}
	if j := fa.job(t); j.State != "review" {
		t.Errorf("state %s", j.State)
	}
	// Where termote cannot tell its pane: refused before any request.
	delete(fa.tc.env, "HERDR_PANE_ID")
	if err := fa.run("--close"); err == nil || !strings.Contains(err.Error(), "finish the job in the PWA") {
		t.Errorf("self unknown: %v", err)
	}
	// Over the server's own TCP port, as a browser: never.
	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(fa.port)+"/api/mux/jobs/"+fa.id+"/finish", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Error("finished over TCP")
		}
	}
}
