package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const subagentTranscriptPath = "/api/mux/panes/p1/agent/subagents/"

// subagentTranscriptServer serves the agent routes for s, every transcript
// read again.
func subagentTranscriptServer(t *testing.T, s AgentSession) *http.ServeMux {
	t.Helper()
	mux, a := subagentsServer(t, s)
	a.reads = newTTLCache[transcriptResponse](0)
	return mux
}

func serveSubagent(mux http.Handler, id string, q url.Values, edit func(*http.Request)) *httptest.ResponseRecorder {
	u := subagentTranscriptPath + id + "/transcript"
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req := httptest.NewRequest(http.MethodGet, u, nil)
	if edit != nil {
		edit(req)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func getSubagentTranscript(t *testing.T, mux http.Handler, id string, q url.Values) transcriptResponse {
	t.Helper()
	rec := serveSubagent(mux, id, q, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("subagent %s = %d %s", id, rec.Code, rec.Body)
	}
	var res transcriptResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	return res
}

// wantSubagentCode checks a refusal's status and error code.
func wantSubagentCode(t *testing.T, name string, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status || (code != "" && !strings.Contains(rec.Body.String(), `"code":"`+code+`"`)) {
		t.Errorf("%s = %d %s, want %d %s", name, rec.Code, rec.Body, status, code)
	}
}

func entryTexts(res transcriptResponse) []string {
	var out []string
	for _, e := range res.Entries {
		for _, p := range e.Parts {
			if p.Text != "" {
				out = append(out, p.Text)
			}
		}
	}
	return out
}

func sidechainLine(uuid, text string) string {
	b, _ := json.Marshal(map[string]any{"type": "assistant", "uuid": uuid, "isSidechain": true,
		"message": map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}})
	return string(b) + "\n"
}

func TestSubagentTranscript(t *testing.T) {
	dir, subs := subagentsFixture(t)
	mux := subagentTranscriptServer(t, claudeSession(dir))
	rec := serveSubagent(mux, "aaa1", nil, nil)
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("aaa1 = %d %v %s", rec.Code, rec.Header(), rec.Body)
	}
	var res transcriptResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	// Every row of the file is a sidechain one, and every one is shown: the
	// task, the tool call with its result folded in.
	if res.Agent != "claude" || res.SessionID != testSessionID || res.Status != "unknown" || !res.Reset || res.Cursor == "" || res.Before != "" {
		t.Errorf("res = %+v", res)
	}
	if len(res.Entries) < 2 || res.Entries[0].Role != "user" || res.Entries[0].Parts[0].Text != "SECRET-PROMPT-ONE" {
		t.Fatalf("entries = %+v", res.Entries)
	}
	if !strings.Contains(rec.Body.String(), "SECRET-TOOL-RESULT") || !strings.Contains(rec.Body.String(), `"tool":"Read"`) {
		t.Errorf("tool call missing: %s", rec.Body)
	}

	// The next read after the cursor has only what was written since.
	appendFile(t, filepath.Join(subs, "agent-aaa1.jsonl"), sidechainLine("n1", "written later"))
	next := getSubagentTranscript(t, mux, "aaa1", url.Values{"cursor": {res.Cursor}})
	if next.Reset || strings.Join(entryTexts(next), ",") != "written later" || next.Cursor == res.Cursor {
		t.Errorf("next = %+v", next)
	}

	// The session's transcript still leaves sidechain rows out.
	p := filepath.Join(filepath.Dir(subs), "..", testSessionID+".jsonl")
	appendFile(t, p, sidechainLine("side", "SIDECHAIN-IN-MAIN"))
	main := getTranscriptRes(t, mux)
	if strings.Contains(strings.Join(entryTexts(main), ","), "SIDECHAIN-IN-MAIN") {
		t.Error("the session's transcript showed a sidechain row")
	}

	// A cursor of the session's transcript starts the subagent's read over,
	// and the subagent's does the session's; another subagent's too.
	if r := getSubagentTranscript(t, mux, "aaa1", url.Values{"cursor": {main.Cursor}}); !r.Reset {
		t.Error("a cursor of the session's transcript continued a subagent's")
	}
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/transcript?cursor="+url.QueryEscape(next.Cursor), nil))
	var back transcriptResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &back); err != nil || !back.Reset {
		t.Errorf("a subagent's cursor continued the session's transcript: %s", rec.Body)
	}
	if r := getSubagentTranscript(t, mux, "aaa2", url.Values{"cursor": {next.Cursor}}); !r.Reset {
		t.Error("a cursor of one subagent continued another's")
	}
}

