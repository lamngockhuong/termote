//go:build !windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fifoWait bounds a git command in these tests: far below gitTimeout, far
// above what git status takes in a small repository.
const fifoWait = 3 * time.Second

// fifoAt makes a FIFO at p, its directory included, which nothing writes
// to: a reader opening it blocks.
func fifoAt(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	mkfifo(t, filepath.Dir(p), filepath.Base(p), false)
}

// A file the repository names that is a FIFO (git 2.34 blocks opening each
// of these until the timeout) makes the root a plain directory, found at
// once: no git status runs in it to wait on the FIFO.
func TestRepoNamingAFifoIsBrowsedWithoutGit(t *testing.T) {
	requireGit(t)
	gitDir := func(r string) string { return filepath.Join(r, ".git") }
	for name, setup := range map[string]func(t *testing.T, repo string){
		"core.excludesFile": func(t *testing.T, repo string) {
			fifoAt(t, filepath.Join(repo, "ex"))
			gitT(t, repo, "config", "core.excludesFile", filepath.Join(repo, "ex"))
		},
		"core.excludesFile, relative": func(t *testing.T, repo string) {
			fifoAt(t, filepath.Join(repo, "ex"))
			gitT(t, repo, "config", "core.excludesFile", "ex")
		},
		"core.attributesFile": func(t *testing.T, repo string) {
			fifoAt(t, filepath.Join(repo, "at"))
			gitT(t, repo, "config", "core.attributesFile", filepath.Join(repo, "at"))
		},
		"info/exclude": func(t *testing.T, repo string) {
			os.Remove(filepath.Join(gitDir(repo), "info", "exclude"))
			fifoAt(t, filepath.Join(gitDir(repo), "info", "exclude"))
		},
		"info/attributes": func(t *testing.T, repo string) {
			fifoAt(t, filepath.Join(gitDir(repo), "info", "attributes"))
		},
		".gitignore":     func(t *testing.T, repo string) { fifoAt(t, filepath.Join(repo, ".gitignore")) },
		".gitattributes": func(t *testing.T, repo string) { fifoAt(t, filepath.Join(repo, ".gitattributes")) },
		"core.excludesFile, a link to a FIFO": func(t *testing.T, repo string) {
			f := filepath.Join(t.TempDir(), "f")
			fifoAt(t, f)
			if err := os.Symlink(f, filepath.Join(repo, "ex")); err != nil {
				t.Fatal(err)
			}
			gitT(t, repo, "config", "core.excludesFile", "ex")
		},
	} {
		t.Run(name, func(t *testing.T) {
			repo := newTestRepo(t)
			setup(t, repo)
			rr := newRootResolver(newGitRunner())
			ctx, cancel := context.WithTimeout(context.Background(), fifoWait)
			defer cancel()
			start := time.Now()
			root, err := rr.resolve(ctx, repo)
			if err != nil || root.IsRepo || root.Root != repo || root.GitDir == "" {
				t.Fatalf("root = %+v, %v; want the plain directory, its git dir still named", root, err)
			}
			if d := time.Since(start); d > fifoWait/2 {
				t.Errorf("resolving took %s", d)
			}
		})
	}
	// A linked worktree reads info/exclude from the shared git dir.
	t.Run("info/exclude of a linked worktree", func(t *testing.T) {
		repo := newTestRepo(t)
		wt := filepath.Join(t.TempDir(), "wt")
		gitT(t, repo, "worktree", "add", "-q", wt)
		os.Remove(filepath.Join(gitDir(repo), "info", "exclude"))
		fifoAt(t, filepath.Join(gitDir(repo), "info", "exclude"))
		wt, _ = filepath.EvalSymlinks(wt)
		if root, err := newRootResolver(newGitRunner()).resolve(context.Background(), wt); err != nil || root.IsRepo {
			t.Fatalf("linked worktree = %+v, %v; want the plain directory", root, err)
		}
	})
	// Still a repository: regular files, /dev/null (a common way to turn the
	// global ignore file off; git reads it at once), a directory, and an
	// in-tree .gitignore that links to a FIFO (git does not follow it).
	repo := newTestRepo(t)
	writeFile(t, filepath.Join(repo, ".gitattributes"), "x\n")
	writeFile(t, filepath.Join(repo, "ex"), "y\n")
	gitT(t, repo, "config", "core.excludesFile", "ex")
	// The user's own global config (HOME is the test's, see requireGit;
	// GIT_CONFIG_GLOBAL is stripped from the server's git).
	writeFile(t, filepath.Join(os.Getenv("HOME"), ".gitconfig"), "[core]\n\tattributesFile = /dev/null\n")
	if err := os.Mkdir(filepath.Join(gitDir(repo), "info", "attributes"), 0o700); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(t.TempDir(), "f")
	fifoAt(t, f)
	if err := os.Symlink(f, filepath.Join(repo, ".gitignore")); err != nil {
		t.Fatal(err)
	}
	root, err := newRootResolver(newGitRunner()).resolve(context.Background(), repo)
	if err != nil || !root.IsRepo {
		t.Fatalf("regular files, /dev/null, a directory, an in-tree link: %+v, %v", root, err)
	}
}

