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
	"net/netip"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"slices"
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
	// AllowLocalAddr also accepts the address a request arrived on as its
	// Host (LAN access; see hostAllowlist).
	AllowLocalAddr bool
	// Tailscale is "host[:port]" to publish over Tailscale HTTPS once
	// listening; empty publishes nothing.
	Tailscale string
	// FilesDenyDirs are never served by the files routes, even inside a
	// pane's root: the config and state dirs (the secret and the encrypted
	// password).
	FilesDenyDirs []string
	// UploadDir holds images uploaded from the PWA; empty disables uploads.
	UploadDir string
	// OnListen runs once the port is bound (serve records its PID then, so
	// a server that cannot bind never replaces the running one's PID file).
	OnListen func()
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

// No TERMOTE_* variable may reach a terminal: any tmux command may start the
// tmux server, which hands the environment it started with to every shell, so
// `env` in a pane would print the password (TERMOTE_PASS) or settings that
// would then configure a server started from that pane.
var termoteEnvKeys = []string{
	"TERMOTE_PASS", "TERMOTE_USER", "TERMOTE_PORT", "TERMOTE_BIND", "TERMOTE_NO_AUTH",
	"TERMOTE_PWA_DIR", "TERMOTE_ALLOWED_HOSTS", "TERMOTE_MUX", "TERMOTE_HERDR_ALLOW_NO_AUTH",
	"TERMOTE_PROJECT_DIR",
}

// scrubTermoteEnv removes every TERMOTE_* variable from the process
// environment once the config is read.
func scrubTermoteEnv() {
	for _, kv := range os.Environ() {
		if isTermoteEnv(kv) {
			k, _, _ := strings.Cut(kv, "=")
			os.Unsetenv(k)
		}
	}
}

// isTermoteEnv reports whether a KEY=value entry is a TERMOTE_* variable.
// Windows keys are case-insensitive, so the match is too.
func isTermoteEnv(kv string) bool {
	k, _, _ := strings.Cut(kv, "=")
	return len(k) > len("TERMOTE_") && strings.EqualFold(k[:len("TERMOTE_")], "TERMOTE_")
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
	// A capped store of reusable tokens (sessions) keeps the most recently
	// used ones: a token in use moves to the end of the eviction order, so
	// logins without a cookie (curl -u, scripts) drop idle sessions first,
	// not the phone that uses its session all day.
	if !s.singleUse && s.max > 0 {
		s.mu.Lock()
		defer s.mu.Unlock()
		expiry, ok := s.tokens[token]
		if !ok || now.After(expiry) {
			return false
		}
		if i := slices.Index(s.order, token); i >= 0 {
			s.order = append(append(s.order[:i:i], s.order[i+1:]...), token)
		}
		return true
	}
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
	allowed := parseAllowedHosts(cfg.AllowedHosts, cfg.AllowLocalAddr)
	hub := newStreamHub(maxStreams)

	var uploads *uploadStore
	if cfg.UploadDir != "" {
		var err error
		if uploads, err = newUploadStore(cfg.UploadDir); err != nil {
			log.Printf("uploads disabled: %v", err)
		}
	}
	agent := registerMuxRoutes(mux, m, tokenStore, uploads)
	registerStreamRoutes(mux, m, tokenStore, allowed, hub)
	files := registerFilesRoutes(mux, m, allowed, cfg.FilesDenyDirs)
	agent.registerCommandsRoute(mux, files, allowed)
	// Unknown /api/ paths get JSON 404 instead of the SPA fallback.
	mux.HandleFunc("/api/", apiNotFound)

	// The 0.x terminal route. A 0.x bundle still cached by a service worker
	// gets a clear JSON error instead of the SPA's HTML.
	mux.HandleFunc("/terminal/", func(w http.ResponseWriter, r *http.Request) {
		jsonError(w, "the /terminal/ endpoint was removed in 1.0; reload the app", http.StatusGone)
	})

	// PWA static files (fallback to index.html for SPA routing)
	pwa := webui.FS(cfg.PWADir)
	mux.Handle("/", spaHandler(pwa))

	var handler http.Handler = mux
	if !cfg.NoAuth {
		handler = basicAuth(cfg.User, cfg.Pass, handler)
	}
	handler = writeGuard(allowed, handler)
	// Inside hostGuard: the policy names the request's Host, so only an
	// allowed one.
	handler = securityHeaders(pwa, handler)
	handler = hostGuard(allowed, handler)
	return readDeadline(noCacheMiddleware(handler)), hub, nil
}

