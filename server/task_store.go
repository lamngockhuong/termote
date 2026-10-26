package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	tasksFile = "tasks.json"
	tasksLock = "tasks.lock"
	// tasksFormat is the file's v. A file with a higher one was written by a
	// newer Termote: it is read, never written.
	tasksFormat = 1
	maxTasks    = 100
	// maxTaskName is in runes, maxTaskCommand in bytes.
	maxTaskName    = 64
	maxTaskCommand = 4096
	// maxTasksRead bounds the file as read, well above 100 tasks written by
	// this or a newer version.
	maxTasksRead = 16 << 20
	// taskBody fits one task whose every command byte JSON escapes to six
	// (\u00XX), plus its name.
	taskBody = 16 << 10
)

// tasksLockWait bounds the wait for another process's write; a variable so
// tests can shorten it.
var tasksLockWait = 2 * time.Second

var taskPartRe = regexp.MustCompile(`^\.tasks-[0-9a-f]{16}\.part$`)

var (
	errTasksUnavailable = &codedError{"tasks_unavailable", "tasks are not available on this server", http.StatusServiceUnavailable}
	errTasksNewer       = &codedError{"newer_format", "the tasks were saved by a newer Termote: update it to change them", http.StatusConflict}
	errTasksBusy        = &codedError{"busy", "another process is changing the tasks: try again", http.StatusServiceUnavailable}
	errTaskNotFound     = &codedError{"not_found", "no such task", http.StatusNotFound}
	errTaskNameTaken    = &codedError{"name_taken", "a task with this name exists", http.StatusConflict}
	errTooManyTasks     = &codedError{"too_many", fmt.Sprintf("up to %d tasks", maxTasks), http.StatusConflict}
	errTasksTooLarge    = &codedError{"too_large", "request body too large", http.StatusRequestEntityTooLarge}
)

// taskConflict is a PUT or DELETE whose updated is not the task's any more:
// another device changed it. It carries the current one.
type taskConflict struct {
	codedError
	task userTask
}

// taskInputError names what is wrong with a task: field is "name" or
// "command".
type taskInputError struct {
	codedError
	field string
}

func invalidTask(field, msg string) *taskInputError {
	return &taskInputError{codedError{"invalid_task", msg, http.StatusBadRequest}, field}
}

// userTask is one task the user defined: a name and the command line the
// Tasks view runs in a pane's root. updated changes with every write of it,
// so a PUT or DELETE from a device that read an older one is refused.
type userTask struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Command string    `json:"command"`
	Updated time.Time `json:"updated"`
}

// taskInput is a task as a client sends it.
type taskInput struct {
	Name    string `json:"name"`
	Command string `json:"command"`
}

type taskFile struct {
	V     int        `json:"v"`
	Tasks []userTask `json:"tasks"`
}

// taskStore keeps the user's tasks in <stateDir>/tasks, as templateStore
// keeps the prompt templates: a file that cannot be read is an error, never
// overwritten, and every write holds tasks.lock and reads the file again
// first.
type taskStore struct {
	dir string
	now func() time.Time

	// writeMu orders this process's writes; tasks.lock is taken after it
	// and before mu, so a read never waits behind another process.
	writeMu sync.Mutex
	mu      sync.Mutex
	list    []userTask
	// readOnly: the file is a newer version's
	readOnly bool
	modTime  time.Time
	size     int64
	// badTime, badSize: the file as it was when it could not be read again,
	// so a corrupt file is not read and logged on every request
	badTime time.Time
	badSize int64
}

