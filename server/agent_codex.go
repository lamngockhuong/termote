package main

import (
	"bufio"
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
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
		Reason  string     `json:"reason"`    // turn_aborted
		Turns   int        `json:"num_turns"` // thread_rolled_back
		// A legacy event's own fields: the item's, at the payload's top.
		codexLegacyPayload
	} `json:"payload"`
}

// codexLegacyPayload is a legacy event (codexLegacyItems): the fields of
// the item it stands for, plus the call id and an MCP call's invocation.
type codexLegacyPayload struct {
	codexItem
	CallID     string `json:"call_id"`
	Invocation *struct {
		Server    string `json:"server"`
		Tool      string `json:"tool"`
		Arguments any    `json:"arguments"`
	} `json:"invocation"`
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
	// Extension; SubAgentActivity (kind); WebSearch (query)
	Kind  string `json:"kind"`
	Query string `json:"query"`
	// ImageView
	Path string `json:"path"`
	// Plan
	Text string `json:"text"`
	// HookPrompt
	Fragments []struct {
		Text string `json:"text"`
	} `json:"fragments"`
	// FunctionCallOutput (name, output); DynamicToolCall (namespace, tool,
	// arguments, content_items, success, error)
	Name         string `json:"name"`
	Namespace    string `json:"namespace"`
	Output       any    `json:"output"`
	ContentItems any    `json:"content_items"`
	Success      *bool  `json:"success"`
	// Error is a string (DynamicToolCall) or {"message"} (McpToolCall),
	// decoded generically so either form keeps the row.
	Error any `json:"error"`
	// CollabAgentToolCall
	Prompt         string `json:"prompt"`
	ReceiverAgents []struct {
		AgentNickname string `json:"agent_nickname"`
		AgentRole     string `json:"agent_role"`
	} `json:"receiver_agents"`
	// SubAgentActivity
	AgentPath string `json:"agent_path"`
	// ImageGeneration
	RevisedPrompt string `json:"revised_prompt"`
	SavedPath     string `json:"saved_path"`
	// EnteredReviewMode, ExitedReviewMode
	UserFacingHint string             `json:"user_facing_hint"`
	ReviewOutput   *codexReviewOutput `json:"review_output"`
}

// codexReviewOutput is what a /review turn found.
type codexReviewOutput struct {
	Findings []struct {
		Title    string `json:"title"`
		Body     string `json:"body"`
		Priority int    `json:"priority"`
	} `json:"findings"`
	OverallCorrectness string `json:"overall_correctness"`
	OverallExplanation string `json:"overall_explanation"`
}

type codexChange struct {
	Type        string `json:"type"` // add | update | delete
	UnifiedDiff string `json:"unified_diff"`
	Content     string `json:"content"`
	MovePath    string `json:"move_path"`
}

// codexToolNames maps item types to the tool names the Chat view shows, so a
// Codex command reads like a Claude Code one.
var codexToolNames = map[string]string{"CommandExecution": "Bash", "FileChange": "Edit", "ImageView": "ViewImage"}

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
			if bytes.Contains(line, []byte(`"event_msg"`)) {
				ev := codexEventIn(line)
				itemType = codexLegacyItems[ev]
				if ev == "item_completed" {
					itemType = "item"
					if m := codexItemTypeRe.FindSubmatch(line); m != nil {
						itemType = string(m[1])
					}
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
		switch codexEventIn(line) {
		case "":
			continue
		case "token_count":
			// Context and rate limits of the request just answered: they
			// go on the entry before, so no entry is added.
			addCodexTokenCount(entries, line)
			continue
		case "task_started":
			turnStart, turnKnown = lineStart, false
			continue
		case "task_complete":
			if turnStart >= 0 && !turnKnown && !noted {
				noted = true
				entries = append(entries, TranscriptEntry{
					ID: fmt.Sprintf("unsupported-%d", turnStart), Role: "note", off: turnStart,
					Parts: []TranscriptPart{{Kind: "text", Text: "unsupported history format"}},
				})
			}
			turnStart = -1
			continue
		}
		e, recognised, ok := parseCodexRow(line, lineStart)
		turnKnown = turnKnown || recognised
		if ok {
			entries = append(entries, e)
		}
	}
}

// codexTokenCountRow is a token_count event: the context the last request
// filled (last_token_usage) in the model's window, and the account's rate
// limits. Read for the overview only.
type codexTokenCountRow struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		Type string `json:"type"`
		Info *struct {
			LastTokenUsage *struct {
				TotalTokens int64 `json:"total_tokens"`
			} `json:"last_token_usage"`
			ModelContextWindow int64 `json:"model_context_window"`
		} `json:"info"`
		RateLimits *struct {
			Primary   *codexLimitWindow `json:"primary"`
			Secondary *codexLimitWindow `json:"secondary"`
			PlanType  string            `json:"plan_type"`
		} `json:"rate_limits"`
	} `json:"payload"`
}

