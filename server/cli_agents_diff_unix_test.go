//go:build !windows

package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// dirAgentsFake is agentsFake with every pane in dir, for the Files routes.
type dirAgentsFake struct {
	*agentsFake
	dir string
}

func (f *dirAgentsFake) PaneDir(context.Context, string) (string, string, error) {
	return f.dir, "%0", nil
}

// diffRepo is a worktree on feat, one commit past trunk, with every kind of
// uncommitted change on top.
func diffRepo(t *testing.T) (main, wt string) {
	t.Helper()
	requireGit(t)
	main = newTestRepo(t)
	gitT(t, main, "branch", "-M", "trunk")
	writeFile(t, filepath.Join(main, "b.txt"), "b1\n")
	writeFile(t, filepath.Join(main, "old.txt"), "same content for rename\n")
	gitT(t, main, "add", ".")
	gitT(t, main, "commit", "-q", "-m", "base")
	wt = filepath.Join(t.TempDir(), "wt")
	gitT(t, main, "worktree", "add", "-q", "-b", "feat", wt)
	wt, _ = filepath.EvalSymlinks(wt)
	writeFile(t, filepath.Join(wt, "a.txt"), "one\nfrom the branch ```` fence\n")
	gitT(t, wt, "add", ".")
	gitT(t, wt, "commit", "-q", "-m", "branch work")
	writeFile(t, filepath.Join(wt, "staged.txt"), "s\n")
	writeFile(t, filepath.Join(wt, "b.txt"), "b1\nb2\n")
	gitT(t, wt, "add", "staged.txt", "b.txt")
	writeFile(t, filepath.Join(wt, "b.txt"), "b1\nb2\nb3\n")
	gitT(t, wt, "mv", "old.txt", "moved.txt")
	writeFile(t, filepath.Join(wt, "new.txt"), "brand new\x1b[2J\n")
	writeFile(t, filepath.Join(wt, ".env"), "TOKEN=secret\n")
	return main, wt
}

func diffTest(t *testing.T, dir string) (*testCLI, *dirAgentsFake) {
	t.Helper()
	shortConfirm(t)
	tc, sock := socketCLI(t)
	f := &dirAgentsFake{agentsFake: newAgentsFake(t, lines(0, 1)), dir: dir}
	startAgentsServer(t, tc, sock, f)
	return tc, f
}

