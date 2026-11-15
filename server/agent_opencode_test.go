package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpencodeTUIArgs(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		tui     bool
		session string
	}{
		{nil, true, ""},
		{[]string{"--session", "ses_abc123"}, true, "ses_abc123"},
		{[]string{"-s", "sesSpikeB1"}, true, "sesSpikeB1"},
		{[]string{"--session=ses_abc123", "/work"}, true, "ses_abc123"},
		{[]string{"/work", "-s=ses_x"}, true, "ses_x"},
		{[]string{"--auto", "-c"}, true, ""},
		{[]string{"--session"}, true, ""},
		{[]string{"--session", "../../x"}, true, ""},
		{[]string{"--session", "abc"}, true, ""},
		{[]string{"--standalone", "--session", "ses_a"}, true, ""},
		{[]string{"--server", "http://h:1", "-s", "ses_a"}, true, ""},
		{[]string{"--server=http://h:1", "-s", "ses_a"}, true, ""},
		{[]string{"--prompt", "serve", "-s", "ses_a"}, true, "ses_a"},
		{[]string{"--log-level=debug", "run"}, false, ""},
		{[]string{"serve", "--service"}, false, ""},
		{[]string{"--print-logs", "api", "GET", "/api/info"}, false, ""},
		{[]string{"mini"}, false, ""},
		{[]string{"--version"}, false, ""},
		{[]string{"/work", "serve"}, true, ""},
		{[]string{"--", "serve"}, true, ""},
	} {
		tui, session := opencodeTUIArgs(tc.args)
		if tui != tc.tui || session != tc.session {
			t.Errorf("opencodeTUIArgs(%q) = %v, %q; want %v, %q", tc.args, tui, session, tc.tui, tc.session)
		}
	}
}

func TestOpencodeIDs(t *testing.T) {
	for id, ok := range map[string]bool{
		"ses_e22caccceffe0hL76lTTiemGdN": true, "sesSpikeB1": true, "ses": false, "ses-x": false,
		"ses_a/../b": false, "msg_1": false, "ses" + strings.Repeat("a", 65): false, "": false,
	} {
		if isOpencodeSessionID(id) != ok {
			t.Errorf("isOpencodeSessionID(%q) = %v", id, !ok)
		}
	}
}

