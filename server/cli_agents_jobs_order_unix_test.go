//go:build !windows

package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// jobLine runs agents with args and returns what it printed, failing the
// test on an error.
func jobLine(t *testing.T, tc *testCLI, args ...string) string {
	t.Helper()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", args); err != nil {
		t.Fatalf("%v: %v (%s)", args, err, tc.stderr)
	}
	return tc.stdout.String()
}

func jobIDs(list []jobView) []string {
	var out []string
	for _, j := range list {
		out = append(out, j.ID)
	}
	return out
}

func TestAgentsJobPriorityAndAfter(t *testing.T) {
	tc, f, _ := jobsCLI(t)
	a := addJob(t, tc, "--title", "A")
	tc.stdout.Reset()
	out := jobLine(t, tc, "job", "add", "--title", "B", "--priority", "high", "--after", a.ID)
	if !strings.Contains(out, ": B (todo, high, after "+a.ID+")") {
		t.Errorf("add: %s", out)
	}
	b := jobsOf(t, tc)[0]
	c := addJob(t, tc, "--title", "C", "--priority", "low")
	// By priority, the jobs to do oldest first; ready keeps what can start.
	if got := jobIDs(jobsOf(t, tc)); strings.Join(got, " ") != strings.Join([]string{b.ID, a.ID, c.ID}, " ") {
		t.Errorf("order %v", got)
	}
	if got := jobIDs(jobsOf(t, tc, "--ready")); strings.Join(got, " ") != a.ID+" "+c.ID {
		t.Errorf("ready %v", got)
	}
	table := jobLine(t, tc, "jobs", "--ready")
	if !strings.Contains(table, "Jobs (jobs ready to start, of every creator): 2") || !strings.Contains(table, "PRI") {
		t.Errorf("ready table:\n%s", table)
	}
	table = jobLine(t, tc, "jobs")
	for _, want := range []string{"PRI", "AFTER", "WS", "high", a.ID} {
		if !strings.Contains(table, want) {
			t.Errorf("table lacks %q:\n%s", want, table)
		}
	}
	// A job that waits is not started, and nothing is.
	starts := len(f.promptText)
	err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "claude", "--job", b.ID})
	if err == nil || !strings.Contains(err.Error(), "waits on "+a.ID+" (todo)") || !strings.Contains(err.Error(), "job set "+b.ID+" --no-after "+a.ID) {
		t.Errorf("start --job: %v", err)
	}
	if len(f.promptText) != starts {
		t.Error("started")
	}
	// show names what it waits on.
	show := jobLine(t, tc, "job", "show", b.ID)
	if !strings.Contains(show, "Priority: high") || !strings.Contains(show, "Waits on: "+a.ID+" (todo)") {
		t.Errorf("show:\n%s", show)
	}
	// A cycle is refused with its hint; an id the job does not wait on is a
	// usage error naming it.
	if err := tc.dispatch("agents", []string{"job", "set", a.ID, "--after", b.ID}); err == nil || !strings.Contains(err.Error(), "would wait on each other") ||
		!strings.Contains(err.Error(), "job show") {
		t.Errorf("cycle: %v", err)
	}
	if err := tc.dispatch("agents", []string{"job", "set", b.ID, "--no-after", c.ID}); exitCode(err) != 2 || !strings.Contains(err.Error(), "does not wait on "+c.ID) {
		t.Errorf("no-after unknown: %v", err)
	}
	// --after on a job in review is a note of order: shown, nothing blocked.
	jobLine(t, tc, "job", "set", c.ID, "--state", "review", "--after", a.ID, "--priority", "normal")
	jobLine(t, tc, "job", "set", a.ID, "--state", "failed")
	show = jobLine(t, tc, "job", "show", c.ID)
	if !strings.Contains(show, "Priority: normal") || !strings.Contains(show, "Waits on: "+a.ID+" (failed: the user decides") {
		t.Errorf("show review:\n%s", show)
	}
	if table := jobLine(t, tc, "jobs"); !strings.Contains(table, a.ID+"!") {
		t.Errorf("failed mark:\n%s", table)
	}
	// Dropped: B is ready.
	out = jobLine(t, tc, "job", "set", b.ID, "--no-after", a.ID)
	if !strings.Contains(out, "(todo, high)") {
		t.Errorf("set: %s", out)
	}
	if got := jobIDs(jobsOf(t, tc, "--ready")); len(got) != 1 || got[0] != b.ID {
		t.Errorf("ready after the drop %v", got)
	}
	// A job removed leaves the after of those waiting on it.
	jobLine(t, tc, "job", "set", b.ID, "--after", a.ID)
	jobLine(t, tc, "job", "remove", a.ID)
	if show := jobLine(t, tc, "job", "show", b.ID); strings.Contains(show, "Waits on") || !strings.Contains(show, "deps "+a.ID+" removed") {
		t.Errorf("after the remove:\n%s", show)
	}
	// A dependency done is counted, not listed.
	d := addJob(t, tc, "--title", "D")
	jobLine(t, tc, "job", "set", b.ID, "--after", d.ID)
	jobLine(t, tc, "job", "set", d.ID, "--state", "done")
	if show := jobLine(t, tc, "job", "show", b.ID); strings.Contains(show, "Waits on") || !strings.Contains(show, "After: 1 job(s) done") {
		t.Errorf("done dependency:\n%s", show)
	}
}

