package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testOpencodeTouchedRaw is a recorded testdata/opencode file with @ROOT@
// made root (the recordings hid the session's directory under it).
func testOpencodeTouchedRaw(t *testing.T, name, root string) []byte {
	t.Helper()
	q, _ := json.Marshal(root)
	return []byte(strings.ReplaceAll(string(testOpencodeFixture(t, name)), "@ROOT@", string(q[1:len(q)-1])))
}

// testOpencodeTouchedMessages is a recorded message list in root.
func testOpencodeTouchedMessages(t *testing.T, name, root string) []json.RawMessage {
	t.Helper()
	return testOpencodeMessagesOf(t, testOpencodeTouchedRaw(t, name, root))
}

// testOpencodeTouchedSession is a session as session.get and session.list
// give it (OpenCode 2.3.0): its directory and the times of its turns.
func testOpencodeTouchedSession(id, parent, dir string, updated, busy, idle int64) json.RawMessage {
	s := map[string]any{"id": id, "projectID": "global", "cost": 0, "title": "t",
		"time":     map[string]any{"created": 1000, "updated": updated, "busy": busy, "idle": idle},
		"location": map[string]any{"directory": dir}}
	if parent != "" {
		s["parentID"] = parent
	}
	data, _ := json.Marshal(s)
	return data
}

// testOpencodeTool is a tool call as an assistant message holds it.
func testOpencodeTool(id, name, status string, input any) map[string]any {
	return map[string]any{"type": "tool", "id": id, "name": name,
		"state": map[string]any{"status": status, "input": input},
		"time":  map[string]any{"created": 2000, "completed": 2100}}
}

// testOpencodeToolMessage is an assistant message holding tools.
func testOpencodeToolMessage(id string, tools ...map[string]any) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"id": id, "type": "assistant", "time": map[string]any{"created": 1900},
		"content": tools})
	return data
}

const testOpencodeTouchedKid = "ses_e20064f4dffeUwnxcB4L7CS4BE"

// The recorded session: an edit relative to its directory, a write by an
// absolute path, an edit that failed, a write the user declined, one
// approved and one still waiting; a subagent edited a file its parent
// failed to.
func TestOpencodeTouchedRecorded(t *testing.T) {
	oc := newFakeOpencode(t)
	root := t.TempDir()
	var kids struct{ Data []json.RawMessage }
	json.Unmarshal(testOpencodeTouchedRaw(t, "session-list-touched-children.json", root), &kids)
	oc.set(func() {
		oc.sessions["ses_t1"] = sessionInfoJSON(testOpencodeTouchedSession("ses_t1", "", root, 5000, 4000, 4500))
		oc.messages["ses_t1"] = testOpencodeTouchedMessages(t, "message-list-touched.json", root)
		oc.list = kids.Data
		oc.messages[testOpencodeTouchedKid] = testOpencodeTouchedMessages(t, "message-list-touched-subagent.json", root)
	})
	files, err := opencodeSessionTouched(AgentSession{Agent: "opencode", ID: "ses_t1"})
	if err != nil {
		t.Fatal(err)
	}
	got := touchedByRel(t, root, files)
	if a := got["a.txt"]; a.count != 1 || a.ops != touchedEdit || a.running || a.sub ||
		!a.last.Equal(time.UnixMilli(1794758957433)) {
		t.Errorf("a.txt = %+v", a)
	}
	for _, name := range []string{"new.txt", "deny2.txt"} {
		if f := got[name]; f.count != 1 || f.ops != touchedWrite || f.running || f.sub {
			t.Errorf("%s = %+v", name, f)
		}
	}
	if w := got["deny3.txt"]; !w.running || w.count != 0 || w.ops != touchedWrite {
		t.Errorf("deny3.txt (waiting for its permission) = %+v", w)
	}
	if b := got["sub/b.txt"]; !b.sub || b.count != 1 || b.ops != touchedEdit {
		t.Errorf("sub/b.txt (the subagent's edit; its parent's failed) = %+v", b)
	}
	if f, ok := got["deny.txt"]; ok {
		t.Errorf("a declined write listed: %+v", f)
	}
	if len(got) != 5 {
		t.Errorf("files = %v", got)
	}
}

