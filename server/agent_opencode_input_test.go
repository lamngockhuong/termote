package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// opencodePane is a pane running an OpenCode TUI on session id, with the
// service faked and its messages read from a fixture.
func opencodePane(t *testing.T, id, status string) (*fakeOpencode, *fakeWriter) {
	t.Helper()
	oc := newFakeOpencode(t)
	oc.messages[id] = testOpencodeMessages(t, "message-list-after-tool.json")
	f := newFakeWriter()
	f.session = AgentSession{Agent: "opencode", ID: id, Status: status, Target: "%5", PID: 77, ProcStart: "9"}
	return oc, f
}

func opencodeCursor(id string) string {
	return encodeCursor(agentCursor{Session: id, File: opencodeCursorAfter + "msg_x"})
}

// captureLogs collects what the server logs during a test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &logs
}

func (f *fakeOpencode) writes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.requests {
		if !strings.HasPrefix(r, "GET ") {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakeOpencode) lastBody(t *testing.T) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bodies) == 0 {
		t.Fatal("no write reached the service")
	}
	var v map[string]any
	json.Unmarshal([]byte(f.bodies[len(f.bodies)-1]), &v)
	return v
}

// A message goes to the pane's session through the service, queued behind a
// running turn; nothing is typed into the pane.
func TestOpencodeMessage(t *testing.T) {
	oc, f := opencodePane(t, "sesFixP1", "idle")
	mux := agentMux(f)
	code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "hello\x07 there", "cursor": opencodeCursor("sesFixP1")})
	if code != http.StatusNoContent {
		t.Fatalf("idle = %d %v", code, body)
	}
	if w := oc.writes(); len(w) != 1 || w[0] != "POST /api/session/sesFixP1/prompt" {
		t.Fatalf("writes = %v", w)
	}
	if b := oc.lastBody(t); b["text"] != "hello there" || b["delivery"] != "queue" || b["files"] != nil {
		t.Errorf("body = %v", b)
	}
	if len(f.pasted) != 0 || len(f.keys) != 0 {
		t.Errorf("typed into the pane: %q %v", f.pasted, f.keys)
	}
	// Working or waiting on a dialog: OpenCode queues it.
	for _, status := range []string{"working", "blocked"} {
		f.mu.Lock()
		f.session.Status = status
		f.mu.Unlock()
		if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "next", "cursor": opencodeCursor("sesFixP1")}); code != http.StatusAccepted {
			t.Errorf("%s = %d %v", status, code, body)
		}
	}
}

// The session is the pane's, read again right before the write: a cursor of
// another session, or a pane that moved to another session meanwhile, sends
// nothing.
func TestOpencodeMessageSessionChecks(t *testing.T) {
	oc, f := opencodePane(t, "sesFixP1", "idle")
	oc.messages["sesOther1"] = oc.messages["sesFixP1"]
	mux := agentMux(f)
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "hi", "cursor": opencodeCursor("sesOther1")}); code != http.StatusConflict || body["code"] != "session_changed" {
		t.Errorf("other cursor = %d %v", code, body)
	}
	f.sessions = []AgentSession{{Agent: "opencode", ID: "sesOther1", Status: "idle", Target: "%5", PID: 77, ProcStart: "9"}}
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "hi", "cursor": opencodeCursor("sesFixP1")}); code != http.StatusConflict || body["code"] != "session_changed" {
		t.Errorf("changed = %d %v", code, body)
	}
	// No session the server can name (no --session, or no service).
	f.sessions = []AgentSession{{Agent: "opencode", Status: "unknown", Target: "%5"}}
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "hi", "cursor": opencodeCursor("sesFixP1")}); code != http.StatusConflict || body["code"] != "session_changed" {
		t.Errorf("no session = %d %v", code, body)
	}
	if w := oc.writes(); len(w) != 0 {
		t.Errorf("writes = %v", w)
	}
}

