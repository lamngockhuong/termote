package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// findPaths runs a find and returns the paths it answers.
func (fx *linkedFixture) findPaths(t *testing.T, req *http.Request) []string {
	t.Helper()
	code, body := fx.get(t, req)
	if code != http.StatusOK {
		t.Fatalf("find = %d %v", code, body)
	}
	var paths []string
	for _, r := range body["results"].([]any) {
		paths = append(paths, r.(map[string]any)["path"].(string))
	}
	return paths
}

// Links git does not track (one ignored by the worktree, one not) into a
// directory of the main checkout: what it holds is found and searched as the
// main checkout's git sees it.
func linkDirs(t *testing.T, fx *linkedFixture) {
	t.Helper()
	writeFile(t, filepath.Join(fx.main, ".gitignore"), "*.log\n")
	writeFile(t, filepath.Join(fx.main, "plans", "debug.log"), "needle in a log\n")
	writeFile(t, filepath.Join(fx.main, "plans", "deep", "notes.md"), "needle deep\n")
	writeFile(t, filepath.Join(fx.wt, ".gitignore"), "records\n")
	for _, link := range []string{"records", "docs"} {
		if err := os.Symlink(filepath.Join(fx.main, "plans"), filepath.Join(fx.wt, link)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestFindLinkedDirs(t *testing.T) {
	fx := newLinkedFixture(t)
	linkDirs(t, fx)
	got := fx.findPaths(t, fullRequest("/api/mux/panes/0/files/find?q=notes"))
	for _, want := range []string{"records/deep/notes.md", "docs/deep/notes.md"} {
		if !slices.Contains(got, want) {
			t.Errorf("find notes = %v, want %s", got, want)
		}
	}
	// Ignored by the main checkout: only with ignored files
	if got := fx.findPaths(t, fullRequest("/api/mux/panes/0/files/find?q=debug&fresh=1")); slices.Contains(got, "docs/debug.log") {
		t.Errorf("an ignored file of the main checkout found without ignored = %v", got)
	}
	if got := fx.findPaths(t, fullRequest("/api/mux/panes/0/files/find?q=debug&ignored=1")); !slices.Contains(got, "docs/debug.log") {
		t.Errorf("find debug with ignored = %v", got)
	}
	// A view-only client finds nothing through the links
	code, body := fx.get(t, viewRequest("GET", "/api/mux/panes/0/files/find?q=notes", ""))
	if code != http.StatusOK || strings.Contains(fmt.Sprint(body), "notes.md") {
		t.Errorf("view find = %d %v", code, body)
	}
}

func TestSearchLinkedDirs(t *testing.T) {
	fx := newLinkedFixture(t)
	linkDirs(t, fx)
	code, body := fx.get(t, fullRequest("/api/mux/panes/0/files/search?q=needle"))
	if code != http.StatusOK {
		t.Fatalf("search = %d %v", code, body)
	}
	var paths []string
	for _, f := range body["files"].([]any) {
		paths = append(paths, f.(map[string]any)["path"].(string))
	}
	// The ignored log is not searched; the links' files are, under each link.
	if want := []string{"docs/deep/notes.md", "records/deep/notes.md"}; !slices.Equal(paths, want) {
		t.Errorf("search = %v, want %v", paths, want)
	}
	code, body = fx.get(t, viewRequest("GET", "/api/mux/panes/0/files/search?q=needle", ""))
	if code != http.StatusOK || strings.Contains(fmt.Sprint(body), "notes.md") {
		t.Errorf("view search = %d %v", code, body)
	}
}

// What findLinkedDirs passes over, and its cap.
func TestFindLinkedDirsEdges(t *testing.T) {
	fx := newLinkedFixture(t)
	f := &filesAPI{git: newGitRunner()}
	root := filesRoot{Root: fx.wt, IsRepo: true}
	writeFile(t, filepath.Join(fx.wt, "untracked.md"), "x\n")
	writeFile(t, filepath.Join(fx.wt, "newdir", "a.md"), "x\n")
	for link, target := range map[string]string{
		"to-file":    filepath.Join(fx.main, "README.md"),
		"to-outside": fx.outside,
		"a":          filepath.Join(fx.main, "plans"),
		"b":          filepath.Join(fx.main, "plans"),
	} {
		if err := os.Symlink(target, filepath.Join(fx.wt, link)); err != nil {
			t.Fatal(err)
		}
	}
	dirs, incomplete := f.findLinkedDirs(t.Context(), root)
	if incomplete || len(dirs) != 2 || dirs[0].rel != "a" || dirs[1].rel != "b" || dirs[0].to.rel != "plans" || dirs[0].safeDir != "" {
		t.Errorf("findLinkedDirs = %+v %v", dirs, incomplete)
	}
	// Trusted at the root: trusted in the other work tree too
	trusted := root
	trusted.SafeDir = fx.wt
	if dirs, _ := f.findLinkedDirs(t.Context(), trusted); len(dirs) != 2 || dirs[0].safeDir != fx.main {
		t.Errorf("trusted = %+v", dirs)
	}
	// git failing once the work trees are known: no error, a list marked
	// incomplete
	f.worktrees = newTTLCache[[]string](time.Minute)
	f.worktreeRoots(t.Context(), root)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if dirs, incomplete := f.findLinkedDirs(ctx, root); len(dirs) != 0 || !incomplete {
		t.Errorf("git failing = %+v %v", dirs, incomplete)
	}
	f.worktrees = nil
	old := maxLinkedDirs
	maxLinkedDirs = 1
	t.Cleanup(func() { maxLinkedDirs = old })
	if dirs, _ := f.findLinkedDirs(t.Context(), root); len(dirs) != 1 {
		t.Errorf("capped = %+v", dirs)
	}
	// No other work tree: nothing to look at
	if dirs, incomplete := f.findLinkedDirs(t.Context(), filesRoot{Root: fx.outside, IsRepo: true}); dirs != nil || incomplete {
		t.Errorf("no repo = %v %v", dirs, incomplete)
	}
}

// findLinkedFiles: a link to a whole work tree, an ignored directory walked,
// excluded names, the path budget, and a work tree it cannot read.
func TestFindLinkedFilesEdges(t *testing.T) {
	fx := newLinkedFixture(t)
	f := &filesAPI{git: newGitRunner()}
	writeFile(t, filepath.Join(fx.main, ".gitignore"), "cache/\nvendor/\n")
	writeFile(t, filepath.Join(fx.main, "plans", "cache", "c.md"), "x\n")
	writeFile(t, filepath.Join(fx.main, "plans", "vendor", "v.md"), "x\n")
	whole := []linkedDir{{rel: "main", to: linkedFile{root: fx.main, rel: "."}}}
	entries, _, incomplete := f.findLinkedFiles(t.Context(), whole, false, nil, findMaxPaths)
	var rels []string
	for _, e := range entries {
		rels = append(rels, e.rel)
	}
	if !slices.Contains(rels, "main/README.md") || !slices.Contains(rels, "main/plans/plan.md") || incomplete {
		t.Errorf("whole work tree = %v %v", rels, incomplete)
	}
	plans := []linkedDir{{rel: "p", to: linkedFile{root: fx.main, rel: "plans"}}}
	ex, _ := parseFindExcludes([]string{"vendor"})
	entries, read, _ := f.findLinkedFiles(t.Context(), plans, true, ex.excludes, findMaxPaths)
	if len(entries) != 1 || entries[0].rel != "p/cache/c.md" || !entries[0].ignored || !slices.Contains(read, "p/cache") {
		t.Errorf("ignored = %+v read %v", entries, read)
	}
	// A link of an excluded name is not walked either
	ex, _ = parseFindExcludes([]string{"p"})
	if entries, _, _ := f.findLinkedFiles(t.Context(), plans, true, ex.excludes, findMaxPaths); len(entries) != 0 {
		t.Errorf("excluded link name = %+v", entries)
	}
	if _, _, incomplete := f.findLinkedFiles(t.Context(), whole, false, nil, 1); !incomplete {
		t.Error("over the budget: not incomplete")
	}
	gone := []linkedDir{{rel: "g", to: linkedFile{root: filepath.Join(fx.main, "gone"), rel: "x"}}}
	if entries, _, incomplete := f.findLinkedFiles(t.Context(), gone, false, nil, findMaxPaths); len(entries) != 0 || !incomplete {
		t.Errorf("gone = %v %v", entries, incomplete)
	}
	if _, err := openInRoot(filepath.Join(fx.main, "gone"), "x"); err == nil {
		t.Error("openInRoot of a missing dir: no error")
	}
}

// A link to a directory below one the main checkout ignores whole: git names
// the ignored ancestor, and only the linked directory is read.
func TestFindLinkedUnderIgnoredDir(t *testing.T) {
	fx := newLinkedFixture(t)
	writeFile(t, filepath.Join(fx.main, ".gitignore"), "hidden/\n")
	writeFile(t, filepath.Join(fx.main, "hidden", "plans", "p.md"), "x\n")
	writeFile(t, filepath.Join(fx.main, "hidden", "other", "p.md"), "x\n")
	if err := os.Symlink(filepath.Join(fx.main, "hidden", "plans"), filepath.Join(fx.wt, "hp")); err != nil {
		t.Fatal(err)
	}
	got := fx.findPaths(t, fullRequest("/api/mux/panes/0/files/find?q=p.md&ignored=1"))
	if !slices.Contains(got, "hp/p.md") || slices.ContainsFunc(got, func(p string) bool { return strings.Contains(p, "other") }) {
		t.Errorf("find under an ignored dir = %v", got)
	}
}
