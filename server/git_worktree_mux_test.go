package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// gitWorktreeFake is a backend whose groups each have one pane in a folder;
// NewGroup and CloseGroup add and remove them.
type gitWorktreeFake struct {
	*fakeMux
	mu     sync.Mutex
	groups []Group
	next   int
	newErr error
	calls  []string
}

func (f *gitWorktreeFake) Caps() Caps { return Caps{Groups: true, Worktrees: true} }

func (f *gitWorktreeFake) Snapshot(context.Context) (Snapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return Snapshot{Groups: slices.Clone(f.groups)}, nil
}

func (f *gitWorktreeFake) add(id, dir string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.groups = append(f.groups, groupIn(id, dir))
}

func (f *gitWorktreeFake) NewGroup(_ context.Context, name, cwd string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "new "+name+" in "+cwd)
	if f.newErr != nil {
		return "", f.newErr
	}
	f.next++
	id := fmt.Sprintf("$%d", f.next)
	f.groups = append(f.groups, groupIn(id, cwd))
	return id, nil
}

func (f *gitWorktreeFake) CloseGroup(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "close "+id)
	f.groups = slices.DeleteFunc(f.groups, func(g Group) bool { return g.ID == id })
	return nil
}

func (f *gitWorktreeFake) took() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.calls
	f.calls = nil
	return c
}

type gitWorktreeFixture struct {
	f     *gitWorktreeFake
	gm    *gitWorktreeMux
	h     *http.ServeMux
	repo  string
	base  string // <worktree base>/<repo name>
	outer string // a folder outside git
}

func newGitWorktreeFixture(t *testing.T, named bool) *gitWorktreeFixture {
	t.Helper()
	repo := worktreeRepo(t)
	outer := tempDirReal(t)
	base := filepath.Join(tempDirReal(t), "worktrees")
	f := &gitWorktreeFake{fakeMux: &fakeMux{}}
	f.add("$main", repo)
	f.add("$plain", outer)
	rr := newTestRoots()
	gm := &gitWorktreeMux{m: f, git: rr.git, roots: rr, nest: newGitNester(rr), base: base, validName: nameCheck(named),
		deny: []string{filepath.Join(base, "denied")}}
	h := http.NewServeMux()
	registerWorktreeRoutes(h, f, gm, rr.git, hostAllowlist{})
	return &gitWorktreeFixture{f: f, gm: gm, h: h, repo: repo, base: filepath.Join(base, filepath.Base(repo)), outer: outer}
}

func (x *gitWorktreeFixture) do(t *testing.T, method, path, body string) (int, string, map[string]any) {
	t.Helper()
	rec := serve(x.h, apiRequest(method, path, body))
	var m map[string]any
	if rec.Code == 200 {
		m = decodeBody(t, rec)
	}
	code := ""
	if rec.Code != 200 {
		code = codeOf(t, rec)
	}
	return rec.Code, code, m
}

