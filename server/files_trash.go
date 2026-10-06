package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

const (
	// trashMaxAge: an entry deleted longer ago than this is removed.
	trashMaxAge = 7 * 24 * time.Hour
	// trashMaxTotal: past this many bytes of deleted files, the oldest go.
	trashMaxTotal = 1 << 30
	// trashMinAge: an entry younger than this is never removed for space,
	// so the Undo of a delete always works.
	trashMinAge = time.Hour
	// trashOrphanAge: a payload without its record (or the reverse, or a
	// .part) left by a server that died goes once seen this long.
	trashOrphanAge = 10 * time.Minute
	// trashRecordMax caps a record read back.
	trashRecordMax = 64 << 10
)

var (
	errTrashUnavailable = &rawError{"trash_unavailable", "the trash is not available on this server", http.StatusServiceUnavailable}
	errNotInTrash       = &rawError{"not_in_trash", "nothing in the trash under that id", http.StatusNotFound}
	errCrossDevice      = &rawError{"cross_device", "the file is on another file system than the trash", http.StatusConflict}
	errInvalidTrashID   = inputError("invalid trashId")

	// trashIDRe is an entry's id; trashNameRe every name the store makes:
	// a payload, its record, and the record's .part while it is written.
	trashIDRe   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	trashNameRe = regexp.MustCompile(`^[0-9a-f]{32}(\.json(\.part)?)?$`)
)

// trashRecord says what an entry of the trash was. Its age is always
// DeletedAt, never the payload's mtime: a rename keeps the mtime, and a file
// last written a week ago must not go at the next delete.
type trashRecord struct {
	Root      string    `json:"root"`
	Path      string    `json:"path"` // '/'-separated, relative to Root
	Kind      string    `json:"kind"` // file | dir
	DeletedAt time.Time `json:"deletedAt"`
	Size      int64     `json:"size"`
	// Mode is a directory's permissions, made again by a restore.
	Mode fs.FileMode `json:"mode,omitempty"`
}

// trashStore keeps deleted files so a delete can be undone: a file is
// renamed into the store as <id> next to its record <id>.json; a deleted
// directory (always empty) has only a record. Only names the store makes
// are ever removed, and never through a directory or a symlink.
type trashStore struct {
	dir                       string
	maxAge, minAge, orphanAge time.Duration
	maxTotal                  int64
	now                       func() time.Time
	// mu covers every change to the store: a delete's record and rename,
	// a restore from reading its record to removing it, and the sweep.
	mu sync.Mutex
	// firstSeen is when the sweep first saw a name it holds no record
	// for, by name.
	firstSeen map[string]time.Time
}

// trashDir is where deleted files go: next to the upload store, in the
// user's cache dir. Empty when there is none.
func trashDir() string {
	cache, err := os.UserCacheDir()
	if err != nil {
		log.Printf("trash disabled: %v", err)
		return ""
	}
	return filepath.Join(cache, "termote", "trash")
}

// newTrashStore creates dir (0700) and refuses one that is a symlink or, on
// Unix, belongs to another user, then sweeps it.
func newTrashStore(dir string) (*trashStore, error) {
	if dir == "" {
		return nil, errors.New("no trash dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	if err := checkPrivateDir(dir); err != nil {
		return nil, err
	}
	s := &trashStore{
		dir: dir, maxAge: trashMaxAge, minAge: trashMinAge, orphanAge: trashOrphanAge,
		maxTotal: trashMaxTotal, now: time.Now, firstSeen: map[string]time.Time{},
	}
	s.mu.Lock()
	s.sweepLocked()
	s.mu.Unlock()
	return s, nil
}

func (s *trashStore) open() (*os.Root, error) { return os.OpenRoot(s.dir) }

// writeRecordLocked writes id's record through a .part (0600, O_EXCL)
// renamed into place.
func (s *trashStore) writeRecordLocked(id string, rec trashRecord) error {
	b, _ := json.Marshal(rec) // plain fields: never fails
	part := filepath.Join(s.dir, id+".json.part")
	fh, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = fh.Write(b)
	if cerr := fh.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(part, filepath.Join(s.dir, id+".json"))
	}
	if err != nil {
		os.Remove(part)
	}
	return err
}

