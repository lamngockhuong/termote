package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// serveConfig holds configuration for the server
type serveConfig struct {
	Port    string
	PWADir  string
	TTYDUrl string
	User    string
	Pass    string
	NoAuth  bool
	Bind    string
}

// newServeConfigFromEnv creates config from environment variables with defaults
func newServeConfigFromEnv() serveConfig {
	return serveConfig{
		Port:    envOr("TERMOTE_PORT", "7680"),
		PWADir:  envOr("TERMOTE_PWA_DIR", "./pwa/dist"),
		TTYDUrl: envOr("TERMOTE_TTYD_URL", "http://127.0.0.1:7681"),
		User:    envOr("TERMOTE_USER", "admin"),
		Pass:    os.Getenv("TERMOTE_PASS"),
		NoAuth:  os.Getenv("TERMOTE_NO_AUTH") == "true",
		Bind:    envOr("TERMOTE_BIND", "0.0.0.0"),
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// terminalTokenStore manages single-use, time-limited tokens for terminal iframe access.
type terminalTokenStore struct {
	mu     sync.Mutex
	tokens map[string]time.Time // token → expiry
}

func newTerminalTokenStore() *terminalTokenStore {
	return &terminalTokenStore{tokens: make(map[string]time.Time)}
}

// generate creates a single-use token valid for 30 seconds.
// Also sweeps expired tokens to prevent unbounded map growth.
func (s *terminalTokenStore) generate() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	now := time.Now()
	s.mu.Lock()
	// Sweep expired tokens
	for k, exp := range s.tokens {
		if now.After(exp) {
			delete(s.tokens, k)
		}
	}
	s.tokens[token] = now.Add(30 * time.Second)
	s.mu.Unlock()
	return token, nil
}

// validate checks and consumes a token (single-use).
func (s *terminalTokenStore) validate(token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.tokens[token]
	if !ok || time.Now().After(expiry) {
		delete(s.tokens, token)
		return false
	}
	delete(s.tokens, token) // single-use: consume immediately
	return true
}

// startServeMode starts the server (PWA static files + ttyd WebSocket proxy + tmux API + basic auth)
func startServeMode(cfg serveConfig) {
	mux := http.NewServeMux()
	tokenStore := newTerminalTokenStore()

	// tmux API endpoints under /api/tmux/
	mux.HandleFunc("/api/tmux/windows", handleWindows)
	mux.HandleFunc("/api/tmux/select/", handleSelect)
	mux.HandleFunc("/api/tmux/new", handleNew)
	mux.HandleFunc("/api/tmux/kill/", handleKill)
	mux.HandleFunc("/api/tmux/rename/", handleRename)
	mux.HandleFunc("/api/tmux/send-keys", handleSendKeys)
	mux.HandleFunc("/api/tmux/health", handleHealth)

	// Terminal token endpoint — only accessible via fetch/XHR from PWA, not direct browser navigation
	mux.HandleFunc("/api/tmux/terminal-token", handleTerminalToken(tokenStore))

	// ttyd reverse proxy (WebSocket support) - only accessible via iframe with valid token
	ttydURL, err := url.Parse(cfg.TTYDUrl)
	if err != nil {
		log.Fatalf("Invalid ttyd URL: %v", err)
	}
	ttydProxy := newWebSocketProxy(ttydURL)
	mux.Handle("/terminal/", iframeOnly(tokenStore, http.StripPrefix("/terminal", ttydProxy)))

	// PWA static files (fallback to index.html for SPA routing)
	absDir, _ := filepath.Abs(cfg.PWADir)
	mux.Handle("/", spaHandler(absDir))

	// Wrap with auth if enabled
	var handler http.Handler = mux
	if !cfg.NoAuth && cfg.Pass != "" {
		handler = basicAuth(cfg.User, cfg.Pass, handler)
	}

	// Add no-cache headers
	handler = noCacheMiddleware(handler)

	addr := cfg.Bind + ":" + cfg.Port
	log.Printf("Termote server listening on %s (PWA: %s)", addr, absDir)
	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}

// authRateLimiter tracks failed auth attempts per IP to prevent brute force attacks.
type authRateLimiter struct {
	mu       sync.Mutex
	failures map[string][]time.Time // IP → timestamps of recent failures
}

func newAuthRateLimiter() *authRateLimiter {
	return &authRateLimiter{failures: make(map[string][]time.Time)}
}

// isBlocked returns true if the IP has exceeded 5 failed attempts in the last minute.
func (rl *authRateLimiter) isBlocked(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	cutoff := time.Now().Add(-1 * time.Minute)
	recent := rl.failures[ip]
	// Sweep old entries
	filtered := recent[:0]
	for _, t := range recent {
		if t.After(cutoff) {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) == 0 {
		delete(rl.failures, ip)
		return false
	}
	rl.failures[ip] = filtered
	return len(filtered) >= 5
}

// record adds a failed attempt for the given IP.
// Sweeps all expired entries when map exceeds 1000 IPs to prevent unbounded growth.
func (rl *authRateLimiter) record(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	rl.failures[ip] = append(rl.failures[ip], now)
	if len(rl.failures) > 1000 {
		cutoff := now.Add(-1 * time.Minute)
		for k, times := range rl.failures {
			filtered := times[:0]
			for _, t := range times {
				if t.After(cutoff) {
					filtered = append(filtered, t)
				}
			}
			if len(filtered) == 0 {
				delete(rl.failures, k)
			} else {
				rl.failures[k] = filtered
			}
		}
	}
}

// basicAuth wraps a handler with HTTP basic authentication.
// Note: uses r.RemoteAddr for rate limiting. Behind a reverse proxy, all clients
// may share one IP — consider the proxy's own rate limiting in that setup.
func basicAuth(user, pass string, next http.Handler) http.Handler {
	limiter := newAuthRateLimiter()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract client IP (strip port)
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if ip == "" {
			ip = r.RemoteAddr
		}
		if limiter.isBlocked(ip) {
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		u, p, ok := r.BasicAuth()
		if !ok {
			// No credentials provided — prompt browser, don't count as failure
			w.Header().Set("WWW-Authenticate", `Basic realm="Terminal Access"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if subtle.ConstantTimeCompare([]byte(u), []byte(user)) != 1 ||
			subtle.ConstantTimeCompare([]byte(p), []byte(pass)) != 1 {
			// Wrong credentials — count as failed attempt
			limiter.record(ip)
			w.Header().Set("WWW-Authenticate", `Basic realm="Terminal Access"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// spaHandler serves static files with SPA fallback to index.html
func spaHandler(dir string) http.Handler {
	fs := http.Dir(dir)
	fileServer := http.FileServer(fs)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Try serving the file directly
		path := filepath.Join(dir, filepath.Clean(r.URL.Path))
		if _, err := os.Stat(path); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		// SPA fallback: serve index.html for unmatched routes
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}

// newWebSocketProxy creates a reverse proxy that supports WebSocket upgrades
func newWebSocketProxy(target *url.URL) http.Handler {
	// Create HTTP proxy once and reuse
	httpProxy := httputil.NewSingleHostReverseProxy(target)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WebSocket upgrade
		if isWebSocket(r) {
			proxyWebSocket(w, r, target)
			return
		}
		// Regular HTTP reverse proxy (reused)
		httpProxy.ServeHTTP(w, r)
	})
}

func isWebSocket(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// proxyWebSocket handles WebSocket connections by creating a TCP tunnel
func proxyWebSocket(w http.ResponseWriter, r *http.Request, target *url.URL) {
	// Connect to upstream
	targetAddr := target.Host
	if !strings.Contains(targetAddr, ":") {
		if target.Scheme == "https" || target.Scheme == "wss" {
			targetAddr += ":443"
		} else {
			targetAddr += ":80"
		}
	}

	upstream, err := net.DialTimeout("tcp", targetAddr, 2*time.Second)
	if err != nil {
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	// Hijack the client connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "WebSocket not supported", http.StatusInternalServerError)
		return
	}
	client, _, err := hijacker.Hijack()
	if err != nil {
		log.Printf("WebSocket hijack error: %v", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	defer client.Close()

	// Forward the original request to upstream
	r.URL.Scheme = target.Scheme
	r.URL.Host = target.Host
	r.Host = target.Host
	r.Write(upstream)

	// Bidirectional copy - wait for both directions to complete
	done := make(chan struct{}, 2)
	go func() { io.Copy(upstream, client); done <- struct{}{} }()
	go func() { io.Copy(client, upstream); done <- struct{}{} }()
	<-done
	<-done // Wait for both goroutines to prevent leak
}

// allowNonNavigationOnly blocks direct browser navigation (Sec-Fetch-Dest: document)
// and non-browser clients (empty Sec-Fetch-Dest). Returns true if the request is allowed.
func allowNonNavigationOnly(w http.ResponseWriter, r *http.Request) bool {
	dest := r.Header.Get("Sec-Fetch-Dest")
	if dest == "document" || dest == "" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return false
	}
	return true
}

// iframeOnly enforces that /terminal/ is only accessible via the PWA iframe.
// Layer 1: Sec-Fetch-Dest — blocks direct navigation (document) and non-browser clients (empty).
// Layer 2: Token — the initial iframe load (Sec-Fetch-Dest: iframe) must carry a valid single-use token.
// Sub-resources (script, style, websocket) loaded by the iframe page are allowed without token.
func iframeOnly(tokens *terminalTokenStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowNonNavigationOnly(w, r) {
			return
		}
		// Initial iframe load must carry a valid token
		if r.Header.Get("Sec-Fetch-Dest") == "iframe" {
			token := r.URL.Query().Get("token")
			if !tokens.validate(token) {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// handleTerminalToken returns a handler that generates single-use tokens for terminal iframe access.
// Only accessible via fetch/XHR (Sec-Fetch-Dest != document and != empty).
func handleTerminalToken(tokens *terminalTokenStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		if !allowNonNavigationOnly(w, r) {
			return
		}
		token, err := tokens.generate()
		if err != nil {
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"token": token})
	}
}

// noCacheMiddleware adds no-cache headers to all responses
func noCacheMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip cache headers for assets (they have content hashes)
		if !strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
			w.Header().Set("Pragma", "no-cache")
		}
		next.ServeHTTP(w, r)
	})
}
