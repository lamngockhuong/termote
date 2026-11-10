package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

// Git worktrees managed by termote itself, for the backends that have no
// worktree support of their own (tmux, Zellij, herdr-core): what repository
// a folder belongs to, the repository's worktrees, where a new checkout goes,
// and the add and remove calls. Every git call goes through gitRunner (hooks,
// fsmonitor and, where set, filters off; GIT_* and TERMOTE_* stripped). No
// path comes from a client: a new checkout's path is built here from the
// branch name and the repository's main checkout.

// gitRepoInfo is what a folder's repository looks like from that folder.
type gitRepoInfo struct {
	// Top is the folder's work tree, resolved.
	Top string
	// Main is the repository's main checkout; empty when the repository
	// has none (a bare one) or it cannot be told.
	Main string
	// GitDir is Top's git directory, Common the one every work tree
	// shares (a linked worktree's GitDir is <Common>/worktrees/<name>).
	GitDir, Common string
	// SafeDir is passed to git as safe.directory (see filesRoot.SafeDir).
	SafeDir string
	// Name is the base name of Main (Top when there is no Main).
	Name string
	// Linked: Top is a linked worktree, not the main checkout.
	Linked bool
	// Branch is Top's checked out branch, empty when detached or when
	// validBranchName refuses it.
	Branch string
}

// gitDir is where git runs for a change to the whole repository: the main
// checkout, else the shared git directory (a bare main).
func (r gitRepoInfo) gitDir() string {
	if r.Main != "" {
		return r.Main
	}
	return r.Common
}

// repoInfo resolves dir's repository. ok is false outside a repository.
func repoInfo(ctx context.Context, rr *rootResolver, dir string) (gitRepoInfo, bool, error) {
	root, err := rr.resolve(ctx, dir)
	if errors.Is(err, errDirNotAvailable) {
		return gitRepoInfo{}, false, nil
	}
	if err != nil || !root.IsRepo || root.GitDir == "" {
		return gitRepoInfo{}, false, err
	}
	info := gitRepoInfo{Top: root.Root, GitDir: root.GitDir, Common: commonGitDir(root.GitDir), SafeDir: root.SafeDir}
	info.Linked = !sameAllowPath(info.Common, info.GitDir)
	switch {
	case !info.Linked:
		info.Main = info.Top
	case filepath.Base(info.Common) == ".git" && gitEntryLeadsTo(filepath.Dir(info.Common), info.Common):
		info.Main = filepath.Dir(info.Common)
	}
	info.Name = filepath.Base(info.Top)
	if info.Main != "" {
		info.Name = filepath.Base(info.Main)
	}
	out, _, err := rr.git.output(ctx, gitCall{root: info.Top, safeDir: info.SafeDir, limit: 4 << 10},
		"symbolic-ref", "-q", "--short", "HEAD")
	if b := strings.TrimSpace(string(out)); err == nil && validBranchName(b) {
		info.Branch = b
	}
	return info, true, nil
}

// worktreeEntry is one work tree of `git worktree list`.
type worktreeEntry struct {
	Path     string // resolved
	Branch   string // empty when detached, bare or refused by validBranchName
	Bare     bool
	Detached bool
	Prunable bool
	// Locked: git refuses to remove it, even with --force once.
	Locked bool
	// Linked: not the main checkout (git lists that one first).
	Linked bool
}

// openable: a linked worktree on a valid branch, not bare, prunable or
// detached, which Open worktree can open by its branch.
func (e worktreeEntry) openable() bool {
	return e.Linked && e.Branch != "" && !e.Bare && !e.Prunable && !e.Detached
}

// listWorktrees lists repo's work trees through git (run in repo.Top). A
// path that does not resolve (a prunable entry whose folder is gone) or
// whose .git does not lead back to the repository is left out. A list git
// cut short is an error, never half a list. A git older than 2.36 has no
// -z: its lines are read instead (a path holding a newline then resolves
// to nothing and is left out).
func listWorktrees(ctx context.Context, git *gitRunner, repo gitRepoInfo) ([]worktreeEntry, error) {
	c := gitCall{root: repo.Top, safeDir: repo.SafeDir, limit: maxWorktreeList}
	out, truncated, err := git.output(ctx, c, "worktree", "list", "--porcelain", "-z")
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() == 129 {
		out, truncated, err = git.output(ctx, c, "worktree", "list", "--porcelain")
		out = bytes.ReplaceAll(out, []byte{'\n'}, []byte{0})
	}
	if err != nil {
		return nil, err
	}
	if truncated {
		return nil, errors.New("git worktree list: output too long")
	}
	var own []worktreeEntry
	for _, e := range parseWorktreeEntries(out) {
		if real, err := filepath.EvalSymlinks(e.Path); err == nil && ownWorktree(real, repo.Common) {
			e.Path = filepath.Clean(real)
			own = append(own, e)
		}
	}
	return own, nil
}