func TestOpencodeMessageRefusals(t *testing.T) {
	logs := captureLogs(t)
	oc, f := opencodePane(t, "sesNew1", "idle")
	delete(oc.messages, "sesNew1")
	mux := agentMux(f)
	// --session names a session the TUI makes with its first message.
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "hi", "cursor": opencodeCursor("sesNew1")}); code != http.StatusConflict || body["code"] != "input_not_ready" {
		t.Errorf("not made = %d %v", code, body)
	}
	// The service fails: the client gets a code, not its words.
	oc.messages["sesNew1"] = nil
	oc.writeStatus = http.StatusInternalServerError
	code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "hi", "cursor": opencodeCursor("sesNew1")})
	if code != http.StatusBadGateway || body["code"] != "agent_unavailable" || strings.Contains(body["error"].(string), "words") {
		t.Errorf("failed = %d %v", code, body)
	}
	if strings.Contains(logs.String(), "write words") || strings.Contains(logs.String(), testOpencodePassword) ||
		!strings.Contains(logs.String(), "opencode message:") {
		t.Errorf("logs = %s", logs)
	}
	// No service at all.
	stubOpencodeStateDir(t, t.TempDir())
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "hi", "cursor": opencodeCursor("sesNew1")}); code != http.StatusBadGateway || body["code"] != "agent_unavailable" {
		t.Errorf("no service = %d %v", code, body)
	}
	// The body's limits hold as for any agent.
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": strings.Repeat("x", agentMessageBody), "cursor": opencodeCursor("sesNew1")}); code != http.StatusRequestEntityTooLarge || body["code"] != "text_too_long" {
		t.Errorf("too large = %d %v", code, body)
	}
}

// Images go as data: URIs read from the server's own uploads; an id that is
// not one of them is refused before anything is sent.
func TestOpencodeMessageImages(t *testing.T) {
	oc, f := opencodePane(t, "sesFixP1", "idle")
	mux, ids, _ := imageMux(t, f, 2)
	code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "look", "images": ids, "at": []int{0, 4}, "cursor": opencodeCursor("sesFixP1")})
	if code != http.StatusNoContent {
		t.Fatalf("POST = %d %v", code, body)
	}
	b := oc.lastBody(t)
	files, _ := b["files"].([]any)
	if b["text"] != "look" || len(files) != 2 {
		t.Fatalf("body = %v", b["text"])
	}
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(testImage(t, "image/png"))
	if f0 := files[0].(map[string]any); f0["uri"] != want || f0["name"] != "image.png" {
		t.Errorf("file = %.80v", f0)
	}
	n := len(oc.writes())
	code, body = postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "x", "images": []string{"../../etc/passwd"}, "cursor": opencodeCursor("sesFixP1")})
	if code != http.StatusBadRequest || body["code"] != "invalid_request" || len(oc.writes()) != n {
		t.Errorf("bad id = %d %v", code, body)
	}
	if _, err := opencodeImage("/nowhere/x.bmp"); err == nil {
		t.Error("an unknown type was read")
	}
	if _, err := opencodeImage("/nowhere/x.png"); err == nil {
		t.Error("a missing file was read")
	}
}

// A view-only client sends nothing, nor answers; another site's page cannot
// write at all.
func TestOpencodeWritesRefusedToViewAndCrossSite(t *testing.T) {
	oc, f := opencodePane(t, "sesFixP1", "blocked")
	oc.permissions["sesFixP1"] = testOpencodeFixture(t, "permission-list.json")
	mux := agentMux(f)
	p := getPrompt(t, mux, "0")
	for _, c := range []struct{ path, body string }{
		{"message", `{"text":"hi","cursor":"` + opencodeCursor("sesFixP1") + `"}`},
		{"answer", `{"promptId":"` + p["promptId"].(string) + `","choice":1}`},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/mux/panes/0/agent/"+c.path, strings.NewReader(c.body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("view %s = %d %s", c.path, rec.Code, rec.Body)
		}
		req = httptest.NewRequest(http.MethodPost, "/api/mux/panes/0/agent/"+c.path, strings.NewReader(c.body))
		req.Host = "localhost:7680"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		req.Header.Set("Origin", "https://evil.example")
		rec = httptest.NewRecorder()
		writeGuard(parseAllowedHosts("", false), mux).ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("cross-site %s = %d %s", c.path, rec.Code, rec.Body)
		}
	}
	if w := oc.writes(); len(w) != 0 {
		t.Errorf("writes = %v", w)
	}
	// The view-only card has no id.
	req := httptest.NewRequest(http.MethodGet, "/api/mux/panes/0/agent/prompt", nil)
	req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var res struct{ Prompt map[string]any }
	json.Unmarshal(rec.Body.Bytes(), &res)
	if rec.Code != http.StatusOK || res.Prompt == nil || res.Prompt["promptId"] != nil || res.Prompt["kind"] != "permission" {
		t.Errorf("view prompt = %d %s", rec.Code, rec.Body)
	}
}

