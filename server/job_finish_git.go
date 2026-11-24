package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
)

// What termote agents job finish (job_finish.go) asks git of a job's
// worktree before it removes it: is the checkout clean, and is its work safe
// elsewhere (HEAD on the branch's push ref, or the head of a merged pull
// request of the job); then the branch's deletion, matched to the SHA that
// was checked, and the removal of a worktree no workspace shows any more.
// Every call goes through gitRunner as argv; git's own text is logged, never
// answered.

// finishTree is a job's worktree as git reads it now.
type finishTree struct {
	repo gitRepoInfo
	// head is HEAD's full SHA.
	head  string
	dirty bool
	// pushRef is refs/remotes/<remote>/<branch>, "" when the branch has no
	// push remote or that ref does not exist here.
	pushRef string
	// onPush: HEAD is pushRef or an ancestor of it.
	onPush bool
	// envFiles: the worktree holds an ignored file whose name starts with
	// .env, which a remove deletes and nothing makes again.
	envFiles bool
}

// headSHARe is a full object name, SHA-1 or SHA-256.
var headSHARe = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// finishEnvPathspec lists the .env* files at any depth, so the ignored-file
// list stays short however large node_modules is.
const finishEnvPathspec = ":(glob)**/.env*"

// readFinishTree reads the worktree t names: refused unless it is a linked
// worktree, not the home dir nor one holding it, still on t's branch.
func readFinishTree(ctx context.Context, git *gitRunner, rr *rootResolver, home string, t jobTree) (finishTree, error) {
	if jobDirTooWide(t.Dir, home) {
		return finishTree{}, errWorktreeNotLinked
	}
	if _, err := os.Lstat(t.Dir); errors.Is(err, os.ErrNotExist) {
		return finishTree{}, errWorktreeNotFound
	}
	repo, ok, err := repoInfo(ctx, rr, t.Dir)
	switch {
	case err != nil:
		return finishTree{}, err
	case !ok || !repo.Linked:
		return finishTree{}, errWorktreeNotLinked
	case !sameAllowPath(repo.Top, t.Dir) || repo.Branch != t.Branch:
		return finishTree{}, errWorktreeChanged
	}
	f := finishTree{repo: repo}
	c := gitCall{root: repo.Top, safeDir: repo.SafeDir, limit: 4 << 10}
	out, _, err := git.output(ctx, c, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	if err != nil {
		return finishTree{}, fmt.Errorf("rev-parse HEAD in %s: %w", repo.Top, err)
	}
	if f.head = strings.TrimSpace(string(out)); !headSHARe.MatchString(f.head) {
		return finishTree{}, fmt.Errorf("rev-parse HEAD in %s: %q is no object name", repo.Top, f.head)
	}
	if f.dirty, err = worktreeDirty(ctx, git, repo); err != nil {
		return finishTree{}, err
	}
	run := func(args ...string) string {
		out, _, err := git.output(ctx, gitCall{root: repo.Top, safeDir: repo.SafeDir, limit: 64 << 10}, args...)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	if remote := pushRemoteName(run, strings.Fields(run("remote")), t.Branch); remote != "" {
		ref := "refs/remotes/" + remote + "/" + t.Branch
		if f.pushRef, err = refIfExists(ctx, git, c, ref); err != nil {
			return finishTree{}, err
		}
	}
	if f.pushRef != "" {
		_, _, err := git.output(ctx, c, "merge-base", "--is-ancestor", f.head, f.pushRef)
		var ee *exec.ExitError
		switch {
		case err == nil:
			f.onPush = true
		case errors.As(err, &ee) && ee.ExitCode() == 1:
		default:
			return finishTree{}, fmt.Errorf("merge-base in %s: %w", repo.Top, err)
		}
	}
	env := gitCall{root: repo.Top, safeDir: repo.SafeDir, heavy: true, noFilters: true, limit: 4 << 20}
	out, truncated, err := git.output(ctx, env, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", finishEnvPathspec)
	if err != nil {
		return finishTree{}, fmt.Errorf("ls-files in %s: %w", repo.Top, err)
	}
	f.envFiles = truncated || len(out) > 0
	return f, nil
}

// refIfExists is ref when it exists in c's repository, "" when it does not.
func refIfExists(ctx context.Context, git *gitRunner, c gitCall, ref string) (string, error) {
	_, _, err := git.output(ctx, c, "show-ref", "--verify", "--quiet", ref)
	var ee *exec.ExitError
	switch {
	case err == nil:
		return ref, nil
	case errors.As(err, &ee) && ee.ExitCode() == 1:
		return "", nil
	}
	return "", fmt.Errorf("show-ref %s: %w", ref, err)
}

// mergedPRAt is the first merged pull request of ci, the job's own (not
// foreign), whose head is head.
func mergedPRAt(ci *jobCI, head string) (jobPR, bool) {
	if ci == nil || head == "" {
		return jobPR{}, false
	}
	for _, pr := range ci.PRs {
		if pr.State == prMerged && !pr.Foreign && pr.Head != "" && strings.HasPrefix(head, strings.ToLower(pr.Head)) {
			return pr, true
		}
	}
	return jobPR{}, false
}

// safe: nothing is lost with the checkout. It is clean, and its HEAD is on
// the pushed branch or is the head of a merged pull request of the job (the
// remote branch is often deleted once merged, and a fetch --prune drops its
// ref here).
func (f finishTree) safe(ci *jobCI) bool {
	if f.dirty {
		return false
	}
	if f.onPush {
		return true
	}
	_, merged := mergedPRAt(ci, f.head)
	return merged
}

// Why a job's branch was kept after its worktree went.
const (
	branchCheckedOut   = "branch_checked_out"
	branchMoved        = "branch_moved"
	branchDeleteFailed = "branch_delete_failed"
)

// deleteMergedBranch deletes the local branch once its worktree is removed,
// only while it still points at sha (update-ref compares it): kept names why
// it stays, "" when it went. It runs where repo.gitDir says, the checkout
// that ran it gone.
func deleteMergedBranch(ctx context.Context, git *gitRunner, repo gitRepoInfo, branch, sha string) (kept string) {
	shared := repo
	shared.Top = repo.gitDir()
	entries, err := listWorktrees(ctx, git, shared)
	if err != nil {
		log.Printf("job finish: worktrees of %s: %v", shared.Top, err)
		return branchDeleteFailed
	}
	if slices.ContainsFunc(entries, func(e worktreeEntry) bool { return e.Branch == branch }) {
		return branchCheckedOut
	}
	c := gitCall{root: repo.gitDir(), safeDir: repo.SafeDir, limit: 4 << 10}
	ref := "refs/heads/" + branch
	w := c
	w.write = true
	if _, _, err := git.output(ctx, w, "update-ref", "-d", ref, sha); err != nil {
		log.Printf("job finish: delete %s in %s: %v", ref, repo.gitDir(), err)
		out, _, rerr := git.output(ctx, c, "rev-parse", "--verify", "--quiet", ref)
		if now := strings.TrimSpace(string(out)); rerr == nil && now != sha {
			return branchMoved
		}
		return branchDeleteFailed
	}
	return ""
}

// removeUnopenedWorktree removes the linked worktree at path that no
// workspace shows any more (a finish whose remove failed after its
// workspace closed): git's own list has to name it, linked and unlocked.
// No workspace is opened again.
func removeUnopenedWorktree(ctx context.Context, git *gitRunner, repo gitRepoInfo, path string) error {
	entries, err := listWorktrees(ctx, git, repo)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(entries, func(e worktreeEntry) bool { return sameAllowPath(e.Path, path) })
	switch {
	case i < 0 || !entries[i].Linked:
		return errWorktreeChanged
	case entries[i].Locked:
		return fmt.Errorf("worktree %s is locked", entries[i].Path)
	}
	return removeFreedWorktree(ctx, git, repo, entries[i].Path)
}
