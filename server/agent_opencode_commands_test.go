package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// opencodeCommandsPane is an OpenCode pane whose session works in /work/proj,
// with the commands route registered.
func opencodeCommandsPane(t *testing.T, status string) (*fakeOpencode, *fakeWriter, *http.ServeMux) {
	oc, f, mux, _ := opencodeCommandsAPI(t, status)
	return oc, f, mux
}

func opencodeCommandsAPI(t *testing.T, status string) (*fakeOpencode, *fakeWriter, *http.ServeMux, *agentAPI) {
	t.Helper()
	oc, f := opencodePane(t, "sesFixP1", status)
	oc.sessions["sesFixP1"] = json.RawMessage(`{"data":{"id":"sesFixP1","location":{"directory":"/work/proj"}}}`)
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, f, newStreamTokenStore(), nil, nil)
	agent.registerCommandsRoute(mux, nil, parseAllowedHosts("", false))
	return oc, f, mux, agent
}

const opencodeCommandsPath = "/api/mux/panes/0/agent/commands"

// The commands route lists the service's commands and skills for the
// session's directory: names, one-line descriptions and sources, never a
// skill's file or path.
func TestOpencodeCommandsRoute(t *testing.T) {
	oc, _, mux := opencodeCommandsPane(t, "idle")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, opencodeCommandsPath, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d %s", rec.Code, rec.Body)
	}
	for _, leak := range []string{"SECRET-BODY-LINE", "USER-BODY", "/work/proj", "skill://", "content", testOpencodePassword} {
		if strings.Contains(rec.Body.String(), leak) {
			t.Errorf("reply holds %q: %s", leak, rec.Body)
		}
	}
	var res commandsResponse
	json.Unmarshal(rec.Body.Bytes(), &res)
	got := map[string]agentCommand{}
	for _, c := range res.Commands {
		got[c.Kind+":"+c.Name] = c
	}
	want := map[string]string{
		"command:init": "custom", "command:review": "custom", "command:goal": "custom",
		"command:spike-cmd": "custom", "command:proj-cmd": "custom",
		"skill:opencode": "system", "skill:report": "system", "skill:browser": "system",
		"skill:user-skill": "user", "skill:proj-skill": "project",
	}
	if len(got) != len(want) {
		t.Fatalf("commands = %v", res.Commands)
	}
	for k, source := range want {
		if got[k].Source != source {
			t.Errorf("%s = %+v, want source %s", k, got[k], source)
		}
	}
	if d := got["command:spike-cmd"].Description; d != "A spike command" {
		t.Errorf("description = %q", d)
	}
	// OpenCode's own skill description is long: cut to commandDescMax.
	if d := []rune(got["skill:opencode"].Description); len(d) != commandDescMax || d[len(d)-1] != '…' {
		t.Errorf("long description = %q", string(d))
	}
	for _, l := range oc.locations {
		if l != "/work/proj" {
			t.Errorf("listed for %q", l)
		}
	}
}

// Names the composer could not send, and descriptions on several lines or
// with escapes, are cleaned; the lists are capped.
func TestOpencodeAgentCommandsCleans(t *testing.T) {
	cmds := []opencodeCommandInfo{{Name: "ok", Description: "two\nlines \x1b[31mred\x1b[0m"}}
	skills := []opencodeSkillInfo{{ID: "s", Path: "/elsewhere/s/SKILL.md"}, {ID: "p", Path: "/work/proj/a/SKILL.md"}, {ID: "r", Path: "relative/SKILL.md"}}
	res := opencodeAgentCommands("/work/proj", cmds, skills).Commands
	if res[0].Description != "two lines red" {
		t.Errorf("description = %q", res[0].Description)
	}
	if res[1].Source != "user" || res[2].Source != "project" || res[3].Source != "user" {
		t.Errorf("sources = %+v", res)
	}
	oc := newFakeOpencode(t)
	var many []map[string]string
	for i := 0; i < commandsMaxPerSource+5; i++ {
		many = append(many, map[string]string{"name": "c" + strings.Repeat("x", i%3) + string(rune('a'+i%26)) + jsonNumber(int64(i)), "id": "s" + jsonNumber(int64(i))})
	}
	many = append(many, map[string]string{"name": "bad name", "id": "bad id"})
	list, _ := json.Marshal(map[string]any{"data": many})
	oc.commandList, oc.skillList = list, list
	c, err := opencodeConnect()
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.commands(t.Context(), "/work/proj")
	if err != nil || len(got) != commandsMaxPerSource {
		t.Errorf("commands = %d %v", len(got), err)
	}
	gotSkills, err := c.skills(t.Context(), "/work/proj")
	if err != nil || len(gotSkills) != commandsMaxPerSource {
		t.Errorf("skills = %d %v", len(gotSkills), err)
	}
	oc.commandList = json.RawMessage(`{"data":[{"name":"bad name"},{"name":"good"}]}`)
	if got, _ := c.commands(t.Context(), "/work/proj"); len(got) != 1 || got[0].Name != "good" {
		t.Errorf("invalid name kept: %v", got)
	}
}

