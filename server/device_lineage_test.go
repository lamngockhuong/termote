package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// deviceIDOf returns the id of the listed device named name.
func deviceIDOf(t *testing.T, h http.Handler, name string) string {
	t.Helper()
	for _, d := range decodeBody(t, serve(h, apiRequest("GET", "/api/mux/devices", "")))["devices"].([]any) {
		if d := d.(map[string]any); d["name"] == name {
			return d["id"].(string)
		}
	}
	t.Fatalf("no device named %s", name)
	return ""
}

// pairWith redeems a code made by req, as a new browser.
func pairWith(t *testing.T, h http.Handler, req *http.Request) *http.Cookie {
	t.Helper()
	rec := serve(h, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("devices/pair: %d %s", rec.Code, rec.Body)
	}
	code := decodeBody(t, rec)["code"].(string)
	page := postPair(h, url.Values{"code": {code}}, nil)
	c := deviceCookieOf(page)
	if c == nil {
		t.Fatalf("pair: %d %s", page.Code, page.Body)
	}
	return c
}

// Who may make a code for which role: only the password (Basic, a session)
// pairs a full device; a paired device, even sending Basic auth as well,
// pairs view devices only, and a view device pairs nothing. Each signer gets
// a server of its own: at most five codes wait.
func TestPairRoleMatrix(t *testing.T) {
	signers := map[string]func(h http.Handler, body string) *http.Request{
		"basic": func(_ http.Handler, b string) *http.Request { return apiRequest("POST", "/api/mux/devices/pair", b) },
		"session": func(h http.Handler, b string) *http.Request {
			session := sessionCookieOf(postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, func(r *http.Request) { r.Host = "localhost:7680" }))
			req := apiRequest("POST", "/api/mux/devices/pair", b)
			req.Header.Del("Authorization")
			req.AddCookie(session)
			return req
		},
		"full device": func(h http.Handler, b string) *http.Request {
			return asDevice("POST", "/api/mux/devices/pair", b, pairDevice(t, h, "full"))
		},
		"view device": func(h http.Handler, b string) *http.Request {
			return asDevice("POST", "/api/mux/devices/pair", b, pairDevice(t, h, "view"))
		},
		"full device + basic": func(h http.Handler, b string) *http.Request {
			req := apiRequest("POST", "/api/mux/devices/pair", b)
			req.AddCookie(pairDevice(t, h, "full"))
			return req
		},
	}
	want := map[string]map[string]string{
		"basic":               {"full": "", "view": ""},
		"session":             {"full": "", "view": ""},
		"full device":         {"full": "full_needs_password", "view": ""},
		"view device":         {"full": "view_only", "view": "view_only"},
		"full device + basic": {"full": "full_needs_password", "view": ""},
	}
	for who, mk := range signers {
		for _, r := range []string{"full", "view"} {
			h, _, _, _ := newDeviceServer(t)
			rec := serve(h, mk(h, `{"role":"`+r+`"}`))
			var body struct{ Code string }
			json.Unmarshal(rec.Body.Bytes(), &body)
			if exp := want[who][r]; (exp == "" && rec.Code != http.StatusOK) || (exp != "" && body.Code != exp) {
				t.Errorf("%s pairing %s: %d %s, want %q", who, r, rec.Code, rec.Body, exp)
			}
		}
	}
}

