package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A Codex thread forked from another (`codex fork`, /fork in the TUI)
// writes a rollout of its own whose session_meta names the thread it came
// from (forked_from_id) and which holds only what is said after the fork:
// Codex reads the conversation before it from the parent's rollout (checked
// on Codex 0.169.0). A fork's transcript is read the same way: the parent's
// rollout up to the fork (its rows written no later than the fork's
// session_meta, as the parent may still be running), then the fork's own,
// as one stream whose offsets run on from the parent's part, so cursors and
// image refs work unchanged. A parent that is itself a fork brings its own,
// up to codexForkDepth. The parent's id comes from the fork's rollout, never
// from the client; the parent is found by that id among the rollouts of the
// same CODEX_HOME/sessions, opened as the history opens a file (resolved
// inside it, regular) and taken only when its own session_meta names that
// id. A thread forked for a subagent is not a user's fork and reads as
// itself.

const codexForkDepth = 8

// codexForkCacheMax bounds the forks remembered; past it the cache starts
// over.
const codexForkCacheMax = 512

// codexForkLink is a part of an ancestor's rollout read before a fork: the
// file (resolved, with its identity when found) and the offset it is cut at.
type codexForkLink struct {
	path, ident string
	cut         int64
}

// codexForks remembers each rollout's ancestors, oldest first (none for a
// thread that is no fork), by path and identity: session_meta is written
// once, and the rows of a parent before a fork never change.
var codexForks = struct {
	sync.Mutex
	m map[string][]codexForkLink
}{m: map[string][]codexForkLink{}}

// codexRolloutMeta is the part of a rollout's session_meta row a fork is
// read by.
type codexRolloutMeta struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		ID           string `json:"id"`
		ThreadSource string `json:"thread_source"`
		ForkedFrom   string `json:"forked_from_id"`
	} `json:"payload"`
}

// readCodexRolloutMeta reads r's first line as session_meta.
func readCodexRolloutMeta(r io.ReaderAt, size int64) (codexRolloutMeta, bool) {
	br := bufio.NewReaderSize(io.NewSectionReader(r, 0, min(size, codexMetaMax)), 64<<10)
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		line = append(line, chunk...)
		if err == nil {
			break
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return codexRolloutMeta{}, false
		}
	}
	var meta codexRolloutMeta
	if json.Unmarshal(line, &meta) != nil || meta.Type != "session_meta" || !isSessionID(meta.Payload.ID) {
		return codexRolloutMeta{}, false
	}
	return meta, true
}

// forkOf is the thread a user's fork was forked from, "" for any other.
func (m codexRolloutMeta) forkOf() string {
	if m.Payload.ThreadSource != "user" || !isSessionID(m.Payload.ForkedFrom) || m.Payload.ForkedFrom == m.Payload.ID {
		return ""
	}
	return m.Payload.ForkedFrom
}

// codexForkView returns the rollout f (at path, of size and identity id)
// after the parts of its ancestors' it was forked from, with the stream's
// size and an identity that names every part; f itself when it is no fork,
// or when an ancestor cannot be read as it was found.
func codexForkView(codexHome, path string, f *os.File, size int64, id string) (journalReader, int64, string) {
	if codexHome == "" || !filepath.IsAbs(codexHome) {
		return f, size, id
	}
	sessions, err := filepath.EvalSymlinks(filepath.Join(codexHome, "sessions"))
	if err != nil {
		return f, size, id
	}
	links := codexForkLinks(sessions, path, id, f, size)
	if len(links) == 0 {
		return f, size, id
	}
	r := &codexForkReader{}
	var base int64
	var ident strings.Builder
	ident.WriteString(id)
	for _, l := range links {
		pf, fi, real, ok := openHistoryFile(sessions, l.path)
		if ok && (real != l.path || fi.Size() < l.cut || rolloutIdent(real, pf, fi) != l.ident) {
			pf.Close()
			ok = false
		}
		if !ok {
			// Replaced or gone since it was found: read the fork as itself,
			// and look its ancestors up again next time.
			r.closeParts()
			codexForks.Lock()
			delete(codexForks.m, path+"\x00"+id)
			codexForks.Unlock()
			return f, size, id
		}
		r.parts = append(r.parts, codexForkPart{pf, base, l.cut})
		base += l.cut
		ident.WriteString("+" + l.ident + "@" + strconv.FormatInt(l.cut, 10))
	}
	r.parts = append(r.parts, codexForkPart{f, base, size})
	return r, base + size, ident.String()
}

// rolloutIdent is a rollout's identity, its name where the system gives
// none.
func rolloutIdent(path string, f *os.File, fi os.FileInfo) string {
	if id := rolloutIdentity(path, f, fi); id != "" {
		return id
	}
	return filepath.Base(path)
}

// codexForkLinks is the ancestors of the rollout f, remembered.
func codexForkLinks(sessions, path, id string, f *os.File, size int64) []codexForkLink {
	key := path + "\x00" + id
	codexForks.Lock()
	links, ok := codexForks.m[key]
	codexForks.Unlock()
	if ok {
		return links
	}
	links, ok = findCodexForkLinks(sessions, path, f, size)
	if !ok {
		return nil // no session_meta yet: looked at again next time
	}
	codexForks.Lock()
	if len(codexForks.m) >= codexForkCacheMax {
		codexForks.m = map[string][]codexForkLink{}
	}
	codexForks.m[key] = links
	codexForks.Unlock()
	return links
}