func newTaskStore(dir string) (*taskStore, error) {
	if dir == "" {
		return nil, errors.New("no tasks state dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// Lstat: a symlink to a dir is refused too.
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	if err := checkPrivateDir(dir); err != nil {
		return nil, err
	}
	s := &taskStore{dir: dir, now: time.Now}
	removeStateParts(dir, taskPartRe)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *taskStore) path() string { return filepath.Join(s.dir, tasksFile) }

// readLocked reads tasks.json as it is on disk; a missing file is empty.
// The limits are not checked again: a newer version may allow more.
func (s *taskStore) readLocked() (taskFile, os.FileInfo, error) {
	fi, err := os.Lstat(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return taskFile{V: tasksFormat}, nil, nil
	}
	if err != nil {
		return taskFile{}, nil, fmt.Errorf("read %s: %w", tasksFile, err)
	}
	if fi.Size() > maxTasksRead {
		return taskFile{}, nil, fmt.Errorf("%s is larger than %d bytes", tasksFile, maxTasksRead)
	}
	data, err := readStateFile(s.path())
	if err != nil {
		return taskFile{}, nil, fmt.Errorf("read %s: %w", tasksFile, err)
	}
	var f taskFile
	if err := json.Unmarshal(data, &f); err != nil {
		return taskFile{}, nil, fmt.Errorf("%s is corrupt: %w", tasksFile, err)
	}
	if f.V < 1 {
		return taskFile{}, nil, fmt.Errorf("%s is corrupt: no format version", tasksFile)
	}
	return f, fi, nil
}

// reloadLocked makes the file's tasks the store's. On failure what is in
// memory stays.
func (s *taskStore) reloadLocked() error {
	f, fi, err := s.readLocked()
	if err != nil {
		return err
	}
	s.list = f.Tasks
	s.readOnly = f.V > tasksFormat
	s.modTime, s.size = time.Time{}, 0
	if fi != nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	return nil
}

// maybeReloadLocked reads the file again when its time or size changed
// since it was read: another process wrote it. A file that cannot be read
// keeps what is in memory.
func (s *taskStore) maybeReloadLocked() {
	fi, err := os.Lstat(s.path())
	switch {
	case errors.Is(err, os.ErrNotExist):
		if s.size == 0 && s.modTime.IsZero() {
			return
		}
	case err != nil:
		return
	case fi.ModTime().Equal(s.modTime) && fi.Size() == s.size,
		fi.ModTime().Equal(s.badTime) && fi.Size() == s.badSize:
		return
	}
	if err := s.reloadLocked(); err != nil {
		log.Printf("tasks: %v", err)
		if fi != nil {
			s.badTime, s.badSize = fi.ModTime(), fi.Size()
		}
	}
}

// tasks returns the tasks by name, and whether a newer version's file makes
// them read-only.
func (s *taskStore) tasks() ([]userTask, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maybeReloadLocked()
	out := slices.Clone(s.list)
	if out == nil {
		out = []userTask{}
	}
	slices.SortStableFunc(out, func(a, b userTask) int {
		if c := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); c != 0 {
			return c
		}
		return strings.Compare(a.Name, b.Name)
	})
	return out, s.readOnly
}

// task returns the task with id, as the file holds it now.
func (s *taskStore) task(id string) (userTask, bool) {
	list, _ := s.tasks()
	i := slices.IndexFunc(list, func(t userTask) bool { return t.ID == id })
	if i < 0 {
		return userTask{}, false
	}
	return list[i], true
}

// change runs op on the tasks as the file holds them now, under tasks.lock,
// and writes the result. On any failure nothing changes, in memory or on
// disk.
func (s *taskStore) change(op func([]userTask) ([]userTask, error)) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	unlock, err := lockStateFile(filepath.Join(s.dir, tasksLock), tasksLockWait)
	if errors.Is(err, errStateLockTimeout) {
		log.Printf("tasks: %s still locked after %s", tasksLock, tasksLockWait)
		return errTasksBusy
	}
	if err != nil {
		return fmt.Errorf("lock %s: %w", tasksFile, err)
	}
	defer unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return err
	}
	if s.readOnly {
		return errTasksNewer
	}
	next, err := op(slices.Clone(s.list))
	if err != nil {
		return err
	}
	data, err := json.Marshal(taskFile{V: tasksFormat, Tasks: next})
	if err != nil {
		return err
	}
	if err := writeStateFile("tasks", s.dir, "tasks", s.path(), data, false); err != nil {
		return fmt.Errorf("write %s: %w", tasksFile, err)
	}
	s.list = next
	s.modTime, s.size = time.Time{}, 0
	if fi, err := os.Lstat(s.path()); err == nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	return nil
}

