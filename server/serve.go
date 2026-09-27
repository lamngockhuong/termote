package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lamngockhuong/termote/server/webui"
)

// serveConfig holds configuration for the server
type serveConfig struct {
	Port string
	// PWADir serves the PWA from disk instead of the embedded build (PWA
	// development); empty uses the embedded build.
	PWADir       string
	User         string
	Pass         string
	NoAuth       bool
	Bind         string
	AllowedHosts string
	MuxBackend   string
	// HerdrAllowNoAuth lets herdr run with auth disabled. herdr exposes every
	// workspace of the user, so NoAuth alone is refused.
	HerdrAllowNoAuth bool
}

// newServeConfigFromEnv creates config from environment variables with defaults
func newServeConfigFromEnv() serveConfig {
	return serveConfig{
		Port:   envOr("TERMOTE_PORT", "7680"),
		PWADir: os.Getenv("TERMOTE_PWA_DIR"),
		User:   envOr("TERMOTE_USER", "admin"),
		Pass:   os.Getenv("TERMOTE_PASS"),
		NoAuth: os.Getenv("TERMOTE_NO_AUTH") == "true",
		Bind:   envOr("TERMOTE_BIND", "0.0.0.0"),
		// Comma-separated extra hostnames; loopback is always allowed.
		AllowedHosts: os.Getenv("TERMOTE_ALLOWED_HOSTS"),
		MuxBackend:   envOr("TERMOTE_MUX", "tmux"),

		HerdrAllowNoAuth: os.Getenv("TERMOTE_HERDR_ALLOW_NO_AUTH") == "true",
	}
}

// secretEnvKeys must never reach a terminal: any tmux command may start the
// tmux server, which hands the environment it started with to every shell, so
// `env` in a pane would print the password.
var secretEnvKeys = []string{"TERMOTE_PASS"}

// scrubSecretEnv removes the secrets from the process environment once the
// config has read them.
func scrubSecretEnv() {
	for _, k := range secretEnvKeys {
		os.Unsetenv(k)
	}
}

// isSecretEnv reports whether a KEY=value entry holds a secret. Windows keys
// are case-insensitive, so the match is too.
func isSecretEnv(kv string) bool {
	k, _, _ := strings.Cut(kv, "=")
	for _, s := range secretEnvKeys {
		if strings.EqualFold(k, s) {
			return true
		}
	}
	return false
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// tokenStore manages time-limited tokens with configurable behavior.
type tokenStore struct {
	mu        sync.RWMutex
	tokens    map[string]time.Time // token → expiry
	ttl       time.Duration
	singleUse bool
	max       int      // live tokens kept; 0 = unlimited
	order     []string // issue order, used only when max > 0
}

func newTokenStore(ttl time.Duration, singleUse bool) *tokenStore {
	return &tokenStore{
		tokens:    make(map[string]time.Time),
		ttl:       ttl,
		singleUse: singleUse,
	}
}

// generate creates a token valid for the configured TTL.
// Sweeps expired tokens to prevent unbounded map growth.
func (s *tokenStore) generate() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	now := time.Now()
	s.mu.Lock()
	for k, exp := range s.tokens {
		if now.After(exp) {
			delete(s.tokens, k)
		}
	}
	if s.max > 0 {
		// Forget used and expired tokens, then drop the oldest over the cap.
		// Issue order, not expiry: timestamps can tie on coarse clocks.
		live := s.order[:0]
		for _, k := range s.order {
			if _, ok := s.tokens[k]; ok {
				live = append(live, k)
			}
		}
		for len(live) >= s.max {
			delete(s.tokens, live[0])
			live = live[1:]
		}
		s.order = append(live, token)
	}
	s.tokens[token] = now.Add(s.ttl)
	s.mu.Unlock()
	return token, nil
}

// validate checks a token. If singleUse is true, consumes the token.
func (s *tokenStore) validate(token string) bool {
	now := time.Now()
	// Fast path: read-only check for reusable tokens
	if !s.singleUse {
		s.mu.RLock()
		expiry, ok := s.tokens[token]
		s.mu.RUnlock()
		if !ok || now.After(expiry) {
			return false
		}
		return true
	}
	// Single-use: need write lock to delete
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.tokens[token]
	if !ok || now.After(expiry) {
		return false
	}
	delete(s.tokens, token)
	return true
}

// maxStreamTokens caps unused stream tokens an authenticated client can pile
// up.
const maxStreamTokens = 32

