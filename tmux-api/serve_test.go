package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
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
	// Create temp dir with test files
	tmpDir := t.TempDir()
	indexContent := []byte("<html>index</html>")
	os.WriteFile(filepath.Join(tmpDir, "index.html"), indexContent, 0644)
	os.WriteFile(filepath.Join(tmpDir, "app.js"), []byte("console.log('app')"), 0644)

	handler := spaHandler(tmpDir)

	tests := []struct {
		path     string
		wantCode int
	}{
		{"/", http.StatusOK},
		{"/app.js", http.StatusOK},
		{"/nonexistent", http.StatusOK}, // SPA fallback
		{"/any/deep/path", http.StatusOK}, // SPA fallback
	}

	for _, tt := range tests {
		req := httptest.NewRequest("GET", tt.path, nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != tt.wantCode {
			t.Errorf("spaHandler(%s) status = %d, want %d", tt.path, rec.Code, tt.wantCode)
		}
	}
}

func TestNoCacheMiddleware(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := noCacheMiddleware(inner)

	tests := []struct {
		path         string
		wantNoCache  bool
	}{
		{"/", true},
		{"/api/test", true},
		{"/assets/app.js", false}, // assets should be cached
	}

	for _, tt := range tests {
		req := httptest.NewRequest("GET", tt.path, nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		cacheControl := rec.Header().Get("Cache-Control")
		hasNoCache := cacheControl != ""

		if hasNoCache != tt.wantNoCache {
			t.Errorf("noCacheMiddleware(%s) Cache-Control = %q, wantNoCache = %v", tt.path, cacheControl, tt.wantNoCache)
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
		{"terminal requires auth", "/terminal/", "", "", http.StatusUnauthorized},
		{"terminal with auth", "/terminal/", "admin", "secret", http.StatusOK},
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
}

func TestTerminalTokenStore(t *testing.T) {
	store := newTerminalTokenStore()

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

func TestIframeOnly(t *testing.T) {
	store := newTerminalTokenStore()
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := iframeOnly(store, inner)

	tests := []struct {
		name     string
		dest     string // Sec-Fetch-Dest header value ("" = not set)
		token    string // query param ("" = not set, "valid" = generate one, else literal)
		wantCode int
	}{
		{"direct navigation", "document", "", http.StatusForbidden},
		{"no header (mobile/curl)", "", "", http.StatusOK},
		{"iframe without token", "iframe", "", http.StatusForbidden},
		{"iframe with invalid token", "iframe", "bad", http.StatusForbidden},
		{"iframe with valid token", "iframe", "valid", http.StatusOK},
		{"websocket", "websocket", "", http.StatusOK},
		{"script sub-resource", "script", "", http.StatusOK},
		{"style sub-resource", "style", "", http.StatusOK},
		{"fetch/XHR", "empty", "", http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tokenParam := tt.token
			if tokenParam == "valid" {
				tokenParam, _ = store.generate()
			}

			path := "/terminal/"
			if tokenParam != "" {
				path += "?token=" + tokenParam
			}
			req := httptest.NewRequest("GET", path, nil)
			if tt.dest != "" {
				req.Header.Set("Sec-Fetch-Dest", tt.dest)
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantCode {
				t.Errorf("iframeOnly(%s) status = %d, want %d", tt.name, rec.Code, tt.wantCode)
			}
		})
	}
}

func TestTerminalTokenEndpoint(t *testing.T) {
	store := newTerminalTokenStore()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/tmux/terminal-token", handleTerminalToken(store))

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
			req := httptest.NewRequest(tt.method, "/api/tmux/terminal-token", nil)
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
		name     string
		dest     string
		setHeader bool
		wantOK   bool
	}{
		{"document blocked", "document", true, false},
		{"no header allowed (mobile)", "", false, true},
		{"iframe allowed", "iframe", true, true},
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

func TestNewWebSocketProxyHTTP(t *testing.T) {
	// Create a test backend server
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("backend response"))
	}))
	defer backend.Close()

	targetURL, _ := url.Parse(backend.URL)
	proxy := newWebSocketProxy(targetURL)

	// Test regular HTTP request (not WebSocket)
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()

	proxy.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("proxy HTTP status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestNewWebSocketProxyDetection(t *testing.T) {
	// Create a test backend
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	targetURL, _ := url.Parse(backend.URL)
	proxy := newWebSocketProxy(targetURL)

	// WebSocket request - will fail to connect but tests the detection path
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	rec := httptest.NewRecorder()

	proxy.ServeHTTP(rec, req)

	// Should attempt WebSocket proxy (will fail, but path is covered)
	// We just verify it doesn't crash and returns some response
	if rec.Code == 0 {
		t.Error("proxy should return a response")
	}
}
