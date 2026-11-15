package main

import (
	"cmp"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// The files an agent session changed through its own tool calls, read from
// its journals: Claude Code's Edit, MultiEdit, Write and NotebookEdit calls
// that did not fail, and Codex's completed FileChange items (a legacy
// rollout's patch_apply_end events). A file changed by a shell command is
// not seen. Paths are taken as the journal writes them, made absolute
// against the session's cwd, and never opened here: the route places them
// under the pane root.
//
// A call still waiting for its result counts as running. A tool_result
// line too long to read leaves its call running, a tool_use line too long
// to read is not seen.

// touchedMax is how many files a session's list holds, the latest first.
const touchedMax = 2000

// touchedPendingMax bounds the calls of one file waiting for a result; past
// it the oldest is dropped.
const touchedPendingMax = 512

// touchedOp is a set of what was done to a file.
type touchedOp uint8

const (
	touchedEdit touchedOp = 1 << iota
	touchedWrite
	touchedDelete
	touchedMove
)

// names lists the ops in a fixed order.
func (o touchedOp) names() []string {
	var out []string
	for _, x := range []struct {
		op   touchedOp
		name string
	}{{touchedEdit, "edit"}, {touchedWrite, "write"}, {touchedDelete, "delete"}, {touchedMove, "move"}} {
		if o&x.op != 0 {
			out = append(out, x.name)
		}
	}
	return out
}

// touchedFile is one file a session changed: abs is clean and absolute,
// count the completed changes, running that a call is waiting for its
// result, sub that only subagents changed it.
type touchedFile struct {
	abs     string
	ops     touchedOp
	count   int
	last    time.Time
	sub     bool
	running bool
}

// touchKey: a Claude Code transcript's sidechain rows are a subagent's,
// kept apart from the session's own.
type touchKey struct {
	abs  string
	side bool
}

type touchedPending struct {
	key touchKey
	op  touchedOp
	at  time.Time
}

// touchedState is what one journal's rows made so far.
type touchedState struct {
	files   map[touchKey]*touchedFile
	pending map[string]touchedPending
	order   []string // pending ids, oldest first
	cwd     string
	// Codex: meta once the rollout's own session_meta was read; start the
	// ordinal from which a subagent's rows are its own.
	meta  bool
	start int64
}

func newTouchedState() touchedState {
	return touchedState{files: map[touchKey]*touchedFile{}, pending: map[string]touchedPending{}}
}

// touchedPath makes p absolute against cwd and clean; "" when it cannot.
func touchedPath(p, cwd string) string {
	if p == "" || strings.ContainsRune(p, 0) {
		return ""
	}
	if !filepath.IsAbs(p) {
		if cwd == "" || !filepath.IsAbs(cwd) {
			return ""
		}
		p = filepath.Join(cwd, p)
	}
	return filepath.Clean(p)
}

// done counts one completed change.
func (st *touchedState) done(k touchKey, op touchedOp, at time.Time) {
	f := st.files[k]
	if f == nil {
		f = &touchedFile{abs: k.abs}
		st.files[k] = f
	}
	f.ops |= op
	f.count++
	if at.After(f.last) {
		f.last = at
	}
}

func (st *touchedState) wait(id string, p touchedPending) {
	if _, ok := st.pending[id]; ok {
		return
	}
	if len(st.order) >= touchedPendingMax {
		delete(st.pending, st.order[0])
		st.order = st.order[1:]
	}
	st.pending[id] = p
	st.order = append(st.order, id)
}

func (st *touchedState) resolve(id string) (touchedPending, bool) {
	p, ok := st.pending[id]
	if !ok {
		return p, false
	}
	delete(st.pending, id)
	st.order = slices.DeleteFunc(st.order, func(x string) bool { return x == id })
	return p, true
}

// files is a copy of the state's files: for a subagent's journal every
// one, as a subagent's, else the session's own (a sidechain row is a
// subagent's, read from its own file). A call waiting for its result adds
// its file as running.
func (st *touchedState) list(sub bool) []touchedFile {
	byAbs := map[string]*touchedFile{}
	var out []*touchedFile
	get := func(k touchKey) *touchedFile {
		if f := byAbs[k.abs]; f != nil {
			return f
		}
		f := &touchedFile{abs: k.abs, sub: sub}
		byAbs[k.abs] = f
		out = append(out, f)
		return f
	}
	for k, f := range st.files {
		if k.side && !sub {
			continue
		}
		t := get(k)
		t.ops |= f.ops
		t.count += f.count
		if f.last.After(t.last) {
			t.last = f.last
		}
	}
	for _, id := range st.order {
		p := st.pending[id]
		if p.key.side && !sub {
			continue
		}
		t := get(p.key)
		t.ops |= p.op
		t.running = true
		if p.at.After(t.last) {
			t.last = p.at
		}
	}
	res := make([]touchedFile, len(out))
	for i, f := range out {
		res[i] = *f
	}
	return res
}

// claudeTouchRow is the part of a transcript row the touched files read.
type claudeTouchRow struct {
	Type        string `json:"type"`
	Timestamp   string `json:"timestamp"`
	Cwd         string `json:"cwd"`
	IsSidechain bool   `json:"isSidechain"`
	Message     *struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type claudeTouchBlock struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	ToolUseID string `json:"tool_use_id"`
	IsError   bool   `json:"is_error"`
	Input     struct {
		FilePath     string `json:"file_path"`
		NotebookPath string `json:"notebook_path"`
	} `json:"input"`
}

// claudeTouchTools are the tools that change a file, by what they do.
var claudeTouchTools = map[string]touchedOp{
	"Edit": touchedEdit, "MultiEdit": touchedEdit, "NotebookEdit": touchedEdit, "Write": touchedWrite,
}

func stepClaudeTouched(st *touchedState, line []byte) {
	var row claudeTouchRow
	if json.Unmarshal(line, &row) != nil || row.Message == nil || len(row.Message.Content) == 0 ||
		row.Message.Content[0] != '[' {
		return
	}
	if row.Cwd != "" {
		st.cwd = row.Cwd
	}
	var blocks []claudeTouchBlock
	if json.Unmarshal(row.Message.Content, &blocks) != nil {
		return
	}
	at, _ := time.Parse(time.RFC3339Nano, row.Timestamp)
	for _, b := range blocks {
		switch {
		case b.Type == "tool_use" && row.Type == "assistant":
			op, ok := claudeTouchTools[b.Name]
			abs := touchedPath(cmp.Or(b.Input.FilePath, b.Input.NotebookPath), st.cwd)
			if !ok || abs == "" || b.ID == "" {
				continue
			}
			st.wait(b.ID, touchedPending{key: touchKey{abs, row.IsSidechain}, op: op, at: at})
		case b.Type == "tool_result" && row.Type == "user":
			p, ok := st.resolve(b.ToolUseID)
			if ok && !b.IsError {
				st.done(p.key, p.op, cmp.Or(at, p.at))
			}
		}
	}
}

func newClaudeTouchedScanner() *journalScanner[touchedState] {
	return newJournalScanner([]string{`"tool_use"`, `"tool_result"`}, newTouchedState, stepClaudeTouched)
}

// codexTouchChange is the part of a file change the touched files read.
type codexTouchChange struct {
	Type     string `json:"type"`
	MovePath string `json:"move_path"`
}

// codexTouchRow is the part of a rollout row the touched files read.
type codexTouchRow struct {
	Timestamp string `json:"timestamp"`
	Ordinal   *int64 `json:"ordinal"`
	Type      string `json:"type"`
	Payload   struct {
		Type string `json:"type"`
		// session_meta, turn_context
		ID           string `json:"id"`
		Cwd          string `json:"cwd"`
		ThreadSource string `json:"thread_source"`
		StartOrdinal int64  `json:"subagent_history_start_ordinal"`
		// item_completed
		Item *struct {
			Type    string                      `json:"type"`
			Status  string                      `json:"status"`
			Changes map[string]codexTouchChange `json:"changes"`
		} `json:"item"`
		// patch_apply_end
		Status  string                      `json:"status"`
		Success *bool                       `json:"success"`
		Changes map[string]codexTouchChange `json:"changes"`
	} `json:"payload"`
}

// codexTouchOps maps a change's type to what it does.
var codexTouchOps = map[string]touchedOp{"add": touchedWrite, "update": touchedEdit, "delete": touchedDelete}

func stepCodexTouched(st *touchedState, line []byte) {
	var row codexTouchRow
	if json.Unmarshal(line, &row) != nil {
		return
	}
	p := &row.Payload
	switch row.Type {
	case "session_meta":
		// A subagent's rollout repeats its parent's session_meta later on:
		// the first is the rollout's own.
		if !st.meta && isSessionID(p.ID) {
			st.meta = true
			st.cwd = p.Cwd
			if p.ThreadSource == "subagent" {
				st.start = p.StartOrdinal
			}
		}
		return
	case "turn_context":
		if p.Cwd != "" && (row.Ordinal == nil || *row.Ordinal >= st.start) {
			st.cwd = p.Cwd
		}
		return
	case "event_msg":
	default:
		return
	}
	if row.Ordinal != nil && *row.Ordinal < st.start {
		return // copied from the parent thread
	}
	var changes map[string]codexTouchChange
	switch {
	case p.Type == "item_completed" && p.Item != nil && p.Item.Type == "FileChange":
		if p.Item.Status != "completed" {
			return
		}
		changes = p.Item.Changes
	case p.Type == "patch_apply_end":
		ok := p.Status == "completed" || (p.Status == "" && p.Success != nil && *p.Success)
		if !ok {
			return
		}
		changes = p.Changes
	default:
		return
	}
	at, _ := time.Parse(time.RFC3339Nano, row.Timestamp)
	for path, c := range changes {
		op, ok := codexTouchOps[c.Type]
		abs := touchedPath(path, st.cwd)
		if !ok || abs == "" {
			continue
		}
		st.done(touchKey{abs: abs}, op, at)
		if dst := touchedPath(c.MovePath, st.cwd); dst != "" {
			st.done(touchKey{abs: dst}, touchedMove, at)
		}
	}
}

func newCodexTouchedScanner() *journalScanner[touchedState] {
	return newJournalScanner([]string{`"FileChange"`, `"patch_apply_end"`, `"session_meta"`, `"turn_context"`},
		newTouchedState, stepCodexTouched)
}

// touchedReader reads the files sessions changed, with one incremental
// scanner per agent.
type touchedReader struct {
	claude, codex *journalScanner[touchedState]
}

func newTouchedReader() *touchedReader {
	return &touchedReader{claude: newClaudeTouchedScanner(), codex: newCodexTouchedScanner()}
}

// files is what the journal f of agent changed, as the scanner reads it.
func (t *touchedReader) files(agent string, f sessionFile) []touchedFile {
	js := t.claude
	if agent == "codex" {
		js = t.codex
	}
	var out []touchedFile
	js.scan(f.path, f.f, f.fi, func(st *touchedState) { out = st.list(f.sub) })
	return out
}

// touchedOf adds up the files of a session's journals: a file changed by
// the session itself and its subagents is the session's. The latest first,
// at most touchedMax; truncated when some were left out.
func touchedOf(lists [][]touchedFile) ([]touchedFile, bool) {
	by := map[string]*touchedFile{}
	for _, l := range lists {
		for _, f := range l {
			k := f.abs
			if pathsFold {
				k = strings.ToLower(k)
			}
			t := by[k]
			if t == nil {
				c := f
				by[k] = &c
				continue
			}
			t.ops |= f.ops
			t.count += f.count
			t.sub = t.sub && f.sub
			t.running = t.running || f.running
			if f.last.After(t.last) {
				t.last = f.last
			}
		}
	}
	out := make([]touchedFile, 0, len(by))
	for _, f := range by {
		out = append(out, *f)
	}
	slices.SortFunc(out, func(a, b touchedFile) int {
		if c := b.last.Compare(a.last); c != 0 {
			return c
		}
		return strings.Compare(a.abs, b.abs)
	})
	if len(out) > touchedMax {
		return out[:touchedMax], true
	}
	return out, false
}
