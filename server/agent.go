package main

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Transcript reading limits. A Claude Code transcript grows without bound and
// a single line can carry megabytes (a pasted image, a large file read).
const (
	// agentCacheTTL lets every client polling one pane share one lookup.
	agentCacheTTL = 500 * time.Millisecond
	// agentMaxEntries is how many entries a first read returns.
	agentMaxEntries = 200
	// agentTailChunk is the first window read back from the end of the file;
	// it doubles until agentMaxEntries are found or agentTailMax is reached.
	agentTailChunk = 256 * 1024
	agentTailMax   = 8 * 1024 * 1024
	// agentMaxLine is the longest line parsed; longer ones become a clipped
	// entry without being decoded.
	agentMaxLine = 2 * 1024 * 1024
	// agentForwardMax caps how much a cursor read takes in one go; a client
	// further behind than this starts over from the end.
	agentForwardMax = 8 * 1024 * 1024
)

// AgentSession is the agent session a pane is running, as its backend found it.
type AgentSession struct {
	Agent     string // "claude" | "codex"
	ID        string // the agent's session id (a UUID)
	Status    string // working | idle | blocked | done | unknown
	ClaudeDir string // Claude Code: its config dir, where its transcripts live
	// Codex: CODEX_HOME of the Codex process holding the rollout, the
	// resolved rollout path it holds open for writing, and the rollout's
	// rolloutIdentity when the process was found.
	CodexHome string
	Rollout   string
	RolloutID string
	// DialogsReadOnly: the status never says a dialog is open (Codex on
	// tmux, read from a rollout that records no approval request), so its
	// dialogs are shown, never answered from the client.
	DialogsReadOnly bool
	// PID and ProcStart identify the agent process (tmux), so a write can
	// check that the same process still runs before it touches the pane.
	PID       int
	ProcStart string
	Target    string // backend address of the pane: tmux "%N", herdr pane id
	// InMode: the pane shows tmux copy mode, which takes the keys sent to it
	// (only looked up for a write).
	InMode bool
}

// agentSessionLocator is implemented by backends that can tell which agent
// session a pane runs. It is not part of Mux: a backend without it answers
// 404 on the agent routes.
type agentSessionLocator interface {
	AgentSession(ctx context.Context, paneID string) (AgentSession, bool, error)
}

// journalAdapter reads one agent's transcript format. An agent has an adapter
// and a locator that reports it.
type journalAdapter interface {
	Agent() string
	// Locate returns the transcript path of s, never built from client input.
	Locate(s AgentSession) (string, error)
	// Parse reads complete lines from r, which starts at byte offset start of
	// the file, and returns their entries plus the offset after the last
	// complete line. A trailing line without '\n' is still being written and
	// is left for the next read.
	Parse(r io.Reader, start int64) ([]TranscriptEntry, int64)
}

var journalAdapters = map[string]journalAdapter{"claude": claudeJournal{}, "codex": codexJournal{}}

type TranscriptEntry struct {
	ID    string           `json:"id"`
	TS    string           `json:"ts,omitempty"`
	Role  string           `json:"role"` // user | assistant | summary | note
	Parts []TranscriptPart `json:"parts"`
	off   int64            // offset of the line the entry came from
}

type TranscriptPart struct {
	Kind    string `json:"kind"` // text | thinking | tool | image
	Text    string `json:"text,omitempty"`
	Tool    string `json:"tool,omitempty"`
	ToolID  string `json:"toolId,omitempty"`
	Input   string `json:"input,omitempty"` // one-line summary of the tool input
	Result  string `json:"result,omitempty"`
	IsError bool   `json:"isError,omitempty"`
	// Orphan: a tool result whose call is not in this read (older, or in an
	// earlier poll); the client attaches it by ToolID when it has the call.
	Orphan  bool `json:"orphan,omitempty"`
	Clipped bool `json:"clipped,omitempty"`
	// Detail: what the Chat view's card of a tool call shows beyond the
	// one-line Input; absent when the call has nothing more.
	Detail *ToolDetail `json:"detail,omitempty"`
}

