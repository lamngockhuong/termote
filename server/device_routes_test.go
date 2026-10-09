package main

import (
	"context"
	"encoding/json"
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

// newDeviceServer is the server with sign-in and a device store, on a
// backend that can attach read-only.
func newDeviceServer(t *testing.T) (http.Handler, *viewMux, *streamHub, string) {
	t.Helper()
	cfg := testConfig(t)
	cfg.DevicesDir = filepath.Join(t.TempDir(), "devices")
	m := &viewMux{fakeMux: &fakeMux{snap: oneTabSnapshot()}, canView: true, attached: make(chan string, 16)}
	m.attach = func(string, Size) (TermStream, error) { return newFakeTerm(), nil }
	h, hub, _, err := buildServer(cfg, m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	return h, m, hub, cfg.DevicesDir
}

// makePairCode asks for a code with Basic auth, as the CLI does.
func makePairCode(t *testing.T, h http.Handler, body string) map[string]any {
	t.Helper()
	rec := serve(h, apiRequest("POST", "/api/mux/devices/pair", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("devices/pair: %d %s", rec.Code, rec.Body)
	}
	return decodeBody(t, rec)
}

func postPair(h http.Handler, form url.Values, mutate func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", pairPath, strings.NewReader(form.Encode()))
	req.Host = "localhost:7680"
	req.RemoteAddr = "192.0.2.7:5555"
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if mutate != nil {
		mutate(req)
	}
	return serve(h, req)
}

// pageRequest is a browser's page load on the server's own host.
func pageRequest(path string) *http.Request {
	req := httptest.NewRequest("GET", path, nil)
	req.Host = "localhost:7680"
	return req
}

func deviceCookieOf(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if strings.HasPrefix(c.Name, "termote_device_") {
			return c
		}
	}
	return nil
}

// pairDevice pairs a device of role r and returns its cookie.
func pairDevice(t *testing.T, h http.Handler, r string) *http.Cookie {
	t.Helper()
	code := makePairCode(t, h, `{"role":"`+r+`","name":"Test `+r+`"}`)["code"].(string)
	rec := postPair(h, url.Values{"code": {code}}, nil)
	c := deviceCookieOf(rec)
	if rec.Code != http.StatusSeeOther || c == nil || c.Value == "" {
		t.Fatalf("pair: %d %v %s", rec.Code, c, rec.Body)
	}
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.MaxAge != int(deviceCookieMaxAge.Seconds()) {
		t.Errorf("cookie attributes: %+v", c)
	}
	return c
}

// asDevice is apiRequest signed in by a device cookie instead of Basic auth.
func asDevice(method, path, body string, c *http.Cookie) *http.Request {
	req := apiRequest(method, path, body)
	req.Header.Del("Authorization")
	req.AddCookie(c)
	return req
}

func snapshotRole(t *testing.T, h http.Handler, c *http.Cookie) (int, string) {
	t.Helper()
	rec := serve(h, asDevice("GET", "/api/mux/snapshot", "", c))
	if rec.Code != http.StatusOK {
		return rec.Code, ""
	}
	var snap Snapshot
	json.Unmarshal(rec.Body.Bytes(), &snap)
	return rec.Code, snap.Caps.Role
}

func TestPairViewDeviceEndToEnd(t *testing.T) {
	h, m, _, dir := newDeviceServer(t)
	res := makePairCode(t, h, `{"role":"view","name":"Phone"}`)
	code := res["code"].(string)
	if link, _ := res["url"].(string); link != "http://localhost:7680/pair?code="+code {
		t.Errorf("url = %q", link)
	}
	if qr, _ := res["qr"].(string); !strings.HasPrefix(qr, "data:image/png;base64,") {
		t.Errorf("qr = %.40q", qr)
	}
	// The form, with the code filled in; a page that is not a code is not
	// echoed.
	page := serve(h, pageRequest(pairPath+"?code="+url.QueryEscape(code)))
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), code) {
		t.Errorf("GET /pair: %d", page.Code)
	}
	if body := serve(h, pageRequest(pairPath+"?code=%3Cscript%3E")).Body.String(); strings.Contains(body, "script>") {
		t.Error("GET /pair echoed a non-code")
	}

	rec := postPair(h, url.Values{"code": {code}}, nil)
	c := deviceCookieOf(rec)
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/" || c == nil {
		t.Fatalf("POST /pair: %d %s", rec.Code, rec.Body)
	}
	if code, role := snapshotRole(t, h, c); code != http.StatusOK || role != "view" {
		t.Fatalf("snapshot as the device: %d %q", code, role)
	}
	// Survives a restart of the server (same store).
	cfg := testConfig(t)
	cfg.DevicesDir = dir
	h2, hub2, _, _ := buildServer(cfg, m)
	defer hub2.shutdown(context.Background())
	if code, role := snapshotRole(t, h2, c); code != http.StatusOK || role != "view" {
		t.Errorf("after a restart: %d %q", code, role)
	}
	// A view-only device writes nothing, manages no devices.
	for _, req := range []*http.Request{
		asDevice("POST", "/api/mux/tabs", `{"name":"x"}`, c),
		asDevice("POST", "/api/mux/devices/pair", `{"role":"full"}`, c),
		asDevice("GET", "/api/mux/devices", "", c),
	} {
		assertViewOnly(t, req.Method+" "+req.URL.Path, serve(h, req))
	}
	// The list names it, by Basic auth.
	list := decodeBody(t, serve(h, apiRequest("GET", "/api/mux/devices", "")))
	devs := list["devices"].([]any)
	if len(devs) != 1 || devs[0].(map[string]any)["name"] != "Phone" || devs[0].(map[string]any)["role"] != "view" {
		t.Fatalf("devices = %v", list)
	}
	id := devs[0].(map[string]any)["id"].(string)
	if rec := serve(h, apiRequest("DELETE", "/api/mux/devices/"+id, "")); rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body)
	}
	rec = serve(h, asDevice("GET", "/api/mux/snapshot", "", c))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("revoked device: %d", rec.Code)
	}
	if cleared := deviceCookieOf(rec); cleared == nil || cleared.MaxAge >= 0 {
		t.Errorf("revoked device's cookie not cleared: %v", cleared)
	}
	if rec := serve(h, apiRequest("DELETE", "/api/mux/devices/"+id, "")); rec.Code != http.StatusNotFound {
		t.Errorf("revoke twice: %d", rec.Code)
	}
}

