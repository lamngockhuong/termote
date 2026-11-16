package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// alternatesChain is a repository whose alternates lead through o1..on, the
// file of o<last> naming target; the repository's own file is the first.
func alternatesChain(n int, target string) map[string]string {
	const g = ".git/"
	files := withFiles(gitDirFiles(g, "[core]\n\tbare = false\n"), g+"objects/info/alternates", "../../o1/objects\n")
	for i := 1; i <= n; i++ {
		next := fmt.Sprintf("../../o%d/objects\n", i+1)
		if i == n {
			next = target + "\n"
		}
		files = withFiles(files, fmt.Sprintf("o%d/objects/info/alternates", i), next)
	}
	return files
}

// git looks at the paths of every alternates file up to the sixth of a
// chain (depth 5), and refuses only a deeper file's.
func TestRepoAlternatesDepthAsGit(t *testing.T) {
	for _, c := range []struct {
		n       int // alternates files after the repository's own
		refused bool
	}{
		{4, true}, // the share in the fifth file
		{5, true}, // in the sixth, which git still follows
		{6, false},
	} {
		dir := fakeRepo(t, alternatesChain(c.n, "//h/s/objects"))
		if err := newTestRoots().repoConfigRefused(dir); (err != nil) != c.refused {
			t.Errorf("share in file %d: err = %v, want refused %v", c.n+1, err, c.refused)
		}
	}
}

// An alternates directory listed many times over is checked once; includes
// git reads as often as they are named, and a repository naming more files
// than repoFollowMax is refused, so the check ends quickly either way.
func TestRepoFollowBounded(t *testing.T) {
	const g = ".git/"
	// withFiles adds to the map it is given: each case starts from its own.
	base := func() map[string]string { return gitDirFiles(g, "[core]\n\tbare = false\n") }
	loop := withFiles(base(), g+"objects/info/alternates", strings.Repeat("../../loop/objects\n", 40),
		"loop/objects/info/alternates", strings.Repeat("../../loop/objects\n", 40))
	include := gitDirFiles(g, "[core]\n\tbare = false\n"+strings.Repeat("[include]\n\tpath = ../a.cfg\n", 40))
	include = withFiles(include, "a.cfg", strings.Repeat("[include]\n\tpath = b.cfg\n", 40),
		"b.cfg", strings.Repeat("[include]\n\tpath = c.cfg\n", 40), "c.cfg", "[a]\n\tk = v\n")
	for name, c := range map[string]struct {
		files map[string]string
		want  error
	}{"alternates": {loop, nil}, "includes": {include, errRepoTooManyFiles}} {
		start := time.Now()
		if err := newTestRoots().repoConfigRefused(fakeRepo(t, c.files)); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", name, err, c.want)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Errorf("%s: the check took %v", name, d)
		}
	}
	// A share behind a file already checked at a shallower depth is still
	// refused the first time.
	shared := withFiles(loop, "loop/objects/info/alternates", "//h/s/objects\n")
	if err := newTestRoots().repoConfigRefused(fakeRepo(t, shared)); err == nil {
		t.Error("a share behind a repeated alternates line passed")
	}
	// Many distinct files.
	var b strings.Builder
	for i := range repoFollowMax + 1 {
		fmt.Fprintf(&b, "../../o%d/objects\n", i)
	}
	many := withFiles(base(), g+"objects/info/alternates", b.String())
	for i := range repoFollowMax + 1 {
		many = withFiles(many, fmt.Sprintf("o%d/objects/info/alternates", i), "")
	}
	if err := newTestRoots().repoConfigRefused(fakeRepo(t, many)); !errors.Is(err, errRepoTooManyFiles) {
		t.Errorf("more files than the limit: %v", err)
	}
}
