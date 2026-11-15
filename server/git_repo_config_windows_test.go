package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A file a config key names relative to the work tree is opened from there,
// so a link at the top of the work tree leading to a share refuses the
// repository; no connection is made, the link itself is read.
func TestRepoConfigRefusedLinkFromWorkTree(t *testing.T) {
	dir := fakeRepo(t, gitDirFiles(".git/", "[diff]\n\torderFile = lnk/order\n"))
	if err := os.Symlink(`\\192.0.2.1\s`, filepath.Join(dir, "lnk")); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	if err := newTestRoots().repoConfigRefused(dir); err == nil {
		t.Error("diff.orderFile through a link to a share passed")
	}
}

// A core.worktree that config.worktree sets is where git opens the files
// the main config names: a link there to a share refuses the repository.
func TestRepoConfigRefusedLinkFromConfigWorktree(t *testing.T) {
	dir := fakeRepo(t, withFiles(gitDirFiles(".git/", "[diff]\n\torderFile = o\n"),
		".git/config.worktree", "[core]\n\tworktree = ../wt\n", "wt/", ""))
	if err := os.Symlink(`\\192.0.2.1\s\o`, filepath.Join(dir, "wt", "o")); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	if err := newTestRoots().repoConfigRefused(dir); err == nil {
		t.Error("diff.orderFile through a link in the work tree config.worktree names passed")
	}
}

// git reads core.worktree literally: ~/w is <git dir>\~\w, and a link at
// <git dir>\~ to a share refuses the repository.
func TestRepoConfigRefusedWorktreeLiteral(t *testing.T) {
	dir := fakeRepo(t, gitDirFiles(".git/", "[core]\n\tworktree = ~/w\n"))
	if err := os.Symlink(`\\192.0.2.1\s`, filepath.Join(dir, ".git", "~")); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	if err := newTestRoots().repoConfigRefused(dir); err == nil {
		t.Error("core.worktree under a link to a share passed")
	}
}

// gitEntryTarget refuses a gitfile in a directory on a drive that names a
// git dir on a share, before anything resolves it.
func TestGitEntryTargetRefusesShare(t *testing.T) {
	top := t.TempDir()
	if err := os.WriteFile(filepath.Join(top, ".git"), []byte("gitdir: //192.0.2.1/s/x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if target, ok := gitEntryTarget(top); ok {
		t.Errorf("gitEntryTarget = %q, want refused", target)
	}
}
