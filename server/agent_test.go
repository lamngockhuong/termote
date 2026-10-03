package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCursorRoundTripAndTamper(t *testing.T) {
	c := agentCursor{Session: testSessionID, Offset: 42, File: "1:2"}
	tok := encodeCursor(c)
	if got, ok := decodeCursor(tok); !ok || got != c {
		t.Fatalf("decode = %+v, %v", got, ok)
	}
	// A client cannot forge or edit a position.
	forged := agentCursor{Session: testSessionID, Offset: 7, File: "1:2"}
	payload, _ := json.Marshal(forged)
	_, sig, _ := strings.Cut(tok, ".")
	for _, bad := range []string{
		"", "abc", "abc.def", tok + "x",
		b64(payload) + "." + sig,
		b64([]byte(`{"o":-1}`)) + "." + b64(cursorMAC([]byte(`{"o":-1}`))),
	} {
		if _, ok := decodeCursor(bad); ok {
			t.Errorf("decodeCursor(%q) accepted", bad)
		}
	}
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func TestTTLCacheSharesOneCall(t *testing.T) {
	c := newTTLCache[int](time.Hour)
	var calls atomic.Int32
	release := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, _ := c.do("k", func() (int, error) {
				calls.Add(1)
				<-release
				return 7, nil
			})
			if v != 7 {
				t.Errorf("v = %d", v)
			}
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	if n := calls.Load(); n != 1 {
		t.Errorf("fn ran %d times, want 1", n)
	}
	// Another key runs on its own.
	c.do("other", func() (int, error) { calls.Add(1); return 0, nil })
	if n := calls.Load(); n != 2 {
		t.Errorf("fn ran %d times, want 2", n)
	}
}

func TestTTLCacheExpires(t *testing.T) {
	c := newTTLCache[int](10 * time.Millisecond)
	n := 0
	fn := func() (int, error) { n++; return n, nil }
	c.do("k", fn)
	c.do("k", fn)
	time.Sleep(15 * time.Millisecond)
	if v, _ := c.do("k", fn); v != 2 {
		t.Errorf("after ttl v = %d, want 2", v)
	}
	if len(c.entries) != 1 {
		t.Errorf("expired entries kept: %d", len(c.entries))
	}
}

// line returns one assistant row with text s.
func line(i int, s string) string {
	b, _ := json.Marshal(map[string]any{"type": "assistant", "uuid": fmt.Sprintf("u%d", i),
		"message": map[string]any{"content": []any{map[string]any{"type": "text", "text": s}}}})
	return string(b) + "\n"
}

func lines(from, to int) string {
	var b strings.Builder
	for i := from; i < to; i++ {
		b.WriteString(line(i, fmt.Sprintf("message %d", i)))
	}
	return b.String()
}

func appendFile(t *testing.T, p, s string) {
	t.Helper()
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(s)
	f.Close()
}

func texts(es []TranscriptEntry) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.Parts[0].Text)
	}
	return out
}

func TestReadTranscriptFollowsTheFile(t *testing.T) {
	dir := t.TempDir()
	p := writeTranscript(t, dir, testSessionID, lines(0, 3))
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir, Status: "idle"}

	first, err := readTranscript(s, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !first.Reset || len(first.Entries) != 3 || first.Before != "" || first.Status != "idle" || first.SessionID != testSessionID {
		t.Fatalf("first = %+v", first)
	}

	// Nothing new: no entries, same position.
	same, _ := readTranscript(s, first.Cursor, "")
	if same.Reset || len(same.Entries) != 0 {
		t.Fatalf("idle poll = %+v", same)
	}

	// A line still being written is not returned until it is complete.
	full := line(3, "message 3")
	appendFile(t, p, full[:10])
	part, _ := readTranscript(s, same.Cursor, "")
	if part.Reset || len(part.Entries) != 0 {
		t.Fatalf("partial poll = %+v", part)
	}
	appendFile(t, p, full[10:]+line(4, "message 4"))
	next, _ := readTranscript(s, part.Cursor, "")
	if next.Reset || strings.Join(texts(next.Entries), ",") != "message 3,message 4" {
		t.Fatalf("next = %+v", next)
	}

	// An unreadable cursor starts over.
	if r, _ := readTranscript(s, "garbage", ""); !r.Reset || len(r.Entries) != 5 {
		t.Errorf("bad cursor = %+v", r)
	}
}

