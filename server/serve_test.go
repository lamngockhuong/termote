package main

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

func TestEnvOr(t *testing.T) {
	tests := []struct {
		key      string
		setVal   string
		fallback string
		want     string
	}{
		{"TEST_ENVR_SET", "value", "fallback", "value"},
		{"TEST_ENVR_EMPTY", "", "fallback", "fallback"},
		{"TEST_ENVR_UNSET", "", "default", "default"},
	}

	for _, tt := range tests {
		if tt.setVal != "" {
			os.Setenv(tt.key, tt.setVal)
			defer os.Unsetenv(tt.key)
		}

		got := envOr(tt.key, tt.fallback)
		if got != tt.want {
			t.Errorf("envOr(%q, %q) = %q, want %q", tt.key, tt.fallback, got, tt.want)
		}
	}
}

func TestIsWebSocket(t *testing.T) {
	tests := []struct {
		upgrade string
		want    bool
	}{
		{"websocket", true},
		{"WebSocket", true},
		{"WEBSOCKET", true},
		{"", false},
		{"http", false},
	}

	for _, tt := range tests {
		req := httptest.NewRequest("GET", "/", nil)
		if tt.upgrade != "" {
			req.Header.Set("Upgrade", tt.upgrade)
		}

		got := isWebSocket(req)
		if got != tt.want {
			t.Errorf("isWebSocket(Upgrade: %q) = %v, want %v", tt.upgrade, got, tt.want)
		}
	}
}

func TestSpaHandler(t *testing.T) {
	files := fstest.MapFS{
		"index.html":   {Data: []byte("<html>index</html>")},
		"app.js":       {Data: []byte("console.log('app')")},
		"assets/x.css": {Data: []byte("body{}")},
	}
	handler := spaHandler(files)

	tests := []struct {
		path     string
		wantBody string
	}{
		{"/", "<html>index</html>"},
		{"/app.js", "console.log('app')"},
		{"/assets/x.css", "body{}"},
		{"/nonexistent", "<html>index</html>"},   // SPA fallback
		{"/any/deep/path", "<html>index</html>"}, // SPA fallback
		{"/../../etc/passwd", "<html>index</html>"},
		{"/any/dir/", "<html>index</html>"},
	}

	for _, tt := range tests {
		req := httptest.NewRequest("GET", tt.path, nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK || rec.Body.String() != tt.wantBody {
			t.Errorf("spaHandler(%s) = %d %q, want 200 %q", tt.path, rec.Code, rec.Body.String(), tt.wantBody)
		}
	}
}

func TestSpaHandlerAssetsAndManifest(t *testing.T) {
	handler := spaHandler(fstest.MapFS{
		"index.html":           {Data: []byte("<html>index</html>")},
		"assets/x.js":          {Data: []byte("js")},
		"manifest.webmanifest": {Data: []byte("{}")},
	})
	for path, want := range map[string]int{"/assets/missing.js": 404, "/assets/": 404, "/assets": 404, "/assets/x.js": 200} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Errorf("GET %s = %d, want %d", path, rec.Code, want)
		}
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/manifest.webmanifest", nil))
	if ct := rec.Header().Get("Content-Type"); ct != "application/manifest+json" {
		t.Errorf("manifest Content-Type = %q", ct)
	}
	rec = httptest.NewRecorder()
	noCacheMiddleware(handler).ServeHTTP(rec, httptest.NewRequest("GET", "/assets/x.js", nil))
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("asset Cache-Control = %q, want immutable", cc)
	}
}