// ToolDetail is a tool call's own description, its whole command and the
// text an edit replaced and put in, each capped.
type ToolDetail struct {
	Description string     `json:"description,omitempty"`
	Command     string     `json:"command,omitempty"`
	Edits       []ToolEdit `json:"edits,omitempty"`
	// Some of the above was cut, or edits of a sensitive file were left out
	Clipped bool `json:"clipped,omitempty"`
	Hidden  bool `json:"hidden,omitempty"`
}

// ToolEdit is one replacement of an edit; a new file has only New.
type ToolEdit struct {
	Old string `json:"old,omitempty"`
	New string `json:"new,omitempty"`
}

type transcriptResponse struct {
	Agent     string            `json:"agent"`
	SessionID string            `json:"sessionId"`
	Status    string            `json:"status"`
	Entries   []TranscriptEntry `json:"entries"`
	// Cursor continues a forward read; empty on a reply to a before read.
	Cursor string `json:"cursor"`
	// Before reads the entries older than this reply; empty at the start.
	Before string `json:"before,omitempty"`
	// Reset: the entries replace everything the client holds.
	Reset bool `json:"reset"`
}

// agentCursor is a position in one transcript file. Tokens are signed with a
// key that lives as long as the process, so a client can only send back a
// position the server issued.
type agentCursor struct {
	Session string `json:"s"`
	Offset  int64  `json:"o"`
	File    string `json:"f"` // file identity (device and inode where known)
}

var agentCursorKey = func() []byte {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		panic(err)
	}
	return k
}()

func cursorMAC(payload []byte) []byte {
	h := hmac.New(sha256.New, agentCursorKey)
	h.Write(payload)
	return h.Sum(nil)[:16]
}

func encodeCursor(c agentCursor) string {
	payload, _ := json.Marshal(c)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(payload) + "." + enc.EncodeToString(cursorMAC(payload))
}

func decodeCursor(s string) (agentCursor, bool) {
	var c agentCursor
	p, sig, ok := strings.Cut(s, ".")
	if !ok {
		return c, false
	}
	enc := base64.RawURLEncoding
	payload, err1 := enc.DecodeString(p)
	mac, err2 := enc.DecodeString(sig)
	if err1 != nil || err2 != nil || !hmac.Equal(mac, cursorMAC(payload)) {
		return c, false
	}
	if json.Unmarshal(payload, &c) != nil || c.Offset < 0 {
		return c, false
	}
	return c, true
}

// ttlCache runs fn once per key for every caller that arrives while it runs
// or within ttl after, so N clients polling one pane cost one lookup.
type ttlCache[V any] struct {
	ttl     time.Duration
	mu      sync.Mutex
	entries map[string]*ttlEntry[V]
}

type ttlEntry[V any] struct {
	done chan struct{}
	at   time.Time
	val  V
	err  error
}

func newTTLCache[V any](ttl time.Duration) *ttlCache[V] {
	return &ttlCache[V]{ttl: ttl, entries: map[string]*ttlEntry[V]{}}
}

func (c *ttlCache[V]) do(key string, fn func() (V, error)) (V, error) {
	c.mu.Lock()
	now := time.Now()
	if e, ok := c.entries[key]; ok {
		select {
		case <-e.done:
			if now.Sub(e.at) < c.ttl {
				c.mu.Unlock()
				return e.val, e.err
			}
		default:
			c.mu.Unlock()
			<-e.done
			return e.val, e.err
		}
	}
	for k, e := range c.entries {
		select {
		case <-e.done:
			if now.Sub(e.at) >= c.ttl {
				delete(c.entries, k)
			}
		default:
		}
	}
	e := &ttlEntry[V]{done: make(chan struct{}), err: errors.New("lookup failed")}
	c.entries[key] = e
	c.mu.Unlock()
	// Close done even if fn panics, or every later caller of key would wait
	// forever; they get the error set above.
	defer func() {
		e.at = time.Now()
		close(e.done)
	}()
	e.val, e.err = fn()
	return e.val, e.err
}

// forgetPrefix drops every entry whose key starts with prefix, so the next
// do reads again. A read in flight still answers its own waiters.
func (c *ttlCache[V]) forgetPrefix(prefix string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.entries {
		if strings.HasPrefix(k, prefix) {
			delete(c.entries, k)
		}
	}
}

