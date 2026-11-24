package main

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// warmRepos has the nester look up every group of the fake's snapshot and
// waits until it knows want of them.
func warmRepos(t *testing.T, jt *jobsTest, want int) {
	t.Helper()
	jt.snapshot()
	deadline := time.Now().Add(5 * time.Second)
	for {
		snap, _ := jt.agent.activity.lastSnapshot()
		if len(jt.agent.groupRepos(snap, true)) >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the nester knows %d repositories", len(jt.agent.groupRepos(snap, false)))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// group is a workspace whose first pane works in dir.
func repoGroup(id, dir string) Group {
	return Group{ID: id, Name: id, Tabs: []Tab{{ID: id + ":t", Key: id + ":t", Panes: []Pane{{ID: id + ":p", Process: &ProcessInfo{Name: "zsh", Cwd: dir}}}}}}
}

// newRepoTest is newDepsTest whose w1 works in /src/app and w2 in
// /src/web, both repositories.
func newRepoTest(t *testing.T) *jobsTest {
	t.Helper()
	jt := newDepsTest(t)
	fr := &fakeRepos{repos: map[string]gitRepoInfo{
		"/src/app":    {Top: "/src/app", Main: "/src/app"},
		"/src/app-wt": {Top: "/src/app-wt", Main: "/src/app", Linked: true},
		"/src/web":    {Top: "/src/web"},
	}}
	jt.agent.nester = newTestNester(fr.lookup)
	jt.f.mu.Lock()
	jt.f.snap.Groups[0].Tabs[0].Panes[0].Process = &ProcessInfo{Name: "claude", Cwd: "/src/app"}
	jt.f.snap.Groups[1].Tabs[0].Panes[0].Process = &ProcessInfo{Name: "claude", Cwd: "/src/web"}
	jt.f.mu.Unlock()
	warmRepos(t, jt, 2)
	return jt
}

func (jt *jobsTest) setGroups(groups ...Group) {
	jt.f.mu.Lock()
	jt.f.snap.Groups = groups
	jt.f.mu.Unlock()
}

func TestJobRepoRecorded(t *testing.T) {
	jt := newRepoTest(t)
	j := jt.create(map[string]any{"title": "A", "workspace": "w1", "repo": "/etc"})
	if j["repo"] != "/src/app" {
		t.Errorf("A %v", j)
	}
	id := j["id"].(string)
	// Moved to another workspace, the repository follows; cleared with it.
	jt.patch("socket", id, map[string]any{"workspace": "w2"})
	if got := jt.stored(id).Repo; got != "/src/web" {
		t.Errorf("w2: %q", got)
	}
	jt.patch("socket", id, map[string]any{"workspace": ""})
	if got := jt.stored(id).Repo; got != "" {
		t.Errorf("cleared: %q", got)
	}
	// A group whose repository is not known: none; a pane's group, the
	// agent's.
	g3 := repoGroup("w3", "/src/none")
	jt.setGroups(append(slices.Clone(jt.f.snap.Groups), g3)...)
	jt.snapshot()
	if j := jt.create(map[string]any{"title": "B", "workspace": "w3"}); j["repo"] != nil {
		t.Errorf("unknown repository %v", j)
	}
	if j := jt.create(map[string]any{"title": "C", "pane": "w1:pa"}); j["repo"] != "/src/app" {
		t.Errorf("pane %v", j)
	}
	// A group the last snapshot does not show yet: no repository, and the
	// workspace stays as set.
	jt.patch("socket", id, map[string]any{"workspace": "w1"})
	jt.f.mu.Lock()
	jt.f.snap.Groups = append(jt.f.snap.Groups, repoGroup("w4", "/src/app"))
	jt.f.mu.Unlock()
	if code, out := jt.patch("socket", id, map[string]any{"workspace": "w4"}); code != http.StatusOK {
		t.Fatalf("w4 = %d %v", code, out)
	}
	if j := jt.stored(id); j.Workspace != "w4" || j.Repo != "" {
		t.Errorf("w4 %+v", j)
	}
}

// A workspace closed and opened again under a new id: the job is shown
// there, moved there at its next write, never by a read.
func TestJobRepoWorkspaceNow(t *testing.T) {
	jt := newRepoTest(t)
	id := jt.create(map[string]any{"title": "A", "workspace": "w1"})["id"].(string)
	w2 := jt.f.snap.Groups[1]
	// w1 recreated as w5, a worktree of the same repository first.
	jt.setGroups(w2, repoGroup("w6", "/src/app-wt"), repoGroup("w5", "/src/app"))
	warmRepos(t, jt, 3)
	path := filepath.Join(jt.dir, jobsFile)
	before, _ := os.ReadFile(path)
	for _, as := range []string{"full", "view"} {
		code, out := jt.do(as, http.MethodGet, "/api/mux/jobs?workspace=w5", nil)
		jobs := asSlice(out["jobs"])
		if code != http.StatusOK || len(jobs) != 1 {
			t.Fatalf("%s = %d %v", as, code, out)
		}
		m := jobs[0].(map[string]any)
		if m["workspaceNow"] != "w5" || m["workspace"] != "w1" {
			t.Errorf("%s %v", as, m)
		}
		if _, ok := m["repo"]; ok != (as == "full") {
			t.Errorf("%s repo %v", as, m)
		}
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
		t.Error("a read wrote the ledger")
	}
	// Without a main checkout open, the worktree's group.
	jt.setGroups(w2, repoGroup("w6", "/src/app-wt"))
	jt.snapshot()
	if snap, _ := jt.agent.activity.lastSnapshot(); workspaceNow(snap, jt.agent.groupRepos(snap, false), jt.stored(id)) != "w6" {
		t.Error("linked fallback")
	}
	// The job's own worktree before another's of the same repository.
	jt.agent.jobs.update(id, "", func(j *job) error { j.Worktree = &jobTree{Branch: "b", Dir: "/src/app-wt2", GroupID: "w8"}; return nil })
	jt.setGroups(w2, repoGroup("w6", "/src/app-wt"), repoGroup("w8", "/src/app-wt"))
	warmRepos(t, jt, 3)
	if snap, _ := jt.agent.activity.lastSnapshot(); workspaceNow(snap, jt.agent.groupRepos(snap, false), jt.stored(id)) != "w8" {
		t.Error("own worktree first")
	}
	// Two main checkouts: the first in the snapshot's order.
	jt.setGroups(w2, repoGroup("w7", "/src/app"), repoGroup("w5", "/src/app"))
	warmRepos(t, jt, 3)
	// A single job's view (a grant's or a finish's answer) says it too.
	if v := jt.agent.viewJob(jt.stored(id)); v.WorkspaceNow != "w7" {
		t.Errorf("view %q", v.WorkspaceNow)
	}
	// The next write moves it.
	if code, out := jt.do("socket", http.MethodPost, "/api/mux/jobs/"+id+"/event", map[string]any{"kind": "sent", "text": "x"}); code != http.StatusOK {
		t.Fatalf("event = %d %v", code, out)
	}
	j := jt.stored(id)
	if j.Workspace != "w7" || j.Repo != "/src/app" || !slices.Equal(jobEventTexts(j, "workspace"), []string{"w7"}) {
		t.Errorf("moved %+v", j)
	}
	// None open: it stays as it is.
	jt.setGroups(w2)
	jt.snapshot()
	jt.do("socket", http.MethodPost, "/api/mux/jobs/"+id+"/event", map[string]any{"kind": "sent", "text": "y"})
	if j := jt.stored(id); j.Workspace != "w7" || j.Repo != "/src/app" {
		t.Errorf("none open %+v", j)
	}
	// No nester (a server without one): nothing is known.
	jt.agent.nester = nil
	if jt.agent.groupRepos(Snapshot{Groups: []Group{repoGroup("w1", "/src/app")}}, true) != nil {
		t.Error("repositories without a nester")
	}
}
