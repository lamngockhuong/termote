package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// newSigninServer is the server with sign-in, on a backend whose full
// attaches report on the returned channel. devices adds a device store.
func newSigninServer(t *testing.T, devices bool) (http.Handler, chan string) {
	t.Helper()
	cfg := testConfig(t)
	if devices {
		cfg.DevicesDir = filepath.Join(t.TempDir(), "devices")
	}
	attached := make(chan string, 16)
	m := &viewMux{fakeMux: &fakeMux{snap: oneTabSnapshot()}, canView: true, attached: make(chan string, 16)}
	m.attach = func(pane string, _ Size) (TermStream, error) {
		attached <- pane
		return newFakeTerm(), nil
	}
	h, hub, _, err := buildServer(cfg, m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	return h, attached
}

// signIn posts the sign-in form from a browser with User-Agent ua and
// returns its session cookie.
func signIn(t *testing.T, h http.Handler, ua string) *http.Cookie {
	t.Helper()
	rec := postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, func(r *http.Request) {
		r.Host = "localhost:7680"
		r.RemoteAddr = "192.0.2.9:4444"
		r.Header.Set("User-Agent", ua)
	})
	c := sessionCookieOf(rec)
	if rec.Code != http.StatusSeeOther || c == nil {
		t.Fatalf("sign in: %d %s", rec.Code, rec.Body)
	}
	return c
}

