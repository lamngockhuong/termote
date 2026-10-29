package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func newTestRecentStore(t *testing.T, dir string) *recentGroupStore {
	t.Helper()
	s, err := newRecentGroupStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mustRecord(t *testing.T, s *recentGroupStore, name, cwd, real string) {
	t.Helper()
	if err := s.record(name, cwd, real); err != nil {
		t.Fatalf("record %q: %v", name, err)
	}
}

func recentNames(list []recentGroup) string {
	out := []string{}
	for _, g := range list {
		out = append(out, g.Name)
	}
	return strings.Join(out, ",")
}

// badFiles lists the corrupt files set aside in dir.
func badFiles(t *testing.T, dir string) []string {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(dir, recentGroupsFile+".bad-*"))
	return m
}

func TestRecentGroupStoreRecord(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "recent-groups")
	base := t.TempDir()
	a, b := filepath.Join(base, "a"), filepath.Join(base, "b")
	s := newTestRecentStore(t, dir)
	now := time.Date(2026, 10, 29, 1, 2, 3, 0, time.UTC)
	s.now = func() time.Time { return now }
	if list, ro := s.entries(); len(list) != 0 || ro || list == nil {
		t.Fatalf("new store = %v %v", list, ro)
	}
	mustRecord(t, s, "api", a, a)
	mustRecord(t, s, "web", b, b)
	list, _ := s.entries()
	if recentNames(list) != "web,api" || list[0].Cwd != b || list[0].Used != "2026-10-29T01:02:03Z" || !validRecentID(list[0].ID) {
		t.Fatalf("entries = %+v", list)
	}
	// Another spelling of a's directory (a symlink to it) is the same
	// entry: it moves up, with the new name and spelling, keeping its id.
	id := list[1].ID
	mustRecord(t, s, "api-2", filepath.Join(base, "link"), a)
	list, _ = s.entries()
	if recentNames(list) != "api-2,web" || list[0].ID != id || list[0].Cwd != filepath.Join(base, "link") || list[0].Real != a {
		t.Fatalf("after again = %+v", list)
	}

	// A restart reads what was written, owner only.
	if got, _ := newTestRecentStore(t, dir).entries(); recentNames(got) != "api-2,web" {
		t.Errorf("after restart: %s", recentNames(got))
	}
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("dir mode %v %v", fi.Mode(), err)
		}
		if fi, err := os.Stat(filepath.Join(dir, recentGroupsFile)); err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("file mode %v %v", fi.Mode(), err)
		}
	}
}