// parseWorktreeEntries reads `git worktree list --porcelain -z`: NUL-ended
// lines, a record per work tree ended by an empty one, the main one first.
// Paths are as git gives them (absolute; a relative one is dropped).
func parseWorktreeEntries(out []byte) []worktreeEntry {
	var list []worktreeEntry
	var cur *worktreeEntry
	n := 0
	flush := func() {
		if cur != nil && filepath.IsAbs(cur.Path) {
			cur.Linked = n > 0
			list = append(list, *cur)
		}
		if cur != nil {
			n++
		}
		cur = nil
	}
	for _, line := range bytes.Split(out, []byte{0}) {
		s := string(line)
		switch {
		case s == "":
			flush()
		case strings.HasPrefix(s, "worktree "):
			flush()
			cur = &worktreeEntry{Path: filepath.FromSlash(s[len("worktree "):])}
		case cur == nil:
		case strings.HasPrefix(s, "branch "):
			if b, ok := strings.CutPrefix(s[len("branch "):], "refs/heads/"); ok && validBranchName(b) {
				cur.Branch = b
			}
		case s == "bare":
			cur.Bare = true
		case s == "detached":
			cur.Detached = true
		case s == "prunable" || strings.HasPrefix(s, "prunable "):
			cur.Prunable = true
		case s == "locked" || strings.HasPrefix(s, "locked "):
			cur.Locked = true
		}
	}
	flush()
	return list
}

// branchSlugRe is what herdr-app turns into a "-" in a branch's folder name.
var branchSlugRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// branchSlug is a branch's folder name, herdr-app's rule: every run of
// characters other than ASCII letters, digits, '.', '_' and '-' becomes one
// '-', leading and trailing '-' trimmed. A name with nothing left, only
// dots, or a git directory's name is refused.
func branchSlug(branch string) (string, error) {
	s := strings.Trim(branchSlugRe.ReplaceAllString(branch, "-"), "-")
	// A folder named like a git directory would make its parent look like
	// a repository.
	if strings.Trim(s, ".") == "" || isGitDirName(s) {
		return "", errWorktreeName
	}
	return s, nil
}

// worktreeBase is the folder new checkouts go under for backend: herdr-core
// uses herdr-app's own (~/.herdr/worktrees), so herdr-app finds them; tmux
// and Zellij ~/.termote/worktrees. In a container both are under the
// workspace, the bind-mounted host folder: the container's home does not
// survive `container down`.
func worktreeBase(backend string) string {
	home, _ := os.UserHomeDir()
	return worktreeBaseFor(backend, home, runningInContainer())
}

func worktreeBaseFor(backend, home string, inContainer bool) string {
	if inContainer {
		home = containerWorkspace
	}
	if home == "" {
		return ""
	}
	dir := ".termote"
	if backend == "hc" {
		dir = ".herdr"
	}
	return filepath.Join(home, dir, "worktrees")
}

