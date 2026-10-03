package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseAllowedHosts(t *testing.T) {
	a := parseAllowedHosts(" MyBox.local , 192.168.1.5:7680, [fe80::1], ,host.ts.net., https://web.box.lan:8443", false)
	for _, h := range []string{
		"localhost", "localhost:7680", "127.0.0.1:7680", "[::1]:7680", "[::1]",
		"mybox.local", "MYBOX.LOCAL:7680", "192.168.1.5", "[fe80::1]:7680", "host.ts.net", "web.box.lan",
	} {
		if !a.allows(noAddr, h) {
			t.Errorf("allows(%q) = false, want true", h)
		}
	}
	for _, h := range []string{"evil.com", "evil.com:7680", "192.168.1.6", "", "*", "https"} {
		if a.allows(noAddr, h) {
			t.Errorf("allows(%q) = true, want false", h)
		}
	}
}

func TestParseAllowedHostsEmptyIsLoopbackOnly(t *testing.T) {
	a := parseAllowedHosts("", false)
	if len(a.names) != len(loopbackHosts) {
		t.Errorf("empty env allowlist = %v, want loopback only", a)
	}
	if a.allows(noAddr, "192.168.1.5") {
		t.Error("LAN IP must not be allowed without TERMOTE_ALLOWED_HOSTS")
	}
}

// A wildcard would switch the check off; it must be treated as a literal name.
func TestParseAllowedHostsNoWildcard(t *testing.T) {
	if parseAllowedHosts("*", true).allows(requestOn("192.168.1.5"), "evil.com") {
		t.Error("'*' must not allow arbitrary hosts")
	}
}

// noAddr is a request without a local address (not from a listener).
var noAddr = httptest.NewRequest("GET", "/", nil)

// requestOn is a request that arrived on local address ip.
func requestOn(ip string) *http.Request {
	r := httptest.NewRequest("GET", "/", nil)
	ctx := context.WithValue(r.Context(), http.LocalAddrContextKey, &net.TCPAddr{IP: net.ParseIP(ip), Port: 7680})
	return r.WithContext(ctx)
}

// With LAN access the address a request arrived on is its own allowed
// Host, whatever the machine's addresses were at boot; another host name
// (DNS rebinding) or another IP still fails.
func TestAllowlistAcceptsLocalAddress(t *testing.T) {
	lan := parseAllowedHosts("", true)
	r := requestOn("192.168.1.20")
	for h, want := range map[string]bool{"192.168.1.20": true, "192.168.1.20:7680": true, "192.168.1.21": false, "evil.com": false, "localhost": true} {
		if got := lan.allows(r, h); got != want {
			t.Errorf("LAN allows(%q) = %v, want %v", h, got, want)
		}
	}
	if parseAllowedHosts("", false).allows(r, "192.168.1.20") {
		t.Error("local address allowed without LAN")
	}
	if !lan.allows(requestOn("::ffff:192.168.1.20"), "192.168.1.20") {
		t.Error("IPv4-mapped local address not matched")
	}
}

func TestHostGuardThroughServer(t *testing.T) {
	h := newTestHandler(t, &fakeMux{})

	req := apiRequest("GET", "/api/mux/health", "")
	req.Host = "evil.com:7680"
	rec := serve(h, req)
	if rec.Code != http.StatusForbidden || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("foreign Host on /api = %d %q, want JSON 403", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "--allow-host evil.com") {
		t.Errorf("rejection must name the fix, got %q", rec.Body.String())
	}

	// Host check applies to static files too, before auth.
	req = httptest.NewRequest("GET", "/", nil)
	req.Host = "attacker.example"
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("foreign Host on / status = %d, want 403", rec.Code)
	}
}

func TestHostGuardAllowsConfiguredHost(t *testing.T) {
	cfg := testConfig(t)
	cfg.AllowedHosts = "mybox.local"
	h, err := newServeHandler(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	req := apiRequest("GET", "/api/mux/health", "")
	req.Host = "mybox.local:7680"
	if rec := serve(h, req); rec.Code != http.StatusOK {
		t.Errorf("configured host status = %d, want 200", rec.Code)
	}
}

func TestWriteGuard(t *testing.T) {
	tests := []struct {
		name     string
		mutate   func(r *http.Request)
		wantCode int
	}{
		{"same-origin json", func(r *http.Request) {}, http.StatusOK},
		{"json with charset", func(r *http.Request) { r.Header.Set("Content-Type", "application/json; charset=utf-8") }, http.StatusOK},
		{"no browser headers (curl)", func(r *http.Request) { r.Header.Del("Origin"); r.Header.Del("Sec-Fetch-Site") }, http.StatusOK},
		{"text/plain", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, http.StatusUnsupportedMediaType},
		{"form", func(r *http.Request) { r.Header.Set("Content-Type", "application/x-www-form-urlencoded") }, http.StatusUnsupportedMediaType},
		// Only the upload route takes an image body.
		{"image on another route", func(r *http.Request) { r.Header.Set("Content-Type", "image/png") }, http.StatusUnsupportedMediaType},
		{"missing content type", func(r *http.Request) { r.Header.Del("Content-Type") }, http.StatusUnsupportedMediaType},
		{"cross-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, http.StatusForbidden},
		{"same-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-site") }, http.StatusForbidden},
		{"foreign origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.com") }, http.StatusForbidden},
		{"null origin", func(r *http.Request) { r.Header.Set("Origin", "null") }, http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeMux{}
			req := apiRequest("POST", "/api/mux/tabs/1/select", "")
			tt.mutate(req)
			rec := serve(newTestHandler(t, f), req)
			if rec.Code != tt.wantCode {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.wantCode, rec.Body.String())
			}
			if tt.wantCode != http.StatusOK && len(f.calls) != 0 {
				t.Errorf("backend was called on rejected request: %v", f.calls)
			}
		})
	}
}

