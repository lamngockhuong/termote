package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// gitIn runs git in dir for a test's setup.
func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

// tempDirReal is t.TempDir resolved (macOS's /var is a link).
func tempDirReal(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func newTestRoots() *rootResolver { return newRootResolver(newGitRunner()) }

func mustRepoInfo(t *testing.T, rr *rootResolver, dir string) gitRepoInfo {
	t.Helper()
	info, ok, err := repoInfo(context.Background(), rr, dir)
	if err != nil || !ok {
		t.Fatalf("repoInfo(%s) = %v %v", dir, ok, err)
	}
	return info
}

func TestGitWorktreeRepoInfo(t *testing.T) {
	repo := worktreeRepo(t)
	other := tempDirReal(t)
	wt := filepath.Join(other, "wt")
	gitIn(t, repo, "worktree", "add", "-q", "-b", "feat/x", wt)
	if err := os.Mkdir(filepath.Join(wt, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}

	main := mustRepoInfo(t, newTestRoots(), repo)
	if main.Linked || main.Main != repo || main.Top != repo || main.Name != filepath.Base(repo) || main.Branch != "main" ||
		main.Common != filepath.Join(repo, ".git") {
		t.Errorf("main = %+v", main)
	}
	linked := mustRepoInfo(t, newTestRoots(), filepath.Join(wt, "sub"))
	if !linked.Linked || linked.Top != wt || linked.Main != repo || linked.Common != main.Common ||
		linked.Name != filepath.Base(repo) || linked.Branch != "feat/x" {
		t.Errorf("linked = %+v", linked)
	}

	gitIn(t, wt, "checkout", "-q", "--detach")
	if d := mustRepoInfo(t, newTestRoots(), wt); d.Branch != "" || !d.Linked {
		t.Errorf("detached = %+v", d)
	}

	if _, ok, err := repoInfo(context.Background(), newTestRoots(), other); ok || err != nil {
		t.Errorf("outside a repo: %v %v", ok, err)
	}
	if _, ok, err := repoInfo(context.Background(), newTestRoots(), filepath.Join(other, "gone")); ok || err != nil {
		t.Errorf("missing folder: %v %v", ok, err)
	}

	// A linked worktree of a bare repository has no main checkout.
	bare := filepath.Join(other, "bare.git")
	gitIn(t, other, "clone", "-q", "--bare", repo, bare)
	bwt := filepath.Join(other, "bwt")
	gitIn(t, bare, "worktree", "add", "-q", bwt, "e2e-base")
	b := mustRepoInfo(t, newTestRoots(), bwt)
	if !b.Linked || b.Main != "" || b.Name != "bwt" || b.gitDir() != b.Common || b.Branch != "e2e-base" {
		t.Errorf("bare's worktree = %+v", b)
	}
}

func TestGitWorktreeParseEntries(t *testing.T) {
	// git on Windows lists C:/r: a drive letter, forward slashes.
	root := "/r"
	if runtime.GOOS == "windows" {
		root = "C:/r"
	}
	out := "worktree " + root + "\x00HEAD 1\x00branch refs/heads/main\x00\x00" +
		"worktree " + root + "/a\x00HEAD 2\x00detached\x00\x00" +
		"worktree " + root + "/b\x00HEAD 3\x00branch refs/heads/a​b\x00prunable gitdir file points to non-existent location\x00\x00" +
		"worktree rel\x00bare\x00\x00" +
		"worktree " + root + "/c\x00branch refs/heads/feat/x\x00locked\x00\x00"
	if runtime.GOOS == "windows" {
		// UNC paths are dropped, never resolved (an SMB connection).
		out += "worktree //host/share/w\x00branch refs/heads/u\x00\x00" +
			"worktree " + `\\?\C:\r\d` + "\x00branch refs/heads/d\x00\x00" +
			"worktree /r/e\x00branch refs/heads/e\x00\x00"
	}
	got := parseWorktreeEntries([]byte(out))
	r := filepath.FromSlash(root)
	want := []worktreeEntry{
		{Path: r, Branch: "main"},
		{Path: filepath.Join(r, "a"), Detached: true, Linked: true},
		{Path: filepath.Join(r, "b"), Prunable: true, Linked: true},
		{Path: filepath.Join(r, "c"), Branch: "feat/x", Locked: true, Linked: true},
	}
	if len(got) != len(want) {
		t.Fatalf("entries = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if got[0].openable() || got[1].openable() || got[2].openable() || !got[3].openable() {
		t.Errorf("openable wrong: %+v", got)
	}
}

func TestGitWorktreeListSkipsGoneAndForeign(t *testing.T) {
	repo := worktreeRepo(t)
	other := tempDirReal(t)
	wt, gone := filepath.Join(other, "wt"), filepath.Join(other, "gone")
	gitIn(t, repo, "worktree", "add", "-q", "-b", "feat/x", wt)
	gitIn(t, repo, "worktree", "add", "-q", "-b", "feat/gone", gone)
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	rr := newTestRoots()
	list, err := listWorktrees(context.Background(), rr.git, mustRepoInfo(t, rr, repo))
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Path != repo || list[0].Linked || list[1].Path != wt || !list[1].Linked ||
		list[1].Branch != "feat/x" || !list[1].openable() {
		t.Errorf("list = %+v", list)
	}
}

func TestBranchSlug(t *testing.T) {
	for in, want := range map[string]string{
		"feat/x": "feat-x", "main": "main", "a.b_c-d": "a.b_c-d", "日本/x": "x", "ü-ber": "ber", "x/日本/y": "x-y",
	} {
		if got, err := branchSlug(in); err != nil || got != want {
			t.Errorf("branchSlug(%q) = %q %v, want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"日本", "", "...", "-", "+.git", "+.GIT"} {
		if got, err := branchSlug(in); !errors.Is(err, errWorktreeName) {
			t.Errorf("branchSlug(%q) = %q %v", in, got, err)
		}
	}
	// Windows drops a trailing dot and opens a device name as the device.
	for _, in := range []string{"feat.", "con", "NUL", "com1", "aux.x/y"} {
		if got, err := branchSlugFor(in, true); !errors.Is(err, errWorktreeName) {
			t.Errorf("Windows branchSlug(%q) = %q %v", in, got, err)
		}
		if _, err := branchSlugFor(in, false); err != nil {
			t.Errorf("branchSlug(%q) off Windows: %v", in, err)
		}
	}
	if validBranchName("a..b") {
		t.Error("a..b reaches branchSlug")
	}
}

func TestWorktreeBase(t *testing.T) {
	for _, c := range []struct {
		backend, home string
		container     bool
		want          string
	}{
		{"hc", "/h", false, "/h/.herdr/worktrees"},
		{"tmux", "/h", false, "/h/.termote/worktrees"},
		{"zellij", "/h", false, "/h/.termote/worktrees"},
		{"tmux", "/h", true, "/workspace/.termote/worktrees"},
		{"hc", "", true, "/workspace/.herdr/worktrees"},
		{"tmux", "", false, ""},
	} {
		if got := worktreeBaseFor(c.backend, c.home, c.container); got != filepath.FromSlash(c.want) {
			t.Errorf("worktreeBaseFor(%q, %q, %v) = %q, want %q", c.backend, c.home, c.container, got, c.want)
		}
	}
}

func TestNewWorktreePath(t *testing.T) {
	base := filepath.Join(tempDirReal(t), "worktrees")
	got, err := newWorktreePath(base, "repo", "feat/x", nil)
	if err != nil || got != filepath.Join(base, "repo", "feat-x") {
		t.Fatalf("path = %q %v", got, err)
	}
	if err := os.MkdirAll(got, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := newWorktreePath(base, "repo", "feat/x", nil); !errors.Is(err, errWorktreeCreateFailed) {
		t.Errorf("existing target: %v", err)
	}
	for _, name := range []string{"", ".", "..", "a/b", `a\b`, "a\x01"} {
		if _, err := newWorktreePath(base, name, "y", nil); !errors.Is(err, errWorktreeCreateFailed) {
			t.Errorf("repo name %q: %v", name, err)
		}
	}
	if _, err := newWorktreePath(base, "repo", "y", []string{filepath.Join(base, "repo")}); !errors.Is(err, errWorktreeCreateFailed) {
		t.Errorf("denied target: %v", err)
	}
	// A deny dir reached through a link is refused too.
	link := filepath.Join(tempDirReal(t), "link")
	if err := os.Symlink(base, link); err != nil {
		t.Fatal(err)
	}
	if _, err := newWorktreePath(link, "repo", "y", []string{base}); !errors.Is(err, errWorktreeCreateFailed) {
		t.Errorf("denied through a link: %v", err)
	}
	if _, err := newWorktreePath("rel", "repo", "y", nil); !errors.Is(err, errWorktreeCreateFailed) {
		t.Errorf("relative base: %v", err)
	}
	if _, err := newWorktreePath(base, "repo", "日本", nil); !errors.Is(err, errWorktreeName) {
		t.Errorf("empty slug: %v", err)
	}
}

func TestGitWorktreeAddRemove(t *testing.T) {
	repo := worktreeRepo(t)
	rr := newTestRoots()
	ctx := context.Background()
	src := mustRepoInfo(t, rr, repo)
	base := filepath.Join(tempDirReal(t), "w", "repo")

	newPath := filepath.Join(base, "feat-new")
	if err := addWorktree(ctx, rr.git, src, newPath, "feat/new", "e2e-base", false); err != nil {
		t.Fatal(err)
	}
	// Windows has no Unix modes: an owner-only ACL instead.
	if fi, err := os.Stat(filepath.Dir(newPath)); err != nil || runtime.GOOS != "windows" && fi.Mode().Perm() != 0o700 {
		t.Errorf("parent folder: %v %v", fi, err)
	}
	checkOwnerOnly(t, filepath.Dir(newPath))
	nw := mustRepoInfo(t, newTestRoots(), newPath)
	if !nw.Linked || nw.Branch != "feat/new" {
		t.Errorf("new = %+v", nw)
	}
	existing := filepath.Join(base, "e2e-base")
	if err := addWorktree(ctx, rr.git, src, existing, "e2e-base", "", true); err != nil {
		t.Fatal(err)
	}
	// A branch checked out elsewhere: git refuses, the reply is coded.
	if err := addWorktree(ctx, rr.git, src, filepath.Join(base, "again"), "e2e-base", "", true); err != errWorktreeCreateFailed {
		t.Errorf("second checkout of a branch: %v", err)
	}

	ex := mustRepoInfo(t, newTestRoots(), existing)
	if dirty, err := worktreeDirty(ctx, rr.git, ex); err != nil || dirty {
		t.Fatalf("clean worktree dirty = %v %v", dirty, err)
	}
	if err := removeWorktree(ctx, rr.git, ex, existing); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(existing); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("removed worktree still there: %v", err)
	}

	if err := os.WriteFile(filepath.Join(newPath, "new.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if dirty, err := worktreeDirty(ctx, rr.git, nw); err != nil || !dirty {
		t.Fatalf("untracked file: dirty = %v %v", dirty, err)
	}
	if err := removeWorktree(ctx, rr.git, nw, newPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(newPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("forced remove left %s: %v", newPath, err)
	}

	// An initialized submodule counts as dirty.
	sub := filepath.Join(base, "sub")
	if err := addWorktree(ctx, rr.git, src, sub, "feat/sub", "", false); err != nil {
		t.Fatal(err)
	}
	si := mustRepoInfo(t, newTestRoots(), sub)
	if err := os.MkdirAll(filepath.Join(si.GitDir, "modules"), 0o700); err != nil {
		t.Fatal(err)
	}
	if dirty, err := worktreeDirty(ctx, rr.git, si); err != nil || !dirty {
		t.Errorf("submodule: dirty = %v %v", dirty, err)
	}
}

// A submodule's own config is outside what gitRunner turns off: the dirty
// check must not run its clean filter, and a gitlink counts as dirty (git
// refuses to remove a worktree holding one).
func TestGitWorktreeDirtySubmoduleFilter(t *testing.T) {
	repo := worktreeRepo(t)
	rr := newTestRoots()
	ctx := context.Background()
	src := mustRepoInfo(t, rr, repo)
	path := filepath.Join(tempDirReal(t), "w", "repo", "feat-sub")
	if err := addWorktree(ctx, rr.git, src, path, "feat/sub", "", false); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(tempDirReal(t), "ran")
	sub := filepath.Join(path, "sub")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "a.txt"), []byte("y\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, ".gitattributes"), []byte("*.txt filter=x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	user := []string{"-c", "user.name=t", "-c", "user.email=t@t"}
	gitIn(t, sub, "init", "-q")
	gitIn(t, sub, "add", ".")
	gitIn(t, sub, append(user, "commit", "-q", "-m", "s")...)
	gitIn(t, sub, "config", "filter.x.clean", "touch '"+filepath.ToSlash(marker)+"'; cat")
	gitIn(t, path, "add", "sub")
	gitIn(t, path, append(user, "commit", "-q", "-m", "gitlink")...)
	// Same size, other mtime: git has to hash the file again, through the filter.
	old := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(sub, "a.txt"), old, old); err != nil {
		t.Fatal(err)
	}

	info := mustRepoInfo(t, newTestRoots(), path)
	dirty, err := worktreeDirty(ctx, rr.git, info)
	if err != nil || !dirty {
		t.Errorf("worktree with a gitlink: dirty = %v %v", dirty, err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the submodule's clean filter ran: %v", err)
	}
}

// A filter the repository declares for its worktrees only (an includeIf on
// gitdir:worktrees/) is not listed from the main checkout: neither creating
// the worktree nor removing it may run it.
func TestGitWorktreeIncludeIfFilter(t *testing.T) {
	repo := worktreeRepo(t)
	marks := tempDirReal(t)
	user := []string{"-c", "user.name=t", "-c", "user.email=t@t"}
	if err := os.WriteFile(filepath.Join(repo, ".gitattributes"), []byte("* filter=x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repo, "add", ".gitattributes")
	gitIn(t, repo, append(user, "commit", "-q", "-m", "attributes")...)
	cfg := filepath.Join(repo, ".git", "worktree-only.cfg")
	for _, kind := range []string{"smudge", "clean"} {
		cmd := "touch '" + filepath.ToSlash(filepath.Join(marks, kind)) + "'; cat"
		gitIn(t, repo, "config", "-f", cfg, "filter.x."+kind, cmd)
	}
	gitIn(t, repo, "config", "includeIf.gitdir:worktrees/.path", cfg)
	ran := func(kind string) bool {
		_, err := os.Stat(filepath.Join(marks, kind))
		return err == nil
	}

	rr := newTestRoots()
	ctx := context.Background()
	src := mustRepoInfo(t, rr, repo)
	path := filepath.Join(tempDirReal(t), "w", "repo", "feat-x")
	if err := addWorktree(ctx, rr.git, src, path, "feat/x", "", false); err != nil {
		t.Fatal(err)
	}
	if ran("smudge") {
		t.Error("the worktree's smudge filter ran on add")
	}
	if _, err := os.Stat(filepath.Join(path, ".gitattributes")); err != nil {
		t.Errorf("files not checked out: %v", err)
	}
	info := mustRepoInfo(t, newTestRoots(), path)
	if dirty, err := worktreeDirty(ctx, rr.git, info); err != nil || dirty {
		t.Fatalf("fresh worktree dirty = %v %v", dirty, err)
	}
	// Same size, other mtime: a status would hash the file again, through the filter.
	old := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(path, ".gitattributes"), old, old); err != nil {
		t.Fatal(err)
	}
	if err := removeWorktree(ctx, rr.git, info, path); err != nil {
		t.Fatal(err)
	}
	if ran("clean") {
		t.Error("the worktree's clean filter ran on remove")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("worktree still there: %v", err)
	}
}

// A config include naming a file the new worktree's branch checks out
// defines its filter only once the checkout wrote that file: a filters-off
// status right after the create must read the list afresh, not the one
// cached while the worktree was still empty.
func TestGitWorktreeIncludedFilterAfterCheckout(t *testing.T) {
	repo := worktreeRepo(t)
	mark := filepath.Join(tempDirReal(t), "clean")
	path := filepath.Join(tempDirReal(t), "w", "repo", "feat-x")
	user := []string{"-c", "user.name=t", "-c", "user.email=t@t"}
	gitIn(t, repo, "checkout", "-q", "-b", "feat/x")
	for name, body := range map[string]string{".gitattributes": "*.txt filter=x\n", "a.txt": "hello\n"} {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	gitIn(t, repo, "config", "-f", filepath.Join(repo, "x.cfg"), "filter.x.clean",
		"touch '"+filepath.ToSlash(mark)+"'; cat")
	gitIn(t, repo, "add", ".gitattributes", "a.txt", "x.cfg")
	gitIn(t, repo, append(user, "commit", "-q", "-m", "included filter")...)
	gitIn(t, repo, "checkout", "-q", "main")
	gitIn(t, repo, "config", "include.path", filepath.Join(path, "x.cfg"))

	rr := newTestRoots()
	ctx := context.Background()
	src := mustRepoInfo(t, rr, repo)
	if err := addWorktree(ctx, rr.git, src, path, "feat/x", "", true); err != nil {
		t.Fatal(err)
	}
	c := gitCall{root: path, safeDir: src.SafeDir, noFilters: true}
	if _, _, err := rr.git.output(ctx, c, "status", "--porcelain"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(mark); err == nil {
		t.Error("the included clean filter ran on the first status after the create")
	}
}