// A recorded patch of a gpt- model: an added, an updated, a moved and a
// deleted file.
func TestOpencodeTouchedPatch(t *testing.T) {
	oc := newFakeOpencode(t)
	root := t.TempDir()
	oc.set(func() {
		oc.sessions["ses_t3"] = sessionInfoJSON(testOpencodeTouchedSession("ses_t3", "", root, 5000, 0, 0))
		oc.messages["ses_t3"] = testOpencodeTouchedMessages(t, "message-list-patch.json", root)
	})
	files, err := opencodeSessionTouched(AgentSession{Agent: "opencode", ID: "ses_t3"})
	if err != nil {
		t.Fatal(err)
	}
	got := touchedByRel(t, root, files)
	for name, want := range map[string]touchedFile{
		"src/added.txt": {ops: touchedWrite}, "src/x.txt": {ops: touchedEdit},
		"src/mv.txt": {ops: touchedDelete, deleted: true}, "src/moved.txt": {ops: touchedMove},
		"src/gone.txt": {ops: touchedDelete, deleted: true},
	} {
		if f := got[name]; f.ops != want.ops || f.deleted != want.deleted || f.count != 1 || f.running {
			t.Errorf("%s = %+v", name, f)
		}
	}
	if len(got) != 5 {
		t.Errorf("files = %v", got)
	}
}

// A recorded fork: its copies of its parent's calls are not its changes.
func TestOpencodeTouchedFork(t *testing.T) {
	oc := newFakeOpencode(t)
	root := t.TempDir()
	fork := "ses_e20068067ffeMfTJXFIkDu7C42"
	oc.set(func() {
		oc.sessions[fork] = sessionInfoJSON(testOpencodeTouchedSession(fork, "", root, 5000, 0, 0))
		oc.messages[fork] = testOpencodeTouchedMessages(t, "message-list-touched-fork.json", root)
	})
	files, err := opencodeSessionTouched(AgentSession{Agent: "opencode", ID: fork})
	if err != nil {
		t.Fatal(err)
	}
	got := touchedByRel(t, root, files)
	if a := got["a.txt"]; len(got) != 1 || a.count != 1 || a.ops != touchedEdit {
		t.Errorf("files = %v", got)
	}
}

// What each tool call adds: only the file tools of an assistant message
// that completed or run, by a path that can be made absolute.
func TestOpencodeTouchedTools(t *testing.T) {
	root := t.TempDir()
	in := filepath.Join(root, "in.txt")
	st := newTouchedState()
	st.cwd = root
	step := func(m json.RawMessage) {
		var msg opencodeTouchMessage
		if err := json.Unmarshal(m, &msg); err != nil {
			t.Fatal(err)
		}
		stepOpencodeTouched(&st, msg)
	}
	step(testOpencodeToolMessage("msg_a",
		testOpencodeTool("c1", "edit", "completed", map[string]any{"filePath": "legacy.txt"}),
		testOpencodeTool("c2", "multiedit", "completed", map[string]any{"path": "unknown.txt"}),
		testOpencodeTool("c3", "edit", "pending", map[string]any{"path": "pending.txt"}),
		testOpencodeTool("c4", "edit", "completed", "not an object"),
		testOpencodeTool("c5", "write", "completed", map[string]any{"path": 7}),
		testOpencodeTool("c6", "write", "completed", map[string]any{"path": "nul\x00.txt"}),
		testOpencodeTool("c7", "apply_patch", "completed", map[string]any{"patchText": "*** Begin Patch\n" +
			"*** Move to: early.txt\n*** Update File: up.txt\n*** Add File: add.txt\n*** Move to: late.txt\n" +
			"*** Update File:   \n*** Delete File: " + in + "\n*** End Patch"}),
		testOpencodeTool("c8", "patch", "running", map[string]any{"patchText": "*** Update File: a.txt\n*** Move to: b.txt\n"}),
		// A hunk's context line that reads like a header is the file's text.
		testOpencodeTool("c9", "patch", "completed", map[string]any{"patchText": "*** Update File: doc.md\r\n@@\r\n" +
			" *** Delete File: in.txt\r\n-old\r\n+new\r\n"}),
		map[string]any{"type": "text", "text": "edit"},
	))
	// A user message's content, a message of a bad id, a fork's copy.
	user, _ := json.Marshal(map[string]any{"id": "msg_u", "type": "user", "content": []any{
		testOpencodeTool("u1", "edit", "completed", map[string]any{"path": "user.txt"})}})
	step(user)
	step(testOpencodeToolMessage("../x", testOpencodeTool("x1", "edit", "completed", map[string]any{"path": "bad.txt"})))
	step(testOpencodeToolMessage("msg_a_3", testOpencodeTool("c1", "edit", "completed", map[string]any{"path": "copy.txt"})))
	got := touchedByRel(t, root, st.list(false))
	want := map[string]touchedOp{"legacy.txt": touchedEdit, "up.txt": touchedEdit, "add.txt": touchedWrite,
		"in.txt": touchedDelete, "a.txt": touchedDelete, "b.txt": touchedMove, "doc.md": touchedEdit}
	for name, op := range want {
		if f, ok := got[name]; !ok || f.ops != op {
			t.Errorf("%s = %+v %v", name, f, ok)
		}
	}
	if !got["a.txt"].running || !got["b.txt"].running || got["up.txt"].running || got["in.txt"].count != 1 {
		t.Errorf("running = %+v", got)
	}
	if len(got) != len(want) {
		t.Errorf("files = %v", got)
	}

	// A relative path without a directory to place it in.
	if ch := opencodeToolChanges("edit", json.RawMessage(`{"path":"a.txt"}`), ""); ch != nil {
		t.Errorf("no directory = %v", ch)
	}
	if !opencodeMillis(0).IsZero() {
		t.Error("no time")
	}
}

