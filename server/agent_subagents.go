package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// The subagent tree (/api/mux/panes/{id}/agent/subagents) lists the
// subagents a pane's Claude Code session started. Claude Code (checked
// against 2.1.28x) keeps each one under
// <claudeDir>/projects/<proj>/<sessionId>/subagents as
//
//	agent-<agentId>.meta.json  {agentType, description, toolUseId, spawnDepth, parentAgentId}
//	agent-<agentId>.jsonl      the subagent's own conversation
//
// Subagents run in the background: the Agent call's tool_result comes back
// as soon as one starts, so it says nothing about the end. Its end is a
// `queue-operation` row of the session's transcript (at any depth) whose
// content is a <task-notification> naming the agentId and a <status>.
// Background shell commands write the same rows with their own task ids,
// which match no file here and are dropped.

const (
	// subagentsTTL: every client polling a tree shares one read.
	subagentsTTL = 2 * time.Second
	// subagentsMaxNodes subagents are listed, the newest; subagentsMaxDepth
	// levels of nesting are shown.
	subagentsMaxNodes = 200
	subagentsMaxDepth = 4
	// subagentDescMax runes of a description and subagentNameMax of a type
	// or tool name are sent.
	subagentDescMax = 200
	subagentNameMax = 64
	// subagentGuessIdle: when the transcript cannot tell (no queue-operation
	// row in what was read), a subagent whose file has not changed for this
	// long is taken as done.
	subagentGuessIdle = 10 * time.Minute
	// subagentMetaMax bytes of a meta file are read; subagentHeadMax of a
	// subagent file's first line (its start time); subagentTailRead of its
	// end (its last tool call).
	subagentMetaMax  = 64 * 1024
	subagentHeadMax  = 1024 * 1024
	subagentTailRead = 256 * 1024
	// subagentLineHead bytes of a transcript line are read for an end.
	subagentLineHead = 64 * 1024
	// subagentsKeep: what is known of a session not asked for in this long
	// is dropped.
	subagentsKeep = 10 * time.Minute
)

var (
	subagentFileRe   = regexp.MustCompile(`^agent-([a-z0-9]{1,64})\.(jsonl|meta\.json)$`)
	subagentIDRe     = regexp.MustCompile(`^[a-z0-9]{1,64}$`)
	subagentTaskRe   = regexp.MustCompile(`<task-id>([a-z0-9]{1,64})</task-id>`)
	subagentStatusRe = regexp.MustCompile(`<status>([a-z_]{1,32})</status>`)
)

// subagentNode is one subagent. Status is running until the transcript
// reports its end: done when that status is completed, error otherwise.
// StatusGuessed: done is a guess from the file's age (subagentGuessIdle).
// Depth is 1 for a subagent of the session itself.
type subagentNode struct {
	ID            string         `json:"id"`
	Type          string         `json:"type"`
	Description   string         `json:"description,omitempty"`
	Status        string         `json:"status"`
	StatusGuessed bool           `json:"statusGuessed,omitempty"`
	StartTS       string         `json:"startTs,omitempty"`
	EndTS         string         `json:"endTs,omitempty"`
	LastTool      string         `json:"lastTool,omitempty"`
	Depth         int            `json:"depth"`
	Children      []subagentNode `json:"children"`
	parent        string
	start         time.Time
}

type subagentsResponse struct {
	Nodes     []subagentNode `json:"nodes"`
	Truncated bool           `json:"truncated,omitempty"`
}

func emptySubagents() subagentsResponse { return subagentsResponse{Nodes: []subagentNode{}} }

func (a *agentAPI) handleSubagents(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	// Same-site only, as the transcript: it names what the agent is doing.
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	s, err := a.session(r.PathValue("id"))
	if err != nil {
		a.agentError(w, "agent session", err)
		return
	}
	res, err := a.subagentTree(s)
	if err != nil {
		a.agentError(w, "subagents", err)
		return
	}
	jsonOK(w, res)
}

