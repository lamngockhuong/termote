//go:build !windows

package main

import (
	"encoding/json"
	"maps"
	"net/http"
	"strings"
	"testing"
	"time"
)

// finishCLI is the CLI against a scripted server: the orchestrator in Herdr
// pane w1:pO (its environment says so), job j1 in review that it started,
// with a worktree it made.
func finishCLI(t *testing.T) (*testCLI, *scripted, *jobView) {
	t.Helper()
	tc, s := scriptedCLI(t)
	claude := &AgentInfo{Name: "claude", Status: "idle"}
	s.set("GET /api/mux/snapshot", jsonAnswer(Snapshot{Backend: "herdr", Groups: []Group{{ID: "w1", Name: "w", Tabs: []Tab{
		{ID: "w1:t1", Name: "orch", Panes: []Pane{{ID: "w1:pO", Agent: claude}}},
		{ID: "w1:t2", Name: "work", Panes: []Pane{{ID: "w1:pA", Agent: claude}}},
	}}}}))
	maps.Copy(tc.env, map[string]string{"HERDR_WORKSPACE_ID": "w1", "HERDR_TAB_ID": "w1:t1", "HERDR_PANE_ID": "w1:pO"})
	j := &jobView{job: job{ID: "j1", Title: "Parser", State: "review", CreatedBy: "w1:pO",
		Updated:  time.Date(2026, 11, 24, 7, 0, 0, 0, time.UTC),
		Worktree: &jobTree{Branch: "feat", Dir: "/wt/feat", Made: true}}, Live: jobLive{PaneID: "w1:pA"}}
	s.set("GET /api/mux/jobs", func(w http.ResponseWriter, r *http.Request) {
		jsonAnswer(map[string]any{"jobs": []jobView{*j}})(w, r)
	})
	return tc, s, j
}

func finishRun(tc *testCLI, args ...string) error {
	tc.stdout.Reset()
	tc.stderr.Reset()
	return tc.dispatch("agents", append([]string{"job", "finish"}, args...))
}

func TestAgentsJobFinish(t *testing.T) {
	tc, s, j := finishCLI(t)
	done := *j
	done.State = "done"
	s.set("POST /api/mux/jobs/j1/finish", jsonAnswer(jobFinishReply{Job: done, Closed: true, WorktreeRemoved: true,
		Branch: "deleted", JobUpdated: true}))
	if err := finishRun(tc, "j1", "--close", "--remove-worktree"); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	want := "Finished job j1: tab closed; worktree /wt/feat removed (ignored files too); branch feat deleted; the job is done"
	if out := tc.stdout.String(); !strings.Contains(out, want) {
		t.Errorf("out: %s", out)
	}
	post := lastPost(s, "/api/mux/jobs/j1/finish")
	if !strings.Contains(post, `"by":"w1:pO"`) || !strings.Contains(post, `"close":true`) || !strings.Contains(post, `"removeWorktree":true`) ||
		!strings.Contains(post, `"updated":"2026-11-24T07:00:00Z"`) {
		t.Errorf("post: %s", post)
	}

	// The branch kept, with why; the ledger not updated, with what to run.
	for reason, why := range map[string]string{"no_merged_pr": "no merged pull request at its head is known",
		"ci_timeout": "termote could not read its pull requests in time", "branch_moved": "it moved", "odd": "termote did not delete it"} {
		s.set("POST /api/mux/jobs/j1/finish", jsonAnswer(jobFinishReply{Job: *j, Closed: true, WorktreeRemoved: true,
			Branch: "kept", BranchReason: reason}))
		if err := finishRun(tc, "j1", "--close", "--remove-worktree"); err != nil {
			t.Fatal(err)
		}
		if out := tc.stdout.String(); !strings.Contains(out, "branch feat kept ("+reason+": "+why) || !strings.Contains(out, "the job is review") {
			t.Errorf("%s: %s", reason, out)
		}
		if e := tc.stderr.String(); !strings.Contains(e, "termote agents job set j1 --state done") {
			t.Errorf("%s: no warning: %s", reason, e)
		}
	}

	// A tab closed already, --json: the answer only on stdout.
	s.set("POST /api/mux/jobs/j1/finish", jsonAnswer(jobFinishReply{Job: done, AlreadyClosed: true, JobUpdated: true}))
	if err := finishRun(tc, "j1", "--close"); err != nil || !strings.Contains(tc.stdout.String(), "its tab was closed already; the job is done") {
		t.Errorf("already: %v %s", err, tc.stdout)
	}
	if err := finishRun(tc, "j1", "--close", "--json"); err != nil {
		t.Fatal(err)
	}
	var out jobFinishReply
	if err := json.Unmarshal(tc.stdout.Bytes(), &out); err != nil || !out.AlreadyClosed || out.Job.ID != "j1" {
		t.Errorf("json: %v %s", err, tc.stdout)
	}
	s.set("POST /api/mux/jobs/j1/finish", answer(http.StatusOK, `{"job":`))
	if err := finishRun(tc, "j1", "--close"); err == nil || !strings.Contains(err.Error(), "unexpected answer") {
		t.Errorf("bad answer: %v", err)
	}
}