// An idle session is read once until it is updated again; a running one,
// whose tool calls do not change that time, every time.
func TestOpencodeTouchedCache(t *testing.T) {
	oc := newFakeOpencode(t)
	root := t.TempDir()
	write := testOpencodeToolMessage("msg_w", testOpencodeTool("c1", "write", "completed", map[string]any{"path": "w.txt"}))
	oc.set(func() {
		oc.sessions["sesIdle"] = sessionInfoJSON(testOpencodeTouchedSession("sesIdle", "", root, 5000, 4000, 4500))
		oc.sessions["sesBusy"] = sessionInfoJSON(testOpencodeTouchedSession("sesBusy", "", root, 5000, 4600, 4500))
		oc.messages["sesIdle"] = []json.RawMessage{write}
		oc.messages["sesBusy"] = []json.RawMessage{write}
	})
	reads := func(id string) int {
		n := 0
		for _, r := range oc.reqs() {
			if strings.HasPrefix(r, "GET /api/session/"+id+"/message?") {
				n++
			}
		}
		return n
	}
	for range 2 {
		for _, id := range []string{"sesIdle", "sesBusy"} {
			if files, err := opencodeSessionTouched(AgentSession{Agent: "opencode", ID: id}); err != nil || len(files) != 1 {
				t.Fatalf("%s = %v %v", id, files, err)
			}
		}
	}
	if reads("sesIdle") != 1 || reads("sesBusy") != 2 {
		t.Errorf("reads: idle %d, busy %d", reads("sesIdle"), reads("sesBusy"))
	}
	// Updated: read again.
	oc.mu.Lock()
	oc.sessions["sesIdle"] = sessionInfoJSON(testOpencodeTouchedSession("sesIdle", "", root, 6000, 4000, 5500))
	oc.mu.Unlock()
	opencodeSessionTouched(AgentSession{Agent: "opencode", ID: "sesIdle"})
	if reads("sesIdle") != 2 {
		t.Errorf("updated: %d reads", reads("sesIdle"))
	}
}