// subagentTree is readSubagents shared by every client asking within
// subagentsTTL.
func (a *agentAPI) subagentTree(s AgentSession) (subagentsResponse, error) {
	if s.Agent != "claude" {
		return emptySubagents(), nil
	}
	key := s.ID + "\x00" + s.ClaudeDir
	return a.subagents.do(key, func() (subagentsResponse, error) {
		return a.subagentState.read(key, s)
	})
}

// subagentLastWrite is subagentStore.lastWrite shared by every overview
// read within subagentsTTL.
func (a *agentAPI) subagentLastWrite(s AgentSession) (time.Time, error) {
	if s.Agent != "claude" {
		return time.Time{}, nil
	}
	key := s.ID + "\x00" + s.ClaudeDir
	return a.subagentWrites.do(key, func() (time.Time, error) {
		return a.subagentState.lastWrite(key, s)
	})
}

// subagentStore keeps, per session, how far its transcript was read for
// ends, the ends found, and what was read of each subagent's file.
type subagentStore struct {
	now      func() time.Time
	mu       sync.Mutex
	sessions map[string]*subagentSession
}

type subagentSession struct {
	mu    sync.Mutex
	asked time.Time
	// file is the identity of the transcript read up to offset; covered:
	// that read began at its start. sawQueue: a queue-operation row was in it.
	file     string
	offset   int64
	covered  bool
	sawQueue bool
	ends     map[string]subagentEnd
	files    map[string]subagentFile
	metas    map[string]subagentMetaFile
}

type subagentEnd struct{ status, ts string }

// subagentFile is what was read of a subagent's .jsonl at size and mtime.
type subagentFile struct {
	size     int64
	mtime    time.Time
	start    time.Time
	lastTool string
}

func newSubagentStore(now func() time.Time) *subagentStore {
	return &subagentStore{now: now, sessions: map[string]*subagentSession{}}
}

// session returns key's state, dropping those not asked for in subagentsKeep.
func (st *subagentStore) session(key string) *subagentSession {
	st.mu.Lock()
	defer st.mu.Unlock()
	now := st.now()
	for k, ss := range st.sessions {
		if k != key && now.Sub(ss.asked) >= subagentsKeep {
			delete(st.sessions, k)
		}
	}
	ss, ok := st.sessions[key]
	if !ok {
		ss = &subagentSession{ends: map[string]subagentEnd{}, files: map[string]subagentFile{}, metas: map[string]subagentMetaFile{}}
		st.sessions[key] = ss
	}
	ss.asked = now
	return ss
}

// read builds s's tree. A session without a transcript or a subagents
// directory has an empty one.
func (st *subagentStore) read(key string, s AgentSession) (subagentsResponse, error) {
	res := emptySubagents()
	err := st.visit(key, s, func(ss *subagentSession, dir *os.Root) { res = ss.tree(dir, st.now()) })
	return res, err
}

// lastWrite is when a subagent of s that has not ended last wrote, zero when
// none runs. It is what the overview asks of every Claude pane, so it reads
// only what is new in the transcript and the listing of the directory: no
// meta file and no subagent file.
func (st *subagentStore) lastWrite(key string, s AgentSession) (time.Time, error) {
	var last time.Time
	err := st.visit(key, s, func(ss *subagentSession, dir *os.Root) { last = ss.runningWrite(dir, st.now()) })
	return last, err
}

// visit reads the ends new in s's transcript and calls fn with its subagents
// directory, under the session's lock; fn is not called when there is no
// transcript or no directory.
func (st *subagentStore) visit(key string, s AgentSession, fn func(*subagentSession, *os.Root)) error {
	path, err := claudeJournal{}.Locate(s)
	if errors.Is(err, errTranscriptNotWritten) || errors.Is(err, errNoTranscript) {
		return nil
	}
	if err != nil {
		return err
	}
	root, err := filepath.EvalSymlinks(s.ClaudeDir)
	if err != nil {
		return nil
	}
	// Locate resolved the path inside root: it is projects/<proj>/<id>.jsonl
	// unless the transcript was a link to another place in root.
	rel, err := filepath.Rel(root, path)
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if err != nil || len(parts) != 3 || parts[0] != "projects" || parts[2] != s.ID+".jsonl" {
		return nil
	}
	ss := st.session(key)
	ss.mu.Lock()
	defer ss.mu.Unlock()
	// The transcript is read before the directory: a subagent's file exists
	// before its end is written, so every end read has its file listed.
	ss.scan(path)
	dir, err := openSubagentsDir(root, parts[1], s.ID)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("subagents: session %s: %v", s.ID, err)
		}
		return nil
	}
	defer dir.Close()
	fn(ss, dir)
	return nil
}