// An entry entries would hide is never written: it would take a place
// nobody can free.
func TestRecentGroupStoreRecordSkipsHidden(t *testing.T) {
	s := newTestRecentStore(t, t.TempDir())
	d := t.TempDir()
	for _, e := range [][3]string{{"bad\x1b", d, d}, {"a", "rel", d}, {"a", d, `\\host\share`}} {
		if err := s.record(e[0], e[1], e[2]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(s.path()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a hidden entry was written: %v", err)
	}
}

func TestRecentGroupStoreLimit(t *testing.T) {
	s := newTestRecentStore(t, t.TempDir())
	base := t.TempDir()
	for i := range maxRecentGroups + 3 {
		d := filepath.Join(base, fmt.Sprint(i))
		mustRecord(t, s, fmt.Sprint("g", i), d, d)
	}
	list, _ := s.entries()
	if len(list) != maxRecentGroups || list[0].Name != "g22" || list[maxRecentGroups-1].Name != "g3" {
		t.Fatalf("%d entries, %s", len(list), recentNames(list))
	}
}

func TestRecentGroupSameDir(t *testing.T) {
	for _, tc := range []struct {
		a, b    string
		windows bool
		same    bool
	}{
		{`C:\Src\Api`, `c:\src\api`, true, true},
		{`C:\src\api`, `C:\src\web`, true, false},
		{"/src/Api", "/src/api", false, false},
		{"/src/api", "/src/api", false, true},
	} {
		if got := sameRecentDir(tc.a, tc.b, tc.windows); got != tc.same {
			t.Errorf("sameRecentDir(%q, %q, %v) = %v", tc.a, tc.b, tc.windows, got)
		}
	}
}

func TestRecentGroupStoreRemoveAndPrune(t *testing.T) {
	s := newTestRecentStore(t, t.TempDir())
	base := t.TempDir()
	for _, n := range []string{"a", "b", "c"} {
		d := filepath.Join(base, n)
		mustRecord(t, s, n, d, d)
	}
	list, _ := s.entries()
	if err := s.remove(list[1].ID); err != nil {
		t.Fatal(err)
	}
	wantCode(t, s.remove(list[1].ID), "unknown_recent")
	wantCode(t, s.remove("../../etc"), "unknown_recent")
	wantCode(t, s.remove("0123456789ABCDEF"), "unknown_recent")
	if got, _ := s.entries(); recentNames(got) != "c,a" {
		t.Fatalf("after remove: %s", recentNames(got))
	}

	// Nothing to drop writes nothing.
	fi, _ := os.Stat(s.path())
	if err := s.prune(func(recentGroup) bool { return false }); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.Stat(s.path()); !after.ModTime().Equal(fi.ModTime()) || after.Size() != fi.Size() {
		t.Error("a prune that dropped nothing wrote the file")
	}
	if err := s.prune(func(g recentGroup) bool { return g.Name == "a" }); err != nil {
		t.Fatal(err)
	}
	if got, _ := newTestRecentStore(t, s.dir).entries(); recentNames(got) != "c" {
		t.Fatalf("after prune: %s", recentNames(got))
	}
}

func TestRecentGroupStoreLoad(t *testing.T) {
	write := func(t *testing.T, data string) string {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, recentGroupsFile), []byte(data), 0o600)
		return dir
	}
	t.Run("corrupt is set aside", func(t *testing.T) {
		for _, data := range []string{"{nope", `{"groups":[]}`, `{"v":0}`, `[]`, `{"v":1,"groups":{}}`} {
			logs := captureLog(t)
			dir := write(t, data)
			s := newTestRecentStore(t, dir)
			bad := badFiles(t, dir)
			if len(bad) != 1 {
				t.Fatalf("%s: set aside as %v", data, bad)
			}
			if got, _ := os.ReadFile(bad[0]); string(got) != data {
				t.Errorf("set aside %s, want %s", got, data)
			}
			if !strings.Contains(logs.String(), "set the unreadable") {
				t.Errorf("not logged: %s", logs)
			}
			if list, ro := s.entries(); len(list) != 0 || ro {
				t.Errorf("%s: %v %v", data, list, ro)
			}
			d := t.TempDir()
			mustRecord(t, s, "a", d, d)
			if got, _ := newTestRecentStore(t, dir).entries(); recentNames(got) != "a" {
				t.Errorf("%s: after record %s", data, recentNames(got))
			}
		}
	})
	t.Run("too large is set aside", func(t *testing.T) {
		dir := t.TempDir()
		f, _ := os.Create(filepath.Join(dir, recentGroupsFile))
		f.Truncate(maxRecentRead + 1)
		f.Close()
		newTestRecentStore(t, dir)
		if len(badFiles(t, dir)) != 1 {
			t.Error("an oversized file was not set aside")
		}
	})
	t.Run("malformed entries are hidden, not dropped", func(t *testing.T) {
		d := filepath.ToSlash(t.TempDir())
		if runtime.GOOS == "windows" {
			d = filepath.Clean(d)
		}
		good := fmt.Sprintf(`{"id":"0123456789abcdef","name":"ok","cwd":%q,"real":%q,"used":"x"}`, d, d)
		data := `{"v":1,"groups":[` + good + `,
			{"id":"nothex","name":"a","cwd":"/x","real":"/x"},
			{"id":"0123456789abcde0","name":"bad\u001b[31m","cwd":"/x","real":"/x"},
			{"id":"0123456789abcde1","name":"rel","cwd":"x","real":"/x"},
			{"id":"0123456789abcde2","name":"r","cwd":"/x","real":"y\u0007"}]}`
		dir := write(t, data)
		s := newTestRecentStore(t, dir)
		if got, _ := s.entries(); recentNames(got) != "ok" {
			t.Fatalf("entries = %s", recentNames(got))
		}
		if len(s.list) != 5 {
			t.Errorf("%d in the file", len(s.list))
		}
	})
	t.Run("newer version is read-only", func(t *testing.T) {
		logs := captureLog(t)
		d := filepath.Clean(t.TempDir())
		data := fmt.Sprintf(`{"v":2,"groups":[{"id":"0123456789abcdef","name":"n","cwd":%q,"real":%q,"pinned":true}]}`, d, d)
		dir := write(t, data)
		s := newTestRecentStore(t, dir)
		list, ro := s.entries()
		if len(list) != 1 || !ro {
			t.Fatalf("%v %v", list, ro)
		}
		if strings.Count(logs.String(), "newer Termote") != 1 {
			t.Errorf("logs: %s", logs)
		}
		logs.Reset()
		if err := s.record("a", d, d); err != nil {
			t.Errorf("record = %v", err)
		}
		if err := s.prune(func(recentGroup) bool { return true }); err != nil {
			t.Errorf("prune = %v", err)
		}
		wantCode(t, s.remove(list[0].ID), "newer_format")
		if got, _ := os.ReadFile(filepath.Join(dir, recentGroupsFile)); string(got) != data {
			t.Errorf("file changed to %s", got)
		}
		if logs.Len() != 0 {
			t.Errorf("record logged: %s", logs)
		}
	})
	t.Run("newer version's list this one cannot read", func(t *testing.T) {
		data := `{"v":2,"groups":{"by":"dir"}}`
		dir := write(t, data)
		s := newTestRecentStore(t, dir)
		if list, ro := s.entries(); len(list) != 0 || !ro {
			t.Fatalf("%v %v", list, ro)
		}
		d := t.TempDir()
		if err := s.record("a", d, d); err != nil {
			t.Fatal(err)
		}
		if got, _ := os.ReadFile(filepath.Join(dir, recentGroupsFile)); string(got) != data || len(badFiles(t, dir)) != 0 {
			t.Errorf("file changed to %s, set aside %v", got, badFiles(t, dir))
		}
	})
	t.Run("symlink", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks need privileges")
		}
		dir, other := t.TempDir(), filepath.Join(t.TempDir(), "x.json")
		os.WriteFile(other, []byte(`{"v":1,"groups":[]}`), 0o600)
		os.Symlink(other, filepath.Join(dir, recentGroupsFile))
		if _, err := newRecentGroupStore(dir); err == nil {
			t.Error("a symlinked file loaded")
		}
		link := filepath.Join(t.TempDir(), "link")
		os.Symlink(t.TempDir(), link)
		if _, err := newRecentGroupStore(link); err == nil {
			t.Error("a symlinked dir loaded")
		}
	})
	t.Run("no dir", func(t *testing.T) {
		if _, err := newRecentGroupStore(""); err == nil {
			t.Error("no dir loaded")
		}
		file := filepath.Join(t.TempDir(), "file")
		os.WriteFile(file, nil, 0o600)
		if _, err := newRecentGroupStore(file); err == nil {
			t.Error("a file as dir loaded")
		}
		if _, err := newRecentGroupStore(filepath.Join(file, "sub")); err == nil {
			t.Error("a dir under a file loaded")
		}
	})
	t.Run("private dir", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Unix modes")
		}
		dir := t.TempDir()
		os.Chmod(dir, 0o755)
		newTestRecentStore(t, dir)
		if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("dir mode %v %v", fi.Mode(), err)
		}
	})
	t.Run("stale parts are removed", func(t *testing.T) {
		dir := t.TempDir()
		part := filepath.Join(dir, ".recent-groups-0123456789abcdef.part")
		other := filepath.Join(dir, ".templates-0123456789abcdef.part")
		os.WriteFile(part, []byte("x"), 0o600)
		os.WriteFile(other, []byte("x"), 0o600)
		newTestRecentStore(t, dir)
		if _, err := os.Stat(part); !errors.Is(err, os.ErrNotExist) {
			t.Error("part kept")
		}
		if _, err := os.Stat(other); err != nil {
			t.Error("another store's part removed")
		}
	})
	t.Run("lock held at start", func(t *testing.T) {
		old := recentGroupsLockWait
		recentGroupsLockWait = 20 * time.Millisecond
		t.Cleanup(func() { recentGroupsLockWait = old })
		logs := captureLog(t)
		dir := write(t, "{nope")
		unlock, err := lockStateFile(filepath.Join(dir, recentGroupsLock), 0)
		if err != nil {
			t.Fatal(err)
		}
		defer unlock()
		s := newTestRecentStore(t, dir)
		if len(badFiles(t, dir)) != 0 || !strings.Contains(logs.String(), "busy") && !strings.Contains(logs.String(), "still locked") {
			t.Errorf("logs: %s", logs)
		}
		if list, _ := s.entries(); len(list) != 0 {
			t.Errorf("entries = %v", list)
		}
	})
}