// A view-only client gets no command (it runs none) and the service is not
// asked; a session not made yet, no service or a failing list is an empty
// list, the service's words never logged.
func TestOpencodeCommandsRouteEmpty(t *testing.T) {
	logs := captureLogs(t)
	oc, _, mux, agent := opencodeCommandsAPI(t, "idle")
	reset := func() { agent.commands.forgetPrefix("") }
	get := func(view bool) []agentCommand {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, opencodeCommandsPath, nil)
		if view {
			req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
		}
		code, cmds := getCommands(t, mux, req)
		if code != http.StatusOK || cmds == nil {
			t.Fatalf("GET = %d %v", code, cmds)
		}
		return cmds
	}
	if cmds := get(true); len(cmds) != 0 || len(oc.reqs()) != 0 {
		t.Errorf("view = %v, requests %v", cmds, oc.reqs())
	}
	delete(oc.sessions, "sesFixP1")
	if cmds := get(false); len(cmds) != 0 {
		t.Errorf("not made = %v", cmds)
	}
	reset()
	oc.sessions["sesFixP1"] = json.RawMessage(`{"data":{"id":"sesFixP1","location":{}}}`)
	if cmds := get(false); len(cmds) != 0 {
		t.Errorf("no dir = %v", cmds)
	}
	reset()
	oc.sessions["sesFixP1"] = json.RawMessage(`{"data":{"id":"sesFixP1","location":{"directory":"/work/proj"}}}`)
	oc.listStatus = http.StatusInternalServerError
	if cmds := get(false); len(cmds) != 0 {
		t.Errorf("failing list = %v", cmds)
	}
	reset()
	oc.commandList, oc.listStatus = nil, 0
	oc.skillList = json.RawMessage(`{"data":[`)
	if cmds := get(false); len(cmds) != 0 {
		t.Errorf("bad skills = %v", cmds)
	}
	reset()
	stubOpencodeStateDir(t, t.TempDir())
	if cmds := get(false); len(cmds) != 0 {
		t.Errorf("no service = %v", cmds)
	}
	if s := logs.String(); strings.Contains(s, "list words") || !strings.Contains(s, "opencode commands:") {
		t.Errorf("logs = %s", s)
	}
}

func opencodeSend(t *testing.T, mux http.Handler, text string) (int, map[string]any) {
	t.Helper()
	return postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": text, "cursor": opencodeCursor("sesFixP1")})
}

// A "/name" the session's list holds runs that command with the rest as its
// arguments, queued as a message is; any other "/name" is text.
func TestOpencodeCommandSend(t *testing.T) {
	oc, f, mux := opencodeCommandsPane(t, "idle")
	cases := []struct {
		text, write, name, body string
	}{
		{"/spike-cmd world", "command", "spike-cmd", "world"},
		{"  /spike-cmd\n  two\nlines ", "command", "spike-cmd", "two\nlines"},
		{"/init", "command", "init", ""},
		{"/nope x", "prompt", "", "/nope x"},
		{"/spike-cmdx", "prompt", "", "/spike-cmdx"},
		{"say /spike-cmd", "prompt", "", "say /spike-cmd"},
	}
	for _, c := range cases {
		if code, body := opencodeSend(t, mux, c.text); code != http.StatusNoContent {
			t.Fatalf("%q = %d %v", c.text, code, body)
		}
		w := oc.writes()
		if w[len(w)-1] != "POST /api/session/sesFixP1/"+c.write {
			t.Errorf("%q went to %v", c.text, w[len(w)-1])
		}
		b := oc.lastBody(t)
		if c.name != "" && b["name"] != c.name {
			t.Errorf("%q name = %v", c.text, b["name"])
		}
		if b["text"] != c.body || b["delivery"] != "queue" || b["skills"] != nil {
			t.Errorf("%q body = %v", c.text, b)
		}
	}
	if len(f.pasted) != 0 || len(f.keys) != 0 {
		t.Errorf("typed into the pane: %q %v", f.pasted, f.keys)
	}
	// A plain message reads no list.
	n := len(oc.reqs())
	opencodeSend(t, mux, "hello there")
	for _, r := range oc.reqs()[n:] {
		if strings.Contains(r, "/api/command") || strings.Contains(r, "/api/skill") {
			t.Errorf("plain message read %s", r)
		}
	}
	// A command to a session running a turn is queued too.
	f.mu.Lock()
	f.session.Status = "working"
	f.mu.Unlock()
	if code, body := opencodeSend(t, mux, "/spike-cmd later"); code != http.StatusAccepted {
		t.Errorf("working = %d %v", code, body)
	}
}

