package main

import (
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"
)

const (
	// findStampSlack is how close to a build a directory's time leaves it
	// unsure whether the build saw the change: a file system's clock is
	// coarser than time.Now (Linux stamps from a clock a tick behind, FAT to
	// 2 s), and a change between reading a directory and stamping it carries
	// the time the stamp records.
	findStampSlack = 2 * time.Second
)

var (
	// findMaxStampDirs caps the directories a list's stamp checks; a list
	// read from more is only ended by findListTTL.
	findMaxStampDirs = 20_000
	// findStampEvery is how often a stamp is checked at most: a search runs
	// at every key typed, and a check stats every directory.
	// Variables, so tests can lower them.
	findStampEvery = time.Second
)

// findStamp tells whether a cached list still holds: a file made, removed
// or renamed changes the time of the directory holding it, wherever the
// change came from (the agent, a terminal, git pull), and git changes the
// index when what it tracks changes.
type findStamp struct {
	dirs []findStampDir
	// index is the repo's index file ("" outside a repo), indexMod its
	// time (zero when it did not exist)
	index    string
	indexMod time.Time
	// unsure: something changed around the build, so the first check
	// reads the list again
	unsure bool

	mu      sync.Mutex
	checked time.Time // the last check, or the stamp
	stale   bool      // a check found a change: it never holds again
}

type findStampDir struct {
	rel string // '/'-separated, "." the root
	mod time.Time
}

// newFindStamp stamps l, built from root from at on: the root, every
// directory a walk read and every directory above a listed file. Nil when
// that is more than findMaxStampDirs.
func newFindStamp(at time.Time, root filesRoot, l findList) *findStamp {
	seen := map[string]bool{".": true}
	add := func(d string) bool {
		seen[d] = true
		return len(seen) <= findMaxStampDirs
	}
	for _, d := range l.read {
		if !add(d) {
			return nil
		}
	}
	for _, e := range l.entries {
		for d := path.Dir(e.rel); d != "." && !seen[d]; d = path.Dir(d) {
			if !add(d) {
				return nil
			}
		}
	}
	s := &findStamp{dirs: make([]findStampDir, 0, len(seen))}
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		s.unsure = true
	} else {
		defer rt.Close()
	}
	for d := range seen {
		var mod time.Time
		if rt != nil {
			if fi, err := rt.Stat(filepath.FromSlash(d)); err == nil {
				mod = fi.ModTime()
			}
		}
		s.dirs = append(s.dirs, findStampDir{rel: d, mod: mod})
	}
	if root.IsRepo && root.GitDir != "" {
		s.index = filepath.Join(root.GitDir, "index")
		s.indexMod, _ = findStampMod(s.index)
	}
	// A time from before the build up to now may be a change the build
	// missed; one far ahead (a clock that went back, an archive's date) is
	// only compared.
	s.checked = time.Now()
	near := func(t time.Time) bool {
		return t.After(at.Add(-findStampSlack)) && t.Before(s.checked.Add(findStampSlack))
	}
	s.unsure = s.unsure || near(s.indexMod)
	for _, d := range s.dirs {
		s.unsure = s.unsure || d.mod.IsZero() || near(d.mod)
	}
	return s
}

// findStampMod is the time of the file at p; zero when there is none, ok
// false when it cannot be read.
func findStampMod(p string) (mod time.Time, ok bool) {
	fi, err := os.Stat(p)
	if err != nil {
		return time.Time{}, errors.Is(err, fs.ErrNotExist)
	}
	return fi.ModTime(), true
}

// changed reports whether something the list was read from changed since
// the stamp, or can no longer be read (a directory gone: a file under it
// went too). Checked at most every findStampEvery, by one caller at a time;
// once changed, always. A nil stamp never changes.
func (s *findStamp) changed(root string) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stale {
		return true
	}
	if now := time.Now(); now.Sub(s.checked) >= findStampEvery {
		s.checked = now
		s.stale = s.unsure || s.differs(root)
	}
	return s.stale
}

func (s *findStamp) differs(root string) bool {
	if s.index != "" {
		if mod, ok := findStampMod(s.index); !ok || !mod.Equal(s.indexMod) {
			return true
		}
	}
	rt, err := os.OpenRoot(root)
	if err != nil {
		return true
	}
	defer rt.Close()
	for _, d := range s.dirs {
		fi, err := rt.Stat(filepath.FromSlash(d.rel))
		if err != nil || !fi.IsDir() || !fi.ModTime().Equal(d.mod) {
			return true
		}
	}
	return false
}
