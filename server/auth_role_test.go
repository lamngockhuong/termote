package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// viewDeviceHeader names the paired device a test request acts as.
const viewDeviceHeader = "X-Test-View-Device"

// asRole serves a request carrying viewDeviceHeader as a view-only device,
// through serveAs as basicAuth does (layer1), or without its default
// refusal, to reach the handlers' own checks. Other requests pass unchanged
// (h runs without sign-in, so they are full).
func asRole(h http.Handler, layer1 bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(viewDeviceHeader)
		if id == "" {
			h.ServeHTTP(w, r)
			return
		}
		a := authInfo{Kind: authDevice, Role: roleView, DeviceID: id}
		if layer1 {
			serveAs(h, w, r, a)
			return
		}
		h.ServeHTTP(w, r.WithContext(withAuth(r.Context(), a)))
	})
}

// viewMux is a fakeMux that can attach read-only and peek, recording both.
// A stream attaches in its handler's goroutine, after the dial returned:
// attached receives each read-only attach.
type viewMux struct {
	*fakeMux
	canView  bool
	attached chan string
}

func (v *viewMux) peekSnapshot(context.Context) (Snapshot, error) {
	v.calls = append(v.calls, "peek")
	return v.snap, v.err
}
func (v *viewMux) CanView(context.Context) bool { return v.canView }
func (v *viewMux) AttachView(_ context.Context, pane string, size Size) (TermStream, error) {
	if v.attached != nil {
		v.attached <- pane
	}
	return v.attach(pane, size)
}

// waitAttached returns the pane of the next read-only attach.
func (v *viewMux) waitAttached(t *testing.T) string {
	t.Helper()
	select {
	case p := <-v.attached:
		return p
	case <-time.After(5 * time.Second):
		t.Fatal("no read-only attach")
		return ""
	}
}