func TestAgentsDiff(t *testing.T) {
	_, wt := diffRepo(t)
	tc, _ := diffTest(t, wt)
	if err := tc.dispatch("agents", []string{"diff", "%2"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	out := tc.stdout.String()
	for _, want := range []string{
		"web/ui (%2) in " + wt,
		"Branch feat, base trunk (merge base ",
		"): 1 commits, 1 files",
		agentsDataNote,
		"## Committed since trunk",
		"### M  a.txt",
		"`````diff\n@@ -1 +1,2 @@\n one\n+from the branch ```` fence\n`````",
		"## Not committed",
		"### staged A  staged.txt",
		"### staged M  b.txt\n```diff\n@@ -1 +1,2 @@\n b1\n+b2\n```",
		"### unstaged M  b.txt\n```diff\n@@ -1,2 +1,3 @@\n b1\n b2\n+b3\n```",
		"### staged R  old.txt -> moved.txt",
		"### untracked  new.txt\n```diff\n@@ -0,0 +1,1 @@\n+brand new[2J\n```",
		"### untracked (sensitive file, diff not shown)  .env",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("diff misses %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "TOKEN") || strings.Contains(out, "\x1b") {
		t.Errorf("secret or escape printed:\n%s", out)
	}
	// --stat: names only.
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"diff", "web/ui", "--stat", "--base", "trunk"}); err != nil {
		t.Fatal(err)
	}
	out = tc.stdout.String()
	if !strings.Contains(out, "M  a.txt") || !strings.Contains(out, "unstaged M  b.txt") || strings.Contains(out, "```") || strings.Contains(out, agentsDataNote) {
		t.Errorf("stat:\n%s", out)
	}
	// The budget spent: the rest is named by --stat.
	budget := agentsDiffBudget
	t.Cleanup(func() { agentsDiffBudget = budget })
	agentsDiffBudget = 1
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"diff", "%2"}); err != nil {
		t.Fatal(err)
	}
	if out := tc.stdout.String(); !strings.Contains(out, "... 6 more files: termote agents diff %2 --stat") || !strings.Contains(out, "(cut short at 0 KB") || strings.Contains(out, "staged.txt") {
		t.Errorf("budget:\n%s", out)
	}
	// A base that is not a branch name is refused.
	if err := tc.dispatch("agents", []string{"diff", "%2", "--base", "-x"}); err == nil || !strings.Contains(err.Error(), "(invalid_base)") {
		t.Errorf("bad base: %v", err)
	}
	for _, args := range [][]string{{"diff"}, {"diff", "%1", "%2"}, {"diff", "%2", "--nope"}} {
		if err := tc.dispatch("agents", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
}

// In the main worktree there is no base to compare with by default: the
// uncommitted part is still shown.
func TestAgentsDiffMainWorktree(t *testing.T) {
	main, _ := diffRepo(t)
	writeFile(t, filepath.Join(main, "a.txt"), "one\nmain edit\n")
	tc, _ := diffTest(t, main)
	if err := tc.dispatch("agents", []string{"diff", "%2"}); err != nil {
		t.Fatal(err)
	}
	out := tc.stdout.String()
	if !strings.Contains(out, "Committed: unknown (") || !strings.Contains(out, "--base <branch>") || !strings.Contains(out, "### unstaged M  a.txt") ||
		strings.Contains(out, "## Committed since") {
		t.Errorf("main:\n%s", out)
	}
}

func TestAgentsDiffNotRepo(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	tc, _ := diffTest(t, dir)
	if err := tc.dispatch("agents", []string{"diff", "%2"}); err != nil || !strings.Contains(tc.stdout.String(), "not a git repository") {
		t.Errorf("plain dir: %v %s", err, tc.stdout)
	}
}

// A status letter is server text like a path: printed without control
// characters, in --stat and in the full diff.
func TestAgentsDiffStatusLabelPlain(t *testing.T) {
	tc, s := scriptedCLI(t)
	s.set("GET /api/mux/snapshot", jsonAnswer(oneAgent("idle")))
	s.set("GET /api/mux/panes/%1/files/changes", jsonAnswer(changesResponse{Root: "/repo", IsRepo: true,
		Entries: []changeEntry{{Path: "b.txt", Staged: "M\x1b[2J", Unstaged: "D\u202e"}}}))
	s.set("GET /api/mux/panes/%1/files/branch", jsonAnswer(branchResponse{Root: "/repo", IsRepo: true, Branch: "feat",
		Base: "trunk", MergeBase: "abc", Commits: 1, Files: []commitFile{{Path: "a.txt", Status: "M\x1b]0;x\x07"}}}))
	noChange := jsonAnswer(diffResponse{Root: "/repo", Path: "a.txt"})
	s.set("GET /api/mux/panes/%1/files/diff", noChange)
	s.set("GET /api/mux/panes/%1/files/branch/diff", noChange)
	for _, args := range [][]string{{"diff", "%1", "--stat"}, {"diff", "%1"}} {
		tc.stdout.Reset()
		if err := tc.dispatch("agents", args); err != nil {
			t.Fatalf("%v: %v (%s)", args, err, tc.stderr)
		}
		out := tc.stdout.String()
		if strings.ContainsAny(out, "\x1b\x07\u202e") {
			t.Errorf("%v printed a control or bidi character:\n%q", args, out)
		}
		for _, want := range []string{"M]0;x  a.txt", "staged M[2J  b.txt", "unstaged D  b.txt"} {
			if !strings.Contains(out, want) {
				t.Errorf("%v misses %q:\n%q", args, want, out)
			}
		}
	}
}
