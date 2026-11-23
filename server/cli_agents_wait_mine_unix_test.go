//go:build !windows

package main

import (
	"maps"
	"strings"
	"testing"
	"time"
)

// mineCLI serves a Herdr snapshot whose pane w1:pO runs the orchestrator
// (this command, by its Herdr variables) and w1:pA, w1:pB two agents; the
// ledger is whatever jobs set. It returns the orchestrator's activity key.
func mineCLI(t *testing.T) (*testCLI, *scripted, func(...jobView), string) {
	t.Helper()
	tc, s := scriptedCLI(t)
	claude := &AgentInfo{Name: "claude", Status: "idle"}
	snap := Snapshot{Backend: "herdr", Groups: []Group{{ID: "w1", Name: "w", Tabs: []Tab{
		{ID: "w1:t1", Name: "orch", Panes: []Pane{{ID: "w1:pO", Agent: claude}}},
		{ID: "w1:t2", Name: "a", Panes: []Pane{{ID: "w1:pA", Agent: claude}}},
		{ID: "w1:t3", Name: "b", Panes: []Pane{{ID: "w1:pB", Agent: claude}}},
	}}}}
	s.set("GET /api/mux/snapshot", jsonAnswer(snap))
	maps.Copy(tc.env, map[string]string{"HERDR_WORKSPACE_ID": "w1", "HERDR_TAB_ID": "w1:t1", "HERDR_PANE_ID": "w1:pO"})
	p, ok := findAgentPane(snap, "w1:pO")
	if !ok {
		t.Fatal("no orchestrator pane")
	}
	jobs := func(list ...jobView) {
		if list == nil {
			list = []jobView{}
		}
		s.set("GET /api/mux/jobs", jsonAnswer(map[string]any{"jobs": list}))
		for _, j := range list {
			s.set("POST /api/mux/jobs/"+j.ID+"/event", answer(200, `{}`))
		}
	}
	every, grace := agentsWaitEvery, agentsWaitGrace
	agentsWaitEvery, agentsWaitGrace = 20*time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { agentsWaitEvery, agentsWaitGrace = every, grace })
	return tc, s, jobs, p.key()
}

// mineJob is a job made by creator whose agent runs in pane (none when
// pane is ""), its agent doing live.
func mineJob(id, title, state, creator, pane string, live jobLive) jobView {
	j := job{ID: id, Title: title, State: state, CreatedBy: creator}
	if pane != "" {
		j.Agent = &jobAgent{Key: pane, PaneID: pane, Kind: "claude", Ref: "w/" + pane}
		live.PaneID, live.Ref = pane, "w/"+pane
	}
	return jobView{job: j, Live: live}
}

func waitMine(t *testing.T, tc *testCLI, args ...string) (int, string) {
	t.Helper()
	tc.stdout.Reset()
	err := tc.dispatch("agents", append([]string{"wait", "--mine"}, args...))
	return exitCode(err), tc.stdout.String()
}

