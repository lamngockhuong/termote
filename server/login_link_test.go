package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// newLink asks for a sign-in link token as the CLI does (Basic auth).
func newLink(t *testing.T, h http.Handler) string {
	t.Helper()
	rec := serve(h, apiRequest("POST", loginLinksRoute, "{}"))
	if rec.Code != http.StatusOK {
		t.Fatalf("login-links: %d %s", rec.Code, rec.Body)
	}
	var body struct {
		Token     string
		ExpiresIn int
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Token == "" || body.ExpiresIn != 30 {
		t.Fatalf("login-links answer: %s", rec.Body)
	}
	return body.Token
}

// postLink posts the CLI's file form as a file:// page does: Origin null,
// cross-site.
func postLink(h http.Handler, form url.Values, mutate func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", loginLinkPath, strings.NewReader(form.Encode()))
	req.Host = "localhost:7680"
	req.RemoteAddr = "127.0.0.1:5555"
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "null")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if mutate != nil {
		mutate(req)
	}
	return serve(h, req)
}

func TestLoginLinkSignsIn(t *testing.T) {
	buf := captureLog(t)
	h, _ := newSigninServer(t, true)
	token := newLink(t, h)
	rec := postLink(h, url.Values{"t": {token}, "hash": {"#/s/main/0?view=chat"}}, nil)
	c := sessionCookieOf(rec)
	if rec.Code != http.StatusOK || c == nil {
		t.Fatalf("redeem: %d %s", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `content="0;url=/#/s/main/0?view=chat"`) || !strings.Contains(body, `href="/#/s/main/0?view=chat"`) {
		t.Errorf("no refresh to the deep link:\n%s", body)
	}
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Location") != "" {
		t.Errorf("headers: %v", rec.Header())
	}
	if code := signedInCode(h, c); code != http.StatusOK {
		t.Errorf("session from the link: %d", code)
	}
	list := listSignins(t, h, apiRequest("GET", "/api/mux/signins", ""))
	if len(list) != 1 || list[0].Via != sessionViaLink {
		t.Errorf("sign-ins: %+v", list)
	}
	if !strings.Contains(buf.String(), `audit: login via="link" user="admin"`) {
		t.Errorf("audit line missing:\n%s", buf.String())
	}
	if strings.Contains(buf.String(), token) {
		t.Error("the token was logged")
	}
	// Single use.
	rec = postLink(h, url.Values{"t": {token}}, nil)
	if rec.Code != http.StatusUnauthorized || sessionCookieOf(rec) != nil || !strings.Contains(rec.Body.String(), "sign-in link has expired") {
		t.Errorf("second use: %d %s", rec.Code, rec.Body)
	}
}

// A deep link the app would not make is dropped, not refused.
func TestLoginLinkDropsOddHash(t *testing.T) {
	h, _ := newSigninServer(t, false)
	for _, hash := range []string{`#"><script>`, "#a b", "javascript:x", "#", "#" + strings.Repeat("a", maxLinkHash)} {
		rec := postLink(h, url.Values{"t": {newLink(t, h)}, "hash": {hash}}, nil)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `content="0;url=/"`) {
			t.Errorf("hash %q: %d %s", hash, rec.Code, rec.Body)
		}
	}
}

// A wrong token is refused and spends nothing.
func TestLoginLinkWrongToken(t *testing.T) {
	h, _ := newSigninServer(t, false)
	token := newLink(t, h)
	rec := postLink(h, url.Values{"t": {"0123456789abcdef0123456789abcdef"}}, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unknown token: %d", rec.Code)
	}
	if rec := postLink(h, url.Values{"t": {token}}, nil); rec.Code != http.StatusOK {
		t.Errorf("a wrong token spent the right one: %d", rec.Code)
	}
}

func TestLoginLinkStoreExpiryAndCap(t *testing.T) {
	s := newLoginLinkStore()
	s.ttl = time.Millisecond
	old, _ := s.generate()
	time.Sleep(5 * time.Millisecond)
	if _, ok := s.consume(old); ok {
		t.Error("an expired token was taken")
	}
	s = newLoginLinkStore()
	var tokens []string
	for range maxLoginLinks + 1 {
		tok, err := s.generate()
		if err != nil {
			t.Fatal(err)
		}
		tokens = append(tokens, tok)
	}
	if _, ok := s.consume(tokens[0]); ok {
		t.Error("the oldest token stayed past the cap")
	}
	for _, tok := range tokens[1:] {
		if _, ok := s.consume(tok); !ok {
			t.Error("a newer token was pushed out")
		}
	}
}

