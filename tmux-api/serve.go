package main

import (
	"crypto/subtle"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// serveConfig holds configuration for full server mode
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
	cfg := serveConfig{
		Port:    envOr("TERMOTE_PORT", "7680"),
		PWADir:  envOr("TERMOTE_PWA_DIR", "./pwa/dist"),
		TTYDUrl: envOr("TERMOTE_TTYD_URL", "http://127.0.0.1:7681"),
		User:    envOr("TERMOTE_USER", "admin"),
		Pass:    os.Getenv("TERMOTE_PASS"),
		NoAuth:  os.Getenv("TERMOTE_NO_AUTH") == "true",
		Bind:    envOr("TERMOTE_BIND", "0.0.0.0"),
	}
	return cfg
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// startServeMode starts the full server (PWA + ttyd proxy + tmux API + auth)
func startServeMode(cfg serveConfig) {
	mux := http.NewServeMux()

	// tmux API endpoints under /api/tmux/
	mux.HandleFunc("/api/tmux/windows", handleWindows)
	mux.HandleFunc("/api/tmux/select/", handleSelect)
	mux.HandleFunc("/api/tmux/new", handleNew)
	mux.HandleFunc("/api/tmux/kill/", handleKill)
	mux.HandleFunc("/api/tmux/rename/", handleRename)
	mux.HandleFunc("/api/tmux/send-keys", handleSendKeys)
	mux.HandleFunc("/api/tmux/health", handleHealth)

	// ttyd reverse proxy (WebSocket support)
	ttydURL, err := url.Parse(cfg.TTYDUrl)
	if err != nil {
		log.Fatalf("Invalid ttyd URL: %v", err)
	}
	ttydProxy := newWebSocketProxy(ttydURL)
	mux.Handle("/terminal/", http.StripPrefix("/terminal", ttydProxy))

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
	log.Fatal(http.ListenAndServe(addr, handler))
}

// basicAuth wraps a handler with HTTP basic authentication
func basicAuth(user, pass string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip auth for terminal WebSocket (iframe handles it)
		if strings.HasPrefix(r.URL.Path, "/terminal/") {
			next.ServeHTTP(w, r)
			return
		}
		u, p, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(u), []byte(user)) != 1 ||
			subtle.ConstantTimeCompare([]byte(p), []byte(pass)) != 1 {
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
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WebSocket upgrade
		if isWebSocket(r) {
			proxyWebSocket(w, r, target)
			return
		}
		// Regular HTTP reverse proxy
		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.ServeHTTP(w, r)
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

	upstream, err := net.Dial("tcp", targetAddr)
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer client.Close()

	// Forward the original request to upstream
	r.URL.Scheme = target.Scheme
	r.URL.Host = target.Host
	r.Host = target.Host
	r.Write(upstream)

	// Bidirectional copy
	done := make(chan struct{}, 2)
	go func() { io.Copy(upstream, client); done <- struct{}{} }()
	go func() { io.Copy(client, upstream); done <- struct{}{} }()
	<-done
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