func TestOpencodePermissionCard(t *testing.T) {
	oc, f := opencodePane(t, "sesFixP1", "blocked")
	oc.permissions["sesFixP1"] = testOpencodeFixture(t, "permission-list.json")
	mux := agentMux(f)
	p := getPrompt(t, mux, "0")
	opts, _ := p["options"].([]any)
	if p["kind"] != "permission" || p["title"] != "Allow shell?" || p["body"] != "touch spike-file.txt" || len(opts) != 3 || p["promptId"] == nil {
		t.Fatalf("prompt = %v", p)
	}
	if o := opts[1].(map[string]any); o["label"] != "Yes, always" || o["detail"] != "touch *" {
		t.Errorf("always = %v", o)
	}
	// Every client polling it holds the same id.
	if again := getPrompt(t, mux, "0"); again["promptId"] != p["promptId"] {
		t.Errorf("ids %v %v", p["promptId"], again["promptId"])
	}
	// A choice that is no option leaves the id usable.
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 9}); code != http.StatusBadRequest || body["code"] != "invalid_choice" {
		t.Errorf("bad choice = %d %v", code, body)
	}
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 2}); code != http.StatusNoContent {
		t.Fatalf("answer = %d %v", code, body)
	}
	if w := oc.writes(); len(w) != 1 || w[0] != "POST /api/session/sesFixP1/permission/per_1dd3466580014YB1n047mbwyWk/reply" {
		t.Errorf("writes = %v", w)
	}
	if b := oc.lastBody(t); b["decision"] != "always" {
		t.Errorf("body = %v", b)
	}
	// Answered: spent, and the card is gone.
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 1}); code != http.StatusConflict || body["code"] != "prompt_expired" {
		t.Errorf("again = %d %v", code, body)
	}
	if p := getPrompt(t, mux, "0"); p != nil {
		t.Errorf("after = %v", p)
	}
}

func TestOpencodePermissionCancelRejects(t *testing.T) {
	oc, f := opencodePane(t, "sesFixP1", "blocked")
	oc.permissions["sesFixP1"] = testOpencodeFixture(t, "permission-list.json")
	mux := agentMux(f)
	p := getPrompt(t, mux, "0")
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": "cancel"}); code != http.StatusNoContent {
		t.Fatalf("cancel = %d %v", code, body)
	}
	if b := oc.lastBody(t); b["decision"] != "reject" {
		t.Errorf("body = %v", b)
	}
}

// A request answered elsewhere (the terminal) meanwhile, or a pane moved to
// another session, gets no reply from termote.
func TestOpencodeAnswerChecks(t *testing.T) {
	oc, f := opencodePane(t, "sesFixP1", "blocked")
	perms := testOpencodeFixture(t, "permission-list.json")
	oc.permissions["sesFixP1"] = perms
	mux := agentMux(f)
	p := getPrompt(t, mux, "0")
	oc.set(func() { oc.permissions["sesFixP1"] = []byte(`{"data":[]}`) })
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 1}); code != http.StatusConflict || body["code"] != "prompt_expired" {
		t.Errorf("answered elsewhere = %d %v", code, body)
	}
	oc.set(func() { oc.permissions["sesFixP1"] = perms })
	time.Sleep(agentCacheTTL)
	p = getPrompt(t, mux, "0")
	f.sessions = []AgentSession{{Agent: "opencode", ID: "sesOther1", Status: "blocked", Target: "%5", PID: 77, ProcStart: "9"}}
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 1}); code != http.StatusConflict || body["code"] != "target_changed" {
		t.Errorf("session changed = %d %v", code, body)
	}
	if w := oc.writes(); len(w) != 0 {
		t.Errorf("writes = %v", w)
	}
	// The service is gone, or fails: 502, its words only in the log.
	logs := captureLogs(t)
	f.sessions = nil
	time.Sleep(agentCacheTTL)
	p = getPrompt(t, mux, "0")
	oc.writeStatus = http.StatusInternalServerError
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 1}); code != http.StatusBadGateway || body["code"] != "agent_unavailable" {
		t.Errorf("failed = %d %v", code, body)
	}
	if strings.Contains(logs.String(), "write words") || !strings.Contains(logs.String(), "opencode answer:") {
		t.Errorf("logs = %s", logs)
	}
	oc.writeStatus = 0
	time.Sleep(agentCacheTTL)
	p = getPrompt(t, mux, "0")
	oc.status = http.StatusInternalServerError
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 1}); code != http.StatusBadGateway || body["code"] != "agent_unavailable" {
		t.Errorf("list failed = %d %v", code, body)
	}
	oc.status = 0
	time.Sleep(agentCacheTTL)
	p = getPrompt(t, mux, "0")
	stubOpencodeStateDir(t, t.TempDir())
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": 1}); code != http.StatusBadGateway || body["code"] != "agent_unavailable" {
		t.Errorf("no service = %d %v", code, body)
	}
}

