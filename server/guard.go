package main

import (
	"errors"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// loopbackHosts are always allowed; a DNS-rebinding page still sends its own
// hostname in Host, so allowing loopback names does not reopen that hole.
var loopbackHosts = []string{"localhost", "127.0.0.1", "::1"}

// hostAllowlist holds normalised hostnames (no port, no brackets, lowercase).
// With localAddr it also accepts the IP address the request arrived on: a
// LAN client types the server's address, which is exactly that. The check
// then follows the machine's addresses as they are now (late network at
// boot, a new DHCP lease) and still blocks DNS rebinding, since an
// attacker's hostname is never one of this machine's IPs.
type hostAllowlist struct {
	names     map[string]struct{}
	localAddr bool
}

// parseAllowedHosts builds the allowlist from TERMOTE_ALLOWED_HOSTS (comma
// separated) plus loopback. There is deliberately no wildcard: users can only
// add names (start --allow-host), never switch the check off.
func parseAllowedHosts(env string, localAddr bool) hostAllowlist {
	a := hostAllowlist{names: map[string]struct{}{}, localAddr: localAddr}
	for _, h := range loopbackHosts {
		a.names[h] = struct{}{}
	}
	for _, h := range strings.Split(env, ",") {
		if h = normalizeHost(h); h != "" {
			a.names[h] = struct{}{}
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

// allows reports whether hostport (a Host header or an Origin's host) may
// reach the server over request r.
func (a hostAllowlist) allows(r *http.Request, hostport string) bool {
	h := normalizeHost(hostport)
	if h == "" {
		return false
	}
	if _, ok := a.names[h]; ok {
		return true
	}
	if !a.localAddr {
		return false
	}
	local, ok := r.Context().Value(http.LocalAddrContextKey).(*net.TCPAddr)
	ip := net.ParseIP(h)
	return ok && ip != nil && ip.Equal(local.IP)
}

// rejectLogEvery bounds "rejected host" log lines, so a scanner hitting a
// LAN-bound server cannot flood the log.
const rejectLogEvery = 10 * time.Second

// rateLimitedLog prints at most one line per interval and reports how many
// lines it dropped in between.
type rateLimitedLog struct {
	mu         sync.Mutex
	every      time.Duration
	last       time.Time
	suppressed int
}

func (l *rateLimitedLog) printf(format string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if !l.last.IsZero() && now.Sub(l.last) < l.every {
		l.suppressed++
		return
	}
	if l.suppressed > 0 {
		format += " (%d similar lines suppressed)"
		a = append(a, l.suppressed)
	}
	l.last, l.suppressed = now, 0
	log.Printf(format, a...)
}

// hostGuard rejects requests whose Host header is not in the allowlist, which
// blocks DNS rebinding from a malicious page.
func hostGuard(allowed hostAllowlist, next http.Handler) http.Handler {
	rejects := &rateLimitedLog{every: rejectLogEvery}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed.allows(r, r.Host) {
			host := normalizeHost(r.Host)
			rejects.printf("rejected request for host %q from %s", host, r.RemoteAddr)
			msg := "Host \"" + host + "\" is not allowed. Add it with: " +
				"termote start --allow-host " + host
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
		// The sign-in form is not JSON; only its Origin is checked here, where
		// the allowlist is, before the login rate limiter counts the POST.
		if r.URL.Path == loginPath && r.Method == http.MethodPost && foreignLoginOrigin(allowed, r) {
			http.Error(w, "cross-site request rejected", http.StatusForbidden)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/") || !isWriteMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		if msg := crossSiteRejection(allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		// An upload is a raw image body: image/* is not CORS-safelisted either,
		// so another site still needs the preflight we never answer.
		// Multipart stays refused: a form posts it without any preflight.
		mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err == nil && r.URL.Path == "/api/mux/uploads" && isUploadType(mt) {
			next.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/api/mux/uploads" {
			writeUploadError(w, errUploadUnsupported)
			return
		}
		if err != nil || mt != "application/json" {
			jsonError(w, "Content-Type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// crossSiteRejection returns why r must be refused as cross-site, or "".
// Browsers send Sec-Fetch-Site and Origin on fetches; a request without them
// (some mobile browsers, curl) passes, as it cannot come from another page's
// script with the user's credentials.
func crossSiteRejection(allowed hostAllowlist, r *http.Request) string {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		return "cross-site request rejected"
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || !allowed.allows(r, u.Host) {
			return "origin not allowed"
		}
	}
	return ""
}

// apiNotFound answers unknown /api/ paths with JSON so an old PWA bundle gets a
// parseable error instead of the SPA's index.html.
func apiNotFound(w http.ResponseWriter, r *http.Request) {
	jsonError(w, "not found", http.StatusNotFound)
}

// validateConfig refuses a config that would silently run without auth, or
// with a username no client could log in as.
func validateConfig(cfg serveConfig) error {
	if !cfg.NoAuth && cfg.Pass == "" {
		return errors.New("TERMOTE_PASS is empty: set a password, or set TERMOTE_NO_AUTH=true to disable auth explicitly")
	}
	// Basic auth splits the user from the password at the first ":", so a
	// name holding one could never log in.
	if !cfg.NoAuth && strings.Contains(cfg.User, ":") {
		return errors.New("TERMOTE_USER must not contain ':' (it separates the username from the password)")
	}
	if cfg.NoAuth && cfg.MuxBackend == "herdr" && !cfg.HerdrAllowNoAuth {
		return errors.New("TERMOTE_NO_AUTH=true with TERMOTE_MUX=herdr would expose every herdr workspace without a password; set TERMOTE_HERDR_ALLOW_NO_AUTH=true to accept that")
	}
	return nil
}

// requestIsHTTPS reports whether the client reached us over HTTPS, directly or
// through a proxy such as `tailscale serve`. X-Forwarded-Proto is trusted from
// any source: in container mode the proxy arrives from the bridge gateway, not
// loopback, and a client that forges the header only marks its own session
// cookie Secure, which its browser then withholds over plain HTTP.
func requestIsHTTPS(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}