// What the CLI can tell itself is refused before anything is sent.
func TestAgentsJobFinishRefusedHere(t *testing.T) {
	tc, s, j := finishCLI(t)
	if err := finishRun(tc, "j1", "--close", "--nope"); exitCode(err) != 2 {
		t.Errorf("bad flag: %v", err)
	}
	if err := finishRun(tc, "nope", "--close"); err == nil || !strings.Contains(err.Error(), "no job nope") {
		t.Errorf("no job: %v", err)
	}
	cases := []struct {
		name   string
		change func(j *jobView)
		args   []string
		want   string
	}{
		{"not mine", func(j *jobView) { j.CreatedBy = "pwa" }, []string{"--close"}, "was not made from this pane"},
		{"active", func(j *jobView) { j.State = "active" }, []string{"--close"}, "job j1 is active; after the user's yes: termote agents job set j1 --state review"},
		{"no worktree", func(j *jobView) { j.Worktree = nil }, []string{"--remove-worktree"}, "has no worktree"},
		{"not made", func(j *jobView) { j.Worktree.Made = false }, []string{"--close", "--remove-worktree"}, "was not made by it"},
	}
	for _, c := range cases {
		saved := *j
		w := *j.Worktree
		saved.Worktree = &w
		c.change(j)
		if err := finishRun(tc, append([]string{"j1"}, c.args...)...); err == nil || exitCode(err) != 1 || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.name, err)
		}
		*j = saved
	}
	// Where termote cannot tell its pane (psmux, herdr-core).
	delete(tc.env, "HERDR_PANE_ID")
	if err := finishRun(tc, "j1", "--close"); err == nil || !strings.Contains(err.Error(), "finish the job in the PWA") {
		t.Errorf("self unknown: %v", err)
	}
	if n := countPosts(s, "/api/mux/jobs/j1/finish"); n != 0 {
		t.Errorf("sent: %v", s.posts)
	}
	// The ledger cannot be read.
	tc2, s2, _ := finishCLI(t)
	s2.set("GET /api/mux/jobs", answer(http.StatusServiceUnavailable, `{"error":"no","code":"jobs_unavailable"}`))
	if err := finishRun(tc2, "j1", "--close"); err == nil || !strings.Contains(err.Error(), "jobs_unavailable") {
		t.Errorf("ledger: %v", err)
	}
	s2.set("GET /api/mux/snapshot", answer(http.StatusInternalServerError, `{"error":"no"}`))
	if err := finishRun(tc2, "j1", "--close"); err == nil {
		t.Error("snapshot refused")
	}
}

func TestAgentsJobFinishRefusedByServer(t *testing.T) {
	tc, s, _ := finishCLI(t)
	for code, hint := range map[string]string{
		"finish_unread":            "termote agents read w1:pA",
		"finish_agent_working":     "termote agents wait --job j1",
		"worktree_not_pushed":      "termote agents job ci j1 --refresh (never push a merged branch again",
		"dirty":                    "never discard them",
		"finish_worktree_env":      "the user saves or deletes those files, then run this again; never read, copy or delete them yourself",
		"finish_worktree_shared":   "close the other tab or workspace",
		"finish_needs_remove":      "termote agents job finish j1 --close --remove-worktree",
		"finish_worktree_not_made": "the user finishes it in the PWA",
		"input_busy":               "",
	} {
		s.set("POST /api/mux/jobs/j1/finish", answer(http.StatusConflict, `{"error":"refused","code":"`+code+`"}`))
		err := finishRun(tc, "j1", "--close", "--remove-worktree")
		if err == nil || exitCode(err) != 1 || !strings.Contains(err.Error(), "("+code+")") || !strings.Contains(err.Error(), hint) {
			t.Errorf("%s: %v", code, err)
		}
	}
	// .env files the user may confirm in the PWA: named, and where.
	s.set("POST /api/mux/jobs/j1/finish", answer(http.StatusConflict,
		`{"error":"the worktree holds 1 .env files (.env.local)","code":"finish_worktree_env","files":[".env.local"],"confirmable":true}`))
	if err := finishRun(tc, "j1", "--close", "--remove-worktree"); err == nil || !strings.Contains(err.Error(), "(.env.local)") ||
		!strings.Contains(err.Error(), "they confirm the removal of those files in the PWA") ||
		!strings.Contains(err.Error(), "never read, copy or delete them yourself") {
		t.Errorf("confirmable env: %v", err)
	}
	s.set("POST /api/mux/jobs/j1/finish", answer(http.StatusConflict, `{"error":"in use","code":"in_use","closed":true}`))
	if err := finishRun(tc, "j1", "--close", "--remove-worktree"); err == nil ||
		!strings.Contains(err.Error(), "the tab is closed: run the same command again to remove the worktree") {
		t.Errorf("partial: %v", err)
	}
	// No answer: never sent again, and where to look.
	before := countPosts(s, "/api/mux/jobs/j1/finish")
	s.set("POST /api/mux/jobs/j1/finish", hangUp)
	if err := finishRun(tc, "j1", "--close"); err == nil || !strings.Contains(err.Error(), "may have been made") ||
		!strings.Contains(err.Error(), "termote agents jobs --all") {
		t.Errorf("no answer: %v", err)
	}
	if n := countPosts(s, "/api/mux/jobs/j1/finish"); n != before+1 {
		t.Errorf("sent %d times", n-before)
	}
}

func TestAgentsJobFinishNotRunning(t *testing.T) {
	tc, _ := socketCLI(t)
	tc.saveConfig(savedConfig{Port: 7997, Password: "secret"})
	if err := finishRun(tc, "j1", "--close"); err == nil || !strings.Contains(err.Error(), "did not answer on port 7997") {
		t.Errorf("err = %v", err)
	}
}
