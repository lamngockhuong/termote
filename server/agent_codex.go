package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// Codex writes every thread to <CODEX_HOME>/sessions/<Y>/<M>/<D>/
// rollout-<time>-<threadId>.jsonl (format checked against Codex 0.159.3). The
// rows the transcript shows are the completed items of a turn:
//
//	{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage",...}}}
//
// with UserMessage, AgentMessage, Reasoning, CommandExecution, FileChange,
// McpToolCall, Extension and ContextCompaction items. The response_item rows
// are what the model saw (developer messages, injected context, encrypted
// reasoning), so they are skipped. A legacy history writes user_message and
// agent_message events instead; a paginated one does not write them, so both
// forms are read without looking at session_meta.

var codexRolloutRe = regexp.MustCompile(`^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$`)

type codexJournal struct{}

func (codexJournal) Agent() string { return "codex" }

// Locate checks the rollout the locator found open in the Codex process: it
// must resolve to a regular file inside <CodexHome>/sessions named after the
// session id. Nothing is looked up by name, so the file read is the file the
// process was writing.
func (codexJournal) Locate(s AgentSession) (string, error) {
	if !isSessionID(s.ID) || s.CodexHome == "" || !filepath.IsAbs(s.CodexHome) || !filepath.IsAbs(s.Rollout) {
		return "", errNoTranscript
	}
	root, err := filepath.EvalSymlinks(filepath.Join(s.CodexHome, "sessions"))
	if err != nil {
		return "", errNoTranscript
	}
	real, err := filepath.EvalSymlinks(s.Rollout)
	if err != nil || !pathWithin(root, real) {
		return "", errNoTranscript
	}
	if m := codexRolloutRe.FindStringSubmatch(filepath.Base(real)); m == nil || m[1] != s.ID {
		return "", errNoTranscript
	}
	if fi, err := os.Stat(real); err != nil || !fi.Mode().IsRegular() {
		return "", errNoTranscript
	}
	return real, nil
}

// codexRow is the part of a rollout row the parser reads; each line is
// decoded once, and the fields not listed (stdout and formatted_output repeat
// aggregated_output) are skipped.
type codexRow struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		Type    string     `json:"type"`
		Message string     `json:"message"` // legacy user_message / agent_message
		Item    *codexItem `json:"item"`
	} `json:"payload"`
}

type codexItem struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	SummaryText []string `json:"summary_text"`
	// CommandExecution
	Command          any    `json:"command"`
	AggregatedOutput string `json:"aggregated_output"`
	ExitCode         *int   `json:"exit_code"`
	Status           string `json:"status"`
	// FileChange: path -> change
	Changes map[string]codexChange `json:"changes"`
	// McpToolCall
	Server    string `json:"server"`
	Tool      string `json:"tool"`
	Arguments any    `json:"arguments"`
	// Result is decoded generically: no real McpToolCall was recorded, so
	// a field of an unexpected type must not drop the whole row.
	Result any `json:"result"`
	// Extension
	Kind  string `json:"kind"`
	Query string `json:"query"`
}

type codexChange struct {
	Type        string `json:"type"` // add | update | delete
	UnifiedDiff string `json:"unified_diff"`
	Content     string `json:"content"`
	MovePath    string `json:"move_path"`
}

// codexToolNames maps item types to the tool names the Chat view shows, so a
// Codex command reads like a Claude Code one.
var codexToolNames = map[string]string{"CommandExecution": "Bash", "FileChange": "Edit"}

// codexItemTypeRe reads the item type from the start of a line too long to
// decode.
var codexItemTypeRe = regexp.MustCompile(`"item":\{"type":"([A-Za-z]+)"`)

