package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// testTrash is a trash store in a temp dir with a clock the test moves.
type testTrash struct {
	*trashStore
	clock time.Time
}

func newTestTrash(t *testing.T) *testTrash {
	t.Helper()
	s, err := newTrashStore(filepath.Join(t.TempDir(), "trash"))
	if err != nil {
		t.Fatal(err)
	}
	tt := &testTrash{trashStore: s, clock: time.Now()}
	s.now = func() time.Time { return tt.clock }
	return tt
}

// add puts a payload of size bytes and its record, deleted at the given
// time, and returns its id.
func (tt *testTrash) add(t *testing.T, deletedAt time.Time, size int) string {
	t.Helper()
	id := randomHex(16)
	if err := os.WriteFile(filepath.Join(tt.dir, id), make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
	tt.mu.Lock()
	defer tt.mu.Unlock()
	if err := tt.writeRecordLocked(id, trashRecord{Root: "/r", Path: id, Kind: "file", DeletedAt: deletedAt, Size: int64(size)}); err != nil {
		t.Fatal(err)
	}
	return id
}

func (tt *testTrash) sweep() {
	tt.mu.Lock()
	tt.sweepLocked()
	tt.mu.Unlock()
}

func (tt *testTrash) has(name string) bool {
	_, err := os.Lstat(filepath.Join(tt.dir, name))
	return err == nil
}

func TestTrashSweepAge(t *testing.T) {
	tt := newTestTrash(t)
	old := tt.add(t, tt.clock.Add(-trashMaxAge-time.Minute), 1)
	young := tt.add(t, tt.clock.Add(-time.Hour), 1)
	// A payload whose mtime is a month old was deleted just now: age is
	// the record's, never the file's.
	stale := tt.add(t, tt.clock, 1)
	month := tt.clock.Add(-30 * 24 * time.Hour)
	if err := os.Chtimes(filepath.Join(tt.dir, stale), month, month); err != nil {
		t.Fatal(err)
	}
	dir := randomHex(16)
	tt.mu.Lock()
	tt.writeRecordLocked(dir, trashRecord{Kind: "dir", DeletedAt: tt.clock.Add(-trashMaxAge)})
	tt.mu.Unlock()
	tt.sweep()
	if tt.has(dir + ".json") {
		t.Error("old directory record stayed")
	}
	if tt.has(old) || tt.has(old+".json") {
		t.Error("entry past trashMaxAge stayed")
	}
	for _, id := range []string{young, stale} {
		if !tt.has(id) || !tt.has(id+".json") {
			t.Errorf("%s removed", id)
		}
	}
}

func TestTrashSweepQuota(t *testing.T) {
	tt := newTestTrash(t)
	tt.maxTotal = 25
	oldest := tt.add(t, tt.clock.Add(-3*time.Hour), 10)
	older := tt.add(t, tt.clock.Add(-2*time.Hour), 10)
	recent := tt.add(t, tt.clock.Add(-time.Minute), 10)
	tt.sweep()
	if tt.has(oldest) || !tt.has(older) || !tt.has(recent) {
		t.Errorf("quota: oldest=%v older=%v recent=%v", tt.has(oldest), tt.has(older), tt.has(recent))
	}
	// Never one younger than trashMinAge, even over quota.
	tt.maxTotal = 1
	tt.sweep()
	if tt.has(older) || !tt.has(recent) {
		t.Errorf("min age: older=%v recent=%v", tt.has(older), tt.has(recent))
	}
}

func TestTrashSweepOrphansAndStrangers(t *testing.T) {
	tt := newTestTrash(t)
	write := func(name string) {
		if err := os.WriteFile(filepath.Join(tt.dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	payload := strings.Repeat("a", 32)
	write(payload) // no record
	record := strings.Repeat("b", 32)
	tt.mu.Lock()
	tt.writeRecordLocked(record, trashRecord{Kind: "file", DeletedAt: tt.clock}) // no payload
	tt.mu.Unlock()
	part := strings.Repeat("c", 32) + ".json.part"
	write(part)
	bad := strings.Repeat("d", 32) + ".json"
	write(bad) // does not parse
	// Names the store never makes (upper case: no other name here differs
	// only in case, which a case-insensitive file system would merge), a
	// directory and a symlink under a payload's name: never touched.
	write("notes.txt")
	write(strings.Repeat("C", 32))
	dir := strings.Repeat("e", 32)
	writeFile(t, filepath.Join(tt.dir, dir, "inner"), "keep")
	link := strings.Repeat("f", 32)
	if runtime.GOOS != "windows" {
		if err := os.Symlink(filepath.Join(tt.dir, dir), filepath.Join(tt.dir, link)); err != nil {
			t.Fatal(err)
		}
	}
	tt.sweep()
	for _, n := range []string{payload, record + ".json", part, bad} {
		if !tt.has(n) {
			t.Errorf("%s removed when first seen", n)
		}
	}
	tt.clock = tt.clock.Add(trashOrphanAge)
	tt.sweep()
	for _, n := range []string{payload, record + ".json", part, bad} {
		if tt.has(n) {
			t.Errorf("%s stayed past trashOrphanAge", n)
		}
	}
	for _, n := range []string{"notes.txt", strings.Repeat("C", 32), filepath.Join(dir, "inner")} {
		if !tt.has(n) {
			t.Errorf("%s removed", n)
		}
	}
	if runtime.GOOS != "windows" && !tt.has(link) {
		t.Error("symlink removed")
	}
	if len(tt.firstSeen) != 0 {
		t.Errorf("firstSeen kept %v", tt.firstSeen)
	}
	// A name that went away before its grace period ended is forgotten.
	write(payload)
	tt.sweep()
	os.Remove(filepath.Join(tt.dir, payload))
	tt.sweep()
	if len(tt.firstSeen) != 0 {
		t.Errorf("firstSeen after removal = %v", tt.firstSeen)
	}
}

// A restore through link + unlink that died in between leaves the payload
// as a second link of the restored file: the sweep removes only that.
func TestTrashSweepRestoredLink(t *testing.T) {
	tt := newTestTrash(t)
	root := plainDir(t)
	id := randomHex(16)
	writeFile(t, filepath.Join(tt.dir, id), "data")
	if err := os.Link(filepath.Join(tt.dir, id), filepath.Join(root, "back.txt")); err != nil {
		t.Skipf("no hard links: %v", err)
	}
	tt.mu.Lock()
	tt.writeRecordLocked(id, trashRecord{Root: root, Path: "back.txt", Kind: "file", DeletedAt: tt.clock})
	tt.mu.Unlock()
	tt.sweep()
	if tt.has(id) || tt.has(id+".json") {
		t.Error("restored link stayed in the trash")
	}
	if readText(t, filepath.Join(root, "back.txt")) != "data" {
		t.Error("restored file lost")
	}
}

func TestTrashStoreRefusesBadDir(t *testing.T) {
	if _, err := newTrashStore(""); err == nil {
		t.Error("empty dir accepted")
	}
	file := filepath.Join(t.TempDir(), "f")
	writeFile(t, file, "")
	if _, err := newTrashStore(file); err == nil {
		t.Error("file accepted")
	}
	if _, err := newTrashStore(filepath.Join(file, "sub")); err == nil {
		t.Error("dir under a file accepted")
	}
	if runtime.GOOS != "windows" {
		real := t.TempDir()
		link := filepath.Join(t.TempDir(), "link")
		if err := os.Symlink(real, link); err != nil {
			t.Fatal(err)
		}
		if _, err := newTrashStore(link); err == nil {
			t.Error("symlink accepted")
		}
	}
}

func TestTrashRecordErrors(t *testing.T) {
	tt := newTestTrash(t)
	tt.mu.Lock()
	defer tt.mu.Unlock()
	if _, err := tt.readRecordLocked(strings.Repeat("0", 32)); err != errNotInTrash {
		t.Errorf("missing = %v", err)
	}
	id := strings.Repeat("1", 32)
	// The .part name is taken: the write fails and leaves no record.
	writeFile(t, filepath.Join(tt.dir, id+".json.part"), "")
	if err := tt.writeRecordLocked(id, trashRecord{}); err == nil || tt.has(id+".json") {
		t.Errorf("taken .part = %v", err)
	}
	// A record path that is a directory fails the rename.
	id2 := strings.Repeat("2", 32)
	writeFile(t, filepath.Join(tt.dir, id2+".json", "x"), "")
	if err := tt.writeRecordLocked(id2, trashRecord{}); err == nil || tt.has(id2+".json.part") {
		t.Errorf("record dir = %v", err)
	}
	if _, err := tt.readRecordLocked(id2); err == nil || err == errNotInTrash {
		t.Errorf("unreadable record = %v", err)
	}
	// Records that are not JSON.
	writeFile(t, filepath.Join(tt.dir, strings.Repeat("3", 32)+".json"), "{")
	if _, err := tt.readRecordLocked(strings.Repeat("3", 32)); err == nil {
		t.Error("bad JSON read")
	}
}

func TestTrashSweepUnreadableDir(t *testing.T) {
	tt := newTestTrash(t)
	os.RemoveAll(tt.dir)
	tt.sweep() // logs, never panics
}

// A restore holds the trash's lock from reading its record to removing it,
// so a sweep running meanwhile never removes the entry.
func TestTrashRestoreRacesSweep(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "race.txt", "keep me")
	_, body := fx.deleteOK(t, "race.txt")
	id := body["trashId"].(string)
	fx.trash().maxTotal = 0
	fx.trash().minAge = 0
	var wg sync.WaitGroup
	wg.Add(2)
	var code int
	go func() {
		defer wg.Done()
		code, _ = fx.restore(t, id, false)
	}()
	go func() {
		defer wg.Done()
		fx.trash().mu.Lock()
		fx.trash().sweepLocked()
		fx.trash().mu.Unlock()
	}()
	wg.Wait()
	// Either the restore ran first (the file is back), or the sweep did
	// and removed the entry whole (404, nothing half done).
	switch code {
	case 200:
		if readText(t, filepath.Join(fx.root, "race.txt")) != "keep me" {
			t.Error("restored bytes differ")
		}
	case 404:
		if fx.trashHas(id) || fx.trashHas(id+".json") {
			t.Error("sweep left half an entry")
		}
	default:
		t.Errorf("restore = %d", code)
	}
}

func TestTrashDir(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	t.Setenv("LOCALAPPDATA", cache)
	if runtime.GOOS == "linux" {
		if got := trashDir(); got != filepath.Join(cache, "termote", "trash") {
			t.Errorf("trashDir = %s", got)
		}
		t.Setenv("XDG_CACHE_HOME", "")
		t.Setenv("HOME", "")
		if got := trashDir(); got != "" {
			t.Errorf("no cache dir = %q", got)
		}
	}
}

// Over quota, a payload still in its grace period (no record yet) counts as
// deleted now: never removed for space.
func TestTrashQuotaKeepsPayloadWithoutRecord(t *testing.T) {
	tt := newTestTrash(t)
	tt.maxTotal = 5
	young := randomHex(16)
	writeFile(t, filepath.Join(tt.dir, young), "0123456789")
	old := tt.add(t, tt.clock.Add(-2*time.Hour), 10)
	tt.sweep()
	if !tt.has(young) || tt.has(old) {
		t.Errorf("young=%v old=%v", tt.has(young), tt.has(old))
	}
}