func TestGitWorktreeMuxCreateOpenRemove(t *testing.T) {
	x := newGitWorktreeFixture(t, true)

	// A new branch, from HEAD and from a base, with and without a label.
	status, code, body := x.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"feat/new"}`)
	newPath := filepath.Join(x.base, "feat-new")
	if status != 200 || body["id"] != "$1" || !slices.Equal(x.f.took(), []string{"new feat-new in " + newPath}) {
		t.Fatalf("create = %d %s %v", status, code, body)
	}
	if info := mustRepoInfo(t, newTestRoots(), newPath); !info.Linked || info.Branch != "feat/new" {
		t.Errorf("new checkout %+v", info)
	}
	status, code, _ = x.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"feat.two","base":"e2e-base","label":"Two"}`)
	if calls := x.f.took(); status != 200 || !slices.Equal(calls, []string{"new Two in " + filepath.Join(x.base, "feat.two")}) {
		t.Errorf("create with base and label = %d %s %q", status, code, calls)
	}
	// An existing branch is checked out as it is; a base for it is refused.
	status, code, _ = x.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"e2e-base"}`)
	if calls := x.f.took(); status != 200 || !slices.Equal(calls, []string{"new e2e-base in " + filepath.Join(x.base, "e2e-base")}) {
		t.Errorf("existing branch = %d %s %q", status, code, calls)
	}
	if _, code, _ = x.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"main","base":"e2e-base"}`); code != "branch_exists" {
		t.Errorf("base for an existing branch: %s", code)
	}

	for _, c := range []struct{ body, code string }{
		{`{"groupId":"$1","branch":"feat/y"}`, "linked_source"},
		{`{"groupId":"$plain","branch":"feat/y"}`, "not_git"},
		{`{"groupId":"$nope","branch":"feat/y"}`, "unknown_group"},
		{`{"groupId":"$main","branch":"日本"}`, "invalid_name"},
		{`{"groupId":"$main","branch":"feat/new"}`, "create_failed"}, // checked out already
	} {
		if _, code, _ := x.do(t, "POST", "/api/mux/worktrees", c.body); code != c.code {
			t.Errorf("create %s: %s, want %s", c.body, code, c.code)
		}
	}
	if calls := x.f.took(); len(calls) != 0 {
		t.Errorf("a refused create opened a group: %q", calls)
	}

	// A name clash on the group keeps the checkout; Open worktree recovers it.
	x.f.newErr = errGroupExists
	if _, code, _ = x.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"clash"}`); code != "open_failed" {
		t.Errorf("name clash: %s", code)
	}
	x.f.newErr = nil
	clash := filepath.Join(x.base, "clash")
	if _, err := os.Stat(clash); err != nil {
		t.Errorf("checkout gone after a failed open: %v", err)
	}
	x.f.took()

	status, _, body = x.do(t, "GET", "/api/mux/worktrees?groupId=$main", "")
	if status != 200 || body["repoName"] != filepath.Base(x.repo) {
		t.Fatalf("list = %d %v", status, body)
	}
	byBranch := map[string]map[string]any{}
	for _, w := range body["worktrees"].([]any) {
		byBranch[w.(map[string]any)["branch"].(string)] = w.(map[string]any)
	}
	if m := byBranch["main"]; m == nil || m["linked"] != false || m["groupId"] != "$main" || m["path"] != x.repo {
		t.Errorf("main %v", m)
	}
	if w := byBranch["feat/new"]; w == nil || w["linked"] != true || w["openable"] != true || w["groupId"] != "$1" || w["path"] != newPath {
		t.Errorf("feat/new %v", w)
	}
	if w := byBranch["clash"]; w == nil || w["groupId"] != nil {
		t.Errorf("clash %v", w)
	}
	if b := body["branches"].([]any); !slices.Contains(b, any("clash")) {
		t.Errorf("branches %v", b)
	}

	status, _, body = x.do(t, "POST", "/api/mux/worktrees/open", `{"groupId":"$main","branch":"feat/new"}`)
	if status != 200 || body["id"] != "$1" || body["alreadyOpen"] != true || len(x.f.took()) != 0 {
		t.Errorf("open an open one = %d %v", status, body)
	}
	status, _, body = x.do(t, "POST", "/api/mux/worktrees/open", `{"groupId":"$main","branch":"clash"}`)
	if calls := x.f.took(); status != 200 || body["alreadyOpen"] != false || !slices.Equal(calls, []string{"new clash in " + clash}) {
		t.Errorf("open = %d %v %q", status, body, calls)
	}
	for _, c := range []struct{ body, code string }{
		{`{"groupId":"$main","branch":"nope"}`, "not_found"},
		{`{"groupId":"$main","branch":"main"}`, "not_found"}, // the main checkout
		{`{"groupId":"$1","branch":"clash"}`, "linked_source"},
	} {
		if _, code, _ := x.do(t, "POST", "/api/mux/worktrees/open", c.body); code != c.code {
			t.Errorf("open %s: %s, want %s", c.body, code, c.code)
		}
	}

	// The nester lists the linked worktrees' groups under the main one.
	snap, _ := x.f.Snapshot(context.Background())
	nested := nestedSoon(t, x.gm.nest, snap, "$main(Mmain),$1(Lfeat/new<$main),$2(Lfeat.two<$main),$3(Le2e-base<$main),$4(Lclash<$main),$plain")
	if nested.Groups[1].Worktree.Parent != "$main" {
		t.Errorf("nested %+v", nested.Groups)
	}

	// Remove: dirty without force changes nothing, then force; a clean one.
	if err := os.WriteFile(filepath.Join(newPath, "x.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	remove := func(id, path, branch string, force bool) (int, string) {
		status, code, _ := x.do(t, "DELETE", "/api/mux/worktrees/"+id, fmt.Sprintf(`{"force":%v,"path":%q,"branch":%q}`, force, path, branch))
		return status, code
	}
	if _, code := remove("$1", newPath, "feat/new", false); code != "dirty" || len(x.f.took()) != 0 {
		t.Errorf("dirty remove: %s", code)
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("dirty remove deleted the checkout: %v", err)
	}
	if _, code := remove("$1", newPath, "feat/other", true); code != "changed" {
		t.Errorf("changed branch: %s", code)
	}
	if _, code := remove("$1", filepath.Join(x.base, "elsewhere"), "feat/new", true); code != "changed" {
		t.Errorf("changed path: %s", code)
	}
	if _, code := remove("$main", x.repo, "main", true); code != "not_linked" {
		t.Errorf("main checkout: %s", code)
	}
	if calls := x.f.took(); len(calls) != 0 {
		t.Errorf("a refused remove closed a group: %q", calls)
	}
	if status, code := remove("$1", newPath, "feat/new", true); status != 200 || !slices.Equal(x.f.took(), []string{"close $1"}) {
		t.Errorf("forced remove = %d %s", status, code)
	}
	if _, err := os.Stat(newPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("forced remove left the checkout: %v", err)
	}
	two := filepath.Join(x.base, "feat.two")
	if status, code := remove("$2", two, "feat.two", false); status != 200 || !slices.Equal(x.f.took(), []string{"close $2"}) {
		t.Errorf("clean remove = %d %s", status, code)
	}
	if _, err := os.Stat(two); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("clean remove left the checkout: %v", err)
	}
	if _, code := remove("$gone", two, "feat.two", false); code != "unknown_group" {
		t.Errorf("unknown group: %s", code)
	}
}

func TestGitWorktreeMuxNamesAndRefusals(t *testing.T) {
	// hc names a space after its folder: no name is passed.
	x := newGitWorktreeFixture(t, false)
	if status, code, _ := x.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"feat/x","label":"L"}`); status != 200 {
		t.Fatalf("create = %d %s", status, code)
	}
	if calls := x.f.took(); !slices.Equal(calls, []string{"new  in " + filepath.Join(x.base, "feat-x")}) {
		t.Errorf("hc calls %q", calls)
	}
	// A target under a deny dir is refused before git runs.
	x.gm.base = filepath.Join(filepath.Dir(x.base), "denied")
	if _, code, _ := x.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"feat/d"}`); code != "create_failed" {
		t.Errorf("denied target: %s", code)
	}

	named := &gitWorktreeMux{validName: validTmuxGroupName}
	long := strings.Repeat("a", 70)
	for _, c := range []struct{ label, branch, want string }{
		{"", "feat.x", "feat-x"}, {"Mine", "feat.x", "Mine"}, {"", long, long[:64]},
		{"", strings.Repeat("a", 63) + "-b", strings.Repeat("a", 63)}, {"", "#.x", "x"}, {"", "=x", "x"},
	} {
		if got, err := named.groupName(c.label, c.branch); err != nil || got != c.want || !validTmuxGroupName(got) {
			t.Errorf("groupName(%q, %q) = %q %v", c.label, c.branch, got, err)
		}
	}
	for _, label := range []string{"a.b", "a:b", "-x"} {
		if got, err := named.groupName(label, "feat/x"); err != errWorktreeName {
			t.Errorf("label %q: %q %v", label, got, err)
		}
	}
	if got, err := (&gitWorktreeMux{}).groupName("L", "feat/x"); got != "" || err != nil {
		t.Errorf("hc name %q %v", got, err)
	}

	// A label tmux refuses is invalid_name before any checkout is made.
	y := newGitWorktreeFixture(t, true)
	if _, code, _ := y.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"feat/l","label":"a.b"}`); code != "invalid_name" {
		t.Errorf("label tmux refuses: %s", code)
	}
	if _, err := os.Stat(filepath.Join(y.base, "feat-l")); !errors.Is(err, os.ErrNotExist) || len(y.f.took()) != 0 {
		t.Errorf("a refused label made something: %v", err)
	}
	for id, want := range map[string]bool{"$1": true, "sp1": true, "": false, "a\x01": false, strings.Repeat("a", 129): false, "\xff": false} {
		if named.ValidGroupID(id) != want {
			t.Errorf("ValidGroupID(%q) = %v", id, !want)
		}
	}
}