// readRecordLocked reads id's record; errNotInTrash when there is none.
func (s *trashStore) readRecordLocked(id string) (trashRecord, error) {
	fh, err := os.Open(filepath.Join(s.dir, id+".json"))
	if errors.Is(err, fs.ErrNotExist) {
		return trashRecord{}, errNotInTrash
	}
	if err != nil {
		return trashRecord{}, err
	}
	defer fh.Close()
	var rec trashRecord
	if err := json.NewDecoder(io.LimitReader(fh, trashRecordMax)).Decode(&rec); err != nil {
		return trashRecord{}, fmt.Errorf("trash record %s: %w", id, err)
	}
	return rec, nil
}

func (s *trashStore) removeRecordLocked(id string) {
	os.Remove(filepath.Join(s.dir, id+".json"))
}

// sweepLocked removes entries deleted longer ago than maxAge, names left
// half done longer than orphanAge, then the oldest files (never one younger
// than minAge) until the payloads fit in maxTotal.
func (s *trashStore) sweepLocked() {
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		log.Printf("trash: read %s: %v", s.dir, err)
		return
	}
	now := s.now()
	payloads := map[string]fs.FileInfo{} // id → regular file
	records := map[string]trashRecord{}
	var odd []string // .part files and records that do not parse
	for _, e := range ents {
		name := e.Name()
		if !trashNameRe.MatchString(name) {
			continue
		}
		switch {
		case trashIDRe.MatchString(name):
			// A directory or a symlink under a payload's name was not
			// made here: never followed, never removed.
			if fi, err := os.Lstat(filepath.Join(s.dir, name)); err == nil && fi.Mode().IsRegular() {
				payloads[name] = fi
			}
		case filepath.Ext(name) == ".json":
			id := name[:32]
			if rec, err := s.readRecordLocked(id); err == nil {
				records[id] = rec
			} else {
				odd = append(odd, name)
			}
		default:
			odd = append(odd, name)
		}
	}
	seen := map[string]bool{}
	orphan := func(name string) bool {
		seen[name] = true
		first, ok := s.firstSeen[name]
		if !ok {
			s.firstSeen[name] = now
			return false
		}
		return now.Sub(first) >= s.orphanAge
	}
	remove := func(name string) {
		os.Remove(filepath.Join(s.dir, name))
		delete(s.firstSeen, name)
	}
	for _, name := range odd {
		if orphan(name) {
			remove(name)
		}
	}
	for id, rec := range records {
		fi, hasPayload := payloads[id]
		switch {
		case now.Sub(rec.DeletedAt) >= s.maxAge:
			if hasPayload {
				remove(id)
			}
			remove(id + ".json")
			delete(payloads, id)
		case rec.Kind == "file" && hasPayload && s.restoredLinkLocked(rec, fi):
			// A restore through link + unlink died in between: the file
			// is back, only the trash's second link to it is left.
			remove(id)
			remove(id + ".json")
			delete(payloads, id)
		case rec.Kind == "file" && !hasPayload:
			if orphan(id + ".json") {
				remove(id + ".json")
			}
		}
	}
	for id := range payloads {
		if _, ok := records[id]; !ok && orphan(id) {
			remove(id)
			delete(payloads, id)
		}
	}
	for name := range s.firstSeen {
		if !seen[name] {
			delete(s.firstSeen, name)
		}
	}
	s.trimLocked(now, payloads, records)
}

// restoredLinkLocked reports whether the file at rec's path is fi itself.
func (s *trashStore) restoredLinkLocked(rec trashRecord, fi fs.FileInfo) bool {
	at, err := os.Lstat(filepath.Join(rec.Root, filepath.FromSlash(rec.Path)))
	return err == nil && os.SameFile(at, fi)
}

// trimLocked removes the oldest payloads, never one younger than minAge,
// until the rest fit in maxTotal.
func (s *trashStore) trimLocked(now time.Time, payloads map[string]fs.FileInfo, records map[string]trashRecord) {
	var total int64
	ids := make([]string, 0, len(payloads))
	for id, fi := range payloads {
		total += fi.Size()
		ids = append(ids, id)
	}
	if total <= s.maxTotal {
		return
	}
	// Oldest first; a payload without a record (still in its grace
	// period) counts as deleted now.
	deletedAt := func(id string) time.Time {
		if rec, ok := records[id]; ok {
			return rec.DeletedAt
		}
		return now
	}
	sort.Slice(ids, func(i, j int) bool { return deletedAt(ids[i]).Before(deletedAt(ids[j])) })
	for _, id := range ids {
		if total <= s.maxTotal || now.Sub(deletedAt(id)) < s.minAge {
			return
		}
		os.Remove(filepath.Join(s.dir, id))
		os.Remove(filepath.Join(s.dir, id+".json"))
		total -= payloads[id].Size()
	}
}