func TestOpencodeLoopbackURL(t *testing.T) {
	for raw, want := range map[string]string{
		"http://127.0.0.1:49374":  "http://127.0.0.1:49374",
		"http://127.0.0.1:49374/": "http://127.0.0.1:49374",
		"http://[::1]:5":          "http://[::1]:5",
		"http://127.5.0.1:80":     "http://127.5.0.1:80",
		"http://localhost:49374":  "",
		"http://10.0.0.2:49374":   "",
		"https://127.0.0.1:49374": "",
		"http://127.0.0.1":        "",
		"http://127.0.0.1:0":      "",
		"http://127.0.0.1:70000":  "",
		"http://u:p@127.0.0.1:1":  "",
		"http://127.0.0.1:1/api":  "",
		"http://127.0.0.1:1/?a=b": "",
		"http://127.0.0.1:1/#x":   "",
		"127.0.0.1:1":             "",
		"::":                      "",
	} {
		u, ok := opencodeLoopbackURL(raw)
		got := ""
		if ok {
			got = u.String()
		}
		if got != want {
			t.Errorf("opencodeLoopbackURL(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestOpencodeStateDirDefault(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_STATE_HOME", xdg)
	if d := opencodeDefaultStateDir(); d != xdg {
		t.Errorf("XDG_STATE_HOME: %q", d)
	}
	// os.UserHomeDir reads HOME, or USERPROFILE on Windows.
	home := t.TempDir()
	t.Setenv("XDG_STATE_HOME", "relative")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if d, want := opencodeDefaultStateDir(), filepath.Join(home, ".local", "state"); d != want {
		t.Errorf("home: %q, want %q", d, want)
	}
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	if d := opencodeDefaultStateDir(); d != "" {
		t.Errorf("no home: %q", d)
	}
}

func TestOpencodeConnect(t *testing.T) {
	f := newFakeOpencode(t)
	c, err := opencodeConnect()
	if err != nil || c.pid != 4242 {
		t.Fatalf("connect: %v", err)
	}
	// One check for every lookup within the TTL.
	opencodeConnect()
	if n := len(f.reqs()); n != 1 {
		t.Errorf("requests = %d, want 1 (cached)", n)
	}

	state := t.TempDir()
	stubOpencodeStateDir(t, state)
	if _, err := opencodeConnect(); !errors.Is(err, errOpencodeUnavailable) {
		t.Errorf("no service file: %v", err)
	}
	good := map[string]any{"url": f.srv.URL, "pid": 4242, "version": "2.3.0", "password": f.password}
	with := func(k string, v any) map[string]any {
		m := map[string]any{}
		for k, v := range good {
			m[k] = v
		}
		m[k] = v
		return m
	}
	for name, file := range map[string]any{
		"wrong password":  with("password", "nope"),
		"no password":     with("password", ""),
		"another pid":     with("pid", 1),
		"no pid":          with("pid", 0),
		"another version": with("version", "2.2.0"),
		"remote url":      with("url", "http://192.0.2.1:1"),
		"not json":        "{",
	} {
		before := len(f.reqs())
		f.writeServiceFile(state, file)
		if _, err := opencodeConnect(); !errors.Is(err, errOpencodeUnavailable) {
			t.Errorf("%s: %v", name, err)
		}
		if name == "remote url" && len(f.reqs()) != before {
			t.Errorf("remote url: a request was sent")
		}
	}
	f.writeServiceFile(state, good)
	f.set(func() { f.version = "1.14.0" })
	if _, err := opencodeConnect(); !errors.Is(err, errOpencodeUnavailable) {
		t.Errorf("version 1: %v", err)
	}
	f.set(func() { f.version = "2.3.0" })
	resetOpencodeCaches()
	if _, err := opencodeConnect(); err != nil {
		t.Errorf("back: %v", err)
	}
	// A refused password drops the cached service.
	f.set(func() { f.password = "rotated" })
	c, _ = opencodeConnect()
	if _, err := c.active(context.Background()); !errors.Is(err, errOpencodeUnavailable) {
		t.Errorf("refused: %v", err)
	}
	if _, ok := opencodeServices.peek(""); ok {
		t.Error("service still cached after a 401")
	}
}

func TestOpencodeForeignPort(t *testing.T) {
	f := newFakeOpencode(t)
	opencodeHTTP.CloseIdleConnections()
	prev := opencodeConnCheck
	t.Cleanup(func() { opencodeConnCheck = prev })
	for _, code := range []int{healthUntrusted, healthUnverified} {
		opencodeConnCheck = func(int, net.Conn) int { return code }
		resetOpencodeCaches()
		if _, err := opencodeConnect(); !errors.Is(err, errOpencodeUnavailable) {
			t.Errorf("%d: %v", code, err)
		}
	}
	if n := len(f.reqs()); n != 0 {
		t.Errorf("the password went to another user's port: %v", f.reqs())
	}
	// A failed check is not repeated within opencodeRetry, then is.
	opencodeConnCheck = prev
	if _, err := opencodeConnect(); !errors.Is(err, errOpencodeUnavailable) {
		t.Errorf("within the retry delay: %v", err)
	}
	opencodeDown.forgetPrefix("")
	if _, err := opencodeConnect(); err != nil {
		t.Errorf("after the retry delay: %v", err)
	}
}

func TestOpencodeServiceGone(t *testing.T) {
	f := newFakeOpencode(t)
	f.srv.Close()
	if _, err := opencodeConnect(); !errors.Is(err, errOpencodeUnavailable) {
		t.Errorf("closed service: %v", err)
	}
}

func TestOpencodeStatus(t *testing.T) {
	f := newFakeOpencode(t)
	c, err := opencodeConnect()
	if err != nil {
		t.Fatal(err)
	}
	if s := opencodeStatus(c, "sesFixP1"); s != "idle" {
		t.Errorf("idle: %q", s)
	}
	f.set(func() { f.active = []string{"sesFixP1", "not a session"} })
	if s := opencodeStatus(c, "sesFixP1"); s != "working" {
		t.Errorf("working: %q", s)
	}
	f.set(func() { f.permissions["sesFixP1"] = testOpencodeFixture(t, "permission-list.json") })
	if s := opencodeStatus(c, "sesFixP1"); s != "blocked" {
		t.Errorf("blocked on a permission: %q", s)
	}
	// A request of another session, or of an odd id, does not count.
	f.set(func() {
		f.permissions["sesFixP1"] = json.RawMessage(`{"data":[{"id":"per_1","sessionID":"sesOther"},{"id":"x","sessionID":"sesFixP1"}]}`)
	})
	if s := opencodeStatus(c, "sesFixP1"); s != "working" {
		t.Errorf("other session's permission: %q", s)
	}
	f.set(func() {
		f.active = []string{"sesFixQ1"}
		f.forms["sesFixQ1"] = testOpencodeFixture(t, "form-list.json")
	})
	if s := opencodeStatus(c, "sesFixQ1"); s != "blocked" {
		t.Errorf("blocked on a form: %q", s)
	}
	f.set(func() { f.status = http.StatusInternalServerError })
	if s := opencodeStatus(c, "sesFixQ1"); s != "unknown" {
		t.Errorf("service error: %q", s)
	}
	// One read of the active sessions for every pane.
	f.set(func() { f.status, f.requests = 0, nil })
	for range 3 {
		opencodeStatus(c, "sesA")
		opencodeStatus(c, "sesB")
	}
	if n := len(f.reqs()); n != 1 {
		t.Errorf("requests = %d (%v), want 1", n, f.reqs())
	}
	f.set(func() { f.active = []string{"sesFixQ1"}; f.status = 0 })
	opencodeActive.do("", func() (map[string]bool, error) { return map[string]bool{"sesFixQ1": true}, nil })
	f.set(func() { f.status = http.StatusBadGateway })
	opencodeActive.do("", func() (map[string]bool, error) { return map[string]bool{"sesFixQ1": true}, nil })
	if s := opencodeStatus(c, "sesFixQ1"); s != "working" {
		t.Errorf("pending unreadable: %q", s)
	}
}

func TestOpencodeSessionOf(t *testing.T) {
	f := newFakeOpencode(t)
	f.set(func() { f.active = []string{"sesFixP1"} })
	s, ok := opencodeSessionOf(claudeProc{agent: "opencode", pid: 7, procStart: "9", opencodeSession: "sesFixP1"})
	if !ok || s.Agent != "opencode" || s.ID != "sesFixP1" || s.Status != "working" || s.PID != 7 {
		t.Errorf("session = %+v", s)
	}
	s, ok = opencodeSessionOf(claudeProc{agent: "opencode", pid: 7})
	if !ok || s.ID != "" || s.Status != "unknown" {
		t.Errorf("no --session = %+v", s)
	}
	f.srv.Close()
	resetOpencodeCaches()
	s, ok = opencodeSessionOf(claudeProc{agent: "opencode", pid: 7, opencodeSession: "sesFixP1"})
	if !ok || s.ID != "" || s.Status != "unknown" {
		t.Errorf("service down = %+v", s)
	}
	if s, ok := sessionOfProc(claudeProc{agent: "opencode"}); !ok || s.Agent != "opencode" {
		t.Errorf("sessionOfProc = %+v", s)
	}
}

// testOpencodeRead reads the pane's transcript the way handleTranscript does.
func testOpencodeRead(t *testing.T, id, status, cursor, before string) transcriptResponse {
	t.Helper()
	res, err := readTranscript(AgentSession{Agent: "opencode", ID: id, Status: status}, cursor, before)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return res
}

func TestOpencodeTranscript(t *testing.T) {
	f := newFakeOpencode(t)
	msgs := testOpencodeMessages(t, "message-list-after-tool.json")
	// The question and its tool call waiting on a permission: not settled.
	f.set(func() { f.messages["sesFixP1"] = testOpencodeMessages(t, "message-list-permission-pending.json") })
	res := testOpencodeRead(t, "sesFixP1", "blocked", "", "")
	if !res.Reset || res.Agent != "opencode" || res.SessionID != "sesFixP1" || res.Status != "blocked" {
		t.Fatalf("first read = %+v", res)
	}
	if len(res.Entries) != 1 || res.Entries[0].Role != "user" || res.Entries[0].Parts[0].Text != "PERM please" {
		t.Fatalf("an answer still being written was sent: %+v", res.Entries)
	}
	if res.Before != "" {
		t.Errorf("before at the start: %q", res.Before)
	}

	f.set(func() { f.messages["sesFixP1"] = msgs })
	next := testOpencodeRead(t, "sesFixP1", "idle", res.Cursor, "")
	if next.Reset {
		t.Fatal("cursor read reset")
	}
	var roles []string
	for _, e := range next.Entries {
		roles = append(roles, e.Role)
	}
	if strings.Join(roles, ",") != "assistant,assistant" {
		t.Fatalf("new entries = %v", roles)
	}
	tool := next.Entries[0].Parts[0]
	if tool.Kind != "tool" || tool.Tool != "shell" || tool.Input != "touch spike-file.txt" || tool.Orphan ||
		tool.Detail == nil || tool.Detail.Command != "touch spike-file.txt" || tool.Detail.Description != "Create a file" {
		t.Errorf("tool part = %+v %+v", tool, tool.Detail)
	}
	if next.Entries[1].Parts[0].Text != "Done after tool." {
		t.Errorf("answer = %+v", next.Entries[1])
	}
	// Nothing new: no entry, same position.
	again := testOpencodeRead(t, "sesFixP1", "idle", next.Cursor, "")
	if again.Reset || len(again.Entries) != 0 {
		t.Errorf("idle read = %+v", again)
	}

	// A cursor of another session, or of a Claude transcript, starts over.
	for _, c := range []agentCursor{{Session: "sesOther", File: opencodeCursorAfter}, {Session: "sesFixP1", Offset: 10, File: "1:2"}} {
		if r := testOpencodeRead(t, "sesFixP1", "idle", encodeCursor(c), ""); !r.Reset || len(r.Entries) != 3 {
			t.Errorf("cursor %+v: reset=%v entries=%d", c, r.Reset, len(r.Entries))
		}
	}
	// The client's last message gone further back than the pages read.
	var many []json.RawMessage
	for i := range 290 {
		many = append(many, json.RawMessage(`{"id":"msg_`+strings.Repeat("0", 3)+string(rune('a'+i/26%26))+string(rune('a'+i%26))+`","type":"user","text":"m","time":{"created":1}}`))
	}
	f.set(func() { f.messages["sesMany"] = many })
	first := testOpencodeRead(t, "sesMany", "idle", "", "")
	if len(first.Entries) != opencodeTailMessages || first.Before == "" {
		t.Fatalf("tail = %d entries, before %q", len(first.Entries), first.Before)
	}
	older := testOpencodeRead(t, "sesMany", "idle", "", first.Before)
	if older.Reset || len(older.Entries) != opencodeTailMessages || older.Entries[len(older.Entries)-1].ID >= first.Entries[0].ID {
		t.Fatalf("older page = %d entries", len(older.Entries))
	}
	oldest := testOpencodeRead(t, "sesMany", "idle", "", older.Before)
	if len(oldest.Entries) != 90 || oldest.Before != "" {
		t.Errorf("oldest page = %d entries, before %q", len(oldest.Entries), oldest.Before)
	}
	stale := encodeCursor(agentCursor{Session: "sesMany", File: opencodeCursorAfter + "msg_000aa"})
	if r := testOpencodeRead(t, "sesMany", "idle", stale, ""); !r.Reset {
		t.Error("a cursor further back than the pages read did not start over")
	}
	// A before of another session starts over; one that is not a before is refused.
	if r := testOpencodeRead(t, "sesFixP1", "idle", "", first.Before); !r.Reset {
		t.Error("before of another session")
	}
	// A before of another agent (the pane ran Claude Code) starts over too;
	// one the server never signed is refused.
	if r := testOpencodeRead(t, "sesFixP1", "idle", "", next.Cursor); !r.Reset || len(r.Entries) != 3 {
		t.Errorf("forward cursor as before: %+v", r)
	}
	if _, err := readTranscript(AgentSession{Agent: "opencode", ID: "sesFixP1"}, "", "x.y"); !errors.Is(err, errInvalidBefore) {
		t.Errorf("forged before: %v", err)
	}
}

func TestOpencodeSettled(t *testing.T) {
	msg := func(id, typ string, completed float64, status string) opencodeMessage {
		m := opencodeMessage{ID: id, Type: typ, Status: status}
		m.Time.Completed = completed
		return m
	}
	ids := func(ms []opencodeMessage) (out []string) {
		for _, m := range ms {
			out = append(out, m.ID)
		}
		return out
	}
	for name, tc := range map[string]struct {
		msgs []opencodeMessage
		want []string
		last string
	}{
		"open answer at the end": {[]opencodeMessage{msg("u1", "user", 0, ""), msg("a1", "assistant", 0, "")}, []string{"u1"}, "u1"},
		// A turn interrupted mid-answer still ends with idle.
		"open answer before idle":    {[]opencodeMessage{msg("a1", "assistant", 0, ""), msg("i1", "idle", 0, ""), msg("u2", "user", 0, "")}, []string{"a1", "i1", "u2"}, "u2"},
		"a step done, the next open": {[]opencodeMessage{msg("i0", "idle", 0, ""), msg("a1", "assistant", 5, ""), msg("a2", "assistant", 0, ""), msg("u3", "user", 0, "")}, []string{"i0", "a1"}, "a1"},
		"running compaction":         {[]opencodeMessage{msg("c1", "compaction", 0, "running")}, nil, "prev"},
		"running shell":              {[]opencodeMessage{msg("u1", "user", 0, ""), msg("s1", "shell", 0, "running")}, []string{"u1"}, "u1"},
		"exited shell":               {[]opencodeMessage{msg("s1", "shell", 0, "exited")}, []string{"s1"}, "s1"},
	} {
		got, last := opencodeSettled(tc.msgs, "prev")
		if strings.Join(ids(got), ",") != strings.Join(tc.want, ",") || last != tc.last {
			t.Errorf("%s: %v, %q", name, ids(got), last)
		}
	}
}

func TestOpencodeTranscriptEmptyAndErrors(t *testing.T) {
	f := newFakeOpencode(t)
	// A session named with --session that has no message yet.
	res := testOpencodeRead(t, "sesNew1", "idle", "", "")
	if !res.Reset || len(res.Entries) != 0 || res.Cursor == "" {
		t.Fatalf("empty = %+v", res)
	}
	if r := testOpencodeRead(t, "sesNew1", "idle", res.Cursor, ""); r.Reset || len(r.Entries) != 0 {
		t.Errorf("still empty: %+v", r)
	}
	f.set(func() { f.messages["sesNew1"] = testOpencodeMessages(t, "message-list-image.json") })
	if r := testOpencodeRead(t, "sesNew1", "idle", res.Cursor, ""); r.Reset || len(r.Entries) != 2 {
		t.Errorf("first messages after an empty read: reset=%v %d", r.Reset, len(r.Entries))
	}

	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	f.set(func() { f.status = http.StatusInternalServerError })
	_, err := readTranscript(AgentSession{Agent: "opencode", ID: "sesNew1"}, "", "")
	if !errors.Is(err, errNoTranscript) || strings.Contains(err.Error(), "internal words") {
		t.Errorf("service error = %v", err)
	}
	// A page over the limit is asked again with fewer messages.
	f.set(func() { f.status, f.big = 0, 6 })
	if r, err := readTranscript(AgentSession{Agent: "opencode", ID: "sesNew1"}, "", ""); err != nil || len(r.Entries) != 2 {
		t.Errorf("page too big, then smaller = %+v, %v", r, err)
	}
	f.set(func() { f.big = 1 })
	if _, err := readTranscript(AgentSession{Agent: "opencode", ID: "sesNew1"}, "", ""); !errors.Is(err, errNoTranscript) {
		t.Errorf("every page too big = %v", err)
	}
	f.srv.Close()
	resetOpencodeCaches()
	if _, err := readTranscript(AgentSession{Agent: "opencode", ID: "sesNew1"}, "", ""); !errors.Is(err, errNoTranscript) {
		t.Errorf("service down = %v", err)
	}
	if out := logs.String(); strings.Contains(out, testOpencodePassword) || strings.Contains(out, "internal words") {
		t.Errorf("log carries the password or the service's words: %s", out)
	}
	for _, a := range f.auths {
		if a != "" && !strings.HasPrefix(a, "Basic ") {
			t.Errorf("auth header %q", a)
		}
	}
}

func TestOpencodeEntries(t *testing.T) {
	read := func(name string) []TranscriptEntry {
		var msgs []opencodeMessage
		for _, raw := range testOpencodeMessages(t, name) {
			var m opencodeMessage
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatal(err)
			}
			msgs = append(msgs, m)
		}
		return opencodeEntries(msgs, "sesFixT1")
	}
	img := read("message-list-image.json")
	if len(img) != 2 || len(img[0].Parts) != 2 || img[0].Parts[1].Kind != "image" || img[0].TS == "" {
		t.Errorf("image message = %+v", img)
	}
	// The image pasted inline gets its reference: the session, the message
	// and the file's place in it.
	if ref, ok := decodeImageRef(img[0].Parts[1].Image); !ok || ref.Session != "sesFixT1" ||
		ref.File != opencodeImageRefFile+img[0].ID || ref.N != 0 {
		t.Errorf("image reference = %+v %v", ref, ok)
	}
	// The answer carries its tokens and model, for the overview.
	if u := img[1].usage; u == nil || u.contextTokens != 1230 || u.model != "m1" || u.provider != "fake" {
		t.Errorf("answer usage = %+v", u)
	}
	sub := read("message-list-subagent.json")
	var subTool *TranscriptPart
	for _, e := range sub {
		for i, p := range e.Parts {
			if p.Tool == "subagent" {
				subTool = &e.Parts[i]
			}
		}
	}
	if subTool == nil || subTool.Input != "explore" && subTool.Input != "Explore files" || !strings.Contains(subTool.Result, "working in the background") {
		t.Errorf("subagent call = %+v", subTool)
	}
	form := read("message-list-form-answered.json")
	if !strings.Contains(form[1].Parts[0].Result, `"Blue"`) {
		t.Errorf("question result = %+v", form[1].Parts)
	}
	compacted := read("message-list-compacted.json")
	last := compacted[len(compacted)-1]
	if last.Role != "note" || last.Parts[0].Text != "Context compaction failed" {
		t.Errorf("failed compaction = %+v", last)
	}
	// A turn that failed (a rate limit, its assistant message empty) and one
	// interrupted: a note each; the provider's raw response body stays out.
	failed := read("message-list-failed.json")
	var notes []string
	for _, e := range failed {
		if e.Role == "note" {
			notes = append(notes, e.Parts[0].Text)
		}
		for _, p := range e.Parts {
			if strings.Contains(p.Text, "free-limit") {
				t.Errorf("response body shown: %+v", e)
			}
		}
	}
	want := []string{"Turn failed: Rate limited: you've used today's free messages", "Interrupted"}
	if strings.Join(notes, "|") != strings.Join(want, "|") || len(failed) != 5 {
		t.Errorf("failed turns = %q (%d entries)", notes, len(failed))
	}

	for name, tc := range map[string]struct {
		msg  string
		role string
		text string
	}{
		"compacted":    {`{"id":"msg_a","type":"compaction","status":"completed","summary":"Did things"}`, "summary", "Did things"},
		"no summary":   {`{"id":"msg_a","type":"compaction","status":"completed"}`, "summary", compactedText},
		"running":      {`{"id":"msg_a","type":"compaction","status":"running"}`, "", ""},
		"shell":        {`{"id":"msg_a","type":"shell","command":"ls","status":"exited","output":{"output":"a\nb"}}`, "note", "$ ls\na\nb"},
		"shell no cmd": {`{"id":"msg_a","type":"shell","command":" "}`, "", ""},
		"skill":        {`{"id":"msg_a","type":"skill","name":"review","text":"x"}`, "note", "Skill: review"},
		"reasoning":    {`{"id":"msg_a","type":"assistant","content":[{"type":"reasoning","text":"hmm"},{"type":"text","text":" "}]}`, "assistant", "hmm"},
		"idle":         {`{"id":"msg_a","type":"idle","outcome":"succeeded"}`, "", ""},
		"failed":       {`{"id":"msg_a","type":"idle","outcome":"failed","error":null}`, "note", "Turn failed"},
		"failed blank": {`{"id":"msg_a","type":"idle","outcome":"failed","error":{"message":" \n"}}`, "note", "Turn failed"},
		"failed lines": {`{"id":"msg_a","type":"idle","outcome":"failed","error":{"message":"bad\n  gateway"}}`, "note", "Turn failed: bad gateway"},
		"synthetic":    {`{"id":"msg_a","type":"synthetic","text":"<subagent>"}`, "", ""},
		"blank user":   {`{"id":"msg_a","type":"user","text":" ","files":[{"mime":"text/plain"}]}`, "", ""},
	} {
		var m opencodeMessage
		if err := json.Unmarshal([]byte(tc.msg), &m); err != nil {
			t.Fatal(err)
		}
		e, ok := opencodeEntry(m)
		if ok != (tc.role != "") || ok && (e.Role != tc.role || e.Parts[0].Text != tc.text) {
			t.Errorf("%s: %v %+v", name, ok, e)
		}
	}

	tool := func(c string) TranscriptPart {
		var m opencodeContent
		if err := json.Unmarshal([]byte(c), &m); err != nil {
			t.Fatal(err)
		}
		return opencodeToolPart(m)
	}
	p := tool(`{"type":"tool","id":"c1","name":"edit","state":{"status":"error","input":{"path":"a.go","oldString":"x","newString":"y"}}}`)
	if !p.IsError || p.Result != "Error" || p.Detail == nil || len(p.Detail.Edits) != 1 || p.Detail.Edits[0].Old != "x" {
		t.Errorf("failed edit = %+v %+v", p, p.Detail)
	}
	p = tool(`{"type":"tool","id":"c1","name":"edit","state":{"status":"error","input":{"filePath":".env","oldString":"A=1","newString":"A=2"},"content":[{"type":"text","text":"no match"}]}}`)
	if !p.Detail.Hidden || len(p.Detail.Edits) != 0 || p.Result != "no match" {
		t.Errorf("edit of a sensitive file = %+v %+v", p, p.Detail)
	}
	p = tool(`{"type":"tool","id":"c1","name":"write","state":{"status":"completed","input":{"path":"n.txt","content":"hello"},"content":[{"type":"text","text":"ok"}]}}`)
	if p.Detail == nil || p.Detail.Edits[0].New != "hello" || p.Result != "ok" {
		t.Errorf("write = %+v", p)
	}
	p = tool(`{"type":"tool","id":"c1","state":{"status":"running","input":{"pattern":"x"}}}`)
	if p.Tool != "tool" || p.Input != "x" || p.Result != "" || p.Detail != nil {
		t.Errorf("unnamed running tool = %+v", p)
	}
}

func TestOpencodeViewOnlyHidesTools(t *testing.T) {
	f := newFakeOpencode(t)
	f.set(func() { f.messages["sesFixP1"] = testOpencodeMessages(t, "message-list-after-tool.json") })
	res := viewTranscript(testOpencodeRead(t, "sesFixP1", "idle", "", ""))
	for _, e := range res.Entries {
		for _, p := range e.Parts {
			if p.Kind == "tool" {
				t.Errorf("a view-only client sees a tool call: %+v", e)
			}
		}
	}
	if len(res.Entries) != 2 {
		t.Errorf("entries = %+v", res.Entries)
	}
}

// fakeOpencodeLocator is a backend that reports an OpenCode pane.
type fakeOpencodeLocator struct{ s AgentSession }

func (l fakeOpencodeLocator) AgentSession(context.Context, string) (AgentSession, bool, error) {
	return l.s, true, nil
}

func TestOpencodeTranscriptRoute(t *testing.T) {
	f := newFakeOpencode(t)
	f.set(func() { f.messages["sesFixP1"] = testOpencodeMessages(t, "message-list-after-tool.json") })
	get := func(s AgentSession) *httptest.ResponseRecorder {
		a := newAgentAPI(nil)
		a.loc = fakeOpencodeLocator{s}
		req := httptest.NewRequest(http.MethodGet, "/api/mux/panes/%251/agent/transcript", nil)
		req.SetPathValue("id", "%1")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		w := httptest.NewRecorder()
		a.handleTranscript(w, req)
		return w
	}
	w := get(AgentSession{Agent: "opencode", ID: "sesFixP1", Status: "idle", Target: "%1"})
	var res transcriptResponse
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &res) != nil || len(res.Entries) != 3 {
		t.Fatalf("transcript: %d %s", w.Code, w.Body)
	}
	// A pane whose session is not known shows no Chat view, without a 500.
	if w := get(AgentSession{Agent: "opencode", Status: "unknown", Target: "%1"}); w.Code != http.StatusNotFound {
		t.Errorf("no session: %d %s", w.Code, w.Body)
	}
	f.srv.Close()
	resetOpencodeCaches()
	if w := get(AgentSession{Agent: "opencode", ID: "sesFixP1", Target: "%1"}); w.Code != http.StatusNotFound ||
		strings.Contains(w.Body.String(), "opencode") {
		t.Errorf("service down: %d %s", w.Code, w.Body)
	}
}