func TestOpencodeQuestionForm(t *testing.T) {
	oc, f := opencodePane(t, "ses_in2", "blocked")
	oc.forms["ses_in2"] = testOpencodeFixture(t, "form-list-question-multi.json")
	mux := agentMux(f)
	p := getPrompt(t, mux, "0")
	fields, _ := p["fields"].([]any)
	if p["kind"] != "form" || p["title"] != "Questions" || len(fields) != 2 || p["promptId"] == nil {
		t.Fatalf("prompt = %v", p)
	}
	q0, q1 := fields[0].(map[string]any), fields[1].(map[string]any)
	if q0["key"] != "q0" || q0["type"] != "string" || q0["custom"] != true || q0["title"] != "Color" || q0["description"] != "Which color?" ||
		q1["type"] != "multiselect" || len(q1["options"].([]any)) != 3 {
		t.Fatalf("fields = %v", fields)
	}
	if o := q0["options"].([]any)[0].(map[string]any); o["value"] != "Red" || o["label"] != "Red" || o["detail"] != "warm" {
		t.Errorf("option = %v", o)
	}
	// Refused by the service: the client hears only that.
	answer := map[string]any{"q0": "refuse", "q1": []string{"S"}}
	code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": map[string]any{"answer": answer}})
	if code != http.StatusBadRequest || body["code"] != "invalid_choice" || strings.Contains(body["error"].(string), "secret") {
		t.Errorf("refused = %d %v", code, body)
	}
	// The same id answers again: the refused answer took nothing.
	if again := getPrompt(t, mux, "0"); again["promptId"] != p["promptId"] {
		t.Errorf("ids %v %v", p["promptId"], again["promptId"])
	}
	answer = map[string]any{"q0": "Green", "q1": []string{"S", "M"}}
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": map[string]any{"answer": answer}}); code != http.StatusNoContent {
		t.Fatalf("answer = %d %v", code, body)
	}
	b := oc.lastBody(t)
	got, _ := json.Marshal(b)
	if string(got) != `{"answer":{"q0":"Green","q1":["S","M"]}}` {
		t.Errorf("body = %s", got)
	}
}

func TestOpencodeFormCancel(t *testing.T) {
	oc, f := opencodePane(t, "sesFixQ1", "blocked")
	oc.forms["sesFixQ1"] = testOpencodeFixture(t, "form-list.json")
	mux := agentMux(f)
	p := getPrompt(t, mux, "0")
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/answer", map[string]any{"promptId": p["promptId"], "choice": "cancel"}); code != http.StatusNoContent {
		t.Fatalf("cancel = %d %v", code, body)
	}
	if w := oc.writes(); len(w) != 1 || w[0] != "DELETE /api/session/sesFixQ1/form/frm_1dd34cba6001GUfZ5XM4tpRMaz" {
		t.Errorf("writes = %v", w)
	}
}