// runningWrite is the newest mtime, as listed, of the subagent files whose
// subagent has not ended (and is not guessed to have).
func (ss *subagentSession) runningWrite(dir *os.Root, now time.Time) time.Time {
	var last time.Time
	listed := map[string]bool{}
	for _, e := range listSubagentDir(dir) {
		m := subagentFileRe.FindStringSubmatch(e.Name())
		if m == nil || !e.Type().IsRegular() {
			continue
		}
		listed[m[1]] = true
		if m[2] != "jsonl" {
			continue
		}
		if _, ended := ss.ends[m[1]]; ended {
			continue
		}
		fi, err := e.Info()
		if err != nil || ss.guessDone(fi.ModTime(), now) {
			continue
		}
		if fi.ModTime().After(last) {
			last = fi.ModTime()
		}
	}
	// The ends of background commands, which name no subagent, are dropped.
	for id := range ss.ends {
		if !listed[id] {
			delete(ss.ends, id)
		}
	}
	return last
}

// guessDone: the transcript cannot tell (no queue-operation row in what was
// read, or the read did not start at its beginning), and a subagent whose
// file last changed at changed has been quiet for subagentGuessIdle.
func (ss *subagentSession) guessDone(changed, now time.Time) bool {
	return (!ss.covered || !ss.sawQueue) && !changed.IsZero() && now.Sub(changed) >= subagentGuessIdle
}

// listSubagentDir is dir's entries, none when it cannot be read.
func listSubagentDir(dir *os.Root) []fs.DirEntry {
	d, err := dir.Open(".")
	if err != nil {
		return nil
	}
	defer d.Close()
	entries, _ := d.ReadDir(-1)
	return entries
}

// errSubagentsLink: a directory on the way to subagents is a link (or not a
// directory), which is never followed.
var errSubagentsLink = errors.New("not a plain directory")

// openSubagentsDir opens projects/<proj>/<sessionID>/subagents in root (an
// already resolved claudeDir). os.Root keeps every open inside root but
// follows a link that stays in it, so each step is checked with Lstat to be
// a plain directory: a symlink or a junction is refused.
func openSubagentsDir(root, proj, sessionID string) (*os.Root, error) {
	rt, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer rt.Close()
	p := ""
	var last os.FileInfo
	for _, name := range []string{"projects", proj, sessionID, "subagents"} {
		p = filepath.Join(p, name)
		fi, err := rt.Lstat(p)
		if err != nil {
			return nil, err
		}
		if fi.Mode().Type() != fs.ModeDir {
			return nil, errSubagentsLink
		}
		last = fi
	}
	dir, err := rt.OpenRoot(p)
	if err != nil {
		return nil, err
	}
	// Swapped for a link between the Lstat and the open
	if fi, err := dir.Stat("."); err != nil || !os.SameFile(fi, last) {
		dir.Close()
		return nil, errSubagentsLink
	}
	return dir, nil
}

// scan reads the transcript's queue-operation rows for ends: from where the
// last scan stopped when it is the same file, else from its last
// agentTailMax bytes. The whole file is never read again.
func (ss *subagentSession) scan(path string) {
	f, err := os.OpenFile(path, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return
	}
	size, id := fi.Size(), fileIdentity(fi)
	if id == "" {
		id = filepath.Base(path)
	}
	start := ss.offset
	if id != ss.file || start > size || size-start > agentForwardMax {
		// Another file, cut short, or too far behind: start over at its end.
		start = max(0, size-agentTailMax)
		ss.file, ss.covered, ss.sawQueue = id, start == 0, false
		ss.ends = map[string]subagentEnd{}
	}
	ss.offset = ss.scanRange(f, start, size)
}