// listSignins reads GET /api/mux/signins as req's client.
func listSignins(t *testing.T, h http.Handler, req *http.Request) []signinView {
	t.Helper()
	rec := serve(h, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
	var body struct{ Sessions []signinView }
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Sessions
}

func signedInCode(h http.Handler, c *http.Cookie) int {
	return serve(h, asDevice("GET", "/api/mux/snapshot", "", c)).Code
}

// Basic auth makes a session only for a browser: the CLI's and curl's
// requests (no Sec-Fetch-Mode, no page load) would push the real sessions
// out. A browser over plain HTTP to a LAN address sends no Sec-Fetch-*
// header, but its page load asks for text/html.
func TestBasicSessionOnlyForBrowsers(t *testing.T) {
	h := basicAuth("admin", "secret", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	for _, tc := range []struct {
		name, path string
		hdr        map[string]string
		want       bool
	}{
		{"cli health", "/api/mux/health", nil, false},
		{"curl page", "/", map[string]string{"Accept": "*/*"}, false},
		{"fetch over https", "/api/mux/snapshot", map[string]string{"Sec-Fetch-Mode": "cors"}, true},
		{"page load over http lan", "/", map[string]string{"Accept": "text/html,application/xhtml+xml"}, true},
		{"api read over http lan", "/api/mux/snapshot", map[string]string{"Accept": "text/html"}, false},
		// Its session ended: the app's next read carries the dead cookie
		// and the saved Basic auth, and gets a session again.
		{"api read over http lan after its session ended", "/api/mux/snapshot", map[string]string{"Cookie": sessionCookieName + "=dead"}, true},
	} {
		req := httptest.NewRequest("GET", tc.path, nil)
		req.SetBasicAuth("admin", "secret")
		for k, v := range tc.hdr {
			req.Header.Set(k, v)
		}
		rec := serve(h, req)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: %d", tc.name, rec.Code)
		}
		if got := sessionCookieOf(rec) != nil; got != tc.want {
			t.Errorf("%s: session cookie %v, want %v", tc.name, got, tc.want)
		}
	}
}

// A session keeps how and from where it signed in; its User-Agent is
// cleaned and cut, and lastUsedAt moves at most once a minute.
func TestSessionMeta(t *testing.T) {
	clock := time.Date(2026, 10, 10, 8, 0, 0, 0, time.UTC)
	s := newSessionAuth(nil, nil)
	s.now = func() time.Time { return clock }
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "[2001:db8::7]:5555"
	req.Header.Set("User-Agent", "Mozilla\u202e\x07 Safari\u200b"+strings.Repeat("x", 300))
	token, err := s.start(req, sessionViaBasic)
	if err != nil {
		t.Fatal(err)
	}
	list := s.list("")
	if len(list) != 1 {
		t.Fatalf("list: %+v", list)
	}
	v := list[0]
	if v.ID != sessionID(token) || len(v.ID) != 16 || strings.Contains(v.ID, token) {
		t.Errorf("id %q", v.ID)
	}
	if v.Via != "basic" || v.IP != "2001:db8::7" || v.Current {
		t.Errorf("meta: %+v", v)
	}
	if !strings.HasPrefix(v.UserAgent, "Mozilla Safari") || len(v.UserAgent) != maxSessionUA {
		t.Errorf("user agent %q (%d bytes)", v.UserAgent, len(v.UserAgent))
	}
	if !v.ExpiresAt.After(clock) {
		t.Errorf("expiresAt %v", v.ExpiresAt)
	}

	clock = clock.Add(30 * time.Second)
	if id, ok := s.lookup(token); !ok || id != v.ID {
		t.Fatalf("lookup: %q %v", id, ok)
	}
	if got := s.list(v.ID)[0]; !got.LastUsedAt.Equal(v.CreatedAt) || !got.Current {
		t.Errorf("lastUsedAt moved within a minute: %+v", got)
	}
	clock = clock.Add(31 * time.Second)
	s.lookup(token)
	if got := s.list("")[0].LastUsedAt; !got.Equal(clock) {
		t.Errorf("lastUsedAt %v, want %v", got, clock)
	}
	if _, ok := s.lookup("nope"); ok {
		t.Error("unknown token found")
	}
}

// The list shows every browser signed in, the caller's marked, and never a
// token or a cookie value; one is signed out by id, the others all at once.
func TestSigninRoutes(t *testing.T) {
	h, _ := newSigninServer(t, false)
	a := signIn(t, h, "Browser A")
	b := signIn(t, h, "Browser B")

	rec := serve(h, asDevice("GET", "/api/mux/signins", "", a))
	for _, c := range []*http.Cookie{a, b} {
		if strings.Contains(rec.Body.String(), c.Value) {
			t.Fatal("list carries a session token")
		}
	}
	list := listSignins(t, h, asDevice("GET", "/api/mux/signins", "", a))
	if len(list) != 2 {
		t.Fatalf("list: %+v", list)
	}
	ids := map[string]signinView{}
	for _, v := range list {
		ids[v.UserAgent] = v
	}
	if !ids["Browser A"].Current || ids["Browser B"].Current || ids["Browser A"].Via != "form" || ids["Browser A"].IP != "192.0.2.9" {
		t.Errorf("list: %+v", list)
	}

	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	rec = serve(h, asDevice("DELETE", "/api/mux/signins/"+ids["Browser B"].ID, "", a))
	if rec.Code != http.StatusOK || decodeBody(t, rec)["ok"] != true {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body)
	}
	if code := signedInCode(h, b); code != http.StatusUnauthorized {
		t.Errorf("revoked session: %d", code)
	}
	if code := signedInCode(h, a); code != http.StatusOK {
		t.Errorf("caller's session after revoking another: %d", code)
	}
	if want := `audit: revoke-session id="` + ids["Browser B"].ID + `" by="password" via="settings"`; !strings.Contains(buf.String(), want) {
		t.Errorf("audit line missing %q:\n%s", want, buf.String())
	}

	rec = serve(h, asDevice("DELETE", "/api/mux/signins/0123456789abcdef", "", a))
	if body := decodeBody(t, rec); rec.Code != http.StatusNotFound || body["code"] != "unknown_session" {
		t.Errorf("unknown id: %d %v", rec.Code, body)
	}

	// All others: the caller's own stays.
	c := signIn(t, h, "Browser C")
	d := signIn(t, h, "Browser D")
	rec = serve(h, asDevice("DELETE", "/api/mux/signins", "", a))
	if body := decodeBody(t, rec); rec.Code != http.StatusOK || body["revoked"] != float64(2) {
		t.Fatalf("revoke others: %d %v", rec.Code, body)
	}
	for name, ck := range map[string]*http.Cookie{"C": c, "D": d} {
		if code := signedInCode(h, ck); code != http.StatusUnauthorized {
			t.Errorf("%s after revoke others: %d", name, code)
		}
	}
	if code := signedInCode(h, a); code != http.StatusOK {
		t.Errorf("caller after revoke others: %d", code)
	}
	if !strings.Contains(buf.String(), `audit: revoke-session id="all" by="password" via="settings" revoked=`) {
		t.Errorf("bulk audit line missing:\n%s", buf.String())
	}

	// The CLI (Basic auth) has no session of its own: every one goes.
	rec = serve(h, apiRequest("DELETE", "/api/mux/signins", ""))
	if body := decodeBody(t, rec); rec.Code != http.StatusOK || body["revoked"] != float64(1) {
		t.Fatalf("revoke all from the CLI: %d %v", rec.Code, body)
	}
	if code := signedInCode(h, a); code != http.StatusUnauthorized {
		t.Errorf("caller's browser after the CLI's revoke all: %d", code)
	}
	if !strings.Contains(buf.String(), `via="cli"`) {
		t.Errorf("cli audit line missing:\n%s", buf.String())
	}
	if list := listSignins(t, h, apiRequest("GET", "/api/mux/signins", "")); len(list) != 0 {
		t.Errorf("sessions left: %+v", list)
	}
}