func TestAgentsJobWorkspace(t *testing.T) {
	tc, _, _ := jobsCLI(t)
	j := addJob(t, tc, "--title", "Docs", "--workspace", "orchestrator")
	if j.Workspace != "$2" {
		t.Fatalf("job %+v", j)
	}
	if got := jobsOf(t, tc, "--workspace", "orchestrator"); len(got) != 1 || got[0].ID != j.ID {
		t.Errorf("filter %+v", got)
	}
	if show := jobLine(t, tc, "job", "show", j.ID); !strings.Contains(show, "Workspace: orchestrator ($2)") {
		t.Errorf("show:\n%s", show)
	}
	if table := jobLine(t, tc, "jobs"); !strings.Contains(table, "orchestrator") {
		t.Errorf("table:\n%s", table)
	}
	if err := tc.dispatch("agents", []string{"job", "add", "--title", "x", "--workspace", "nope"}); err == nil || !strings.Contains(err.Error(), "no workspace is named") {
		t.Errorf("unknown: %v", err)
	}
	// With a pane, only the pane's workspace, by id or name; another is a
	// usage error before anything is sent.
	before := len(jobsOf(t, tc))
	if err := tc.dispatch("agents", []string{"job", "add", "--title", "x", "--pane", "web/api", "--workspace", "orchestrator"}); exitCode(err) != 2 ||
		!strings.Contains(err.Error(), "--workspace orchestrator is not the workspace of pane %1; leave --workspace out") {
		t.Errorf("pane + another: %v", err)
	}
	if got := len(jobsOf(t, tc)); got != before {
		t.Errorf("a job was made: %d", got)
	}
	for _, ws := range []string{"web", "$1"} {
		if j := addJob(t, tc, "--title", "x", "--pane", "web/api", "--workspace", ws); j.Workspace != "$1" {
			t.Errorf("%s: %+v", ws, j)
		}
	}
	bound := addJob(t, tc, "--title", "bound", "--pane", "web/api")
	if bound.Workspace != "$1" {
		t.Errorf("pane alone %+v", bound)
	}
	// A bound job keeps it; one without a pane changes or drops it.
	if err := tc.dispatch("agents", []string{"job", "set", bound.ID, "--workspace", "orchestrator"}); err == nil ||
		!strings.Contains(err.Error(), "its workspace is the one it was started in") {
		t.Errorf("bound: %v", err)
	}
	jobLine(t, tc, "job", "set", j.ID, "--workspace", "web")
	jobLine(t, tc, "job", "set", j.ID, "--no-workspace")
	if show := jobLine(t, tc, "job", "show", j.ID); strings.Contains(show, "Workspace:") {
		t.Errorf("dropped:\n%s", show)
	}
	if err := tc.dispatch("agents", []string{"job", "set", j.ID, "--pane", "ui", "--workspace", "orchestrator"}); exitCode(err) != 2 ||
		!strings.Contains(err.Error(), "is not the workspace of pane %2") {
		t.Errorf("set pane + another: %v", err)
	}
	jobLine(t, tc, "job", "set", j.ID, "--pane", "ui", "--workspace", "web")
	if got, _ := findJob(jobsOf(t, tc), j.ID); got.Workspace != "$1" || got.Agent == nil {
		t.Errorf("set pane + its workspace: %+v", got)
	}
}

func TestJobTableTexts(t *testing.T) {
	s := Snapshot{Groups: []Group{{ID: "$1", Name: "web"}, {ID: "$2"}}}
	for id, want := range map[string]string{"$1": "web ($1)", "$2": "$2", "$9": "$9"} {
		if got := workspaceText(s, id); got != want {
			t.Errorf("%s = %q", id, got)
		}
	}
	j := jobView{WaitsOn: []string{"a", "b", "c", "d", "e"}, WaitsOnFailed: []string{"b"}}
	if got := afterShort(j); got != "a b! c +2" {
		t.Errorf("after %q", got)
	}
	if got := afterShort(jobView{}); got != "-" {
		t.Errorf("none %q", got)
	}
}

func TestAgentsJobSetUnknownWorkspace(t *testing.T) {
	tc, _, _ := jobsCLI(t)
	j := addJob(t, tc, "--title", "x")
	if err := tc.dispatch("agents", []string{"job", "set", j.ID, "--workspace", "nope"}); err == nil || !strings.Contains(err.Error(), "no workspace is named") {
		t.Errorf("unknown: %v", err)
	}
}

// A job whose workspace was closed and opened again is found by the new
// one, and show names both and its repository.
func TestAgentsJobWorkspaceNow(t *testing.T) {
	tc, s := scriptedCLI(t)
	s.set("GET /api/mux/snapshot", jsonAnswer(Snapshot{Backend: "herdr", Groups: []Group{{ID: "w5", Name: "app"}}}))
	j := jobView{job: job{ID: jid(1), Title: "A", State: "todo", Workspace: "w1", Repo: filepath.Join(tc.home, "src", "app")}, WorkspaceNow: "w5"}
	s.set("GET /api/mux/jobs", jsonAnswer(map[string]any{"jobs": []jobView{j}}))
	if got := jobsOf(t, tc, "--workspace", "app"); len(got) != 1 {
		t.Errorf("filter %+v", got)
	}
	if table := jobLine(t, tc, "jobs"); !strings.Contains(table, "app") {
		t.Errorf("table:\n%s", table)
	}
	show := jobLine(t, tc, "job", "show", j.ID)
	if !strings.Contains(show, "Workspace: app (w5) (w1 was closed; the same repository)") || !strings.Contains(show, "Repository: ~/src/app") {
		t.Errorf("show:\n%s", show)
	}
}