// newRoleHandler builds the server without sign-in, wrapped by asRole.
func newRoleHandler(t *testing.T, m Mux, layer1 bool) (http.Handler, *streamHub) {
	t.Helper()
	cfg := testConfig(t)
	cfg.NoAuth = true
	cfg.Pass = ""
	h, hub, _, err := buildServer(cfg, m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	return asRole(h, layer1), hub
}

func viewRequest(method, path, body string) *http.Request {
	req := apiRequest(method, path, body)
	req.Header.Del("Authorization")
	req.Header.Set(viewDeviceHeader, "d1")
	return req
}

func assertViewOnly(t *testing.T, what string, rec *httptest.ResponseRecorder) {
	t.Helper()
	var body struct{ Error, Code string }
	json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != http.StatusForbidden || body.Code != "view_only" {
		t.Errorf("%s: %d %s, want 403 view_only", what, rec.Code, rec.Body)
	}
}

func TestDenyViewWritesEveryWriteMethod(t *testing.T) {
	called := 0
	// A route nobody wrote a role check for: the default refusal covers it.
	mux := http.NewServeMux()
	mux.HandleFunc("/api/mux/brand-new", func(w http.ResponseWriter, r *http.Request) { called++ })
	mux.HandleFunc("/elsewhere", func(w http.ResponseWriter, r *http.Request) { called++ })
	h := asRole(mux, true)
	for _, path := range []string{"/api/mux/brand-new", "/elsewhere"} {
		for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "PROPFIND", "post"} {
			req := httptest.NewRequest(method, path, nil)
			req.Header.Set(viewDeviceHeader, "d1")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			assertViewOnly(t, method+" "+path, rec)
		}
	}
	if called != 0 {
		t.Errorf("handler ran %d times for a view-only write", called)
	}
	for _, method := range []string{"GET", "HEAD", "OPTIONS"} {
		req := httptest.NewRequest(method, "/api/mux/brand-new", nil)
		req.Header.Set(viewDeviceHeader, "d1")
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	if called != 3 {
		t.Errorf("reads reached the handler %d times, want 3", called)
	}
	// Full clients and logging out are untouched.
	called = 0
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/mux/brand-new", nil))
	if called != 1 {
		t.Error("a full client's write was refused")
	}
	req := httptest.NewRequest("POST", logoutPath, nil)
	req.Header.Set(viewDeviceHeader, "d1")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code == http.StatusForbidden {
		t.Error("logout refused to a view-only client")
	}
}

func TestRequestRole(t *testing.T) {
	ctx := context.Background()
	if requestRole(ctx) != roleFull || authenticated(ctx) {
		t.Error("no identity (--no-auth) must be full and unauthenticated")
	}
	if requestRole(withAuth(ctx, authInfo{Kind: authSession, Role: roleFull})) != roleFull {
		t.Error("session must be full")
	}
	v := withAuth(ctx, authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"})
	if requestRole(v) != roleView || !authenticated(v) {
		t.Error("view device")
	}
}

// Every write route refuses a view-only client in its own handler too
// (without the default refusal), before the backend is asked anything.
func TestViewRefusedByEveryWriteHandler(t *testing.T) {
	m := &viewMux{fakeMux: &fakeMux{snap: oneTabSnapshot(), caps: &Caps{Groups: true, ReorderTabs: true, ReorderGroups: true, Worktrees: true, Files: true, AgentChat: true, AgentStart: true}}}
	h, _ := newRoleHandler(t, m, false)
	cases := []struct{ method, path, body string }{
		{"POST", "/api/mux/tabs", `{"groupId":"main","name":"x"}`},
		{"PATCH", "/api/mux/tabs/0", `{"name":"x"}`},
		{"DELETE", "/api/mux/tabs/0", ""},
		{"POST", "/api/mux/tabs/0/select", "{}"},
		{"DELETE", "/api/mux/panes/0", ""},
		{"POST", "/api/mux/panes/0/keys", `{"keys":"ls"}`},
		{"POST", "/api/mux/panes/0/scroll", `{"lines":3}`},
		{"POST", "/api/mux/tabs/0/move", `{"index":0}`},
		{"POST", "/api/mux/groups", `{"name":"x"}`},
		{"PATCH", "/api/mux/groups/main", `{"name":"x"}`},
		{"DELETE", "/api/mux/groups/main", ""},
		{"POST", "/api/mux/groups/main/move", `{"index":0}`},
		{"POST", "/api/mux/worktrees", `{"groupId":"main","branch":"b"}`},
		{"POST", "/api/mux/worktrees/open", `{"groupId":"main","branch":"b"}`},
		{"DELETE", "/api/mux/worktrees/w1", `{"force":false,"path":"/x","branch":"b"}`},
		{"POST", "/api/mux/push/subscribe", "{}"},
		{"DELETE", "/api/mux/push/subscribe", "{}"},
		{"PUT", "/api/mux/panes/0/files/content?root=/x", `{"path":"a"}`},
		{"POST", "/api/mux/panes/0/files/create?root=/x", `{"path":"a"}`},
		{"POST", "/api/mux/panes/0/files/delete?root=/x", `{"path":"a"}`},
		{"POST", "/api/mux/panes/0/files/restore?root=/x", `{"trashId":"a"}`},
		{"POST", "/api/mux/panes/0/agent/message", `{"text":"hi"}`},
		{"POST", "/api/mux/panes/0/agent/answer", `{"promptId":"p"}`},
		{"POST", "/api/mux/panes/0/agent/start", `{"kind":"claude"}`},
		{"GET", "/api/mux/panes/0/agent/start", ""},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, viewRequest(c.method, c.path, c.body))
		assertViewOnly(t, c.method+" "+c.path, rec)
	}
	upload := viewRequest("POST", "/api/mux/uploads", "\x89PNG\r\n\x1a\n")
	upload.Header.Set("Content-Type", "image/png")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, upload)
	assertViewOnly(t, "POST uploads", rec)
	if slices.ContainsFunc(m.calls, func(c string) bool { return c != "snapshot" && c != "peek" }) {
		t.Errorf("backend asked for a view-only client: %v", m.calls)
	}
}

