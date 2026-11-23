package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ciTest is a job ledger, a repository on disk and a poller reading it
// through the fake gh.
type ciTest struct {
	*jobsTest
	gh      *fakeGh
	p       *ciPoller
	repo    string
	failed  atomic.Int32
	merged  atomic.Int32
	created time.Time
}

func newCITest(t *testing.T, branch string, remotes ...string) *ciTest {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	jt := newJobsTest(t)
	f, g := newFakeGh(t)
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", branch)
	repo, _ = filepath.EvalSymlinks(repo)
	for i := 0; i+1 < len(remotes); i += 2 {
		gitIn(t, repo, "remote", "add", remotes[i], remotes[i+1])
	}
	git := newGitRunner()
	rr := newRootResolver(git)
	ct := &ciTest{jobsTest: jt, gh: f, repo: repo}
	ct.p = &ciPoller{a: jt.agent, gh: g, git: git, resolve: rr.resolve, now: time.Now,
		state: map[string]*ciJobState{}, defaults: map[string]ciDefault{}, targets: map[string]ciTargetAt{}}
	ct.p.onFailed = func(string) { ct.failed.Add(1) }
	ct.p.onMerged = func(string) { ct.merged.Add(1) }
	jt.agent.ci = ct.p
	f.reply("auth status --hostname=github.com", fakeGhReply{Out: "Logged in"})
	f.reply("repo view github.com/o/r --json=defaultBranchRef", fakeGhReply{Out: `{"defaultBranchRef":{"name":"main"}}`})
	return ct
}

// worktreeJob adds a job whose worktree is the test's repository.
func (ct *ciTest) worktreeJob(branch string) string {
	ct.t.Helper()
	j, err := ct.agent.jobs.create(job{Title: "a", State: "active", Worktree: &jobTree{Branch: branch, Dir: ct.repo}})
	if err != nil {
		ct.t.Fatal(err)
	}
	ct.created = j.Created
	return j.ID
}

func ghPRJSON(n int, state, head, owner, created string, checks ...string) string {
	return fmt.Sprintf(`{"number":%d,"state":%q,"url":"https://github.com/o/r/pull/%d","headRefOid":%q,"headRepository":{"name":"r"},`+
		`"headRepositoryOwner":{"login":%q},"createdAt":%q,"statusCheckRollup":[%s]}`, n, state, n, strings.Repeat(head, 40), owner, created, strings.Join(checks, ","))
}

func failCheck(name string) string {
	return fmt.Sprintf(`{"__typename":"CheckRun","name":%q,"status":"COMPLETED","conclusion":"FAILURE"}`, name)
}

const passCheck = `{"__typename":"CheckRun","name":"ok","status":"COMPLETED","conclusion":"SUCCESS"}`

func (ct *ciTest) list(branch string, prs ...string) {
	ct.gh.reply(prListArgs("github.com/o/r", branch), fakeGhReply{Out: "[" + strings.Join(prs, ",") + "]"})
}

func (ct *ciTest) read(id string) job {
	ct.t.Helper()
	j, err := ct.p.read(context.Background(), id)
	if err != nil {
		ct.t.Fatalf("read: %v", err)
	}
	return j
}

func (ct *ciTest) now() string { return time.Now().Add(time.Second).UTC().Format(time.RFC3339) }

