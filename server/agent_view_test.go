package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// getTranscriptAs reads the pane's transcript through the route as a
// view-only client or a full one, returning the decoded reply and its body.
func getTranscriptAs(t *testing.T, h http.Handler, view bool) (transcriptResponse, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/mux/panes/1/agent/transcript", nil)
	if view {
		req.Header.Set(viewDeviceHeader, "d1")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var res transcriptResponse
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil {
		t.Fatalf("GET (view %v) = %d %s", view, rec.Code, rec.Body)
	}
	return res, rec.Body.Bytes()
}

// checkTextOnly fails unless every part of res is the user's or the agent's
// words (text, thinking) or an image, with no tool input, result or detail,
// no entry is left empty, and none of the secrets appears in body.
func checkTextOnly(t *testing.T, res transcriptResponse, body []byte, secrets ...string) {
	t.Helper()
	for _, e := range res.Entries {
		if len(e.Parts) == 0 {
			t.Errorf("view entry %s has no part", e.ID)
		}
		for _, p := range e.Parts {
			if p.Kind != "text" && p.Kind != "thinking" && p.Kind != "image" {
				t.Errorf("view entry %s has a %s part: %+v", e.ID, p.Kind, p)
			}
			if p.Tool != "" || p.ToolID != "" || p.Input != "" || p.Result != "" || p.Detail != nil || p.Orphan {
				t.Errorf("view entry %s carries a tool field: %+v", e.ID, p)
			}
		}
	}
	for _, s := range secrets {
		if bytes.Contains(body, []byte(s)) {
			t.Errorf("view reply holds %q: %s", s, body)
		}
	}
}

// textParts lists the text of every text part, in order.
func textParts(es []TranscriptEntry) []string {
	var out []string
	for _, e := range es {
		for _, p := range e.Parts {
			if p.Kind == "text" {
				out = append(out, p.Text)
			}
		}
	}
	return out
}

// fullUnchanged fails unless a full client's reply holds exactly the entries
// readTranscript parses, read after the view client's reply from the same
// cached read.
func fullUnchanged(t *testing.T, s AgentSession, full transcriptResponse) {
	t.Helper()
	want, err := readTranscript(s, "", "")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(full.Entries)
	exp, _ := json.Marshal(want.Entries)
	if !bytes.Equal(got, exp) {
		t.Errorf("full entries changed:\n got %s\nwant %s", got, exp)
	}
}

// A view-only client reads a Claude Code transcript as text only: no call,
// result or detail of any tool, whichever file it names (a symlink to .env
// under an innocent name, a Grep over the repository, an edit, a result whose
// call lies before the read), no output of a command the user ran with `!`,
// and of a compaction summary (which quotes what tools read) only that it
// happened. A full client's reply is unchanged.
func TestTranscriptRouteGivesViewTextOnlyClaude(t *testing.T) {
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, ".env"), []byte("SECRET=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A symlink needs a privilege on Windows: the Read then names a plain
	// file, which is still left out.
	notes := filepath.Join(repo, "notes.txt")
	if err := os.Symlink(filepath.Join(repo, ".env"), notes); err != nil {
		writeFile(t, notes, "SECRET=1\n")
	}
	dir := t.TempDir()
	call, _ := json.Marshal(map[string]any{"type": "assistant", "uuid": "a", "message": map[string]any{"content": []any{
		map[string]any{"type": "thinking", "thinking": "Let me look."},
		map[string]any{"type": "text", "text": "Reading the notes."},
		map[string]any{"type": "tool_use", "id": "t1", "name": "Read", "input": map[string]any{"file_path": notes}},
		map[string]any{"type": "tool_use", "id": "t2", "name": "Grep", "input": map[string]any{"pattern": "SECRET", "path": repo, "glob": "*.txt"}},
		map[string]any{"type": "tool_use", "id": "t3", "name": "Edit", "input": map[string]any{"file_path": filepath.Join(repo, "a.go"), "old_string": "SECRET_OLD", "new_string": "SECRET_NEW"}},
		map[string]any{"type": "tool_use", "id": "t4", "name": "Bash", "input": map[string]any{"command": "cat .env # SECRET_CMD", "description": "Show SECRET_DESC"}},
	}}})
	results := `{"type":"user","uuid":"b","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"SECRET=1"},{"type":"tool_result","tool_use_id":"t2","content":"notes.txt:SECRET=1"},{"type":"tool_result","tool_use_id":"t3","content":"ok"},{"type":"tool_result","tool_use_id":"t4","content":"SECRET=1"}]}}
{"type":"user","uuid":"c","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":"SECRET_ORPHAN"}]}}
{"type":"user","uuid":"d","message":{"content":"thanks"}}
{"type":"user","uuid":"f","message":{"content":"<bash-input>cat .env</bash-input>"}}
{"type":"user","uuid":"g","message":{"content":"<bash-stdout>SECRET_BASH=1</bash-stdout><bash-stderr></bash-stderr>"}}
{"type":"user","uuid":"h","isCompactSummary":true,"message":{"content":"This session is being continued. The agent read .env: SECRET_SUMMARY=1"}}
{"type":"assistant","uuid":"e","message":{"content":[{"type":"text","text":"Done."}]}}
`
	writeTranscript(t, dir, testSessionID, string(call)+"\n"+results)
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}
	loc := &fakeLocator{s: s, found: true}
	mux := http.NewServeMux()
	registerMuxRoutes(mux, loc, newStreamTokenStore(), nil, nil)
	h := asRole(mux, false)

	view, body := getTranscriptAs(t, h, true)
	checkTextOnly(t, view, body, "SECRET", notes, "*.txt")
	if got := strings.Join(textParts(view.Entries), ","); got != "Reading the notes.,thanks,! cat .env,"+compactedText+",Done." {
		t.Errorf("view texts = %q", got)
	}
	if p := view.Entries[0].Parts[0]; p.Kind != "thinking" || p.Text != "Let me look." {
		t.Errorf("view thinking = %+v", p)
	}
	if e := view.Entries[len(view.Entries)-2]; e.Role != "summary" || len(e.Parts) != 1 || e.Parts[0].Text != compactedText {
		t.Errorf("view summary = %+v", e)
	}
	full, fullBody := getTranscriptAs(t, h, false)
	if !bytes.Contains(fullBody, []byte("SECRET_ORPHAN")) || !bytes.Contains(fullBody, []byte("SECRET_NEW")) ||
		!bytes.Contains(fullBody, []byte("SECRET_BASH")) || !bytes.Contains(fullBody, []byte("SECRET_SUMMARY")) {
		t.Errorf("full reply lost a tool result or an edit: %s", fullBody)
	}
	fullUnchanged(t, s, full)
	if n := loc.calls.Load(); n != 1 {
		t.Errorf("reads made %d lookups, want 1 (one cached read)", n)
	}
}

