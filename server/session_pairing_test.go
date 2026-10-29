package main

import (
	"context"
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

	"github.com/coder/websocket"
)

// sessionPairCode asks for a code as the browser signed in with cookie c.
func sessionPairCode(t *testing.T, h http.Handler, c *http.Cookie, body string) string {
	t.Helper()
	rec := serve(h, asDevice("POST", "/api/mux/devices/pair", body, c))
	if rec.Code != http.StatusOK {
		t.Fatalf("devices/pair: %d %s", rec.Code, rec.Body)
	}
	return decodeBody(t, rec)["code"].(string)
}

// redeemCode pairs a new browser with code and returns its device cookie.
func redeemCode(t *testing.T, h http.Handler, code string) *http.Cookie {
	t.Helper()
	rec := postPair(h, url.Values{"code": {code}}, nil)
	c := deviceCookieOf(rec)
	if rec.Code != http.StatusSeeOther || c == nil || c.Value == "" {
		t.Fatalf("pair: %d %v %s", rec.Code, c, rec.Body)
	}
	return c
}

// sessionID returns the id of the session signed in with cookie c.
func sessionIDOf(t *testing.T, h http.Handler, c *http.Cookie) string {
	t.Helper()
	for _, s := range listSignins(t, h, asDevice("GET", "/api/mux/signins", "", c)) {
		if s.Current {
			return s.ID
		}
	}
	t.Fatal("no current session")
	return ""
}

// devicesPairedBy maps each listed device's id to its pairedBy.
func devicesPairedBy(t *testing.T, h http.Handler) map[string]string {
	t.Helper()
	var body struct{ Devices []deviceView }
	if err := json.Unmarshal(serve(h, apiRequest("GET", "/api/mux/devices", "")).Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, d := range body.Devices {
		out[d.ID] = d.PairedBy
	}
	return out
}

// A code made by a browser signed in with the password names its session,
// in the audit lines and in the device it pairs; the CLI's stays "password".
func TestPairFromSessionRecordsSession(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	buf := captureLog(t)
	owner := signIn(t, h, "Owner")
	id := sessionIDOf(t, h, owner)
	redeemCode(t, h, sessionPairCode(t, h, owner, `{"role":"view"}`))
	pairDevice(t, h, "view") // Basic auth, as the CLI
	got := map[string]int{}
	for _, by := range devicesPairedBy(t, h) {
		got[by]++
	}
	if got["session:"+id] != 1 || got[pairedByPassword] != 1 {
		t.Errorf("pairedBy = %v, want one session:%s and one password", got, id)
	}
	for _, want := range []string{
		`audit: pair-code role="view" validFor="0" by="session:` + id + `"`,
		`pairedBy="session:` + id + `"`,
		`audit: pair-code role="view" validFor="0" by="password"`,
		`pairedBy="password"`,
	} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("audit line missing %q:\n%s", want, buf.String())
		}
	}
}