func TestPairFullDeviceAndCurrent(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	c := pairDevice(t, h, "full")
	if code, role := snapshotRole(t, h, c); code != http.StatusOK || role != "full" {
		t.Fatalf("full device: %d %q", code, role)
	}
	// A full device makes codes and sees itself as current.
	rec := serve(h, asDevice("POST", "/api/mux/devices/pair", `{"role":"view"}`, c))
	if rec.Code != http.StatusOK {
		t.Fatalf("pair from a full device: %d %s", rec.Code, rec.Body)
	}
	list := decodeBody(t, serve(h, asDevice("GET", "/api/mux/devices", "", c)))
	if d := list["devices"].([]any)[0].(map[string]any); d["current"] != true {
		t.Errorf("current = %v", d)
	}
	// Log out revokes it.
	out := asDevice("POST", logoutPath, "{}", c)
	if rec := serve(h, out); rec.Code != http.StatusNoContent || deviceCookieOf(rec) == nil {
		t.Fatalf("logout: %d", rec.Code)
	}
	if code, _ := snapshotRole(t, h, c); code != http.StatusUnauthorized {
		t.Errorf("after logout: %d", code)
	}
	// Its waiting code went with it.
	if body := decodeBody(t, serve(h, apiRequest("GET", "/api/mux/devices", ""))); len(body["devices"].([]any)) != 0 {
		t.Errorf("devices after logout: %v", body)
	}
}