// A view-only client reads a Codex rollout as text only, whatever form a
// tool's arguments take: an object, a JSON string, an array of paths. A full
// client's reply is unchanged.
func TestTranscriptRouteGivesViewTextOnlyCodex(t *testing.T) {
	home := t.TempDir()
	msg := func(typ, id, text string) string {
		return codexItemRow(map[string]any{"type": typ, "id": id, "content": []any{map[string]any{"type": "text", "text": text}}})
	}
	rows := msg("UserMessage", "u1", "read the env") +
		codexItemRow(map[string]any{"type": "Reasoning", "id": "r1", "text": "Reading it."}) +
		codexItemRow(map[string]any{"type": "McpToolCall", "id": "m1", "server": "fs", "tool": "read_multiple_files", "status": "completed",
			"arguments": map[string]any{"paths": []any{"/p/a.txt", "/p/.env"}}, "result": map[string]any{"content": "SECRET_MCP"}}) +
		codexItemRow(map[string]any{"type": "FunctionCallOutput", "id": "f1", "name": "read", "status": "completed",
			"arguments": `{"path":"/p/.env"}`, "output": "SECRET_FN"}) +
		codexItemRow(map[string]any{"type": "DynamicToolCall", "id": "d1", "tool": "nb", "status": "completed",
			"arguments": map[string]any{"notebook_path": "/p/notes.ipynb"}, "output": "SECRET_DYN"}) +
		codexItemRow(map[string]any{"type": "CommandExecution", "id": "c1", "command": "cat .env", "status": "completed",
			"aggregated_output": "SECRET_CMD"}) +
		codexItemRow(map[string]any{"type": "FileChange", "id": "e1", "status": "completed", "changes": map[string]any{
			"/p/a.txt": map[string]any{"type": "update", "unified_diff": "-a\n+SECRET_DIFF\n"}}}) +
		msg("AgentMessage", "a1", "Done.")
	p := writeRollout(t, home, testCodexID, rows)
	s := AgentSession{Agent: "codex", ID: testCodexID, CodexHome: home, Rollout: p, RolloutID: rolloutIdentity(p, nil, mustStat(t, p))}
	loc := &fakeLocator{s: s, found: true}
	mux := http.NewServeMux()
	registerMuxRoutes(mux, loc, newStreamTokenStore(), nil, nil)
	h := asRole(mux, false)

	view, body := getTranscriptAs(t, h, true)
	checkTextOnly(t, view, body, "SECRET", "/p/", "cat .env")
	if got := strings.Join(textParts(view.Entries), ","); got != "read the env,Done." {
		t.Errorf("view texts = %q", got)
	}
	full, fullBody := getTranscriptAs(t, h, false)
	for _, s := range []string{"SECRET_MCP", "SECRET_FN", "SECRET_DYN", "SECRET_CMD", "SECRET_DIFF"} {
		if !bytes.Contains(fullBody, []byte(s)) {
			t.Errorf("full reply lost %s: %s", s, fullBody)
		}
	}
	fullUnchanged(t, s, full)
}

// The view filter copies what it changes: the cached read every client
// shares keeps its tool parts.
func TestViewTranscriptLeavesTheSharedReadAlone(t *testing.T) {
	entries := []TranscriptEntry{
		{ID: "a", Role: "assistant", Parts: []TranscriptPart{{Kind: "text", Text: "hi"}, {Kind: "tool", Tool: "Read", ToolID: "t1", Input: "x", Result: "r"}}},
		{ID: "b", Role: "user", Parts: []TranscriptPart{{Kind: "tool", Tool: "result", ToolID: "t1", Orphan: true, Result: "r"}}},
		{ID: "c", Role: "user", Parts: []TranscriptPart{{Kind: "image", Image: "ref"}}},
	}
	res := viewTranscript(transcriptResponse{Entries: entries, Cursor: "k"})
	if len(res.Entries) != 2 || len(res.Entries[0].Parts) != 1 || res.Entries[1].Parts[0].Image != "ref" || res.Cursor != "k" {
		t.Errorf("view = %+v", res)
	}
	if len(entries) != 3 || len(entries[0].Parts) != 2 || entries[0].Parts[1].Result != "r" {
		t.Errorf("the shared entries were changed: %+v", entries)
	}
}