// A FIFO deeper in the tree (a directory's own .gitignore, tracked or not)
// cannot be found before git walks there: the root's git status waits on it
// until the timeout, but holds one of the server's slots at most, so another
// root's git status is not delayed by it.
func TestRepoWithANestedFifoHoldsOneGitSlot(t *testing.T) {
	requireGit(t)
	bad := newTestRepo(t)
	fifoAt(t, filepath.Join(bad, "new", ".gitignore"))
	good := newTestRepo(t)
	g := newGitRunner()
	g.timeout = fifoWait
	status := func(root string) (time.Duration, error) {
		start := time.Now()
		_, _, err := g.output(context.Background(), gitCall{root: root, heavy: true, noBackoff: true}, gitStatusArgs...)
		return time.Since(start), err
	}
	var wg sync.WaitGroup
	for range gitMaxRunning {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := status(bad); err != errGitTimeout {
				t.Errorf("status of the repository with a FIFO = %v, want a timeout", err)
			}
		}()
	}
	// Wait until one call of bad runs git and the other waits for its root.
	for deadline := time.Now().Add(fifoWait / 2); ; time.Sleep(10 * time.Millisecond) {
		g.mu.Lock()
		s := g.rootSlots[bad]
		started := s != nil && s.users == gitMaxRunning && len(g.sem) == 1
		g.mu.Unlock()
		if started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the calls of the repository with a FIFO did not start")
		}
	}
	d, err := status(good)
	if err != nil || d > fifoWait/2 {
		t.Errorf("status of another root = %s, %v; want it at once", d, err)
	}
	// A tryOnly call of bad (the overview's) does not take the free slot.
	if _, _, err := g.output(context.Background(), gitCall{root: bad, heavy: true, noBackoff: true, tryOnly: true}, gitStatusArgs...); err != errGitBusy {
		t.Errorf("tryOnly status of the repository with a FIFO = %v, want busy", err)
	}
	wg.Wait()
}

// A call that waited for its root's slot behind one that timed out does not
// run git again: the root is backing off. A write is not held behind the
// root's reads.
func TestRootSlotWaitersAndWrites(t *testing.T) {
	requireGit(t)
	bad := newTestRepo(t)
	fifoAt(t, filepath.Join(bad, "new", ".gitignore"))
	g := newGitRunner()
	g.timeout = fifoWait
	var wg sync.WaitGroup
	start := time.Now()
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := g.output(context.Background(), gitCall{root: bad, heavy: true}, gitStatusArgs...); err != errGitTimeout {
				t.Errorf("status = %v, want a timeout", err)
			}
		}()
	}
	wg.Wait()
	if d := time.Since(start); d > fifoWait*3/2 {
		t.Errorf("two statuses took %s: the second ran git after the first timed out", d)
	}

	good := newTestRepo(t)
	release, ok := g.takeRootSlot(context.Background(), good)
	if !ok {
		t.Fatal("root slot not taken")
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), fifoWait/2)
	defer cancel()
	if _, _, err := g.output(ctx, gitCall{root: good, heavy: true, write: true, noBackoff: true}, "rev-parse", "HEAD"); err != nil {
		t.Errorf("a write behind the root's read = %v, want it run", err)
	}
}
