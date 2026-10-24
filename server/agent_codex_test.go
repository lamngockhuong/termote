package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	testCodexID    = "01a0fbc2-4df0-7f32-864d-eb33100e552d"
	testCodexSubID = "01a0fbc6-978c-74a1-aeae-d34f439bfce2"
)

func parseCodex(s string) ([]TranscriptEntry, int64) {
	return codexJournal{}.Parse(strings.NewReader(s), 0)
}

// codexEvent returns one event_msg row with payload p.
func codexEvent(p map[string]any) string {
	b, _ := json.Marshal(map[string]any{"timestamp": "2026-10-02T08:37:02.070Z", "type": "event_msg", "payload": p})
	return string(b) + "\n"
}

func codexItemRow(item map[string]any) string {
	return codexEvent(map[string]any{"type": "item_completed", "turn_id": "t1", "item": item})
}

// codexLongItem returns an item_completed row in the key order Codex writes
// (type first), with field set to value; json.Marshal would sort the keys and
// push the type behind a long value.
func codexLongItem(itemType, field, value string) string {
	return `{"timestamp":"2026-10-02T08:37:02.070Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"` +
		itemType + `","id":"x","` + field + `":"` + value + `"}}}` + "\n"
}

func TestCodexParseFixture(t *testing.T) {
	b, err := os.ReadFile("testdata/codex/rollout-0.159.3.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	entries, next := parseCodex(string(b))
	if next != int64(len(b)) {
		t.Errorf("next = %d, want %d", next, len(b))
	}
	type want struct{ role, kind, tool, text, input string }
	var got []want
	for _, e := range entries {
		for _, p := range e.Parts {
			got = append(got, want{e.Role, p.Kind, p.Tool, p.Text, p.Input})
		}
	}
	expect := []want{
		{"user", "text", "", "Run `sleep 6; ls` and tell me the file count.", ""},
		{"assistant", "text", "", "I’ll wait six seconds, list the directory, and count its entries.", ""},
		{"assistant", "tool", "Bash", "", "sleep 6; ls"},
		{"assistant", "text", "", "2 files.", ""},
		{"user", "text", "", "Run `touch c.txt` (request approval if needed), then reply done.", ""},
		{"assistant", "tool", "Bash", "", "touch c.txt"},
		{"assistant", "text", "", "done", ""},
	}
	if len(got) < len(expect) {
		t.Fatalf("got %d parts: %+v", len(got), got)
	}
	for i, w := range expect {
		if got[i] != w {
			t.Errorf("part %d = %+v, want %+v", i, got[i], w)
		}
	}
	// The response_item rows (what the model saw) never show.
	for _, e := range entries {
		for _, p := range e.Parts {
			if strings.Contains(p.Text, "environment_context") {
				t.Errorf("model input shown: %+v", e)
			}
		}
	}
	var bash, edits []TranscriptPart
	for _, e := range entries {
		if e.TS == "" || e.ID == "" {
			t.Errorf("entry without id or ts: %+v", e)
		}
		for _, p := range e.Parts {
			switch p.Tool {
			case "Bash":
				bash = append(bash, p)
			case "Edit":
				edits = append(edits, p)
			}
		}
	}
	if bash[0].Result != "a.txt\nb.txt\n" || bash[0].IsError || bash[0].ToolID == "" || bash[0].Orphan {
		t.Errorf("ls = %+v", bash[0])
	}
	var failed bool
	for _, p := range bash {
		if p.Input == "cat missing.txt" {
			failed = p.IsError && strings.Contains(p.Result, "No such file")
		}
	}
	if !failed {
		t.Error("the failed command is not marked as an error")
	}
	if len(edits) != 2 || edits[0].Input != "/home/user/proj/a.txt" || edits[0].Result != "@@ -1 +1 @@\n-a\n+hello\n" ||
		edits[1].Input != "/home/user/proj/d.txt" || edits[1].Result != "+new\n" || edits[0].IsError {
		t.Errorf("edits = %+v", edits)
	}
}

func TestCodexParsePartialLineAndOffsets(t *testing.T) {
	first := codexItemRow(map[string]any{"type": "UserMessage", "id": "u1", "content": []any{map[string]any{"type": "text", "text": "hi"}}})
	second := codexItemRow(map[string]any{"type": "AgentMessage", "id": "a1", "content": []any{map[string]any{"type": "Text", "text": "hello"}}})
	entries, next := parseCodex(first + second[:20])
	if len(entries) != 1 || next != int64(len(first)) || entries[0].off != 0 {
		t.Fatalf("partial = %+v, %d", entries, next)
	}
	entries, next = codexJournal{}.Parse(strings.NewReader(second), 100)
	if len(entries) != 1 || entries[0].off != 100 || next != 100+int64(len(second)) || entries[0].Role != "assistant" {
		t.Fatalf("offset read = %+v, %d", entries, next)
	}
}

func TestCodexParseLongLines(t *testing.T) {
	big := strings.Repeat("9", agentMaxLine)
	cmd := codexLongItem("CommandExecution", "aggregated_output", big)
	resp := `{"type":"response_item","payload":{"type":"message","text":"` + big + "\"}}\n"
	// A completed item whose type is not at the start of the line.
	odd := `{"type":"event_msg","payload":{"type":"item_completed","item":{"id":"y","aggregated_output":"` + big + `","type":"CommandExecution"}}}` + "\n"
	tail := codexItemRow(map[string]any{"type": "AgentMessage", "content": []any{map[string]any{"type": "text", "text": "after"}}})
	entries, next := parseCodex(cmd + resp + odd + tail)
	if next != int64(len(cmd+resp+odd+tail)) || len(entries) != 3 {
		t.Fatalf("entries = %d, next = %d", len(entries), next)
	}
	if p := entries[0].Parts[0]; p.Tool != "Bash" || !p.Clipped || entries[0].Role != "assistant" || entries[0].off != 0 {
		t.Errorf("long command = %+v", entries[0])
	}
	if p := entries[1].Parts[0]; p.Tool != "item" || !p.Clipped {
		t.Errorf("long item without a readable type = %+v", entries[1])
	}
	if entries[2].Parts[0].Text != "after" {
		t.Errorf("after = %+v", entries[2])
	}
	// Another known item type keeps its own name; a long line still being
	// written is left for the next read.
	mcp := codexLongItem("McpToolCall", "arguments", big)
	if entries, _ := parseCodex(mcp); len(entries) != 1 || entries[0].Parts[0].Tool != "McpToolCall" {
		t.Errorf("long mcp = %+v", entries)
	}
	// Long messages keep their role; a long row that is not an event, even
	// one naming item_completed, is skipped.
	user := codexLongItem("UserMessage", "content", big)
	notEvent := `{"type":"response_item","payload":{"type":"item_completed","x":"` + big + "\"}}\n"
	if entries, _ := parseCodex(user + notEvent); len(entries) != 1 || entries[0].Role != "user" || entries[0].Parts[0].Kind != "text" || !entries[0].Parts[0].Clipped {
		t.Errorf("long user message = %+v", entries)
	}
	if entries, _ := parseCodex(codexLongItem("AgentMessage", "content", big)); len(entries) != 1 || entries[0].Role != "assistant" || entries[0].Parts[0].Kind != "text" {
		t.Errorf("long agent message = %+v", entries)
	}
	if entries, next := parseCodex(tail + cmd[:len(cmd)-1]); len(entries) != 1 || next != int64(len(tail)) {
		t.Errorf("incomplete long line = %d entries, next %d", len(entries), next)
	}
}

func TestCodexParseItems(t *testing.T) {
	failed := 2
	rows := []string{
		"not json\n",
		`{"type":"response_item","payload":{"type":"item_completed","note":"event_msg"}}` + "\n",
		`{"type":"event_msg","payload":{"type":"item_completed"}}` + "\n",
		`{"type":"response_item","payload":{"type":"item_completed"}}` + "\n",
		codexEvent(map[string]any{"type": "token_count", "info": "agent_message"}),
		codexItemRow(map[string]any{"type": "UserMessage", "content": []any{
			map[string]any{"type": "text", "text": " "},
			map[string]any{"type": "image"},
			map[string]any{"type": "local_image"},
		}}),
		codexItemRow(map[string]any{"type": "Reasoning", "summary_text": []any{"one", "two"}}),
		codexItemRow(map[string]any{"type": "Reasoning", "summary_text": []any{}}),
		codexItemRow(map[string]any{"type": "CommandExecution", "command": []any{"git", "status"}, "aggregated_output": "\x1b[31mx\x1b[0m", "exit_code": failed, "status": "completed"}),
		codexItemRow(map[string]any{"type": "CommandExecution", "command": "ls -la", "status": "failed"}),
		codexItemRow(map[string]any{"type": "CommandExecution", "aggregated_output": strings.Repeat("a", claudeMaxResult+5)}),
		codexItemRow(map[string]any{"type": "FileChange", "status": "failed", "changes": map[string]any{
			"/p/gone.txt": map[string]any{"type": "delete", "content": "x\ny\n"},
			"/p/old.txt":  map[string]any{"type": "update", "move_path": "/p/new.txt"},
		}}),
		codexItemRow(map[string]any{"type": "McpToolCall", "server": "docs", "tool": "search", "arguments": map[string]any{"query": "go"},
			"result": map[string]any{"content": []any{map[string]any{"type": "text", "text": "found"}}, "isError": true}, "status": "completed"}),
		codexItemRow(map[string]any{"type": "McpToolCall", "status": "failed"}),
		codexItemRow(map[string]any{"type": "McpToolCall", "server": "fs", "result": map[string]any{"content": "denied", "is_error": true}}),
		codexItemRow(map[string]any{"type": "McpToolCall", "tool": "t", "result": "unexpected"}),
		codexItemRow(map[string]any{"type": "Extension", "kind": "web_search", "query": "termote"}),
		codexItemRow(map[string]any{"type": "Extension"}),
		codexItemRow(map[string]any{"type": "ContextCompaction"}),
		codexItemRow(map[string]any{"type": "SomethingNew"}),
		codexEvent(map[string]any{"type": "user_message", "message": "legacy question"}),
		codexEvent(map[string]any{"type": "agent_message", "message": "legacy answer"}),
		codexEvent(map[string]any{"type": "agent_message", "message": " "}),
	}
	entries, _ := parseCodex(strings.Join(rows, ""))
	var parts []TranscriptPart
	var roles []string
	for _, e := range entries {
		for _, p := range e.Parts {
			parts = append(parts, p)
			roles = append(roles, e.Role)
		}
	}
	check := func(i int, role string, ok func(TranscriptPart) bool) {
		t.Helper()
		if i >= len(parts) || roles[i] != role || !ok(parts[i]) {
			if i < len(parts) {
				t.Errorf("part %d = %s %+v", i, roles[i], parts[i])
			} else {
				t.Errorf("part %d missing", i)
			}
		}
	}
	check(0, "user", func(p TranscriptPart) bool { return p.Kind == "image" })
	check(1, "user", func(p TranscriptPart) bool { return p.Kind == "image" })
	check(2, "assistant", func(p TranscriptPart) bool { return p.Kind == "thinking" && p.Text == "one\n\ntwo" })
	check(3, "assistant", func(p TranscriptPart) bool {
		return p.Input == "git status" && p.Result == "x" && p.IsError && p.Detail.Command == "git status"
	})
	check(4, "assistant", func(p TranscriptPart) bool { return p.Input == "ls -la" && p.IsError })
	check(5, "assistant", func(p TranscriptPart) bool {
		return p.Clipped && len(p.Result) == claudeMaxResult && !p.IsError && p.Detail == nil
	})
	check(6, "assistant", func(p TranscriptPart) bool {
		return p.Tool == "Edit" && p.Input == "/p/gone.txt" && p.Result == "-x\n-y\n" && p.IsError
	})
	check(7, "assistant", func(p TranscriptPart) bool { return p.Input == "/p/old.txt → /p/new.txt" && p.Result == "" })
	check(8, "assistant", func(p TranscriptPart) bool {
		return p.Tool == "docs.search" && p.Input == "go" && p.Result == "found" && p.IsError
	})
	check(9, "assistant", func(p TranscriptPart) bool { return p.Tool == "mcp" && p.IsError && p.Result == "" })
	check(10, "assistant", func(p TranscriptPart) bool { return p.Tool == "fs" && p.Result == "denied" && p.IsError })
	check(11, "assistant", func(p TranscriptPart) bool { return p.Tool == "t" && p.Result == "" && !p.IsError })
	check(12, "assistant", func(p TranscriptPart) bool { return p.Tool == "web_search" && p.Input == "termote" })
	check(13, "assistant", func(p TranscriptPart) bool { return p.Tool == "extension" })
	check(14, "summary", func(p TranscriptPart) bool { return p.Text == "Context compacted" })
	check(15, "user", func(p TranscriptPart) bool { return p.Text == "legacy question" })
	check(16, "assistant", func(p TranscriptPart) bool { return p.Text == "legacy answer" })
	if len(parts) != 17 {
		t.Errorf("got %d parts: %+v", len(parts), parts)
	}
}

// The TurnItem variants of codex-rs/protocol (rust-v0.163.0) beyond the
// first set, turn_aborted and thread_rolled_back.
func TestCodexParseMoreItems(t *testing.T) {
	no := false
	rows := []string{
		codexItemRow(map[string]any{"type": "ImageView", "id": "v1", "path": "file:///tmp/shot.png"}),
		codexItemRow(map[string]any{"type": "WebSearch", "query": "go 1.26", "action": map[string]any{"type": "search"}}),
		codexItemRow(map[string]any{"type": "ImageGeneration", "status": "completed", "revised_prompt": "a cat", "result": "iVBOR", "saved_path": "/tmp/cat.png"}),
		codexItemRow(map[string]any{"type": "ImageGeneration", "status": "failed"}),
		codexItemRow(map[string]any{"type": "FunctionCallOutput", "name": "apply", "namespace": "ns", "output": "done"}),
		codexItemRow(map[string]any{"type": "FunctionCallOutput", "output": []any{map[string]any{"type": "input_text", "text": "a"}, map[string]any{"type": "input_image"}}}),
		codexItemRow(map[string]any{"type": "DynamicToolCall", "tool": "lookup", "arguments": map[string]any{"q": "x"}, "status": "completed",
			"content_items": []any{map[string]any{"type": "inputText", "text": "hit"}}, "success": no, "error": "denied"}),
		codexItemRow(map[string]any{"type": "CollabAgentToolCall", "tool": "spawn_agent", "status": "completed", "prompt": "check the tests"}),
		codexItemRow(map[string]any{"type": "CollabAgentToolCall", "tool": "wait", "status": "failed", "receiver_agents": []any{
			map[string]any{"thread_id": "a", "agent_nickname": "Ada"}, map[string]any{"thread_id": "b", "agent_role": "reviewer"}, map[string]any{"thread_id": "c"},
		}}),
		codexItemRow(map[string]any{"type": "CollabAgentToolCall"}),
		codexItemRow(map[string]any{"type": "SubAgentActivity", "kind": "started", "agent_path": "/root/reviewer"}),
		codexItemRow(map[string]any{"type": "HookPrompt", "fragments": []any{map[string]any{"text": "run lint"}, map[string]any{"text": " "}}}),
		codexItemRow(map[string]any{"type": "HookPrompt", "fragments": []any{}}),
		codexItemRow(map[string]any{"type": "Plan", "text": "1. read\n2. fix"}),
		codexItemRow(map[string]any{"type": "Plan", "text": " "}),
		codexItemRow(map[string]any{"type": "EnteredReviewMode", "user_facing_hint": "current changes"}),
		codexItemRow(map[string]any{"type": "ExitedReviewMode", "review_output": map[string]any{
			"overall_correctness": "patch is incorrect", "overall_explanation": "One bug.",
			"findings": []any{map[string]any{"title": "Off by one", "body": "i <= n", "priority": 1}},
		}}),
		codexItemRow(map[string]any{"type": "ExitedReviewMode"}),
		codexEvent(map[string]any{"type": "turn_aborted", "reason": "interrupted"}),
		codexEvent(map[string]any{"type": "turn_aborted", "reason": "budget_limited"}),
		codexEvent(map[string]any{"type": "thread_rolled_back", "num_turns": 2}),
		codexEvent(map[string]any{"type": "thread_rolled_back", "num_turns": 1}),
	}
	entries, _ := parseCodex(strings.Join(rows, ""))
	type want struct{ role, tool, input, text, result string }
	wants := []want{
		{"assistant", "ViewImage", "/tmp/shot.png", "", ""},
		{"assistant", "WebSearch", "go 1.26", "", ""},
		{"assistant", "ImageGeneration", "a cat", "", "/tmp/cat.png"},
		{"assistant", "ImageGeneration", "", "", ""},
		{"assistant", "ns.apply", "", "", "done"},
		{"assistant", "tool", "", "", "a"},
		{"assistant", "lookup", "x", "", "hit\ndenied"},
		{"assistant", "Agent spawn_agent", "check the tests", "", ""},
		{"assistant", "Agent wait", "Ada, reviewer", "", ""},
		{"assistant", "Agent call", "", "", ""},
		{"note", "", "", "Subagent /root/reviewer started", ""},
		{"note", "", "", "Hook: run lint", ""},
		{"assistant", "", "", "1. read\n2. fix", ""},
		{"note", "", "", "Review started current changes", ""},
		{"assistant", "", "", "patch is incorrect\n\nOne bug.\n\n[P1] Off by one\ni <= n", ""},
		{"note", "", "", "Interrupted", ""},
		{"note", "", "", "Turn ended: budget limited", ""},
		{"note", "", "", "Rolled back 2 turns", ""},
		{"note", "", "", "Rolled back 1 turn", ""},
	}
	if len(entries) != len(wants) {
		t.Fatalf("got %d entries: %+v", len(entries), entries)
	}
	for i, w := range wants {
		e := entries[i]
		p := e.Parts[0]
		if e.Role != w.role || p.Tool != w.tool || p.Input != w.input || p.Text != w.text || p.Result != w.result {
			t.Errorf("entry %d = %s %+v, want %+v", i, e.Role, p, w)
		}
	}
	if !entries[3].Parts[0].IsError || !entries[6].Parts[0].IsError || !entries[8].Parts[0].IsError || entries[4].Parts[0].IsError {
		t.Error("error flags wrong")
	}
	for _, typ := range codexItemTypes {
		if _, recognised, _ := parseCodexRow([]byte(codexItemRow(map[string]any{"type": typ})), 0); !recognised {
			t.Errorf("%s listed but not read", typ)
		}
	}
}

// A legacy-mode rollout (Codex 0.147) writes events in place of items.
func TestCodexParseLegacyEvents(t *testing.T) {
	rows := []string{
		codexEvent(map[string]any{"type": "agent_reasoning", "text": "thinking"}),
		codexEvent(map[string]any{"type": "patch_apply_end", "call_id": "c1", "success": true, "status": "completed",
			"changes": map[string]any{"/p/a.md": map[string]any{"type": "add", "content": "hi\n"}}}),
		codexEvent(map[string]any{"type": "patch_apply_end", "call_id": "c2", "status": "declined",
			"changes": map[string]any{"/p/b.md": map[string]any{"type": "delete", "content": "x\n"}}}),
		codexEvent(map[string]any{"type": "mcp_tool_call_end", "call_id": "c3",
			"invocation": map[string]any{"server": "docs", "tool": "search", "arguments": map[string]any{"query": "go"}},
			"result":     map[string]any{"Ok": map[string]any{"content": []any{map[string]any{"type": "text", "text": "found"}}}}}),
		codexEvent(map[string]any{"type": "mcp_tool_call_end", "invocation": map[string]any{"server": "fs", "tool": "read"},
			"result": map[string]any{"Err": "timed out"}}),
		codexEvent(map[string]any{"type": "web_search_end", "call_id": "c4", "query": "termote"}),
		codexEvent(map[string]any{"type": "context_compacted"}),
		codexEvent(map[string]any{"type": "entered_review_mode", "user_facing_hint": "main"}),
		codexEvent(map[string]any{"type": "sub_agent_activity", "kind": "interacted", "agent_path": "/root/a"}),
		codexEvent(map[string]any{"type": "thread_goal_updated", "goal": map[string]any{}}),
		`{"type":"event_msg","payload":{"type":"agent_reasoning","text":1}}` + "\n",
	}
	entries, _ := parseCodex(strings.Join(rows, ""))
	if len(entries) != 9 {
		t.Fatalf("got %d entries: %+v", len(entries), entries)
	}
	if p := entries[0].Parts[0]; p.Kind != "thinking" || p.Text != "thinking" {
		t.Errorf("reasoning = %+v", p)
	}
	if e := entries[1]; e.ID != "c1" || e.Parts[0].Tool != "Edit" || e.Parts[0].Input != "/p/a.md" || e.Parts[0].Result != "+hi\n" || e.Parts[0].IsError {
		t.Errorf("patch = %+v", e)
	}
	if p := entries[2].Parts[0]; !p.IsError {
		t.Errorf("declined patch = %+v", p)
	}
	if p := entries[3].Parts[0]; p.Tool != "docs.search" || p.Input != "go" || p.Result != "found" || p.IsError {
		t.Errorf("mcp ok = %+v", p)
	}
	if p := entries[4].Parts[0]; p.Tool != "fs.read" || p.Result != "timed out" || !p.IsError {
		t.Errorf("mcp err = %+v", p)
	}
	if p := entries[5].Parts[0]; p.Tool != "WebSearch" || p.Input != "termote" {
		t.Errorf("web search = %+v", p)
	}
	if entries[6].Role != "summary" || entries[7].Parts[0].Text != "Review started main" || entries[8].Parts[0].Text != "Subagent /root/a interacted" {
		t.Errorf("notes = %+v", entries[6:])
	}
}

// TestCodexRolloutItems reads real rollouts and fails on an item type or an
// event type the parser neither reads nor knowingly skips. It runs only with
// TERMOTE_CODEX_SESSIONS set to a Codex sessions directory, for example
// after a Codex update: scripts/codex-chat-items.sh runs it.
func TestCodexRolloutItems(t *testing.T) {
	dir := os.Getenv("TERMOTE_CODEX_SESSIONS")
	if dir == "" {
		t.Skip("TERMOTE_CODEX_SESSIONS not set")
	}
	// The events read, then those with nothing to show: read for the status
	// or the context, a goal change, and raw reasoning (only its summary is
	// shown).
	skipped := map[string]bool{
		"item_completed": true, "user_message": true, "agent_message": true, "turn_aborted": true, "thread_rolled_back": true,
		"token_count": true, "task_started": true, "task_complete": true, "thread_settings_applied": true,
		"thread_goal_updated": true, "agent_reasoning_raw_content": true,
	}
	for ev := range codexLegacyItems {
		skipped[ev] = true
	}
	known := map[string]bool{}
	for _, typ := range codexItemTypes {
		known[typ] = true
	}
	unknown := map[string]int{}
	var rows int
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(path) != ".jsonl" {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		codexJournal{}.Parse(strings.NewReader(string(data)), 0) // must not panic on a real rollout
		for _, line := range strings.Split(string(data), "\n") {
			var row codexRow
			if json.Unmarshal([]byte(line), &row) != nil || row.Type != "event_msg" {
				continue
			}
			rows++
			switch {
			case !skipped[row.Payload.Type]:
				unknown["event "+row.Payload.Type]++
			case row.Payload.Item != nil && !known[row.Payload.Item.Type]:
				unknown["item "+row.Payload.Item.Type]++
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%d event rows read", rows)
	for what, n := range unknown {
		t.Errorf("%s in %d rows: read it in parseCodexRow or skip it here", what, n)
	}
}

func TestCodexParseUnsupportedFormat(t *testing.T) {
	started := codexEvent(map[string]any{"type": "task_started", "turn_id": "t1"})
	done := codexEvent(map[string]any{"type": "task_complete", "turn_id": "t1"})
	unknown := codexEvent(map[string]any{"type": "turn_item", "item": "?"})
	turn := started + unknown + done
	entries, _ := parseCodex(turn + turn)
	if len(entries) != 1 || entries[0].Role != "note" || entries[0].Parts[0].Text != "unsupported history format" ||
		entries[0].off != 0 || entries[0].ID != "unsupported-0" {
		t.Fatalf("unknown format = %+v", entries)
	}
	// A forward read that starts after the turn's rows (the last message was
	// read by the previous poll, task_complete arrives later): no note.
	answer := codexItemRow(map[string]any{"type": "AgentMessage", "content": []any{map[string]any{"type": "text", "text": "ok"}}})
	cursorRead := done + codexEvent(map[string]any{"type": "thread_settings_applied"})
	if entries, _ := (codexJournal{}).Parse(strings.NewReader(cursorRead), int64(len(started+answer))); len(entries) != 0 {
		t.Errorf("turn cut by the range start = %+v", entries)
	}
	// A turn of only an item type the parser does not know is not readable.
	newItem := codexItemRow(map[string]any{"type": "SomethingNew"})
	if entries, _ := parseCodex(started + newItem + done); len(entries) != 1 || entries[0].Role != "note" {
		t.Errorf("unknown item type = %+v", entries)
	}
	// An unfinished turn, a turn with a known row that shows nothing, and a
	// turn with a known row too long to decode: no note.
	if entries, _ := parseCodex(started + unknown); len(entries) != 0 {
		t.Errorf("unfinished turn = %+v", entries)
	}
	empty := codexItemRow(map[string]any{"type": "Reasoning"})
	if entries, _ := parseCodex(started + empty + done); len(entries) != 0 {
		t.Errorf("known empty row = %+v", entries)
	}
	long := codexLongItem("Reasoning", "x", strings.Repeat("r", agentMaxLine))
	if entries, _ := parseCodex(started + long + done); len(entries) != 1 || entries[0].Role != "assistant" {
		t.Errorf("long known row = %+v", entries)
	}
}

func TestCodexAgentName(t *testing.T) {
	if (codexJournal{}).Agent() != "codex" || journalAdapters["codex"] == nil {
		t.Error("codex adapter not registered")
	}
}

func TestCodexCommand(t *testing.T) {
	for _, c := range []struct {
		in   any
		want string
	}{
		{[]any{"/bin/bash", "-c", "echo hi"}, "echo hi"},
		{[]any{"/usr/bin/zsh", "-lc", "ls"}, "ls"},
		{[]any{"rg", 3.0, "x"}, "rg x"},
		{"pwd", "pwd"},
		{nil, ""},
	} {
		if got := codexCommand(c.in); got != c.want {
			t.Errorf("codexCommand(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

// writeRollout creates <home>/sessions/2026/10/02/rollout-...-<id>.jsonl.
func writeRollout(t *testing.T, home, id, content string) string {
	t.Helper()
	dir := filepath.Join(home, "sessions", "2026", "10", "02")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "rollout-2026-10-02T08-36-50-"+id+".jsonl")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCodexLocate(t *testing.T) {
	home := t.TempDir()
	p := writeRollout(t, home, testCodexID, "")
	real, _ := filepath.EvalSymlinks(p)
	ok := AgentSession{Agent: "codex", ID: testCodexID, CodexHome: home, Rollout: p}
	if got, err := (codexJournal{}).Locate(ok); err != nil || got != real {
		t.Fatalf("Locate = %q, %v", got, err)
	}

	outside := filepath.Join(t.TempDir(), "rollout-2026-10-02T08-36-50-"+testCodexID+".jsonl")
	os.WriteFile(outside, nil, 0o600)
	link := filepath.Join(filepath.Dir(p), "rollout-2026-10-02T09-00-00-"+testCodexID+".jsonl")
	// Symlinks need a privilege on Windows: the other cases still run.
	hasLink := true
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS != "windows" {
			t.Fatal(err)
		}
		hasLink = false
	}
	other := "01a0fbc6-978c-74a1-aeae-d34f439bfce2"
	otherPath := writeRollout(t, home, other, "")
	dirPath := filepath.Join(filepath.Dir(p), "rollout-2026-10-02T10-00-00-"+testCodexID+".jsonl")
	os.Mkdir(dirPath, 0o700)
	misnamed := filepath.Join(filepath.Dir(p), testCodexID+".jsonl")
	os.WriteFile(misnamed, nil, 0o600)
	noSessions := t.TempDir()

	for name, s := range map[string]AgentSession{
		"symlink outside sessions": {ID: testCodexID, CodexHome: home, Rollout: link},
		"file outside sessions":    {ID: testCodexID, CodexHome: home, Rollout: outside},
		"another session's file":   {ID: testCodexID, CodexHome: home, Rollout: otherPath},
		"not a rollout name":       {ID: testCodexID, CodexHome: home, Rollout: misnamed},
		"directory":                {ID: testCodexID, CodexHome: home, Rollout: dirPath},
		"missing file":             {ID: testCodexID, CodexHome: home, Rollout: p + ".gone"},
		"empty rollout":            {ID: testCodexID, CodexHome: home},
		"relative rollout":         {ID: testCodexID, CodexHome: home, Rollout: "rollout-x-" + testCodexID + ".jsonl"},
		"id not a uuid":            {ID: "../" + testCodexID, CodexHome: home, Rollout: p},
		"empty home":               {ID: testCodexID, Rollout: p},
		"relative home":            {ID: testCodexID, CodexHome: "codex", Rollout: p},
		"home without sessions":    {ID: testCodexID, CodexHome: noSessions, Rollout: p},
	} {
		if s.Rollout == link && !hasLink {
			continue
		}
		if got, err := (codexJournal{}).Locate(s); err != errNoTranscript {
			t.Errorf("%s: Locate = %q, %v", name, got, err)
		}
	}
}

func TestCodexStatus(t *testing.T) {
	ev := func(typ string) string { return codexEvent(map[string]any{"type": typ, "turn_id": "t"}) }
	meta := `{"type":"session_meta","payload":{"id":"x"}}` + "\n"
	user := codexItemRow(map[string]any{"type": "UserMessage", "content": []any{map[string]any{"type": "text", "text": "task_complete"}}})
	// A line longer than a marker can be, mentioning one, in a long turn.
	bigOutput := codexLongItem("CommandExecution", "aggregated_output", strings.Repeat("task_complete ", 200_000))
	var many strings.Builder
	for many.Len() < 3*agentTailChunk {
		many.WriteString(user)
	}
	for name, c := range map[string]struct{ content, want string }{
		"empty":               {"", "unknown"},
		"no turn":             {meta, "unknown"},
		"no turn, no newline": {`{"type":"session_meta"}`, "unknown"},
		"turn running":        {meta + ev("task_started") + user, "working"},
		"turn done":           {meta + ev("task_started") + user + ev("task_complete"), "idle"},
		"turn aborted":        {meta + ev("task_started") + ev("turn_aborted"), "idle"},
		// Codex writes thread_settings_applied on a resume and on a model
		// change within a turn alike: the turn still counts as running.
		"killed turn then resumed": {meta + ev("task_started") + user + ev("thread_settings_applied"), "working"},
		"model changed in a turn":  {meta + ev("task_started") + user + ev("thread_settings_applied") + user, "working"},
		"model changed between":    {meta + ev("task_started") + ev("task_complete") + ev("thread_settings_applied"), "idle"},
		"next turn after resume":   {meta + ev("task_started") + ev("thread_settings_applied") + ev("task_started") + user, "working"},
		"marker being written":     {meta + ev("task_started") + `{"type":"event_msg","payload":{"type":"task_comp`, "working"},
		"long turn":                {meta + ev("task_started") + many.String() + bigOutput + many.String(), "working"},
		"long line at the end":     {meta + ev("task_complete") + bigOutput + `{"type":"event_msg"`, "idle"},
		"long line at the start":   {bigOutput + many.String(), "unknown"},
		"long unfinished line":     {meta + ev("task_started") + strings.TrimSuffix(bigOutput, "\n"), "working"},
	} {
		home := t.TempDir()
		p := writeRollout(t, home, testCodexID, c.content)
		if got := codexStatus(p); got != c.want {
			t.Errorf("%s: codexStatus = %q, want %q", name, got, c.want)
		}
	}
	if got := codexStatus(filepath.Join(t.TempDir(), "missing")); got != "unknown" {
		t.Errorf("missing file = %q", got)
	}
	if got := codexStatus(t.TempDir()); got != "unknown" {
		t.Errorf("directory = %q", got)
	}
}

func TestCodexLatestMarkerShortRead(t *testing.T) {
	content := codexEvent(map[string]any{"type": "task_started"})
	if got, found, end := codexLatestMarker(strings.NewReader(content), 0, int64(len(content))+10); got != "unknown" || found || end != 0 {
		t.Errorf("short read = %q, %v, %d", got, found, end)
	}
	// A line that names event_msg without being one is not a marker.
	for _, l := range []string{`{"type":"response_item","payload":{"type":"task_started","x":"event_msg"}}`, `"event_msg" task_started {`} {
		if s, ok := codexMarker([]byte(l)); ok {
			t.Errorf("codexMarker(%s) = %q", l, s)
		}
	}
}

func TestCodexStatusReadsOnlyNewRows(t *testing.T) {
	ev := func(typ string) string { return codexEvent(map[string]any{"type": typ, "turn_id": "t"}) }
	item := codexItemRow(map[string]any{"type": "AgentMessage", "content": []any{map[string]any{"type": "text", "text": "x"}}})
	p := writeRollout(t, t.TempDir(), testCodexID, ev("task_started")+item)
	if got := codexStatus(p); got != "working" {
		t.Fatalf("start = %q", got)
	}
	// Rows without a marker keep the status found before; a marker half
	// written is read once it is complete.
	full := ev("task_complete")
	appendFile(t, p, item+full[:15])
	if got := codexStatus(p); got != "working" {
		t.Errorf("no new marker = %q", got)
	}
	appendFile(t, p, full[15:])
	if got := codexStatus(p); got != "idle" {
		t.Errorf("turn done = %q", got)
	}
	appendFile(t, p, item)
	if got := codexStatus(p); got != "idle" {
		t.Errorf("after the turn = %q", got)
	}
	fi := mustStat(t, p)
	codexScans.Lock()
	scan := codexScans.m[p+"\x00"+rolloutIdentity(p, nil, fi)]
	codexScans.Unlock()
	if scan.end != fi.Size() || scan.status != "idle" {
		t.Errorf("remembered scan = %+v, size %d", scan, fi.Size())
	}
	// A file that shrank is read again from the start.
	os.WriteFile(p, []byte(ev("task_started")), 0o600)
	if got := codexStatus(p); got != "working" {
		t.Errorf("shrunk file = %q", got)
	}
	// The memory is bounded.
	codexScans.Lock()
	for i := len(codexScans.m); i < codexScansMax; i++ {
		codexScans.m[strings.Repeat("k", i)] = codexScan{}
	}
	codexScans.Unlock()
	codexStatus(p)
	codexScans.Lock()
	n := len(codexScans.m)
	codexScans.Unlock()
	if n != 1 {
		t.Errorf("cache holds %d entries after the cap", n)
	}
}

func TestReadTranscriptCodex(t *testing.T) {
	home := t.TempDir()
	row := func(text string) string {
		return codexItemRow(map[string]any{"type": "AgentMessage", "id": text, "content": []any{map[string]any{"type": "text", "text": text}}})
	}
	p := writeRollout(t, home, testCodexID, row("one")+row("two"))
	id := rolloutIdentity(p, nil, mustStat(t, p))
	s := AgentSession{Agent: "codex", ID: testCodexID, CodexHome: home, Rollout: p, RolloutID: id, Status: "working"}
	first, err := readTranscript(s, "", "")
	if err != nil || !first.Reset || strings.Join(texts(first.Entries), ",") != "one,two" || first.Status != "working" || first.Agent != "codex" {
		t.Fatalf("first = %+v, %v", first, err)
	}
	appendFile(t, p, row("three"))
	next, err := readTranscript(s, first.Cursor, "")
	if err != nil || next.Reset || strings.Join(texts(next.Entries), ",") != "three" {
		t.Fatalf("next = %+v, %v", next, err)
	}
	if id == "" {
		// Without device and inode (Windows) the cursor carries the file
		// name, so a new rollout of the same session starts over.
		c, _ := decodeCursor(next.Cursor)
		if c.File != filepath.Base(p) {
			t.Errorf("cursor file = %q", c.File)
		}
		other := filepath.Join(filepath.Dir(p), "rollout-2026-10-02T11-00-00-"+testCodexID+".jsonl")
		os.WriteFile(other, []byte(row("one")+row("two")+row("three")), 0o600)
		s.Rollout = other
		if r, err := readTranscript(s, next.Cursor, ""); err != nil || !r.Reset {
			t.Errorf("new rollout of the same session = %+v, %v", r, err)
		}
		return
	}
	// The file at the path is no longer the one the locator saw open.
	tmp := p + ".new"
	os.WriteFile(tmp, []byte(row("forged")), 0o600)
	os.Rename(tmp, p)
	if _, err := readTranscript(s, next.Cursor, ""); err != errNoTranscript {
		t.Errorf("replaced rollout = %v", err)
	}
}

// A Codex edit of a sensitive file, or a move onto one, shows its diff to no
// view-only client, as a Claude Code edit of the same file does not.
func TestCodexFileChangeOnSensitiveFileHidden(t *testing.T) {
	entries, _ := parseCodex(codexItemRow(map[string]any{"type": "FileChange", "id": "c1", "status": "completed", "changes": map[string]any{
		"/p/.env":    map[string]any{"type": "update", "unified_diff": "-KEY=old\n+KEY=new\n"},
		"/p/a.txt":   map[string]any{"type": "update", "unified_diff": "-a\n+b\n"},
		"/p/key.txt": map[string]any{"type": "update", "move_path": "/p/.ssh/id_ed25519", "unified_diff": "-k\n+k2\n"},
	}}))
	if len(entries) != 1 || len(entries[0].Parts) != 3 {
		t.Fatalf("entries = %+v", entries)
	}
	res := hideSensitiveResults(transcriptResponse{Entries: entries}, func(string) bool { return false })
	want := map[string]bool{"/p/.env": true, "/p/a.txt": false, "/p/key.txt → /p/.ssh/id_ed25519": true}
	for _, p := range res.Entries[0].Parts {
		hidden, ok := want[p.Input]
		if !ok {
			t.Fatalf("unexpected part %+v", p)
		}
		if hidden != (p.Result == "" && p.Detail != nil && p.Detail.Hidden) {
			t.Errorf("%s: result %q, detail %+v; want hidden %v", p.Input, p.Result, p.Detail, hidden)
		}
	}
	if entries[0].Parts[0].Result == "" {
		t.Error("the cached entries were changed")
	}
}
