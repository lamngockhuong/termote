package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// A file the agent in a pane named in its transcript (a scratchpad note
// under /tmp, a report in another folder) is outside the pane's root and
// every Place. files/mentioned opens one such file, read only: the client
// sends the absolute path the agent wrote, the server reads that pane's
// own transcript and answers only when the path is there, then hands out
// an opaque id the Files read routes take as a Place whose root is the
// file's folder and whose only file is that one.

const (
	// mentionedPrefix starts every id files/mentioned hands out; a Place
	// id is 16 hex digits, so the two never meet.
	mentionedPrefix = "m-"
	// mentionedTTL is how long an id stays valid after its last use.
	mentionedTTL = time.Hour
	// mentionedMax is how many ids are kept; the oldest goes first.
	mentionedMax = 128
	// mentionedMaxPath bounds the path sent, before any read.
	mentionedMaxPath = 4096
	// mentionedChunk is how much of a transcript is read at a time.
	mentionedChunk = 1 << 20
)

var (
	errNotMentioned   = &codedError{"not_mentioned", "the agent did not name this file", http.StatusNotFound}
	errMentionedRoute = &codedError{"place_not_supported", "not available for a file the agent named", http.StatusBadRequest}
)

// mentionedFile is one id: the pane it was opened for and the file.
type mentionedFile struct {
	paneID string
	path   string
	used   time.Time
}

// mentionedFiles holds the ids handed out, in memory only: a restart
// forgets them (unknown_place), and the client asks again.
type mentionedFiles struct {
	mu    sync.Mutex
	now   func() time.Time
	files map[string]*mentionedFile
}

func newMentionedFiles() *mentionedFiles {
	return &mentionedFiles{now: time.Now, files: map[string]*mentionedFile{}}
}

// add returns the id of path for paneID, the one already handed out when
// there is one.
func (m *mentionedFiles) add(paneID, path string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	m.expire(now)
	for id, f := range m.files {
		if f.paneID == paneID && f.path == path {
			f.used = now
			return id
		}
	}
	if len(m.files) >= mentionedMax {
		oldest := ""
		for id, f := range m.files {
			if oldest == "" || f.used.Before(m.files[oldest].used) {
				oldest = id
			}
		}
		delete(m.files, oldest)
	}
	var b [16]byte
	_, _ = rand.Read(b[:])
	id := mentionedPrefix + hex.EncodeToString(b[:])
	m.files[id] = &mentionedFile{paneID: paneID, path: path, used: now}
	return id
}

// get returns the file of id when it was handed out for paneID.
func (m *mentionedFiles) get(id, paneID string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	m.expire(now)
	f, ok := m.files[id]
	if !ok || f.paneID != paneID {
		return "", false
	}
	f.used = now
	return f.path, true
}

func (m *mentionedFiles) expire(now time.Time) {
	for id, f := range m.files {
		if now.Sub(f.used) > mentionedTTL {
			delete(m.files, id)
		}
	}
}

// mentionedReadRoutes are the only routes an id opens: the text, an image
// and a document of the one file. Nothing lists, searches or writes.
var mentionedReadRoutes = []string{"/files/content", "/files/raw", "/files/document"}

// isMentionedID reports an id files/mentioned hands out.
func isMentionedID(id string) bool { return strings.HasPrefix(id, mentionedPrefix) }

// mentionedRoot is the root of the id: the file's folder, for a read of
// that file alone, by the pane it was opened for.
func (f *filesAPI) mentionedRoot(r *http.Request, id string) (filesRoot, error) {
	if f.mentioned == nil {
		return filesRoot{}, errUnknownPlace
	}
	p, ok := f.mentioned.get(id, r.PathValue("id"))
	if !ok {
		return filesRoot{}, errUnknownPlace
	}
	readRoute := false
	for _, s := range mentionedReadRoutes {
		readRoute = readRoute || strings.HasSuffix(r.URL.Path, s)
	}
	if r.Method != http.MethodGet || !readRoute {
		return filesRoot{}, errMentionedRoute
	}
	if r.URL.Query().Get("path") != filepath.Base(p) {
		return filesRoot{}, errPathNotAllowed
	}
	// Checked again at each read: a folder on the way may have become a
	// symlink into a git dir since.
	if gitDirOnPath(p) {
		return filesRoot{}, errPathNotAllowed
	}
	return filesRoot{Root: filepath.Dir(p)}, nil
}