// stamp is a write's time, after prev: a clock that did not move still
// changes updated, which PUT and DELETE compare.
func (s *taskStore) stamp(prev time.Time) time.Time {
	t := s.now().UTC().Round(0)
	if !t.After(prev) {
		t = prev.Add(time.Nanosecond)
	}
	return t
}

// findTaskName returns the index of the task named name (EqualFold), other
// than skip, or -1.
func findTaskName(list []userTask, name, skip string) int {
	return slices.IndexFunc(list, func(t userTask) bool {
		return t.ID != skip && strings.EqualFold(t.Name, name)
	})
}

func (s *taskStore) create(in taskInput) (userTask, error) {
	name, command, err := validateTask(in.Name, in.Command)
	if err != nil {
		return userTask{}, err
	}
	var made userTask
	err = s.change(func(list []userTask) ([]userTask, error) {
		if findTaskName(list, name, "") >= 0 {
			return nil, errTaskNameTaken
		}
		if len(list) >= maxTasks {
			return nil, errTooManyTasks
		}
		made = userTask{ID: newTemplateID(), Name: name, Command: command, Updated: s.stamp(time.Time{})}
		return append(list, made), nil
	})
	return made, err
}

// currentTask finds id, refusing a stale updated with the task as it is.
func currentTask(list []userTask, id, updated string) (int, error) {
	i := slices.IndexFunc(list, func(t userTask) bool { return t.ID == id })
	if i < 0 {
		return -1, errTaskNotFound
	}
	if list[i].Updated.Format(time.RFC3339Nano) != updated {
		return -1, &taskConflict{codedError{"conflict", "the task was changed on another device", http.StatusConflict}, list[i]}
	}
	return i, nil
}

func (s *taskStore) update(id string, in taskInput, updated string) (userTask, error) {
	name, command, err := validateTask(in.Name, in.Command)
	if err != nil {
		return userTask{}, err
	}
	var saved userTask
	err = s.change(func(list []userTask) ([]userTask, error) {
		i, err := currentTask(list, id, updated)
		if err != nil {
			return nil, err
		}
		if findTaskName(list, name, id) >= 0 {
			return nil, errTaskNameTaken
		}
		list[i].Name, list[i].Command, list[i].Updated = name, command, s.stamp(list[i].Updated)
		saved = list[i]
		return list, nil
	})
	return saved, err
}

func (s *taskStore) remove(id, updated string) error {
	return s.change(func(list []userTask) ([]userTask, error) {
		i, err := currentTask(list, id, updated)
		if err != nil {
			return nil, err
		}
		return slices.Delete(list, i, i+1), nil
	})
}

// validateTask returns the name and command trimmed, or why they cannot be
// saved. The command is one line typed into a shell: no line break (it
// would run as two commands, the second outside the markers), no control
// character and nothing that shows nothing, so what the list shows is what
// runs. Its shell syntax is the user's: the run wraps it in eval.
func validateTask(name, command string) (string, string, error) {
	name = strings.TrimSpace(name)
	command = strings.TrimSpace(command)
	switch n := utf8.RuneCountInString(name); {
	case !utf8.ValidString(name):
		return "", "", invalidTask("name", "the name is not valid UTF-8")
	case n == 0:
		return "", "", invalidTask("name", "the name is empty")
	case n > maxTaskName:
		return "", "", invalidTask("name", fmt.Sprintf("the name is longer than %d characters", maxTaskName))
	}
	switch {
	case !utf8.ValidString(command):
		return "", "", invalidTask("command", "the command is not valid UTF-8")
	case command == "":
		return "", "", invalidTask("command", "the command is empty")
	case len(command) > maxTaskCommand:
		return "", "", invalidTask("command", fmt.Sprintf("the command is larger than %d bytes", maxTaskCommand))
	}
	bad := func(r rune) bool { return unicode.IsControl(r) || hiddenRune(r) }
	if strings.ContainsFunc(name, bad) {
		return "", "", invalidTask("name", "the name contains control or hidden characters")
	}
	if strings.ContainsAny(command, "\n\r") {
		return "", "", invalidTask("command", "the command must be one line")
	}
	if strings.ContainsFunc(command, bad) {
		return "", "", invalidTask("command", "the command contains control or hidden characters")
	}
	return name, command, nil
}
