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
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	recentGroupsFile = "recent-groups.json"
	recentGroupsLock = "recent-groups.lock"
	// recentGroupsFormat is the file's v. A file with a higher one was
	// written by a newer Termote: it is read, never written.
	recentGroupsFormat = 1
	maxRecentGroups    = 20
	// maxRecentRead bounds the file as read, well above 20 entries written
	// by this or a newer version.
	maxRecentRead = 1 << 20
)

// recentGroupsLockWait bounds the wait for another process's write; a
// variable so tests can shorten it.
var recentGroupsLockWait = 2 * time.Second

var recentPartRe = regexp.MustCompile(`^\.recent-groups-[0-9a-f]{16}\.part$`)

var (
	errRecentUnavailable = &codedError{"recent_unavailable", "recent groups are not available on this server", http.StatusServiceUnavailable}
	errRecentNewer       = &codedError{"newer_format", "the recent groups were saved by a newer Termote: update it to change them", http.StatusConflict}
	errRecentBusy        = &codedError{"busy", "another process is changing the recent groups: try again", http.StatusServiceUnavailable}
	errUnknownRecent     = &codedError{"unknown_recent", "no such recent group", http.StatusNotFound}
)

// recentGroup is one group created with a directory. cwd is the directory
// as typed (cleaned), shown and filled in again; real is it with its
// symlinks resolved, which tells two spellings of one directory apart and
// never reaches a client.
type recentGroup struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
	Real string `json:"real"`
	Used string `json:"used"`
}

type recentGroupFile struct {
	V      int           `json:"v"`
	Groups []recentGroup `json:"groups"`
}

// corruptRecentError is a file that is there but holds no list: it is set
// aside, never written over.
type corruptRecentError struct{ err error }

func (e *corruptRecentError) Error() string { return e.err.Error() }

// recentGroupStore keeps the groups created last in <stateDir>/recent-groups,
// newest first. They are suggestions the next group made brings back: a file
// that cannot be read is renamed recent-groups.json.bad-<unix nanoseconds>
// under the lock and the list starts again, unlike the templates. Every
// write holds recent-groups.lock and reads the file again first, so a second
// process on the same state dir never writes back what it read before
// another's write.
type recentGroupStore struct {
	dir string
	now func() time.Time

	// writeMu orders this process's writes; recent-groups.lock is taken
	// after it and before mu, so a read never waits behind another process.
	writeMu sync.Mutex
	mu      sync.Mutex
	list    []recentGroup
	// readOnly: the file is a newer version's
	readOnly bool
	modTime  time.Time
	size     int64
	// badTime, badSize: the file as it was when it could not be read again,
	// so a corrupt file is not read and logged on every request
	badTime time.Time
	badSize int64
}