// validFor: checked, cut to the maker's own limit, answered; the list shows
// validUntil, expired, pairedBy and pairedByName.
func TestPairValidForAndList(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	for _, body := range []string{`{"role":"view","validFor":3599}`, `{"role":"view","validFor":34560001}`, `{"role":"view","validFor":-5}`, `{"role":"view","validFor":1.5}`} {
		rec := serve(h, apiRequest("POST", "/api/mux/devices/pair", body))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body)
		}
	}
	if res := makePairCode(t, h, `{"role":"view"}`); res["validFor"] != float64(0) {
		t.Errorf("no validFor answered %v", res["validFor"])
	}
	// A full device valid for 2 hours, from the password.
	laptop := pairWith(t, h, apiRequest("POST", "/api/mux/devices/pair", `{"role":"full","name":"Laptop","validFor":7200}`))
	rec := serve(h, asDevice("POST", "/api/mux/devices/pair", `{"role":"view"}`, laptop))
	if body := decodeBody(t, rec); rec.Code != http.StatusBadRequest || body["code"] != "invalid_validity" {
		t.Errorf("a device with a limit gave none: %d %v", rec.Code, body)
	}
	rec = serve(h, asDevice("POST", "/api/mux/devices/pair", `{"role":"view","name":"Phone","validFor":86400}`, laptop))
	res := decodeBody(t, rec)
	if v, _ := res["validFor"].(float64); v < 7190 || v > 7200 {
		t.Errorf("validFor not cut to the maker's: %v", res["validFor"])
	}
	postPair(h, url.Values{"code": {res["code"].(string)}}, nil)

	byName := map[string]map[string]any{}
	for _, d := range decodeBody(t, serve(h, asDevice("GET", "/api/mux/devices", "", laptop)))["devices"].([]any) {
		byName[d.(map[string]any)["name"].(string)] = d.(map[string]any)
	}
	lap, phone := byName["Laptop"], byName["Phone"]
	if lap["pairedBy"] != "password" || lap["validUntil"] == nil || lap["expired"] != false || lap["current"] != true {
		t.Errorf("Laptop: %v", lap)
	}
	if phone["pairedBy"] != lap["id"] || phone["pairedByName"] != "Laptop" {
		t.Errorf("Phone: %v", phone)
	}
	lu, _ := time.Parse(time.RFC3339, lap["validUntil"].(string))
	pu, _ := time.Parse(time.RFC3339, phone["validUntil"].(string))
	if pu.After(lu) {
		t.Errorf("Phone (%v) outlasts Laptop (%v)", pu, lu)
	}
}

// A revoke from Devices or the CLI takes the devices the revoked one paired;
// Log out takes only the device itself.
func TestRevokeCascadeRoutes(t *testing.T) {
	logs := captureLog(t)
	h, _, _, _ := newDeviceServer(t)
	a := pairWith(t, h, apiRequest("POST", "/api/mux/devices/pair", `{"role":"full","name":"A"}`))
	child := pairWith(t, h, asDevice("POST", "/api/mux/devices/pair", `{"role":"view","name":"A child"}`, a))
	b := pairWith(t, h, apiRequest("POST", "/api/mux/devices/pair", `{"role":"full","name":"B"}`))
	bChild := pairWith(t, h, asDevice("POST", "/api/mux/devices/pair", `{"role":"view","name":"B child"}`, b))
	aID, childID := deviceIDOf(t, h, "A"), deviceIDOf(t, h, "A child")

	rec := serve(h, apiRequest("DELETE", "/api/mux/devices/"+aID, ""))
	res := decodeBody(t, rec)
	if rev, _ := res["revoked"].([]any); len(rev) != 2 || rev[0] != aID || rev[1] != childID {
		t.Fatalf("revoked = %v", res)
	}
	if code, _ := snapshotRole(t, h, child); code != http.StatusUnauthorized {
		t.Errorf("A's child after the cascade: %d", code)
	}
	if !strings.Contains(logs.String(), `audit: revoke id="`+aID+`" by="password" via="cli" cascade="`+childID+`"`) {
		t.Errorf("cascade audit missing:\n%s", logs)
	}

	if rec := serve(h, asDevice("POST", logoutPath, "{}", b)); rec.Code != http.StatusNoContent {
		t.Fatalf("logout B: %d", rec.Code)
	}
	if code, _ := snapshotRole(t, h, bChild); code != http.StatusOK {
		t.Errorf("B's child after B logged out: %d", code)
	}
	if !strings.Contains(logs.String(), `via="logout" cascade=""`) {
		t.Errorf("logout audit missing:\n%s", logs)
	}
	var orphan map[string]any
	for _, d := range decodeBody(t, serve(h, apiRequest("GET", "/api/mux/devices", "")))["devices"].([]any) {
		orphan = d.(map[string]any)
	}
	if _, named := orphan["pairedByName"]; orphan["name"] != "B child" || orphan["pairedBy"] == "password" || named {
		t.Errorf("a device whose maker logged out: %v", orphan)
	}
}