type codexLimitWindow struct {
	UsedPercent   float64 `json:"used_percent"`
	WindowMinutes int     `json:"window_minutes"`
	ResetsAt      int64   `json:"resets_at"` // Unix seconds
}

// addCodexTokenCount puts a token_count row's context and rate limits on the
// last assistant entry of entries; a later row replaces what an earlier one
// put. A row that cannot be read, or with no assistant entry before it in
// this read, is skipped: when a tail chunk starts between an entry and its
// row, the overview shows the turn before until the next row.
func addCodexTokenCount(entries []TranscriptEntry, line []byte) {
	i := len(entries) - 1
	for i >= 0 && entries[i].Role != "assistant" {
		i--
	}
	if i < 0 {
		return
	}
	var row codexTokenCountRow
	if json.Unmarshal(line, &row) != nil || row.Type != "event_msg" || row.Payload.Type != "token_count" {
		return
	}
	u := entryUsage{noContext: true}
	if old := entries[i].usage; old != nil {
		u = *old
	}
	if in := row.Payload.Info; in != nil && in.LastTokenUsage != nil && in.ModelContextWindow > 0 {
		u.contextTokens, u.window, u.noContext = in.LastTokenUsage.TotalTokens, in.ModelContextWindow, false
	}
	if l := codexLimitsOf(row); l != nil {
		u.limits = l
	}
	if u.noContext && u.limits == nil {
		return
	}
	entries[i].usage = &u
}