func TestHerdrOpencodeSession(t *testing.T) {
	newFakeOpencode(t)
	ref := &herdrSessionRef{Agent: "opencode", Kind: "id", Value: "ses_e22caccceffe0hL76lTTiemGdN"}
	s, ok, err := herdrOpencodeSession("opencode", ref, "blocked", "w1:p1")
	if err != nil || !ok || s.ID != ref.Value || s.Status != "blocked" || s.Target != "w1:p1" || s.Agent != "opencode" {
		t.Errorf("session = %+v %v %v", s, ok, err)
	}
	for name, r := range map[string]*herdrSessionRef{
		"none":          nil,
		"another agent": {Agent: "claude", Kind: "id", Value: "sesA"},
		"path":          {Agent: "opencode", Kind: "path", Value: "sesA"},
		"bad id":        {Agent: "opencode", Kind: "id", Value: "../x"},
	} {
		if s, ok, _ := herdrOpencodeSession("opencode", r, "idle", "w1:p1"); !ok || s.ID != "" {
			t.Errorf("%s: %+v", name, s)
		}
	}
	stubOpencodeStateDir(t, t.TempDir())
	if s, ok, _ := herdrOpencodeSession("opencode", ref, "idle", "w1:p1"); !ok || s.ID != "" {
		t.Errorf("service down: %+v", s)
	}
}