// Parse reads rows until the last complete line. A line longer than
// agentMaxLine is not decoded: when its start shows a completed item it
// becomes a clipped part, anything else is skipped. When a whole turn in the
// range (task_started to task_complete) holds no row the parser knows, it
// returns one note so an unknown format does not look like an empty chat; a
// turn cut by the range start is not judged, since its rows may be in an
// earlier read.
func (codexJournal) Parse(r io.Reader, start int64) ([]TranscriptEntry, int64) {
	br := lineReaders.Get().(*bufio.Reader)
	br.Reset(r)
	defer func() {
		br.Reset(nil)
		lineReaders.Put(br)
	}()
	var entries []TranscriptEntry
	off := start
	turnStart, turnKnown, noted := int64(-1), false, false
	for {
		line, err := br.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			lineStart, n := off, int64(len(line))
			var itemType string
			if bytes.Contains(line, []byte(`"event_msg"`)) && bytes.Contains(line, []byte(`"item_completed"`)) {
				itemType = "item"
				if m := codexItemTypeRe.FindSubmatch(line); m != nil {
					itemType = string(m[1])
				}
			}
			for errors.Is(err, bufio.ErrBufferFull) {
				line, err = br.ReadSlice('\n')
				n += int64(len(line))
			}
			if err != nil {
				return entries, off // the long line is not complete yet
			}
			off = lineStart + n
			if itemType != "" {
				turnKnown = true
				entries = append(entries, codexClippedEntry(itemType, lineStart))
			}
			continue
		}
		if err != nil {
			return entries, off // EOF: a partial last line is read next time
		}
		lineStart := off
		off += int64(len(line))
		if !bytes.Contains(line, []byte(`"event_msg"`)) {
			continue
		}
		switch {
		case bytes.Contains(line, []byte(`"item_completed"`)),
			bytes.Contains(line, []byte(`"user_message"`)),
			bytes.Contains(line, []byte(`"agent_message"`)):
		case bytes.Contains(line, []byte(`"task_started"`)):
			turnStart, turnKnown = lineStart, false
			continue
		case bytes.Contains(line, []byte(`"task_complete"`)):
			if turnStart >= 0 && !turnKnown && !noted {
				noted = true
				entries = append(entries, TranscriptEntry{
					ID: fmt.Sprintf("unsupported-%d", turnStart), Role: "note", off: turnStart,
					Parts: []TranscriptPart{{Kind: "text", Text: "unsupported history format"}},
				})
			}
			turnStart = -1
			continue
		default:
			continue
		}
		e, recognised, ok := parseCodexRow(line, lineStart)
		turnKnown = turnKnown || recognised
		if ok {
			entries = append(entries, e)
		}
	}
}

// codexClippedEntry stands for a completed item too long to decode: a
// message keeps its role as clipped text, anything else is a clipped tool.
func codexClippedEntry(itemType string, off int64) TranscriptEntry {
	e := TranscriptEntry{ID: fmt.Sprintf("clipped-%d", off), Role: "assistant", off: off}
	switch itemType {
	case "UserMessage", "AgentMessage":
		if itemType == "UserMessage" {
			e.Role = "user"
		}
		e.Parts = []TranscriptPart{{Kind: "text", Clipped: true}}
	default:
		tool := codexToolNames[itemType]
		if tool == "" {
			tool = itemType
		}
		e.Parts = []TranscriptPart{{Kind: "tool", Tool: tool, Clipped: true}}
	}
	return e
}

