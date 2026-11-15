package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Session history (GET /api/mux/panes/{id}/agent/history): the Claude Code,
// Codex and OpenCode sessions that ran in the pane's root (its git
// toplevel, as the files routes find it) or a directory under it, newest
// first. The server finds the files itself under the agents' own dirs (the
// server user's CLAUDE_CONFIG_DIR or ~/.claude, CODEX_HOME or ~/.codex),
// and OpenCode's sessions through its service (agent_history_opencode.go);
// a client only names a pane, an agent and a session id. A session counts
// only when the cwd it records is inside the root, whatever directory it
// was found in, and no absolute path is ever returned.

const (
	// historyTTL lets every client opening the history of one root share
	// one scan.
	historyTTL = 10 * time.Second
	// historyPage is how many sessions one reply holds.
	historyPage = 30
	// historyHead and historyTail are what is read at each end of a
	// Claude Code transcript: its cwd, branch and first prompt near the
	// start, the latest title and branch near the end.
	historyHead = 64 * 1024
	historyTail = 64 * 1024
	// historyCodexMeta bounds a rollout's first line (session_meta carries
	// the whole base instructions); historyCodexIndex bounds the read of
	// session_index.jsonl.
	historyCodexMeta  = 256 * 1024
	historyCodexIndex = 4 * 1024 * 1024
	// historyIndexMax is how many files the parsed-file index keeps.
	historyIndexMax = 5000
	// historyTitleMax bounds a title, in bytes.
	historyTitleMax = 200
)

// historyMaxScan is how many files one agent's scan opens at most, newest
// day first for Codex; a variable so tests can lower it.
var historyMaxScan = 2000

var errHistoryCursor = inputError("invalid history cursor")

// Title sources, from the strongest: the user's /rename, the title the
// agent made, the first prompt.
const (
	titleCustom = "custom"
	titleAI     = "ai"
	titlePrompt = "prompt"
)

// historySession is one session as the client sees it.
type historySession struct {
	Agent       string `json:"agent"`
	ID          string `json:"id"`
	Title       string `json:"title"`
	TitleSource string `json:"titleSource"`
	// Cwd is the session's directory relative to the root, slash
	// separated, "" at the root itself.
	Cwd       string       `json:"cwd"`
	Branch    string       `json:"branch,omitempty"`
	UpdatedAt string       `json:"updatedAt"`
	Live      *historyLive `json:"live,omitempty"`

	updated time.Time
	// path is the file found, absCwd the cwd it records, forkOf the Codex
	// thread a user's fork was forked from: never sent.
	path   string
	absCwd string
	forkOf string
}

// historyLive is the pane a session runs in now.
type historyLive struct {
	TabID  string `json:"tabId"`
	PaneID string `json:"paneId"`
}

type historyResponse struct {
	Sessions  []historySession `json:"sessions"`
	Next      string           `json:"next,omitempty"`
	Truncated bool             `json:"truncated"`
}

// historyScan is every session of one root, newest first.
type historyScan struct {
	sessions  []historySession
	truncated bool
}

// historyFile is what one file says about its session, before the root is
// known: the same file serves every root it is inside.
type historyFile struct {
	agent, id   string
	title, src  string
	cwd, branch string
	// child: a Codex thread a subagent or a tool started, not the user;
	// parent: the thread a subagent's was started from; forkOf: the thread
	// a user's fork was forked from
	child  bool
	parent string
	forkOf string
}

// historyIndex keeps each parsed file by its size and mtime, so a scan only
// reads the files that changed since the last one.
type historyIndex struct {
	mu    sync.Mutex
	files map[string]*historyIndexEntry
	now   func() time.Time
}

type historyIndexEntry struct {
	size  int64
	mtime time.Time
	used  time.Time
	file  historyFile
	ok    bool
}

func newHistoryIndex() *historyIndex {
	return &historyIndex{files: map[string]*historyIndexEntry{}, now: time.Now}
}