// Every kind of field a form can have, as OpenCode 2.3.0 lists them; a link
// to open is answered in the terminal.
func TestOpencodeFormFields(t *testing.T) {
	var list struct {
		Data []opencodePending `json:"data"`
	}
	if err := json.Unmarshal(testOpencodeFixture(t, "form-list-fields.json"), &list); err != nil || len(list.Data) != 1 {
		t.Fatal(err)
	}
	form := list.Data[0]
	if p := opencodeFormCard(form); p.Kind != "unsupported" || p.Title != "Deploy settings" || p.Fields != nil || p.opencodeID != form.ID {
		t.Errorf("with a link = %+v", p)
	}
	form.Fields = form.Fields[:len(form.Fields)-1] // the link
	p := opencodeFormCard(form)
	if p.Kind != "form" || len(p.Fields) != 7 {
		t.Fatalf("card = %+v", p)
	}
	got, _ := json.Marshal(p.Fields)
	want := `[{"key":"name","type":"string","title":"Name","description":"Service name","required":true,"placeholder":"my-svc","minLength":2,"maxLength":20,"default":"svc"},` +
		`{"key":"email","type":"string","title":"Email","format":"email"},` +
		`{"key":"replicas","type":"integer","title":"Replicas","required":true,"minimum":1,"maximum":5,"default":2},` +
		`{"key":"ratio","type":"number","title":"Ratio","minimum":0,"maximum":1},` +
		`{"key":"public","type":"boolean","title":"Public","description":"Expose it","default":false},` +
		`{"key":"regions","type":"multiselect","title":"Regions","options":[{"value":"eu","label":"Europe"},{"value":"us","label":"United States"},{"value":"ap","label":"Asia"}],"minItems":1,"maxItems":2,"default":["eu"]},` +
		`{"key":"domain","type":"string","title":"Domain","when":[{"key":"public","op":"eq","value":true}]}]`
	if string(got) != want {
		t.Errorf("fields\n%s\nwant\n%s", got, want)
	}
	// Forms the card cannot take.
	for name, edit := range map[string]func(*opencodePending){
		"unknown type": func(f *opencodePending) { f.Fields[0].Type = "date" },
		"bad key":      func(f *opencodePending) { f.Fields[0].Key = "a\nb" },
		"__proto__":    func(f *opencodePending) { f.Fields[0].Key = "__proto__" },
		"bad option":   func(f *opencodePending) { f.Fields[5].Options[0].Value = "e\u0007u" },
		"when on a hidden field": func(f *opencodePending) {
			f.Fields[4].Hidden = true // public, which domain's condition names
		},
		"bad when": func(f *opencodePending) { f.Fields[6].When[0].Op = "gt" },
		"all hidden": func(f *opencodePending) {
			for i := range f.Fields {
				f.Fields[i].Hidden = true
			}
		},
		"too many fields": func(f *opencodePending) {
			for len(f.Fields) <= opencodeMaxFields {
				f.Fields = append(f.Fields, f.Fields[0])
			}
		},
		"too many options": func(f *opencodePending) {
			for len(f.Fields[5].Options) <= opencodeMaxOptions {
				f.Fields[5].Options = append(f.Fields[5].Options, f.Fields[5].Options[0])
			}
		},
	} {
		var c opencodePending
		data, _ := json.Marshal(form)
		json.Unmarshal(data, &c)
		edit(&c)
		if p := opencodeFormCard(c); p.Kind != "unsupported" {
			t.Errorf("%s: %+v", name, p)
		}
	}
	// Bounds OpenCode writes as text are none; a default of the wrong type
	// is dropped.
	if opencodeNumber(json.RawMessage(`"Infinity"`)) != nil || opencodeNumber(nil) != nil {
		t.Error("Infinity is a bound")
	}
	for _, typ := range []string{"string", "number", "boolean", "multiselect", "external"} {
		if d := opencodeDefault(opencodeFormField{Type: typ, Default: json.RawMessage(`{}`)}); d != nil {
			t.Errorf("%s default = %v", typ, d)
		}
	}
	// A default no answer could send back (not an option of a field that
	// takes no other text) is dropped; the field stays.
	c := opencodeFormCard(opencodePending{ID: "frm_x", Fields: []opencodeFormField{
		{Key: "q", Type: "string", Options: []opencodeFormOption{{Value: "A", Label: "A"}}, Default: json.RawMessage(`"Z"`)},
		{Key: "m", Type: "multiselect", Options: []opencodeFormOption{{Value: "A", Label: "A"}}, Default: json.RawMessage(`["A","Z"]`)},
		{Key: "c", Type: "string", Options: []opencodeFormOption{{Value: "A", Label: "A"}}, Custom: true, Default: json.RawMessage(`"Z"`)},
	}})
	if c.Kind != "form" || c.Fields[0].Default != nil || c.Fields[1].Default != nil || c.Fields[2].Default != "Z" {
		t.Errorf("defaults = %+v", c.Fields)
	}
}