// Without TERMOTE_PWA_DIR the server serves the embedded build, which in a
// test build is the placeholder page (webui/dist only holds .gitkeep).
func TestServeEmbeddedPWA(t *testing.T) {
	h, err := newServeHandler(serveConfig{NoAuth: true}, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Termote") {
		t.Fatalf("GET / = %d %q", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
		t.Fatalf("index.html Cache-Control = %q, want no-cache (embed.FS has no mtime)", cc)
	}
}

func TestNoCacheMiddleware(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := noCacheMiddleware(inner)

	tests := []struct {
		path        string
		wantNoCache bool
	}{
		{"/", true},
		{"/api/test", true},
		{"/sw.js", true},
		{"/manifest.webmanifest", true},
		{"/assets/app.js", false}, // assets should be cached
	}

	for _, tt := range tests {
		req := httptest.NewRequest("GET", tt.path, nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		cacheControl := rec.Header().Get("Cache-Control")
		hasNoCache := strings.Contains(cacheControl, "no-cache")

		if hasNoCache != tt.wantNoCache {
			t.Errorf("noCacheMiddleware(%s) Cache-Control = %q, wantNoCache = %v", tt.path, cacheControl, tt.wantNoCache)
		}
	}
}

func TestIsPWAPublicPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"/manifest.webmanifest", true},
		{"/sw.js", true},
		{"/workbox-abc123.js", true},
		{"/workbox-window.js", true},
		{"/", false},
		{"/api/test", false},
		{"/terminal/", false},
		{"/index.html", false},
		{"/workbox-.js", true},      // edge case: minimal workbox name
		{"/workbox-test.ts", false}, // not .js extension
		// Unclean or nested paths resolve to another file once cleaned
		{"/workbox-/../assets/index.js", false},
		{"/workbox-/../api/mux/sessions.js", false},
		{"/workbox-x/app.js", false},
		{"/workbox-a.js/", false},
		{"//workbox-a.js", false},
		{"/./workbox-a.js", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isPWAPublicPath(tt.path); got != tt.want {
				t.Errorf("isPWAPublicPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

// An encoded path that only looks like a workbox script must not serve
// another file without auth once the static handler cleans it.
func TestPublicPathBypassNeedsAuth(t *testing.T) {
	cfg := testConfig(t)
	if err := os.MkdirAll(cfg.PWADir+"/assets", 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"index.html", "assets/app.js", "workbox-abc.js"} {
		if err := os.WriteFile(cfg.PWADir+"/"+name, []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h, err := newServeHandler(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]int{
		"/workbox-abc.js":                          http.StatusOK,
		"/workbox-%2f..%2fassets%2fapp.js":         http.StatusUnauthorized,
		"/workbox-/..%2fassets/app.js":             http.StatusUnauthorized,
		"/workbox-%2f..%2findex.html%2fx.js":       http.StatusUnauthorized,
		"/workbox-%2f..%2fapi%2fmux%2fsessions.js": http.StatusUnauthorized,
	} {
		req := httptest.NewRequest("GET", "http://localhost:7680"+path, nil)
		req.Host = "localhost:7680"
		if rec := serve(h, req); rec.Code != want {
			t.Errorf("GET %s = %d %q, want %d", path, rec.Code, rec.Body.String(), want)
		}
	}
}

func TestBasicAuth(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := basicAuth("admin", "secret", inner)

	tests := []struct {
		name     string
		path     string
		user     string
		pass     string
		wantCode int
	}{
		{"no auth", "/api/test", "", "", http.StatusUnauthorized},
		{"wrong user", "/api/test", "wrong", "secret", http.StatusUnauthorized},
		{"wrong pass", "/api/test", "admin", "wrong", http.StatusUnauthorized},
		{"correct auth", "/api/test", "admin", "secret", http.StatusOK},
		{"stream requires auth", "/api/mux/stream", "", "", http.StatusUnauthorized},
		{"stream with auth", "/api/mux/stream", "admin", "secret", http.StatusOK},
		// PWA public paths bypass auth
		{"manifest no auth", "/manifest.webmanifest", "", "", http.StatusOK},
		{"sw.js no auth", "/sw.js", "", "", http.StatusOK},
		{"workbox no auth", "/workbox-abc123.js", "", "", http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tt.path, nil)
			if tt.user != "" || tt.pass != "" {
				req.SetBasicAuth(tt.user, tt.pass)
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantCode {
				t.Errorf("basicAuth(%s) status = %d, want %d", tt.name, rec.Code, tt.wantCode)
			}
		})
	}
}

func TestNewServeConfigFromEnv(t *testing.T) {
	// Set test env vars
	os.Setenv("TERMOTE_PORT", "8080")
	os.Setenv("TERMOTE_NO_AUTH", "true")
	defer os.Unsetenv("TERMOTE_PORT")
	defer os.Unsetenv("TERMOTE_NO_AUTH")

	cfg := newServeConfigFromEnv()

	if cfg.Port != "8080" {
		t.Errorf("cfg.Port = %q, want %q", cfg.Port, "8080")
	}
	if !cfg.NoAuth {
		t.Error("cfg.NoAuth = false, want true")
	}
	if cfg.MuxBackend != "tmux" {
		t.Errorf("cfg.MuxBackend = %q, want default tmux", cfg.MuxBackend)
	}
	if cfg.AllowedHosts != "" {
		t.Errorf("cfg.AllowedHosts = %q, want empty default", cfg.AllowedHosts)
	}
	if cfg.HerdrAllowNoAuth {
		t.Error("cfg.HerdrAllowNoAuth = true, want false by default")
	}
	t.Setenv("TERMOTE_HERDR_ALLOW_NO_AUTH", "true")
	if !newServeConfigFromEnv().HerdrAllowNoAuth {
		t.Error("TERMOTE_HERDR_ALLOW_NO_AUTH=true not read")
	}
}

func TestTerminalTokenStore(t *testing.T) {
	store := newStreamTokenStore()

	t.Run("generate and validate", func(t *testing.T) {
		token, err := store.generate()
		if err != nil {
			t.Fatalf("generate() error: %v", err)
		}
		if len(token) != 32 { // 16 bytes = 32 hex chars
			t.Errorf("token length = %d, want 32", len(token))
		}
		if !store.validate(token) {
			t.Error("validate() = false for fresh token")
		}
	})

	t.Run("single use", func(t *testing.T) {
		token, _ := store.generate()
		store.validate(token) // consume
		if store.validate(token) {
			t.Error("validate() = true for already-consumed token")
		}
	})

	t.Run("invalid token", func(t *testing.T) {
		if store.validate("nonexistent") {
			t.Error("validate() = true for invalid token")
		}
	})

	t.Run("expired token", func(t *testing.T) {
		token, _ := store.generate()
		// Manually expire it
		store.mu.Lock()
		store.tokens[token] = time.Now().Add(-1 * time.Second)
		store.mu.Unlock()
		if store.validate(token) {
			t.Error("validate() = true for expired token")
		}
	})

	t.Run("sweep expired on generate", func(t *testing.T) {
		// Add an expired token manually
		store.mu.Lock()
		store.tokens["expired1"] = time.Now().Add(-1 * time.Second)
		store.mu.Unlock()

		store.generate() // should sweep

		store.mu.Lock()
		_, exists := store.tokens["expired1"]
		store.mu.Unlock()
		if exists {
			t.Error("expired token not swept during generate()")
		}
	})
}

// A 0.x bundle cached by a service worker still loads /terminal/; it must get
// a JSON 410, not the SPA's index.html.
func TestRemovedTerminalRoute(t *testing.T) {
	h := newTestHandler(t, &fakeMux{})
	for _, path := range []string{"/terminal/", "/terminal/ws", "/terminal/?token=x"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, apiRequest(http.MethodGet, path, ""))
		if rec.Code != http.StatusGone {
			t.Errorf("GET %s = %d, want 410", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Errorf("GET %s Content-Type = %q, want JSON", path, ct)
		}
	}
}

func TestTerminalTokenEndpoint(t *testing.T) {
	store := newStreamTokenStore()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/mux/stream-token", handleTerminalToken(store))

	tests := []struct {
		name     string
		method   string
		dest     string
		wantCode int
	}{
		{"POST rejected", "POST", "empty", http.StatusMethodNotAllowed},
		{"direct browser", "GET", "document", http.StatusForbidden},
		{"no header (mobile/curl)", "GET", "", http.StatusOK},
		{"fetch/XHR allowed", "GET", "empty", http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/api/mux/stream-token", nil)
			if tt.dest != "" {
				req.Header.Set("Sec-Fetch-Dest", tt.dest)
			}
			rec := httptest.NewRecorder()

			mux.ServeHTTP(rec, req)

			if rec.Code != tt.wantCode {
				t.Errorf("terminal-token(%s) status = %d, want %d", tt.name, rec.Code, tt.wantCode)
			}
		})
	}
}

func TestAuthRateLimiter(t *testing.T) {
	t.Run("allows under limit", func(t *testing.T) {
		rl := newAuthRateLimiter()
		for i := 0; i < 4; i++ {
			rl.record("1.2.3.4")
		}
		if rl.isBlocked("1.2.3.4") {
			t.Error("should not be blocked with 4 failures")
		}
	})

	t.Run("blocks at limit", func(t *testing.T) {
		rl := newAuthRateLimiter()
		for i := 0; i < 5; i++ {
			rl.record("1.2.3.4")
		}
		if !rl.isBlocked("1.2.3.4") {
			t.Error("should be blocked after 5 failures")
		}
	})

	t.Run("different IPs independent", func(t *testing.T) {
		rl := newAuthRateLimiter()
		for i := 0; i < 5; i++ {
			rl.record("1.2.3.4")
		}
		if rl.isBlocked("5.6.7.8") {
			t.Error("different IP should not be blocked")
		}
	})

	t.Run("expires after window", func(t *testing.T) {
		rl := newAuthRateLimiter()
		// Manually insert old failures
		rl.mu.Lock()
		old := time.Now().Add(-2 * time.Minute)
		rl.failures["1.2.3.4"] = []time.Time{old, old, old, old, old}
		rl.mu.Unlock()

		if rl.isBlocked("1.2.3.4") {
			t.Error("expired failures should not block")
		}
	})

	t.Run("cleans up empty entries", func(t *testing.T) {
		rl := newAuthRateLimiter()
		// Insert expired failures
		rl.mu.Lock()
		old := time.Now().Add(-2 * time.Minute)
		rl.failures["1.2.3.4"] = []time.Time{old}
		rl.mu.Unlock()

		rl.isBlocked("1.2.3.4") // triggers sweep

		rl.mu.Lock()
		_, exists := rl.failures["1.2.3.4"]
		rl.mu.Unlock()
		if exists {
			t.Error("empty IP entry should be deleted after sweep")
		}
	})

	t.Run("record sweeps when map exceeds 1000", func(t *testing.T) {
		rl := newAuthRateLimiter()
		old := time.Now().Add(-2 * time.Minute)
		// Fill with 1001 expired IPs
		rl.mu.Lock()
		for i := 0; i < 1001; i++ {
			ip := fmt.Sprintf("10.0.%d.%d", i/256, i%256)
			rl.failures[ip] = []time.Time{old}
		}
		rl.mu.Unlock()

		// Record triggers sweep since map > 1000
		rl.record("99.99.99.99")

		rl.mu.Lock()
		size := len(rl.failures)
		rl.mu.Unlock()
		// Only the newly recorded IP should remain (all others expired)
		if size != 1 {
			t.Errorf("after sweep: map size = %d, want 1", size)
		}
	})
}

func TestBasicAuthRateLimiting(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := basicAuth("admin", "secret", inner)

	// Send 5 failed attempts
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest("GET", "/", nil)
		req.SetBasicAuth("admin", "wrong")
		req.RemoteAddr = "1.2.3.4:12345"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d, want 401", i+1, rec.Code)
		}
	}

	// 6th attempt should be rate limited
	req := httptest.NewRequest("GET", "/", nil)
	req.SetBasicAuth("admin", "wrong")
	req.RemoteAddr = "1.2.3.4:12345"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("rate limited request: got %d, want 429", rec.Code)
	}

	// Correct credentials from same IP should also be blocked
	req = httptest.NewRequest("GET", "/", nil)
	req.SetBasicAuth("admin", "secret")
	req.RemoteAddr = "1.2.3.4:12345"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("rate limited correct auth: got %d, want 429", rec.Code)
	}

	// Different IP should still work
	req = httptest.NewRequest("GET", "/", nil)
	req.SetBasicAuth("admin", "secret")
	req.RemoteAddr = "5.6.7.8:12345"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("different IP: got %d, want 200", rec.Code)
	}
}

