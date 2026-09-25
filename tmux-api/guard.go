package main

import (
	"errors"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// loopbackHosts are always allowed; a DNS-rebinding page still sends its own
// hostname in Host, so allowing loopback names does not reopen that hole.
var loopbackHosts = []string{"localhost", "127.0.0.1", "::1"}

// hostAllowlist holds normalised hostnames (no port, no brackets, lowercase).
type hostAllowlist map[string]struct{}

// parseAllowedHosts builds the allowlist from TERMOTE_ALLOWED_HOSTS (comma
// separated) plus loopback. There is deliberately no wildcard: users can only
// add names (install --allow-host), never switch the check off.
func parseAllowedHosts(env string) hostAllowlist {
	a := hostAllowlist{}
	for _, h := range loopbackHosts {
		a[h] = struct{}{}
	}
	for _, h := range strings.Split(env, ",") {
		if h = normalizeHost(h); h != "" {
			a[h] = struct{}{}
		}
	}
	return a
}

// normalizeHost strips an optional scheme, port and IPv6 brackets and lowercases.
func normalizeHost(hostport string) string {
	h := strings.TrimSpace(hostport)
	if u, err := url.Parse(h); err == nil && u.Scheme != "" && u.Host != "" {
		h = u.Host
	}
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	h = strings.TrimPrefix(strings.TrimSuffix(h, "]"), "[")
	return strings.TrimSuffix(strings.ToLower(h), ".")
}

func (a hostAllowlist) allows(hostport string) bool {
	h := normalizeHost(hostport)
	if h == "" {
		return false
	}
	_, ok := a[h]
	return ok
}

// hostGuard rejects requests whose Host header is not in the allowlist, which
// blocks DNS rebinding from a malicious page.
func hostGuard(allowed hostAllowlist, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed.allows(r.Host) {
			host := normalizeHost(r.Host)
			log.Printf("rejected request for host %q from %s", host, r.RemoteAddr)
			msg := "Host \"" + host + "\" is not allowed. Add it with: " +
				"termote install <mode> --allow-host " + host +
				" (Windows: termote.ps1 install <mode> -AllowHost " + host + ")"
			if strings.HasPrefix(r.URL.Path, "/api/") {
				jsonError(w, msg, http.StatusForbidden)
			} else {
				http.Error(w, msg, http.StatusForbidden)
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isWriteMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	}
	return true
}

// writeGuard protects state-changing /api/ requests from cross-site callers:
// browsers always send Sec-Fetch-Site and Origin on such requests, and a
// required JSON Content-Type forces a CORS preflight that we never answer.
func writeGuard(allowed hostAllowlist, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || !isWriteMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
			jsonError(w, "cross-site request rejected", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host == "" || !allowed.allows(u.Host) {
				jsonError(w, "origin not allowed", http.StatusForbidden)
				return
			}
		}
		if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
			jsonError(w, "Content-Type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// apiNotFound answers unknown /api/ paths with JSON so an old PWA bundle gets a
// parseable error instead of the SPA's index.html.
func apiNotFound(w http.ResponseWriter, r *http.Request) {
	jsonError(w, "not found", http.StatusNotFound)
}

// validateConfig refuses a config that would silently run without auth.
func validateConfig(cfg serveConfig) error {
	if !cfg.NoAuth && cfg.Pass == "" {
		return errors.New("TERMOTE_PASS is empty: set a password, or set TERMOTE_NO_AUTH=true to disable auth explicitly")
	}
	if cfg.NoAuth && cfg.MuxBackend == "herdr" && !cfg.HerdrAllowNoAuth {
		return errors.New("TERMOTE_NO_AUTH=true with TERMOTE_MUX=herdr would expose every herdr workspace without a password; set TERMOTE_HERDR_ALLOW_NO_AUTH=true to accept that")
	}
	return nil
}

// requestIsHTTPS trusts X-Forwarded-Proto only from a loopback proxy such as
// `tailscale serve`; a remote client could otherwise set it freely.
func requestIsHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if r.Header.Get("X-Forwarded-Proto") != "https" {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