// gitDirOnPath reports a git dir among the components of p or of where it
// leads: the root of a mentioned file is its folder, so denied() only sees
// the name.
func gitDirOnPath(p string) bool {
	for _, q := range []string{p, resolvedPath(p)} {
		rest := strings.TrimPrefix(q, filepath.VolumeName(q))
		for _, part := range strings.Split(filepath.ToSlash(rest), "/") {
			if isGitDirName(part) {
				return true
			}
		}
	}
	return false
}

type mentionedRequest struct {
	Path string `json:"path"`
	// Agent and Session name a past session of the pane's folder (the
	// History): its transcript is read instead of the live one
	Agent   string `json:"agent,omitempty"`
	Session string `json:"session,omitempty"`
}

type mentionedResponse struct {
	// Place is the id the Files read routes take as place=
	Place string `json:"place"`
	Root  string `json:"root"`
	Path  string `json:"path"`
}

// handleMentioned opens a file the pane's agent named, read only: POST
// {"path": "<absolute path>"}. Full role only (a view-only client never
// sees a tool's input, where most paths are). 404 not_mentioned: the
// pane's transcript does not hold that path.
func (f *filesAPI) handleMentioned(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if msg := crossSiteRejection(f.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireWriteRole(w, r) {
		return
	}
	var in mentionedRequest
	if !decodeJSON(w, r, &in) {
		return
	}
	if f.dirs == nil || !f.m.Caps().Files || f.mentions == nil || f.mentioned == nil {
		f.error(w, "files mentioned", errUnsupported)
		return
	}
	p, err := mentionedPath(in.Path)
	if err != nil {
		f.error(w, "files mentioned", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), filesTimeout)
	defer cancel()
	paneID := r.PathValue("id")
	ok, err := f.mentions(ctx, paneID, in.Agent, in.Session, in.Path)
	if err != nil {
		f.error(w, "files mentioned", err)
		return
	}
	if !ok {
		f.error(w, "files mentioned", errNotMentioned)
		return
	}
	dir, base := filepath.Dir(p), filepath.Base(p)
	if gitDirOnPath(p) || f.denied(dir, base) {
		f.error(w, "files mentioned", errPathNotAllowed)
		return
	}
	if fi, err := os.Stat(p); err != nil {
		f.error(w, "files mentioned", err)
		return
	} else if fi.IsDir() {
		f.error(w, "files mentioned", fs.ErrNotExist)
		return
	}
	jsonOK(w, mentionedResponse{Place: f.mentioned.add(paneID, p), Root: dir, Path: base})
}

// mentionedPath is p, absolute and without a "." or ".." part, as the host
// spells it; errInvalidPath otherwise.
func mentionedPath(p string) (string, error) {
	if p == "" || len(p) > mentionedMaxPath || strings.ContainsRune(p, 0) {
		return "", errInvalidPath
	}
	native := filepath.FromSlash(p)
	if !filepath.IsAbs(native) {
		return "", errInvalidPath
	}
	rest := strings.TrimPrefix(native, filepath.VolumeName(native))
	for _, part := range strings.Split(filepath.ToSlash(rest), "/") {
		if part == "." || part == ".." {
			return "", errInvalidPath
		}
	}
	clean := filepath.Clean(native)
	if filepath.Dir(clean) == clean {
		return "", errInvalidPath
	}
	return clean, nil
}

// transcriptMentions reports whether the transcript of paneID's agent
// names path, as the agent wrote it: the live session's, or with agent and
// session the past one the History lists for the pane's folder.
func (a *agentAPI) transcriptMentions(ctx context.Context, paneID, agent, session, path string) (bool, error) {
	var s AgentSession
	if agent != "" || session != "" {
		if !historySessionID(agent, session) || a.files == nil || a.history == nil {
			return false, nil
		}
		root, err := a.files.paneRootForRead(ctx, paneID)
		if err != nil {
			return false, err
		}
		h, ok := a.findHistorySession(root.Root, agent, session)
		if !ok {
			return false, nil
		}
		s = a.historyAgentSession(h)
	} else {
		var err error
		s, err = a.session(paneID)
		if errors.Is(err, errNoAgentSession) || errors.Is(err, errAgentUnsupported) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
	}
	adapter, ok := journalAdapters[s.Agent]
	if !ok {
		return false, nil
	}
	at, err := adapter.Locate(s)
	if err != nil {
		return false, nil
	}
	fh, err := os.OpenFile(at, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return false, nil
	}
	defer fh.Close()
	return mentionsIn(fh, mentionNeedles(path))
}

// mentionNeedles are the forms path takes in a JSON line: as written, and
// escaped in a JSON string (a Windows path's backslashes doubled).
func mentionNeedles(path string) [][]byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(path)
	quoted := bytes.TrimSpace(buf.Bytes())
	escaped := quoted[1 : len(quoted)-1]
	out := [][]byte{[]byte(path)}
	if !bytes.Equal(escaped, out[0]) {
		out = append(out, escaped)
	}
	return out
}