func countEvents(j job, kind string) int {
	n := 0
	for _, e := range j.Events {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

func TestCIPollerTwoFailingPRsPushOnce(t *testing.T) {
	ct := newCITest(t, "feat", "origin", "https://github.com/o/r.git")
	id := ct.worktreeJob("feat")
	ct.list("feat")
	if j := ct.read(id); j.CI == nil || j.CI.Notified != ciNoneKey || j.CI.Repo != "github.com/o/r" {
		t.Fatalf("first read %+v", j.CI)
	}
	ct.list("feat", ghPRJSON(12, "OPEN", "a", "o", ct.now(), failCheck("lint")), ghPRJSON(15, "OPEN", "b", "o", ct.now(), failCheck("e2e")))
	var j job
	for range 10 {
		j = ct.read(id)
	}
	if ct.failed.Load() != 1 || countEvents(j, "ci") != 1 {
		t.Errorf("pushes %d, ci events %d", ct.failed.Load(), countEvents(j, "ci"))
	}
	if ev := j.Events[len(j.Events)-1].Text; ev != "CI failed on #15: e2e; #12: lint" {
		t.Errorf("event %q", ev)
	}
	// One of them fixed: nothing new. A new commit failing again: a push.
	ct.list("feat", ghPRJSON(12, "OPEN", "a", "o", ct.now(), failCheck("lint")), ghPRJSON(15, "OPEN", "b", "o", ct.now(), passCheck))
	ct.read(id)
	ct.list("feat", ghPRJSON(12, "OPEN", "a", "o", ct.now(), failCheck("lint")), ghPRJSON(15, "OPEN", "c", "o", ct.now(), failCheck("e2e")))
	ct.read(id)
	if ct.failed.Load() != 2 {
		t.Errorf("new failure pushes = %d", ct.failed.Load())
	}
	// A restart (a new store and poller on the same file) pushes nothing again.
	store, err := newJobStore(ct.dir)
	if err != nil {
		t.Fatal(err)
	}
	ct.agent.jobs = store
	ct.read(id)
	if ct.failed.Load() != 2 {
		t.Errorf("after restart = %d", ct.failed.Load())
	}
}

func TestCIPollerFirstReadAndMerged(t *testing.T) {
	ct := newCITest(t, "feat", "origin", "git@github.com:o/r.git")
	id := ct.worktreeJob("feat")
	// Failing already at the first read: the mark only.
	ct.list("feat", ghPRJSON(12, "OPEN", "a", "o", ct.now(), failCheck("lint")))
	ct.read(id)
	if ct.failed.Load() != 0 {
		t.Error("first read pushed")
	}
	ct.list("feat", ghPRJSON(12, "MERGED", "a", "o", ct.now()))
	j := ct.read(id)
	ct.read(id)
	if ct.merged.Load() != 1 || !ciSummary(j.CI).AllMerged || countEvents(j, "ci") != 1 {
		t.Errorf("merged pushes %d, %+v", ct.merged.Load(), j.CI)
	}
	if next := ciNextRead(j, time.Now()); next != ciSlowEvery {
		t.Errorf("merged next read %s", next)
	}
}

func TestCIPollerFiltersPRs(t *testing.T) {
	ct := newCITest(t, "feat", "origin", "https://github.com/o/r.git")
	id := ct.worktreeJob("feat")
	old := ct.created.Add(-time.Hour).UTC().Format(time.RFC3339)
	ct.list("feat",
		ghPRJSON(1, "CLOSED", "a", "o", old),          // closed before the job
		ghPRJSON(2, "OPEN", "b", "o", old, passCheck), // open, older: kept
		ghPRJSON(3, "OPEN", "c", "other", ct.now()),   // another fork's branch of that name
		ghPRJSON(4, "MERGED", "d", "o", ct.now(), passCheck))
	j := ct.read(id)
	var got []int
	for _, pr := range j.CI.PRs {
		got = append(got, pr.Number)
	}
	if fmt.Sprint(got) != "[4 2]" {
		t.Errorf("kept %v", got)
	}
	if j.CI.PRs[1].Checks != ciPass {
		t.Errorf("checks %+v", j.CI.PRs[1])
	}
}

func TestCIPollerDefaultBranchAndPins(t *testing.T) {
	ct := newCITest(t, "main", "origin", "https://github.com/o/r.git")
	id := ct.worktreeJob("main")
	ct.p.read(context.Background(), id)
	if n := ct.gh.callsOf("pr list"); n != 0 {
		t.Errorf("asked the default branch's pull requests %d times", n)
	}
	// A pull request attached by number is read on its own.
	ct.agent.jobs.update(id, "", func(j *job) error { return applyPRPins(ct.agent.jobs, j, []int{7}, nil) })
	ct.gh.reply("pr view 7 --repo=github.com/o/r --json="+ghPRFields, fakeGhReply{Out: ghPRJSON(7, "OPEN", "e", "x", ct.now(), failCheck("lint"))})
	j := ct.read(id)
	if len(j.CI.PRs) != 1 || !j.CI.PRs[0].Pinned || !j.CI.PRs[0].Foreign {
		t.Errorf("pinned %+v", j.CI.PRs)
	}
	// Detached while gh runs: it stays detached.
	ct.gh.reply("pr view 7 --repo=github.com/o/r --json="+ghPRFields, fakeGhReply{Out: ghPRJSON(7, "OPEN", "f", "x", ct.now()), SleepMS: 600})
	done := make(chan job)
	go func() { j, _ := ct.p.read(context.Background(), id); done <- j }()
	time.Sleep(200 * time.Millisecond)
	if _, err := ct.agent.jobs.update(id, "", func(j *job) error { return applyPRPins(ct.agent.jobs, j, nil, []int{7}) }); err != nil {
		t.Fatal(err)
	}
	<-done
	if j, _ := ct.agent.jobs.job(id); len(j.CI.PRs) != 0 {
		t.Errorf("detached pull request came back: %+v", j.CI.PRs)
	}
}

func TestCIPollerFork(t *testing.T) {
	ct := newCITest(t, "feat", "origin", "https://github.com/me/r.git", "upstream", "https://github.com/o/r.git")
	id := ct.worktreeJob("feat")
	ct.list("feat", ghPRJSON(5, "OPEN", "a", "me", ct.now(), passCheck), ghPRJSON(6, "OPEN", "b", "someone", ct.now()))
	j := ct.read(id)
	if j.CI.Repo != "github.com/o/r" || j.CI.Push != "github.com/me/r" || len(j.CI.PRs) != 1 || j.CI.PRs[0].Number != 5 || j.CI.PRs[0].Foreign {
		t.Errorf("fork %+v", j.CI)
	}
}

func TestCIPollerHostsAndErrors(t *testing.T) {
	ct := newCITest(t, "feat", "origin", "https://ghe.example.com/o/r.git")
	id := ct.worktreeJob("feat")
	ct.gh.reply("auth status --hostname=ghe.example.com", fakeGhReply{Err: "not logged in", Code: 1})
	if _, err := ct.p.read(context.Background(), id); !errors.Is(err, errNoRepo) {
		t.Errorf("host without a login = %v", err)
	}
	if j, _ := ct.agent.jobs.job(id); j.CI.Error != "ci_no_repo" {
		t.Errorf("error kept %+v", j.CI)
	}
	// github.com without a login: ci_gh_auth, through refresh, at once.
	ct2 := newCITest(t, "feat", "origin", "https://github.com/o/r.git")
	id2 := ct2.worktreeJob("feat")
	ct2.gh.reply("auth status --hostname=github.com", fakeGhReply{Err: "gh auth login", Code: 1})
	ct2.p.gh.auth = map[string]ghAuth{}
	if _, err := ct2.p.refresh(context.Background(), id2); err != nil {
		t.Fatal(err)
	}
	if j, _ := ct2.agent.jobs.job(id2); j.CI == nil || j.CI.Error != "ci_gh_auth" {
		t.Errorf("auth error %+v", j.CI)
	}
	if ct2.p.checkedAt(id2).IsZero() {
		t.Error("no check time after a failed read")
	}
	// A second refresh right away gets that read.
	n := len(ct2.gh.calls())
	ct2.p.refresh(context.Background(), id2)
	if len(ct2.gh.calls()) != n {
		t.Error("refresh within the gap read again")
	}
}

func TestCIPollerAgentFolderKept(t *testing.T) {
	ct := newCITest(t, "feat", "origin", "https://github.com/o/r.git")
	ct.f.mu.Lock()
	ct.f.snap.Groups[0].Tabs[0].Panes[0].Process = &ProcessInfo{Cwd: ct.repo}
	ct.f.mu.Unlock()
	ct.snapshot()
	id := ct.create(map[string]any{"title": "Parser", "pane": "w1:pa"})["id"].(string)
	ct.list("feat", ghPRJSON(9, "OPEN", "a", "o", ct.now(), passCheck))
	j := ct.read(id)
	if j.CI == nil || j.CI.Branch != "feat" || len(j.CI.PRs) != 1 {
		t.Fatalf("from the agent's folder %+v", j.CI)
	}
	// The agent leaves and the folder changes branch: the kept one is read.
	gitIn(t, ct.repo, "checkout", "-q", "-b", "other")
	ct.f.mu.Lock()
	ct.f.session.PID = 99
	ct.f.mu.Unlock()
	if j = ct.read(id); j.CI.Branch != "feat" || len(j.CI.PRs) != 1 {
		t.Errorf("after the agent left %+v", j.CI)
	}
}

func TestCIPollerTickAndReadOnly(t *testing.T) {
	ct := newCITest(t, "feat", "origin", "https://github.com/o/r.git")
	id := ct.worktreeJob("feat")
	ct.list("feat")
	ct.p.tick(context.Background())
	if ct.p.checkedAt(id).IsZero() {
		t.Fatal("tick read nothing")
	}
	if code, out := ct.do("socket", "GET", "/api/mux/jobs", nil); code != 200 || out["ciAvailable"] != true ||
		out["jobs"].([]any)[0].(map[string]any)["ciChecked"] == nil {
		t.Errorf("list = %d %v", code, out)
	}
	n := ct.gh.callsOf("pr list")
	ct.p.tick(context.Background())
	if ct.gh.callsOf("pr list") != n {
		t.Error("read again before it was due")
	}
	// A ledger a newer Termote wrote stops the poller.
	os.WriteFile(filepath.Join(ct.dir, jobsFile), []byte(`{"v":99,"jobs":[]}`), 0o600)
	ct.p.tick(context.Background())
	if ct.p.available() {
		t.Error("still following a newer ledger")
	}
	if _, err := ct.p.refresh(context.Background(), id); !errors.Is(err, errCIUnavailable) {
		t.Errorf("refresh when off = %v", err)
	}
}

// A failed read of an attached pull request is a failed read, never the
// pull request gone: the set of failures is not pushed again when it comes
// back. A number gh cannot find is left out.
func TestCIPollerPinReadFails(t *testing.T) {
	ct := newCITest(t, "feat", "origin", "https://github.com/o/r.git")
	id := ct.worktreeJob("feat")
	ct.agent.jobs.update(id, "", func(j *job) error { return applyPRPins(ct.agent.jobs, j, []int{12, 99}, nil) })
	view := func(n int) string { return fmt.Sprintf("pr view %d --repo=github.com/o/r --json=%s", n, ghPRFields) }
	ct.list("feat")
	ct.gh.reply(view(99), fakeGhReply{Err: "GraphQL: Could not resolve to a PullRequest with the number of 99.", Code: 1})
	ct.gh.reply(view(12), fakeGhReply{Out: ghPRJSON(12, "OPEN", "a", "o", ct.now(), passCheck)})
	ct.read(id)
	ct.gh.reply(view(12), fakeGhReply{Out: ghPRJSON(12, "OPEN", "a", "o", ct.now(), failCheck("lint"))})
	j := ct.read(id)
	if ct.failed.Load() != 1 || len(j.CI.PRs) != 1 {
		t.Fatalf("first failure: pushes %d, %+v", ct.failed.Load(), j.CI.PRs)
	}
	ct.gh.reply(view(12), fakeGhReply{Err: "error connecting to api.github.com", Code: 1})
	if _, err := ct.p.read(context.Background(), id); !errors.Is(err, errGhFailed) {
		t.Errorf("failed read = %v", err)
	}
	if j, _ = ct.agent.jobs.job(id); len(j.CI.PRs) != 1 || j.CI.Error != "ci_failed" {
		t.Errorf("after a failed read %+v", j.CI)
	}
	ct.gh.reply(view(12), fakeGhReply{Out: ghPRJSON(12, "OPEN", "a", "o", ct.now(), failCheck("lint"))})
	j = ct.read(id)
	if ct.failed.Load() != 1 || countEvents(j, "ci") != 1 || j.CI.Error != "" {
		t.Errorf("pushed again after a failed read: %d, %d events, %+v", ct.failed.Load(), countEvents(j, "ci"), j.CI)
	}
}

// A read cut short (a refresh whose client left, the server stopping)
// leaves nothing on the job.
func TestCIPollerCancelledRead(t *testing.T) {
	ct := newCITest(t, "feat", "origin", "https://github.com/o/r.git")
	id := ct.worktreeJob("feat")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ct.p.read(ctx, id); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled read = %v", err)
	}
	if j, _ := ct.agent.jobs.job(id); j.CI != nil {
		t.Errorf("a cut read wrote %+v", j.CI)
	}
	if ciErrorCode(context.DeadlineExceeded) != "" {
		t.Error("a deadline is a job's failure")
	}
}

// A job without a worktree whose agent is still on the default branch is
// read again from its folder, so the branch it moves to is followed.
func TestCIPollerDefaultBranchNotKept(t *testing.T) {
	ct := newCITest(t, "main", "origin", "https://github.com/o/r.git")
	ct.f.mu.Lock()
	ct.f.snap.Groups[0].Tabs[0].Panes[0].Process = &ProcessInfo{Cwd: ct.repo}
	ct.f.mu.Unlock()
	ct.snapshot()
	id := ct.create(map[string]any{"title": "Parser", "pane": "w1:pa"})["id"].(string)
	if j := ct.read(id); j.CI == nil || j.CI.Branch != "" {
		t.Fatalf("default branch kept %+v", j.CI)
	}
	gitIn(t, ct.repo, "checkout", "-q", "-b", "fix-x")
	ct.p.targets = map[string]ciTargetAt{}
	ct.list("fix-x", ghPRJSON(4, "OPEN", "a", "o", ct.now(), passCheck))
	if j := ct.read(id); j.CI.Branch != "fix-x" || len(j.CI.PRs) != 1 {
		t.Errorf("new branch not followed %+v", j.CI)
	}
}

// An SSH alias (a host without a dot) is github.com only when github.com is
// the one host gh is signed in to; with another one, or when gh cannot
// list its hosts, the alias may name a GitHub Enterprise: ci_no_repo.
func TestCIPollerSSHAlias(t *testing.T) {
	hosts := func(names ...string) string {
		var parts []string
		for _, h := range names {
			parts = append(parts, fmt.Sprintf(`%q:[{"state":"success","active":true}]`, h))
		}
		return `{"hosts":{` + strings.Join(parts, ",") + `}}`
	}
	for _, c := range []struct {
		name  string
		reply fakeGhReply
		want  string
	}{
		{"github.com alone", fakeGhReply{Out: hosts("github.com")}, ""},
		{"another host too", fakeGhReply{Out: hosts("github.com", "ghe.example.com")}, "ci_no_repo"},
		{"only another host", fakeGhReply{Out: hosts("ghe.example.com")}, "ci_no_repo"},
		{"a failed login only", fakeGhReply{Out: `{"hosts":{"github.com":[{"state":"error"}]}}`}, "ci_no_repo"},
		{"gh cannot list them", fakeGhReply{Err: "unknown flag: --json", Code: 1}, "ci_no_repo"},
	} {
		t.Run(c.name, func(t *testing.T) {
			ct := newCITest(t, "feat", "origin", "git@github-work:o/r.git")
			id := ct.worktreeJob("feat")
			ct.gh.reply("auth status --json=hosts", c.reply)
			ct.list("feat", ghPRJSON(3, "OPEN", "a", "o", ct.now(), passCheck))
			ct.p.read(context.Background(), id)
			j, _ := ct.agent.jobs.job(id)
			if j.CI == nil {
				t.Fatal("nothing written")
			}
			if j.CI.Error != c.want {
				t.Errorf("error %q, want %q", j.CI.Error, c.want)
			}
			if c.want == "" && (j.CI.Repo != "github.com/o/r" || len(j.CI.PRs) != 1) {
				t.Errorf("alias not read as github.com: %+v", j.CI)
			}
			if c.want != "" && ct.gh.callsOf("pr list") != 0 {
				t.Error("asked github.com for an alias that may be another host")
			}
		})
	}
}