var (
	errNoAgentSession = inputError("no agent session in this pane")
	errNoTranscript   = inputError("transcript not found")
	// errTranscriptNotWritten: the session is known but its transcript does
	// not exist yet (Claude Code writes it with the first message).
	errTranscriptNotWritten = inputError("transcript not written yet")
	errInvalidBefore        = inputError("invalid before")
	errAgentUnsupported     = errors.New("agent not available")
)

// agentAPI serves /api/mux/panes/{id}/agent/*.
type agentAPI struct {
	m        Mux
	loc      agentSessionLocator // nil when the backend has none
	sessions *ttlCache[agentLookup]
	reads    *ttlCache[transcriptResponse]
	input    *agentInput
	starts   *agentStarts
	// Set by registerCommandsRoute: the files routes' pane roots, the host
	// allowlist, the custom command listings and the server user's home
	// (for ~/.agents/skills).
	files    *filesAPI
	allowed  hostAllowlist
	commands *ttlCache[commandsResponse]
	home     string
	// uploads resolves image ids in a message; nil when the server has none.
	uploads *uploadStore
	// devices: devices can be paired (the snapshot's caps.devices); set by
	// buildServer.
	devices bool
	// signins: password sessions can be listed and revoked (the
	// snapshot's caps.signins); set by buildServer.
	signins bool
}

type agentLookup struct {
	s     AgentSession
	found bool
}

func newAgentAPI(m Mux) *agentAPI {
	loc, _ := m.(agentSessionLocator)
	return &agentAPI{
		m:        m,
		loc:      loc,
		sessions: newTTLCache[agentLookup](agentCacheTTL),
		reads:    newTTLCache[transcriptResponse](agentCacheTTL),
		input:    newAgentInput(),
		starts:   newAgentStarts(),
	}
}

func registerAgentRoutes(mux *http.ServeMux, m Mux, uploads *uploadStore) *agentAPI {
	a := newAgentAPI(m)
	a.uploads = uploads
	mux.HandleFunc("/api/mux/panes/{id}/agent/transcript", a.handleTranscript)
	a.registerInputRoutes(mux)
	return a
}

// session returns the pane's agent session, shared between concurrent
// requests for the same pane.
func (a *agentAPI) session(paneID string) (AgentSession, error) {
	if a.loc == nil {
		return AgentSession{}, errAgentUnsupported
	}
	r, err := a.sessions.do(paneID, func() (agentLookup, error) {
		ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
		defer cancel()
		s, ok, err := a.loc.AgentSession(ctx, paneID)
		return agentLookup{s, ok}, err
	})
	if err != nil {
		return AgentSession{}, err
	}
	if !r.found {
		return AgentSession{}, errNoAgentSession
	}
	return r.s, nil
}

func (a *agentAPI) handleTranscript(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	// A read, but a cross-site page has no reason to start one (with
	// --no-auth it would make the server read the transcript for nothing).
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	paneID := r.PathValue("id")
	s, err := a.session(paneID)
	if err != nil {
		a.agentError(w, "agent session", err)
		return
	}
	q := r.URL.Query()
	cursor, before := q.Get("cursor"), q.Get("before")
	// Only server-issued positions reach the cache key, so junk cursors
	// cannot each start a read of their own.
	if _, ok := decodeCursor(cursor); !ok {
		cursor = ""
	}
	if _, ok := decodeCursor(before); before != "" && !ok {
		a.agentError(w, "transcript", errInvalidBefore)
		return
	}
	key := strings.Join([]string{s.Agent, s.ID, s.ClaudeDir, s.CodexHome, s.Rollout, s.RolloutID, cursor, before}, "\x00")
	res, err := a.reads.do(key, func() (transcriptResponse, error) {
		return readTranscript(s, cursor, before)
	})
	if err != nil {
		a.agentError(w, "transcript", err)
		return
	}
	jsonOK(w, res)
}

// agentError answers like muxError, plus 404 for a pane without an agent.
func (a *agentAPI) agentError(w http.ResponseWriter, op string, err error) {
	switch {
	case errors.Is(err, errAgentUnsupported):
		jsonError(w, errAgentUnsupported.Error(), http.StatusNotFound)
	case errors.Is(err, errNoAgentSession), errors.Is(err, errNoTranscript):
		jsonError(w, err.Error(), http.StatusNotFound)
	default:
		muxError(w, a.m, op, err)
	}
}