// A full device lists the sign-ins but revokes none; a view-only one gets
// nothing; another site's page cannot read the list; a write needs JSON.
func TestSigninRoutesRefusals(t *testing.T) {
	h, _ := newSigninServer(t, true)
	session := signIn(t, h, "Owner")
	full := pairDevice(t, h, "full")
	view := pairDevice(t, h, "view")

	if list := listSignins(t, h, asDevice("GET", "/api/mux/signins", "", full)); len(list) != 1 || list[0].Current {
		t.Errorf("full device list: %+v", list)
	}
	for c, want := range map[*http.Cookie]bool{full: false, session: true} {
		if got := decodeBody(t, serve(h, asDevice("GET", "/api/mux/signins", "", c)))["canRevoke"]; got != want {
			t.Errorf("canRevoke = %v, want %v", got, want)
		}
	}
	id := listSignins(t, h, asDevice("GET", "/api/mux/signins", "", session))[0].ID
	for _, path := range []string{"/api/mux/signins", "/api/mux/signins/" + id} {
		rec := serve(h, asDevice("DELETE", path, "", full))
		if body := decodeBody(t, rec); rec.Code != http.StatusForbidden || body["code"] != "full_needs_password" {
			t.Errorf("full device DELETE %s: %d %v", path, rec.Code, body)
		}
	}
	if code := signedInCode(h, session); code != http.StatusOK {
		t.Errorf("session after a full device's refused revoke: %d", code)
	}
	for _, req := range []*http.Request{
		asDevice("GET", "/api/mux/signins", "", view),
		asDevice("DELETE", "/api/mux/signins", "", view),
		asDevice("DELETE", "/api/mux/signins/"+id, "", view),
	} {
		rec := serve(h, req)
		if body := decodeBody(t, rec); rec.Code != http.StatusForbidden || body["code"] != "view_only" {
			t.Errorf("view device %s %s: %d %v", req.Method, req.URL.Path, rec.Code, body)
		}
	}

	req := asDevice("GET", "/api/mux/signins", "", session)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site list: %d", rec.Code)
	}
	req = asDevice("DELETE", "/api/mux/signins", "", session)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site revoke: %d", rec.Code)
	}
	req = asDevice("DELETE", "/api/mux/signins", "", session)
	req.Header.Del("Content-Type")
	if rec := serve(h, req); rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("revoke without JSON: %d", rec.Code)
	}
	if rec := serve(h, asDevice("POST", "/api/mux/signins", "{}", session)); rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, DELETE" {
		t.Errorf("POST: %d %q", rec.Code, rec.Header().Get("Allow"))
	}
	if rec := serve(h, asDevice("GET", "/api/mux/signins/"+id, "", session)); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET one: %d", rec.Code)
	}
	if code := signedInCode(h, session); code != http.StatusOK {
		t.Errorf("session after refused revokes: %d", code)
	}

	var snap Snapshot
	json.Unmarshal(serve(h, apiRequest("GET", "/api/mux/snapshot", "")).Body.Bytes(), &snap)
	if !snap.Caps.Signins {
		t.Error("caps.signins false with sign-in on")
	}
}