func TestAllowNonNavigationOnly(t *testing.T) {
	tests := []struct {
		name      string
		dest      string
		setHeader bool
		wantOK    bool
	}{
		{"document blocked", "document", true, false},
		{"no header allowed (mobile)", "", false, true},
		{"image allowed", "image", true, true},
		{"empty (fetch) allowed", "empty", true, true},
		{"script allowed", "script", true, true},
		{"websocket allowed", "websocket", true, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			if tt.setHeader {
				req.Header.Set("Sec-Fetch-Dest", tt.dest)
			}
			rec := httptest.NewRecorder()

			got := allowNonNavigationOnly(rec, req)
			if got != tt.wantOK {
				t.Errorf("allowNonNavigationOnly(%s) = %v, want %v", tt.name, got, tt.wantOK)
			}
			if !tt.wantOK && rec.Code != http.StatusForbidden {
				t.Errorf("status = %d, want 403", rec.Code)
			}
		})
	}
}

func TestTokenStoreReusable(t *testing.T) {
	store := newTokenStore(time.Hour, false) // reusable tokens

	t.Run("generate and validate", func(t *testing.T) {
		token, err := store.generate()
		if err != nil {
			t.Fatalf("generate failed: %v", err)
		}
		if !store.validate(token) {
			t.Error("valid token should pass validation")
		}
	})

	t.Run("reusable token validates multiple times", func(t *testing.T) {
		token, _ := store.generate()
		for i := 0; i < 5; i++ {
			if !store.validate(token) {
				t.Errorf("reusable token should validate on attempt %d", i+1)
			}
		}
	})

	t.Run("invalid token rejected", func(t *testing.T) {
		if store.validate("nonexistent") {
			t.Error("invalid token should fail validation")
		}
	})

	t.Run("expired token rejected", func(t *testing.T) {
		shortStore := newTokenStore(time.Millisecond, false)
		token, _ := shortStore.generate()
		time.Sleep(5 * time.Millisecond)
		if shortStore.validate(token) {
			t.Error("expired token should fail validation")
		}
	})
}