// newStreamTokenStore holds the single-use, 30s tokens that open
// /api/mux/stream.
func newStreamTokenStore() *tokenStore {
	s := newTokenStore(30*time.Second, true)
	s.max = maxStreamTokens
	return s
}

// newMux returns the backend selected by TERMOTE_MUX. Background work of the
// backend (herdr's event subscription) runs until ctx ends.
func newMux(ctx context.Context, backend string) (Mux, error) {
	switch backend {
	case "tmux":
		return tmuxMux{}, nil
	case "herdr":
		return newHerdrMux(ctx, herdrSocketPath())
	}
	return nil, fmt.Errorf("unsupported TERMOTE_MUX %q (supported: tmux, herdr)", backend)
}

// newServeHandler builds the full handler chain: PWA static files,
// /api/mux/*, auth, Host allowlist and cross-site write protection.
func newServeHandler(cfg serveConfig, m Mux) (http.Handler, error) {
	h, _, err := buildServer(cfg, m)
	return h, err
}

// buildServer is newServeHandler plus the hub that owns open terminal streams,
// which the caller must shut down.
func buildServer(cfg serveConfig, m Mux) (http.Handler, *streamHub, error) {
	if err := validateConfig(cfg); err != nil {
		return nil, nil, err
	}
	mux := http.NewServeMux()
	tokenStore := newStreamTokenStore()
	allowed := parseAllowedHosts(cfg.AllowedHosts)
	hub := newStreamHub(maxStreams)

	registerMuxRoutes(mux, m, tokenStore)
	registerStreamRoutes(mux, m, tokenStore, allowed, hub)
	// Unknown /api/ paths get JSON 404 instead of the SPA fallback.
	mux.HandleFunc("/api/", apiNotFound)

	// The 0.x terminal route. A 0.x bundle still cached by a service worker
	// gets a clear JSON error instead of the SPA's HTML.
	mux.HandleFunc("/terminal/", func(w http.ResponseWriter, r *http.Request) {
		jsonError(w, "the /terminal/ endpoint was removed in 1.0; reload the app", http.StatusGone)
	})

	// PWA static files (fallback to index.html for SPA routing)
	mux.Handle("/", spaHandler(webui.FS(cfg.PWADir)))

	var handler http.Handler = mux
	if !cfg.NoAuth {
		handler = basicAuth(cfg.User, cfg.Pass, handler)
	}
	handler = writeGuard(allowed, handler)
	handler = hostGuard(allowed, handler)
	return noCacheMiddleware(handler), hub, nil
}

// shutdownTimeout bounds how long SIGTERM/SIGINT waits for requests and
// terminal processes before the server exits anyway; it leaves room for a
// stream to escalate to a kill after processKillWait.
const shutdownTimeout = processKillWait + 2*time.Second

// startServeMode starts the server (PWA static files + terminal stream + mux API + basic auth)
func startServeMode(cfg serveConfig) {
	if err := validateConfig(cfg); err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	m, err := newMux(ctx, cfg.MuxBackend)
	if err != nil {
		log.Fatal(err)
	}
	switch m.Name() {
	case "tmux":
		reapOrphanTerminals(isTmuxAttachCmdline)
		scrubTmuxSecrets(ctx)
	case "herdr":
		reapOrphanTerminals(isHerdrObserveCmdline)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(cfg.Bind, cfg.Port))
	if err != nil {
		log.Fatal(err)
	}
	// After the first signal, a second one kills the process as usual.
	go func() { <-ctx.Done(); stop() }()
	if err := runServer(ctx, cfg, m, ln); err != nil {
		log.Fatal(err)
	}
}

