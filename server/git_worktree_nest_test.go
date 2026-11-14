package main

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// newTestNester is a nester whose lookup is fn.
func newTestNester(fn func(ctx context.Context, dir string) (gitRepoInfo, bool, error)) *gitNester {
	n := newGitNester(nil)
	n.lookup = fn
	return n
}

// fakeRepos answers a lookup from a table of folder → repository.
type fakeRepos struct {
	mu    sync.Mutex
	repos map[string]gitRepoInfo
	calls int
	err   error
}

func (f *fakeRepos) lookup(_ context.Context, dir string) (gitRepoInfo, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return gitRepoInfo{}, false, f.err
	}
	info, ok := f.repos[dir]
	return info, ok, nil
}

func (f *fakeRepos) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func groupIn(id, dir string) Group {
	return Group{ID: id, Name: id, Tabs: []Tab{{ID: id + ":0", Panes: []Pane{{ID: id + "p", Process: &ProcessInfo{Name: "zsh", Cwd: dir}}}}}}
}

func groupIDs(gs []Group) string {
	var ids []string
	for _, g := range gs {
		s := g.ID
		if g.Worktree != nil {
			s += "(" + map[bool]string{true: "L", false: "M"}[g.Worktree.Linked] + g.Worktree.Branch
			if g.Worktree.Parent != "" {
				s += "<" + g.Worktree.Parent
			}
			s += ")"
		}
		ids = append(ids, s)
	}
	return strings.Join(ids, ",")
}

func linkedOf(common, branch string) gitRepoInfo {
	return gitRepoInfo{Common: common, Linked: true, Branch: branch}
}

func mainOf(common string) gitRepoInfo {
	return gitRepoInfo{Common: common, Branch: "main"}
}

// nestedSoon starts the lookups, then waits until every one has landed.
func nestedSoon(t *testing.T, n *gitNester, snap Snapshot, want string) Snapshot {
	t.Helper()
	n.nest(snap, true)
	var got Snapshot
	waitFor(t, func() bool {
		got = n.nest(snap, false)
		return groupIDs(got.Groups) == want
	})
	return got
}

func TestGitNesterOrders(t *testing.T) {
	f := &fakeRepos{repos: map[string]gitRepoInfo{
		"/r/wt": linkedOf("/r/.git", "feat/x"), "/r": mainOf("/r/.git"),
		"/s": mainOf("/s/.git"), "/s/wt": linkedOf("/s/.git", "s1"),
		"/t":   mainOf("/t/.git"), // a plain repo: no linked worktree open
		"/bwt": linkedOf("/b.git", "b1"),
	}}
	n := newTestNester(f.lookup)
	snap := Snapshot{Groups: []Group{groupIn("g1", "/r/wt"), groupIn("g2", "/r"), groupIn("g3", "/s"), groupIn("g4", "/s/wt"),
		groupIn("g5", "/none"), groupIn("g6", "/bwt"), groupIn("g7", "/t"), {ID: "g8"}}}
	before := groupIDs(snap.Groups)
	if got := n.nest(snap, false); groupIDs(got.Groups) != before || f.count() != 0 {
		t.Fatalf("nothing cached and no start: %s, %d lookups", groupIDs(got.Groups), f.count())
	}
	nestedSoon(t, n, snap, "g2(Mmain),g1(Lfeat/x<g2),g3(Mmain),g4(Ls1<g3),g5,g6(Lb1),g7,g8")
	if groupIDs(snap.Groups) != before {
		t.Errorf("the snapshot passed in was changed: %s", groupIDs(snap.Groups))
	}

	// With the main checkout not open, a repository's worktrees stay together
	// where the first one is.
	snap = Snapshot{Groups: []Group{groupIn("a", "/r/wt"), groupIn("b", "/none"), groupIn("c", "/r/wt")}}
	if got := n.nest(snap, false); groupIDs(got.Groups) != "a(Lfeat/x),c(Lfeat/x),b" {
		t.Errorf("parent missing: %s", groupIDs(got.Groups))
	}

	// After a drop, what was known is served while it is looked up again.
	n.drop()
	if got := n.nest(snap, false); groupIDs(got.Groups) != "a(Lfeat/x),c(Lfeat/x),b" {
		t.Errorf("after drop: %s", groupIDs(got.Groups))
	}
	calls := f.count()
	n.nest(snap, true)
	waitFor(t, func() bool { return f.count() > calls })
}

// Where file names ignore case (Windows, macOS), a git dir that differs only
// in case is the same repository: its worktree nests under its checkout.
func TestGitNesterIgnoresCase(t *testing.T) {
	f := &fakeRepos{repos: map[string]gitRepoInfo{
		`C:\R\wt`: linkedOf(`C:\R\.git`, "feat/x"), `c:\r`: mainOf(`c:\r\.git`),
	}}
	n := newTestNester(f.lookup)
	snap := Snapshot{Groups: []Group{groupIn("g1", `C:\R\wt`), groupIn("g2", `c:\r`)}}
	want := "g1(Lfeat/x),g2"
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		want = "g2(Mmain),g1(Lfeat/x<g2)"
	}
	nestedSoon(t, n, snap, want)
}

