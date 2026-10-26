package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestTaskStore(t *testing.T, dir string) *taskStore {
	t.Helper()
	s, err := newTaskStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mustCreateTask(t *testing.T, s *taskStore, name, command string) userTask {
	t.Helper()
	task, err := s.create(taskInput{name, command})
	if err != nil {
		t.Fatalf("create %q: %v", name, err)
	}
	return task
}

func taskStamp(t userTask) string { return t.Updated.Format(time.RFC3339Nano) }

func wantTaskCode(t *testing.T, err error, code string) {
	t.Helper()
	var ce *codedError
	var conflict *taskConflict
	var input *taskInputError
	got := ""
	switch {
	case errors.As(err, &conflict):
		got = conflict.code
	case errors.As(err, &input):
		got = input.code
	case errors.As(err, &ce):
		got = ce.code
	}
	if got != code {
		t.Fatalf("err = %v (code %q), want %s", err, got, code)
	}
}

func taskNames(list []userTask) []string {
	out := []string{}
	for _, t := range list {
		out = append(out, t.Name)
	}
	return out
}

func TestTaskStoreCRUD(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tasks")
	s := newTestTaskStore(t, dir)
	if list, ro := s.tasks(); len(list) != 0 || ro || list == nil {
		t.Fatalf("new store = %v %v", list, ro)
	}
	b := mustCreateTask(t, s, "  beta  ", "  go test ./... &  ")
	if b.Name != "beta" || b.Command != "go test ./... &" || !validTemplateID(b.ID) {
		t.Fatalf("created = %+v", b)
	}
	mustCreateTask(t, s, "Alpha", "a")
	mustCreateTask(t, s, "gamma", "g")
	if got := taskNames(s.list); strings.Join(got, ",") != "beta,Alpha,gamma" {
		t.Errorf("stored order = %v", got)
	}
	list, _ := s.tasks()
	if got := strings.Join(taskNames(list), ","); got != "Alpha,beta,gamma" {
		t.Errorf("tasks() = %s, want by name", got)
	}
	if got, ok := s.task(b.ID); !ok || got.Command != b.Command {
		t.Errorf("task(id) = %+v %v", got, ok)
	}
	if _, ok := s.task("0123456789abcdef"); ok {
		t.Error("task(unknown) found")
	}

	b2, err := s.update(b.ID, taskInput{"Beta", "new"}, taskStamp(b))
	if err != nil || b2.Name != "Beta" || b2.Command != "new" || !b2.Updated.After(b.Updated) {
		t.Fatalf("update = %+v %v", b2, err)
	}
	// The device that read b before the update is refused, with b2.
	_, err = s.update(b.ID, taskInput{"Beta", "mine"}, taskStamp(b))
	var conflict *taskConflict
	if !errors.As(err, &conflict) || conflict.task.Command != "new" {
		t.Fatalf("stale update = %v", err)
	}
	wantTaskCode(t, s.remove(b.ID, taskStamp(b)), "conflict")
	if err := s.remove(b.ID, taskStamp(b2)); err != nil {
		t.Fatal(err)
	}
	wantTaskCode(t, s.remove(b.ID, taskStamp(b2)), "not_found")
	_, err = s.update(b.ID, taskInput{"x", "y"}, taskStamp(b2))
	wantTaskCode(t, err, "not_found")
	_, err = s.update(b.ID, taskInput{"x", ""}, taskStamp(b2))
	wantTaskCode(t, err, "invalid_task")

	// A restart reads what was written, owner only.
	again := newTestTaskStore(t, dir)
	if list, _ := again.tasks(); strings.Join(taskNames(list), ",") != "Alpha,gamma" {
		t.Errorf("after restart: %v", taskNames(list))
	}
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("dir mode %v %v", fi.Mode(), err)
		}
		if fi, err := os.Stat(filepath.Join(dir, tasksFile)); err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("file mode %v %v", fi.Mode(), err)
		}
	}
}

