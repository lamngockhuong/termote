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
	// A tool card's command, and all the old and new text of one edit call
	claudeMaxCommand = 8 * 1024
	claudeMaxEdits   = 16 * 1024
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
	if len(matches) == 0 {
		// Claude Code creates the file with the session's first message.
		return "", errTranscriptNotWritten
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
// once: fields not listed here are skipped, toolUseResult (which repeats
// every tool output) is only searched for its file path, and content is
// decoded generically since it is a string or a list of blocks.
type claudeRow struct {
	Type             string `json:"type"`
	UUID             string `json:"uuid"`
	Timestamp        string `json:"timestamp"`
	IsSidechain      bool   `json:"isSidechain"`
	IsMeta           bool   `json:"isMeta"`
	IsCompactSummary bool   `json:"isCompactSummary"`
	Message          *struct {
		Content any `json:"content"`
		// Model and Usage are on assistant rows; every row of one
		// message repeats the same usage.
		Model string       `json:"model"`
		Usage *claudeUsage `json:"usage"`
	} `json:"message"`
	// ToolUseResult: Claude Code's own record of a tool result, naming the
	// file a Read (file.filePath) or an Edit/Write (filePath) touched
	ToolUseResult claudeToolUseResult `json:"toolUseResult"`
}

// claudeUsage is the token counts of an assistant row's request.
type claudeUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

// claudeToolUseResult is the file path a toolUseResult names: filePath (an
// Edit or Write) or file.filePath (a Read).
type claudeToolUseResult struct{ FilePath string }

// UnmarshalJSON reads only up to the path, which Claude Code writes before
// the file's text (a Read's content, an Edit's originalFile), so the row's
// largest value is not scanned a second time; a value naming no path (a
// Bash output, an error string) is passed over at memchr speed.
func (r *claudeToolUseResult) UnmarshalJSON(b []byte) error {
	if bytes.Contains(b, []byte(`"filePath"`)) {
		r.FilePath = findFilePath(json.NewDecoder(bytes.NewReader(b)), 0)
	}
	return nil
}

// findFilePath returns the first filePath string of the object dec is at,
// looking into its "file" object; "" when there is none or the JSON is not
// an object.
func findFilePath(dec *json.Decoder, depth int) string {
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return ""
	}
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return ""
		}
		switch {
		case k == "filePath":
			var p string
			if dec.Decode(&p) != nil {
				return ""
			}
			return p
		case k == "file" && depth == 0:
			if p := findFilePath(dec, 1); p != "" {
				return p
			}
			return ""
		default:
			var skip json.RawMessage
			if dec.Decode(&skip) != nil {
				return ""
			}
		}
	}
	return ""
}

// anySensitive reports whether one of paths names a sensitive file.
func anySensitive(paths ...string) bool {
	for _, p := range paths {
		if p != "" && isSensitive(p) {
			return true
		}
	}
	return false
}

// claudeInputSensitive reports whether a tool call's input names a sensitive
// file: whatever its result shows (a Read's text, the lines an Edit quotes,
// the lines a Grep of that one file matched) comes from that file.
func claudeInputSensitive(in map[string]any) bool {
	return anySensitive(jsonStr(in["file_path"]), jsonStr(in["notebook_path"]), jsonStr(in["path"]))
}

// Parse reads rows until the last complete line. A line longer than
// agentMaxLine is read through a longLineClipper, which cuts every long
// string in it (the base64 of an image sent with a message), and parsed
// from what is left; when even that does not fit, it leaves a clipped note in
// its place. A tool result is returned as its own orphan part;
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
			var clip longLineClipper
			clip.write(line)
			for errors.Is(err, bufio.ErrBufferFull) {
				line, err = br.ReadSlice('\n')
				n += int64(len(line))
				clip.write(line)
			}
			if err != nil {
				return entries, off // the long line is not complete yet
			}
			off = lineStart + n
			if !clip.overflow {
				if e, ok := parseClaudeRow(clip.out, lineStart); ok {
					entries = append(entries, e)
				}
				continue
			}
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

// longLineKeep is how many bytes of each JSON string a longLineClipper
// keeps. Even a string made only of \uXXXX escapes still decodes past
// claudeMaxText, so a text cut here is still reported clipped.
const longLineKeep = 6 * claudeMaxText