func TestViewSnapshotMakesNothing(t *testing.T) {
	m := &viewMux{fakeMux: &fakeMux{snap: oneTabSnapshot()}}
	h, _ := newRoleHandler(t, m, true)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, viewRequest("GET", "/api/mux/snapshot", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("snapshot: %d %s", rec.Code, rec.Body)
	}
	if !slices.Equal(m.calls, []string{"peek"}) {
		t.Errorf("calls = %v, want only a peek (no default session made)", m.calls)
	}
	var snap Snapshot
	json.Unmarshal(rec.Body.Bytes(), &snap)
	if snap.Caps.Role != "view" || !snap.Caps.Auth {
		t.Errorf("caps = %+v, want role view", snap.Caps)
	}
	// Herdr (client-side select) makes nothing in its snapshot, and its peek
	// would drop the worktree branches.
	m.calls = nil
	m.caps = &Caps{ClientSideSelect: true}
	h.ServeHTTP(httptest.NewRecorder(), viewRequest("GET", "/api/mux/snapshot", ""))
	if !slices.Equal(m.calls, []string{"snapshot"}) {
		t.Errorf("herdr calls = %v", m.calls)
	}
	// A full client still gets the snapshot that makes the default session.
	m.calls, m.caps = nil, nil
	rec = httptest.NewRecorder()
	full := apiRequest("GET", "/api/mux/snapshot", "")
	full.Header.Del("Authorization")
	h.ServeHTTP(rec, full)
	snap = Snapshot{}
	json.Unmarshal(rec.Body.Bytes(), &snap)
	if !slices.Equal(m.calls, []string{"snapshot"}) || snap.Caps.Role != "" {
		t.Errorf("full: calls %v, role %q", m.calls, snap.Caps.Role)
	}
}

// viewFilesFixture is a pane whose directory is dir.
func viewFilesFixture(t *testing.T, dir string) (*viewMux, http.Handler) {
	t.Helper()
	m := &viewMux{fakeMux: &fakeMux{snap: oneTabSnapshot(), caps: &Caps{Files: true}}}
	fm := &dirMux{viewMux: m, dir: dir}
	h, _ := newRoleHandler(t, fm, true)
	return m, h
}

// dirMux reports dir as every pane's directory.
type dirMux struct {
	*viewMux
	dir string
}

func (d *dirMux) PaneDir(context.Context, string) (string, string, error) { return d.dir, "%0", nil }

func gitInit(t *testing.T, dir string) {
	t.Helper()
	if out, err := exec.Command("git", "-C", dir, "init", "-q").CombinedOutput(); err != nil {
		t.Skipf("git init: %v %s", err, out)
	}
}

func TestViewFilesRules(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	plain := t.TempDir()
	os.WriteFile(filepath.Join(plain, "notes.txt"), []byte("x"), 0o600)
	_, h := viewFilesFixture(t, plain)
	for _, p := range []string{"tree", "content?path=notes.txt", "find?q=notes"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, viewRequest("GET", "/api/mux/panes/0/files/"+p, ""))
		assertViewOnly(t, "outside a repo: "+p, rec)
	}
	// A full client still reads outside a repo.
	rec := httptest.NewRecorder()
	full := apiRequest("GET", "/api/mux/panes/0/files/content?path=notes.txt", "")
	full.Header.Del("Authorization")
	h.ServeHTTP(rec, full)
	if rec.Code != http.StatusOK {
		t.Errorf("full outside a repo: %d %s", rec.Code, rec.Body)
	}

	repo := t.TempDir()
	gitInit(t, repo)
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("hello"), 0o600)
	os.WriteFile(filepath.Join(repo, ".env"), []byte("SECRET=1"), 0o600)
	_, h = viewFilesFixture(t, repo)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, viewRequest("GET", "/api/mux/panes/0/files/content?path=a.txt", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "hello") {
		t.Errorf("view in a repo: %d %s", rec.Code, rec.Body)
	}
	for _, p := range []string{"content?path=.env&reveal=1", "content?path=.env&hash=1", "content?path=a.txt&hash=1", "diff?path=.env&reveal=1", "raw?path=.env&reveal=1"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, viewRequest("GET", "/api/mux/panes/0/files/"+p, ""))
		assertViewOnly(t, p, rec)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, viewRequest("GET", "/api/mux/panes/0/files/content?path=.env", ""))
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "SECRET") {
		t.Errorf("sensitive file without reveal: %d %s", rec.Code, rec.Body)
	}
}

func TestViewPromptHasNoPromptID(t *testing.T) {
	p := &AgentPrompt{Kind: "choice", PromptID: "set-by-someone"}
	if got := viewPrompt(agentScreen{prompt: p}); got == nil || got.PromptID != "" || got.Kind != "choice" {
		t.Errorf("viewPrompt = %+v", got)
	}
	if p.PromptID != "set-by-someone" {
		t.Error("viewPrompt changed the screen's prompt")
	}
	if viewPrompt(agentScreen{}) != nil {
		t.Error("no dialog must give no card")
	}
}