// newWorktreePath is where branch's checkout of repoName goes under base:
// base/<repoName>/<branch slug>. It refuses a repo name that is not one
// clean path element, a target that exists, and one under a deny dir (as
// given or, for the part that exists, resolved).
func newWorktreePath(base, repoName, branch string, deny []string) (string, error) {
	if base == "" || !filepath.IsAbs(base) {
		return "", fmt.Errorf("worktree base %q is not absolute: %w", base, errWorktreeCreateFailed)
	}
	if repoName == "" || repoName == "." || repoName == ".." || filepath.Base(repoName) != repoName ||
		strings.ContainsAny(repoName, `/\`) || strings.IndexFunc(repoName, unicode.IsControl) >= 0 {
		return "", fmt.Errorf("repository name %q: %w", repoName, errWorktreeCreateFailed)
	}
	slug, err := branchSlug(branch)
	if err != nil {
		return "", err
	}
	path := filepath.Join(base, repoName, slug)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("worktree target %s exists: %w", path, errWorktreeCreateFailed)
	}
	paths := []string{path}
	if real, ok := resolveExisting(path); ok {
		paths = append(paths, real)
	}
	for _, p := range paths {
		for _, d := range deny {
			if underDir(d, p) {
				return "", fmt.Errorf("worktree target %s is denied: %w", path, errWorktreeCreateFailed)
			}
		}
	}
	return path, nil
}

// resolveExisting resolves the deepest part of p that exists and joins the
// rest back on.
func resolveExisting(p string) (string, bool) {
	rest := ""
	for dir := p; ; {
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(real, rest), true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		rest = filepath.Join(filepath.Base(dir), rest)
		dir = parent
	}
}

// addWorktree checks branch out at path, a new worktree of repo (run where
// repo.gitDir says): an existing branch as it is, else a new branch made
// from base (HEAD when empty). Filters stay off (a Git LFS repository gets
// pointer files) and so do hooks (no post-checkout). git's message is logged,
// never answered.
func addWorktree(ctx context.Context, git *gitRunner, repo gitRepoInfo, path, branch, base string, exists bool) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		log.Printf("worktree add: %v", err)
		return errWorktreeCreateFailed
	}
	args := []string{"worktree", "add", "--", path, branch}
	if !exists {
		if base == "" {
			base = "HEAD"
		}
		args = []string{"worktree", "add", "-b", branch, "--", path, base}
	}
	if _, _, err := git.output(ctx, gitCall{root: repo.gitDir(), safeDir: repo.SafeDir, noFilters: true, write: true}, args...); err != nil {
		log.Printf("worktree add %s in %s: %v", path, repo.gitDir(), err)
		return errWorktreeCreateFailed
	}
	return nil
}

// removeWorktree deletes the linked worktree at path (git refuses a dirty
// one without force). git's message is logged, never answered.
func removeWorktree(ctx context.Context, git *gitRunner, repo gitRepoInfo, path string, force bool) error {
	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, "--", path)
	// Filters off: without --force git checks the work tree's status first.
	c := gitCall{root: repo.gitDir(), safeDir: repo.SafeDir, noFilters: true, write: true}
	if _, _, err := git.output(ctx, c, args...); err != nil {
		log.Printf("worktree remove %s in %s: %v", path, repo.gitDir(), err)
		return errWorktreeFailed
	}
	return nil
}

// worktreeDirty reports whether the work tree has changes git keeps it for:
// modified, staged or untracked (not ignored) files, or a submodule
// (gitDir/modules, or a gitlink in the index), which git refuses to remove.
// status never enters a submodule: gitRunner turns off only the filters the
// repository's own config names, and a submodule's config can define more.
func worktreeDirty(ctx context.Context, git *gitRunner, repo gitRepoInfo) (bool, error) {
	if fileExists(filepath.Join(repo.GitDir, "modules")) {
		return true, nil
	}
	c := gitCall{root: repo.Top, safeDir: repo.SafeDir, heavy: true, noFilters: true, limit: worktreeIndexLimit}
	// ls-files reads the index only; a cut list counts as dirty.
	index, truncated, err := git.output(ctx, c, "ls-files", "--stage", "-z")
	if err != nil {
		return false, err
	}
	if truncated || hasGitlink(index) {
		return true, nil
	}
	c.limit = 4 << 10
	out, truncated, err := git.output(ctx, c,
		"status", "--porcelain", "-z", "--untracked-files=normal", "--ignore-submodules=all")
	if err != nil {
		return false, err
	}
	return truncated || len(out) > 0, nil
}

// worktreeIndexLimit caps the index list worktreeDirty reads (some 200k
// entries); a larger index is dirty, and only a forced remove takes it.
const worktreeIndexLimit = 16 << 20

// hasGitlink reports whether `ls-files --stage -z` output ("<mode> <oid>
// <stage>\t<path>" records) holds a gitlink (mode 160000).
func hasGitlink(out []byte) bool {
	for rec := range bytes.SplitSeq(out, []byte{0}) {
		if bytes.HasPrefix(rec, []byte("160000 ")) {
			return true
		}
	}
	return false
}