// get returns path's parsed file, reading it with parse when it is new or
// changed since. ok is false for a file that holds no session to list.
func (x *historyIndex) get(path string, fi os.FileInfo, parse func() (historyFile, bool)) (historyFile, bool) {
	x.mu.Lock()
	if e, found := x.files[path]; found && e.size == fi.Size() && e.mtime.Equal(fi.ModTime()) {
		e.used = x.now()
		x.mu.Unlock()
		return e.file, e.ok
	}
	x.mu.Unlock()
	file, ok := parse()
	x.mu.Lock()
	defer x.mu.Unlock()
	x.files[path] = &historyIndexEntry{size: fi.Size(), mtime: fi.ModTime(), used: x.now(), file: file, ok: ok}
	if len(x.files) > historyIndexMax {
		x.evictLocked()
	}
	return file, ok
}

// evictLocked drops the least recently used tenth of the index.
func (x *historyIndex) evictLocked() {
	type aged struct {
		path string
		used time.Time
	}
	all := make([]aged, 0, len(x.files))
	for p, e := range x.files {
		all = append(all, aged{p, e.used})
	}
	slices.SortFunc(all, func(a, b aged) int { return a.used.Compare(b.used) })
	for _, a := range all[:len(all)-historyIndexMax*9/10] {
		delete(x.files, a.path)
	}
}

// historyDirs are the agents' dirs the server reads: its own user's.
type historyDirs struct {
	claude, codex string
}

func serverHistoryDirs() historyDirs {
	home, _ := os.UserHomeDir()
	return historyDirs{claude: defaultClaudeDir(), codex: codexAccountHome(AgentSession{}, os.Getenv, home)}
}

// historyAPI serves the history routes; set up by registerHistoryRoutes.
type historyAPI struct {
	index *historyIndex
	scans *ttlCache[historyScan]
	dirs  func() historyDirs
	// children: the rollouts of a Codex session's threads
	children *ttlCache[[]string]
	// opencode: the OpenCode service's root sessions, for every root
	opencode *ttlCache[opencodeHistoryList]
}

func newHistoryAPI() *historyAPI {
	return &historyAPI{index: newHistoryIndex(), scans: newTTLCache[historyScan](historyTTL), dirs: serverHistoryDirs,
		children: newTTLCache[[]string](codexChildTTL), opencode: newTTLCache[opencodeHistoryList](historyTTL)}
}

// registerHistoryRoutes adds the history routes. They need the files
// routes' pane roots, set by registerCommandsRoute.
func (a *agentAPI) registerHistoryRoutes(mux *http.ServeMux) {
	a.history = newHistoryAPI()
	mux.HandleFunc("/api/mux/panes/{id}/agent/history", a.handleHistory)
	a.registerResumeRoutes(mux)
	a.registerUsageRoutes(mux)
	a.registerTouchedRoutes(mux)
}

// historyRoot resolves the pane's root for a history read, answering the
// request itself when there is none or a view-only client may not read it
// (no git repo, a home dir), as the files routes do.
func (a *agentAPI) historyRoot(w http.ResponseWriter, r *http.Request) (filesRoot, bool) {
	if a.files == nil {
		jsonErrorCode(w, "unsupported", errUnsupported.Error(), http.StatusNotImplemented)
		return filesRoot{}, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), filesTimeout)
	defer cancel()
	root, err := a.files.paneRootForRead(ctx, r.PathValue("id"))
	if err != nil {
		a.files.error(w, "history root", err)
		return filesRoot{}, false
	}
	if isViewOnly(r) && a.files.viewHidesRoot(root) {
		writeViewOnly(w)
		return filesRoot{}, false
	}
	return root, true
}

func (a *agentAPI) handleHistory(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	q := r.URL.Query()
	agent := q.Get("agent")
	if agent != "" && !historyAgent(agent) {
		jsonErrorCode(w, "invalid_request", "agent must be claude, codex or opencode", http.StatusBadRequest)
		return
	}
	var after *historyCursor
	if c := q.Get("cursor"); c != "" {
		hc, ok := decodeHistoryCursor(c)
		if !ok || hc.Agent != agent {
			jsonErrorCode(w, "invalid_request", errHistoryCursor.Error(), http.StatusBadRequest)
			return
		}
		after = &hc
	}
	root, ok := a.historyRoot(w, r)
	if !ok {
		return
	}
	res := historyPageOf(a.history.scan(root.Root), agent, after)
	a.markLive(r.Context(), res.Sessions)
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, res)
}