func TestGitWorktreeBackend(t *testing.T) {
	if !gitWorktreeBackend(&zellijMux{}) || gitWorktreeBackend(&herdrMux{}) || gitWorktreeBackend(&fakeMux{}) {
		t.Error("backends")
	}
	orig := tmuxIsPsmux
	defer func() { tmuxIsPsmux = orig }()
	for _, psmux := range []bool{false, true} {
		tmuxIsPsmux = psmux
		if !gitWorktreeBackend(tmuxMux{}) || !gitWorktreeBackend(&hcMux{}) || !(tmuxMux{}).Caps().Worktrees {
			t.Errorf("psmux=%v: no worktrees", psmux)
		}
	}
	f := &filesAPI{}
	if worktreeMuxFor(&fakeMux{}, f, nil) != nil {
		t.Error("a backend without worktrees got one")
	}
	if _, ok := worktreeMuxFor(newWorktreeFake("/r"), f, nil).(*worktreeFake); !ok {
		t.Error("a backend's own implementation must be kept")
	}
}

// worktreeRoundTrip drives gitWorktreeMux on a real backend: a group in a
// throwaway repository, a new worktree opened as a group, nested under it
// once the lookup lands, then removed with its checkout.
func worktreeRoundTrip(t *testing.T, m Mux, repo string, named bool, wait func(what string, cond func() bool)) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	srcName := ""
	if named {
		srcName = "wt-src"
	}
	src, err := m.NewGroup(ctx, srcName, repo)
	if err != nil {
		t.Fatalf("NewGroup: %v", err)
	}
	rr := newTestRoots()
	gm := &gitWorktreeMux{m: m, git: rr.git, roots: rr, nest: newGitNester(rr), base: filepath.Join(tempDirReal(t), "wt"), validName: nameCheck(named)}
	wait("the source group's folder", func() bool {
		snap, err := peekSnapshot(ctx, m)
		i := groupIndex(snap.Groups, src)
		return err == nil && i >= 0 && groupFolder(snap.Groups[i]) == repo
	})
	id, err := gm.CreateWorktree(ctx, src, "feat/rt", "", "")
	if err != nil {
		t.Fatalf("CreateWorktree: %v", err)
	}
	path := filepath.Join(gm.base, filepath.Base(repo), "feat-rt")
	if info := mustRepoInfo(t, newTestRoots(), path); !info.Linked || info.Branch != "feat/rt" {
		t.Fatalf("checkout %+v", info)
	}
	var nested Snapshot
	wait("the worktree's group nested under its repository's", func() bool {
		snap, err := peekSnapshot(ctx, m)
		if err != nil {
			return false
		}
		nested = gm.nest.nest(snap, true)
		i, j := groupIndex(nested.Groups, id), groupIndex(nested.Groups, src)
		if i < 0 || j < 0 || i != j+1 {
			return false
		}
		w := nested.Groups[i].Worktree
		return w != nil && w.Linked && w.Parent == src && w.Branch == "feat/rt"
	})
	list, err := gm.ListWorktrees(ctx, src)
	if err != nil || len(list.Worktrees) != 2 || list.Worktrees[1].GroupID != id || list.Worktrees[0].GroupID != src {
		t.Fatalf("list %+v %v", list, err)
	}
	if err := gm.RemoveWorktree(ctx, id, false); err != nil {
		t.Fatalf("RemoveWorktree: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("checkout left after remove: %v", err)
	}
	wait("the worktree's group closed", func() bool {
		snap, err := peekSnapshot(ctx, m)
		return err == nil && groupIndex(snap.Groups, id) < 0
	})
}