// scanRange reads the complete lines in [start, end) and returns the offset
// after the last one. A start inside a line skips to the next. A line longer
// than the reader's buffer is read from its head: a queue-operation row
// carries the subagent's whole report after its id and status, so its end
// row can be far longer than the rest.
func (ss *subagentSession) scanRange(f *os.File, start, end int64) int64 {
	br := bufio.NewReaderSize(io.NewSectionReader(f, start, end-start), subagentLineHead)
	off := start
	partial := start > 0 && !atLineStart(f, start)
	for {
		line, err := br.ReadSlice('\n')
		n := int64(len(line))
		if errors.Is(err, bufio.ErrBufferFull) {
			// The buffer is reused by the next read: keep the head.
			line = bytes.Clone(line)
			for errors.Is(err, bufio.ErrBufferFull) {
				var more []byte
				more, err = br.ReadSlice('\n')
				n += int64(len(more))
			}
		}
		if err != nil {
			return off // the last line is still being written
		}
		off += n
		if partial {
			partial = false
			continue
		}
		if bytes.Contains(line, []byte(`"type":"queue-operation"`)) {
			ss.sawQueue = true
			ss.addEnd(line)
		}
	}
}

var (
	subagentEnqueueRe = regexp.MustCompile(`"operation":"enqueue"`)
	subagentTimeRe    = regexp.MustCompile(`"timestamp":"([^"\\]{1,64})"`)
)

// addEnd records the end a queue-operation row reports, read from the row's
// bytes rather than decoded, so a row cut to its head still counts. Claude
// Code writes type, operation and timestamp before the content, and in the
// content the task id and status before the report.
func (ss *subagentSession) addEnd(row []byte) {
	if !subagentEnqueueRe.Match(row) || !bytes.Contains(row, []byte("<task-notification>")) {
		return
	}
	id := subagentTaskRe.FindSubmatch(row)
	status := subagentStatusRe.FindSubmatch(row)
	if id == nil || status == nil {
		return
	}
	ts := ""
	if m := subagentTimeRe.FindSubmatch(row); m != nil {
		ts = normalizeTS(string(m[1]))
	}
	ss.ends[string(id[1])] = subagentEnd{status: string(status[1]), ts: ts}
}

// normalizeTS is an RFC 3339 time from a file in activityTimeFormat, "" when
// it is not one: the text is never passed on as written.
func normalizeTS(s string) string {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return ""
	}
	return t.UTC().Format(activityTimeFormat)
}

// subagentMeta is the part of a meta file read.
type subagentMeta struct {
	AgentType     string `json:"agentType"`
	Description   string `json:"description"`
	ParentAgentID string `json:"parentAgentId"`
}