// historyAgent: the history lists agent's sessions.
func historyAgent(agent string) bool {
	return agent == "claude" || agent == "codex" || agent == "opencode"
}

// historySessionID: id has the form of agent's session ids (a lowercase
// UUID; OpenCode's own, isOpencodeSessionID).
func historySessionID(agent, id string) bool {
	if agent == "opencode" {
		return isOpencodeSessionID(id)
	}
	return historyAgent(agent) && isSessionID(id)
}

// historyCursor continues a listing after the session it names (its
// mtime, agent and id), in the listing's order. Agent is the listing's
// filter, which the next request must repeat.
type historyCursor struct {
	Agent   string `json:"a"`
	Updated int64  `json:"u"`
	Of      string `json:"o"`
	ID      string `json:"i"`
}

func encodeHistoryCursor(c historyCursor) string {
	payload, _ := json.Marshal(c)
	payload = append([]byte("history\x00"), payload...)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(payload) + "." + enc.EncodeToString(cursorMAC(payload))
}

func decodeHistoryCursor(s string) (historyCursor, bool) {
	var c historyCursor
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
	rest, ok := bytes.CutPrefix(payload, []byte("history\x00"))
	if !ok || json.Unmarshal(rest, &c) != nil {
		return c, false
	}
	return c, true
}

// historyOrder sorts newest first, then by agent and id so a cursor names
// one place.
func historyOrder(a, b historySession) int {
	if c := b.updated.Compare(a.updated); c != 0 {
		return c
	}
	if c := strings.Compare(a.Agent, b.Agent); c != 0 {
		return c
	}
	return strings.Compare(a.ID, b.ID)
}

// historyPageOf is the page of scan after the cursor, for one agent or
// both.
func historyPageOf(scan historyScan, agent string, after *historyCursor) historyResponse {
	res := historyResponse{Sessions: []historySession{}, Truncated: scan.truncated}
	for _, s := range scan.sessions {
		if agent != "" && s.Agent != agent {
			continue
		}
		if after != nil && historyOrder(s, historySession{updated: time.Unix(0, after.Updated), Agent: after.Of, ID: after.ID}) <= 0 {
			continue
		}
		if len(res.Sessions) == historyPage {
			last := res.Sessions[len(res.Sessions)-1]
			res.Next = encodeHistoryCursor(historyCursor{Agent: agent, Updated: last.updated.UnixNano(), Of: last.Agent, ID: last.ID})
			break
		}
		res.Sessions = append(res.Sessions, s)
	}
	return res
}

// scan lists root's sessions, shared by every request for the root within
// historyTTL.
func (h *historyAPI) scan(root string) historyScan {
	dirs := h.dirs()
	// A scan never fails: a dir it cannot read holds no session.
	scan, _ := h.scans.do(root+"\x00"+dirs.claude+"\x00"+dirs.codex, func() (historyScan, error) {
		// OpenCode's service is asked meanwhile: a slow one does not add
		// its wait to the file scans'.
		var opencode []historySession
		var ot bool
		done := make(chan struct{})
		go func() {
			defer close(done)
			opencode, ot = h.scanOpencode(root)
		}()
		claude, ct := h.scanClaude(dirs.claude, root)
		codex, xt := h.scanCodex(dirs.codex, root)
		<-done
		all := slices.Concat(claude, codex, opencode)
		slices.SortFunc(all, historyOrder)
		return historyScan{sessions: all, truncated: ct || xt || ot}, nil
	})
	return scan
}