func TestOpencodeFormAnswers(t *testing.T) {
	var list struct {
		Data []opencodePending `json:"data"`
	}
	json.Unmarshal(testOpencodeFixture(t, "form-list-fields.json"), &list)
	form := list.Data[0]
	form.Fields = form.Fields[:len(form.Fields)-1]
	p := opencodeFormCard(form)
	ok := `"name":"abc","replicas":2`
	for _, c := range []struct {
		answer, code string
	}{
		{`{` + ok + `}`, ""},
		{`{` + ok + `,"email":"a@b.c","ratio":0.5,"public":true,"regions":["eu","us"],"domain":"d.com"}`, ""},
		{`{"name":"abc"}`, "invalid_choice"},             // replicas is required
		{`{` + ok + `,"nope":1}`, "invalid_choice"},      // no such field
		{`{` + ok + `,"secret":"x"}`, "invalid_choice"},  // hidden: never sent
		{`{"name":1,"replicas":2}`, "invalid_choice"},    // not a string
		{`{"name":"a\nb","replicas":2}`, "invalid_text"}, // a control character
		{`{"name":"` + strings.Repeat("x", agentMaxFreeText+1) + `","replicas":2}`, "text_too_long"},
		{`{"name":"abc","replicas":2.5}`, "invalid_choice"}, // not an integer
		{`{"name":"abc","replicas":9}`, "invalid_choice"},   // over the maximum
		{`{"name":"abc","replicas":0}`, "invalid_choice"},   // under the minimum
		{`{"name":"abc","replicas":"2"}`, "invalid_choice"}, // not a number
		{`{` + ok + `,"public":"yes"}`, "invalid_choice"},   // not a boolean
		{`{` + ok + `,"regions":"eu"}`, "invalid_choice"},   // not a list
		{`{` + ok + `,"regions":null}`, "invalid_choice"},
		{`{"name":null,"replicas":2}`, "invalid_choice"}, // null is no string
		{`{"name":"abc","replicas":null}`, "invalid_choice"},
		{`{` + ok + `,"public":null}`, "invalid_choice"},
		{`{` + ok + `,"regions":[]}`, "invalid_choice"},               // under minItems
		{`{` + ok + `,"regions":["eu","us","ap"]}`, "invalid_choice"}, // over maxItems
		{`{` + ok + `,"regions":["xx"]}`, "invalid_choice"},           // not an option
		{`{` + ok + `,"regions":["e\u0007u"]}`, "invalid_text"},
	} {
		_, answer, err := opencodeChoice(p, json.RawMessage(`{"answer":`+c.answer+`}`))
		code := ""
		if f, isF := err.(*agentFailure); isF {
			code = f.code
		} else if err != nil {
			code = err.Error()
		}
		if code != c.code || (c.code == "" && answer == nil) {
			t.Errorf("%s: %q %v", c.answer, code, answer)
		}
	}
	// A string field with options takes only those, unless custom.
	q := AgentPrompt{Kind: "form", opencodeForm: true, Fields: []PromptField{{Key: "q", Type: "string", Options: []FieldOption{{Value: "A"}}}}}
	if _, _, err := opencodeChoice(q, json.RawMessage(`{"answer":{"q":"B"}}`)); err == nil {
		t.Error("B taken")
	}
	q.Fields[0].Custom = true
	if _, a, err := opencodeChoice(q, json.RawMessage(`{"answer":{"q":"B"}}`)); err != nil || a["q"] != "B" {
		t.Errorf("custom = %v %v", a, err)
	}
	// Choices of another shape.
	for _, raw := range []string{`1`, `"next"`, `{"text":"x"}`, `{"answer":null}`, `{"answer":[1]}`} {
		if _, _, err := opencodeChoice(q, json.RawMessage(raw)); err == nil {
			t.Errorf("%s taken", raw)
		}
	}
	if _, a, err := opencodeChoice(q, json.RawMessage(`"cancel"`)); err != nil || a != nil {
		t.Errorf("cancel = %v %v", a, err)
	}
	// An unsupported card is answered in the terminal only.
	if _, _, err := opencodeChoice(AgentPrompt{Kind: "unsupported", opencodeForm: true}, json.RawMessage(`{"answer":{}}`)); err == nil {
		t.Error("unsupported answered")
	}
	if _, err := opencodeFieldValue(PromptField{Type: "external"}, json.RawMessage(`true`)); err == nil {
		t.Error("external answered")
	}
	perm := AgentPrompt{Kind: "permission"}
	for raw, want := range map[string]string{`1`: "once", `2`: "always", `3`: "reject", `"cancel"`: "reject"} {
		if d, _, err := opencodeChoice(perm, json.RawMessage(raw)); err != nil || d != want {
			t.Errorf("%s = %q %v", raw, d, err)
		}
	}
	for _, raw := range []string{`0`, `4`, `"x"`, `{"answer":{}}`} {
		if _, _, err := opencodeChoice(perm, json.RawMessage(raw)); err == nil {
			t.Errorf("%s taken", raw)
		}
	}
}

