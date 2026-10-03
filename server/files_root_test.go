package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// requireGit skips without git, and isolates the test from the user's own
// git config.
func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("needs git")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
}

// gitT runs git for test setup, outside the runner under test.
func gitT(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// newTestRepo makes a repo with one commit.
func newTestRepo(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "init", "-q")
	writeFile(t, filepath.Join(dir, "a.txt"), "one\n")
	gitT(t, dir, "add", ".")
	gitT(t, dir, "commit", "-q", "-m", "init")
	return dir
}

// writeScript writes an executable shell script.
func writeScript(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "s.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func requireUnixShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses shell scripts")
	}
}

func TestParseFilterDrivers(t *testing.T) {
	got, err := parseFilterDrivers([]byte("filter.lfs.clean\x00filter.lfs.smudge\x00filter.Evil.x.process\x00filter.noname\x00core.x\x00"))
	if err != nil || !slices.Equal(got, []string{"lfs", "Evil.x"}) {
		t.Fatalf("drivers = %q, %v", got, err)
	}
	if _, err := parseFilterDrivers([]byte("filter.a=b.clean\x00")); !errors.Is(err, errUnsafeRepoConfig) {
		t.Errorf("driver with '=': %v", err)
	}
	if got, err := parseFilterDrivers(nil); err != nil || len(got) != 0 {
		t.Errorf("empty = %q, %v", got, err)
	}
}

func TestGitArgvOverrides(t *testing.T) {
	g := newGitRunner()
	argv := g.argv(gitCall{root: "/r", safeDir: "/r"}, []string{"Evil.x"}, []string{"status"})
	joined := strings.Join(argv, " ")
	for _, want := range []string{"-C /r --no-pager", "core.fsmonitor=false", "protocol.allow=never", "safe.directory=/r",
		"core.hooksPath=" + os.DevNull, "diff.autoRefreshIndex=false",
		"filter.Evil.x.clean=", "filter.Evil.x.smudge=", "filter.Evil.x.process=", "filter.Evil.x.required=false"} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv %q lacks %q", joined, want)
		}
	}
	if argv[len(argv)-1] != "status" {
		t.Errorf("args must come last: %q", argv)
	}
}

func TestGitEnv(t *testing.T) {
	t.Setenv("GIT_DIR", "/evil")
	t.Setenv("GIT_CONFIG_PARAMETERS", "'core.fsmonitor'='/evil'")
	t.Setenv("TERMOTE_PASS", "secret")
	t.Setenv("LANGUAGE", "vi")
	t.Setenv("KEEP_ME", "1")
	env := gitEnv()
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if k == "GIT_DIR" || k == "GIT_CONFIG_PARAMETERS" || k == "TERMOTE_PASS" || k == "LANGUAGE" {
			t.Errorf("env keeps %s", kv)
		}
	}
	for _, want := range []string{"KEEP_ME=1", "LC_ALL=C", "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_NO_LAZY_FETCH=1"} {
		if !slices.Contains(env, want) {
			t.Errorf("env lacks %s", want)
		}
	}
}

func TestDubiousRepo(t *testing.T) {
	msg := "fatal: detected dubious ownership in repository at '/srv/my repo'\nTo add an exception for this directory, call:\n"
	if p, ok := dubiousRepo(msg); !ok || p != filepath.Clean("/srv/my repo") {
		t.Errorf("dubiousRepo = %q, %v", p, ok)
	}
	if p, ok := dubiousRepo("fatal: detected dubious ownership in repository at '/x'"); !ok || p != filepath.Clean("/x") {
		t.Errorf("without newline = %q, %v", p, ok)
	}
	for _, s := range []string{"fatal: not a git repository", "dubious ownership in repository at '"} {
		if _, ok := dubiousRepo(s); ok {
			t.Errorf("dubiousRepo(%q) matched", s)
		}
	}
}