// codexLimitsOf is the row's rate limits, primary window first; nil when it
// has none (an API key login) or no readable time.
func codexLimitsOf(row codexTokenCountRow) *codexLimits {
	rl := row.Payload.RateLimits
	ts, err := time.Parse(time.RFC3339Nano, row.Timestamp)
	if rl == nil || err != nil {
		return nil
	}
	l := codexLimits{plan: rl.PlanType, ts: ts.UTC().Format(activityTimeFormat)}
	for _, w := range []*codexLimitWindow{rl.Primary, rl.Secondary} {
		if w == nil || w.WindowMinutes <= 0 {
			continue
		}
		uw := usageWindow{UsedPercent: min(max(w.UsedPercent, 0), 100), WindowMinutes: w.WindowMinutes}
		if w.ResetsAt > 0 {
			uw.ResetsAt = time.Unix(w.ResetsAt, 0).UTC().Format(time.RFC3339)
		}
		l.windows = append(l.windows, uw)
	}
	if len(l.windows) == 0 {
		return nil
	}
	return &l
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
	case "turn_aborted", "thread_rolled_back":
		text := "Interrupted"
		if r := row.Payload.Reason; r != "" && r != "interrupted" {
			text = "Turn ended: " + strings.ReplaceAll(r, "_", " ")
		}
		if row.Payload.Type == "thread_rolled_back" {
			text = fmt.Sprintf("Rolled back %d turns", row.Payload.Turns)
			if row.Payload.Turns == 1 {
				text = "Rolled back 1 turn"
			}
		}
		e.Role = "note"
		e.Parts = []TranscriptPart{{Kind: "text", Text: text}}
		return e, true, true
	case "item_completed":
	default:
		itemType, legacy := codexLegacyItems[row.Payload.Type]
		if !legacy {
			return e, false, false
		}
		row.Payload.Item = row.Payload.codexLegacyPayload.item(itemType)
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
		if t := cmp.Or(strings.Join(it.SummaryText, "\n\n"), it.Text); strings.TrimSpace(t) != "" {
			e.Parts = append(e.Parts, textPart("thinking", t, claudeMaxText))
		}
	case "CommandExecution":
		result, clipped := clampText(stripANSI(it.AggregatedOutput), claudeMaxResult)
		p := TranscriptPart{
			Kind: "tool", Tool: codexToolNames["CommandExecution"], ToolID: it.ID, Input: oneLine(codexCommand(it.Command)),
			Result: result, IsError: it.Status == "failed" || (it.ExitCode != nil && *it.ExitCode != 0), Clipped: clipped,
		}
		if cmd := strings.TrimSpace(stripANSI(codexCommand(it.Command))); cmd != "" {
			d := &ToolDetail{}
			d.Command, d.Clipped = clampText(cmd, claudeMaxCommand)
			p.Detail = d
		}
		e.Parts = append(e.Parts, p)
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
				Result: result, IsError: it.Status != "completed", Clipped: clipped, sensitive: anySensitive(p, c.MovePath),
			})
		}
	case "McpToolCall":
		tool := strings.Trim(it.Server+"."+it.Tool, ".")
		if tool == "" {
			tool = "mcp"
		}
		in, _ := it.Arguments.(map[string]any)
		errText := codexErrorText(it.Error)
		p := TranscriptPart{Kind: "tool", Tool: tool, ToolID: it.ID, Input: summarizeToolInput(in), IsError: it.Status == "failed" || errText != ""}
		if res, ok := it.Result.(map[string]any); ok {
			p.Result, p.Clipped = clampText(stripANSI(toolResultText(res["content"])), claudeMaxResult)
			isErr, _ := res["isError"].(bool)
			isErr2, _ := res["is_error"].(bool)
			p.IsError = p.IsError || isErr || isErr2
		}
		if errText != "" && p.Result == "" {
			p.Result, p.Clipped = clampText(stripANSI(errText), claudeMaxResult)
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
	case "Plan":
		if strings.TrimSpace(it.Text) != "" {
			e.Parts = append(e.Parts, textPart("text", it.Text, claudeMaxText))
		}
	case "ImageView":
		path := strings.TrimPrefix(it.Path, "file://")
		e.Parts = append(e.Parts, TranscriptPart{
			Kind: "tool", Tool: codexToolNames[it.Type], ToolID: it.ID, Input: oneLine(path), sensitive: anySensitive(path),
		})
	case "WebSearch":
		e.Parts = append(e.Parts, TranscriptPart{Kind: "tool", Tool: it.Type, ToolID: it.ID, Input: oneLine(it.Query)})
	case "ImageGeneration":
		// result is the image itself (base64): only where it was saved is shown.
		e.Parts = append(e.Parts, TranscriptPart{
			Kind: "tool", Tool: it.Type, ToolID: it.ID, Input: oneLine(it.RevisedPrompt),
			Result: it.SavedPath, IsError: it.Status == "failed",
		})
	case "FunctionCallOutput", "DynamicToolCall":
		name := it.Tool
		if it.Type == "FunctionCallOutput" {
			name = it.Name
		}
		tool := cmp.Or(strings.Trim(it.Namespace+"."+name, "."), "tool")
		in, _ := it.Arguments.(map[string]any)
		out := toolResultText(it.Output) + toolResultText(it.ContentItems)
		errText := codexErrorText(it.Error)
		if errText != "" {
			out = strings.TrimSpace(out + "\n" + errText)
		}
		result, clipped := clampText(stripANSI(out), claudeMaxResult)
		e.Parts = append(e.Parts, TranscriptPart{
			Kind: "tool", Tool: tool, ToolID: it.ID, Input: summarizeToolInput(in), Result: result, Clipped: clipped,
			IsError: it.Status == "failed" || errText != "" || (it.Success != nil && !*it.Success),
		})
	case "CollabAgentToolCall":
		input := oneLine(it.Prompt)
		if input == "" {
			var names []string
			for _, a := range it.ReceiverAgents {
				if n := cmp.Or(a.AgentNickname, a.AgentRole); n != "" {
					names = append(names, n)
				}
			}
			input = strings.Join(names, ", ")
		}
		e.Parts = append(e.Parts, TranscriptPart{
			Kind: "tool", Tool: "Agent " + cmp.Or(it.Tool, "call"), ToolID: it.ID, Input: input, IsError: it.Status == "failed",
		})
	case "SubAgentActivity":
		e.Role = "note"
		e.Parts = append(e.Parts, TranscriptPart{Kind: "text", Text: strings.TrimSpace("Subagent " + it.AgentPath + " " + it.Kind)})
	case "HookPrompt":
		var texts []string
		for _, f := range it.Fragments {
			if t := strings.TrimSpace(f.Text); t != "" {
				texts = append(texts, t)
			}
		}
		if len(texts) > 0 {
			e.Role = "note"
			e.Parts = append(e.Parts, textPart("text", "Hook: "+strings.Join(texts, "\n"), claudeMaxText))
		}
	case "EnteredReviewMode":
		e.Role = "note"
		e.Parts = append(e.Parts, TranscriptPart{Kind: "text", Text: strings.TrimSpace("Review started " + it.UserFacingHint)})
	case "ExitedReviewMode":
		if t := codexReviewText(it.ReviewOutput); t != "" {
			e.Parts = append(e.Parts, textPart("text", t, claudeMaxText))
		}
	default:
		// An item type this parser does not know: the turn is not judged
		// readable on its account.
		return e, false, false
	}
	return e, true, len(e.Parts) > 0
}