// runServer serves on ln until ctx is cancelled, then stops accepting
// requests, closes every terminal stream and waits for their processes.
func runServer(ctx context.Context, cfg serveConfig, m Mux, ln net.Listener) error {
	handler, hub, err := buildServer(cfg, m)
	if err != nil {
		ln.Close()
		return err
	}
	pwa := "embedded"
	if cfg.PWADir != "" {
		pwa, _ = filepath.Abs(cfg.PWADir)
	} else if !webui.Built() {
		pwa = "not built (placeholder page)"
	}
	log.Printf("Termote server listening on %s (PWA: %s, backend: %s)", ln.Addr(), pwa, m.Name())
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	log.Printf("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	// Shutdown ignores hijacked connections, so streams are closed by the hub.
	if err := srv.Shutdown(sctx); err != nil {
		log.Printf("http shutdown: %v", err)
	}
	if err := hub.shutdown(sctx); err != nil {
		log.Printf("terminal streams still open at exit: %v", err)
	}
	return nil
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

// pwaPublicPaths are paths that must be accessible without authentication.
// Service workers and manifest fetches don't include credentials by default.
var pwaPublicPaths = []string{
	"/manifest.webmanifest",
	"/sw.js",
}

// isPWAPublicPath checks if a path should bypass authentication.
func isPWAPublicPath(path string) bool {
	for _, p := range pwaPublicPaths {
		if path == p {
			return true
		}
	}
	// Workbox scripts (e.g., /workbox-*.js)
	if strings.HasPrefix(path, "/workbox-") && strings.HasSuffix(path, ".js") {
		return true
	}
	return false
}

const (
	sessionCookieName = "termote_session"
	sessionTTL        = 24 * time.Hour
)

// basicAuth wraps a handler with HTTP basic authentication.
// After successful basic auth, sets a session cookie to avoid re-prompting
// (fixes mobile browsers not persisting basic auth across page loads).
// Note: uses r.RemoteAddr for rate limiting. Behind a reverse proxy, all clients
// may share one IP — consider the proxy's own rate limiting in that setup.
func basicAuth(user, pass string, next http.Handler) http.Handler {
	limiter := newAuthRateLimiter()
	sessions := newTokenStore(sessionTTL, false)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip auth for PWA public paths (manifest, service worker)
		if isPWAPublicPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}

		// Check session cookie first (mobile browsers drop basic auth)
		if cookie, err := r.Cookie(sessionCookieName); err == nil {
			if sessions.validate(cookie.Value) {
				next.ServeHTTP(w, r)
				return
			}
		}

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

		// Set session cookie to avoid re-prompting on mobile reloads
		sessionToken, err := sessions.generate()
		if err != nil {
			log.Printf("session token generation failed: %v", err)
		} else {
			http.SetCookie(w, &http.Cookie{
				Name:     sessionCookieName,
				Value:    sessionToken,
				Path:     "/",
				MaxAge:   int(sessionTTL.Seconds()),
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
				Secure:   requestIsHTTPS(r),
			})
		}

		next.ServeHTTP(w, r)
	})
}

// The PWA manifest; Go's table does not know the extension.
func init() { mime.AddExtensionType(".webmanifest", "application/manifest+json") }

// spaHandler serves static files with SPA fallback to index.html
func spaHandler(files fs.FS) http.Handler {
	fileServer := http.FileServerFS(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Try serving the file directly
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" {
			name = "."
		}
		st, err := fs.Stat(files, name)
		if err == nil && (!st.IsDir() || name == ".") {
			fileServer.ServeHTTP(w, r)
			return
		}
		// A missing asset is a 404, not the app: a stale bundle must fail
		// loudly instead of parsing HTML as JavaScript.
		if name == "assets" || strings.HasPrefix(name, "assets/") {
			http.NotFound(w, r)
			return
		}
		// SPA fallback: serve index.html for unmatched routes (and
		// directories, which are never listed)
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}

func isWebSocket(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// allowNonNavigationOnly blocks direct browser navigation (Sec-Fetch-Dest: document).
// Allows requests without the header (mobile browsers via LAN/Tailscale may omit it).
// Returns true if the request is allowed.
func allowNonNavigationOnly(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Dest") == "document" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return false
	}
	return true
}

// handleTerminalToken returns a handler that generates single-use tokens for
// /api/mux/stream. Direct browser navigation is refused.
func handleTerminalToken(tokens *tokenStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		if !allowNonNavigationOnly(w, r) {
			return
		}
		// A foreign page cannot read the token, but could keep minting them to
		// push the PWA's own out of the bounded store.
		if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
			jsonError(w, "cross-site request rejected", http.StatusForbidden)
			return
		}
		token, err := tokens.generate()
		if err != nil {
			log.Printf("stream token generation failed: %v", err)
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"token": token})
	}
}

// noCacheMiddleware adds no-cache headers to all responses but the hashed
// Vite assets, which never change under the same name. The embedded files
// have no mtime (no Last-Modified, no 304), so assets are marked immutable.
func noCacheMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
			w.Header().Set("Pragma", "no-cache")
		}
		next.ServeHTTP(w, r)
	})
}
