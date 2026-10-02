package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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
	check(3, "assistant", func(p TranscriptPart) bool { return p.Input == "git status" && p.Result == "x" && p.IsError })
	check(4, "assistant", func(p TranscriptPart) bool { return p.Input == "ls -la" && p.IsError })
	check(5, "assistant", func(p TranscriptPart) bool { return p.Clipped && len(p.Result) == claudeMaxResult && !p.IsError })
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
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
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
		"empty":                    {"", "unknown"},
		"no turn":                  {meta, "unknown"},
		"no turn, no newline":      {`{"type":"session_meta"}`, "unknown"},
		"turn running":             {meta + ev("task_started") + user, "working"},
		"turn done":                {meta + ev("task_started") + user + ev("task_complete"), "idle"},
		"turn aborted":             {meta + ev("task_started") + ev("turn_aborted"), "idle"},
		"killed turn then resumed": {meta + ev("task_started") + user + ev("thread_settings_applied"), "idle"},
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
	scan := codexScans.m[p+"\x00"+fileIdentity(fi)]
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
	id := fileIdentity(mustStat(t, p))
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