func TestRootFromToplevel(t *testing.T) {
	if r := rootFromToplevel("/d", "", "", ""); r != (filesRoot{Root: "/d"}) {
		t.Errorf("empty toplevel = %+v", r)
	}
	top, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(top, "sub")
	os.MkdirAll(sub, 0o755)
	// An absolute path on every OS (git gives one with a drive on Windows),
	// written into the gitfile with '/' as git does.
	gitDir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// core.worktree naming a directory with no .git (even /): the pane's
	// directory itself, not a tree over the toplevel.
	if r := rootFromToplevel(sub, top, gitDir, "/s"); r != (filesRoot{Root: sub}) {
		t.Errorf("toplevel without .git = %+v", r)
	}
	writeFile(t, filepath.Join(top, ".git"), "gitdir: "+filepath.ToSlash(gitDir)+"\n")
	if r := rootFromToplevel(sub, top, gitDir, "/s"); r != (filesRoot{Root: top, IsRepo: true, SafeDir: "/s", GitDir: gitDir}) {
		t.Errorf("toplevel = %+v", r)
	}
	// A gitfile naming another git dir is not this repo's.
	if r := rootFromToplevel(sub, top, filepath.Join(gitDir, "other"), "/s"); r != (filesRoot{Root: sub}) {
		t.Errorf("gitfile of another repo = %+v", r)
	}
	// A toplevel the pane's directory is not under.
	elsewhere := filepath.Join(gitDir, "elsewhere")
	if r := rootFromToplevel(elsewhere, top, gitDir, ""); r != (filesRoot{Root: elsewhere}) {
		t.Errorf("toplevel not above dir = %+v", r)
	}
}

// core.worktree naming a parent that holds another repo (a home directory
// under dotfiles): its .git is not this repo's, so the pane's directory
// stays the root.
func TestRootResolverWorktreeInAnotherRepo(t *testing.T) {
	requireGit(t)
	home := newTestRepo(t)
	inner := filepath.Join(home, "proj")
	os.MkdirAll(inner, 0o755)
	gitT(t, inner, "init", "-q")
	gitT(t, inner, "config", "core.worktree", home)
	rr := newRootResolver(newGitRunner())
	if r, err := rr.resolve(t.Context(), inner); err != nil || r != (filesRoot{Root: inner}) {
		t.Errorf("core.worktree=%s resolves to %+v, %v", home, r, err)
	}
	// The parent repo itself still resolves as one.
	if r, err := rr.resolve(t.Context(), home); err != nil || !r.IsRepo || r.Root != home {
		t.Errorf("parent repo = %+v, %v", r, err)
	}
}

// A linked worktree (.git is a gitfile into the main repo) is a repo.
func TestRootResolverLinkedWorktree(t *testing.T) {
	requireGit(t)
	repo := newTestRepo(t)
	wt := filepath.Join(t.TempDir(), "wt")
	gitT(t, repo, "worktree", "add", "-q", wt)
	wt, _ = filepath.EvalSymlinks(wt)
	rr := newRootResolver(newGitRunner())
	if r, err := rr.resolve(t.Context(), wt); err != nil || !r.IsRepo || r.Root != wt {
		t.Errorf("linked worktree = %+v, %v", r, err)
	}
}

// A repo whose core.worktree is / browses as the pane's own directory, so
// the Files view does not cover the whole file system.
func TestRootResolverWorktreeElsewhere(t *testing.T) {
	requireGit(t)
	repo := newTestRepo(t)
	gitT(t, repo, "config", "core.worktree", "/")
	rr := newRootResolver(newGitRunner())
	if r, err := rr.resolve(t.Context(), repo); err != nil || r != (filesRoot{Root: repo}) {
		t.Errorf("core.worktree=/ resolves to %+v, %v", r, err)
	}
}

func TestTrustRepo(t *testing.T) {
	rr := newRootResolver(newGitRunner())
	owned, container := false, false
	rr.ownedByServer = func(string) bool { return owned }
	rr.inContainer = func() bool { return container }
	if rr.trustRepo("/workspace/a") {
		t.Error("trusted outside a container without ownership")
	}
	owned = true
	if !rr.trustRepo("/anywhere") {
		t.Error("owned repo not trusted")
	}
	owned, container = false, true
	for path, want := range map[string]bool{"/workspace/a": true, "/workspace": true, "/home/x": false, "/workspace/../etc": false} {
		if got := rr.trustRepo(path); got != want {
			t.Errorf("trustRepo(%q) in container = %v, want %v", path, got, want)
		}
	}
}