// Reads stay usable without Content-Type or Origin headers.
func TestWriteGuardIgnoresReadsAndNonAPI(t *testing.T) {
	h := writeGuard(parseAllowedHosts("", false), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, req := range []*http.Request{
		httptest.NewRequest("GET", "/api/mux/snapshot", nil),
		httptest.NewRequest("POST", "/terminal/token", nil),
	} {
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		if rec := serve(h, req); rec.Code != http.StatusNoContent {
			t.Errorf("%s %s status = %d, want passthrough", req.Method, req.URL.Path, rec.Code)
		}
	}
}

func TestValidateConfig(t *testing.T) {
	if err := validateConfig(serveConfig{Pass: ""}); err == nil {
		t.Error("empty password without NoAuth must be rejected")
	}
	if err := validateConfig(serveConfig{Pass: "", NoAuth: true}); err != nil {
		t.Errorf("explicit NoAuth: %v", err)
	}
	if err := validateConfig(serveConfig{Pass: "x"}); err != nil {
		t.Errorf("with password: %v", err)
	}
	// Basic auth cuts at the first ":", so such a user could never log in.
	if err := validateConfig(serveConfig{User: "a:b", Pass: "x"}); err == nil || !strings.Contains(err.Error(), "TERMOTE_USER") {
		t.Errorf("user with ':' = %v, want refusal naming TERMOTE_USER", err)
	}
	if err := validateConfig(serveConfig{User: "a:b", NoAuth: true}); err != nil {
		t.Errorf("user unused without auth: %v", err)
	}
	// herdr exposes every workspace: NoAuth alone is not enough.
	if err := validateConfig(serveConfig{NoAuth: true, MuxBackend: "herdr"}); err == nil || !strings.Contains(err.Error(), "TERMOTE_HERDR_ALLOW_NO_AUTH") {
		t.Errorf("herdr + NoAuth = %v, want refusal naming the opt-out", err)
	}
	if err := validateConfig(serveConfig{NoAuth: true, MuxBackend: "herdr", HerdrAllowNoAuth: true}); err != nil {
		t.Errorf("herdr + NoAuth + opt-out: %v", err)
	}
	if err := validateConfig(serveConfig{Pass: "x", MuxBackend: "herdr"}); err != nil {
		t.Errorf("herdr with password: %v", err)
	}

	cfg := testConfig(t)
	cfg.Pass = ""
	if _, err := newServeHandler(cfg, &fakeMux{}); err == nil {
		t.Error("newServeHandler must refuse an empty password")
	}
}

func TestNoAuthServesWithoutCredentials(t *testing.T) {
	cfg := testConfig(t)
	cfg.Pass, cfg.NoAuth = "", true
	h, err := newServeHandler(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/api/mux/health", nil)
	req.Host = "localhost"
	if rec := serve(h, req); rec.Code != http.StatusOK {
		t.Errorf("no-auth status = %d, want 200", rec.Code)
	}
}

func TestAuthRequiredWithPassword(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/mux/health", nil)
	req.Host = "localhost"
	if rec := serve(newTestHandler(t, &fakeMux{}), req); rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestRequestIsHTTPS(t *testing.T) {
	tests := []struct {
		name   string
		remote string
		xfp    string
		tls    bool
		want   bool
	}{
		{"plain", "192.168.1.9:5000", "", false, false},
		{"tls", "192.168.1.9:5000", "", true, true},
		{"xfp from loopback proxy", "127.0.0.1:5000", "https", false, true},
		{"xfp from ipv6 loopback", "[::1]:5000", "https", false, true},
		{"xfp from bridge gateway", "172.17.0.1:5000", "https", false, true},
		{"xfp from remote client", "192.168.1.9:5000", "https", false, true},
		{"xfp http from loopback", "127.0.0.1:5000", "http", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			req.RemoteAddr = tt.remote
			if tt.xfp != "" {
				req.Header.Set("X-Forwarded-Proto", tt.xfp)
			}
			if tt.tls {
				req.TLS = &tls.ConnectionState{}
			}
			if got := requestIsHTTPS(req); got != tt.want {
				t.Errorf("requestIsHTTPS = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRateLimitedLog(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	l := &rateLimitedLog{every: time.Hour}
	for i := 0; i < 5; i++ {
		l.printf("rejected %d", i)
	}
	if got := strings.Count(buf.String(), "rejected"); got != 1 {
		t.Fatalf("logged %d lines within the interval, want 1:\n%s", got, buf.String())
	}
	l.last = time.Now().Add(-2 * time.Hour)
	l.printf("rejected again")
	if !strings.Contains(buf.String(), "(4 similar lines suppressed)") {
		t.Fatalf("missing suppressed count:\n%s", buf.String())
	}
}