// A code whose maker was revoked before it was used pairs nothing, says so
// and is not counted as a wrong code.
func TestPairCodeOfRevokedMaker(t *testing.T) {
	h, _, _, dir := newDeviceServer(t)
	a := pairWith(t, h, apiRequest("POST", "/api/mux/devices/pair", `{"role":"full","name":"A"}`))
	res := decodeBody(t, serve(h, asDevice("POST", "/api/mux/devices/pair", `{"role":"view"}`, a)))
	code := res["code"].(string)
	// Revoked behind this process's back (a second process): the code
	// still waits here, the store refuses it.
	s := newTestDeviceStore(t, dir, "secret")
	if err := s.revoke(deviceIDOf(t, h, "A")); err != nil {
		t.Fatal(err)
	}
	page := postPair(h, url.Values{"code": {code}}, nil)
	if page.Code != http.StatusConflict || !strings.Contains(page.Body.String(), "no longer valid") || deviceCookieOf(page) != nil {
		t.Errorf("code of a revoked maker: %d %s", page.Code, page.Body)
	}
}

// Every event leaves one audit line; Basic auth sign-ins (the CLI, its
// health polls) leave none, and no code or token reaches the log.
func TestDeviceAuditLines(t *testing.T) {
	logs := captureLog(t)
	h, _, _, _ := newDeviceServer(t)
	for range 5 {
		serve(h, apiRequest("GET", "/api/mux/health", ""))
	}
	if strings.Contains(logs.String(), "audit:") {
		t.Fatalf("Basic auth logged:\n%s", logs)
	}
	res := makePairCode(t, h, `{"role":"view","name":"Ph\"one x=1","validFor":3600}`)
	page := postPair(h, url.Values{"code": {res["code"].(string)}}, nil)
	c := deviceCookieOf(page)
	login := postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, func(r *http.Request) { r.Host = "localhost:7680" })
	if login.Code != http.StatusSeeOther {
		t.Fatalf("login: %d", login.Code)
	}
	out := logs.String()
	for _, want := range []string{
		`audit: pair-code role="view" validFor="3600" by="password" ip="192.0.2.1"`,
		`audit: pair id="`,
		`name="Ph\"one x=1" role="view" validUntil="`,
		`pairedBy="password" ip="192.0.2.7"`,
		`audit: login via="form" user="admin" ip=`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %s:\n%s", want, out)
		}
	}
	for _, secret := range []string{res["code"].(string), strings.ReplaceAll(res["code"].(string), "-", ""), c.Value, "secret"} {
		if strings.Contains(out, secret) {
			t.Errorf("log holds a secret %q:\n%s", secret, out)
		}
	}
	if n := strings.Count(out, "audit:"); n != 3 {
		t.Errorf("%d audit lines, want 3:\n%s", n, out)
	}
}

// A device past its limit is refused and its cookie cleared, like a revoked
// one; the list marks it expired. Written by hand here: the server's clock
// is the real one.
func TestExpiredDeviceCookie(t *testing.T) {
	logs := captureLog(t)
	h, m, _, dir := newDeviceServer(t)
	c := pairWith(t, h, apiRequest("POST", "/api/mux/devices/pair", `{"role":"view","name":"Old","validFor":3600}`))
	path := filepath.Join(dir, devicesFile)
	var recs []map[string]any
	raw, _ := os.ReadFile(path)
	json.Unmarshal(raw, &recs)
	recs[0]["validUntil"] = time.Now().Add(-time.Minute).UTC()
	raw, _ = json.Marshal(recs)
	os.WriteFile(path, raw, 0o600)

	cfg := testConfig(t)
	cfg.DevicesDir = dir
	h2, hub2, _, _ := buildServer(cfg, m)
	defer hub2.shutdown(context.Background())
	rec := serve(h2, asDevice("GET", "/api/mux/snapshot", "", c))
	if cleared := deviceCookieOf(rec); rec.Code != http.StatusUnauthorized || cleared == nil || cleared.MaxAge >= 0 {
		t.Errorf("expired device: %d, cookie %v", rec.Code, cleared)
	}
	d := decodeBody(t, serve(h2, apiRequest("GET", "/api/mux/devices", "")))["devices"].([]any)[0].(map[string]any)
	if d["expired"] != true {
		t.Errorf("list: %v", d)
	}
	if !strings.Contains(logs.String(), `audit: device-expired id="`+d["id"].(string)+`"`) {
		t.Errorf("no device-expired line:\n%s", logs)
	}
}