func TestBasicAuthSessionCookie(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := basicAuth("admin", "secret", inner)

	t.Run("sets session cookie on successful auth", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/test", nil)
		req.SetBasicAuth("admin", "secret")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}

		cookies := rec.Result().Cookies()
		var sessionCookie *http.Cookie
		for _, c := range cookies {
			if c.Name == sessionCookieName {
				sessionCookie = c
				break
			}
		}
		if sessionCookie == nil {
			t.Fatal("session cookie not set")
		}
		if !sessionCookie.HttpOnly {
			t.Error("session cookie should be HttpOnly")
		}
		if sessionCookie.SameSite != http.SameSiteStrictMode {
			t.Error("session cookie should have SameSite=Strict")
		}
	})

	t.Run("session cookie allows access without basic auth", func(t *testing.T) {
		// First request: authenticate and get cookie
		req1 := httptest.NewRequest("GET", "/api/test", nil)
		req1.SetBasicAuth("admin", "secret")
		rec1 := httptest.NewRecorder()
		handler.ServeHTTP(rec1, req1)

		cookies := rec1.Result().Cookies()
		var sessionCookie *http.Cookie
		for _, c := range cookies {
			if c.Name == sessionCookieName {
				sessionCookie = c
				break
			}
		}
		if sessionCookie == nil {
			t.Fatal("session cookie not set")
		}

		// Second request: use cookie, no basic auth
		req2 := httptest.NewRequest("GET", "/api/test", nil)
		req2.AddCookie(sessionCookie)
		rec2 := httptest.NewRecorder()
		handler.ServeHTTP(rec2, req2)

		if rec2.Code != http.StatusOK {
			t.Errorf("session cookie should grant access, got %d", rec2.Code)
		}
	})

	t.Run("invalid session cookie falls back to basic auth", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/test", nil)
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "invalid"})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("invalid cookie without basic auth should return 401, got %d", rec.Code)
		}
	})

	t.Run("invalid cookie with valid basic auth succeeds", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/test", nil)
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "invalid"})
		req.SetBasicAuth("admin", "secret")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("valid basic auth should succeed even with invalid cookie, got %d", rec.Code)
		}
	})
}