func TestTaskStoreNamesAndOrder(t *testing.T) {
	s := newTestTaskStore(t, t.TempDir())
	a := mustCreateTask(t, s, "Unit", "x")
	_, err := s.create(taskInput{" UNIT ", "y"})
	wantTaskCode(t, err, "name_taken")
	// Renaming to itself, in another case, is no clash.
	if _, err := s.update(a.ID, taskInput{"unit", "x"}, taskStamp(a)); err != nil {
		t.Fatal(err)
	}
	b := mustCreateTask(t, s, "Other", "y")
	_, err = s.update(b.ID, taskInput{"UNIT", "y"}, taskStamp(b))
	wantTaskCode(t, err, "name_taken")
	// Same name but for case: sorted stably by the exact name.
	s2 := newTestTaskStore(t, t.TempDir())
	s2.list = []userTask{{Name: "b"}, {Name: "a"}, {Name: "A"}}
	if list, _ := s2.tasks(); fmt.Sprint(taskNames(list)) != "[A a b]" {
		t.Errorf("order = %v", taskNames(list))
	}
}

func TestTaskStoreLimit(t *testing.T) {
	s := newTestTaskStore(t, t.TempDir())
	for i := range maxTasks {
		mustCreateTask(t, s, "t"+strconv.Itoa(i), "x")
	}
	_, err := s.create(taskInput{"one more", "x"})
	wantTaskCode(t, err, "too_many")
	if len(s.list) != maxTasks {
		t.Fatalf("%d tasks", len(s.list))
	}
}

// A clock that does not move still changes updated.
func TestTaskStoreStampMoves(t *testing.T) {
	s := newTestTaskStore(t, t.TempDir())
	frozen := time.Date(2026, 10, 26, 1, 2, 3, 0, time.UTC)
	s.now = func() time.Time { return frozen }
	a := mustCreateTask(t, s, "a", "x")
	a2, err := s.update(a.ID, taskInput{"a", "y"}, taskStamp(a))
	if err != nil || taskStamp(a2) == taskStamp(a) {
		t.Fatalf("updated %s then %s (%v)", taskStamp(a), taskStamp(a2), err)
	}
}

func TestValidateTask(t *testing.T) {
	long := strings.Repeat("é", maxTaskName)
	for _, tc := range []struct {
		name, command, field string
	}{
		{long, "x", ""},
		{long + "é", "x", "name"},
		{"   ", "x", "name"},
		{"a\xff", "x", "name"},
		{"a\tb", "x", "name"},
		{"a", "", "command"},
		{"a", "   ", "command"},
		{"a", "x\xff", "command"},
		{"a", strings.Repeat("a", maxTaskCommand), ""},
		{"a", strings.Repeat("a", maxTaskCommand+1), "command"},
		{"a", "make\nrm -rf /", "command"},
		{"a", "make\rx", "command"},
		{"a", "make\tx", "command"},
		{"a", "esc \x1b[31m", "command"},
		{"a", "echo a‮b", "command"},
		// Shell syntax is the user's: eval runs it whole.
		{"a", "sleep 1 & echo $(date) ; ls # done", ""},
	} {
		_, _, err := validateTask(tc.name, tc.command)
		var ie *taskInputError
		switch {
		case tc.field == "" && err != nil:
			t.Errorf("%.20q/%.20q: %v", tc.name, tc.command, err)
		case tc.field != "" && (!errors.As(err, &ie) || ie.field != tc.field || ie.code != "invalid_task"):
			t.Errorf("%.20q/%.20q: %v, want invalid %s", tc.name, tc.command, err, tc.field)
		}
	}
}

// The characters the templates refuse as hidden are refused in a task too.
func TestValidateTaskHiddenChars(t *testing.T) {
	data, err := os.ReadFile("testdata/template-hidden-chars.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			CodePoint string
			InName    bool
			Why       string
		}
	}
	if err := json.Unmarshal(data, &f); err != nil || len(f.Cases) == 0 {
		t.Fatalf("cases: %v", err)
	}
	for _, c := range f.Cases {
		cp, err := strconv.ParseUint(c.CodePoint, 16, 32)
		if err != nil {
			t.Fatal(err)
		}
		s := "a" + string(rune(cp)) + "b"
		_, _, nameErr := validateTask(s, "x")
		_, _, cmdErr := validateTask("x", s)
		if (nameErr == nil) != c.InName || (cmdErr == nil) != c.InName {
			t.Errorf("U+%s (%s): name %v, command %v; want allowed %v", c.CodePoint, c.Why, nameErr, cmdErr, c.InName)
		}
	}
}