// A file that turns corrupt after the start reads as empty, is logged
// once however often it is read, and is set aside by the next write.
func TestRecentGroupStoreCorruptLater(t *testing.T) {
	dir := t.TempDir()
	s := newTestRecentStore(t, dir)
	d := t.TempDir()
	mustRecord(t, s, "a", d, d)
	logs := captureLog(t)
	os.WriteFile(s.path(), []byte("{nope, and longer than the file was ......................................................"), 0o600)
	for range 3 {
		if list, _ := s.entries(); len(list) != 0 {
			t.Fatalf("corrupt read: %v", list)
		}
	}
	if n := strings.Count(logs.String(), "is corrupt"); n != 1 {
		t.Errorf("logged %d times: %s", n, logs)
	}
	mustRecord(t, s, "b", d, d)
	if len(badFiles(t, dir)) != 1 {
		t.Error("not set aside")
	}
	if got, _ := s.entries(); recentNames(got) != "b" {
		t.Errorf("entries = %s", recentNames(got))
	}
	// A file that cannot be read for another reason keeps what was read.
	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		os.Remove(s.path())
		os.Mkdir(s.path(), 0o700)
		if got, _ := s.entries(); recentNames(got) != "b" {
			t.Errorf("unreadable: %s", recentNames(got))
		}
		if err := s.record("c", d, d); err == nil {
			t.Error("wrote over a directory")
		}
	}
}

