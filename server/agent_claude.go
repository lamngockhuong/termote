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
	"unicode/utf8"
)

// Claude Code writes every turn of a session to
// <claudeDir>/projects/<mangled cwd>/<sessionId>.jsonl (format checked against
// Claude Code 2.1.28x). The rows the transcript shows:
//
//	{"type":"user","message":{"content":"text" | [text|image|tool_result...]}}
//	{"type":"assistant","message":{"content":[text|thinking|tool_use...]}}
//
// plus bookkeeping rows (mode, permission-mode, ai-title, attachment,
// file-history-*, ...) that are skipped. Rows marked isSidechain are a
// subagent's own conversation and isMeta rows are injected for the model, so
// neither is shown. The filtering follows collie (MIT), which reads the same
// files: github.com/AltanS/collie bridge/journal/claude.ts.

// Caps per part; the phone needs the gist of a tool result, not a whole file.
const (
	claudeMaxText    = 32 * 1024
	claudeMaxResult  = 8 * 1024
	claudeMaxSummary = 200
)

var claudeSessionIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// isSessionID accepts a canonical lowercase UUID, the only form Claude Code
// writes; the id becomes part of a file name, so nothing else is accepted.
func isSessionID(s string) bool { return claudeSessionIDRe.MatchString(s) }

// defaultClaudeDir is the config dir of a Claude Code started by the user
// running the server: CLAUDE_CONFIG_DIR when the server has it, else
// ~/.claude. Used where the agent's own process cannot be read (herdr).
func defaultClaudeDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}

type claudeJournal struct{}

// lineReaders reuses the agentMaxLine buffers Parse reads with.
var lineReaders = sync.Pool{New: func() any { return bufio.NewReaderSize(nil, agentMaxLine) }}

func (claudeJournal) Agent() string { return "claude" }

// Locate finds <claudeDir>/projects/*/<id>.jsonl. The result must resolve to
// a file inside claudeDir, so a symlink cannot point the read elsewhere.
func (claudeJournal) Locate(s AgentSession) (string, error) {
	if !isSessionID(s.ID) || s.ClaudeDir == "" || !filepath.IsAbs(s.ClaudeDir) {
		return "", errNoTranscript
	}
	root, err := filepath.EvalSymlinks(s.ClaudeDir)
	if err != nil {
		return "", errNoTranscript
	}
	matches, err := filepath.Glob(filepath.Join(root, "projects", "*", s.ID+".jsonl"))
	if err != nil {
		return "", err
	}
	for _, m := range matches {
		real, err := filepath.EvalSymlinks(m)
		if err != nil || !pathWithin(root, real) {
			continue
		}
		if fi, err := os.Stat(real); err == nil && fi.Mode().IsRegular() {
			return real, nil
		}
	}
	return "", errNoTranscript
}

// pathWithin reports whether p is inside dir (both already resolved).
func pathWithin(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// claudeRow is the part of a transcript row the parser reads. encoding/json
// spends nearly all of its time scanning, so each line is decoded exactly
// once: fields not listed here (toolUseResult repeats every tool output) are
// skipped, and content is decoded generically since it is a string or a list
// of blocks.
type claudeRow struct {
	Type             string `json:"type"`
	UUID             string `json:"uuid"`
	Timestamp        string `json:"timestamp"`
	IsSidechain      bool   `json:"isSidechain"`
	IsMeta           bool   `json:"isMeta"`
	IsCompactSummary bool   `json:"isCompactSummary"`
	Message          *struct {
		Content any `json:"content"`
	} `json:"message"`
}

// Parse reads rows until the last complete line. A line longer than
// agentMaxLine is skipped without being held in memory, and leaves a clipped
// note in its place. A tool result is returned as its own orphan part;
// foldToolResults attaches it to its call.
func (claudeJournal) Parse(r io.Reader, start int64) ([]TranscriptEntry, int64) {
	br := lineReaders.Get().(*bufio.Reader)
	br.Reset(r)
	defer func() {
		br.Reset(nil)
		lineReaders.Put(br)
	}()
	var entries []TranscriptEntry
	off := start
	for {
		line, err := br.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			lineStart, n := off, int64(len(line))
			for errors.Is(err, bufio.ErrBufferFull) {
				line, err = br.ReadSlice('\n')
				n += int64(len(line))
			}
			if err != nil {
				return entries, off // the long line is not complete yet
			}
			off = lineStart + n
			entries = append(entries, TranscriptEntry{
				ID: fmt.Sprintf("clipped-%d", lineStart), Role: "note", off: lineStart,
				Parts: []TranscriptPart{{Kind: "text", Clipped: true}},
			})
			continue
		}
		if err != nil {
			return entries, off // EOF: a partial last line is read next time
		}
		lineStart := off
		off += int64(len(line))
		// Most rows are bookkeeping; skip those without decoding them.
		if !bytes.Contains(line, []byte(`"user"`)) && !bytes.Contains(line, []byte(`"assistant"`)) {
			continue
		}
		if e, ok := parseClaudeRow(line, lineStart); ok {
			entries = append(entries, e)
		}
	}
}