func TestSubagentTranscriptBefore(t *testing.T) {
	dir, subs := subagentsFixture(t)
	var b strings.Builder
	for i := range agentMaxEntries + 50 {
		b.WriteString(sidechainLine("b"+strings.Repeat("x", i%3)+string(rune('a'+i%26)), "row"))
	}
	if err := os.WriteFile(filepath.Join(subs, "agent-big.jsonl"), []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	mux := subagentTranscriptServer(t, claudeSession(dir))
	first := getSubagentTranscript(t, mux, "big", nil)
	if first.Before == "" || len(first.Entries) != agentMaxEntries {
		t.Fatalf("first = %d entries, before %q", len(first.Entries), first.Before)
	}
	older := getSubagentTranscript(t, mux, "big", url.Values{"before": {first.Before}})
	if older.Reset || len(older.Entries) != 50 || older.Before != "" {
		t.Errorf("older = %d entries reset=%v before=%q", len(older.Entries), older.Reset, older.Before)
	}
	wantSubagentCode(t, "junk before", serveSubagent(mux, "big", url.Values{"before": {"junk"}}, nil), http.StatusBadRequest, "")
}

func TestSubagentTranscriptRefusals(t *testing.T) {
	dir, _ := subagentsFixture(t)
	mux := subagentTranscriptServer(t, claudeSession(dir))
	for _, id := range []string{"AAA1", strings.Repeat("a", 65), "a.b", "..%2Fx", "aaa1%2F..%2Faaa2"} {
		wantSubagentCode(t, "id "+id, serveSubagent(mux, id, nil, nil), http.StatusBadRequest, "invalid_request")
	}
	wantSubagentCode(t, "no file", serveSubagent(mux, "nope", nil, nil), http.StatusNotFound, "session_not_found")
	// A meta file without its conversation (a subagent that just started).
	wantSubagentCode(t, "meta only", serveSubagent(mux, "aaa5", nil, nil), http.StatusNotFound, "session_not_found")
	wantSubagentCode(t, "cross-site", serveSubagent(mux, "aaa1", nil, func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }),
		http.StatusForbidden, "")
	wantSubagentCode(t, "view-only", serveSubagent(mux, "aaa1", nil, func(r *http.Request) {
		*r = *r.WithContext(withAuth(r.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
	}), http.StatusForbidden, "view_only")
	req := httptest.NewRequest(http.MethodPost, subagentTranscriptPath+"aaa1/transcript", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	wantSubagentCode(t, "POST", rec, http.StatusMethodNotAllowed, "")

	// Only a Claude Code pane has subagent files.
	for name, s := range map[string]AgentSession{
		"codex":         {Agent: "codex", ID: testSessionID},
		"opencode":      {Agent: "opencode", ID: "ses_x"},
		"no transcript": claudeSession(t.TempDir()),
		"no subagents":  claudeSession(func() string { d := t.TempDir(); writeTranscript(t, d, testSessionID, lines(0, 1)); return d }()),
	} {
		wantSubagentCode(t, name, serveSubagent(subagentTranscriptServer(t, s), "aaa1", nil, nil), http.StatusNotFound, "session_not_found")
	}
	none := http.NewServeMux()
	registerMuxRoutes(none, &fakeLocator{}, newStreamTokenStore(), nil, nil)
	wantSubagentCode(t, "no agent", serveSubagent(none, "aaa1", nil, nil), http.StatusNotFound, "")
}

// An id with no file is answered without waiting for a read slot.
func TestSubagentTranscriptNoSlotForMissing(t *testing.T) {
	dir, _ := subagentsFixture(t)
	mux := subagentTranscriptServer(t, claudeSession(dir))
	for range cap(transcriptReads) {
		transcriptReads <- struct{}{}
	}
	defer func() {
		for range cap(transcriptReads) {
			<-transcriptReads
		}
	}()
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- serveSubagent(mux, "nope", nil, nil) }()
	select {
	case rec := <-done:
		wantSubagentCode(t, "no file", rec, http.StatusNotFound, "session_not_found")
	case <-time.After(5 * time.Second):
		t.Fatal("an id with no file waited for a read slot")
	}
}

func TestSubagentTranscriptNoLinks(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "outside.jsonl")
	if err := os.WriteFile(outside, []byte(sidechainLine("o", "OUTSIDE")), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Run("file", func(t *testing.T) {
		dir, subs := subagentsFixture(t)
		symlinkOrSkip(t, outside, filepath.Join(subs, "agent-out.jsonl"))
		// Even a link to another subagent's file in the same directory.
		symlinkOrSkip(t, filepath.Join(subs, "agent-aaa1.jsonl"), filepath.Join(subs, "agent-in.jsonl"))
		mux := subagentTranscriptServer(t, claudeSession(dir))
		for _, id := range []string{"out", "in"} {
			wantSubagentCode(t, id, serveSubagent(mux, id, nil, nil), http.StatusNotFound, "session_not_found")
		}
	})
	t.Run("directory", func(t *testing.T) {
		dir, subs := subagentsFixture(t)
		moved := filepath.Join(t.TempDir(), "moved")
		if err := os.Rename(subs, moved); err != nil {
			t.Fatal(err)
		}
		symlinkOrSkip(t, moved, subs)
		mux := subagentTranscriptServer(t, claudeSession(dir))
		wantSubagentCode(t, "linked dir", serveSubagent(mux, "aaa1", nil, nil), http.StatusNotFound, "session_not_found")
	})
	t.Run("swapped", func(t *testing.T) {
		dir, subs := subagentsFixture(t)
		mux := subagentTranscriptServer(t, claudeSession(dir))
		p := filepath.Join(subs, "agent-aaa1.jsonl")
		for name, swap := range map[string]func(){
			"link": func() {
				os.Remove(p)
				symlinkOrSkip(t, outside, p)
			},
			"file": func() {
				tmp := p + ".new"
				if err := os.WriteFile(tmp, []byte(sidechainLine("n", "NEW")), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(tmp, p); err != nil {
					t.Fatal(err)
				}
			},
		} {
			t.Run(name, func(t *testing.T) {
				subagentOpenHook = swap
				defer func() { subagentOpenHook = func() {} }()
				wantSubagentCode(t, name, serveSubagent(mux, "aaa1", nil, nil), http.StatusNotFound, "session_not_found")
			})
		}
	})
}

// A subagents directory that cannot be read answers as missing (and is logged).
func TestSubagentTranscriptUnreadableDir(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("permissions")
	}
	dir, subs := subagentsFixture(t)
	session := filepath.Dir(subs)
	if err := os.Chmod(session, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(session, 0o755)
	mux := subagentTranscriptServer(t, claudeSession(dir))
	wantSubagentCode(t, "unreadable", serveSubagent(mux, "aaa1", nil, nil), http.StatusNotFound, "session_not_found")
}

func TestClaudeSubagentJournal(t *testing.T) {
	var j claudeSubagentJournal
	if j.Agent() != "claude" {
		t.Error("Agent")
	}
	if _, err := j.Locate(claudeSession(t.TempDir())); err == nil {
		t.Error("Locate found a file")
	}
	in := sidechainLine("s", "side") + line(1, "plain")
	if got, _ := (claudeJournal{}).Parse(strings.NewReader(in), 0); len(got) != 1 || got[0].Parts[0].Text != "plain" {
		t.Errorf("claudeJournal kept a sidechain row: %+v", got)
	}
	if got, _ := j.Parse(strings.NewReader(in), 0); len(got) != 2 {
		t.Errorf("claudeSubagentJournal = %+v", got)
	}
}

// The route reaches a machine through the proxy.
func TestSubagentTranscriptMachineRoute(t *testing.T) {
	if !machineRouteRe.MatchString("panes/%1/agent/subagents/aaa1/transcript") {
		t.Error("the subagent transcript is not forwarded to a machine")
	}
}