// A "/name" after an image is text; images go with a command before them.
func TestOpencodeCommandImages(t *testing.T) {
	oc, f, _ := opencodeCommandsPane(t, "idle")
	mux, ids, _ := imageMux(t, f, 1)
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": "/spike-cmd look", "images": ids, "at": []int{15}, "cursor": opencodeCursor("sesFixP1")}); code != http.StatusNoContent {
		t.Fatalf("command = %d %v", code, body)
	}
	if b := oc.lastBody(t); b["name"] != "spike-cmd" || b["text"] != "look" || len(b["files"].([]any)) != 1 {
		t.Errorf("command body = %.200v", b)
	}
	if code, body := postJSON(t, mux, "/api/mux/panes/0/agent/message", map[string]any{"text": " /spike-cmd", "images": ids, "at": []int{0}, "cursor": opencodeCursor("sesFixP1")}); code != http.StatusNoContent {
		t.Fatalf("after image = %d %v", code, body)
	}
	if w := oc.writes(); w[len(w)-1] != "POST /api/session/sesFixP1/prompt" {
		t.Errorf("after image went to %v", w)
	}
}

// "@name" words the session's skill list holds attach those skills, each
// once, with where they stand in the text (UTF-16, as OpenCode counts).
func TestOpencodeSkillSend(t *testing.T) {
	oc, _, mux := opencodeCommandsPane(t, "idle")
	if code, body := opencodeSend(t, mux, "héllo 😀 @proj-skill, @nope and @proj-skill. @user-skill:"); code != http.StatusNoContent {
		t.Fatalf("POST = %d %v", code, body)
	}
	b := oc.lastBody(t)
	skills, _ := b["skills"].([]any)
	if len(skills) != 2 {
		t.Fatalf("skills = %v", b["skills"])
	}
	first := skills[0].(map[string]any)
	m := first["mention"].(map[string]any)
	// "héllo 😀 " is 9 UTF-16 units: the emoji takes two.
	if first["id"] != "proj-skill" || m["start"] != 9.0 || m["end"] != 20.0 || m["text"] != "@proj-skill" {
		t.Errorf("first = %v", first)
	}
	if skills[1].(map[string]any)["id"] != "user-skill" {
		t.Errorf("second = %v", skills[1])
	}
	if b["text"] != "héllo 😀 @proj-skill, @nope and @proj-skill. @user-skill:" {
		t.Errorf("text = %v", b["text"])
	}
	// A skill named in a command's arguments goes with the command.
	opencodeSend(t, mux, "/spike-cmd use @proj-skill")
	b = oc.lastBody(t)
	skills, _ = b["skills"].([]any)
	if b["name"] != "spike-cmd" || len(skills) != 1 || skills[0].(map[string]any)["mention"].(map[string]any)["start"] != 4.0 {
		t.Errorf("command with skill = %v", b)
	}
	// After a Unicode space (an ideographic one) as after an ASCII one.
	opencodeSend(t, mux, "dùng\u3000@proj-skill")
	if b := oc.lastBody(t); b["skills"] == nil {
		t.Errorf("after U+3000 = %v", b)
	}
	opencodeSend(t, mux, "/spike-cmd\u00a0now")
	if b := oc.lastBody(t); b["name"] != "spike-cmd" || b["text"] != "now" {
		t.Errorf("command before U+00A0 = %v", b)
	}
	// Mail addresses and unlisted names attach nothing.
	opencodeSend(t, mux, "mail a@proj-skill or @Nope")
	if b := oc.lastBody(t); b["skills"] != nil {
		t.Errorf("skills = %v", b["skills"])
	}
}

func TestPlanOpencodeMessageLimits(t *testing.T) {
	var skills []opencodeSkillInfo
	var words []string
	for i := 0; i < opencodeMaxSkills+4; i++ {
		id := "s" + jsonNumber(int64(i))
		skills = append(skills, opencodeSkillInfo{ID: id})
		words = append(words, "@"+id)
	}
	p := planOpencodeMessage("", strings.Join(words, " "), nil, skills)
	if len(p.skills) != opencodeMaxSkills {
		t.Errorf("skills = %d", len(p.skills))
	}
	// A name of a skill that ends in a dash keeps it.
	p = planOpencodeMessage("", "@a- @b-", nil, []opencodeSkillInfo{{ID: "a-"}, {ID: "b"}})
	if len(p.skills) != 2 || p.skills[0].ID != "a-" || p.skills[1].ID != "b" {
		t.Errorf("skills = %+v", p.skills)
	}
}

