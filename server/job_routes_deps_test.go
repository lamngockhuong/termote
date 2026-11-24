package main

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// newDepsTest is newJobsTest with a second workspace w2 whose pane w2:pb
// runs an agent too.
func newDepsTest(t *testing.T) *jobsTest {
	t.Helper()
	jt := newJobsTest(t)
	jt.f.mu.Lock()
	jt.f.snap.Groups = append(jt.f.snap.Groups, Group{ID: "w2", Name: "web", Tabs: []Tab{{ID: "w2:t1", Key: "w2:t1",
		Panes: []Pane{{ID: "w2:pb", Agent: &AgentInfo{Name: "claude", Status: "idle"}}}}}})
	jt.f.mu.Unlock()
	jt.snapshot()
	return jt
}

func (jt *jobsTest) patch(as, id string, body map[string]any) (int, map[string]any) {
	jt.t.Helper()
	if as != "socket" {
		if _, ok := body["updated"]; !ok {
			j, _ := jt.agent.jobs.job(id)
			body["updated"] = j.Updated.Format(time.RFC3339Nano)
		}
	}
	return jt.do(as, http.MethodPatch, "/api/mux/jobs/"+id, body)
}

func (jt *jobsTest) stored(id string) job {
	jt.t.Helper()
	j, ok := jt.agent.jobs.job(id)
	if !ok {
		jt.t.Fatalf("no job %s", id)
	}
	return j
}

func jobEventTexts(j job, kind string) []string {
	var out []string
	for _, e := range j.Events {
		if e.Kind == kind {
			out = append(out, e.Text)
		}
	}
	return out
}