// A file a newer version wrote since the last read is left as it is.
func TestRecentGroupStorePruneNewerSince(t *testing.T) {
	s := newTestRecentStore(t, t.TempDir())
	data := `{"v":2,"groups":[]}`
	os.WriteFile(s.path(), []byte(data), 0o600)
	if err := s.prune(func(recentGroup) bool { return true }); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(s.path()); string(got) != data {
		t.Errorf("file changed to %s", got)
	}
}

// Two processes on one state dir: each write reads the other's first, and
// a read sees the other's write.
func TestRecentGroupStoreTwoProcesses(t *testing.T) {
	dir := t.TempDir()
	a, b := newTestRecentStore(t, dir), newTestRecentStore(t, dir)
	base := t.TempDir()
	x, y := filepath.Join(base, "x"), filepath.Join(base, "y")
	mustRecord(t, a, "x", x, x)
	if list, _ := b.entries(); recentNames(list) != "x" {
		t.Fatalf("b reads %s", recentNames(list))
	}
	mustRecord(t, b, "y", y, y)
	mustRecord(t, a, "x2", x, x)
	if list, _ := newTestRecentStore(t, dir).entries(); recentNames(list) != "x2,y" {
		t.Fatalf("on disk: %s", recentNames(list))
	}
	os.Remove(a.path())
	if list, _ := a.entries(); len(list) != 0 {
		t.Errorf("removed file: %d", len(list))
	}
}

func TestRecentGroupStoreLockTimeout(t *testing.T) {
	old := recentGroupsLockWait
	recentGroupsLockWait = 20 * time.Millisecond
	t.Cleanup(func() { recentGroupsLockWait = old })
	dir := t.TempDir()
	s := newTestRecentStore(t, dir)
	unlock, err := lockStateFile(filepath.Join(dir, recentGroupsLock), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	d := t.TempDir()
	wantCode(t, s.record("a", d, d), "busy")
}

// A failed write changes nothing.
func TestRecentGroupStoreWriteFails(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("Unix modes, not as root")
	}
	dir := t.TempDir()
	s := newTestRecentStore(t, dir)
	d := t.TempDir()
	mustRecord(t, s, "a", d, d)
	os.Chmod(dir, 0o500)
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if err := s.record("b", d, d); err == nil {
		t.Fatal("wrote into a read-only dir")
	}
	if list, _ := s.entries(); recentNames(list) != "a" {
		t.Fatalf("after a failed write: %s", recentNames(list))
	}
	// A corrupt file that cannot be set aside is left as it is.
	os.Chmod(dir, 0o700)
	os.WriteFile(s.path(), []byte("{nope"), 0o600)
	os.Chmod(dir, 0o500)
	if err := s.record("b", d, d); err == nil || !strings.Contains(err.Error(), "set aside") {
		t.Fatalf("record over a corrupt file = %v", err)
	}
	if got, _ := os.ReadFile(s.path()); string(got) != "{nope" {
		t.Errorf("file changed to %s", got)
	}
	// A dir that cannot be searched: reads keep what is in memory, writes
	// fail.
	os.Chmod(dir, 0o700)
	os.Remove(s.path())
	mustRecord(t, s, "c", d, d)
	os.Chmod(dir, 0)
	if list, _ := s.entries(); recentNames(list) != "c" {
		t.Errorf("unsearchable dir: %s", recentNames(list))
	}
	if err := s.record("e", d, d); err == nil {
		t.Error("wrote into an unsearchable dir")
	}
}