// Revoking a session revokes the devices it paired, the devices those
// paired, and its waiting codes; closes their streams; and leaves the rest.
func TestRevokeSessionRevokesItsDevices(t *testing.T) {
	h, m, _, _ := newDeviceServer(t)
	srv := httptest.NewServer(h)
	defer srv.Close()
	buf := captureLog(t)
	owner := signIn(t, h, "Owner")
	leaked := signIn(t, h, "Leaked")
	leakedID := sessionIDOf(t, h, leaked)
	full := redeemCode(t, h, sessionPairCode(t, h, leaked, `{"role":"full"}`))
	view := redeemCode(t, h, sessionPairCode(t, h, full, `{"role":"view"}`))
	waiting := sessionPairCode(t, h, leaked, `{"role":"view"}`)
	mine := pairDevice(t, h, "view")
	ws := openDeviceStream(t, srv, view, m)

	rec := serve(h, asDevice("DELETE", "/api/mux/signins/"+leakedID, "", owner))
	if body := decodeBody(t, rec); rec.Code != http.StatusOK || body["devices"] != float64(2) {
		t.Fatalf("revoke: %d %v", rec.Code, body)
	}
	for name, c := range map[string]*http.Cookie{"session": leaked, "full device": full, "view device": view} {
		if code := signedInCode(h, c); code != http.StatusUnauthorized {
			t.Errorf("%s after its session's revoke: %d", name, code)
		}
	}
	for name, c := range map[string]*http.Cookie{"owner": owner, "CLI's device": mine} {
		if code := signedInCode(h, c); code != http.StatusOK {
			t.Errorf("%s after another session's revoke: %d", name, code)
		}
	}
	if rec := postPair(h, url.Values{"code": {waiting}}, nil); deviceCookieOf(rec) != nil {
		t.Error("a revoked session's waiting code paired a device")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := ws.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Errorf("stream of a revoked session's device: %v", err)
	}
	if want := `audit: revoke-session id="` + leakedID + `" by="session:`; !strings.Contains(buf.String(), want) || !strings.Contains(buf.String(), `devices="`) {
		t.Errorf("audit line missing %q with devices:\n%s", want, buf.String())
	}
}

// Every other session: their devices go too, counted.
func TestRevokeOtherSessionsRevokesTheirDevices(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	owner := signIn(t, h, "Owner")
	other := signIn(t, h, "Other")
	d := redeemCode(t, h, sessionPairCode(t, h, other, `{"role":"view"}`))
	mine := redeemCode(t, h, sessionPairCode(t, h, owner, `{"role":"view"}`))
	rec := serve(h, asDevice("DELETE", "/api/mux/signins", "", owner))
	if body := decodeBody(t, rec); rec.Code != http.StatusOK || body["revoked"] != float64(1) || body["devices"] != float64(1) {
		t.Fatalf("revoke others: %d %v", rec.Code, body)
	}
	if code := signedInCode(h, d); code != http.StatusUnauthorized {
		t.Errorf("other session's device: %d", code)
	}
	if code := signedInCode(h, mine); code != http.StatusOK {
		t.Errorf("caller's own device: %d", code)
	}
}

// Signing out drops the session's waiting codes, never its devices.
func TestLogoutKeepsSessionDevices(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	c := signIn(t, h, "Laptop")
	phone := redeemCode(t, h, sessionPairCode(t, h, c, `{"role":"view"}`))
	waiting := sessionPairCode(t, h, c, `{"role":"view"}`)
	if rec := serve(h, asDevice("POST", logoutPath, "{}", c)); rec.Code != http.StatusNoContent {
		t.Fatalf("logout: %d", rec.Code)
	}
	if code := signedInCode(h, phone); code != http.StatusOK {
		t.Errorf("device after its session signed out: %d", code)
	}
	if rec := postPair(h, url.Values{"code": {waiting}}, nil); deviceCookieOf(rec) != nil {
		t.Error("a signed out session's waiting code paired a device")
	}
}

// The session is signed out even when its devices cannot be removed from
// the disk, and the caller is told.
func TestRevokeSessionDevicesWriteFailure(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("needs a dir the user cannot write")
	}
	h, _, _, dir := newDeviceServer(t)
	owner := signIn(t, h, "Owner")
	leaked := signIn(t, h, "Leaked")
	id := sessionIDOf(t, h, leaked)
	redeemCode(t, h, sessionPairCode(t, h, leaked, `{"role":"view"}`))
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	captureLog(t)
	rec := serve(h, asDevice("DELETE", "/api/mux/signins/"+id, "", owner))
	if body := decodeBody(t, rec); rec.Code != http.StatusInternalServerError || body["code"] != "devices_not_revoked" {
		t.Errorf("revoke with a read-only store: %d %v", rec.Code, body)
	}
	if code := signedInCode(h, leaked); code != http.StatusUnauthorized {
		t.Errorf("session after a failed device revoke: %d", code)
	}
	if strings.Contains(rec.Body.String(), filepath.Base(dir)) {
		t.Error("the error names a path")
	}
}