// readTranscript reads s's transcript: from the end when cursor is empty or no
// longer valid, after cursor when it is, or the entries older than before.
func readTranscript(s AgentSession, cursor, before string) (transcriptResponse, error) {
	adapter, ok := journalAdapters[s.Agent]
	if !ok {
		return transcriptResponse{}, errAgentUnsupported
	}
	path, err := adapter.Locate(s)
	if errors.Is(err, errTranscriptNotWritten) {
		// An empty conversation: its cursor names the session, so the
		// client can send the first message. The file it then finds has
		// another identity than this cursor's, so that read starts over.
		return transcriptResponse{
			Agent: s.Agent, SessionID: s.ID, Status: s.Status,
			Entries: []TranscriptEntry{}, Reset: true,
			Cursor: encodeCursor(agentCursor{Session: s.ID}),
		}, nil
	}
	if err != nil {
		return transcriptResponse{}, err
	}
	f, err := os.OpenFile(path, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return transcriptResponse{}, errNoTranscript
		}
		return transcriptResponse{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return transcriptResponse{}, err
	}
	size, id := fi.Size(), fileIdentity(fi)
	if s.RolloutID != "" {
		// A Codex rollout's identity, read from the open file on Windows.
		if id = rolloutIdentity(path, f, fi); id != s.RolloutID {
			return transcriptResponse{}, errNoTranscript // replaced since the locator found it
		}
	}
	if id == "" {
		// No device and inode (Windows): the file name still tells a new
		// rollout of the same session from the old one.
		id = filepath.Base(path)
	}
	res := transcriptResponse{Agent: s.Agent, SessionID: s.ID, Status: s.Status}
	sameFile := func(c agentCursor) bool { return c.Session == s.ID && c.File == id && c.Offset <= size }

	var page transcriptPage
	switch {
	case before != "":
		c, ok := decodeCursor(before)
		if !ok {
			return transcriptResponse{}, errInvalidBefore
		}
		if !sameFile(c) {
			// The session or file changed since the client's first read.
			page, err = readTail(adapter, f, size)
			res.Reset = true
			res.Cursor = encodeCursor(agentCursor{s.ID, page.end, id})
			break
		}
		page, err = readTail(adapter, f, c.Offset)
	default:
		c, ok := decodeCursor(cursor)
		if cursor != "" && ok && sameFile(c) && size-c.Offset <= agentForwardMax && atLineStart(f, c.Offset) {
			page, err = parseRange(adapter, f, c.Offset, size)
			page.entries = foldToolResults(page.entries)
			res.Cursor = encodeCursor(agentCursor{s.ID, page.end, id})
			break
		}
		page, err = readTail(adapter, f, size)
		res.Reset = true
		res.Cursor = encodeCursor(agentCursor{s.ID, page.end, id})
	}
	if err != nil {
		return transcriptResponse{}, err
	}
	res.Entries = page.entries
	if res.Entries == nil {
		res.Entries = []TranscriptEntry{}
	}
	if page.start > 0 && (before != "" || res.Reset) {
		res.Before = encodeCursor(agentCursor{s.ID, page.start, id})
	}
	return res, nil
}

// transcriptPage is the entries parsed from the byte range [start, end).
type transcriptPage struct {
	entries    []TranscriptEntry
	start, end int64
}