// requestReadTimeout bounds reading one request, its body included:
// ReadHeaderTimeout covers only the headers, and a client that announces a
// body then sends it a byte at a time would otherwise hold its connection
// (and a file descriptor) forever. Bodies are at most 64 KB, but for an
// uploaded image (10 MB): its handler extends the deadline to
// uploadReadTimeout once the request is authenticated, and a Chat view
// message with images to its own time budget once its body is read. Past
// the deadline, net/http's background read also cancels the request's
// context, so no other handler but the stream may run longer (mux calls
// take at most muxTimeout, git gitTimeout).
var requestReadTimeout = 60 * time.Second

// readDeadline sets requestReadTimeout on every request but the terminal
// stream, a WebSocket that reads for as long as it is open. Matched by path,
// not by an Upgrade header any request could carry. The server clears the
// deadline before it reads the connection's next request.
func readDeadline(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/mux/stream" {
			// Fails only on a writer without a connection (tests).
			_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(requestReadTimeout))
		}
		next.ServeHTTP(w, r)
	})
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
		reapOrphanTerminals(isHerdrStreamCmdline)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(cfg.Bind, cfg.Port))
	if err != nil {
		log.Fatal(err)
	}
	if cfg.OnListen != nil {
		cfg.OnListen()
	}
	// After the first signal, a second one kills the process as usual.
	go func() { <-ctx.Done(); stop() }()
	// Publish over Tailscale only once the port answers.
	if cfg.Tailscale != "" {
		go applyTailscale(ctx, cfg.Tailscale, ln.Addr().(*net.TCPAddr).Port)
	}
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

// authRateLimiter tracks failed auth attempts per IP, and per /64 for IPv6, to
// prevent brute force attacks.
type authRateLimiter struct {
	mu       sync.Mutex
	failures map[string][]time.Time // IP or IPv6 /64 → timestamps of recent failures
}

func newAuthRateLimiter() *authRateLimiter {
	return &authRateLimiter{failures: make(map[string][]time.Time)}
}

// authMaxFailures failed attempts per IP within a minute block further ones.
const authMaxFailures = 5

// authMaxPrefixFailures failed attempts within a minute from one IPv6 /64
// block further ones from all of it: a host usually holds a whole /64 and
// could take a new address for each try. It is above authMaxFailures so one
// device's typos do not lock out the other devices of its LAN or tailnet.
const authMaxPrefixFailures = 20

// authPrefix is the /64 of an IPv6 address (zone dropped), or "" for IPv4,
// IPv4-mapped IPv6 and anything that does not parse.
func authPrefix(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil || a.Unmap().Is4() {
		return ""
	}
	p, err := a.WithZone("").Prefix(64)
	if err != nil {
		return ""
	}
	return p.String()
}