func TestRunningInContainerAndOwnership(t *testing.T) {
	// Only checks that they answer; the results depend on the machine.
	runningInContainer()
	if runtime.GOOS != "windows" && !ownedByServer(t.TempDir()) {
		t.Error("a temp dir the test created is not owned by it")
	}
	if ownedByServer(filepath.Join(t.TempDir(), "missing")) {
		t.Error("missing path reported as owned")
	}
}

func TestResolveFilesRoot(t *testing.T) {
	requireGit(t)
	ctx := context.Background()
	repo := newTestRepo(t)
	sub := filepath.Join(repo, "deep", "sub")
	os.MkdirAll(sub, 0o755)
	rr := newRootResolver(newGitRunner())

	if r, err := rr.resolve(ctx, sub); err != nil || r != (filesRoot{Root: repo, IsRepo: true, GitDir: filepath.Join(repo, "."+"git")}) {
		t.Errorf("subdir of repo = %+v, %v", r, err)
	}
	plain, _ := filepath.EvalSymlinks(t.TempDir())
	if r, err := rr.resolve(ctx, plain); err != nil || r != (filesRoot{Root: plain}) {
		t.Errorf("plain dir = %+v, %v", r, err)
	}
	if runtime.GOOS != "windows" {
		link := filepath.Join(t.TempDir(), "link")
		if err := os.Symlink(sub, link); err != nil {
			t.Fatal(err)
		}
		if r, err := rr.resolve(ctx, link); err != nil || r.Root != repo || !r.IsRepo {
			t.Errorf("symlinked cwd = %+v, %v", r, err)
		}
	}
	for _, bad := range []string{filepath.Join(plain, "gone"), filepath.Join(repo, "a.txt")} {
		if _, err := rr.resolve(ctx, bad); !errors.Is(err, errDirNotAvailable) {
			t.Errorf("resolve(%q) = %v, want directory not available", bad, err)
		}
	}
	// A caller that leaves does not turn the shared answer into "not a repo".
	gone, cancel := context.WithCancel(ctx)
	cancel()
	fresh := newRootResolver(newGitRunner())
	if r, err := fresh.resolve(gone, sub); err != nil || !r.IsRepo {
		t.Errorf("canceled caller = %+v, %v", r, err)
	}
	// No git: browsed as a plain directory.
	nogit := newRootResolver(&gitRunner{bin: "termote-no-such-git", timeout: time.Second,
		sem: make(chan struct{}, 1), filters: newTTLCache[[]string](0), failedAt: map[string]time.Time{}})
	if r, err := nogit.resolve(ctx, sub); err != nil || r != (filesRoot{Root: sub}) {
		t.Errorf("without git = %+v, %v", r, err)
	}
}

// A fake git that refuses the repo for its owner unless safe.directory is
// passed, as git does for a repo owned by another user.
func TestResolveFilesRootDubiousOwnership(t *testing.T) {
	requireUnixShell(t)
	ctx := context.Background()
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	fake := writeScript(t, fmt.Sprintf(`case "$*" in
*safe.directory=%[1]s*) printf '%%s\n' %[1]s %[1]s/meta ;;
*) echo "fatal: detected dubious ownership in repository at '%[1]s'" >&2; exit 128 ;;
esac`, dir))
	writeFile(t, filepath.Join(dir, "."+"git"), "gitdir: meta\n")
	g := newGitRunner()
	g.bin = fake
	rr := newRootResolver(g)
	trusted := false
	rr.ownedByServer = func(p string) bool { return trusted && p == dir }
	rr.inContainer = func() bool { return false }

	if r, err := rr.resolve(ctx, dir); err != nil || r != (filesRoot{Root: dir}) {
		t.Errorf("untrusted = %+v, %v, want a plain directory", r, err)
	}
	trusted = true
	rr.resolved = newTTLCache[filesRoot](0)
	if r, err := rr.resolve(ctx, dir); err != nil || r != (filesRoot{Root: dir, IsRepo: true, SafeDir: dir, GitDir: filepath.Join(dir, "meta")}) {
		t.Errorf("trusted = %+v, %v", r, err)
	}
}