// wait --mine waits on every unfinished job made from this pane, review
// included, and only those; it goes on with --mine.
func TestAgentsWaitMine(t *testing.T) {
	tc, s, jobs, self := mineCLI(t)
	idle := jobLive{Status: "idle"}
	unread := jobLive{Status: "idle", Unread: true}
	jobs(
		mineJob("j1", "Parser", "review", self, "w1:pA", unread),
		mineJob("j2", "UI", "active", self, "w1:pB", jobLive{Status: "working"}),
		mineJob("j3", "Theirs", "active", "cli", "w1:pB", unread),
		mineJob("j4", "Old", "done", self, "w1:pB", unread),
	)
	code, out := waitMine(t, tc, "--timeout", "2s")
	if code != 0 || !strings.Contains(out, "Job j1 (Parser): w/w1:pA (w1:pA) ended a turn; read it: termote agents read w1:pA") ||
		!strings.Contains(out, "next: termote agents wait --mine") || strings.Contains(out, "j3") || strings.Contains(out, "j4") {
		t.Errorf("review job unread: exit %d\n%s", code, out)
	}
	// Still working at the timeout: wait again with the same command.
	jobs(mineJob("j1", "Parser", "review", self, "w1:pA", idle), mineJob("j2", "UI", "active", self, "w1:pB", jobLive{Status: "working"}),
		mineJob("j3", "Theirs", "active", "cli", "w1:pB", unread))
	code, out = waitMine(t, tc, "--timeout", "200ms")
	if code != agentsExitTimeout || !strings.Contains(out, "Job j2 (UI): w/w1:pB (w1:pB) is working") ||
		!strings.Contains(out, "Job j1 (Parser): w/w1:pA (w1:pA) is idle and its last turn was read") ||
		!strings.Contains(out, "wait again: termote agents wait --mine") || strings.Contains(out, "j3") {
		t.Errorf("timeout: exit %d\n%s", code, out)
	}
	// The ledger is read at each poll: a job started while the wait runs
	// is waited for too.
	go func() {
		time.Sleep(150 * time.Millisecond)
		jobs(mineJob("j2", "UI", "active", self, "w1:pB", jobLive{Status: "working"}), mineJob("j5", "New", "active", self, "w1:pA", unread))
	}()
	jobs(mineJob("j2", "UI", "active", self, "w1:pB", jobLive{Status: "working"}))
	code, out = waitMine(t, tc, "--timeout", "5s")
	if code != 0 || !strings.Contains(out, "Job j5 (New): w/w1:pA (w1:pA) ended a turn") || !strings.Contains(out, "next: termote agents wait --mine") {
		t.Errorf("new job: exit %d\n%s", code, out)
	}
	// A dialog and background work are reported as wait --job does.
	jobs(mineJob("j6", "Dialog", "active", self, "w1:pA", jobLive{Status: "blocked", EntryTS: "t1"}),
		mineJob("j7", "Bg", "active", self, "w1:pB", jobLive{Status: "background", Background: "npm test"}))
	code, out = waitMine(t, tc, "--timeout", "2s")
	if code != agentsExitDialog || !strings.Contains(out, "Job j6 (Dialog): w/w1:pA (w1:pA) waits on a dialog") ||
		!strings.Contains(out, "Job j7 (Bg): w/w1:pB (w1:pB) wrote its answer and only waits on background work (npm test)") ||
		!strings.Contains(out, "next: termote agents wait --mine") {
		t.Errorf("dialog: exit %d\n%s", code, out)
	}
	if lastPost(s, "/api/mux/jobs/j6/event") == "" || lastPost(s, "/api/mux/jobs/j7/event") == "" {
		t.Errorf("not marked reported: %v", s.posts)
	}
}