// codexItemTypes are the item types parseCodexRow reads; a test checks each
// is read, and scripts/codex-chat-items.sh compares them with the Codex
// source.
var codexItemTypes = []string{
	"UserMessage", "AgentMessage", "Reasoning", "CommandExecution", "FileChange", "McpToolCall",
	"Extension", "ContextCompaction", "Plan", "ImageView", "WebSearch", "ImageGeneration",
	"FunctionCallOutput", "DynamicToolCall", "CollabAgentToolCall", "SubAgentActivity", "HookPrompt",
	"EnteredReviewMode", "ExitedReviewMode",
}

// codexLegacyItems maps the events a legacy-mode rollout writes in place of
// an item_completed row to that item's type (codex-rs/rollout policy.rs).
var codexLegacyItems = map[string]string{
	"agent_reasoning": "Reasoning", "patch_apply_end": "FileChange", "mcp_tool_call_end": "McpToolCall",
	"web_search_end": "WebSearch", "image_generation_end": "ImageGeneration", "context_compacted": "ContextCompaction",
	"entered_review_mode": "EnteredReviewMode", "exited_review_mode": "ExitedReviewMode",
	"sub_agent_activity": "SubAgentActivity",
}

// codexSkippedEvents are persisted events with nothing to show: the
// status and context the read loop takes from some, a goal change, raw
// reasoning (its summary is shown). TestCodexRolloutItems and
// scripts/codex-chat-items.sh count them as handled.
var codexSkippedEvents = []string{"thread_settings_applied", "thread_goal_updated", "agent_reasoning_raw_content"}

// codexEventNames are the events the read loop acts on, the frequent first:
// a row is matched against them in this order.
var codexEventNames = append([]string{
	"item_completed", "user_message", "agent_message", "token_count", "task_started", "task_complete",
	"turn_aborted", "thread_rolled_back",
}, slices.Sorted(maps.Keys(codexLegacyItems))...)

// codexEventQuoted is codexEventNames quoted as a row holds them, built once.
var codexEventQuoted = func() [][]byte {
	q := make([][]byte, len(codexEventNames))
	for i, ev := range codexEventNames {
		q[i] = []byte(`"` + ev + `"`)
	}
	return q
}()

// codexEventIn returns the first event of codexEventNames line names, or "".
func codexEventIn(line []byte) string {
	for i, q := range codexEventQuoted {
		if bytes.Contains(line, q) {
			return codexEventNames[i]
		}
	}
	return ""
}

// item turns a legacy event into the item it stands for: the call id is
// the id, an MCP call's invocation is flattened and its Rust Result
// ({"Ok": …} or {"Err": "…"}) split into result and error, and a patch
// with no status takes it from success.
func (p *codexLegacyPayload) item(itemType string) *codexItem {
	it := &p.codexItem
	it.Type, it.ID = itemType, cmp.Or(it.ID, p.CallID)
	if inv := p.Invocation; inv != nil {
		it.Server, it.Tool, it.Arguments = inv.Server, inv.Tool, inv.Arguments
		if r, ok := it.Result.(map[string]any); ok {
			it.Result, it.Error = r["Ok"], r["Err"]
		}
	}
	if it.Status == "" && it.Success != nil {
		it.Status = "failed"
		if *it.Success {
			it.Status = "completed"
		}
	}
	return it
}

// codexErrorText is an item's error: a string or an object's message.
func codexErrorText(v any) string {
	switch e := v.(type) {
	case string:
		return e
	case map[string]any:
		return jsonStr(e["message"])
	}
	return ""
}

// codexReviewText is a /review turn's verdict, then its findings by priority.
func codexReviewText(r *codexReviewOutput) string {
	if r == nil {
		return ""
	}
	var b strings.Builder
	b.WriteString(strings.TrimSpace(r.OverallCorrectness + "\n\n" + r.OverallExplanation))
	for _, f := range r.Findings {
		fmt.Fprintf(&b, "\n\n[P%d] %s\n%s", f.Priority, f.Title, f.Body)
	}
	return strings.TrimSpace(b.String())
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
// that completed or was aborted means idle. thread_settings_applied is no
// marker: Codex writes it on a model change in the middle of a turn as well
// as on a resume, so a turn killed and then resumed reads as working until
// the next turn ends. A turn can be megabytes long, so no fixed window is
// enough. path comes from Locate.
func codexStatus(path string) string {
	f, err := os.OpenFile(path, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return "unknown"
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return "unknown"
	}
	size, key := fi.Size(), path+"\x00"+rolloutIdentity(path, f, fi)
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

var codexMarkerNames = [][]byte{[]byte(`"task_started"`), []byte(`"task_complete"`), []byte(`"turn_aborted"`)}

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
	case "task_complete", "turn_aborted":
		return "idle", true
	}
	return "", false
}