// A session not made yet runs no command; a failing list sends nothing and
// tells the client only a code; a command gone between the list and the
// send goes as text.
func TestOpencodeCommandSendRefusals(t *testing.T) {
	logs := captureLogs(t)
	oc, _, mux := opencodeCommandsPane(t, "idle")
	delete(oc.sessions, "sesFixP1")
	if code, body := opencodeSend(t, mux, "/spike-cmd"); code != http.StatusConflict || body["code"] != "input_not_ready" {
		t.Errorf("not made = %d %v", code, body)
	}
	oc.sessions["sesFixP1"] = json.RawMessage(`{"data":{"id":"sesFixP1","location":{"directory":"/work/proj"}}}`)
	// A command list that cannot be read (a failure, a 404 from a build
	// without the route) sends nothing: the message meant a command.
	for _, status := range []int{http.StatusInternalServerError, http.StatusNotFound} {
		oc.listStatus = status
		code, body := opencodeSend(t, mux, "/spike-cmd")
		if code != http.StatusBadGateway || body["code"] != "agent_unavailable" {
			t.Errorf("%d failing list = %d %v", status, code, body)
		}
	}
	if len(oc.writes()) != 0 {
		t.Errorf("writes = %v", oc.writes())
	}
	// A skill list that cannot be read attaches none: "@" may name a person.
	if code, body := opencodeSend(t, mux, "ping @proj-skill"); code != http.StatusNoContent {
		t.Errorf("failing skills = %d %v", code, body)
	}
	if b := oc.lastBody(t); b["text"] != "ping @proj-skill" || b["skills"] != nil {
		t.Errorf("failing skills body = %v", b)
	}
	if s := logs.String(); strings.Contains(s, "list words") || !strings.Contains(s, "opencode message:") {
		t.Errorf("logs = %s", s)
	}
	oc.listStatus = 0
	oc.bodies = nil
	oc.requests = nil
	oc.goneCommand = "spike-cmd"
	if code, body := opencodeSend(t, mux, "/spike-cmd @proj-skill now"); code != http.StatusNoContent {
		t.Fatalf("gone = %d %v", code, body)
	}
	w := oc.writes()
	if len(w) != 2 || w[0] != "POST /api/session/sesFixP1/command" || w[1] != "POST /api/session/sesFixP1/prompt" {
		t.Errorf("gone writes = %v", w)
	}
	b := oc.lastBody(t)
	skills, _ := b["skills"].([]any)
	if b["text"] != "/spike-cmd @proj-skill now" || len(skills) != 1 || skills[0].(map[string]any)["mention"].(map[string]any)["start"] != 11.0 {
		t.Errorf("gone body = %v", b)
	}
	// The service refuses the command: the client is told without its words.
	oc.goneCommand = ""
	oc.writeStatus = http.StatusInternalServerError
	if code, body := opencodeSend(t, mux, "/spike-cmd"); code != http.StatusBadGateway || strings.Contains(body["error"].(string), "words") {
		t.Errorf("failed = %d %v", code, body)
	}
}

func TestOpencodeRunCommandIDs(t *testing.T) {
	oc := newFakeOpencode(t)
	c, err := opencodeConnect()
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range []error{
		c.runCommand(t.Context(), "x/../y", "init", "", nil, nil),
		c.runCommand(t.Context(), "sesA1", "../x", "", nil, nil),
	} {
		if e != errOpencodeNotFound {
			t.Errorf("err = %v", e)
		}
	}
	if _, err := c.sessionDir(t.Context(), "x/../y"); err != errOpencodeNotFound {
		t.Errorf("sessionDir = %v", err)
	}
	if len(oc.reqs()) != 1 { // /api/info
		t.Errorf("requests = %v", oc.reqs())
	}
}

// The permission card names its action for the client to word it.
func TestOpencodePermissionCardAction(t *testing.T) {
	p := opencodePermissionCard(opencodePending{ID: "per_a", Action: "shell"})
	if p.Action != "shell" || p.Title != "Allow shell?" {
		t.Errorf("card = %+v", p)
	}
	p = opencodePermissionCard(opencodePending{ID: "per_a"})
	if p.Action != "" || p.Title != "Allow a tool?" {
		t.Errorf("no action = %+v", p)
	}
}