func TestTaskStoreLoad(t *testing.T) {
	write := func(t *testing.T, data string) string {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, tasksFile), []byte(data), 0o600)
		return dir
	}
	t.Run("corrupt is never overwritten", func(t *testing.T) {
		for _, data := range []string{"{nope", `{"tasks":[]}`, `{"v":0}`, `[]`} {
			dir := write(t, data)
			if _, err := newTaskStore(dir); err == nil {
				t.Errorf("%s loaded", data)
			}
			if got, _ := os.ReadFile(filepath.Join(dir, tasksFile)); string(got) != data {
				t.Errorf("file changed to %s", got)
			}
		}
	})
	t.Run("newer version is read-only", func(t *testing.T) {
		data := `{"v":2,"tasks":[{"id":"0123456789abcdef","name":"n","command":"x","updated":"2026-10-26T00:00:00Z"}]}`
		dir := write(t, data)
		s := newTestTaskStore(t, dir)
		list, ro := s.tasks()
		if len(list) != 1 || !ro {
			t.Fatalf("%v %v", list, ro)
		}
		_, err := s.create(taskInput{"a", "b"})
		wantTaskCode(t, err, "newer_format")
		wantTaskCode(t, s.remove(list[0].ID, taskStamp(list[0])), "newer_format")
		if got, _ := os.ReadFile(filepath.Join(dir, tasksFile)); string(got) != data {
			t.Errorf("file changed to %s", got)
		}
	})
	t.Run("symlink", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks need privileges")
		}
		dir, other := t.TempDir(), filepath.Join(t.TempDir(), "x.json")
		os.WriteFile(other, []byte(`{"v":1,"tasks":[]}`), 0o600)
		os.Symlink(other, filepath.Join(dir, tasksFile))
		if _, err := newTaskStore(dir); err == nil {
			t.Error("a symlinked file loaded")
		}
		link := filepath.Join(t.TempDir(), "link")
		os.Symlink(t.TempDir(), link)
		if _, err := newTaskStore(link); err == nil {
			t.Error("a symlinked dir loaded")
		}
	})
	t.Run("too large", func(t *testing.T) {
		dir := t.TempDir()
		f, _ := os.Create(filepath.Join(dir, tasksFile))
		f.Truncate(maxTasksRead + 1)
		f.Close()
		if _, err := newTaskStore(dir); err == nil {
			t.Error("an oversized file loaded")
		}
	})
	t.Run("not readable", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Unix modes")
		}
		dir := t.TempDir()
		os.Mkdir(filepath.Join(dir, tasksFile), 0o700)
		if _, err := newTaskStore(dir); err == nil {
			t.Error("a dir as file loaded")
		}
	})
	t.Run("no dir", func(t *testing.T) {
		if _, err := newTaskStore(""); err == nil {
			t.Error("no dir loaded")
		}
		file := filepath.Join(t.TempDir(), "file")
		os.WriteFile(file, nil, 0o600)
		if _, err := newTaskStore(file); err == nil {
			t.Error("a file as dir loaded")
		}
		if _, err := newTaskStore(filepath.Join(file, "sub")); err == nil {
			t.Error("a dir under a file loaded")
		}
	})
	t.Run("stale parts are removed", func(t *testing.T) {
		dir := t.TempDir()
		part := filepath.Join(dir, ".tasks-0123456789abcdef.part")
		other := filepath.Join(dir, ".templates-0123456789abcdef.part")
		os.WriteFile(part, []byte("x"), 0o600)
		os.WriteFile(other, []byte("x"), 0o600)
		newTestTaskStore(t, dir)
		if _, err := os.Stat(part); !errors.Is(err, os.ErrNotExist) {
			t.Error("part kept")
		}
		if _, err := os.Stat(other); err != nil {
			t.Error("another store's part removed")
		}
	})
}