// A code its session's revoke missed (used at that very moment) pairs a
// device that is revoked at once.
func TestPairRevokedWhenSessionGone(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "devices")
	store, err := newDeviceStore(dir, "admin", "secret")
	if err != nil {
		t.Fatal(err)
	}
	dev := newDeviceAuth(store, newStreamTokenStore(), newStreamHub(4))
	sessions := newSessionAuth(nil, nil)
	h := newBasicAuth("admin", "secret", dev, sessions, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	// Made while the session lived; its revoke then missed the code (it was
	// being used), and only the store, wired as buildServer does, sees it.
	code, _, err := dev.codes.create(roleView, "", sessionCreator("0123456789abcdef"), 0)
	if err != nil {
		t.Fatal(err)
	}
	store.sessionAlive = sessions.alive
	captureLog(t)
	rec := postPair(h, url.Values{"code": {code}}, nil)
	if rec.Code != http.StatusConflict {
		t.Errorf("pair from a gone session: %d", rec.Code)
	}
	if n := len(store.list()); n != 0 {
		t.Errorf("devices left: %d", n)
	}
}

// openDeviceStream opens a terminal stream signed in by device cookie c.
func openDeviceStream(t *testing.T, srv *httptest.Server, c *http.Cookie, m *viewMux) *websocket.Conn {
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
	m.waitAttached(t)
	return ws
}

// A session gone already (Log out here; a restart or a failed revoke alike)
// still has the devices it paired revoked by its id; an id with none is
// unknown.
func TestRevokeGoneSessionRevokesItsDevices(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	owner := signIn(t, h, "Owner")
	laptop := signIn(t, h, "Laptop")
	id := sessionIDOf(t, h, laptop)
	phone := redeemCode(t, h, sessionPairCode(t, h, laptop, `{"role":"view"}`))
	if rec := serve(h, asDevice("POST", logoutPath, "{}", laptop)); rec.Code != http.StatusNoContent {
		t.Fatalf("logout: %d", rec.Code)
	}
	captureLog(t)
	rec := serve(h, asDevice("DELETE", "/api/mux/signins/"+id, "", owner))
	if body := decodeBody(t, rec); rec.Code != http.StatusOK || body["signedOut"] != false || body["devices"] != float64(1) {
		t.Fatalf("revoke a gone session: %d %v", rec.Code, body)
	}
	if code := signedInCode(h, phone); code != http.StatusUnauthorized {
		t.Errorf("device of a gone session after its revoke: %d", code)
	}
	rec = serve(h, asDevice("DELETE", "/api/mux/signins/"+id, "", owner))
	if body := decodeBody(t, rec); rec.Code != http.StatusNotFound || body["code"] != "unknown_session" {
		t.Errorf("again: %d %v", rec.Code, body)
	}
}

// The CLI says the browser is signed out when only its devices could not be
// revoked, and fails naming what to do.
func TestSigninsCLIDevicesKept(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("needs a dir the user cannot write")
	}
	h, _, _, dir := newDeviceServer(t)
	port := listen(t, h)
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	b := signIn(t, h, "Safari")
	redeemCode(t, h, sessionPairCode(t, h, b, `{"role":"view"}`))
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	captureLog(t)
	code, out, errOut := runDevCLI(tc, "signins", "revoke", sessionIDOf(t, h, b))
	if code == 0 || !strings.Contains(out+errOut, "Signed out browser") || !strings.Contains(errOut, "termote devices revoke") ||
		strings.Contains(out+errOut, "refused") || !strings.Contains(out+errOut, "termote start --fresh") {
		t.Errorf("revoke with a read-only store: %d\n%s%s", code, out, errOut)
	}
}