func TestSigninsWithoutAuth(t *testing.T) {
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass = true, ""
	h, hub, _, err := buildServer(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.shutdown(context.Background())
	for _, req := range []*http.Request{
		apiRequest("GET", "/api/mux/signins", ""),
		apiRequest("DELETE", "/api/mux/signins", ""),
		apiRequest("DELETE", "/api/mux/signins/0123456789abcdef", ""),
	} {
		rec := serve(h, req)
		if body := decodeBody(t, rec); rec.Code != http.StatusNotImplemented || body["code"] != "unsupported" {
			t.Errorf("%s %s: %d %v", req.Method, req.URL.Path, rec.Code, body)
		}
	}
	var snap Snapshot
	json.Unmarshal(serve(h, apiRequest("GET", "/api/mux/snapshot", "")).Body.Bytes(), &snap)
	if snap.Caps.Signins {
		t.Error("caps.signins without sign-in")
	}
}

// openSessionStream opens a terminal stream signed in by session cookie c.
func openSessionStream(t *testing.T, srv *httptest.Server, c *http.Cookie, attached chan string) *websocket.Conn {
	t.Helper()
	tok := sessionStreamToken(t, srv, c)
	hdr := http.Header{}
	hdr.Set("Origin", srv.URL)
	hdr.Set("Cookie", c.Name+"="+c.Value)
	ws, _, err := dialStream(t, srv.URL, "token="+tok+"&pane=0", hdr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	select {
	case <-attached:
	case <-time.After(5 * time.Second):
		t.Fatal("no attach")
	}
	return ws
}

func sessionStreamToken(t *testing.T, srv *httptest.Server, c *http.Cookie) string {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/mux/stream-token", nil)
	req.AddCookie(c)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var tok struct{ Token string }
	json.NewDecoder(resp.Body).Decode(&tok)
	if tok.Token == "" {
		t.Fatalf("stream-token: %d", resp.StatusCode)
	}
	return tok.Token
}

func wantSignedOutClose(t *testing.T, ws *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := ws.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("stream after sign-out: %v", err)
	}
}

// Signing a browser out closes its open terminal, with or without a device
// store (pairing off).
func TestSigninRevokeClosesStream(t *testing.T) {
	for _, devices := range []bool{false, true} {
		h, attached := newSigninServer(t, devices)
		srv := httptest.NewServer(h)
		defer srv.Close()
		owner := signIn(t, h, "Owner")
		other := signIn(t, h, "Other")
		ws := openSessionStream(t, srv, other, attached)
		mine := openSessionStream(t, srv, owner, attached)

		rec := serve(h, asDevice("DELETE", "/api/mux/signins", "", owner))
		if rec.Code != http.StatusOK {
			t.Fatalf("revoke: %d %s", rec.Code, rec.Body)
		}
		wantSignedOutClose(t, ws)
		// The caller's own stream stays open.
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		_, _, err := mine.Read(ctx)
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("caller's stream: %v", err)
		}
	}
}

// Log out closes the session's open terminal too.
func TestLogoutClosesSessionStream(t *testing.T) {
	h, attached := newSigninServer(t, false)
	srv := httptest.NewServer(h)
	defer srv.Close()
	c := signIn(t, h, "Browser")
	ws := openSessionStream(t, srv, c, attached)
	out := asDevice("POST", logoutPath, "{}", c)
	if rec := serve(h, out); rec.Code != http.StatusNoContent {
		t.Fatalf("logout: %d", rec.Code)
	}
	wantSignedOutClose(t, ws)
}