// Wrong links are not counted against the password: the sign-in form still
// works from the same address afterwards.
func TestLoginLinkNotCountedByLimiter(t *testing.T) {
	h, _ := newSigninServer(t, false)
	for range authMaxFailures + 3 {
		postLink(h, url.Values{"t": {"nope"}}, nil)
	}
	rec := postLogin(h, url.Values{"username": {"admin"}, "password": {"secret"}}, func(r *http.Request) {
		r.Host = "localhost:7680"
		r.RemoteAddr = "127.0.0.1:5555"
	})
	if rec.Code != http.StatusSeeOther {
		t.Errorf("password sign-in after wrong links: %d", rec.Code)
	}
}

func TestLoginLinkCrossSite(t *testing.T) {
	h, _ := newSigninServer(t, true)
	// Another site's page: refused by its Origin, and with no Origin by
	// Sec-Fetch-Site.
	rec := postLink(h, url.Values{"t": {newLink(t, h)}}, func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") })
	if rec.Code != http.StatusForbidden {
		t.Errorf("foreign Origin: %d", rec.Code)
	}
	rec = postLink(h, url.Values{"t": {newLink(t, h)}}, func(r *http.Request) { r.Header.Del("Origin") })
	if rec.Code != http.StatusForbidden {
		t.Errorf("cross-site without Origin: %d", rec.Code)
	}
	// Same-origin (the Continue button of a page the server served) works.
	rec = postLink(h, url.Values{"t": {newLink(t, h)}}, func(r *http.Request) {
		r.Header.Set("Origin", "http://localhost:7680")
		r.Header.Set("Sec-Fetch-Site", "same-origin")
	})
	if rec.Code != http.StatusOK {
		t.Errorf("same-origin: %d", rec.Code)
	}
	// /login and /pair still refuse an Origin null cross-site POST.
	for _, p := range []string{loginPath, pairPath} {
		req := httptest.NewRequest("POST", p, strings.NewReader("username=admin&password=secret&code=x"))
		req.Host = "localhost:7680"
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", "null")
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		if rec := serve(h, req); rec.Code != http.StatusForbidden {
			t.Errorf("%s cross-site with Origin null: %d", p, rec.Code)
		}
	}
	// Not a form.
	rec = postLink(h, url.Values{"t": {"x"}}, func(r *http.Request) { r.Header.Set("Content-Type", "application/json") })
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("JSON body: %d", rec.Code)
	}
}

func TestLoginLinkMethods(t *testing.T) {
	h, _ := newSigninServer(t, false)
	req := httptest.NewRequest("GET", loginLinkPath, nil)
	req.Host = "localhost:7680"
	if rec := serve(h, req); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "sign-in link has expired") {
		t.Errorf("GET: %d %s", rec.Code, rec.Body)
	}
	req = httptest.NewRequest("PUT", loginLinkPath, nil)
	req.Host = "localhost:7680"
	if rec := serve(h, req); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("PUT: %d", rec.Code)
	}
	if got := safeNext(loginLinkPath); got != "/" {
		t.Errorf("safeNext(%s) = %q", loginLinkPath, got)
	}
}

// Only the CLI gets a token: a session or a paired device, even full, never.
func TestLoginLinksOnlyForCLI(t *testing.T) {
	h, _ := newSigninServer(t, true)
	session := signIn(t, h, "Browser")
	for name, c := range map[string]*http.Cookie{"session": session, "full device": pairDevice(t, h, "full")} {
		rec := serve(h, asDevice("POST", loginLinksRoute, "{}", c))
		if body := decodeBody(t, rec); rec.Code != http.StatusForbidden || body["code"] != "full_needs_password" {
			t.Errorf("%s: %d %v", name, rec.Code, body)
		}
	}
	// The local socket is the CLI too.
	if rec := serve(h, onLocalSocket(apiRequest("POST", loginLinksRoute, "{}"))); rec.Code != http.StatusOK {
		t.Errorf("local socket: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("GET", loginLinksRoute, "")); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET login-links: %d", rec.Code)
	}
}

func TestLoginLinksWithoutAuth(t *testing.T) {
	h, err := newServeHandler(serveConfig{NoAuth: true, PWADir: t.TempDir()}, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	if rec := serve(h, apiRequest("POST", loginLinksRoute, "{}")); rec.Code != http.StatusNotImplemented {
		t.Errorf("--no-auth: %d", rec.Code)
	}
}