func newRecentGroupStore(dir string) (*recentGroupStore, error) {
	if dir == "" {
		return nil, errors.New("no recent groups state dir")
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
	s := &recentGroupStore{dir: dir, now: time.Now}
	removeStateParts(dir, recentPartRe)
	s.mu.Lock()
	err := s.reloadLocked()
	s.mu.Unlock()
	var corrupt *corruptRecentError
	switch {
	case errors.As(err, &corrupt):
		// Set aside under the lock, writing nothing.
		if err := s.change(func(list []recentGroup) ([]recentGroup, bool) { return list, false }); err != nil {
			log.Printf("recent groups: %v", err)
		}
	case err != nil:
		return nil, err
	case s.readOnly:
		log.Printf("recent groups: %s was saved by a newer Termote: read-only", recentGroupsFile)
	}
	return s, nil
}

func (s *recentGroupStore) path() string { return filepath.Join(s.dir, recentGroupsFile) }

// readLocked reads recent-groups.json as it is on disk; a missing file is
// empty. A file that is too large or not JSON is a corruptRecentError.
func (s *recentGroupStore) readLocked() (recentGroupFile, os.FileInfo, error) {
	fi, err := os.Lstat(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return recentGroupFile{V: recentGroupsFormat}, nil, nil
	}
	if err != nil {
		return recentGroupFile{}, nil, fmt.Errorf("read %s: %w", recentGroupsFile, err)
	}
	if fi.Mode().IsRegular() && fi.Size() > maxRecentRead {
		return recentGroupFile{}, fi, &corruptRecentError{fmt.Errorf("%s is larger than %d bytes", recentGroupsFile, maxRecentRead)}
	}
	data, err := readStateFile(s.path())
	if err != nil {
		return recentGroupFile{}, nil, fmt.Errorf("read %s: %w", recentGroupsFile, err)
	}
	// v first: a newer version's file may hold a list this one cannot
	// decode, and is read only rather than set aside.
	var head struct {
		V int `json:"v"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return recentGroupFile{}, fi, &corruptRecentError{fmt.Errorf("%s is corrupt: %w", recentGroupsFile, err)}
	}
	if head.V < 1 {
		return recentGroupFile{}, fi, &corruptRecentError{fmt.Errorf("%s is corrupt: no format version", recentGroupsFile)}
	}
	var f recentGroupFile
	if err := json.Unmarshal(data, &f); err != nil {
		if head.V > recentGroupsFormat {
			return recentGroupFile{V: head.V}, fi, nil
		}
		return recentGroupFile{}, fi, &corruptRecentError{fmt.Errorf("%s is corrupt: %w", recentGroupsFile, err)}
	}
	return f, fi, nil
}

// reloadLocked makes the file's list the store's. On failure what is in
// memory stays.
func (s *recentGroupStore) reloadLocked() error {
	f, fi, err := s.readLocked()
	if err != nil {
		return err
	}
	s.list = f.Groups
	s.readOnly = f.V > recentGroupsFormat
	s.modTime, s.size = time.Time{}, 0
	if fi != nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	return nil
}

// maybeReloadLocked reads the file again when its time or size changed
// since it was read: another process wrote it. A corrupt file reads as
// empty until the next write sets it aside; any other failure keeps what is
// in memory. Either is logged once per file.
func (s *recentGroupStore) maybeReloadLocked() {
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
		log.Printf("recent groups: %v", err)
		if errors.As(err, new(*corruptRecentError)) {
			s.list, s.readOnly = nil, false
		}
		if fi != nil {
			s.badTime, s.badSize = fi.ModTime(), fi.Size()
		}
	}
}

// entries returns the groups, newest first, leaving out any entry that is
// not one this version writes (a hand-edited file shows the client no
// control character); they stay in the file. The bool is whether a newer
// version's file makes them read-only.
func (s *recentGroupStore) entries() ([]recentGroup, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maybeReloadLocked()
	windows := runtime.GOOS == "windows"
	out := []recentGroup{}
	for _, e := range s.list {
		if validRecentID(e.ID) && validateTmuxTarget(e.Name) && validCwdForm(e.Cwd, windows) && validCwdForm(e.Real, windows) {
			out = append(out, e)
		}
	}
	return out, s.readOnly
}

// change runs op on the list as the file holds it now, under
// recent-groups.lock, and writes the result when op says so. A corrupt file
// is set aside first. On any failure nothing changes, in memory or on disk.
func (s *recentGroupStore) change(op func([]recentGroup) ([]recentGroup, bool)) error {
	return s.changeWithin(recentGroupsLockWait, op)
}

// changeWithin is change waiting at most wait for the lock; 0 is busy,
// without a log, when another process holds it.
func (s *recentGroupStore) changeWithin(wait time.Duration, op func([]recentGroup) ([]recentGroup, bool)) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	unlock, err := lockStateFile(filepath.Join(s.dir, recentGroupsLock), wait)
	if errors.Is(err, errStateLockTimeout) {
		if wait > 0 {
			log.Printf("recent groups: %s still locked after %s", recentGroupsLock, wait)
		}
		return errRecentBusy
	}
	if err != nil {
		return fmt.Errorf("lock %s: %w", recentGroupsFile, err)
	}
	defer unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		if !errors.As(err, new(*corruptRecentError)) {
			return err
		}
		if err := s.setAsideLocked(); err != nil {
			return err
		}
	}
	if s.readOnly {
		return errRecentNewer
	}
	next, write := op(slices.Clone(s.list))
	if !write {
		return nil
	}
	data, err := json.Marshal(recentGroupFile{V: recentGroupsFormat, Groups: next})
	if err != nil {
		return err
	}
	if err := writeStateFile("recent groups", s.dir, "recent-groups", s.path(), data, false); err != nil {
		return fmt.Errorf("write %s: %w", recentGroupsFile, err)
	}
	s.list = next
	s.modTime, s.size = time.Time{}, 0
	if fi, err := os.Lstat(s.path()); err == nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	return nil
}

// setAsideLocked renames a corrupt file out of the way, so the list starts
// again without losing what it held.
func (s *recentGroupStore) setAsideLocked() error {
	bad := s.path() + ".bad-" + strconv.FormatInt(s.now().UnixNano(), 10)
	if err := os.Rename(s.path(), bad); err != nil {
		return fmt.Errorf("set aside %s: %w", recentGroupsFile, err)
	}
	log.Printf("recent groups: set the unreadable %s aside as %s", recentGroupsFile, filepath.Base(bad))
	s.list, s.readOnly = nil, false
	s.modTime, s.size, s.badTime, s.badSize = time.Time{}, 0, time.Time{}, 0
	return nil
}

// validRecentID: ids are 16 lowercase hex digits, as the templates'.
func validRecentID(id string) bool { return validTemplateID(id) }

// sameRecentDir compares two resolved directories, without case on Windows.
func sameRecentDir(a, b string, windows bool) bool {
	if windows {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// record puts the group created as name in cwd (as typed, cleaned; real
// resolved) first. A directory already there, by real, moves up with the
// new name and spelling, keeping its id; beyond maxRecentGroups the oldest
// goes. A newer version's file is left as it is, without an error, and so
// is an entry entries would not show (a directory resolved to a UNC path
// through a Windows junction): it would take a place nobody can free.
func (s *recentGroupStore) record(name, cwd, real string) error {
	windows := runtime.GOOS == "windows"
	if !validateTmuxTarget(name) || !validCwdForm(cwd, windows) || !validCwdForm(real, windows) {
		return nil
	}
	err := s.change(func(list []recentGroup) ([]recentGroup, bool) {
		e := recentGroup{ID: newTemplateID()}
		if i := slices.IndexFunc(list, func(g recentGroup) bool { return sameRecentDir(g.Real, real, windows) }); i >= 0 {
			e.ID = list[i].ID
			list = slices.Delete(list, i, i+1)
		}
		e.Name, e.Cwd, e.Real, e.Used = name, cwd, real, s.now().UTC().Format(time.RFC3339)
		list = append([]recentGroup{e}, list...)
		if len(list) > maxRecentGroups {
			list = list[:maxRecentGroups]
		}
		return list, true
	})
	if errors.Is(err, errRecentNewer) {
		return nil
	}
	return err
}

// prune drops the entries drop names from the file (one under a denied
// dir), only when the lock is free now: a read calls it and never waits
// (errRecentBusy otherwise). A newer version's file is left as it is,
// without taking the lock.
func (s *recentGroupStore) prune(drop func(recentGroup) bool) error {
	s.mu.Lock()
	readOnly := s.readOnly
	s.mu.Unlock()
	if readOnly {
		return nil
	}
	err := s.changeWithin(0, func(list []recentGroup) ([]recentGroup, bool) {
		n := len(list)
		next := slices.DeleteFunc(list, drop)
		return next, len(next) != n
	})
	if errors.Is(err, errRecentNewer) {
		return nil
	}
	return err
}

// remove drops the entry id.
func (s *recentGroupStore) remove(id string) error {
	if !validRecentID(id) {
		return errUnknownRecent
	}
	var found bool
	err := s.change(func(list []recentGroup) ([]recentGroup, bool) {
		i := slices.IndexFunc(list, func(g recentGroup) bool { return g.ID == id })
		if found = i >= 0; !found {
			return nil, false
		}
		return slices.Delete(list, i, i+1), true
	})
	if err == nil && !found {
		return errUnknownRecent
	}
	return err
}