// A stream token taken before a sign-out opens nothing after it, even
// presented with the password.
func TestSigninRevokeDropsStreamTokens(t *testing.T) {
	h, _ := newSigninServer(t, false)
	srv := httptest.NewServer(h)
	defer srv.Close()
	c := signIn(t, h, "Browser")
	tok := sessionStreamToken(t, srv, c)
	if rec := serve(h, apiRequest("DELETE", "/api/mux/signins", "")); rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d", rec.Code)
	}
	hdr := authHeader()
	hdr.Set("Origin", srv.URL)
	if _, resp, err := dialStream(t, srv.URL, "token="+tok+"&pane=0", hdr); err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("dial with a revoked session's token: %v %v", err, resp)
	}
}

// The hub refuses a stream of a session revoked between its token and its
// upgrade, and closeSession ends only that session's streams.
func TestHubSessionRevoked(t *testing.T) {
	h := newStreamHub(4)
	live := map[string]bool{"s1": true, "s2": true}
	h.sessionAlive = func(id string) bool { return live[id] }
	type stream struct {
		ctx    context.Context
		cancel context.CancelCauseFunc
	}
	open := func() stream {
		ctx, cancel := context.WithCancelCause(context.Background())
		return stream{ctx, cancel}
	}
	s1, s2, basic := open(), open(), open()
	for _, c := range []struct {
		s  stream
		id string
	}{{s1, "s1"}, {s2, "s2"}, {basic, ""}} {
		if _, err := h.addFor(c.s.cancel, roleFull, "", c.id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.addFor(open().cancel, roleFull, "", "gone"); !errors.Is(err, errSessionRevoked) {
		t.Errorf("revoked session added: %v", err)
	}
	h.closeSession("s1")
	h.closeSession("")
	if !errors.Is(context.Cause(s1.ctx), errSessionRevoked) {
		t.Error("closeSession left the stream open")
	}
	if s2.ctx.Err() != nil || basic.ctx.Err() != nil {
		t.Error("closeSession closed another stream")
	}
}

// revokeSession drops only that session's stream tokens.
func TestTokenStoreRevokeSession(t *testing.T) {
	s := newStreamTokenStore()
	a, _ := s.generateGrant(roleFull, "", "s1")
	b, _ := s.generateGrant(roleFull, "", "s2")
	c, _ := s.generateFor(roleFull, "")
	s.revokeSession("s1")
	s.revokeSession("")
	if _, ok := s.check(a); ok {
		t.Error("revoked session's token still valid")
	}
	if ti, ok := s.check(b); !ok || ti.sessionID != "s2" {
		t.Errorf("other session's token: %+v %v", ti, ok)
	}
	if _, ok := s.check(c); !ok {
		t.Error("Basic client's token dropped")
	}
}

// An expired session is neither alive nor listed; the list is the most
// recently used first.
func TestSessionExpiryAndOrder(t *testing.T) {
	clock := time.Now()
	s := newSessionAuth(nil, nil)
	s.now = func() time.Time { return clock }
	req := httptest.NewRequest("GET", "/", nil)
	old, _ := s.start(req, sessionViaForm)
	clock = clock.Add(2 * time.Minute)
	recent, _ := s.start(req, sessionViaForm)
	clock = clock.Add(2 * time.Minute)
	s.lookup(old)
	list := s.list("")
	if len(list) != 2 || list[0].ID != sessionID(old) || list[1].ID != sessionID(recent) {
		t.Fatalf("order: %+v", list)
	}
	// Used in the same minute: the newer sign-in first.
	s.lookup(recent)
	if list := s.list(""); list[0].ID != sessionID(recent) {
		t.Errorf("tie order: %+v", list)
	}
	clock = clock.Add(sessionTTL)
	if s.alive(sessionID(old)) || len(s.list("")) != 0 {
		t.Error("expired session alive or listed")
	}
}