func TestReadTranscriptResets(t *testing.T) {
	dir := t.TempDir()
	p := writeTranscript(t, dir, testSessionID, lines(0, 4))
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}
	first, _ := readTranscript(s, "", "")

	t.Run("other session", func(t *testing.T) {
		other := "22222222-2222-4333-8444-555555555555"
		writeTranscript(t, dir, other, lines(10, 11))
		r, _ := readTranscript(AgentSession{Agent: "claude", ID: other, ClaudeDir: dir}, first.Cursor, "")
		if !r.Reset || strings.Join(texts(r.Entries), ",") != "message 10" {
			t.Errorf("session change = %+v", r)
		}
	})
	t.Run("truncated", func(t *testing.T) {
		os.WriteFile(p, []byte(lines(0, 1)), 0o600)
		if r, _ := readTranscript(s, first.Cursor, ""); !r.Reset || len(r.Entries) != 1 {
			t.Errorf("truncated = %+v", r)
		}
	})
	t.Run("offset inside a line", func(t *testing.T) {
		// Same file, rewritten so the old offset now falls mid-line.
		os.WriteFile(p, []byte(line(0, "a much longer first message than before")+lines(1, 4)), 0o600)
		if r, _ := readTranscript(s, first.Cursor, ""); !r.Reset {
			t.Errorf("mid-line offset = %+v", r)
		}
	})
	t.Run("file replaced", func(t *testing.T) {
		os.WriteFile(p, []byte(lines(0, 4)), 0o600)
		c, _ := readTranscript(s, "", "")
		tmp := p + ".new"
		os.WriteFile(tmp, []byte(lines(0, 6)), 0o600)
		os.Rename(tmp, p)
		r, _ := readTranscript(s, c.Cursor, "")
		if fileIdentity(mustStat(t, p)) == "" {
			t.Skip("no file identity on this OS")
		}
		if !r.Reset || len(r.Entries) != 6 {
			t.Errorf("replaced file = reset %v, %d entries", r.Reset, len(r.Entries))
		}
	})
}

func mustStat(t *testing.T, p string) os.FileInfo {
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	return fi
}

func TestReadTranscriptPagesBackwards(t *testing.T) {
	dir := t.TempDir()
	total := agentMaxEntries*2 + 50
	writeTranscript(t, dir, testSessionID, lines(0, total))
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}

	r, _ := readTranscript(s, "", "")
	if len(r.Entries) != agentMaxEntries || r.Entries[0].Parts[0].Text != fmt.Sprintf("message %d", total-agentMaxEntries) || r.Before == "" {
		t.Fatalf("first page: %d entries, first %q, before %q", len(r.Entries), r.Entries[0].Parts[0].Text, r.Before)
	}
	var got []string
	got = append(texts(r.Entries), got...)
	for before := r.Before; before != ""; {
		page, err := readTranscript(s, "", before)
		if err != nil || page.Reset || page.Cursor != "" {
			t.Fatalf("page = %+v, %v", page, err)
		}
		got = append(texts(page.Entries), got...)
		before = page.Before
	}
	if len(got) != total || got[0] != "message 0" || got[total-1] != fmt.Sprintf("message %d", total-1) {
		t.Fatalf("paged %d entries, want %d in order", len(got), total)
	}

	if _, err := readTranscript(s, "", "forged"); err != errInvalidBefore {
		t.Errorf("forged before: %v, want errInvalidBefore", err)
	}
	// A before token from another session resets.
	other := "33333333-2222-4333-8444-555555555555"
	writeTranscript(t, dir, other, lines(0, 2))
	if page, _ := readTranscript(AgentSession{Agent: "claude", ID: other, ClaudeDir: dir}, "", r.Before); !page.Reset || len(page.Entries) != 2 {
		t.Errorf("before from other session = %+v", page)
	}
}

func TestReadTranscriptTailCutReportsOrphan(t *testing.T) {
	// The tool call sits just before the last agentMaxEntries rows: its result
	// is kept as an orphan instead of folding onto a call the reply omits.
	dir := t.TempDir()
	use := `{"type":"assistant","uuid":"call","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}` + "\n"
	res := `{"type":"user","uuid":"res","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"out"}]}}` + "\n"
	writeTranscript(t, dir, testSessionID, use+line(0, "m0")+res+lines(1, agentMaxEntries))
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}
	r, _ := readTranscript(s, "", "")
	// The page holds agentMaxEntries: m0 moves to the older page, and the
	// result whose call is cut off stays an orphan.
	if len(r.Entries) != agentMaxEntries {
		t.Fatalf("%d entries, want %d", len(r.Entries), agentMaxEntries)
	}
	if p := r.Entries[0].Parts[0]; !p.Orphan || p.Result != "out" || p.ToolID != "t1" {
		t.Fatalf("first entry = %+v, want the orphan result", r.Entries[0])
	}
	older, _ := readTranscript(s, "", r.Before)
	if len(older.Entries) != 2 || older.Entries[0].ID != "call" || older.Entries[1].Parts[0].Text != "m0" {
		t.Fatalf("older page = %+v", older.Entries)
	}
}

