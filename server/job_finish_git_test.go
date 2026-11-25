package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// finishRepo is a repository with a bare origin and a linked worktree on
// branch feat, its home the temp dir above them.
type finishRepo struct {
	home, origin, main, wt string
}

// gitOut runs git in dir and answers its trimmed output.
func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func newFinishRepo(t *testing.T) finishRepo {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := tempDirReal(t)
	r := finishRepo{home: filepath.Join(root, "home"), origin: filepath.Join(root, "origin.git")}
	r.main = filepath.Join(r.home, "repo")
	r.wt = filepath.Join(r.home, "wt", "feat")
	for _, d := range []string{r.main, r.origin} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	gitIn(t, r.origin, "init", "-q", "--bare", "-b", "main")
	gitIn(t, r.main, "init", "-q", "-b", "main")
	gitIn(t, r.main, "config", "user.name", "t")
	gitIn(t, r.main, "config", "user.email", "t@t")
	if err := os.WriteFile(filepath.Join(r.main, ".gitignore"), []byte(".env*\nnode_modules/\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitIn(t, r.main, "add", ".gitignore")
	gitIn(t, r.main, "commit", "-q", "-m", "one")
	gitIn(t, r.main, "remote", "add", "origin", r.origin)
	gitIn(t, r.main, "push", "-q", "origin", "main")
	gitIn(t, r.main, "worktree", "add", "-q", "-b", "feat", r.wt)
	r.commit(t, "two")
	return r
}

// commit makes a commit in the worktree.
func (r finishRepo) commit(t *testing.T, msg string) string {
	t.Helper()
	gitIn(t, r.wt, "commit", "-q", "--allow-empty", "-m", msg)
	return gitOut(t, r.wt, "rev-parse", "HEAD")
}

func (r finishRepo) tree() jobTree { return jobTree{Branch: "feat", Dir: r.wt, Made: true} }

func (r finishRepo) read(t *testing.T) (finishTree, error) {
	t.Helper()
	rr := newTestRoots()
	return readFinishTree(context.Background(), rr.git, rr, r.home, r.tree())
}

func (r finishRepo) mustRead(t *testing.T) finishTree {
	t.Helper()
	f, err := r.read(t)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func mergedCI(head string) *jobCI {
	return &jobCI{PRs: []jobPR{{Number: 1, State: prMerged, Head: head[:12]}}}
}

func TestFinishTreePushed(t *testing.T) {
	r := newFinishRepo(t)
	gitIn(t, r.wt, "push", "-q", "-u", "origin", "feat")
	f := r.mustRead(t)
	if f.dirty || !f.onPush || f.pushRef != "refs/remotes/origin/feat" || !f.safe(nil) || f.envFiles {
		t.Fatalf("pushed: %+v", f)
	}
	if f.head != gitOut(t, r.wt, "rev-parse", "HEAD") {
		t.Errorf("head = %s", f.head)
	}

	// A commit after the push is not safe without a merged pull request.
	r.commit(t, "three")
	if f := r.mustRead(t); f.onPush || f.safe(nil) {
		t.Errorf("commit after push: %+v", f)
	}
}

func TestFinishTreeNeverPushed(t *testing.T) {
	r := newFinishRepo(t)
	f := r.mustRead(t)
	if f.pushRef != "" || f.onPush || f.safe(nil) {
		t.Errorf("never pushed: %+v", f)
	}
}

// A branch with no commit of its own, never pushed: HEAD is already on the
// remote's default branch, so nothing is lost with the checkout.
func TestFinishTreeNoCommitsNeverPushed(t *testing.T) {
	r := newFinishRepo(t)
	gitIn(t, r.wt, "reset", "-q", "--hard", "main")
	f := r.mustRead(t)
	if f.pushRef != "" || f.onPush || !f.onRemote || !f.safe(nil) {
		t.Errorf("no commits, never pushed: %+v", f)
	}

	// Through the remote's HEAD as well, whatever its default branch is named.
	gitIn(t, r.origin, "symbolic-ref", "HEAD", "refs/heads/trunk")
	gitIn(t, r.main, "push", "-q", "origin", "main:trunk", ":main")
	gitIn(t, r.main, "fetch", "-q", "--prune", "origin")
	gitIn(t, r.main, "remote", "set-head", "origin", "--auto")
	if f := r.mustRead(t); !f.onRemote || !f.safe(nil) {
		t.Errorf("on origin/HEAD -> origin/trunk: %+v", f)
	}
}

// HEAD on another remote branch than the default one counts too.
func TestFinishTreeOnOtherRemoteBranch(t *testing.T) {
	r := newFinishRepo(t)
	gitIn(t, r.wt, "push", "-q", "origin", "HEAD:refs/heads/other")
	f := r.mustRead(t)
	if f.pushRef != "" || !f.onRemote || !f.safe(nil) {
		t.Errorf("on origin/other: %+v", f)
	}
}

// Commits of its own on top of the remote's branch, never pushed, stay
// refused: on no remote ref, and a branch that only local main holds is not
// on the remote either.
func TestFinishTreeOwnCommitsNeverPushed(t *testing.T) {
	r := newFinishRepo(t)
	if f := r.mustRead(t); f.onRemote || f.safe(nil) {
		t.Errorf("own commit, never pushed: %+v", f)
	}
	gitIn(t, r.main, "commit", "-q", "--allow-empty", "-m", "local only")
	gitIn(t, r.wt, "reset", "-q", "--hard", "main")
	if f := r.mustRead(t); f.onRemote || f.safe(nil) {
		t.Errorf("on local main only: %+v", f)
	}
	// Another remote's ref does not count for the push remote.
	other := filepath.Join(filepath.Dir(r.origin), "other.git")
	if err := os.MkdirAll(other, 0o700); err != nil {
		t.Fatal(err)
	}
	gitIn(t, other, "init", "-q", "--bare")
	gitIn(t, r.main, "remote", "add", "zzz", other)
	gitIn(t, r.main, "push", "-q", "zzz", "main")
	if f := r.mustRead(t); f.onRemote || f.safe(nil) {
		t.Errorf("only on a remote that is not the push remote: %+v", f)
	}
}

// The remote branch deleted once its pull request merged, and pruned here:
// the merged pull request at HEAD is what makes it safe.
func TestFinishTreePrunedMerged(t *testing.T) {
	r := newFinishRepo(t)
	gitIn(t, r.wt, "push", "-q", "-u", "origin", "feat")
	gitIn(t, r.origin, "branch", "-D", "feat")
	gitIn(t, r.main, "fetch", "-q", "--prune", "origin")
	f := r.mustRead(t)
	if f.pushRef != "" || f.onPush || f.safe(nil) {
		t.Errorf("pruned: %+v", f)
	}
	if !f.safe(mergedCI(f.head)) {
		t.Errorf("pruned with a merged pull request at HEAD is not safe: %+v", f)
	}
}

func TestFinishTreePushRemote(t *testing.T) {
	r := newFinishRepo(t)
	fork := filepath.Join(filepath.Dir(r.origin), "fork.git")
	if err := os.MkdirAll(fork, 0o700); err != nil {
		t.Fatal(err)
	}
	gitIn(t, fork, "init", "-q", "--bare")
	gitIn(t, r.main, "remote", "add", "fork", fork)
	gitIn(t, r.main, "config", "branch.feat.pushRemote", "fork")
	gitIn(t, r.wt, "push", "-q", "fork", "feat")
	if f := r.mustRead(t); f.pushRef != "refs/remotes/fork/feat" || !f.onPush {
		t.Errorf("pushRemote: %+v", f)
	}
}

func TestFinishTreeDirty(t *testing.T) {
	cases := map[string]func(t *testing.T, r finishRepo){
		"untracked": func(t *testing.T, r finishRepo) {
			os.WriteFile(filepath.Join(r.wt, "new.txt"), []byte("x"), 0o600)
		},
		"modified": func(t *testing.T, r finishRepo) {
			os.WriteFile(filepath.Join(r.wt, ".gitignore"), []byte("x\n"), 0o600)
		},
		"submodule": func(t *testing.T, r finishRepo) {
			gd := gitOut(t, r.wt, "rev-parse", "--absolute-git-dir")
			os.MkdirAll(filepath.Join(gd, "modules"), 0o700)
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			r := newFinishRepo(t)
			gitIn(t, r.wt, "push", "-q", "-u", "origin", "feat")
			setup(t, r)
			if f := r.mustRead(t); !f.dirty || f.safe(mergedCI(f.head)) {
				t.Errorf("%s: %+v", name, f)
			}
		})
	}
}

func TestFinishTreeIgnoredFiles(t *testing.T) {
	r := newFinishRepo(t)
	os.MkdirAll(filepath.Join(r.wt, "node_modules", "x"), 0o700)
	os.WriteFile(filepath.Join(r.wt, "node_modules", "x", "index.js"), []byte("x"), 0o600)
	if f := r.mustRead(t); f.dirty || f.envFiles {
		t.Errorf("node_modules only: %+v", f)
	}
	os.WriteFile(filepath.Join(r.wt, ".env.local"), []byte("SECRET=1"), 0o600)
	if f := r.mustRead(t); f.dirty || !f.envFiles {
		t.Errorf(".env.local: %+v", f)
	}
	os.Remove(filepath.Join(r.wt, ".env.local"))
	os.MkdirAll(filepath.Join(r.wt, "app"), 0o700)
	os.WriteFile(filepath.Join(r.wt, "app", ".env"), []byte("SECRET=1"), 0o600)
	if f := r.mustRead(t); !f.envFiles {
		t.Errorf("app/.env: %+v", f)
	}
}

func TestFinishTreeRefused(t *testing.T) {
	r := newFinishRepo(t)
	rr := newTestRoots()
	ctx := context.Background()
	read := func(tree jobTree) error {
		_, err := readFinishTree(ctx, rr.git, rr, r.home, tree)
		return err
	}
	if err := read(jobTree{Branch: "main", Dir: r.main}); err != errWorktreeNotLinked {
		t.Errorf("main checkout: %v", err)
	}
	if err := read(jobTree{Branch: "feat", Dir: r.home}); err != errWorktreeNotLinked {
		t.Errorf("home: %v", err)
	}
	if err := read(jobTree{Branch: "feat", Dir: filepath.Join(r.home, "gone")}); err != errWorktreeNotFound {
		t.Errorf("gone: %v", err)
	}
	if err := read(jobTree{Branch: "other", Dir: r.wt}); err != errWorktreeChanged {
		t.Errorf("other branch: %v", err)
	}
	if err := read(jobTree{Branch: "feat", Dir: filepath.Join(r.wt, "sub")}); err != errWorktreeNotFound {
		t.Errorf("missing subdir: %v", err)
	}
	os.MkdirAll(filepath.Join(r.wt, "sub"), 0o700)
	if err := read(jobTree{Branch: "feat", Dir: filepath.Join(r.wt, "sub")}); err != errWorktreeChanged {
		t.Errorf("a folder inside: %v", err)
	}
	gitIn(t, r.wt, "checkout", "-q", "--detach")
	if err := read(r.tree()); err != errWorktreeChanged {
		t.Errorf("detached: %v", err)
	}
	notRepo := filepath.Join(r.home, "plain")
	os.MkdirAll(notRepo, 0o700)
	if err := read(jobTree{Branch: "feat", Dir: notRepo}); err != errWorktreeNotLinked {
		t.Errorf("no repository: %v", err)
	}
}

// A git that fails every call (a missing binary) is an error, never a
// verdict on the worktree.
func TestFinishTreeGitFails(t *testing.T) {
	r := newFinishRepo(t)
	gitIn(t, r.wt, "push", "-q", "-u", "origin", "feat")
	rr := newTestRoots()
	ctx := context.Background()
	info := mustRepoInfo(t, rr, r.wt)
	broken := newGitRunner()
	broken.bin = filepath.Join(r.home, "no-git")
	rr.git = broken
	if _, err := readFinishTree(ctx, broken, rr, r.home, r.tree()); err == nil {
		t.Error("a failing git read a tree")
	}
	if _, err := refIfExists(ctx, broken, gitCall{root: r.wt}, "refs/heads/feat"); err == nil {
		t.Error("refIfExists with a failing git")
	}
	if kept := deleteMergedBranch(ctx, broken, info, "feat", "x"); kept != branchDeleteFailed {
		t.Errorf("delete with a failing git: %q", kept)
	}
	if err := removeUnopenedWorktree(ctx, broken, info, r.wt); err == nil {
		t.Error("remove with a failing git")
	}
}

func TestMergedPRAt(t *testing.T) {
	head := "0123456789abcdef0123456789abcdef01234567"
	cases := []struct {
		name string
		pr   jobPR
		want bool
	}{
		{"merged at head", jobPR{State: prMerged, Head: "0123456789AB"}, true},
		{"foreign", jobPR{State: prMerged, Head: "0123456789ab", Foreign: true}, false},
		{"other head", jobPR{State: prMerged, Head: "ffffffffffff"}, false},
		{"open at head", jobPR{State: prOpen, Head: "0123456789ab"}, false},
		{"no head", jobPR{State: prMerged}, false},
	}
	for _, c := range cases {
		if _, ok := mergedPRAt(&jobCI{PRs: []jobPR{c.pr}}, head); ok != c.want {
			t.Errorf("%s: %v", c.name, ok)
		}
	}
	if _, ok := mergedPRAt(nil, head); ok {
		t.Error("nil ci")
	}
	if _, ok := mergedPRAt(&jobCI{PRs: []jobPR{{State: prMerged, Head: "0123456789ab"}}}, ""); ok {
		t.Error("no head")
	}
}

func TestDeleteMergedBranch(t *testing.T) {
	r := newFinishRepo(t)
	rr := newTestRoots()
	ctx := context.Background()
	info := mustRepoInfo(t, rr, r.wt)
	sha := gitOut(t, r.wt, "rev-parse", "HEAD")

	// Checked out in the worktree still.
	if kept := deleteMergedBranch(ctx, rr.git, info, "feat", sha); kept != branchCheckedOut {
		t.Errorf("checked out: %q", kept)
	}
	if err := removeWorktree(ctx, rr.git, info, r.wt); err != nil {
		t.Fatal(err)
	}
	// Another SHA than the branch's: kept.
	old := gitOut(t, r.main, "rev-parse", "main")
	if kept := deleteMergedBranch(ctx, rr.git, info, "feat", old); kept != branchMoved {
		t.Errorf("moved: %q", kept)
	}
	if kept := deleteMergedBranch(ctx, rr.git, info, "feat", sha); kept != "" {
		t.Errorf("delete: %q", kept)
	}
	if out, err := exec.Command("git", "-C", r.main, "show-ref", "--verify", "--quiet", "refs/heads/feat").CombinedOutput(); err == nil {
		t.Errorf("branch still there: %s", out)
	}
	// Gone already: nothing moved it, the delete failed.
	if kept := deleteMergedBranch(ctx, rr.git, info, "feat", sha); kept != branchDeleteFailed {
		t.Errorf("gone: %q", kept)
	}
}

func TestRemoveUnopenedWorktree(t *testing.T) {
	r := newFinishRepo(t)
	rr := newTestRoots()
	ctx := context.Background()
	info := mustRepoInfo(t, rr, r.wt)

	if err := removeUnopenedWorktree(ctx, rr.git, info, filepath.Join(r.home, "elsewhere")); err != errWorktreeChanged {
		t.Errorf("other path: %v", err)
	}
	if err := removeUnopenedWorktree(ctx, rr.git, info, r.main); err != errWorktreeChanged {
		t.Errorf("main checkout: %v", err)
	}
	gitIn(t, r.main, "worktree", "lock", r.wt)
	if err := removeUnopenedWorktree(ctx, rr.git, info, r.wt); err == nil || errors.Is(err, errWorktreeChanged) {
		t.Errorf("locked: %v", err)
	}
	gitIn(t, r.main, "worktree", "unlock", r.wt)
	if err := removeUnopenedWorktree(ctx, rr.git, info, r.wt); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(r.wt); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("worktree still there: %v", err)
	}
}

// A checkout git made with core.autocrlf=true (Git for Windows' system
// config, which gitRunner never reads) has CRLF files whose sizes the index
// records; once a file's time changes, or its entry is racy, git compares
// its content. On Windows such a file is no change unless the repository's
// own config says otherwise; any other change still is.
func TestWorktreeDirtyWindowsLineEndings(t *testing.T) {
	r := newFinishRepo(t)
	ctx := context.Background()
	wt := filepath.Join(r.home, "wt", "crlf")
	gitIn(t, r.main, "-c", "core.autocrlf=true", "worktree", "add", "-q", "-b", "crlf", wt)
	file := filepath.Join(wt, ".gitignore")
	if b, _ := os.ReadFile(file); !strings.Contains(string(b), "\r\n") {
		t.Skipf("git wrote no CRLF: %q", b)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(file, later, later); err != nil {
		t.Fatal(err)
	}
	info := mustRepoInfo(t, newTestRoots(), wt)
	win, plain := newGitRunner(), newGitRunner()
	win.windows, plain.windows = true, false
	dirty := func(g *gitRunner) bool {
		t.Helper()
		d, err := worktreeDirty(ctx, g, info)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	if !dirty(plain) {
		t.Error("the CRLF checkout read as clean without core.autocrlf (the test proves nothing)")
	}
	if dirty(win) {
		t.Error("a CRLF checkout reads dirty on Windows")
	}
	gitIn(t, r.main, "config", "core.autocrlf", "false")
	if !dirty(win) {
		t.Error("the repository's own core.autocrlf=false was not followed")
	}
	gitIn(t, r.main, "config", "--unset", "core.autocrlf")
	if err := os.WriteFile(file, []byte("other\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !dirty(win) {
		t.Error("a real change read as clean on Windows")
	}
}

func TestRemoteOfRef(t *testing.T) {
	remotes := []string{"origin", "origin/fork", "up"}
	for ref, want := range map[string]string{
		"refs/remotes/origin/main":      "origin",
		"refs/remotes/origin/HEAD":      "origin",
		"refs/remotes/origin/fork/main": "origin/fork",
		"refs/remotes/up/main":          "up",
		"refs/remotes/originx/main":     "",
		"refs/heads/main":               "",
	} {
		if got := remoteOfRef(ref, remotes); got != want {
			t.Errorf("remoteOfRef(%s) = %q, want %q", ref, got, want)
		}
	}
}