func parseClaudeRow(line []byte, off int64) (TranscriptEntry, bool) {
	var row claudeRow
	if json.Unmarshal(line, &row) != nil || row.Message == nil {
		return TranscriptEntry{}, false
	}
	if (row.Type != "user" && row.Type != "assistant") || row.IsSidechain || row.IsMeta {
		return TranscriptEntry{}, false
	}
	e := TranscriptEntry{ID: row.UUID, TS: row.Timestamp, Role: row.Type, off: off}
	if e.ID == "" {
		e.ID = fmt.Sprintf("line-%d", off)
	}
	switch c := row.Message.Content.(type) {
	case string:
		role, text, ok := classifyClaudeUserText(c)
		if !ok {
			return TranscriptEntry{}, false
		}
		if row.Type == "user" {
			e.Role = role
		}
		e.Parts = append(e.Parts, textPart("text", text, claudeMaxText))
	case []any:
		for _, item := range c {
			b, _ := item.(map[string]any)
			switch jsonStr(b["type"]) {
			case "image":
				e.Parts = append(e.Parts, TranscriptPart{Kind: "image"})
			case "text":
				if t := jsonStr(b["text"]); strings.TrimSpace(t) != "" {
					e.Parts = append(e.Parts, textPart("text", t, claudeMaxText))
				}
			case "thinking":
				if t := jsonStr(b["thinking"]); strings.TrimSpace(t) != "" {
					e.Parts = append(e.Parts, textPart("thinking", t, claudeMaxText))
				}
			case "tool_use":
				name := jsonStr(b["name"])
				if name == "" {
					name = "tool"
				}
				in, _ := b["input"].(map[string]any)
				e.Parts = append(e.Parts, TranscriptPart{Kind: "tool", Tool: name, ToolID: jsonStr(b["id"]), Input: summarizeToolInput(in)})
			case "tool_result":
				result, clipped := clampText(stripANSI(toolResultText(b["content"])), claudeMaxResult)
				isErr, _ := b["is_error"].(bool)
				e.Parts = append(e.Parts, TranscriptPart{
					Kind: "tool", Tool: "result", ToolID: jsonStr(b["tool_use_id"]), Result: result,
					IsError: isErr, Orphan: true, Clipped: clipped,
				})
			}
		}
	}
	if len(e.Parts) == 0 {
		return TranscriptEntry{}, false
	}
	if row.IsCompactSummary {
		e.Role = "summary"
	}
	return e, true
}

func jsonStr(v any) string {
	s, _ := v.(string)
	return s
}

func textPart(kind, s string, limit int) TranscriptPart {
	text, clipped := clampText(stripANSI(s), limit)
	return TranscriptPart{Kind: kind, Text: text, Clipped: clipped}
}

// clampText cuts s to at most limit bytes without splitting a rune.
func clampText(s string, limit int) (string, bool) {
	if len(s) <= limit {
		return s, false
	}
	i := limit
	for i > 0 && !utf8.RuneStart(s[i]) {
		i--
	}
	return s[:i], true
}

// classifyClaudeUserText sorts a string user content. Claude Code also uses
// the user role to carry plumbing: reminders addressed to the model are
// dropped, a slash command shows as the command, its output and background
// task notices become notes.
func classifyClaudeUserText(text string) (role, out string, ok bool) {
	t := strings.TrimLeft(text, " \t\r\n")
	envelope := func(tag string) bool { return strings.HasPrefix(t, "<"+tag+">") }
	switch {
	case envelope("system-reminder"), envelope("local-command-caveat"):
		return "", "", false
	case envelope("command-name"), envelope("command-message"):
		line := strings.TrimSpace(xmlInner(t, "command-name") + " " + xmlInner(t, "command-args"))
		return "user", line, line != ""
	case envelope("local-command-stdout"):
		s := xmlInner(t, "local-command-stdout")
		return "note", s, s != ""
	case envelope("task-notification"):
		s := xmlInner(t, "summary")
		return "note", s, s != ""
	}
	return "user", text, strings.TrimSpace(text) != ""
}