func TestStreamTokensByRole(t *testing.T) {
	s := newTokenStore(time.Minute, true)
	s.max = 4
	s.perDevice = 2
	full := make([]string, 0, 4)
	for range 4 {
		tok, _ := s.generateFor(roleFull, "")
		full = append(full, tok)
	}
	// A full store holds only full tokens: a view-only one is refused.
	if _, err := s.generateFor(roleView, "d1"); !errors.Is(err, errTokensBusy) {
		t.Fatalf("view into a store of full tokens: %v", err)
	}
	for _, tok := range full[1:] {
		if _, ok := s.tokens[tok]; !ok {
			t.Fatal("a view-only request pushed out a full token")
		}
	}
	// A view-only token takes the oldest view-only one; a full one takes a
	// view-only one before any full.
	s = newTokenStore(time.Minute, true)
	s.max = 4
	s.perDevice = 2
	f1, _ := s.generateFor(roleFull, "")
	v1, _ := s.generateFor(roleView, "d1")
	v2, _ := s.generateFor(roleView, "d2")
	f2, _ := s.generateFor(roleFull, "")
	v3, _ := s.generateFor(roleView, "d3")
	if _, ok := s.tokens[v1]; ok {
		t.Error("oldest view token kept")
	}
	f3, _ := s.generateFor(roleFull, "")
	if _, ok := s.tokens[v2]; ok {
		t.Error("full token did not take the view token first")
	}
	for _, tok := range []string{f1, f2, f3, v3} {
		if _, ok := s.tokens[tok]; !ok {
			t.Errorf("token %s gone", tok[:6])
		}
	}
	// One device keeps at most perDevice tokens.
	s = newTokenStore(time.Minute, true)
	s.max = 32
	s.perDevice = 2
	a, _ := s.generateFor(roleView, "d1")
	s.generateFor(roleView, "d1")
	s.generateFor(roleView, "d1")
	if _, ok := s.tokens[a]; ok || len(s.tokens) != 2 {
		t.Errorf("per-device cap: %d tokens, first kept %v", len(s.tokens), ok)
	}
	// consume says who; revokeDevice ends a device's tokens.
	b, _ := s.generateFor(roleView, "d2")
	s.revokeDevice("d1")
	if len(s.tokens) != 1 {
		t.Errorf("after revoke: %d tokens", len(s.tokens))
	}
	if ti, ok := s.consume(b); !ok || ti.role != roleView || ti.deviceID != "d2" {
		t.Errorf("consume = %+v %v", ti, ok)
	}
	if _, ok := s.consume(b); ok {
		t.Error("token used twice")
	}
}

func TestHubByRole(t *testing.T) {
	type stream struct {
		ctx    context.Context
		cancel context.CancelCauseFunc
	}
	open := func() stream {
		ctx, cancel := context.WithCancelCause(context.Background())
		return stream{ctx, cancel}
	}
	ended := func(s stream) bool { return s.ctx.Err() != nil }

	h := newStreamHub(3)
	f1, f2, f3 := open(), open(), open()
	for _, s := range []stream{f1, f2, f3} {
		if _, err := h.add(s.cancel, roleFull, ""); err != nil {
			t.Fatal(err)
		}
	}
	v := open()
	if _, err := h.add(v.cancel, roleView, "d1"); !errors.Is(err, errTooManyViewers) {
		t.Fatalf("view into a hub of full streams: %v", err)
	}
	if ended(f1) || ended(f2) || ended(f3) {
		t.Fatal("a view-only stream pushed out a full one")
	}

	h = newStreamHub(3)
	f1, v1, v2 := open(), open(), open()
	h.add(f1.cancel, roleFull, "")
	h.add(v1.cancel, roleView, "d1")
	h.add(v2.cancel, roleView, "d2")
	f2 = open()
	h.add(f2.cancel, roleFull, "")
	if !ended(v1) || ended(f1) || ended(v2) {
		t.Error("a full stream must push out the oldest view-only one first")
	}
	v3 := open()
	h.add(v3.cancel, roleView, "d3")
	if !ended(v2) || ended(f1) || ended(f2) {
		t.Error("a view-only stream must push out the oldest view-only one")
	}

	// One device keeps at most maxViewStreamsPerDevice streams.
	h = newStreamHub(8)
	var mine []stream
	for range maxViewStreamsPerDevice + 1 {
		s := open()
		h.add(s.cancel, roleView, "d1")
		mine = append(mine, s)
	}
	if !ended(mine[0]) || ended(mine[1]) || ended(mine[2]) {
		t.Error("per-device cap must end the device's oldest stream")
	}

	// A revoked device cannot add; closeDevice ends what it has.
	var mu sync.Mutex
	revoked := map[string]bool{}
	h.alive = func(id string) bool { mu.Lock(); defer mu.Unlock(); return !revoked[id] }
	mu.Lock()
	revoked["d9"] = true
	mu.Unlock()
	if _, err := h.add(open().cancel, roleView, "d9"); !errors.Is(err, errDeviceRevoked) {
		t.Errorf("revoked device add: %v", err)
	}
	h.closeDevice("d1")
	if ended(mine[1]) == false || ended(mine[2]) == false {
		t.Error("closeDevice left a stream open")
	}
}