// parseCodexRow turns one event row into an entry. recognised reports a row in
// a known form even when it shows nothing (an empty reasoning summary).
func parseCodexRow(line []byte, off int64) (e TranscriptEntry, recognised, ok bool) {
	var row codexRow
	if json.Unmarshal(line, &row) != nil || row.Type != "event_msg" {
		return e, false, false
	}
	e = TranscriptEntry{TS: row.Timestamp, off: off, ID: fmt.Sprintf("line-%d", off)}
	switch row.Payload.Type {
	case "user_message", "agent_message":
		e.Role = "user"
		if row.Payload.Type == "agent_message" {
			e.Role = "assistant"
		}
		if strings.TrimSpace(row.Payload.Message) == "" {
			return e, true, false
		}
		e.Parts = []TranscriptPart{textPart("text", row.Payload.Message, claudeMaxText)}
		return e, true, true
	case "item_completed":
	default:
		return e, false, false
	}
	it := row.Payload.Item
	if it == nil {
		return e, false, false
	}
	if it.ID != "" {
		e.ID = it.ID
	}
	e.Role = "assistant"
	switch it.Type {
	case "UserMessage", "AgentMessage":
		if it.Type == "UserMessage" {
			e.Role = "user"
		}
		for _, c := range it.Content {
			switch strings.ToLower(c.Type) {
			case "text":
				if strings.TrimSpace(c.Text) != "" {
					e.Parts = append(e.Parts, textPart("text", c.Text, claudeMaxText))
				}
			case "image", "local_image":
				e.Parts = append(e.Parts, TranscriptPart{Kind: "image"})
			}
		}
	case "Reasoning":
		if t := strings.Join(it.SummaryText, "\n\n"); strings.TrimSpace(t) != "" {
			e.Parts = append(e.Parts, textPart("thinking", t, claudeMaxText))
		}
	case "CommandExecution":
		result, clipped := clampText(stripANSI(it.AggregatedOutput), claudeMaxResult)
		e.Parts = append(e.Parts, TranscriptPart{
			Kind: "tool", Tool: codexToolNames["CommandExecution"], ToolID: it.ID, Input: oneLine(codexCommand(it.Command)),
			Result: result, IsError: it.Status == "failed" || (it.ExitCode != nil && *it.ExitCode != 0), Clipped: clipped,
		})
	case "FileChange":
		paths := make([]string, 0, len(it.Changes))
		for p := range it.Changes {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		for _, p := range paths {
			c := it.Changes[p]
			input := p
			if c.MovePath != "" {
				input += " → " + c.MovePath
			}
			result, clipped := clampText(stripANSI(codexChangeDiff(c)), claudeMaxResult)
			e.Parts = append(e.Parts, TranscriptPart{
				Kind: "tool", Tool: codexToolNames["FileChange"], ToolID: it.ID, Input: oneLine(input),
				Result: result, IsError: it.Status != "completed", Clipped: clipped,
			})
		}
	case "McpToolCall":
		tool := strings.Trim(it.Server+"."+it.Tool, ".")
		if tool == "" {
			tool = "mcp"
		}
		in, _ := it.Arguments.(map[string]any)
		p := TranscriptPart{Kind: "tool", Tool: tool, ToolID: it.ID, Input: summarizeToolInput(in), IsError: it.Status == "failed"}
		if res, ok := it.Result.(map[string]any); ok {
			p.Result, p.Clipped = clampText(stripANSI(toolResultText(res["content"])), claudeMaxResult)
			isErr, _ := res["isError"].(bool)
			isErr2, _ := res["is_error"].(bool)
			p.IsError = p.IsError || isErr || isErr2
		}
		e.Parts = append(e.Parts, p)
	case "Extension":
		tool := it.Kind
		if tool == "" {
			tool = "extension"
		}
		e.Parts = append(e.Parts, TranscriptPart{Kind: "tool", Tool: tool, ToolID: it.ID, Input: oneLine(it.Query)})
	case "ContextCompaction":
		e.Role = "summary"
		e.Parts = append(e.Parts, TranscriptPart{Kind: "text", Text: "Context compacted"})
	default:
		return e, true, false
	}
	return e, true, len(e.Parts) > 0
}

// codexCommand returns the script of a command run as [shell, "-lc", script],
// else the arguments joined.
func codexCommand(cmd any) string {
	switch c := cmd.(type) {
	case string:
		return c
	case []any:
		args := make([]string, 0, len(c))
		for _, a := range c {
			if s, ok := a.(string); ok {
				args = append(args, s)
			}
		}
		if len(args) == 3 && (args[1] == "-lc" || args[1] == "-c") {
			return args[2]
		}
		return strings.Join(args, " ")
	}
	return ""
}

// codexChangeDiff is the diff of one file change; a new or deleted file
// carries its content instead, shown as added or removed lines.
func codexChangeDiff(c codexChange) string {
	if c.UnifiedDiff != "" {
		return c.UnifiedDiff
	}
	if c.Content == "" {
		return ""
	}
	sign := "+"
	if c.Type == "delete" {
		sign = "-"
	}
	lines := strings.Split(strings.TrimSuffix(c.Content, "\n"), "\n")
	for i, l := range lines {
		lines[i] = sign + l
	}
	return strings.Join(lines, "\n") + "\n"
}

// codexMarkerMax is the longest line codexStatus decodes; the turn markers
// are small, and a longer line is a command output that mentions one.
const codexMarkerMax = 64 * 1024

// codexStatus reads the rollout backwards, a block at a time and as far as it
// takes, to the latest turn marker: task_started means a turn runs; a turn
// that completed or was aborted, and thread_settings_applied (a resume after
// a killed turn, which never closes it, writes only that), mean idle. A turn
// can be megabytes long, so no fixed window is enough. path comes from Locate.
func codexStatus(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return "unknown"
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return "unknown"
	}
	size, key := fi.Size(), path+"\x00"+fileIdentity(fi)
	codexScans.Lock()
	prev, ok := codexScans.m[key]
	codexScans.Unlock()
	if !ok || prev.end > size {
		prev = codexScan{status: "unknown"} // first look, or the file shrank
	}
	status, found, end := codexLatestMarker(f, prev.end, size)
	if !found {
		status = prev.status
	}
	codexScans.Lock()
	if len(codexScans.m) >= codexScansMax {
		clear(codexScans.m)
	}
	codexScans.m[key] = codexScan{end: end, status: status}
	codexScans.Unlock()
	return status
}