// recentLocked returns ip's failures of the last minute, dropping older
// ones (and the entry once empty). rl.mu must be held.
func (rl *authRateLimiter) recentLocked(ip string, now time.Time) []time.Time {
	cutoff := now.Add(-1 * time.Minute)
	recent := rl.failures[ip]
	filtered := recent[:0]
	for _, t := range recent {
		if t.After(cutoff) {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) == 0 {
		delete(rl.failures, ip)
		return nil
	}
	rl.failures[ip] = filtered
	return filtered
}

// isBlocked returns true if the IP has exceeded 5 failed attempts in the last minute.
func (rl *authRateLimiter) isBlocked(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	return len(rl.recentLocked(ip, time.Now())) >= authMaxFailures
}

// reserve checks the limits and counts the attempt as failed in one step,
// before its credentials are compared: a burst of concurrent requests cannot
// all pass the check before any failure is recorded. It returns "" when the
// attempt may go on, else the key that is blocked: ip, or its IPv6 /64.
func (rl *authRateLimiter) reserve(ip string) string {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	prefix := authPrefix(ip)
	if len(rl.recentLocked(ip, now)) >= authMaxFailures {
		return ip
	}
	if prefix != "" && len(rl.recentLocked(prefix, now)) >= authMaxPrefixFailures {
		return prefix
	}
	rl.addLocked(ip, now)
	if prefix != "" {
		rl.addLocked(prefix, now)
	}
	return ""
}

// refund takes back one reservation of ip: its credentials were right, or
// it sent none.
func (rl *authRateLimiter) refund(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.dropLastLocked(ip)
	if prefix := authPrefix(ip); prefix != "" {
		rl.dropLastLocked(prefix)
	}
}

// dropLastLocked removes key's newest failure. rl.mu must be held.
func (rl *authRateLimiter) dropLastLocked(key string) {
	f := rl.failures[key]
	switch {
	case len(f) > 1:
		rl.failures[key] = f[:len(f)-1]
	case len(f) == 1:
		delete(rl.failures, key)
	}
}

// record adds a failed attempt for the given IP.
func (rl *authRateLimiter) record(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.addLocked(ip, time.Now())
}

// addLocked adds a failure of ip at now. It sweeps all expired entries when
// the map exceeds 1000 IPs to prevent unbounded growth. rl.mu must be held.
func (rl *authRateLimiter) addLocked(ip string, now time.Time) {
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

// isPWAPublicPath checks if a path should bypass authentication. The path is
// the decoded r.URL.Path, which the static handler cleans before serving: a
// path that is not already clean (e.g. /workbox-%2f..%2fassets%2fx.js) would
// resolve to a different file, so it is never public.
func isPWAPublicPath(p string) bool {
	if p != path.Clean(p) {
		return false
	}
	if slices.Contains(pwaPublicPaths, p) {
		return true
	}
	// Workbox scripts at the root (e.g., /workbox-*.js), never in a subdirectory
	name, ok := strings.CutPrefix(p, "/workbox-")
	return ok && strings.HasSuffix(name, ".js") && !strings.Contains(name, "/")
}

const (
	sessionCookieName = "termote_session"
	sessionTTL        = 24 * time.Hour
	// maxSessions caps live sessions: each login without a valid cookie
	// makes one, and past the cap the least recently used is dropped (its
	// device logs in again with the saved credentials).
	maxSessions = 256
)

// basicAuth wraps a handler with HTTP basic authentication.
// After successful basic auth, sets a session cookie to avoid re-prompting
// (fixes mobile browsers not persisting basic auth across page loads).
// Note: uses r.RemoteAddr for rate limiting. Behind a reverse proxy, all clients
// may share one IP — consider the proxy's own rate limiting in that setup.
func basicAuth(user, pass string, next http.Handler) http.Handler {
	limiter := newAuthRateLimiter()
	sessions := newTokenStore(sessionTTL, false)
	sessions.max = maxSessions
	// Bounded like hostGuard's rejects, so a password guesser cannot flood
	// the log. The credentials sent are never logged.
	failedLogins := &rateLimitedLog{every: rejectLogEvery}
	blockedLogins := &rateLimitedLog{every: rejectLogEvery}

	// credsMatch compares in constant time, so the time taken does not tell
	// how much of a guess was right.
	credsMatch := func(u, p string) bool {
		return subtle.ConstantTimeCompare([]byte(u), []byte(user)) == 1 &&
			subtle.ConstantTimeCompare([]byte(p), []byte(pass)) == 1
	}
	// Set session cookie to avoid re-prompting on mobile reloads
	startSession := func(w http.ResponseWriter, r *http.Request) {
		sessionToken, err := sessions.generate()
		if err != nil {
			log.Printf("session token generation failed: %v", err)
			return
		}
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
	hasSession := func(r *http.Request) bool {
		cookie, err := r.Cookie(sessionCookieName)
		return err == nil && sessions.validate(cookie.Value)
	}
	// challenge asks for credentials. A browser gets the sign-in form on a
	// page load and no Basic auth challenge: its prompt would sit on top of
	// the form (two logins at once), and an iOS home-screen app never shows
	// it. Other clients (curl --anyauth) still get the challenge; the CLI
	// sends its credentials up front.
	challenge := func(w http.ResponseWriter, r *http.Request) {
		if isNavigation(r) {
			writeLoginPage(w, http.StatusUnauthorized, loginForm{Next: safeNext(r.URL.RequestURI())})
			return
		}
		if r.Header.Get("Sec-Fetch-Mode") == "" {
			w.Header().Set("WWW-Authenticate", `Basic realm="Terminal Access"`)
		}
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
	}
	// login serves the sign-in form (GET) and checks what it posts, under
	// the same rate limit as Basic auth.
	login := func(w http.ResponseWriter, r *http.Request, ip string) {
		switch r.Method {
		case http.MethodGet:
			next := safeNext(r.URL.Query().Get("next"))
			if hasSession(r) {
				http.Redirect(w, r, next, http.StatusSeeOther)
				return
			}
			writeLoginPage(w, http.StatusOK, loginForm{Next: next})
			return
		case http.MethodPost:
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		if isCrossSiteLogin(r) {
			http.Error(w, "cross-site request rejected", http.StatusForbidden)
			return
		}
		if !isFormPost(r) {
			http.Error(w, "Unsupported Media Type", http.StatusUnsupportedMediaType)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxLoginBody)
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}
		next := safeNext(r.PostForm.Get("next"))
		// A phone's keyboard suggestion ends the username with a space.
		username := strings.TrimSpace(r.PostForm.Get("username"))
		if blocked := limiter.reserve(ip); blocked != "" {
			blockedLogins.printf("auth: %s blocked after too many failed logins from %s", ip, blocked)
			writeLoginPage(w, http.StatusTooManyRequests, loginForm{next, "Too many failed attempts. Wait a minute and try again.", username})
			return
		}
		if !credsMatch(username, r.PostForm.Get("password")) {
			failedLogins.printf("auth: failed login from %s", ip)
			writeLoginPage(w, http.StatusUnauthorized, loginForm{next, "Wrong username or password.", username})
			return
		}
		limiter.refund(ip)
		startSession(w, r)
		http.Redirect(w, r, next, http.StatusSeeOther)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip auth for PWA public paths (manifest, service worker)
		if isPWAPublicPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}

		// Extract client IP (strip port)
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if ip == "" {
			ip = r.RemoteAddr
		}
		if r.URL.Path == loginPath {
			login(w, r, ip)
			return
		}

		// Check session cookie first (mobile browsers drop basic auth)
		if hasSession(r) {
			next.ServeHTTP(w, r)
			return
		}

		// Counted as a failure until the credentials prove right.
		if blocked := limiter.reserve(ip); blocked != "" {
			blockedLogins.printf("auth: %s blocked after too many failed logins from %s", ip, blocked)
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		u, p, ok := r.BasicAuth()
		if !ok {
			// No credentials provided — prompt browser, don't count as failure
			limiter.refund(ip)
			challenge(w, r)
			return
		}
		if !credsMatch(u, p) {
			// Wrong credentials — the reservation stays as a failed attempt
			failedLogins.printf("auth: failed login from %s", ip)
			challenge(w, r)
			return
		}
		limiter.refund(ip)
		startSession(w, r)
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