// nameCheck is the group-name check of a backend that takes names (tmux's),
// or none (hc).
func nameCheck(named bool) func(string) bool {
	if named {
		return validTmuxGroupName
	}
	return nil
}

// Every group working in a linked worktree is closed before its checkout
// goes, from whichever of them the remove names; a locked one is refused
// before anything closes.
func TestGitWorktreeMuxRemoveClosesEveryGroup(t *testing.T) {
	x := newGitWorktreeFixture(t, true)
	if status, code, _ := x.do(t, "POST", "/api/mux/worktrees", `{"groupId":"$main","branch":"feat/two"}`); status != 200 {
		t.Fatalf("create = %d %s", status, code)
	}
	path := filepath.Join(x.base, "feat-two")
	sub := filepath.Join(path, "sub")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	x.f.add("$other", sub)
	x.f.took()

	gitIn(t, x.repo, "worktree", "lock", path)
	body := fmt.Sprintf(`{"force":true,"path":%q,"branch":"feat/two"}`, path)
	if status, _, _ := x.do(t, "DELETE", "/api/mux/worktrees/$other", body); status != 500 || len(x.f.took()) != 0 {
		t.Errorf("locked worktree: %d", status)
	}
	gitIn(t, x.repo, "worktree", "unlock", path)

	if status, code, _ := x.do(t, "DELETE", "/api/mux/worktrees/$other", body); status != 200 {
		t.Fatalf("remove from the second group = %d %s", status, code)
	}
	if calls := x.f.took(); !slices.Equal(calls, []string{"close $other", "close $1"}) {
		t.Errorf("calls %q", calls)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("checkout left: %v", err)
	}
}