// A session not made yet changed nothing; no service, a refused password:
// no transcript; a failing service, an error without its words. A
// subagent that cannot be read is left out. Neither the service's words
// nor its password reach the log.
func TestOpencodeTouchedErrors(t *testing.T) {
	oc := newFakeOpencode(t)
	logs := captureLogs(t)
	root := t.TempDir()
	write := testOpencodeToolMessage("msg_w", testOpencodeTool("c1", "write", "completed", map[string]any{"path": "w.txt"}))
	oc.set(func() {
		oc.sessions["sesP"] = sessionInfoJSON(testOpencodeTouchedSession("sesP", "", root, 5000, 0, 0))
		oc.messages["sesP"] = []json.RawMessage{write}
		// A subagent whose messages are gone, and one too large to read.
		oc.list = []json.RawMessage{
			testOpencodeTouchedSession("ses_gone", "sesP", root, 4000, 0, 0),
			testOpencodeTouchedSession("ses_big", "sesP", root, 4000, 0, 0),
		}
		oc.messages["ses_big"] = []json.RawMessage{write}
		oc.big = opencodeUsagePage
	})
	s := AgentSession{Agent: "opencode", ID: "sesP"}
	// The page of sesP is as large as the subagent's: both fail alike.
	if _, err := opencodeSessionTouched(s); err == nil || !strings.Contains(err.Error(), "over") {
		t.Errorf("too large = %v", err)
	}
	oc.set(func() { oc.big = 0 })
	if files, err := opencodeSessionTouched(s); err != nil || len(files) != 1 || files[0].sub {
		t.Errorf("files = %+v %v", files, err)
	}
	if files, err := opencodeSessionTouched(AgentSession{Agent: "opencode", ID: "sesNew"}); err != nil || files != nil {
		t.Errorf("not made yet = %v %v", files, err)
	}
	oc.set(func() { oc.status = http.StatusInternalServerError })
	if _, err := opencodeSessionTouched(s); err == nil || err == errNoTranscript || strings.Contains(err.Error(), "internal words") {
		t.Errorf("failing service: %v", err)
	}
	oc.set(func() { oc.status = http.StatusUnauthorized })
	if _, err := opencodeSessionTouched(s); err != errNoTranscript {
		t.Errorf("refused: %v", err)
	}
	stubOpencodeStateDir(t, t.TempDir())
	if _, err := opencodeSessionTouched(s); err != errNoTranscript {
		t.Errorf("no service: %v", err)
	}
	if out := logs.String(); strings.Contains(out, testOpencodePassword) || strings.Contains(out, "words") {
		t.Errorf("logged: %s", out)
	}
}

// The subagents' failures are logged without the service's words, and the
// list of the session itself is kept.
func TestOpencodeTouchedSubagentFailure(t *testing.T) {
	oc := newFakeOpencode(t)
	logs := captureLogs(t)
	root := t.TempDir()
	oc.set(func() {
		oc.sessions["sesP"] = sessionInfoJSON(testOpencodeTouchedSession("sesP", "", root, 5000, 0, 0))
		oc.messages["sesP"] = []json.RawMessage{testOpencodeToolMessage("msg_w",
			testOpencodeTool("c1", "write", "completed", map[string]any{"path": "w.txt"}))}
		oc.list = []json.RawMessage{testOpencodeTouchedSession("ses_kid", "sesP", "", 4000, 0, 0)}
		// Content that is not a list: the subagent's page cannot be decoded.
		oc.messages["ses_kid"] = []json.RawMessage{json.RawMessage(`{"id":"msg_k","type":"assistant","content":"x"}`)}
	})
	files, err := opencodeSessionTouched(AgentSession{Agent: "opencode", ID: "sesP"})
	if err != nil || len(files) != 1 {
		t.Errorf("files = %+v %v", files, err)
	}
	if !strings.Contains(logs.String(), "opencode touched:") || strings.Contains(logs.String(), testOpencodePassword) {
		t.Errorf("logged: %s", logs)
	}
}