// xmlInner returns the trimmed text of the first <tag>…</tag> in s.
func xmlInner(s, tag string) string {
	_, rest, ok := strings.Cut(s, "<"+tag+">")
	if !ok {
		return ""
	}
	inner, _, _ := strings.Cut(rest, "</"+tag+">")
	return strings.TrimSpace(inner)
}

// toolResultText flattens a tool_result content: a string, or a list of
// blocks of which only the text ones are kept.
func toolResultText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var texts []string
		for _, item := range c {
			b, _ := item.(map[string]any)
			if t := jsonStr(b["text"]); jsonStr(b["type"]) == "text" && t != "" {
				texts = append(texts, t)
			}
		}
		return strings.Join(texts, "\n")
	}
	return ""
}

// summarizeToolInput turns a tool call's input into one line: the argument
// that names what the call acts on, else its first string value.
func summarizeToolInput(in map[string]any) string {
	str := func(v any) string {
		switch v := v.(type) {
		case string:
			return strings.TrimSpace(v)
		case []any:
			var parts []string
			for _, x := range v {
				if s, ok := x.(string); ok {
					parts = append(parts, s)
				}
			}
			return strings.TrimSpace(strings.Join(parts, " "))
		}
		return ""
	}
	// Order matters: Grep has both pattern and path, and the pattern is what
	// was searched for.
	for _, k := range []string{"file_path", "command", "pattern", "query", "url", "path", "description", "prompt"} {
		if s := str(in[k]); s != "" {
			return oneLine(s)
		}
	}
	keys := make([]string, 0, len(in))
	for k := range in {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if s, ok := in[k].(string); ok && strings.TrimSpace(s) != "" {
			return oneLine(s)
		}
	}
	return ""
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > claudeMaxSummary {
		s, _ = clampText(s, claudeMaxSummary)
		s += "…"
	}
	return s
}

// ansiRe matches CSI sequences and two-character escapes; transcript text is
// rendered as text, so a colour code would show as garbage.
var ansiRe = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\\\-_]")

func stripANSI(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	return ansiRe.ReplaceAllString(s, "")
}

// claudeSessionFile is <claudeDir>/sessions/<pid>.json, which Claude Code
// writes for every interactive process and does not remove when it exits.
type claudeSessionFile struct {
	PID         int    `json:"pid"`
	SessionID   string `json:"sessionId"`
	Status      string `json:"status"`
	ProcStart   string `json:"procStart"`
	ProcStartFt string `json:"procStartFt"` // Windows: process creation FILETIME
	PIDDomain   string `json:"pidDomain"`
}

// readClaudeSessionFile reads the session file of pid, if Claude Code wrote one.
func readClaudeSessionFile(claudeDir string, pid int) (claudeSessionFile, bool) {
	var f claudeSessionFile
	fh, err := os.Open(filepath.Join(claudeDir, "sessions", fmt.Sprintf("%d.json", pid)))
	if err != nil {
		return f, false
	}
	defer fh.Close()
	// Only a regular file, read up to a limit: a FIFO or a link to a device
	// must not block or exhaust memory.
	if fi, err := fh.Stat(); err != nil || !fi.Mode().IsRegular() {
		return f, false
	}
	const limit = 64 * 1024
	b, err := io.ReadAll(io.LimitReader(fh, limit+1))
	if err != nil || len(b) > limit || json.Unmarshal(b, &f) != nil || f.PID != pid {
		return f, false
	}
	return f, true
}

// procStart is the start-time token the file records for its process.
func (f claudeSessionFile) procStart() string {
	if f.ProcStartFt != "" {
		return f.ProcStartFt
	}
	return f.ProcStart
}

// claudeStatus maps a session file status to the badge statuses. The file
// only knows busy and idle; "waiting for the user" is not in it.
func claudeStatus(s string) string {
	switch s {
	case "busy":
		return "working"
	case "idle":
		return "idle"
	}
	return "unknown"
}
