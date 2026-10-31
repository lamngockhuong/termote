package main

import (
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// ageTree sets every directory under dir, and a repo's index, an hour back,
// so a list built next is not read again for a change made just before it
// (findStampSlack).
func ageTree(t *testing.T, dir string) {
	t.Helper()
	old := time.Now().Add(-time.Hour)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || p == filepath.Join(dir, ".git", "index") {
			return os.Chtimes(p, old, old)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// countBuilds counts the lists built, by kind.
func countBuilds(t *testing.T) func(key string) int {
	t.Helper()
	var mu sync.Mutex
	builds := map[string]int{}
	setFindHook(t, &findBeforeBuild, func(key string) {
		mu.Lock()
		builds[key]++
		mu.Unlock()
	})
	return func(key string) int {
		mu.Lock()
		defer mu.Unlock()
		return builds[key]
	}
}

// A file made, removed or renamed outside Termote shows at the next search;
// a save in place, which changes no directory, keeps the list.
func TestFilesFindSeesChangesMadeOutside(t *testing.T) {
	requireGit(t)
	r := newTestRepo(t)
	writeFile(t, filepath.Join(r, "docs", "old", "keep.md"), "")
	ageTree(t, r)
	setFindHook(t, &findStampEvery, 0)
	fx := newFindFixture(t, r)
	count := countBuilds(t)
	fx.findOK(t, url.Values{"q": {"md"}})
	writeFile(t, filepath.Join(r, "a.txt"), "saved again\n")
	fx.findOK(t, url.Values{"q": {"md"}})
	if count("tracked") != 1 {
		t.Fatalf("tracked built %d times, want 1", count("tracked"))
	}
	// Deep in a directory nothing listed changed but the one holding it
	writeFile(t, filepath.Join(r, "docs", "old", "meeting.md"), "TC-001\n")
	if _, by := fx.findOK(t, url.Values{"q": {"meeting"}}); by["docs/old/meeting.md"] == nil {
		t.Errorf("after a create = %v", by)
	}
	ageTree(t, r)
	if err := os.Rename(filepath.Join(r, "docs", "old", "meeting.md"), filepath.Join(r, "notes.md")); err != nil {
		t.Fatal(err)
	}
	if _, by := fx.findOK(t, url.Values{"q": {"notes"}}); by["notes.md"] == nil {
		t.Errorf("after a rename = %v", by)
	}
	// A directory gone: what it held is gone too
	ageTree(t, r)
	if err := os.RemoveAll(filepath.Join(r, "docs")); err != nil {
		t.Fatal(err)
	}
	fx.findOK(t, url.Values{"q": {"md"}})
	if count("tracked") != 4 {
		t.Errorf("tracked built %d times, want 4", count("tracked"))
	}
}

// Outside a repo the directories the walk read are the stamp; content
// search reads the same list.
func TestFilesSearchSeesFilesMadeOutside(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, "a", "b", "other.md"), "nothing\n")
	ageTree(t, root)
	setFindHook(t, &findStampEvery, 0)
	fx := newFindFixture(t, root)
	count := countBuilds(t)
	if res := fx.searchOK(t, url.Values{"q": {"TC-001"}}); len(res.Files) != 0 {
		t.Fatalf("before = %q", searchPaths(res))
	}
	writeFile(t, filepath.Join(root, "a", "b", "meeting.md"), "TC-001\n")
	if res := fx.searchOK(t, url.Values{"q": {"TC-001"}}); len(res.Files) != 1 || res.Files[0].Path != "a/b/meeting.md" {
		t.Errorf("after = %q", searchPaths(res))
	}
	if n := count("walk\x00"); n != 2 {
		t.Errorf("walk built %d times, want 2", n)
	}
}

// A stamp is checked at most every findStampEvery: until then a search
// takes the list as it is.
func TestFilesFindStampCheckedAtMostEvery(t *testing.T) {
	requireGit(t)
	r := newTestRepo(t)
	ageTree(t, r)
	setFindHook(t, &findStampEvery, time.Hour)
	fx := newFindFixture(t, r)
	count := countBuilds(t)
	fx.findOK(t, url.Values{"q": {"a"}})
	writeFile(t, filepath.Join(r, "later.txt"), "")
	if _, by := fx.findOK(t, url.Values{"q": {"later"}}); len(by) != 0 || count("tracked") != 1 {
		t.Errorf("checked before its time: %v, %d builds", by, count("tracked"))
	}
}

func TestFindStamp(t *testing.T) {
	requireGit(t)
	setFindHook(t, &findStampEvery, 0)
	r := newTestRepo(t)
	writeFile(t, filepath.Join(r, "src", "x.go"), "")
	gitDir := filepath.Join(r, ".git")
	root := filesRoot{Root: r, IsRepo: true, GitDir: gitDir}
	list := findList{entries: []findEntry{newFindEntry("src/x.go", false)}}
	stamp := func() *findStamp { return newFindStamp(time.Now(), root, list) }
	hourAgo := time.Now().Add(-time.Hour)

	var none *findStamp
	if none.changed(r) {
		t.Error("a nil stamp changed")
	}
	// Made just before the build: the first check reads it again
	if s := stamp(); !s.unsure || !s.changed(r) || !s.changed(r) {
		t.Errorf("fresh tree: unsure %v", s.unsure)
	}
	ageTree(t, r)
	if s := stamp(); s.unsure || s.changed(r) || len(s.dirs) != 2 || s.index != filepath.Join(gitDir, "index") {
		t.Errorf("stamp = %+v", s)
	}
	// A directory dated ahead (a clock gone back) is only compared
	ahead := time.Now().Add(time.Hour)
	os.Chtimes(filepath.Join(r, "src"), ahead, ahead)
	if s := stamp(); s.unsure || s.changed(r) {
		t.Errorf("a time ahead: unsure %v", s.unsure)
	}
	ageTree(t, r)

	setFindHook(t, &findMaxStampDirs, 1)
	if s := stamp(); s != nil {
		t.Errorf("past the cap = %+v, want nil", s)
	}
	read := list
	read.read = []string{"src", "src/y"}
	if s := newFindStamp(time.Now(), root, read); s != nil {
		t.Errorf("walk past the cap = %+v, want nil", s)
	}
	findMaxStampDirs = 20_000
	// A directory the walk read but gone before the stamp, or a root that
	// cannot be opened, leaves it unsure
	if s := newFindStamp(time.Now(), root, read); !s.unsure {
		t.Error("a directory gone before the stamp is sure")
	}
	if s := newFindStamp(time.Now(), filesRoot{Root: filepath.Join(r, "missing")}, list); !s.unsure || s.index != "" {
		t.Errorf("no root: %+v", s)
	}

	// git changes the index when what it tracks changes
	s := stamp()
	gitT(t, r, "add", ".")
	if !s.changed(r) {
		t.Error("index change not seen")
	}
	// A repo with nothing added has no index yet; one that cannot be read
	// is a change
	os.Remove(filepath.Join(gitDir, "index"))
	ageTree(t, r)
	if s := stamp(); s.unsure || s.changed(r) {
		t.Error("a missing index changed")
	}
	bad := stamp()
	bad.index = filepath.Join(gitDir, "in\x00dex")
	if !bad.changed(r) {
		t.Error("an unreadable index did not change")
	}
	// A directory replaced by a file, or the root gone
	s = stamp()
	os.RemoveAll(filepath.Join(r, "src"))
	writeFile(t, filepath.Join(r, "src"), "")
	os.Chtimes(r, hourAgo, hourAgo)
	if !s.changed(r) {
		t.Error("a directory turned file not seen")
	}
	if s := newFindStamp(time.Now(), filesRoot{Root: r}, findList{}); s.unsure || !s.changed(filepath.Join(r, "missing")) {
		t.Errorf("a root gone not seen: unsure %v", s.unsure)
	}
}

func TestTTLCacheForgetIf(t *testing.T) {
	c := newTTLCache[int](time.Hour)
	runs := 0
	get := func(key string, v int) int {
		got, _ := c.do(key, func() (int, error) { runs++; return v, nil })
		return got
	}
	get("a", 1)
	c.forgetIf("a", func(v int) bool { return v == 2 })
	c.forgetIf("none", func(int) bool { return true })
	if get("a", 3) != 1 || runs != 1 {
		t.Errorf("kept an entry it should have dropped: runs %d", runs)
	}
	c.forgetIf("a", func(v int) bool { return v == 1 })
	if get("a", 3) != 3 || runs != 2 {
		t.Errorf("forgetIf did not drop: runs %d", runs)
	}
	// A call in flight is kept for those waiting on it
	started, release := make(chan struct{}), make(chan struct{})
	go c.do("b", func() (int, error) { close(started); <-release; return 4, nil })
	<-started
	c.forgetIf("b", func(int) bool { return true })
	close(release)
	if get("b", 5) != 4 {
		t.Error("forgetIf dropped a call in flight")
	}
}
