package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// windowsRoots is a resolver that checks repositories as on Windows, the
// temp dir standing in for a drive.
func windowsRoots(t *testing.T, repo string) *rootResolver {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the temp dir stands in for a drive only off Windows")
	}
	rr := newTestRoots()
	rr.windows = true
	rr.placeDirs = []string{filepath.Dir(repo)}
	return rr
}

// An untracked folder whose .git file names a share makes status look at
// that share, so a heavy git command in the work tree is refused; a light
// one, which does not look into untracked folders, still runs.
func TestGitRefusesNestedRepoOffDrive(t *testing.T) {
	ctx := context.Background()
	repo := tempDirReal(t)
	gitInit(t, repo)
	writeFile(t, filepath.Join(repo, "a", "sub", ".git"), "gitdir: //termote-test.invalid/s/x\n")
	rr := windowsRoots(t, repo)
	for _, root := range []string{repo, filepath.Join(repo, "a")} {
		if _, _, err := rr.git.output(ctx, gitCall{root: root, heavy: true}, gitStatusArgs...); !errors.Is(err, errDirNotAvailable) {
			t.Errorf("status in %s: err = %v", root, err)
		}
	}
	if _, _, err := rr.git.output(ctx, gitCall{root: repo}, "rev-parse", "--git-dir"); err != nil {
		t.Errorf("rev-parse: %v", err)
	}
	// Off Windows nothing is walked.
	rr.windows = false
	if _, _, err := rr.git.output(ctx, gitCall{root: repo, heavy: true}, gitStatusArgs...); err != nil {
		t.Errorf("status off Windows: %v", err)
	}
}

func TestNestedRepoRefused(t *testing.T) {
	const g = ".git"
	for _, c := range []struct {
		name    string
		files   map[string]string
		refused bool
	}{
		{"none", map[string]string{"a/b.txt": "x"}, false},
		{"clean nested gitfile", map[string]string{"sub/" + g: "gitdir: ../other\n", "other/HEAD": "ref: refs/heads/main\n", "other/objects/": "", "other/refs/": ""}, false},
		{"nested gitfile off a drive", map[string]string{"a/b/sub/" + g: "gitdir: //h/s/x\n"}, true},
		{"nested git dir naming a share", withFiles(gitDirFiles("sub/"+g+"/", ""), "sub/"+g+"/commondir", "//h/s/x\n"), true},
		{"nested git dir config", gitDirFiles("sub/"+g+"/", "[core]\n\tworktree = //h/s\n"), true},
		{"inside a .git entry", map[string]string{g + "/x/" + g: "gitdir: //h/s/x\n"}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := fakeRepo(t, withFiles(gitDirFiles(g+"/", "[core]\n\tbare = false\n"), mapPairs(c.files)...))
			if err := windowsRoots(t, dir).nestedRepoRefused(dir); (err != nil) != c.refused {
				t.Errorf("err = %v, want refused %v", err, c.refused)
			}
		})
	}
}

// A link to a folder is not followed (git does not follow it either), and
// a folder outside any work tree is not walked.
func TestNestedRepoLinksAndNoRepo(t *testing.T) {
	outside := tempDirReal(t)
	writeFile(t, filepath.Join(outside, "sub", ".git"), "gitdir: //h/s/x\n")
	if err := windowsRoots(t, outside).nestedRepoRefused(outside); err != nil {
		t.Errorf("no work tree: %v", err)
	}
	dir := fakeRepo(t, gitDirFiles(".git/", "[core]\n\tbare = false\n"))
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if err := windowsRoots(t, dir).nestedRepoRefused(dir); err != nil {
		t.Errorf("a linked folder was walked: %v", err)
	}
}

// A work tree with more folders than repoTreeMaxDirs is refused.
func TestNestedRepoTreeTooLarge(t *testing.T) {
	files := gitDirFiles(".git/", "[core]\n\tbare = false\n")
	for i := range repoTreeMaxDirs {
		files[fmt.Sprintf("d%d/", i)] = ""
	}
	dir := fakeRepo(t, files)
	if err := windowsRoots(t, dir).nestedRepoRefused(dir); !errors.Is(err, errRepoTreeTooLarge) {
		t.Errorf("err = %v", err)
	}
}

// mapPairs lists m as withFiles takes it.
func mapPairs(m map[string]string) []string {
	var out []string
	for k, v := range m {
		out = append(out, k, v)
	}
	return out
}

// A clean work tree runs status; a folder git cannot read is passed by, as
// git passes it by; a path whose parent is a file is an error.
func TestNestedRepoCleanUnreadableAndErrors(t *testing.T) {
	ctx := context.Background()
	repo := tempDirReal(t)
	gitInit(t, repo)
	writeFile(t, filepath.Join(repo, "a", "b.txt"), "x")
	rr := windowsRoots(t, repo)
	if _, _, err := rr.git.output(ctx, gitCall{root: repo, heavy: true}, gitStatusArgs...); err != nil {
		t.Errorf("status in a clean work tree: %v", err)
	}
	locked := filepath.Join(repo, "locked")
	writeFile(t, filepath.Join(locked, "x.txt"), "x")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0o755) })
	if os.Getuid() != 0 {
		if err := rr.nestedRepoRefused(repo); err != nil {
			t.Errorf("an unreadable folder: %v", err)
		}
	}
	if _, err := rr.workTreeTop(filepath.Join(repo, "a", "b.txt", "c")); err == nil {
		t.Error("a path under a file found a work tree")
	}
}