func TestTerminalsNeverSeeTermoteVariables(t *testing.T) {
	t.Setenv("TERMOTE_PASS", "s3cret-pass")
	t.Setenv("TERMOTE_BIND", "0.0.0.0")
	for _, kv := range terminalEnv() {
		if strings.HasPrefix(strings.ToUpper(kv), "TERMOTE_") {
			t.Fatalf("terminal env carries %q", kv)
		}
	}
	cfg := newServeConfigFromEnv()
	scrubTermoteEnv()
	if cfg.Pass != "s3cret-pass" {
		t.Fatalf("config lost the password: %q", cfg.Pass)
	}
	for _, k := range []string{"TERMOTE_PASS", "TERMOTE_BIND"} {
		if _, ok := os.LookupEnv(k); ok {
			t.Fatalf("%s still in the process environment, so tmux would inherit it", k)
		}
	}
}

// A burst of concurrent wrong passwords from one IP gets no more than the
// limit through to the password check; the rest are refused as blocked.
func TestBasicAuthConcurrentFailuresBounded(t *testing.T) {
	var reached atomic.Int32
	h := basicAuth("admin", "secret", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range 1000 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = "1.2.3.4:5"
			req.SetBasicAuth("admin", "wrong")
			<-start
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code == http.StatusUnauthorized {
				reached.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if n := reached.Load(); n > authMaxFailures {
		t.Errorf("%d wrong passwords checked in a burst, want at most %d", n, authMaxFailures)
	}
}

// Right credentials and requests without any do not count as failures.
func TestBasicAuthRefundsNonFailures(t *testing.T) {
	h := basicAuth("admin", "secret", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	for range 10 {
		for _, creds := range [][2]string{{"admin", "secret"}, {}} {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = "1.2.3.4:5"
			if creds[0] != "" {
				req.SetBasicAuth(creds[0], creds[1])
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code == http.StatusTooManyRequests {
				t.Fatalf("blocked after logins that were not failures (%q)", creds)
			}
		}
	}
}

// An IPv6 client taking a new address of its /64 for each try still runs into
// a limit, while one address's failures leave the rest of its /64 alone.
func TestBasicAuthIPv6PrefixBounded(t *testing.T) {
	newTry := func() func(addr, pass string) int {
		h := basicAuth("admin", "secret", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		return func(addr, pass string) int {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = net.JoinHostPort(addr, "5")
			req.SetBasicAuth("admin", pass)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			return rec.Code
		}
	}

	try := newTry()
	for range authMaxFailures {
		try("2001:db8:1:2::1", "wrong")
	}
	if got := try("2001:db8:1:2::2", "secret"); got != http.StatusOK {
		t.Fatalf("another address of the /64 after one address's failures: %d, want 200", got)
	}

	// The /64 limit is exactly authMaxPrefixFailures, and right logins are
	// refunded on the /64 as well as on the address.
	try = newTry()
	for i := range authMaxPrefixFailures - 1 {
		try(fmt.Sprintf("2001:db8:1:2::%x", 0x100+i), "wrong")
	}
	for i := range 10 {
		if got := try(fmt.Sprintf("2001:db8:1:2::%x", 0x200+i), "secret"); got != http.StatusOK {
			t.Fatalf("right login %d one failure under the /64 limit: %d, want 200", i, got)
		}
	}
	try("2001:db8:1:2::300", "wrong")
	if got := try("2001:db8:1:2::ffff", "secret"); got != http.StatusTooManyRequests {
		t.Errorf("a fresh address of a /64 at its limit: %d, want 429", got)
	}
	if got := try("2001:db8:1:3::1", "secret"); got != http.StatusOK {
		t.Errorf("an address of another /64: %d, want 200", got)
	}
	if got := try("192.0.2.1", "secret"); got != http.StatusOK {
		t.Errorf("an IPv4 address: %d, want 200", got)
	}
}

func TestAuthPrefix(t *testing.T) {
	for _, tt := range []struct{ ip, want string }{
		{"2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"},
		{"fe80::1%eth0", "fe80::/64"},
		{"192.0.2.1", ""},
		{"::ffff:192.0.2.1", ""},
		{"not-an-ip", ""},
	} {
		if got := authPrefix(tt.ip); got != tt.want {
			t.Errorf("authPrefix(%q) = %q, want %q", tt.ip, got, tt.want)
		}
	}
}

// Wrong credentials and a blocked client are logged with the client's
// address; the credentials sent never are.
func TestBasicAuthLogsFailures(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	h := basicAuth("admin", "secret", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	for range authMaxFailures + 3 {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "198.51.100.7:5"
		req.SetBasicAuth("mallory", "hunter2")
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	out := buf.String()
	if !strings.Contains(out, "failed login from 198.51.100.7") {
		t.Errorf("no failed login line:\n%s", out)
	}
	if !strings.Contains(out, "198.51.100.7 blocked after too many failed logins from 198.51.100.7") {
		t.Errorf("no blocked line:\n%s", out)
	}
	if strings.Contains(out, "hunter2") || strings.Contains(out, "mallory") {
		t.Errorf("credentials in the log:\n%s", out)
	}
	if n := strings.Count(out, "\n"); n > 2 {
		t.Errorf("%d log lines for one burst, want at most 2:\n%s", n, out)
	}
}

// Logins without a cookie cannot grow the session store past its cap: the
// oldest session is dropped, the newest still works.
func TestBasicAuthSessionsBounded(t *testing.T) {
	h := basicAuth("admin", "secret", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	login := func() *http.Cookie {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.SetBasicAuth("admin", "secret")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		for _, c := range rec.Result().Cookies() {
			if c.Name == sessionCookieName {
				return c
			}
		}
		t.Fatal("no session cookie")
		return nil
	}
	withCookie := func(c *http.Cookie) int {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.AddCookie(c)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	first := login()
	var last *http.Cookie
	for range maxSessions {
		last = login()
	}
	if code := withCookie(first); code != http.StatusUnauthorized {
		t.Errorf("oldest session past the cap = %d, want 401", code)
	}
	if code := withCookie(last); code != http.StatusOK {
		t.Errorf("newest session = %d", code)
	}

	// A session in use survives logins without a cookie: the least recently
	// used one goes first.
	phone := login()
	for range maxSessions - 1 {
		login()
	}
	if code := withCookie(phone); code != http.StatusOK {
		t.Fatalf("phone session before the cap = %d", code)
	}
	for range maxSessions - 1 {
		login()
	}
	if code := withCookie(phone); code != http.StatusOK {
		t.Errorf("session in use dropped past the cap = %d", code)
	}
}

// A client that announces a body and never sends it is cut off once the
// request read timeout passes, even on a route that answers without reading
// the body (a 401).
func TestSlowBodyConnectionClosed(t *testing.T) {
	old := requestReadTimeout
	requestReadTimeout = 300 * time.Millisecond
	t.Cleanup(func() { requestReadTimeout = old })
	h, err := newServeHandler(testConfig(t), &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "POST /api/mux/panes/0/keys HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{", srv.Listener.Addr())
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	out, err := io.ReadAll(conn)
	if err != nil {
		t.Fatalf("connection still open after the read timeout: %v (read %q)", err, out)
	}
	if !strings.Contains(string(out), "401") {
		t.Errorf("response = %q", out)
	}
}

// The stream path skips the request read timeout only for a WebSocket the
// handler accepted: a body sent to it a byte at a time, before auth and from
// a Host that is not allowed, is cut off like on any other route.
func TestSlowBodyOnStreamPathClosed(t *testing.T) {
	old := requestReadTimeout
	requestReadTimeout = 300 * time.Millisecond
	t.Cleanup(func() { requestReadTimeout = old })
	h, err := newServeHandler(testConfig(t), &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	for _, host := range []string{srv.Listener.Addr().String(), "evil.example"} {
		conn, err := net.Dial("tcp", srv.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(conn, "POST /api/mux/stream HTTP/1.1\r\nHost: %s\r\nContent-Length: 200000\r\n\r\n{", host)
		conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		out, err := io.ReadAll(conn)
		conn.Close()
		if err != nil {
			t.Errorf("Host %s: connection still open after the read timeout: %v (read %q)", host, err, out)
		}
	}
}