// The working line of a turn: its time, and the provider error OpenCode
// retries after (its message, never the response's body).
func TestOpencodeActivity(t *testing.T) {
	oc, f := opencodePane(t, "ses_in5", "working")
	oc.messages["ses_in5"] = testOpencodeMessages(t, "message-list-retry.json")
	busy := time.Now().Add(-75 * time.Second).UnixMilli()
	oc.sessions["ses_in5"] = json.RawMessage(`{"data":{"id":"ses_in5","time":{"created":1,"busy":` + jsonNumber(busy) + `}}}`)
	mux := agentMux(f)
	code, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt")
	act, _ := body["activity"].(map[string]any)
	if code != http.StatusOK || body["prompt"] != nil || act == nil {
		t.Fatalf("prompt = %d %v", code, body)
	}
	retry, _ := act["retry"].(map[string]any)
	if act["label"] != "" || act["elapsed"].(float64) < 75 || retry["attempt"] != 4.0 ||
		retry["error"] != "Rate limited: you've used today's free messages" {
		t.Errorf("activity = %v", act)
	}
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), "free-limit") {
		t.Errorf("the response body reached the client: %s", raw)
	}
	// Thinking, without a retry.
	oc.set(func() {
		oc.messages["ses_in5"] = []json.RawMessage{json.RawMessage(`{"id":"msg_t1","type":"assistant","time":{"created":1},"content":[{"type":"reasoning","text":"hm"}]}`)}
	})
	opencodeReads.forgetPrefix("")
	if _, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt"); body["activity"].(map[string]any)["phase"] != "thinking" {
		t.Errorf("thinking = %v", body)
	}
	// A turn not started, a message done, no message: a line with nothing
	// more; a session that cannot be read: still a line.
	for _, msgs := range [][]json.RawMessage{
		{json.RawMessage(`{"id":"msg_u1","type":"user","text":"hi"}`)},
		{json.RawMessage(`{"id":"msg_a1","type":"assistant","time":{"created":1,"completed":2},"content":[]}`)},
		{},
	} {
		oc.set(func() { oc.messages["ses_in5"] = msgs; delete(oc.sessions, "ses_in5") })
		opencodeReads.forgetPrefix("")
		_, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt")
		if a, _ := body["activity"].(map[string]any); a == nil || a["phase"] != nil || a["retry"] != nil {
			t.Errorf("%s = %v", msgs, body)
		}
	}
	captureLogs(t)
	oc.set(func() { delete(oc.messages, "ses_in5") })
	opencodeReads.forgetPrefix("")
	if _, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt"); body["activity"] == nil {
		t.Errorf("unread = %v", body)
	}
	// Idle: no line.
	f.mu.Lock()
	f.session.Status = "idle"
	f.mu.Unlock()
	opencodeReads.forgetPrefix("")
	time.Sleep(agentCacheTTL)
	if _, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt"); body["activity"] != nil {
		t.Errorf("idle = %v", body)
	}
}