func TestPairRefusals(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	// No code waiting: refused, not counted.
	for range authMaxFailures + 2 {
		if rec := postPair(h, url.Values{"code": {"AAAAA-AAAAA"}}, nil); rec.Code != http.StatusUnauthorized {
			t.Fatalf("no code waiting: %d", rec.Code)
		}
	}
	code := makePairCode(t, h, `{"role":"view"}`)["code"].(string)
	// Another site's form.
	for name, mutate := range map[string]func(*http.Request){
		"Sec-Fetch-Site": func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		"Origin":         func(r *http.Request) { r.Header.Del("Sec-Fetch-Site"); r.Header.Set("Origin", "https://evil.example") },
	} {
		if rec := postPair(h, url.Values{"code": {code}}, mutate); rec.Code != http.StatusForbidden {
			t.Errorf("cross-site by %s: %d", name, rec.Code)
		}
	}
	// A browser signed in with the password is never paired.
	login := postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, func(r *http.Request) { r.Host = "localhost:7680" })
	session := sessionCookieOf(login)
	if rec := postPair(h, url.Values{"code": {code}}, func(r *http.Request) { r.AddCookie(session) }); rec.Code != http.StatusConflict {
		t.Errorf("signed-in browser: %d", rec.Code)
	}
	// The code survived the refusals above.
	if rec := postPair(h, url.Values{"code": {code}}, nil); rec.Code != http.StatusSeeOther {
		t.Fatalf("pair after refusals: %d %s", rec.Code, rec.Body)
	}
	// Wrong codes are rate limited per IP, apart from the password.
	makePairCode(t, h, `{"role":"view"}`)
	for range authMaxFailures {
		postPair(h, url.Values{"code": {"ZZZZZ-ZZZZZ"}}, nil)
	}
	if rec := postPair(h, url.Values{"code": {"ZZZZZ-ZZZZZ"}}, nil); rec.Code != http.StatusTooManyRequests {
		t.Errorf("after %d wrong codes: %d", authMaxFailures, rec.Code)
	}
	login = postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, func(r *http.Request) {
		r.Host = "localhost:7680"
		r.RemoteAddr = "192.0.2.7:5555"
	})
	if sessionCookieOf(login) == nil {
		t.Error("wrong pairing codes locked out the password")
	}
	// Bad requests for a code.
	for _, body := range []string{`{"role":"admin"}`, `{"role":"view","name":"a‮b"}`} {
		if rec := serve(h, apiRequest("POST", "/api/mux/devices/pair", body)); rec.Code != http.StatusBadRequest {
			t.Errorf("pair %s: %d", body, rec.Code)
		}
	}
	// The sign-in page links the pairing form; next never leads to it.
	if body := serve(h, pageRequest(loginPath)).Body.String(); !strings.Contains(body, `href="/pair"`) {
		t.Error("sign-in page has no pairing link")
	}
	if got := safeNext("/pair?code=ABCDE-FGHJK"); got != "/" {
		t.Errorf("safeNext(/pair) = %q", got)
	}
}

// A view-only device pairing again replaces its old device.
func TestPairAgainReplacesViewDevice(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	old := pairDevice(t, h, "view")
	code := makePairCode(t, h, `{"role":"view"}`)["code"].(string)
	rec := postPair(h, url.Values{"code": {code}}, func(r *http.Request) { r.AddCookie(old) })
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("pair again: %d %s", rec.Code, rec.Body)
	}
	if code, _ := snapshotRole(t, h, old); code != http.StatusUnauthorized {
		t.Errorf("old device still signs in: %d", code)
	}
	if n := len(decodeBody(t, serve(h, apiRequest("GET", "/api/mux/devices", "")))["devices"].([]any)); n != 1 {
		t.Errorf("%d devices, want 1", n)
	}
}

// Changing the password ends every device (they stay on disk).
func TestDevicesEndWithThePassword(t *testing.T) {
	h, m, _, dir := newDeviceServer(t)
	c := pairDevice(t, h, "full")
	cfg := testConfig(t)
	cfg.Pass, cfg.DevicesDir = "another", dir
	h2, hub2, _, _ := buildServer(cfg, m)
	defer hub2.shutdown(context.Background())
	if code, _ := snapshotRole(t, h2, c); code != http.StatusUnauthorized {
		t.Errorf("device after a new password: %d", code)
	}
	if code, _ := snapshotRole(t, h, c); code != http.StatusOK {
		t.Errorf("device lost from the disk: %d", code)
	}
}