func strs(v any) []string {
	var out []string
	for _, s := range asSlice(v) {
		out = append(out, s.(string))
	}
	return out
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func TestJobPriorityAndAfterRoutes(t *testing.T) {
	jt := newDepsTest(t)
	a := jt.create(map[string]any{"title": "A", "priority": "low"})["id"].(string)
	b := jt.create(map[string]any{"title": "B", "after": []string{a}, "priority": "normal"})
	if b["priority"] != nil || !slices.Equal(strs(b["after"]), []string{a}) || !slices.Equal(strs(b["waitsOn"]), []string{a}) || b["ready"] != nil {
		t.Errorf("B %v", b)
	}
	bid := b["id"].(string)
	for name, c := range map[string]struct {
		body map[string]any
		code string
	}{
		"bad priority": {map[string]any{"title": "x", "priority": "urgent"}, "job_invalid"},
		"malformed":    {map[string]any{"title": "x", "after": []string{"J2"}}, "job_invalid"},
		"missing":      {map[string]any{"title": "x", "after": []string{jid(9)}}, "job_after_missing"},
	} {
		if code, out := jt.do("full", http.MethodPost, "/api/mux/jobs", c.body); out["code"] != c.code || code < 400 {
			t.Errorf("%s = %d %v", name, code, out)
		}
	}
	for name, c := range map[string]struct {
		body map[string]any
		code string
	}{
		"self":   {map[string]any{"after": []string{bid}}, "job_invalid"},
		"cycle":  {map[string]any{"after": []string{bid}}, "job_cycle"},
		"21 ids": {map[string]any{"after": manyIDs(maxJobAfter + 1)}, "job_invalid"},
	} {
		id := a
		if name == "self" {
			id = bid
		}
		before := jt.stored(id)
		if code, out := jt.patch("full", id, c.body); out["code"] != c.code || code < 400 {
			t.Errorf("%s = %d %v", name, code, out)
		}
		if after := jt.stored(id); !after.Updated.Equal(before.Updated) {
			t.Errorf("%s wrote the job", name)
		}
	}
	// Priority and after change with an event each, a no-op with none.
	c := jt.create(map[string]any{"title": "C"})["id"].(string)
	if code, out := jt.patch("full", bid, map[string]any{"priority": "high", "after": []string{c, a}}); code != http.StatusOK {
		t.Fatalf("patch = %d %v", code, out)
	}
	if code, out := jt.patch("socket", bid, map[string]any{"priority": "high", "after": []string{c}}); code != http.StatusOK {
		t.Fatalf("patch = %d %v", code, out)
	}
	jb := jt.stored(bid)
	if jb.Priority != "high" || !slices.Equal(jb.After, []string{c}) ||
		!slices.Equal(jobEventTexts(jb, "priority"), []string{"high"}) || !slices.Equal(jobEventTexts(jb, "after"), []string{"+" + c, "-" + a}) {
		t.Errorf("B %+v", jb)
	}
	jt.patch("socket", bid, map[string]any{"priority": "normal"})
	if jb := jt.stored(bid); jb.Priority != "" || !slices.Equal(jobEventTexts(jb, "priority"), []string{"high", "normal"}) {
		t.Errorf("back to normal %+v", jb)
	}
	// A browser still needs updated; a view-only device is refused first.
	if code, out := jt.do("full", http.MethodPatch, "/api/mux/jobs/"+bid, map[string]any{"priority": "low"}); code != http.StatusBadRequest {
		t.Errorf("no updated = %d %v", code, out)
	}
	if code, out := jt.do("bridge", http.MethodPatch, "/api/mux/jobs/"+bid, map[string]any{"priority": "low"}); code != http.StatusBadRequest {
		t.Errorf("bridge without updated = %d %v", code, out)
	}
	if code, _ := jt.do("view", http.MethodPatch, "/api/mux/jobs/"+bid, "{"); code != http.StatusForbidden {
		t.Errorf("view = %d", code)
	}
}

func manyIDs(n int) []string {
	var out []string
	for i := range n {
		out = append(out, jid(0x40+i))
	}
	return out
}

// The listing is by priority, todo oldest first; ready=1 keeps the jobs to
// start; a finished job left out still counts for what waits on it.
func TestJobListOrderAndReady(t *testing.T) {
	jt := newDepsTest(t)
	failed := jt.create(map[string]any{"title": "F", "state": "failed"})["id"].(string)
	first := jt.create(map[string]any{"title": "first"})["id"].(string)
	waits := jt.create(map[string]any{"title": "waits", "after": []string{failed}})["id"].(string)
	high := jt.create(map[string]any{"title": "high", "priority": "high"})["id"].(string)
	low := jt.create(map[string]any{"title": "low", "priority": "low"})["id"].(string)
	code, out := jt.do("full", http.MethodGet, "/api/mux/jobs", nil)
	if code != http.StatusOK || !slices.Equal(strs(out["jobFields"]), []string{"priority", "after", "workspace"}) {
		t.Fatalf("list = %d %v", code, out)
	}
	var ids []string
	for _, j := range asSlice(out["jobs"]) {
		m := j.(map[string]any)
		ids = append(ids, m["id"].(string))
		if m["id"] == waits && (!slices.Equal(strs(m["waitsOn"]), []string{failed}) || !slices.Equal(strs(m["waitsOnFailed"]), []string{failed}) || m["ready"] != nil) {
			t.Errorf("waits %v", m)
		}
		if m["id"] == first && m["ready"] != true {
			t.Errorf("first %v", m)
		}
	}
	if !slices.Equal(ids, []string{high, first, waits, low}) {
		t.Errorf("order %v", ids)
	}
	_, out = jt.do("full", http.MethodGet, "/api/mux/jobs?ready=1", nil)
	ids = nil
	for _, j := range asSlice(out["jobs"]) {
		ids = append(ids, j.(map[string]any)["id"].(string))
	}
	if !slices.Equal(ids, []string{high, first, low}) {
		t.Errorf("ready %v", ids)
	}
	// A view-only device gets the ids and the enum, and the fields list.
	_, out = jt.do("view", http.MethodGet, "/api/mux/jobs", nil)
	if !slices.Equal(strs(out["jobFields"]), []string{"priority", "after", "workspace"}) {
		t.Errorf("view fields %v", out)
	}
	for _, j := range asSlice(out["jobs"]) {
		m := j.(map[string]any)
		if m["id"] == waits && (!slices.Equal(strs(m["after"]), []string{failed}) || !slices.Equal(strs(m["waitsOn"]), []string{failed})) {
			t.Errorf("view waits %v", m)
		}
		if m["id"] == high && m["priority"] != "high" {
			t.Errorf("view high %v", m)
		}
	}
}

// Removing a job it waits on strips it from after in the same write.
func TestJobDeleteStripsAfter(t *testing.T) {
	jt := newDepsTest(t)
	a := jt.create(map[string]any{"title": "A", "state": "done"})["id"].(string)
	b := jt.create(map[string]any{"title": "B", "after": []string{a}})["id"].(string)
	if code, _ := jt.do("socket", http.MethodDelete, "/api/mux/jobs/"+a, nil); code != http.StatusOK {
		t.Fatal(code)
	}
	for _, j := range jt.list() {
		if j["id"] == b && j["after"] != nil {
			t.Errorf("B %v", j)
		}
	}
	if jb := jt.stored(b); !slices.Equal(jobEventTexts(jb, "deps"), []string{a + " removed"}) {
		t.Errorf("events %+v", jb.Events)
	}
}

// after on a job in any state is kept, and blocks no state change.
func TestJobAfterAnyState(t *testing.T) {
	jt := newDepsTest(t)
	a := jt.create(map[string]any{"title": "A"})["id"].(string)
	for _, st := range []string{"active", "review", "done"} {
		id := jt.create(map[string]any{"title": st, "state": st})["id"].(string)
		if code, out := jt.patch("full", id, map[string]any{"after": []string{a}}); code != http.StatusOK || !slices.Equal(strs(out["job"].(map[string]any)["waitsOn"]), []string{a}) {
			t.Errorf("%s = %d %v", st, code, out)
		}
	}
	w := jt.create(map[string]any{"title": "W", "state": "active", "after": []string{a}})["id"].(string)
	for _, st := range []string{"review", "done"} {
		if code, out := jt.patch("socket", w, map[string]any{"state": st}); code != http.StatusOK {
			t.Errorf("to %s = %d %v", st, code, out)
		}
	}
}

func TestJobWorkspaceRoutes(t *testing.T) {
	jt := newDepsTest(t)
	// Set without a pane, refused for a group not open, cleared with "".
	j := jt.create(map[string]any{"title": "A", "workspace": "w2"})
	id := j["id"].(string)
	if j["workspace"] != "w2" {
		t.Errorf("A %v", j)
	}
	for _, as := range []string{"socket", "full"} {
		if code, out := jt.do(as, http.MethodPost, "/api/mux/jobs", map[string]any{"title": "x", "workspace": "w7"}); code != http.StatusConflict || out["code"] != "job_workspace_unknown" {
			t.Errorf("%s unknown = %d %v", as, code, out)
		}
		if code, out := jt.patch(as, id, map[string]any{"workspace": "w7"}); code != http.StatusConflict || out["code"] != "job_workspace_unknown" {
			t.Errorf("%s patch unknown = %d %v", as, code, out)
		}
	}
	if code, out := jt.patch("full", id, map[string]any{"workspace": "w1"}); code != http.StatusOK || out["job"].(map[string]any)["workspace"] != "w1" {
		t.Errorf("change = %d %v", code, out)
	}
	if code, out := jt.patch("full", id, map[string]any{"workspace": ""}); code != http.StatusOK || out["job"].(map[string]any)["workspace"] != nil {
		t.Errorf("clear = %d %v", code, out)
	}
	if got := jobEventTexts(jt.stored(id), "workspace"); !slices.Equal(got, []string{"w1", ""}) {
		t.Errorf("events %q", got)
	}
	// A workspace made after the last snapshot is found in a new one.
	jt.f.mu.Lock()
	jt.f.snap.Groups = append(jt.f.snap.Groups, Group{ID: "w3"})
	jt.f.mu.Unlock()
	if code, out := jt.patch("socket", id, map[string]any{"workspace": "w3"}); code != http.StatusOK {
		t.Errorf("new group = %d %v", code, out)
	}

	// A job with an agent keeps its workspace; the same value is no change.
	bound := jt.create(map[string]any{"title": "B", "pane": "w1:pa"})["id"].(string)
	for _, as := range []string{"socket", "full"} {
		before := jt.stored(bound)
		if code, out := jt.patch(as, bound, map[string]any{"workspace": "w2"}); code != http.StatusConflict || out["code"] != "job_workspace_bound" {
			t.Errorf("%s bound = %d %v", as, code, out)
		}
		if code, out := jt.patch(as, bound, map[string]any{"workspace": ""}); code != http.StatusConflict || out["code"] != "job_workspace_bound" {
			t.Errorf("%s bound clear = %d %v", as, code, out)
		}
		if !jt.stored(bound).Updated.Equal(before.Updated) {
			t.Errorf("%s wrote the bound job", as)
		}
	}
	if code, out := jt.patch("full", bound, map[string]any{"workspace": "w1"}); code != http.StatusOK || jobEventTexts(jt.stored(bound), "workspace") != nil {
		t.Errorf("same = %d %v", code, out)
	}
	// Only a worktree binds it too.
	tree := jt.create(map[string]any{"title": "T"})["id"].(string)
	jt.agent.jobs.update(tree, "", func(j *job) error { j.Worktree = &jobTree{Branch: "b", Dir: "/x"}; return nil })
	if code, out := jt.patch("full", tree, map[string]any{"workspace": "w2"}); code != http.StatusConflict || out["code"] != "job_workspace_bound" {
		t.Errorf("worktree = %d %v", code, out)
	}
	// An agent given after the client read the job is seen under the lock.
	late := jt.create(map[string]any{"title": "L"})["id"].(string)
	jt.agent.jobs.update(late, "", func(j *job) error { j.Agent = &jobAgent{Key: "w1:pa", PaneID: "w1:pa"}; return nil })
	if code, out := jt.patch("socket", late, map[string]any{"workspace": "w2"}); code != http.StatusConflict || out["code"] != "job_workspace_bound" {
		t.Errorf("late agent = %d %v", code, out)
	}
}

// A job given its first pane takes the pane's workspace; a later pane
// leaves it; a pane with another workspace is refused, writing nothing.
func TestJobWorkspaceFromPane(t *testing.T) {
	jt := newDepsTest(t)
	for name, c := range map[string]struct {
		ws     string
		events []string
	}{
		"none":    {"", []string{"w1"}},
		"another": {"w2", []string{"w2", "w1"}},
		"same":    {"w1", []string{"w1"}},
	} {
		body := map[string]any{"title": name}
		if c.ws != "" {
			body["workspace"] = c.ws
		}
		id := jt.create(body)["id"].(string)
		if c.ws != "" {
			// The create's own workspace is not an event; the PATCH that set
			// one before the pane is.
			jt.patch("socket", id, map[string]any{"workspace": ""})
			jt.patch("socket", id, map[string]any{"workspace": c.ws})
		}
		if code, out := jt.patch("full", id, map[string]any{"pane": "w1:pa"}); code != http.StatusOK {
			t.Fatalf("%s = %d %v", name, code, out)
		}
		j := jt.stored(id)
		got := jobEventTexts(j, "workspace")
		if c.ws != "" {
			got = got[1:] // the clear
		}
		if j.Workspace != "w1" || !slices.Equal(got, c.events) {
			t.Errorf("%s: %s %q", name, j.Workspace, got)
		}
		// Another pane later: the workspace stays.
		if code, out := jt.patch("socket", id, map[string]any{"pane": "w2:pb"}); code != http.StatusOK || jt.stored(id).Workspace != "w1" {
			t.Errorf("%s another pane = %d %v", name, code, out)
		}
	}
	// A pane with another workspace: refused, nothing written.
	id := jt.create(map[string]any{"title": "P"})["id"].(string)
	before := jt.stored(id)
	for _, as := range []string{"socket", "full"} {
		for _, ws := range []string{"w2", ""} {
			if code, out := jt.patch(as, id, map[string]any{"pane": "w1:pa", "workspace": ws}); code != http.StatusConflict || out["code"] != "job_workspace_bound" {
				t.Errorf("%s pane + %q = %d %v", as, ws, code, out)
			}
		}
	}
	if j := jt.stored(id); j.Agent != nil || !j.Updated.Equal(before.Updated) || len(j.Events) != len(before.Events) {
		t.Errorf("refused patch wrote %+v", j)
	}
	if code, out := jt.patch("full", id, map[string]any{"pane": "w1:pa", "workspace": "w1"}); code != http.StatusOK || jt.stored(id).Agent == nil {
		t.Errorf("pane + its workspace = %d %v", code, out)
	}

	// The same for a job made with a pane.
	for _, as := range []string{"socket", "full"} {
		if j := jt.create(map[string]any{"title": "n", "pane": "w1:pa"}); j["workspace"] != "w1" {
			t.Errorf("%s pane alone %v", as, j)
		}
		code, out := jt.do(as, http.MethodPost, "/api/mux/jobs", map[string]any{"title": "n", "pane": "w1:pa", "workspace": "w1"})
		if code != http.StatusCreated {
			t.Errorf("%s pane + its workspace = %d %v", as, code, out)
		}
		data, _ := os.ReadFile(filepath.Join(jt.dir, jobsFile))
		if code, out := jt.do(as, http.MethodPost, "/api/mux/jobs", map[string]any{"title": "n", "pane": "w1:pa", "workspace": "w2"}); code != http.StatusConflict || out["code"] != "job_workspace_bound" {
			t.Errorf("%s pane + another = %d %v", as, code, out)
		}
		if after, _ := os.ReadFile(filepath.Join(jt.dir, jobsFile)); !bytes.Equal(data, after) {
			t.Errorf("%s refused create wrote the file", as)
		}
		if code, out := jt.do(as, http.MethodPost, "/api/mux/jobs", map[string]any{"title": "n", "pane": "w1:pa", "workspace": "w7"}); code != http.StatusConflict || out["code"] != "job_workspace_unknown" {
			t.Errorf("%s pane + unknown = %d %v", as, code, out)
		}
	}
}

// A start in a worktree records the workspace it ran from (S, w1), its
// pane being in the worktree's own (W, w2).
func TestJobWorkspaceOfWorktreeStart(t *testing.T) {
	jt := newDepsTest(t)
	wtDir := t.TempDir()
	jt.agent.wm = &fakeWorktreeMux{list: WorktreeList{Worktrees: []Worktree{{Path: "/repo", Branch: "main", GroupID: "w1"},
		{Path: wtDir, Branch: "feat", Linked: true, GroupID: "w2"}}}}
	tree := map[string]any{"source": "w1", "branch": "feat", "made": true}
	j := jt.create(map[string]any{"title": "S", "pane": "w2:pb", "workspace": "w1", "worktree": tree})
	if j["workspace"] != "w1" || j["worktree"].(map[string]any)["groupId"] != "w2" {
		t.Errorf("start %v", j)
	}
	if j := jt.create(map[string]any{"title": "S", "pane": "w2:pb", "worktree": tree}); j["workspace"] != "w1" {
		t.Errorf("no workspace %v", j)
	}
	if code, out := jt.do("socket", http.MethodPost, "/api/mux/jobs", map[string]any{"title": "S", "pane": "w2:pb", "workspace": "w2", "worktree": tree}); code != http.StatusConflict || out["code"] != "job_workspace_bound" {
		t.Errorf("worktree's own = %d %v", code, out)
	}
	// A browser's worktree is ignored: it is held to the pane's workspace.
	body := map[string]any{"title": "S", "pane": "w2:pb", "workspace": "w1", "worktree": tree}
	if code, out := jt.do("full", http.MethodPost, "/api/mux/jobs", body); code != http.StatusConflict || out["code"] != "job_workspace_bound" {
		t.Errorf("browser = %d %v", code, out)
	}

	// start --job <todo> --worktree: the todo job gets the source.
	for name, ws := range map[string]string{"source": "w1", "none": "", "another": "w2"} {
		body := map[string]any{"title": name}
		if ws != "" {
			body["workspace"] = ws
		}
		id := jt.create(body)["id"].(string)
		if code, out := jt.patch("socket", id, map[string]any{"pane": "w2:pb", "state": "active", "worktree": tree}); code != http.StatusOK {
			t.Fatalf("%s = %d %v", name, code, out)
		}
		j := jt.stored(id)
		changed := ws != "w1"
		if j.Workspace != "w1" || j.Worktree.GroupID != "w2" || (len(jobEventTexts(j, "workspace")) > 0) != changed {
			t.Errorf("%s: %+v", name, j)
		}
	}
}

func TestJobListFieldsUnchangedForOldClients(t *testing.T) {
	jt := newDepsTest(t)
	jt.create(map[string]any{"title": "plain"})
	data, _ := os.ReadFile(filepath.Join(jt.dir, jobsFile))
	for _, k := range []string{`"priority"`, `"after"`, `"workspace"`} {
		if strings.Contains(string(data), k) {
			t.Errorf("a plain job stores %s: %s", k, data)
		}
	}
}