func jsonNumber(n int64) string { b, _ := json.Marshal(n); return string(b) }

// No card while the pane has no session, the service is gone or fails.
func TestOpencodePromptWithoutService(t *testing.T) {
	logs := captureLogs(t)
	oc, f := opencodePane(t, "sesFixP1", "blocked")
	mux := agentMux(f)
	oc.status = http.StatusInternalServerError
	if code, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt"); code != http.StatusOK || body["prompt"] != nil || body["activity"] != nil {
		t.Errorf("failed = %d %v", code, body)
	}
	if strings.Contains(logs.String(), "internal words") || !strings.Contains(logs.String(), "opencode prompt:") {
		t.Errorf("logs = %s", logs)
	}
	oc.status = http.StatusNotFound
	opencodeReads.forgetPrefix("")
	if _, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt"); body["prompt"] != nil {
		t.Errorf("not found = %v", body)
	}
	stubOpencodeStateDir(t, t.TempDir())
	opencodeReads.forgetPrefix("")
	if _, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt"); body["prompt"] != nil {
		t.Errorf("no service = %v", body)
	}
	f.mu.Lock()
	f.session.ID = ""
	f.mu.Unlock()
	time.Sleep(agentCacheTTL)
	// As for any agent without a session: no card to read.
	if code, body := getJSON(t, mux, "/api/mux/panes/0/agent/prompt"); code != http.StatusNotFound || body["prompt"] != nil {
		t.Errorf("no session = %d %v", code, body)
	}
}

// The client's write methods refuse ids of another shape before a request.
func TestOpencodeClientWriteIDs(t *testing.T) {
	oc := newFakeOpencode(t)
	c, err := opencodeConnect()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, err := range []error{
		c.prompt(ctx, "x/../y", "hi", nil),
		c.permissionReply(ctx, "sesA1", "../per", "once"),
		c.formReply(ctx, "sesA1", "frm_1/../x", nil),
		func() error { _, err := c.busySince(ctx, "nope"); return err }(),
	} {
		if err != errOpencodeNotFound {
			t.Errorf("err = %v", err)
		}
	}
	if w := oc.writes(); len(w) != 0 {
		t.Errorf("writes = %v", w)
	}
	// A refused password drops the service, as a read does.
	oc.set(func() { oc.writeStatus = http.StatusUnauthorized })
	oc.messages["sesA1"] = nil
	if err := c.prompt(ctx, "sesA1", "hi", nil); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Errorf("401 = %v", err)
	}
	if _, cached := opencodeServices.peek(""); cached {
		t.Error("the service was kept after a refused password")
	}
}

// A refused answer gives its id back, unless a poll during the write
// already issued another one for the same dialog: never two at once.
func TestRestorePromptKeepsOneID(t *testing.T) {
	in := newAgentInput()
	s := AgentSession{Agent: "opencode", ID: "sesA1"}
	id := in.issuePrompt("0", s, "frm:frm_1", AgentPrompt{Kind: "form"})
	rec, err := in.consumePrompt("0", id, func(*promptRecord) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	other := in.issuePrompt("0", s, "frm:frm_1", AgentPrompt{Kind: "form"})
	in.restorePrompt(rec)
	if _, ok := in.prompts[id]; ok || len(in.prompts) != 1 || in.prompts[other] == nil {
		t.Errorf("prompts = %v", in.prompts)
	}
	in.prompts = map[string]*promptRecord{}
	in.restorePrompt(rec)
	if in.prompts[id] == nil {
		t.Error("not restored")
	}
}

// A message the service refuses is not one to try again.
func TestOpencodeMessageRefused(t *testing.T) {
	oc, f := opencodePane(t, "sesFixP1", "idle")
	oc.writeStatus = http.StatusBadRequest
	code, body := postJSON(t, agentMux(f), "/api/mux/panes/0/agent/message", map[string]any{"text": "hi", "cursor": opencodeCursor("sesFixP1")})
	if code != http.StatusBadRequest || body["code"] != "invalid_request" {
		t.Errorf("refused = %d %v", code, body)
	}
}