// readTail returns the last agentMaxEntries entries that end at or before
// end (a line boundary, or the file size). It reads back in windows that
// double from agentTailChunk, parsing each byte once, until it has enough
// entries or has read agentTailMax.
func readTail(a journalAdapter, f *os.File, end int64) (transcriptPage, error) {
	var chunks [][]TranscriptEntry // newest first
	hi, lo, pageEnd := end, end, int64(-1)
	var folded []TranscriptEntry
	for window := int64(agentTailChunk); lo > 0 && end-lo < agentTailMax; window *= 2 {
		lo = max(0, hi-window, end-agentTailMax)
		page, err := parseRange(a, f, lo, hi)
		if err != nil {
			return transcriptPage{}, err
		}
		if page.start >= hi {
			continue // no line starts in [lo, hi): a long line, read further back
		}
		if pageEnd < 0 {
			pageEnd = page.end
		}
		chunks = append(chunks, page.entries)
		hi = page.start
		folded = foldToolResults(oldestFirst(chunks))
		if len(folded) >= agentMaxEntries {
			break
		}
	}
	if pageEnd < 0 {
		return transcriptPage{start: lo, end: lo}, nil // no complete line
	}
	if len(folded) <= agentMaxEntries {
		return transcriptPage{entries: folded, start: hi, end: pageEnd}, nil
	}
	// Keep the rows from the first kept entry on and fold them again, so a
	// result whose call is cut off stays an orphan instead of being lost with
	// its call.
	boundary := folded[len(folded)-agentMaxEntries].off
	var kept []TranscriptEntry
	for _, e := range oldestFirst(chunks) {
		if e.off >= boundary {
			kept = append(kept, e)
		}
	}
	entries := foldToolResults(kept)
	// Results whose call was cut off stay as orphan entries; drop the oldest
	// so the page holds agentMaxEntries, and the next page starts at them.
	if n := len(entries) - agentMaxEntries; n > 0 {
		entries = entries[n:]
		boundary = entries[0].off
	}
	return transcriptPage{entries: entries, start: boundary, end: pageEnd}, nil
}

func oldestFirst(chunks [][]TranscriptEntry) []TranscriptEntry {
	var out []TranscriptEntry
	for i := len(chunks) - 1; i >= 0; i-- {
		out = append(out, chunks[i]...)
	}
	return out
}

// foldToolResults moves each orphan tool result onto the call with the same
// tool id earlier in entries, dropping entries left empty. It returns new
// entries and leaves the given ones untouched.
func foldToolResults(entries []TranscriptEntry) []TranscriptEntry {
	out := make([]TranscriptEntry, 0, len(entries))
	type ref struct{ entry, part int }
	calls := map[string]ref{}
	for _, e := range entries {
		kept := make([]TranscriptPart, 0, len(e.Parts))
		for _, p := range e.Parts {
			if p.Kind != "tool" || p.ToolID == "" {
				kept = append(kept, p)
				continue
			}
			if !p.Orphan {
				calls[p.ToolID] = ref{len(out), len(kept)}
				kept = append(kept, p)
				continue
			}
			r, ok := calls[p.ToolID]
			if !ok {
				kept = append(kept, p)
				continue
			}
			delete(calls, p.ToolID)
			parts := kept // the call is in this same row
			if r.entry < len(out) {
				parts = out[r.entry].Parts
			}
			call := &parts[r.part]
			call.Result, call.IsError, call.Clipped = p.Result, p.IsError, call.Clipped || p.Clipped
		}
		if len(kept) > 0 {
			e.Parts = kept
			out = append(out, e)
		}
	}
	return out
}

// parseRange parses the complete lines in [start, end), with tool results not
// yet folded. A start inside a line skips to the next one; a range in which no
// line starts returns start = end.
func parseRange(a journalAdapter, f *os.File, start, end int64) (transcriptPage, error) {
	if start > 0 && !atLineStart(f, start) {
		br := bufio.NewReader(io.NewSectionReader(f, start, end-start))
		for {
			b, err := br.ReadSlice('\n')
			start += int64(len(b))
			if err == nil {
				break
			}
			if !errors.Is(err, bufio.ErrBufferFull) {
				return transcriptPage{start: end, end: end}, nil
			}
		}
	}
	entries, next := a.Parse(io.NewSectionReader(f, start, end-start), start)
	return transcriptPage{entries: entries, start: start, end: next}, nil
}

// atLineStart reports whether off begins a line: the start of the file, or
// right after a '\n'.
func atLineStart(f *os.File, off int64) bool {
	if off == 0 {
		return true
	}
	var b [1]byte
	n, err := f.ReadAt(b[:], off-1)
	if n != 1 || (err != nil && !errors.Is(err, io.EOF)) {
		log.Printf("agent transcript: read at %d: %v", off-1, err)
		return false
	}
	return b[0] == '\n'
}