// Two processes on one state dir: each write reads the other's first, and a
// read sees the other's write.
func TestTaskStoreTwoProcesses(t *testing.T) {
	dir := t.TempDir()
	a, b := newTestTaskStore(t, dir), newTestTaskStore(t, dir)
	made := mustCreateTask(t, a, "from a", "x")
	if list, _ := b.tasks(); len(list) != 1 {
		t.Fatalf("b reads %d", len(list))
	}
	if _, err := b.update(made.ID, taskInput{"edited by b", "y"}, taskStamp(made)); err != nil {
		t.Fatal(err)
	}
	mustCreateTask(t, a, "second from a", "z")
	list, _ := newTestTaskStore(t, dir).tasks()
	if fmt.Sprint(taskNames(list)) != "[edited by b second from a]" {
		t.Fatalf("on disk: %v", taskNames(list))
	}
	// A corrupt file keeps what was read, and is read once.
	os.WriteFile(filepath.Join(dir, tasksFile), []byte("{nope, and longer than before ......................................."), 0o600)
	if list, _ := a.tasks(); len(list) != 2 {
		t.Errorf("corrupt read: %d", len(list))
	}
	if list, _ := a.tasks(); len(list) != 2 {
		t.Errorf("corrupt read again: %d", len(list))
	}
	_, err := a.create(taskInput{"c", "x"})
	if err == nil || errors.As(err, new(*codedError)) {
		t.Errorf("write over a corrupt file: %v", err)
	}
	// A removed file reads as empty, and stays so.
	os.Remove(filepath.Join(dir, tasksFile))
	if list, _ := a.tasks(); len(list) != 0 {
		t.Errorf("removed file: %d", len(list))
	}
	if list, _ := a.tasks(); len(list) != 0 {
		t.Errorf("removed file again: %d", len(list))
	}
	// A file that cannot be stat'ed keeps what is in memory.
	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		mustCreateTask(t, a, "kept", "x")
		os.Chmod(dir, 0o200)
		t.Cleanup(func() { os.Chmod(dir, 0o700) })
		if list, _ := a.tasks(); len(list) != 1 {
			t.Errorf("unstat-able file: %d", len(list))
		}
		os.Chmod(dir, 0o700)
	}
}

func TestTaskStoreLockTimeout(t *testing.T) {
	old := tasksLockWait
	tasksLockWait = 20 * time.Millisecond
	t.Cleanup(func() { tasksLockWait = old })
	dir := t.TempDir()
	s := newTestTaskStore(t, dir)
	unlock, err := lockStateFile(filepath.Join(dir, tasksLock), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	_, err = s.create(taskInput{"a", "b"})
	wantTaskCode(t, err, "busy")
}

// A lock that cannot be opened, or a failed write, changes nothing.
func TestTaskStoreWriteFails(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("Unix modes, not as root")
	}
	dir := t.TempDir()
	s := newTestTaskStore(t, dir)
	mustCreateTask(t, s, "a", "x")
	os.Chmod(dir, 0o500)
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if _, err := s.create(taskInput{"b", "y"}); err == nil {
		t.Fatal("wrote into a read-only dir")
	}
	if list, _ := s.tasks(); len(list) != 1 {
		t.Fatalf("%d tasks after a failed write", len(list))
	}
	os.Chmod(dir, 0o700)
	// The lock exists now; written over, it is a directory nothing opens.
	os.Remove(filepath.Join(dir, tasksLock))
	os.Mkdir(filepath.Join(dir, tasksLock), 0o700)
	if _, err := s.create(taskInput{"b", "y"}); err == nil {
		t.Fatal("wrote without the lock")
	}
}

// Two processes writing at once lose nothing.
func TestTaskStoreConcurrentWrites(t *testing.T) {
	dir := t.TempDir()
	stores := []*taskStore{newTestTaskStore(t, dir), newTestTaskStore(t, dir)}
	var wg sync.WaitGroup
	for i := range 40 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := stores[i%2].create(taskInput{"t" + strconv.Itoa(i), "x"}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if list, _ := newTestTaskStore(t, dir).tasks(); len(list) != 40 {
		t.Fatalf("%d of 40 written", len(list))
	}
}

// A file that cannot be stat'ed fails a reload, keeping what is in memory.
func TestTaskStoreReloadStatFails(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("Unix modes, not as root")
	}
	dir := t.TempDir()
	s := newTestTaskStore(t, dir)
	mustCreateTask(t, s, "a", "x")
	os.Chmod(dir, 0)
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	s.mu.Lock()
	err := s.reloadLocked()
	s.mu.Unlock()
	if err == nil || len(s.list) != 1 {
		t.Fatalf("reload = %v, %d tasks", err, len(s.list))
	}
}