// newViewStreamServer is newStreamServer without sign-in, where a request
// carrying viewDeviceHeader is a view-only device.
func newViewStreamServer(t *testing.T, caps *Caps) (*streamServer, *viewMux) {
	t.Helper()
	s := &streamServer{}
	snap := oneTabSnapshot()
	snap.Groups[0].Tabs = append(snap.Groups[0].Tabs, Tab{ID: "1", Name: "other", Panes: []Pane{{ID: "1", Active: true}}})
	m := &viewMux{fakeMux: &fakeMux{snap: snap, caps: caps}, canView: true, attached: make(chan string, 16)}
	m.attach = func(_ string, size Size) (TermStream, error) {
		ft := newFakeTerm()
		s.mu.Lock()
		s.terms = append(s.terms, ft)
		s.sizes = append(s.sizes, size)
		s.mu.Unlock()
		return ft, nil
	}
	h, hub := newRoleHandler(t, m, true)
	s.hub = hub
	s.Server = httptest.NewServer(h)
	t.Cleanup(s.Close)
	return s, m
}

func viewHeader(s *streamServer) http.Header {
	h := http.Header{}
	h.Set("Origin", s.URL)
	h.Set(viewDeviceHeader, "d1")
	return h
}

func viewToken(t *testing.T, s *streamServer) string {
	t.Helper()
	req, _ := http.NewRequest("GET", s.URL+"/api/mux/stream-token", nil)
	req.Header.Set(viewDeviceHeader, "d1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct{ Token string }
	json.NewDecoder(resp.Body).Decode(&body)
	if body.Token == "" {
		t.Fatalf("stream-token: %d", resp.StatusCode)
	}
	return body.Token
}

func TestViewStreamChangesNothing(t *testing.T) {
	s, m := newViewStreamServer(t, &Caps{DriveSize: true})
	c, _, err := dialStream(t, s.URL, "token="+viewToken(t, s)+"&pane=0&drive=1&cols=50&rows=10", viewHeader(s))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	ft := s.term(t, 0)
	ctx := context.Background()
	c.Write(ctx, websocket.MessageBinary, []byte("rm -rf ~\r"))
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":90,"rows":30}`))
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"drive","on":true}`))
	// Output still flows, and arrives after the frames above were read.
	ft.out <- []byte("hi")
	if typ, data, err := readFrame(t, c); err != nil || typ != websocket.MessageBinary || string(data) != "hi" {
		t.Fatalf("output = %v %q %v", typ, data, err)
	}
	time.Sleep(50 * time.Millisecond)
	ft.mu.Lock()
	in, sizes := string(ft.in), ft.sizes
	ft.mu.Unlock()
	if in != "" || len(sizes) != 0 {
		t.Errorf("a view-only stream reached the pane: input %q, resizes %v", in, sizes)
	}
	if p := m.waitAttached(t); p != "0" || !slices.Equal(m.calls, []string{"peek"}) {
		t.Errorf("attached %q, calls %v: want a peek and a read-only attach (no snapshot, no select)", p, m.calls)
	}
}

func TestViewStreamRefusals(t *testing.T) {
	s, m := newViewStreamServer(t, nil)
	// Another window than the current one: attaching would switch it.
	_, resp, err := dialStream(t, s.URL, "token="+viewToken(t, s)+"&pane=1", viewHeader(s))
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("view stream to another window: %v %v", resp, err)
	}
	// A backend that cannot attach read-only is refused, never given a
	// normal stream.
	m.canView = false
	_, resp, err = dialStream(t, s.URL, "token="+viewToken(t, s)+"&pane=0", viewHeader(s))
	if err == nil || resp == nil || resp.StatusCode != http.StatusNotImplemented {
		t.Errorf("view stream without read-only attach: %v %v", resp, err)
	}
	if slices.ContainsFunc(m.calls, func(c string) bool { return strings.HasPrefix(c, "select") }) || len(m.attached) != 0 {
		t.Errorf("calls = %v, attaches %d", m.calls, len(m.attached))
	}
	// Herdr (client-side select) streams any pane read-only.
	m.canView, m.caps = true, &Caps{ClientSideSelect: true}
	c, _, err := dialStream(t, s.URL, "token="+viewToken(t, s)+"&pane=1", viewHeader(s))
	if err != nil {
		t.Fatalf("herdr view stream: %v", err)
	}
	defer c.CloseNow()
	if p := m.waitAttached(t); p != "1" {
		t.Errorf("herdr attached %q", p)
	}
}

func TestViewStreamCannotPushOutFull(t *testing.T) {
	s, _ := newViewStreamServer(t, nil)
	var full []*websocket.Conn
	for range maxStreams {
		hdr := http.Header{}
		hdr.Set("Origin", s.URL)
		req, _ := http.NewRequest("GET", s.URL+"/api/mux/stream-token", nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var body struct{ Token string }
		json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		c, _, err := dialStream(t, s.URL, "token="+body.Token+"&pane=0", hdr)
		if err != nil {
			t.Fatal(err)
		}
		defer c.CloseNow()
		full = append(full, c)
	}
	for i := range maxStreams {
		s.term(t, i)
	}
	c, _, err := dialStream(t, s.URL, "token="+viewToken(t, s)+"&pane=0", viewHeader(s))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	if typ, data, _ := readFrame(t, c); typ != websocket.MessageText || !strings.Contains(string(data), "too many viewers") {
		t.Errorf("view into a full hub: %v %q", typ, data)
	}
	for i := range maxStreams {
		if s.term(t, i).isClosed() {
			t.Errorf("full stream %d closed by a view-only one", i)
		}
	}
}

// fresh=1 drops the root's cached file list; a view-only client's is ignored.
func TestViewFindIgnoresFresh(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := t.TempDir()
	gitInit(t, repo)
	os.WriteFile(filepath.Join(repo, "alpha.txt"), []byte("x"), 0o600)
	_, h := viewFilesFixture(t, repo)
	find := func(req *http.Request) string {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("find: %d %s", rec.Code, rec.Body)
		}
		return rec.Body.String()
	}
	find(viewRequest("GET", "/api/mux/panes/0/files/find?q=a", ""))
	os.WriteFile(filepath.Join(repo, "another.txt"), []byte("x"), 0o600)
	if got := find(viewRequest("GET", "/api/mux/panes/0/files/find?q=another&fresh=1", "")); strings.Contains(got, "another.txt") {
		t.Errorf("a view-only fresh=1 rebuilt the list: %s", got)
	}
	full := apiRequest("GET", "/api/mux/panes/0/files/find?q=another&fresh=1", "")
	full.Header.Del("Authorization")
	if got := find(full); !strings.Contains(got, "another.txt") {
		t.Errorf("a full client's fresh=1 did not rebuild: %s", got)
	}
}

// The snapshot names the role: full for Basic auth, none without sign-in.
func TestSnapshotRole(t *testing.T) {
	h := newTestHandler(t, &fakeMux{snap: oneTabSnapshot()})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, apiRequest("GET", "/api/mux/snapshot", ""))
	var snap Snapshot
	json.Unmarshal(rec.Body.Bytes(), &snap)
	if snap.Caps.Role != "full" {
		t.Errorf("Basic auth role = %q, want full", snap.Caps.Role)
	}
}

// basicAuth refuses a view-only client's writes before any handler, through
// serveAs; a full client passes.
func TestServeAsDeniesViewWrites(t *testing.T) {
	called := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called++ })
	rec := httptest.NewRecorder()
	serveAs(next, rec, httptest.NewRequest("POST", "/api/mux/tabs", nil), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"})
	assertViewOnly(t, "serveAs view POST", rec)
	serveAs(next, httptest.NewRecorder(), httptest.NewRequest("POST", "/api/mux/tabs", nil), authInfo{Kind: authSession, Role: roleFull})
	serveAs(next, httptest.NewRecorder(), httptest.NewRequest("GET", "/api/mux/tabs", nil), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"})
	if called != 2 {
		t.Errorf("handler ran %d times, want 2 (full write, view read)", called)
	}
}