// codexScans remembers, per rollout, where the last codexStatus stopped and
// what it found, so a poll reads only the rows appended since: reading back
// through a 50 MB turn takes hundreds of milliseconds.
var codexScans = struct {
	sync.Mutex
	m map[string]codexScan
}{m: map[string]codexScan{}}

const codexScansMax = 256

type codexScan struct {
	end    int64 // offset after the last complete line scanned
	status string
}

// codexLatestMarker reads r back from size to floor (a line start) for the
// latest turn marker. end is the offset after the last complete line, where
// the next scan starts.
func codexLatestMarker(r io.ReaderAt, floor, size int64) (status string, found bool, end int64) {
	pos, end := size, floor
	var pending []byte // the start of a line whose beginning is in an older block
	// junk: the newest bytes of data are not a complete line (the line being
	// written, or a line too long to hold).
	junk, ended := true, false
	for pos > floor {
		lo := max(floor, pos-agentTailChunk)
		data := make([]byte, pos-lo, pos-lo+int64(len(pending)))
		if n, _ := r.ReadAt(data, lo); n < len(data) {
			return "unknown", false, floor // truncated since it was measured
		}
		data = append(data, pending...)
		stop := len(data)
		if junk {
			i := bytes.LastIndexByte(data, '\n')
			if i < 0 {
				pos, pending = lo, nil
				continue
			}
			stop, junk = i, false
			if !ended {
				end, ended = lo+int64(i)+1, true
			}
		}
		for {
			i := bytes.LastIndexByte(data[:stop], '\n')
			if i < 0 && lo > floor {
				break
			}
			if s, ok := codexMarker(data[i+1 : stop]); ok {
				return s, true, end
			}
			if i < 0 {
				return "unknown", false, end
			}
			stop = i
		}
		pending = data[:stop]
		if len(pending) > codexMarkerMax {
			pending, junk = nil, true
		}
		pos = lo
	}
	return "unknown", false, end
}

var codexMarkerNames = [][]byte{[]byte(`"task_started"`), []byte(`"task_complete"`), []byte(`"turn_aborted"`), []byte(`"thread_settings_applied"`)}

// codexMarker maps a turn marker row to a status.
func codexMarker(line []byte) (string, bool) {
	if len(line) > codexMarkerMax || !bytes.Contains(line, []byte(`"event_msg"`)) {
		return "", false
	}
	// Most rows of a turn are items; decode only a row naming a marker.
	named := false
	for _, m := range codexMarkerNames {
		named = named || bytes.Contains(line, m)
	}
	if !named {
		return "", false
	}
	var row struct {
		Type    string `json:"type"`
		Payload struct {
			Type string `json:"type"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &row) != nil || row.Type != "event_msg" {
		return "", false
	}
	switch row.Payload.Type {
	case "task_started":
		return "working", true
	case "task_complete", "turn_aborted", "thread_settings_applied":
		return "idle", true
	}
	return "", false
}