// mentionsIn reports whether r holds one of needles as a whole path: not
// the end of a longer one (/x/tmp/a for /tmp/a) nor the start of one
// (/tmp/a.md for /tmp/a). Read a chunk at a time, so a large transcript is
// never held whole.
func mentionsIn(r io.Reader, needles [][]byte) (bool, error) {
	longest := 0
	for _, n := range needles {
		longest = max(longest, len(n))
	}
	if longest == 0 {
		return false, nil
	}
	// The bytes kept from one chunk to the next: a needle cut at the
	// chunk's end, the three bytes before it and the two after it.
	keep := longest + 5
	buf := make([]byte, 0, mentionedChunk+keep)
	chunk := make([]byte, mentionedChunk)
	start := true
	for {
		n, err := io.ReadFull(r, chunk)
		buf = append(buf, chunk[:n]...)
		eof := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
		if err != nil && !eof {
			return false, err
		}
		for _, needle := range needles {
			for i := 0; ; {
				j := bytes.Index(buf[i:], needle)
				if j < 0 {
					break
				}
				s, e := i+j, i+j+len(needle)
				if !eof && e+2 > len(buf) {
					break // decided with the next chunk, which keeps it
				}
				if (s > 0 || start) && wholePath(buf, s, e) {
					return true, nil
				}
				i = s + 1
			}
		}
		if eof {
			return false, nil
		}
		if cut := len(buf) - keep; cut > 0 {
			buf = append(buf[:0], buf[cut:]...)
			start = false
		}
	}
}

// pathByte is a byte that goes on a path's name: a letter, a digit, one of
// _ - ~ / \, or any byte of a non-ASCII character.
func pathByte(c byte) bool {
	return c >= 0x80 || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
		c == '_' || c == '-' || c == '~' || c == '/' || c == '\\'
}

// wholePath reports whether buf[s:e] stands alone: no path byte or "." just
// before it (but the n, r or t of a JSON \n, \r, \t: a line break), and
// after it none that carries the name on. A "." after it ends a sentence
// unless a name byte follows; a "\" is a JSON escape (\" \n) unless another
// "\" or a "/" follows it.
func wholePath(buf []byte, s, e int) bool {
	if s > 0 && (pathByte(buf[s-1]) || buf[s-1] == '.') && !jsonBreakBefore(buf, s) {
		return false
	}
	if e >= len(buf) {
		return true
	}
	next := byte(0)
	if e+1 < len(buf) {
		next = buf[e+1]
	}
	switch c := buf[e]; {
	case c == '.':
		return !pathByte(next) || next == '\\'
	case c == '\\':
		return next != '\\' && next != '/'
	default:
		return !pathByte(c)
	}
}

// jsonBreakBefore reports a JSON \n, \r or \t just before buf[s] (not an
// escaped backslash followed by a letter).
func jsonBreakBefore(buf []byte, s int) bool {
	if s < 2 || buf[s-2] != '\\' || !strings.ContainsRune("nrt", rune(buf[s-1])) {
		return false
	}
	return s < 3 || buf[s-3] != '\\'
}