// longLineClipper copies a JSON line too long to hold, keeping at most
// longLineKeep bytes of each string. A string is cut only before a complete
// character or escape, so what is left still decodes. Past agentMaxLine of
// output (a line made of many short strings) it sets overflow and keeps
// nothing more.
type longLineClipper struct {
	out      []byte
	overflow bool
	inString bool
	escape   bool
	hexLeft  int // hex digits of a \uXXXX escape still to come
	strLen   int
	dropping bool
}

func (c *longLineClipper) write(p []byte) {
	for _, b := range p {
		keep := true
		switch {
		case !c.inString:
			if b == '"' {
				c.inString, c.strLen, c.dropping = true, 0, false
			}
		case c.escape:
			c.escape = false
			if b == 'u' {
				c.hexLeft = 4
			}
			keep = !c.dropping
		case c.hexLeft > 0:
			c.hexLeft--
			keep = !c.dropping
		case b == '"':
			c.inString = false
		default:
			if !c.dropping && c.strLen >= longLineKeep && utf8.RuneStart(b) {
				c.dropping = true
			}
			c.escape = b == '\\'
			keep = !c.dropping
			c.strLen++
		}
		if !keep || c.overflow {
			continue
		}
		if len(c.out) >= agentMaxLine {
			c.overflow, c.out = true, nil
			continue
		}
		c.out = append(c.out, b)
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
	content := row.Message.Content
	if s, ok := content.(string); ok {
		// A string message reads as a single text block.
		content = []any{map[string]any{"type": "text", "text": s}}
	}
	if c, ok := content.([]any); ok {
		var blockRole string
		for _, item := range c {
			b, _ := item.(map[string]any)
			switch jsonStr(b["type"]) {
			case "image":
				e.Parts = append(e.Parts, TranscriptPart{Kind: "image"})
			case "text":
				t := jsonStr(b["text"])
				if row.Type == "user" {
					// Only the user role carries Claude Code's envelopes;
					// the model's own words are shown as written.
					role, s, ok := classifyClaudeUserText(t)
					if !ok {
						continue
					}
					if role != "user" {
						blockRole = role
					}
					t = s
				}
				if strings.TrimSpace(t) != "" {
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
				e.Parts = append(e.Parts, TranscriptPart{
					Kind: "tool", Tool: name, ToolID: jsonStr(b["id"]), Input: summarizeToolInput(in),
					Detail: claudeToolDetail(name, in), sensitive: claudeInputSensitive(in),
				})
			case "tool_result":
				result, clipped := clampText(stripANSI(toolResultText(b["content"])), claudeMaxResult)
				isErr, _ := b["is_error"].(bool)
				e.Parts = append(e.Parts, TranscriptPart{
					Kind: "tool", Tool: "result", ToolID: jsonStr(b["tool_use_id"]), Result: result,
					IsError: isErr, Orphan: true, Clipped: clipped, sensitive: anySensitive(row.ToolUseResult.FilePath),
				})
			}
		}
		// A lone notice (a command's output, an interruption) is a note,
		// not the user's speech.
		if blockRole != "" && len(e.Parts) == 1 && e.Parts[0].Kind == "text" {
			e.Role = blockRole
		}
	}
	if len(e.Parts) == 0 {
		return TranscriptEntry{}, false
	}
	if row.IsCompactSummary {
		e.Role = "summary"
	}
	// Claude Code writes an error or an interruption as an assistant row of
	// model <synthetic> with zero usage: it filled no context.
	if u := row.Message.Usage; u != nil && row.Type == "assistant" && row.Message.Model != "<synthetic>" {
		// The whole prompt of the request: what fills the context.
		e.usage = &entryUsage{
			contextTokens: u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens,
			model:         row.Message.Model,
		}
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

// classifyClaudeUserText sorts a user text. Claude Code also uses the user
// role to carry plumbing: reminders addressed to the model are dropped, a
// slash command or a ! command shows as typed, their output, background task
// notices and injected prompts become notes. The envelopes are the ones the
// VS Code extension's chat recognises; scripts/claude-chat-tags.sh compares
// the two lists.
func classifyClaudeUserText(text string) (role, out string, ok bool) {
	t := strings.TrimLeft(text, " \t\r\n")
	if s, ok := claudeInterrupts[strings.TrimSpace(t)]; ok {
		return "note", s, true
	}
	tag := claudeEnvelope(t)
	switch tag {
	case "system-reminder", "local-command-caveat":
		return "", "", false
	case "command-name", "command-message":
		line := strings.TrimSpace(xmlInner(t, "command-name") + " " + xmlInner(t, "command-args"))
		return "user", line, line != ""
	case "local-command-stdout", "local-command-stderr":
		s := joinOutputs(t, "local-command-stdout", "local-command-stderr")
		return "note", s, s != ""
	case "bash-input":
		s := xmlInner(t, "bash-input")
		return "user", "! " + s, s != ""
	case "bash-stdout", "bash-stderr":
		s := joinOutputs(t, "bash-stdout", "bash-stderr")
		if code := xmlInner(t, "bash-exit-code"); code != "" && code != "0" {
			s = strings.TrimSpace(s + "\nExit code " + code)
		}
		return "note", s, s != ""
	case "task-notification":
		s := unescapeXML(xmlInner(t, "summary"))
		return "note", s, s != ""
	}
	if n, ok := claudeNotices[tag]; ok {
		s := n.label
		if body := unescapeXML(xmlInner(t, tag)); body != "" && !n.labelOnly {
			s += ": " + body
		}
		return "note", s, true
	}
	text = stripPastedTags(text)
	return "user", text, strings.TrimSpace(text) != ""
}

// claudeInterrupts are the texts Claude Code writes as the user when the
// user stops a turn, and the note shown instead.
var claudeInterrupts = map[string]string{
	"[Request interrupted by user]":              "Interrupted",
	"[Request interrupted by user for tool use]": "Tool interrupted",
}

// claudeNotices are envelopes around a prompt Claude Code injects as the
// user (a teammate's or another session's message, an autonomous tick, an
// MCP update, a hook's output): a note with a label, the extension's own
// where it has one, then the body. An artifact envelope carries a file or
// instructions for the model, so its note is the label alone.
var claudeNotices = map[string]struct {
	label     string
	labelOnly bool
}{
	"teammate-message":            {label: "Teammate message"},
	"tick":                        {label: "Autonomous prompt"},
	"mcp-resource-update":         {label: "MCP resource update"},
	"mcp-polling-update":          {label: "MCP polling update"},
	"agent-message":               {label: "Agent message"},
	"cross-session-message":       {label: "Message from another session"},
	"coordinator-relay":           {label: "Coordinator message"},
	"channel":                     {label: "Channel message"},
	"remote-review":               {label: "Remote review"},
	"slack-ping":                  {label: "Slack message"},
	"slack-tag-message":           {label: "Slack message"},
	"fetched-web-content":         {label: "Fetched web content"},
	"user-prompt-submit-hook":     {label: "Hook output"},
	"post-tool-use-hook":          {label: "Hook output"},
	"artifact-type-instructions":  {label: "Artifact instructions", labelOnly: true},
	"artifact-file-content":       {label: "Artifact file", labelOnly: true},
	"artifact-origin-notes":       {label: "Artifact notes", labelOnly: true},
	"artifact-stored-declaration": {label: "Artifact saved", labelOnly: true},
	"cowritten-artifact-html":     {label: "Artifact page", labelOnly: true},
}

// claudeEnvelopeRe matches the opening tag a plumbing text starts with; a
// tag may carry attributes (<teammate-message teammate_id="…">).
var claudeEnvelopeRe = regexp.MustCompile(`^<([a-z][a-z0-9_-]*)(?:[ \t][^>\r\n]*)?>`)

// claudeEnvelope returns the name of the tag t starts with, or "".
func claudeEnvelope(t string) string {
	if !strings.HasPrefix(t, "<") {
		return "" // speech, the common case: no regexp run
	}
	if m := claudeEnvelopeRe.FindStringSubmatch(t); m != nil {
		return m[1]
	}
	return ""
}

// joinOutputs joins the output and error output of a command, leaving out
// an empty one, with its XML escapes undone.
func joinOutputs(t, out, errOut string) string {
	s := unescapeXML(xmlInner(t, out))
	if e := unescapeXML(xmlInner(t, errOut)); e != "" {
		s = strings.TrimSpace(s + "\n" + e)
	}
	return s
}

// unescapeXML undoes the escapes Claude Code applies to text inside its
// envelopes (a command's output, a task summary).
var unescapeXML = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&").Replace

// stripPastedTags removes the tags around an expanded paste, and the line
// breaks left at either end of the message.
func stripPastedTags(text string) string {
	if !strings.Contains(text, "<pasted_content id=") {
		return text
	}
	return strings.Trim(pastedTagRe.ReplaceAllString(text, ""), "\r\n")
}

// pastedTagRe matches the tags Claude Code wraps a long paste in when it
// expands its [Pasted text #N] token into the message (2.1.286):
// <pasted_content id="5edd"> … </pasted_content id="5edd">.
var pastedTagRe = regexp.MustCompile(`</?pasted_content id="[^"<>]*">\n?`)

// xmlInner returns the trimmed text of the first <tag>…</tag> in s; the
// opening tag may carry attributes.
func xmlInner(s, tag string) string {
	open := "<" + tag
	for {
		i := strings.Index(s, open)
		if i < 0 {
			return ""
		}
		s = s[i+len(open):]
		if s != "" && (s[0] == '>' || s[0] == ' ' || s[0] == '\t') {
			break
		}
	}
	_, rest, ok := strings.Cut(s, ">")
	if !ok {
		return ""
	}
	inner, _, _ := strings.Cut(rest, "</"+tag+">")
	return strings.TrimSpace(inner)
}

// toolResultText flattens a tool output: a string, or a list of blocks of
// which those carrying text are kept (Claude Code's text blocks, Codex's
// input_text and inputText content items).
func toolResultText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var texts []string
		for _, item := range c {
			b, _ := item.(map[string]any)
			if t := jsonStr(b["text"]); t != "" {
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

// claudeToolDetail reads what a tool call's card shows: the description the
// model gave it, a Bash command whole, and the text of Edit, MultiEdit and
// Write. Edits of a file the Files view would not show without reveal are
// left out, as its diff is.
func claudeToolDetail(tool string, in map[string]any) *ToolDetail {
	d := &ToolDetail{}
	if s := jsonStr(in["description"]); strings.TrimSpace(s) != "" {
		d.Description = oneLine(s)
	}
	if tool == "Bash" {
		if s := strings.TrimSpace(jsonStr(in["command"])); s != "" {
			d.Command, d.Clipped = clampText(stripANSI(s), claudeMaxCommand)
		}
	}
	var edits []ToolEdit
	switch tool {
	case "Edit":
		edits = []ToolEdit{{Old: jsonStr(in["old_string"]), New: jsonStr(in["new_string"])}}
	case "MultiEdit":
		list, _ := in["edits"].([]any)
		for _, x := range list {
			m, _ := x.(map[string]any)
			edits = append(edits, ToolEdit{Old: jsonStr(m["old_string"]), New: jsonStr(m["new_string"])})
		}
	case "Write":
		edits = []ToolEdit{{New: jsonStr(in["content"])}}
	}
	if len(edits) > 0 {
		if claudeInputSensitive(in) {
			d.Hidden = true
		} else {
			var clipped bool
			d.Edits, clipped = clampEdits(edits, claudeMaxEdits)
			d.Clipped = d.Clipped || clipped
		}
	}
	if d.Description == "" && d.Command == "" && len(d.Edits) == 0 && !d.Hidden {
		return nil
	}
	return d
}

// clampEdits keeps edits while their text fits in limit bytes; the one that
// crosses it is cut, the rest are dropped.
func clampEdits(edits []ToolEdit, limit int) ([]ToolEdit, bool) {
	out := make([]ToolEdit, 0, len(edits))
	for _, e := range edits {
		e.Old, e.New = stripANSI(e.Old), stripANSI(e.New)
		if e.Old == "" && e.New == "" {
			continue
		}
		var c1, c2 bool
		e.Old, c1 = clampText(e.Old, limit)
		limit -= len(e.Old)
		e.New, c2 = clampText(e.New, limit)
		limit -= len(e.New)
		out = append(out, e)
		if c1 || c2 {
			return out, true
		}
	}
	return out, false
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
	fh, err := os.OpenFile(filepath.Join(claudeDir, "sessions", fmt.Sprintf("%d.json", pid)), os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return f, false
	}
	defer fh.Close()
	// Only a regular file, read up to a limit: a FIFO or a link to a device
	// must not block or exhaust memory (openNonblock: opening a FIFO does
	// not wait for a writer).
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

// claudeStatus maps a session file status to the badge statuses: busy while
// a turn runs, waiting while a dialog is open, idle otherwise.
func claudeStatus(s string) string {
	switch s {
	case "busy":
		return "working"
	case "idle":
		return "idle"
	case "waiting": // a dialog is open (measured on 2.1.286)
		return "blocked"
	}
	return "unknown"
}