// A repo whose config points core.fsmonitor and a filter driver (set through
// an include, with a mixed-case dotted name) at a program: status and diff
// through the runner run neither. Without the overrides, the same status runs
// the filter, so the setup does trigger it.
func TestGitRunnerDoesNotRunRepoPrograms(t *testing.T) {
	requireGit(t)
	requireUnixShell(t)
	ctx := context.Background()
	repo := newTestRepo(t)
	writeFile(t, filepath.Join(repo, ".gitattributes"), "*.txt filter=Evil.x\n*.md filter=proc\n")
	writeFile(t, filepath.Join(repo, "b.md"), "md\n")
	gitT(t, repo, "add", ".")
	gitT(t, repo, "commit", "-q", "-m", "attrs")

	marker := filepath.Join(t.TempDir(), "ran")
	evil := writeScript(t, "touch "+marker+"; cat")
	inc := filepath.Join(t.TempDir(), "inc")
	writeFile(t, inc, "[filter \"Evil.x\"]\n\tclean = "+evil+"\n\tsmudge = "+evil+"\n\trequired = true\n")
	gitT(t, repo, "config", "include.path", inc)
	gitT(t, repo, "config", "core.fsmonitor", evil)
	gitT(t, repo, "config", "filter.proc.process", evil)
	gitT(t, repo, "config", "filter.proc.required", "true")
	// Changed content and mtime, so git must re-read (and clean) the files.
	writeFile(t, filepath.Join(repo, "a.txt"), "two\n")
	writeFile(t, filepath.Join(repo, "b.md"), "md2\n")
	later := time.Now().Add(time.Minute)
	os.Chtimes(filepath.Join(repo, "a.txt"), later, later)

	g := newGitRunner()
	c := gitCall{root: repo, noFilters: true}
	if out, _, err := g.output(ctx, c, "status", "--porcelain=v2", "-z", "--untracked-files=all"); err != nil || !strings.Contains(string(out), "a.txt") {
		t.Fatalf("status = %q, %v", out, err)
	}
	if out, _, err := g.output(ctx, c, "diff", "--no-ext-diff", "--no-textconv", "--", ":(literal)a.txt"); err != nil || !strings.Contains(string(out), "+two") {
		t.Fatalf("diff = %q, %v", out, err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a program from the repo config ran")
	}

	g.output(ctx, gitCall{root: repo}, "status", "--porcelain=v2")
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("control: the filter did not run without the overrides, so the test proves nothing")
	}
}

func TestGitRunnerFailsClosedOnUnsafeDriverName(t *testing.T) {
	requireGit(t)
	repo := newTestRepo(t)
	writeFile(t, filepath.Join(repo, ".git", "config"), "[filter \"a=b\"]\n\tclean = x\n")
	g := newGitRunner()
	if _, _, err := g.output(context.Background(), gitCall{root: repo, noFilters: true}, "status"); !errors.Is(err, errUnsafeRepoConfig) {
		t.Errorf("err = %v, want errUnsafeRepoConfig", err)
	}
	// A broken config is an error too, never a run without overrides.
	writeFile(t, filepath.Join(repo, ".git", "config"), "[broken\n")
	g = newGitRunner()
	if _, _, err := g.output(context.Background(), gitCall{root: repo, noFilters: true}, "status"); err == nil {
		t.Error("broken config: status ran")
	}
}

func TestGitRunnerTruncates(t *testing.T) {
	requireUnixShell(t)
	g := newGitRunner()
	g.bin = writeScript(t, "yes x")
	out, truncated, err := g.output(context.Background(), gitCall{root: t.TempDir(), limit: 100}, "status")
	if err != nil || !truncated || len(out) != 100 {
		t.Errorf("out=%d truncated=%v err=%v", len(out), truncated, err)
	}
	g.bin = writeScript(t, "echo ok")
	out, truncated, err = g.output(context.Background(), gitCall{root: t.TempDir()}, "status")
	if err != nil || truncated || string(out) != "ok\n" {
		t.Errorf("out=%q truncated=%v err=%v", out, truncated, err)
	}
	g.bin = writeScript(t, "echo nope >&2; exit 3")
	var ge *gitError
	if _, _, err = g.output(context.Background(), gitCall{root: t.TempDir()}, "status"); !errors.As(err, &ge) || !strings.Contains(ge.Error(), "nope") {
		t.Errorf("failing git: %v", err)
	}
}