// A lost agent is reported once; afterwards that job, and a job without an
// agent, are skipped: they never hold the others, and 6 comes only when no
// job's agent can end a turn.
func TestAgentsWaitMineSkips(t *testing.T) {
	tc, s, jobs, self := mineCLI(t)
	idle := jobLive{Status: "idle"}
	gone := mineJob("j1", "Merged", "review", self, "w1:pA", jobLive{Status: "gone"})
	todo := mineJob("j2", "Later", "todo", self, "", jobLive{})
	jobs(gone, todo, mineJob("j3", "UI", "active", self, "w1:pB", idle))
	code, out := waitMine(t, tc, "--timeout", "2s")
	if code != agentsExitGone || !strings.Contains(out, "Job j1 (Merged): its agent no longer runs in w/w1:pA (w1:pA)") ||
		!strings.Contains(out, "next: termote agents wait --mine") || strings.Contains(out, "j2") {
		t.Errorf("gone: exit %d\n%s", code, out)
	}
	if p := lastPost(s, "/api/mux/jobs/j1/event"); !strings.Contains(p, `"reported"`) || !strings.Contains(p, `"gone:w1:pA"`) {
		t.Errorf("gone not marked: %q", p)
	}
	// Reported before: skipped; the other job, idle and read, ends the
	// wait after the grace with 6, the skipped ones named.
	gone.Reported = goneSig("w1:pA")
	jobs(gone, todo, mineJob("j3", "UI", "active", self, "w1:pB", idle))
	code, out = waitMine(t, tc, "--timeout", "5s")
	if code != agentsExitIdle || !strings.Contains(out, "Job j3 (UI): w/w1:pB (w1:pB) is idle and its last turn was read") ||
		!strings.Contains(out, "Job j1 (Merged): its agent no longer runs in w/w1:pA (w1:pA), reported before") ||
		!strings.Contains(out, "Job j2 (Later) has no agent; give it one (termote agents start --job j2 ...)") {
		t.Errorf("skipped: exit %d\n%s", code, out)
	}
	// They do not hold a job that ends a turn.
	jobs(gone, todo, mineJob("j3", "UI", "active", self, "w1:pB", jobLive{Status: "idle", Unread: true}))
	if code, out = waitMine(t, tc, "--timeout", "2s"); code != 0 || !strings.Contains(out, "Job j3 (UI): w/w1:pB (w1:pB) ended a turn") {
		t.Errorf("one ends: exit %d\n%s", code, out)
	}
	// Only skipped jobs: nothing can end a turn, said at once.
	jobs(gone, todo)
	start := time.Now()
	if code, out = waitMine(t, tc, "--timeout", "5s"); code != agentsExitIdle || time.Since(start) > 2*time.Second ||
		!strings.Contains(out, "Nothing to wait for: no job made from this pane has an agent that can end a turn.") ||
		!strings.Contains(out, "Job j2 (Later) has no agent") {
		t.Errorf("all skipped: exit %d\n%s", code, out)
	}
	// No job of this pane at all (another creator's, a finished one).
	jobs(mineJob("j8", "Theirs", "active", "cli", "w1:pB", jobLive{Status: "idle", Unread: true}), mineJob("j9", "Done", "done", self, "w1:pB", idle))
	if code, out = waitMine(t, tc); code != agentsExitIdle || !strings.Contains(out, "Nothing to wait for: no unfinished job was made from this pane") {
		t.Errorf("no job: exit %d\n%s", code, out)
	}
}

// --mine needs this pane known, as jobs --mine, and stands alone: a pane in
// two waits would have its turn reported to one of them only.
func TestAgentsWaitMineRefused(t *testing.T) {
	tc, s, jobs, _ := mineCLI(t)
	jobs()
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"wait", "--mine", "--job", "j1"}, "--mine already waits on every job made from this pane"},
		{[]string{"wait", "--job", "j1", "--mine"}, "--mine already waits on every job made from this pane"},
		{[]string{"wait", "--mine", "w1:pA@3"}, "it takes no job ids, panes or --after"},
		{[]string{"wait", "w1:pA", "--mine"}, "it takes no job ids, panes or --after"},
		{[]string{"wait", "--mine", "--after", "3"}, "it takes no job ids, panes or --after"},
		{[]string{"wait", "-mine", "--timeout", "0s"}, "--timeout must be more than 0"},
		{[]string{"wait", "--mine=true", "--mine=false"}, "wait --mine=false waits for nothing"},
	} {
		err := tc.dispatch("agents", c.args)
		if exitCode(err) != 2 || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "wait --") ||
			strings.Contains(err.Error(), "agents list") {
			t.Errorf("%q: %v", c.args, err)
		}
	}
	// This pane not known for sure: refused, naming wait --job instead.
	delete(tc.env, "HERDR_TAB_ID")
	err := tc.dispatch("agents", []string{"wait", "--mine"})
	if err == nil || !strings.Contains(err.Error(), "--mine needs to know this command's pane") ||
		!strings.Contains(err.Error(), "termote agents wait --job <id>...") {
		t.Errorf("unknown pane: %v", err)
	}
	if n := countPosts(s, "/api/mux/"); n != 0 {
		t.Errorf("sent something: %v", s.posts)
	}
}

func TestWaitMineUsageListed(t *testing.T) {
	if !strings.Contains(agentsUsage, strings.TrimPrefix(waitMineUsage, "usage: ")) {
		t.Errorf("agentsUsage lacks %q", waitMineUsage)
	}
}