// findCodexForkLinks finds the ancestors of the rollout f at path (in
// sessions, resolved), oldest first. ok is false when f has no complete
// session_meta yet.
func findCodexForkLinks(sessions, path string, f *os.File, size int64) ([]codexForkLink, bool) {
	meta, ok := readCodexRolloutMeta(f, size)
	if !ok {
		return nil, false
	}
	var links []codexForkLink // newest first
	seen := map[string]bool{meta.Payload.ID: true}
	child := path
	for range codexForkDepth {
		parent := meta.forkOf()
		at, err := time.Parse(time.RFC3339Nano, meta.Timestamp)
		if parent == "" || seen[parent] || err != nil {
			break
		}
		link, pmeta, ok := codexForkLinkTo(sessions, child, parent, at)
		if !ok {
			break
		}
		links = append(links, link)
		seen[parent] = true
		meta, child = pmeta, link.path
	}
	slices.Reverse(links)
	return links, true
}

// codexForkLinkTo finds the rollout of thread parent, which child was
// forked from at at, and the offset its rows written after at start from.
func codexForkLinkTo(sessions, child, parent string, at time.Time) (codexForkLink, codexRolloutMeta, bool) {
	p, ok := findCodexRollout(sessions, child, parent)
	if !ok {
		return codexForkLink{}, codexRolloutMeta{}, false
	}
	pf, fi, real, ok := openHistoryFile(sessions, p)
	if !ok {
		return codexForkLink{}, codexRolloutMeta{}, false
	}
	defer pf.Close()
	if m := codexRolloutRe.FindStringSubmatch(filepath.Base(real)); m == nil || m[1] != parent {
		return codexForkLink{}, codexRolloutMeta{}, false
	}
	pmeta, ok := readCodexRolloutMeta(pf, fi.Size())
	if !ok || pmeta.Payload.ID != parent {
		return codexForkLink{}, codexRolloutMeta{}, false
	}
	cut := codexCutAt(pf, fi.Size(), at)
	if cut == 0 {
		return codexForkLink{}, codexRolloutMeta{}, false
	}
	return codexForkLink{real, rolloutIdent(real, pf, fi), cut}, pmeta, true
}

// findCodexRollout finds the rollout of thread id among the day dirs of
// sessions, from child's day back (a thread is forked after it started),
// looking at no more than historyMaxScan rollouts.
func findCodexRollout(sessions, child, id string) (string, bool) {
	rel, err := filepath.Rel(sessions, filepath.Dir(child))
	from := strings.Split(filepath.ToSlash(rel), "/")
	if err != nil || len(from) != 3 {
		return "", false
	}
	scanned := 0
	for _, y := range numberedDirs(sessions) {
		for _, m := range numberedDirs(filepath.Join(sessions, y)) {
			for _, d := range numberedDirs(filepath.Join(sessions, y, m)) {
				if dayBefore(from, []string{y, m, d}) {
					continue
				}
				day := filepath.Join(sessions, y, m, d)
				entries, err := os.ReadDir(day)
				if err != nil {
					continue
				}
				for _, e := range slices.Backward(entries) {
					match := codexRolloutRe.FindStringSubmatch(e.Name())
					if match == nil || e.IsDir() {
						continue
					}
					if match[1] == id {
						return filepath.Join(day, e.Name()), true
					}
					if scanned++; scanned >= historyMaxScan {
						return "", false
					}
				}
			}
		}
	}
	return "", false
}

// codexCutAt is the offset of r's first complete row written after at (its
// timestamp), else the end of its last complete row. A row whose time
// cannot be read is kept.
func codexCutAt(r io.ReaderAt, size int64, at time.Time) int64 {
	br := bufio.NewReaderSize(io.NewSectionReader(r, 0, size), 64<<10)
	var off int64
	for {
		line, err := br.ReadSlice('\n')
		ts, known := codexRowTime(line, err == nil)
		n := int64(len(line))
		for errors.Is(err, bufio.ErrBufferFull) {
			line, err = br.ReadSlice('\n')
			n += int64(len(line))
		}
		if err != nil {
			return off // no complete row left
		}
		if known && ts.After(at) {
			return off
		}
		off += n
	}
}

var codexTimestampPrefix = []byte(`{"timestamp":"`)

// codexRowTime reads the time a rollout row was written: its first field,
// or the whole row decoded when complete.
func codexRowTime(head []byte, complete bool) (time.Time, bool) {
	if rest, ok := bytes.CutPrefix(head, codexTimestampPrefix); ok {
		if i := bytes.IndexByte(rest, '"'); i > 0 {
			t, err := time.Parse(time.RFC3339Nano, string(rest[:i]))
			return t, err == nil
		}
	}
	if !complete {
		return time.Time{}, false
	}
	var row struct {
		Timestamp string `json:"timestamp"`
	}
	if json.Unmarshal(head, &row) != nil {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, row.Timestamp)
	return t, err == nil
}

// codexForkReader reads parts of files as one stream: each part's bytes
// [0, size) at offsets [base, base+size).
type codexForkReader struct {
	parts []codexForkPart
}

type codexForkPart struct {
	f          *os.File
	base, size int64
}

func (r *codexForkReader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, errors.New("negative offset")
	}
	n := 0
	for _, part := range r.parts {
		if len(p) == 0 {
			break
		}
		end := part.base + part.size
		if off >= end {
			continue
		}
		want := min(int64(len(p)), end-off)
		k, err := part.f.ReadAt(p[:want], off-part.base)
		n += k
		off += int64(k)
		p = p[k:]
		if int64(k) < want {
			if err == nil || errors.Is(err, io.EOF) {
				err = io.ErrUnexpectedEOF
			}
			return n, err
		}
	}
	if len(p) > 0 {
		return n, io.EOF
	}
	return n, nil
}

func (r *codexForkReader) closeParts() {
	for _, part := range r.parts {
		part.f.Close()
	}
	r.parts = nil
}

func (r *codexForkReader) Close() error {
	r.closeParts()
	return nil
}