// The route for a pane running an OpenCode session and for one of the
// root's history: placed under the root, a running call only for the live
// one, a view-only client the tracked files by name.
func TestTouchedRouteOpencode(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	outside := realTemp(t)
	writeFile(t, filepath.Join(fx.root, "a.txt"), "x")
	gitRun(t, fx.root, "add", ".")
	gitRun(t, fx.root, "commit", "-qm", "init")
	msgs := testOpencodeTouchedMessages(t, "message-list-touched.json", fx.root)
	msgs = append(msgs, testOpencodeToolMessage("msg_out",
		testOpencodeTool("c9", "write", "completed", map[string]any{"path": filepath.Join(outside, "o.txt")})))
	fx.oc.set(func() {
		fx.oc.sessions["sesRoot"] = sessionInfoJSON(testOpencodeTouchedSession("sesRoot", "", fx.root, 5000, 4600, 4500))
		fx.oc.messages["sesRoot"] = msgs
	})
	fx.m.sessions["0"] = AgentSession{Agent: "opencode", ID: "sesRoot"}

	code, live, body := getTouched(t, fx.h, apiRequest("GET", "/api/mux/panes/0/agent/touched", ""))
	if code != 200 {
		t.Fatalf("live = %d %s", code, body)
	}
	got := touchedPaths(live)
	if w := got["deny3.txt"]; !w.Running || len(got) != 4 || live.Skipped != 1 || got["a.txt"].Ops[0] != "edit" {
		t.Errorf("live = %+v", live)
	}
	if strings.Contains(body, outside) || strings.Contains(body, fx.root) {
		t.Errorf("the reply holds a path: %s", body)
	}

	q := "/api/mux/panes/0/agent/touched?agent=opencode&session=sesRoot"
	code, hist, body := getTouched(t, fx.h, apiRequest("GET", q, ""))
	if _, ok := touchedPaths(hist)["deny3.txt"]; code != 200 || ok || len(hist.Files) != 3 {
		t.Errorf("history = %d %s", code, body)
	}
	code, view, body := getTouched(t, fx.h, viewRequest("GET", q, ""))
	if code != 200 || len(view.Files) != 1 || view.Files[0].Path != "a.txt" || strings.Contains(body, `"ops"`) {
		t.Errorf("view = %d %s", code, body)
	}
	// Another root's session.
	if rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/0/agent/touched?agent=opencode&session=sesOut", "")); rec.Code != 404 {
		t.Errorf("another root's = %d", rec.Code)
	}

	// A failing service: an error with none of its words; no service: none.
	fx.oc.set(func() { fx.oc.status = http.StatusInternalServerError })
	fx.m.sessions["1"] = AgentSession{Agent: "opencode", ID: "sesOther"}
	rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/1/agent/touched", ""))
	if rec.Code < 500 || strings.Contains(rec.Body.String(), "words") {
		t.Errorf("failing = %d %s", rec.Code, rec.Body)
	}
	stubOpencodeStateDir(t, t.TempDir())
	fx.m.sessions["2"] = AgentSession{Agent: "opencode", ID: "sesThird"}
	if rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/2/agent/touched", "")); rec.Code != 404 {
		t.Errorf("no service = %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(fx.root, "deny3.txt")); err == nil {
		t.Error("the route made a file")
	}
}

// The subagents are read within the session's budget and time; a list of
// them that fails is logged without the service's words.
func TestOpencodeSubagentTouchedLimits(t *testing.T) {
	oc := newFakeOpencode(t)
	logs := captureLogs(t)
	root := t.TempDir()
	oc.set(func() {
		oc.list = []json.RawMessage{testOpencodeTouchedSession("ses_kid", "sesP", root, 4000, 0, 0)}
		oc.messages["ses_kid"] = []json.RawMessage{testOpencodeToolMessage("msg_k",
			testOpencodeTool("c1", "edit", "completed", map[string]any{"path": "k.txt"}))}
	})
	c, err := opencodeConnect()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	budget := 0
	if out := opencodeSubagentTouched(ctx, c, "sesP", root, 1, &budget); out != nil {
		t.Errorf("no budget = %v", out)
	}
	done, cancel := context.WithCancel(ctx)
	cancel()
	budget = 10
	if out := opencodeSubagentTouched(done, c, "sesP", root, 1, &budget); out != nil {
		t.Errorf("time up = %v", out)
	}
	if out := opencodeSubagentTouched(ctx, c, "sesP", root, 1, &budget); len(out) != 1 || !out[0][0].sub || budget != 9 {
		t.Errorf("subagents = %v, budget %d", out, budget)
	}
	oc.set(func() { oc.status = http.StatusInternalServerError })
	if out := opencodeSubagentTouched(ctx, c, "sesP", root, 1, &budget); out != nil {
		t.Errorf("failing = %v", out)
	}
	if out := logs.String(); !strings.Contains(out, "opencode touched:") || strings.Contains(out, "words") {
		t.Errorf("logged: %s", out)
	}
}
