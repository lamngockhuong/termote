//go:build !windows

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// failingGit is a git that runs the real one, except that a command whose
// arguments hold the word in $FINISH_GIT_FAIL exits 2, and one holding the
// word in $FINISH_GIT_JUNK prints junk.
func failingGit(t *testing.T) *gitRunner {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	script := filepath.Join(t.TempDir(), "git")
	body := "#!/bin/sh\nfor a in \"$@\"; do\n" +
		"  [ -n \"$FINISH_GIT_FAIL\" ] && [ \"$a\" = \"$FINISH_GIT_FAIL\" ] && exit 2\n" +
		"  [ -n \"$FINISH_GIT_JUNK\" ] && [ \"$a\" = \"$FINISH_GIT_JUNK\" ] && { echo junk; exit 0; }\n" +
		"done\nexec " + real + " \"$@\"\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	g := newGitRunner()
	g.bin = script
	return g
}

func TestFinishTreeGitErrors(t *testing.T) {
	r := newFinishRepo(t)
	gitIn(t, r.wt, "push", "-q", "-u", "origin", "feat")
	git := failingGit(t)
	ctx := context.Background()
	for _, c := range []struct{ env, word string }{
		{"FINISH_GIT_FAIL", "rev-parse"},
		{"FINISH_GIT_JUNK", "rev-parse"},
		{"FINISH_GIT_FAIL", "--stage"},
		{"FINISH_GIT_FAIL", "show-ref"},
		{"FINISH_GIT_FAIL", "merge-base"},
		{"FINISH_GIT_FAIL", "--ignored"},
	} {
		t.Run(c.env+"="+c.word, func(t *testing.T) {
			t.Setenv(c.env, c.word)
			if f, err := readFinishTree(ctx, git, newTestRoots(), r.home, r.tree()); err == nil {
				t.Errorf("read: %+v", f)
			}
		})
	}
	// The repository's own resolve running out of time is an error too.
	slow := newGitRunner()
	slow.timeout = 1
	if f, err := readFinishTree(ctx, git, newRootResolver(slow), r.home, r.tree()); err == nil {
		t.Errorf("resolve: %+v", f)
	}
}