func TestReadTranscriptLargeFileIsFast(t *testing.T) {
	if testing.Short() {
		t.Skip("writes 50 MB")
	}
	dir := t.TempDir()
	p := writeTranscript(t, dir, testSessionID, "")
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	chunk := lines(0, 1000)
	for written := 0; written < 50<<20; written += len(chunk) {
		f.WriteString(chunk)
	}
	f.Close()
	start := time.Now()
	r, err := readTranscript(AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}, "", "")
	if err != nil || len(r.Entries) != agentMaxEntries {
		t.Fatalf("read = %d entries, %v", len(r.Entries), err)
	}
	if d := time.Since(start); d > 300*time.Millisecond {
		t.Errorf("first read of 50 MB took %v, want < 300ms", d)
	}
}

// fakeLocator is a Mux with an agent locator.
type fakeLocator struct {
	fakeMux
	calls atomic.Int32
	s     AgentSession
	found bool
	err   error
}

func (f *fakeLocator) AgentSession(_ context.Context, pane string) (AgentSession, bool, error) {
	f.calls.Add(1)
	if pane == "bad" {
		return AgentSession{}, false, inputError("invalid pane id")
	}
	return f.s, f.found, f.err
}

func getJSON(t *testing.T, h http.Handler, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body
}

func TestTranscriptRoute(t *testing.T) {
	dir := t.TempDir()
	writeTranscript(t, dir, testSessionID, lines(0, 2))
	loc := &fakeLocator{s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir, Status: "working"}, found: true}
	mux := http.NewServeMux()
	registerMuxRoutes(mux, loc, newStreamTokenStore(), nil)

	code, body := getJSON(t, mux, "/api/mux/panes/1/agent/transcript")
	if code != http.StatusOK || body["agent"] != "claude" || body["status"] != "working" || body["reset"] != true || len(body["entries"].([]any)) != 2 {
		t.Fatalf("GET = %d %v", code, body)
	}
	code, body = getJSON(t, mux, "/api/mux/panes/1/agent/transcript?cursor="+url.QueryEscape(body["cursor"].(string)))
	if code != http.StatusOK || body["reset"] != false || len(body["entries"].([]any)) != 0 {
		t.Fatalf("GET with cursor = %d %v", code, body)
	}
	if code, body := getJSON(t, mux, "/api/mux/panes/1/agent/transcript?before=x"); code != http.StatusBadRequest {
		t.Errorf("forged before = %d %v", code, body)
	}
	if code, _ := getJSON(t, mux, "/api/mux/panes/bad/agent/transcript"); code != http.StatusBadRequest {
		t.Errorf("bad pane = %d", code)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/mux/panes/1/agent/transcript", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}

	loc.found = false
	time.Sleep(agentCacheTTL)
	if code, body := getJSON(t, mux, "/api/mux/panes/2/agent/transcript"); code != http.StatusNotFound || body["error"] != errNoAgentSession.Error() {
		t.Errorf("no session = %d %v", code, body)
	}
	loc.found, loc.s.ID = true, "99999999-2222-4333-8444-555555555555"
	if code, body := getJSON(t, mux, "/api/mux/panes/3/agent/transcript"); code != http.StatusNotFound || body["error"] != errNoTranscript.Error() {
		t.Errorf("no transcript = %d %v", code, body)
	}
	loc.s.Agent = "pi"
	if code, _ := getJSON(t, mux, "/api/mux/panes/4/agent/transcript"); code != http.StatusNotFound {
		t.Errorf("agent without adapter = %d", code)
	}
	loc.err = fmt.Errorf("tmux exploded")
	if code, body := getJSON(t, mux, "/api/mux/panes/5/agent/transcript"); code != http.StatusInternalServerError || strings.Contains(fmt.Sprint(body), "exploded") {
		t.Errorf("backend error = %d %v", code, body)
	}
}

func TestTranscriptRouteWithoutLocator(t *testing.T) {
	mux := http.NewServeMux()
	registerMuxRoutes(mux, &fakeMux{}, newStreamTokenStore(), nil)
	if code, body := getJSON(t, mux, "/api/mux/panes/1/agent/transcript"); code != http.StatusNotFound || body["error"] != "agent not available" {
		t.Errorf("GET = %d %v", code, body)
	}
}