func TestGitNesterCache(t *testing.T) {
	f := &fakeRepos{repos: map[string]gitRepoInfo{"/r": mainOf("/r/.git"), "/r/wt": linkedOf("/r/.git", "x")}}
	n := newTestNester(f.lookup)
	snap := Snapshot{Groups: []Group{groupIn("m", "/r"), groupIn("w", "/r/wt")}}
	nestedSoon(t, n, snap, "m(Mmain),w(Lx<m)")
	calls := f.count()
	// Fresh: a full read starts nothing more.
	n.nest(snap, true)
	if f.count() != calls {
		t.Errorf("fresh entries looked up again: %d → %d", calls, f.count())
	}

	// A failed lookup keeps what was known.
	n.mu.Lock()
	for k, e := range n.entries {
		e.until = e.until.Add(-nestFresh)
		n.entries[k] = e
	}
	n.mu.Unlock()
	f.mu.Lock()
	f.err = errors.New("git timed out")
	f.mu.Unlock()
	n.nest(snap, true)
	waitFor(t, func() bool { return f.count() >= calls+2 })
	waitFor(t, func() bool {
		n.mu.Lock()
		defer n.mu.Unlock()
		return len(n.busy) == 0
	})
	if got := n.nest(snap, false); groupIDs(got.Groups) != "m(Mmain),w(Lx<m)" {
		t.Errorf("after a failed refresh: %s", groupIDs(got.Groups))
	}
	n.mu.Lock()
	e := n.entries["/r"]
	n.mu.Unlock()
	if !e.ok || time.Until(e.until) < nestFresh {
		t.Errorf("entry %+v", e)
	}

	var nilNester *gitNester
	if got := nilNester.nest(snap, true); groupIDs(got.Groups) != "m,w" {
		t.Errorf("nil nester: %s", groupIDs(got.Groups))
	}
	nilNester.drop()
}

func TestGroupFolder(t *testing.T) {
	g := groupIn("g", "/active")
	g.Tabs[0].Processes = []ProcessInfo{{Name: "zsh", Cwd: "/first"}, {Name: "zsh", Cwd: "/active"}}
	if dir := groupFolder(g); dir != "/first" {
		t.Errorf("tmux's first pane: %q", dir)
	}
	if dir := groupFolder(groupIn("g", "/x")); dir != "/x" {
		t.Errorf("first pane: %q", dir)
	}
	if dir := groupFolder(Group{Tabs: []Tab{{Panes: []Pane{{ID: "p"}}}}}); dir != "" {
		t.Errorf("no process: %q", dir)
	}
}

// On hc a move's index is among the spaces the nested view lets move: a
// linked worktree cannot move, and a parent moves past another repository's
// block.
func TestHcMoveGroupNested(t *testing.T) {
	s := newHcSim(t)
	d := s.withDoc(t)
	ctx := ctx5s(t)
	s.mu.Lock()
	s.terms["t7"] = map[string]any{"address": "t7", "labels": map[string]string{hcLabelSpace: "sp3", hcLabelTab: "tb7"},
		"state": "live", "cols": 80, "rows": 24, "cwd": "/u", "argv": []string{"zsh"}, "created_ms": 60,
		"foreground": map[string]any{"pid": 1060, "name": "zsh", "cwd": "/u", "argv": []string{"zsh"}}}
	rec := s.recLocked("t7")
	s.mu.Unlock()
	d.mu.Lock()
	doc := strings.TrimSuffix(strings.TrimSpace(hcSimDocValue), "]}") +
		`,{"id":"sp3","name":"three","folder":"/u","tabs":[{"id":"tb7","name":"","root":{"id":"b7","type":"block","content":{"terminal":"t7"}}}]}]}`
	d.value, d.version = []byte(doc), d.version+1
	version := d.version
	d.mu.Unlock()
	s.emit("t7", "created", rec)
	s.emit("", "doc", map[string]any{"name": hcAppDoc, "version": version})

	snap, err := s.m.Snapshot(ctx)
	waitFor(t, func() bool {
		snap, err = s.m.Snapshot(ctx)
		return err == nil && len(snap.Groups) == 3
	})
	// sp1 is a repository's main checkout, sp3 a linked worktree of it.
	f := &fakeRepos{repos: map[string]gitRepoInfo{}}
	for _, g := range snap.Groups {
		switch g.ID {
		case "sp1":
			f.repos[groupFolder(g)] = mainOf("/w/.git")
		case "sp3":
			f.repos[groupFolder(g)] = linkedOf("/w/.git", "x")
		}
	}
	n := newTestNester(f.lookup)
	nestedSoon(t, n, snap, "sp1(Mmain),sp3(Lx<sp1),sp2")
	s.m.nester = n

	if err := s.m.MoveGroup(ctx, "sp3", 0); err != errLinkedWorktree {
		t.Errorf("move a linked worktree: %v", err)
	}
	if err := s.m.MoveGroup(ctx, "sp1", 2); err != errInvalidIndex {
		t.Errorf("index past the movable spaces: %v", err)
	}
	if err := s.m.MoveGroup(ctx, "sp1", 1); err != nil {
		t.Fatal(err)
	}
	// The linked worktree keeps its place in the document.
	if got := hcSimIDs(hcDocList(d.doc(t), "spaces")); got != "sp2,sp1,sp3" {
		t.Errorf("spaces %s", got)
	}
	snap, _ = s.m.Snapshot(ctx)
	if got := groupIDs(n.nest(snap, false).Groups); got != "sp2,sp1(Mmain),sp3(Lx<sp1)" {
		t.Errorf("nested view after the move: %s", got)
	}
}