// Without sign-in, the device routes answer 501 and the store is untouched.
func TestDevicesWithoutAuth(t *testing.T) {
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass = true, ""
	cfg.DevicesDir = filepath.Join(t.TempDir(), "devices")
	h, hub, _, err := buildServer(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.shutdown(context.Background())
	for _, req := range []*http.Request{
		apiRequest("POST", "/api/mux/devices/pair", `{"role":"view"}`),
		apiRequest("GET", "/api/mux/devices", ""),
		apiRequest("DELETE", "/api/mux/devices/0123456789abcdef", ""),
	} {
		if rec := serve(h, req); rec.Code != http.StatusNotImplemented {
			t.Errorf("%s %s: %d", req.Method, req.URL.Path, rec.Code)
		}
	}
	if _, err := os.Stat(cfg.DevicesDir); !os.IsNotExist(err) {
		t.Errorf("store dir made without sign-in: %v", err)
	}
	var snap Snapshot
	json.Unmarshal(serve(h, apiRequest("GET", "/api/mux/snapshot", "")).Body.Bytes(), &snap)
	if snap.Caps.Devices {
		t.Error("caps.devices without sign-in")
	}
}

// Revoking a device closes its open stream.
func TestRevokeClosesStream(t *testing.T) {
	h, m, _, _ := newDeviceServer(t)
	srv := httptest.NewServer(h)
	defer srv.Close()
	c := pairDevice(t, h, "view")

	req, _ := http.NewRequest("GET", srv.URL+"/api/mux/stream-token", nil)
	req.AddCookie(c)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var tok struct{ Token string }
	json.NewDecoder(resp.Body).Decode(&tok)
	resp.Body.Close()
	hdr := http.Header{}
	hdr.Set("Origin", srv.URL)
	hdr.Set("Cookie", c.Name+"="+c.Value)
	ws, _, err := dialStream(t, srv.URL, "token="+tok.Token+"&pane=0", hdr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.CloseNow()
	m.waitAttached(t)

	list := decodeBody(t, serve(h, apiRequest("GET", "/api/mux/devices", "")))
	id := list["devices"].([]any)[0].(map[string]any)["id"].(string)
	serve(h, apiRequest("DELETE", "/api/mux/devices/"+id, ""))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err = ws.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("stream after revoke: %v", err)
	}
}

// Health says whether pairing works, to signed-in callers only (container
// status reads it).
func TestHealthReportsDevices(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	if body := decodeBody(t, serve(h, apiRequest("GET", "/api/mux/health", ""))); body["devices"] != true {
		t.Errorf("health with a store: %v", body)
	}
	h = newTestHandler(t, &fakeMux{})
	if body := decodeBody(t, serve(h, apiRequest("GET", "/api/mux/health", ""))); body["devices"] != false {
		t.Errorf("health without a store: %v", body)
	}
}

// A request with both cookies signs in by the session; logging out ends
// both, the device revoked.
func TestSessionAndDeviceCookies(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	dev := pairDevice(t, h, "view")
	login := postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, func(r *http.Request) { r.Host = "localhost:7680" })
	session := sessionCookieOf(login)
	req := asDevice("GET", "/api/mux/snapshot", "", dev)
	req.AddCookie(session)
	var snap Snapshot
	json.Unmarshal(serve(h, req).Body.Bytes(), &snap)
	if snap.Caps.Role != "full" {
		t.Errorf("both cookies: role %q, want the session's full", snap.Caps.Role)
	}
	out := asDevice("POST", logoutPath, "{}", dev)
	out.AddCookie(session)
	rec := serve(h, out)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout: %d %s", rec.Code, rec.Body)
	}
	if c := deviceCookieOf(rec); c == nil || c.MaxAge >= 0 {
		t.Error("device cookie not expired")
	}
	if c := sessionCookieOf(rec); c == nil || c.MaxAge >= 0 {
		t.Error("session cookie not expired")
	}
	for name, c := range map[string]*http.Cookie{"device": dev, "session": session} {
		if code, _ := snapshotRole(t, h, c); code != http.StatusUnauthorized {
			t.Errorf("%s after logout: %d", name, code)
		}
	}
}

// A cookie naming no device is cleared and Basic auth still signs in; one
// of a device of another password is kept (the password may come back).
func TestUnknownAndStaleDeviceCookies(t *testing.T) {
	h, m, _, dir := newDeviceServer(t)
	c := pairDevice(t, h, "view")
	bogus := &http.Cookie{Name: c.Name, Value: deviceTokenTag + "nope"}
	req := apiRequest("GET", "/api/mux/snapshot", "")
	req.AddCookie(bogus)
	rec := serve(h, req)
	if rec.Code != http.StatusOK {
		t.Errorf("Basic with a bad device cookie: %d", rec.Code)
	}
	if cleared := deviceCookieOf(rec); cleared == nil || cleared.MaxAge >= 0 {
		t.Error("bad device cookie not cleared")
	}
	cfg := testConfig(t)
	cfg.Pass, cfg.DevicesDir = "another", dir
	h2, hub2, _, _ := buildServer(cfg, m)
	defer hub2.shutdown(context.Background())
	rec = serve(h2, asDevice("GET", "/api/mux/snapshot", "", c))
	if rec.Code != http.StatusUnauthorized || deviceCookieOf(rec) != nil {
		t.Errorf("stale device cookie: %d, cleared %v", rec.Code, deviceCookieOf(rec))
	}
}

// The device list is a same-site read.
func TestDeviceListCrossSite(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	req := apiRequest("GET", "/api/mux/devices", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site list: %d", rec.Code)
	}
}

// What the device store holds in memory is written even when shutdown runs
// out of time.
func TestHubShutdownRunsOnShutdown(t *testing.T) {
	h := newStreamHub(2)
	ran := false
	h.onShutdown = func() { ran = true }
	_, cancel := context.WithCancelCause(context.Background())
	h.add(cancel, roleFull, "") // never removed: shutdown times out
	ctx, done := context.WithCancel(context.Background())
	done()
	if err := h.shutdown(ctx); err == nil {
		t.Fatal("shutdown did not time out")
	}
	if !ran {
		t.Error("onShutdown skipped")
	}
}
