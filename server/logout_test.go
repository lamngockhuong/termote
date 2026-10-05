package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
)

// logoutRequest is the PWA's logout: a same-origin JSON POST, carrying
// cookie when given.
func logoutRequest(cookie *http.Cookie) *http.Request {
	req := apiRequest("POST", logoutPath, "{}")
	req.Header.Del("Authorization")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	return req
}

// A signed-in browser logs out: the session ends on the server, not only
// in the browser, and its cookie is expired.
func TestLogoutEndsTheSession(t *testing.T) {
	h := newTestHandler(t, &fakeMux{})
	cookie := sessionCookieOf(postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, func(r *http.Request) {
		r.Host = "localhost:7680"
	}))
	if cookie == nil {
		t.Fatal("no session after sign-in")
	}
	snapshot := func() int {
		req := apiRequest("GET", "/api/mux/snapshot", "")
		req.Header.Del("Authorization")
		req.AddCookie(cookie)
		return serve(h, req).Code
	}
	if code := snapshot(); code != http.StatusOK {
		t.Fatalf("signed in: snapshot = %d", code)
	}
	rec := serve(h, logoutRequest(cookie))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout = %d %s", rec.Code, rec.Body.String())
	}
	if c := sessionCookieOf(rec); c == nil || c.MaxAge >= 0 || c.Value != "" || !c.HttpOnly {
		t.Errorf("cookie not expired: %+v", c)
	}
	if code := snapshot(); code != http.StatusUnauthorized {
		t.Errorf("after logout: snapshot = %d, want 401", code)
	}
}

// Without a session there is nothing to end, and nothing counts as a failed
// login: the cookie is expired all the same.
func TestLogoutWithoutSession(t *testing.T) {
	h := newTestHandler(t, &fakeMux{})
	for range authMaxFailures + 1 {
		rec := serve(h, logoutRequest(&http.Cookie{Name: sessionCookieName, Value: "stale"}))
		if rec.Code != http.StatusNoContent || sessionCookieOf(rec) == nil {
			t.Fatalf("stale cookie = %d %v", rec.Code, rec.Result().Cookies())
		}
	}
	if rec := serve(h, logoutRequest(nil)); rec.Code != http.StatusNoContent {
		t.Errorf("no cookie = %d", rec.Code)
	}
	// Not rate limited by the logouts above.
	if rec := serve(h, apiRequest("GET", "/api/mux/snapshot", "")); rec.Code != http.StatusOK {
		t.Errorf("sign-in after logouts = %d", rec.Code)
	}
}

// Logout is a write: another site cannot end the session, and GET does not.
func TestLogoutRefusals(t *testing.T) {
	h := newTestHandler(t, &fakeMux{})
	req := logoutRequest(nil)
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
	req = logoutRequest(nil)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if rec := serve(h, req); rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("form post = %d", rec.Code)
	}
	if rec := serve(h, apiRequest("GET", logoutPath, "")); rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "POST" {
		t.Errorf("GET = %d %v", rec.Code, rec.Header())
	}
}

// The snapshot tells the PWA whether sign-in is on, so it offers Log out
// only then.
func TestSnapshotCapsAuth(t *testing.T) {
	read := func(h http.Handler) bool {
		rec := serve(h, apiRequest("GET", "/api/mux/snapshot", ""))
		var snap Snapshot
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &snap) != nil {
			t.Fatalf("snapshot = %d %s", rec.Code, rec.Body.String())
		}
		return snap.Caps.Auth
	}
	if !read(newTestHandler(t, &fakeMux{})) {
		t.Error("auth on: caps.auth = false")
	}
	cfg := testConfig(t)
	cfg.NoAuth = true
	h, err := newServeHandler(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	if read(h) {
		t.Error("--no-auth: caps.auth = true")
	}
	// No logout route without sign-in.
	if rec := serve(h, logoutRequest(nil)); rec.Code != http.StatusNotFound {
		t.Errorf("--no-auth logout = %d", rec.Code)
	}
}