// A timed-out git makes the root back off: the next call fails at once
// without running git.
func TestGitRunnerTimeoutBacksOff(t *testing.T) {
	requireUnixShell(t)
	root := t.TempDir()
	count := filepath.Join(t.TempDir(), "count")
	g := newGitRunner()
	g.bin = writeScript(t, "echo x >> "+count+"; sleep 5")
	g.timeout = 200 * time.Millisecond
	start := time.Now()
	heavy := gitCall{root: root, heavy: true}
	if _, _, err := g.output(context.Background(), heavy, "status"); !errors.Is(err, errGitTimeout) {
		t.Fatalf("err = %v, want timeout", err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("timeout took %s", d)
	}
	if _, _, err := g.output(context.Background(), heavy, "status"); !errors.Is(err, errGitTimeout) {
		t.Fatalf("second call = %v, want timeout", err)
	}
	if b, _ := os.ReadFile(count); strings.Count(string(b), "x") != 1 {
		t.Errorf("git ran %d times, want 1", strings.Count(string(b), "x"))
	}
	// A light command (rev-parse) still runs in a root that backs off.
	g.bin = writeScript(t, "echo light")
	if out, _, err := g.output(context.Background(), gitCall{root: root}, "rev-parse"); err != nil || string(out) != "light\n" {
		t.Errorf("light command while backing off = %q, %v", out, err)
	}
	g.mu.Lock()
	g.failedAt[root] = time.Now().Add(-gitFailBackoff)
	g.mu.Unlock()
	if g.backingOff(root) {
		t.Error("still backing off after gitFailBackoff")
	}
}

func TestGitRunnerSemaphore(t *testing.T) {
	g := newGitRunner()
	g.timeout = 100 * time.Millisecond
	for i := 0; i < gitMaxRunning; i++ {
		g.sem <- struct{}{}
	}
	if _, _, err := g.output(context.Background(), gitCall{root: t.TempDir(), heavy: true}, "status"); !errors.Is(err, errGitTimeout) {
		t.Errorf("full semaphore: %v, want timeout", err)
	}
	// Light commands do not wait for a slot.
	if runtime.GOOS != "windows" {
		g.bin = writeScript(t, "echo ok")
		if _, _, err := g.output(context.Background(), gitCall{root: t.TempDir()}, "rev-parse"); err != nil {
			t.Errorf("light command with a full semaphore: %v", err)
		}
	}
}

type fakePaneDirer struct {
	dir, key string
	err      error
}

func (f *fakePaneDirer) PaneDir(context.Context, string) (string, string, error) {
	return f.dir, f.key, f.err
}

func TestPaneRootSettles(t *testing.T) {
	requireGit(t)
	ctx := context.Background()
	a, _ := filepath.EvalSymlinks(t.TempDir())
	b, _ := filepath.EvalSymlinks(t.TempDir())
	rr := newRootResolver(newGitRunner())
	now := time.Now()
	rr.now = func() time.Time { return now }
	d := &fakePaneDirer{dir: a, key: "%1"}
	root := func() string {
		t.Helper()
		r, err := rr.paneRoot(ctx, d, "0")
		if err != nil {
			t.Fatal(err)
		}
		return r.Root
	}
	if got := root(); got != a {
		t.Fatalf("first root = %q", got)
	}
	d.dir = b // `make -C b` for a moment
	if got := root(); got != a {
		t.Errorf("one read of b moved the root to %q", got)
	}
	d.dir = a
	if got := root(); got != a {
		t.Errorf("root = %q", got)
	}
	d.dir = b
	root()
	now = now.Add(rootSettle - time.Millisecond)
	if got := root(); got != a {
		t.Errorf("b moved the root before rootSettle: %q", got)
	}
	now = now.Add(time.Millisecond)
	if got := root(); got != b {
		t.Errorf("b seen for rootSettle, root still %q", got)
	}
	// Another pane has its own state; idle state is dropped.
	if r, _ := rr.paneRoot(ctx, &fakePaneDirer{dir: a, key: "%2"}, "1"); r.Root != a {
		t.Errorf("other pane = %q", r.Root)
	}
	now = now.Add(rootStateIdle)
	rr.paneRoot(ctx, &fakePaneDirer{dir: a, key: "%3"}, "2")
	rr.mu.Lock()
	n := len(rr.panes)
	rr.mu.Unlock()
	if n != 1 {
		t.Errorf("%d pane states kept, want only the fresh one", n)
	}

	d.err = inputError("unknown pane")
	if _, err := rr.paneRoot(ctx, d, "0"); err == nil {
		t.Error("PaneDir error not returned")
	}
	d.err, d.dir = nil, filepath.Join(a, "gone")
	if _, err := rr.paneRoot(ctx, d, "0"); !errors.Is(err, errDirNotAvailable) {
		t.Errorf("gone dir: %v", err)
	}
}

func TestHerdrPaneDir(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	set := func(extra map[string]any) {
		f.mu.Lock()
		f.paneExtra = extra
		f.mu.Unlock()
	}
	set(map[string]any{"cwd": "/home/u", "foreground_cwd": "/home/u/proj"})
	if dir, key, err := m.PaneDir(ctx, "wR:p3"); err != nil || dir != "/home/u/proj" || key != "wR:p3" {
		t.Errorf("PaneDir = %q, %q, %v", dir, key, err)
	}
	set(map[string]any{"cwd": "/home/u"})
	if dir, _, err := m.PaneDir(ctx, "wR:p3"); err != nil || dir != "/home/u" {
		t.Errorf("without foreground_cwd = %q, %v", dir, err)
	}
	set(nil)
	if _, _, err := m.PaneDir(ctx, "wR:p3"); !errors.Is(err, errUnsupported) {
		t.Errorf("old herdr = %v, want errUnsupported", err)
	}
	var ie inputError
	if _, _, err := m.PaneDir(ctx, "-x"); !errors.As(err, &ie) {
		t.Errorf("bad pane id: %v", err)
	}
	f.close()
	if _, _, err := m.PaneDir(ctx, "wR:p3"); err == nil {
		t.Error("herdr down: no error")
	}
}

func TestTmuxPaneDirRejectsBadIDs(t *testing.T) {
	if !tmuxFilesSupported {
		if _, _, err := (tmuxMux{}).PaneDir(context.Background(), "0"); !errors.Is(err, errUnsupported) {
			t.Errorf("PaneDir without support = %v", err)
		}
		return
	}
	for _, bad := range []string{"-t", "main:0", "name", ""} {
		var ie inputError
		if _, _, err := (tmuxMux{}).PaneDir(context.Background(), bad); !errors.As(err, &ie) {
			t.Errorf("PaneDir(%q) = %v", bad, err)
		}
	}
}

// A real tmux: the window's directory and pane id; an index that no longer
// exists is "unknown pane" even when a window name starts with it (tmux would
// otherwise match the name).
func TestTmuxPaneDirInRealSession(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil || runtime.GOOS == "windows" {
		t.Skip("needs tmux with a private socket")
	}
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = fmt.Sprintf("termote-panedir-%d", os.Getpid())
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})
	ctx := context.Background()
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	if err := tmuxCmd(ctx, "-f", "/dev/null", "new-session", "-d", "-s", tmuxSession, "-c", dir, "-n", "5-x", "exec sleep 60").Run(); err != nil {
		t.Fatal(err)
	}
	// The pane reports the server's directory until its process has started.
	var got, key string
	var err error
	waitUntil(t, "pane directory", func() bool {
		got, key, err = tmuxMux{}.PaneDir(ctx, "0")
		return got == dir
	})
	if err != nil || got != dir || !tmuxPaneIDRe.MatchString(key) {
		t.Fatalf("PaneDir(0) = %q, %q, %v", got, key, err)
	}
	var ie inputError
	if _, _, err := (tmuxMux{}).PaneDir(ctx, "5"); !errors.As(err, &ie) || ie != "unknown pane" {
		t.Errorf("PaneDir(5) with a window named 5-x = %v, want unknown pane", err)
	}
}