// inHistoryRoot places a session's recorded cwd under root: its path
// relative to root, slash separated, when it is root or inside it. A cwd
// that still exists is resolved first, so a session started through a
// symlink of the root counts.
func inHistoryRoot(root, cwd string) (string, bool) {
	if cwd == "" || !filepath.IsAbs(cwd) {
		return "", false
	}
	cwd = filepath.Clean(cwd)
	if real, err := evalSymlinks(cwd); err == nil {
		cwd = real
	}
	return relUnder(root, cwd)
}

// relUnder is p (clean, absolute) relative to root, slash separated, when
// it is root ("") or inside it, compared without case where the OS ignores
// it. Only the strings are compared: nothing is looked up on disk.
func relUnder(root, p string) (string, bool) {
	r, c := root, p
	if pathsFold {
		r, c = strings.ToLower(r), strings.ToLower(c)
	}
	rel, err := filepath.Rel(r, c)
	if err != nil || !filepath.IsLocal(rel) {
		return "", false
	}
	if rel == "." {
		return "", true
	}
	// The last components of p as written, rel's case being folded.
	parts := strings.Split(p, string(filepath.Separator))
	n := strings.Count(rel, string(filepath.Separator)) + 1
	return strings.Join(parts[len(parts)-n:], "/"), true
}

// pathsFold: the OS compares paths without case (a variable for tests).
var pathsFold = runtime.GOOS == "windows" || runtime.GOOS == "darwin"

// historyTitle makes a title one line of at most historyTitleMax bytes,
// without control or invisible characters.
func historyTitle(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || r == '\r' {
			return ' '
		}
		if unicode.IsControl(r) || hiddenRune(r) {
			return -1
		}
		return r
	}, stripANSI(s))
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > historyTitleMax {
		s, _ = clampText(s, historyTitleMax)
		s += "…"
	}
	return s
}

// historyBranch keeps a branch name only when it looks like one.
func historyBranch(s string) string {
	if len(s) > 255 || strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || hiddenRune(r) }) {
		return ""
	}
	return s
}

// readEnds reads up to head bytes from the start of f and up to tail bytes
// from its end (none when the head covers the file). Each holds whole
// lines only: the head drops a last line cut short, the tail a first one.
func readEnds(f *os.File, size int64, head, tail int) (h, t []byte, err error) {
	h = make([]byte, min(int64(head), size))
	if _, err := io.ReadFull(f, h); err != nil {
		return nil, nil, err
	}
	if int64(len(h)) < size {
		if i := bytes.LastIndexByte(h, '\n'); i >= 0 {
			h = h[:i+1]
		} else {
			h = nil
		}
	}
	if size <= int64(head) || tail <= 0 {
		return h, nil, nil
	}
	start := max(size-int64(tail), int64(head))
	t = make([]byte, size-start)
	if _, err := f.ReadAt(t, start); err != nil && !errors.Is(err, io.EOF) {
		return nil, nil, err
	}
	if i := bytes.IndexByte(t, '\n'); i >= 0 {
		t = t[i+1:]
	} else {
		t = nil
	}
	return h, t, nil
}

// openHistoryFile opens p for a read when it resolves to a regular file
// inside root (resolved), so a symlink cannot point the scan elsewhere.
func openHistoryFile(root, p string) (*os.File, os.FileInfo, string, bool) {
	real, err := filepath.EvalSymlinks(p)
	if err != nil || !pathWithin(root, real) {
		return nil, nil, "", false
	}
	f, err := os.OpenFile(real, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, nil, "", false
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		f.Close()
		return nil, nil, "", false
	}
	return f, fi, real, true
}

// historyEntry makes the client's row of a parsed file, when its cwd is
// inside root.
func historyEntry(root, path string, fi os.FileInfo, file historyFile) (historySession, bool) {
	rel, ok := inHistoryRoot(root, file.cwd)
	if !ok {
		return historySession{}, false
	}
	return historySession{
		Agent: file.agent, ID: file.id, Title: file.title, TitleSource: file.src,
		Cwd: rel, Branch: file.branch, UpdatedAt: fi.ModTime().UTC().Format(time.RFC3339),
		updated: fi.ModTime(), path: path, absCwd: file.cwd, forkOf: file.forkOf,
	}, true
}