// tree lists dir and builds the tree from the meta files, the subagent
// files and the ends scanned.
func (ss *subagentSession) tree(dir *os.Root, now time.Time) subagentsResponse {
	entries := listSubagentDir(dir)
	type found struct {
		meta, log fs.DirEntry
		metaOK    bool
		m         subagentMeta
		file      subagentFile
		hasFile   bool
		metaTime  time.Time
	}
	byID := map[string]*found{}
	for _, e := range entries {
		m := subagentFileRe.FindStringSubmatch(e.Name())
		// A link or anything but a plain file is never opened.
		if m == nil || !e.Type().IsRegular() {
			continue
		}
		f := byID[m[1]]
		if f == nil {
			f = &found{}
			byID[m[1]] = f
		}
		if m[2] == "jsonl" {
			f.log = e
		} else {
			f.meta = e
		}
	}
	res := emptySubagents()
	if len(byID) == 0 {
		return res
	}
	for id, f := range byID {
		if f.meta != nil {
			f.m, f.metaTime, f.metaOK = ss.readMeta(dir, id, f.meta)
		}
		if f.log != nil {
			f.file, f.hasFile = ss.readFile(dir, id, f.log)
		}
	}
	// What the transcript reported of subagents gone from the directory, and
	// the ends of background commands, are dropped.
	for id := range ss.ends {
		if byID[id] == nil {
			delete(ss.ends, id)
		}
	}
	for id := range ss.files {
		if byID[id] == nil || byID[id].log == nil {
			delete(ss.files, id)
		}
	}
	for id := range ss.metas {
		if byID[id] == nil || byID[id].meta == nil {
			delete(ss.metas, id)
		}
	}

	nodes := make([]*subagentNode, 0, len(byID))
	for id, f := range byID {
		if !f.metaOK && !f.hasFile {
			continue
		}
		n := &subagentNode{ID: id, Type: "agent", Status: "running", Children: []subagentNode{}}
		if f.metaOK {
			if t := cutRunes(collapseSpace(f.m.AgentType), subagentNameMax); t != "" {
				n.Type = t
			}
			n.Description = cutRunes(collapseSpace(f.m.Description), subagentDescMax)
			if subagentIDRe.MatchString(f.m.ParentAgentID) && f.m.ParentAgentID != id {
				n.parent = f.m.ParentAgentID
			}
		}
		// The meta file is written when the subagent starts.
		n.start = f.metaTime
		changed := f.metaTime
		if f.hasFile {
			if !f.file.start.IsZero() {
				n.start = f.file.start
			}
			changed = f.file.mtime
			n.LastTool = f.file.lastTool
		}
		if !n.start.IsZero() {
			n.StartTS = n.start.UTC().Format(activityTimeFormat)
		}
		switch end, ok := ss.ends[id]; {
		case ok:
			n.Status, n.EndTS = "done", end.ts
			if end.status != "completed" {
				n.Status = "error"
			}
		case ss.guessDone(changed, now):
			n.Status, n.StatusGuessed = "done", true
		}
		nodes = append(nodes, n)
	}
	// The newest subagentsMaxNodes, by start.
	slices.SortFunc(nodes, func(x, y *subagentNode) int {
		if c := x.start.Compare(y.start); c != 0 {
			return c
		}
		return strings.Compare(x.ID, y.ID)
	})
	if len(nodes) > subagentsMaxNodes {
		nodes = nodes[len(nodes)-subagentsMaxNodes:]
		res.Truncated = true
	}
	kept := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		kept[n.ID] = true
	}
	children := map[string][]*subagentNode{}
	for _, n := range nodes {
		p := n.parent
		if !kept[p] {
			p = "" // a child of the session itself
		}
		children[p] = append(children[p], n)
	}
	var build func(parent string, depth int) []subagentNode
	placed := 0
	build = func(parent string, depth int) []subagentNode {
		out := []subagentNode{}
		for _, n := range children[parent] {
			if depth > subagentsMaxDepth {
				res.Truncated = true
				break
			}
			n.Depth = depth
			n.Children = build(n.ID, depth+1)
			out = append(out, *n)
			placed++
		}
		return out
	}
	res.Nodes = build("", 1)
	if placed < len(nodes) {
		res.Truncated = true // a parent loop, never reached from the session
	}
	return res
}

// subagentMetaFile is a meta file as read at size and mtime.
type subagentMetaFile struct {
	size  int64
	mtime time.Time
	m     subagentMeta
	ok    bool
}

// readMeta returns a subagent's meta and when it was written, read again
// only when its size or mtime changed; ok is false when it could not be
// read or decoded.
func (ss *subagentSession) readMeta(dir *os.Root, id string, e fs.DirEntry) (subagentMeta, time.Time, bool) {
	if fi, err := e.Info(); err == nil {
		if prev, had := ss.metas[id]; had && prev.size == fi.Size() && prev.mtime.Equal(fi.ModTime()) {
			return prev.m, prev.mtime, prev.ok
		}
	}
	b, fi, ok := readPlainFile(dir, e, subagentMetaMax)
	if !ok {
		delete(ss.metas, id)
		return subagentMeta{}, time.Time{}, false
	}
	v := subagentMetaFile{size: fi.Size(), mtime: fi.ModTime()}
	v.ok = json.Unmarshal(b, &v.m) == nil
	ss.metas[id] = v
	return v.m, v.mtime, v.ok
}