func TestTranscriptRouteSharesWorkBetweenClients(t *testing.T) {
	dir := t.TempDir()
	writeTranscript(t, dir, testSessionID, lines(0, 2))
	loc := &fakeLocator{s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: filepath.Clean(dir)}, found: true}
	mux := http.NewServeMux()
	registerMuxRoutes(mux, loc, newStreamTokenStore(), nil)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code, _ := getJSON(t, mux, "/api/mux/panes/1/agent/transcript"); code != http.StatusOK {
				t.Errorf("GET = %d", code)
			}
		}()
	}
	wg.Wait()
	if n := loc.calls.Load(); n != 1 {
		t.Errorf("3 clients made %d lookups, want 1", n)
	}
}

func TestReadTailStopsAtTheCap(t *testing.T) {
	dir := t.TempDir()
	// Fewer than agentMaxEntries rows, spread over more than agentTailMax.
	big := line(0, strings.Repeat("x", 512*1024))
	var b strings.Builder
	for b.Len() < agentTailMax+4*len(big) {
		b.WriteString(big)
	}
	writeTranscript(t, dir, testSessionID, b.String())
	r, err := readTranscript(AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}, "", "")
	if err != nil || r.Before == "" || len(r.Entries) == 0 {
		t.Fatalf("read = %d entries, before %q, %v", len(r.Entries), r.Before, err)
	}
	if n := len(r.Entries) * len(big); n > agentTailMax {
		t.Errorf("read %d bytes of rows, cap is %d", n, agentTailMax)
	}
}

func TestReadTranscriptWithoutCompleteLine(t *testing.T) {
	dir := t.TempDir()
	p := writeTranscript(t, dir, testSessionID, `{"type":"user"`)
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}
	r, err := readTranscript(s, "", "")
	if err != nil || len(r.Entries) != 0 {
		t.Fatalf("partial file = %+v, %v", r, err)
	}
	appendFile(t, p, `,"uuid":"u","message":{"content":"hello"}}`+"\n")
	if r, _ := readTranscript(s, r.Cursor, ""); r.Reset || len(r.Entries) != 1 {
		t.Errorf("after completing the line = %+v", r)
	}
	if r, _ := readTranscript(AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: t.TempDir()}, "", ""); r.Agent != "" {
		t.Errorf("missing transcript = %+v", r)
	}
}

func TestTTLCacheSurvivesPanic(t *testing.T) {
	c := newTTLCache[int](time.Hour)
	func() {
		defer func() { recover() }()
		c.do("k", func() (int, error) { panic("boom") })
	}()
	done := make(chan error, 1)
	go func() { _, err := c.do("k", func() (int, error) { return 1, nil }); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Error("a panicked lookup reported success")
		}
	case <-time.After(time.Second):
		t.Fatal("caller blocked after a panicked lookup")
	}
}

func TestTranscriptRouteIgnoresJunkCursor(t *testing.T) {
	dir := t.TempDir()
	writeTranscript(t, dir, testSessionID, lines(0, 2))
	loc := &fakeLocator{s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}, found: true}
	mux := http.NewServeMux()
	a := registerAgentRoutes(mux, loc, nil)
	for i := 0; i < 5; i++ {
		if code, body := getJSON(t, mux, fmt.Sprintf("/api/mux/panes/1/agent/transcript?cursor=junk%d", i)); code != http.StatusOK || body["reset"] != true {
			t.Fatalf("junk cursor = %d %v", code, body)
		}
	}
	if n := len(a.reads.entries); n != 1 {
		t.Errorf("junk cursors made %d cache entries, want 1", n)
	}
}

// Another site's page cannot start a transcript or prompt read: refused
// before the pane's session is even looked up.
func TestAgentReadRoutesRejectCrossSite(t *testing.T) {
	dir := t.TempDir()
	writeTranscript(t, dir, testSessionID, lines(0, 2))
	loc := &fakeLocator{s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}, found: true}
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, loc, newStreamTokenStore(), nil)
	agent.registerCommandsRoute(mux, nil, parseAllowedHosts("", false))
	for _, route := range []string{"transcript", "prompt"} {
		path := "/api/mux/panes/1/agent/" + route
		for k, v := range map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"} {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Host = "localhost:7680"
			req.Header.Set(k, v)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Errorf("%s with %s: %s = %d", route, k, v, rec.Code)
			}
		}
	}
	if n := loc.calls.Load(); n != 0 {
		t.Errorf("session looked up %d times for cross-site requests", n)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/mux/panes/1/agent/transcript", nil)
	req.Host = "localhost:7680"
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Origin", "http://localhost:7680")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("same-origin transcript = %d %s", rec.Code, rec.Body.String())
	}
}