// readFile returns what is known of a subagent's file, read again only
// when its size or mtime changed: its start (the first line's time, read
// once) and the last tool it called.
func (ss *subagentSession) readFile(dir *os.Root, id string, e fs.DirEntry) (subagentFile, bool) {
	f, fi, ok := openPlainFile(dir, e)
	if !ok {
		return subagentFile{}, false
	}
	defer f.Close()
	prev, had := ss.files[id]
	if had && prev.size == fi.Size() && prev.mtime.Equal(fi.ModTime()) {
		return prev, true
	}
	v := subagentFile{size: fi.Size(), mtime: fi.ModTime(), start: prev.start, lastTool: prev.lastTool}
	if v.start.IsZero() {
		v.start = firstLineTime(f)
	}
	if t := lastToolName(f, fi.Size()); t != "" {
		v.lastTool = t
	}
	ss.files[id] = v
	return v, true
}

// openPlainFile opens e in dir when it is still the plain file the listing
// found (not swapped for a link since).
func openPlainFile(dir *os.Root, e fs.DirEntry) (*os.File, os.FileInfo, bool) {
	listed, err := e.Info()
	if err != nil || !listed.Mode().IsRegular() {
		return nil, nil, false
	}
	// Nonblocking: a FIFO put in a file's place never holds the read up.
	f, err := dir.OpenFile(e.Name(), os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, nil, false
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || !os.SameFile(fi, listed) {
		f.Close()
		return nil, nil, false
	}
	return f, fi, true
}

// readPlainFile reads up to limit bytes of e; a longer file is not read.
func readPlainFile(dir *os.Root, e fs.DirEntry, limit int64) ([]byte, os.FileInfo, bool) {
	f, fi, ok := openPlainFile(dir, e)
	if !ok {
		return nil, nil, false
	}
	defer f.Close()
	if fi.Size() > limit {
		return nil, nil, false
	}
	b, err := io.ReadAll(io.LimitReader(f, limit))
	return b, fi, err == nil
}

// firstLineTime is the timestamp of f's first line, zero when that line is
// longer than subagentHeadMax or has none.
func firstLineTime(f *os.File) time.Time {
	br := bufio.NewReaderSize(io.NewSectionReader(f, 0, subagentHeadMax), subagentHeadMax)
	line, err := br.ReadSlice('\n')
	if err != nil {
		return time.Time{}
	}
	var row struct {
		Timestamp string `json:"timestamp"`
	}
	if json.Unmarshal(line, &row) != nil {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339Nano, row.Timestamp)
	return t
}

// lastToolName is the name of the last tool called in the complete lines of
// f's last subagentTailRead bytes, "" when none is.
func lastToolName(f *os.File, size int64) string {
	start := max(0, size-subagentTailRead)
	b := make([]byte, size-start)
	if _, err := f.ReadAt(b, start); err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	if start > 0 && !atLineStart(f, start) {
		i := bytes.IndexByte(b, '\n')
		if i < 0 {
			return ""
		}
		b = b[i+1:]
	}
	name := ""
	for line := range bytes.Lines(b) {
		if !bytes.HasSuffix(line, []byte("\n")) || !bytes.Contains(line, []byte(`"tool_use"`)) {
			continue
		}
		var row struct {
			Type    string `json:"type"`
			Message struct {
				Content []struct {
					Type string `json:"type"`
					Name string `json:"name"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &row) != nil || row.Type != "assistant" {
			continue
		}
		for _, c := range row.Message.Content {
			if c.Type == "tool_use" && c.Name != "" {
				name = cutRunes(collapseSpace(c.Name), subagentNameMax)
			}
		}
	}
	return name
}

// collapseSpace is s with every run of white space made one space.
func collapseSpace(s string) string { return strings.Join(strings.Fields(s), " ") }
