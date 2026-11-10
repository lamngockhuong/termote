package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// /api/machines/{id}/mux/{rest...} is /api/mux/{rest...} on machine id,
// forwarded over its bridge. It is a route of this server like any other:
// basicAuth, writeGuard (on the path with the prefix removed),
// securityHeaders and hostGuard ran before it. Because the machine no
// longer sees Origin or Sec-Fetch-*, the proxy runs the cross-site checks
// itself, then removes every credential and header of this server's, and
// sends the request's role (X-Termote-Role). Only an allowlist of routes is
// forwarded: never the devices, sign-ins, Web Push or sign-in links of the
// machine, which belong to whoever holds its own password.

// machinePathRe splits a proxied path: the machine id and the rest.
var machinePathRe = regexp.MustCompile(`^/api/machines/([0-9a-f]{16})/mux/(.+)$`)

// machineRest is p with /api/machines/{id}/mux/ replaced by /api/mux/: what
// the machine serves. Any other path is returned as it is.
func machineRest(p string) string {
	if m := machinePathRe.FindStringSubmatch(p); m != nil {
		return "/api/mux/" + m[2]
	}
	return p
}

// machineRouteRe is the allowlist of routes forwarded to a machine.
var machineRouteRe = regexp.MustCompile(`^(?:snapshot|overview|activity|system|stream-token|stream|health|uploads|files/places|` +
	`(?:tabs|panes|groups|worktrees|tasks|templates|recent-groups)(?:/.*)?)$`)

// machineResponseIdleWait and machineResponseBodyMost bound reading a
// machine's answer once its header came: machineConn has no read deadline (an
// ssh pipe), so a machine that sent a header and then stalled would hold one
// of machineMaxConns until the client left. Each read of the body gets the
// idle wait, the whole body the most, as a download from this server gets
// (downloadIdleTimeout, downloadMaxDuration). A WebSocket stream (101) is
// bounded by neither.
var (
	machineResponseIdleWait = downloadIdleTimeout
	machineResponseBodyMost = downloadMaxDuration
)

// idleBody restarts idle each time a read returns bytes.
type idleBody struct {
	io.ReadCloser
	idle *time.Timer
}

func (b *idleBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		b.idle.Reset(machineResponseIdleWait)
	}
	return n, err
}

// maxForwardedStreams bounds the terminal streams forwarded to machines,
// apart from this server's own maxStreams.
const maxForwardedStreams = 32

// forwardedStreamRecheck is how often a forwarded stream checks its device
// or session is still signed in (a revoke in another process, an expiry).
var forwardedStreamRecheck = 15 * time.Second

var (
	errMachineUnknown        = &codedError{code: "machine_unknown", msg: "no such machine", status: http.StatusNotFound}
	errMachineRouteForbidden = &codedError{code: "machine_route_forbidden", msg: "not available on another machine", status: http.StatusNotFound}
)

// machineErrorCode is the coded error a client gets for a machine that
// cannot be reached; what ssh said stays in the log.
func machineErrorCode(err error) *codedError {
	switch {
	case errors.Is(err, errMachineUnauthorized), errors.Is(err, errMachineHostKey):
		// A changed host key is never connected to: to a client it is a
		// machine that refuses until the CLI fixes it.
		return &codedError{code: "machine_unauthorized", msg: "the machine refused this server's connection", status: http.StatusBadGateway}
	case errors.Is(err, errMachineIncompatible):
		return &codedError{code: "machine_incompatible", msg: "the machine runs another release (see termote machine status)", status: http.StatusBadGateway}
	}
	return &codedError{code: "machine_offline", msg: "the machine is offline", status: http.StatusBadGateway}
}

func writeCoded(w http.ResponseWriter, e *codedError) { jsonErrorCode(w, e.code, e.msg, e.status) }

// machineBodyLimit is the largest body the edge takes for rest: the
// machine applies its own, exact one.
func machineBodyLimit(rest string) int64 {
	if isFilesUploadPath(rest) {
		return maxUploadFileSize
	}
	return max(int64(uploadMaxFile), int64(fileWriteBody), int64(agentMessageBody))
}

// machineStripHeaders are removed from every forwarded request: this
// server's credentials and cookies, the browser's site headers (checked
// here), any X-Termote-* a client sent, and what proxies in front set.
var machineStripHeaders = []string{"Cookie", "Authorization", "Origin", "Referer", "Forwarded"}

func stripMachineHeaders(h http.Header, proxyHeader string) {
	for _, k := range machineStripHeaders {
		h.Del(k)
	}
	if proxyHeader != "" {
		h.Del(proxyHeader)
	}
	for k := range h {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "sec-fetch-") || strings.HasPrefix(lk, "x-termote-") || strings.HasPrefix(lk, "x-forwarded-") ||
			lk == "cf-connecting-ip" || lk == "x-real-ip" {
			h.Del(k)
		}
	}
}

// machineTokenWindow is how long a stream token lives on the machine; a
// client asks at most machineTokenMax of them (machineViewTokenMax for the
// view role) per machine in that window. On the machine every forwarded
// token has the same (empty) device, so its own per-device cap cannot tell
// one client from another: without this, one client could push every other
// client's pending tokens out of the machine's store.
const (
	machineTokenWindow  = 30 * time.Second
	machineTokenMax     = 16
	machineViewTokenMax = maxViewStreamTokens
)

// tokenLimiter counts recent stream-token requests per client and machine.
type tokenLimiter struct {
	mu   sync.Mutex
	seen map[string][]time.Time
}

// allow records a request of key and reports whether it is within max.
func (t *tokenLimiter) allow(key string, max int, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, ts := range t.seen {
		kept := ts[:0]
		for _, at := range ts {
			if now.Sub(at) < machineTokenWindow {
				kept = append(kept, at)
			}
		}
		if len(kept) == 0 {
			delete(t.seen, k)
		} else {
			t.seen[k] = kept
		}
	}
	if len(t.seen[key]) >= max {
		return false
	}
	t.seen[key] = append(t.seen[key], now)
	return true
}

// tokenClient names who asks for a token, apart from every other client.
func tokenClient(a authInfo) string {
	switch {
	case a.DeviceID != "":
		return "device:" + a.DeviceID
	case a.SessionID != "":
		return "session:" + a.SessionID
	}
	return "password"
}

func registerMachineProxy(mux *http.ServeMux, agent *agentAPI, fwd *streamHub, allowed hostAllowlist, proxyHeader string) {
	tokens := &tokenLimiter{seen: map[string][]time.Time{}}
	mux.HandleFunc("/api/machines/", func(w http.ResponseWriter, r *http.Request) {
		// The id and the route are read from the decoded path; the path is
		// forwarded as it was escaped (a tmux pane id holds a '%'), but
		// never with an escaped '/' or '\\' a segment check would miss.
		m := machinePathRe.FindStringSubmatch(r.URL.Path)
		esc := machinePathRe.FindStringSubmatch(r.URL.EscapedPath())
		if m == nil || esc == nil || strings.Contains(strings.ToLower(esc[2]), "%2f") || strings.Contains(strings.ToLower(esc[2]), "%5c") {
			writeCoded(w, errMachineRouteForbidden)
			return
		}
		id, rest, restEsc := m[1], m[2], esc[2]
		if strings.Contains("/"+rest+"/", "/../") || strings.Contains("/"+rest+"/", "/./") || strings.Contains(rest, "//") || !machineRouteRe.MatchString(rest) {
			writeCoded(w, errMachineRouteForbidden)
			return
		}
		l := agent.machines.link(id)
		if l == nil {
			writeCoded(w, errMachineUnknown)
			return
		}
		// The cross-site checks the machine can no longer make: every
		// method (a GET names what runs in every pane), the token route
		// never as a navigation, and a stream's Origin.
		if msg := crossSiteRejection(allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		if rest == "stream-token" && !allowNonNavigationOnly(w, r) {
			return
		}
		if isWriteMethod(r.Method) && !requireWriteRole(w, r) {
			return
		}
		a, _ := authFrom(r.Context())
		if rest == "stream-token" {
			max := machineTokenMax
			if isViewOnly(r) {
				max = machineViewTokenMax
			}
			if !tokens.allow(id+"|"+tokenClient(a), max, time.Now()) {
				jsonErrorCode(w, errTokensBusy.code, errTokensBusy.msg, errTokensBusy.status)
				return
			}
		}
		if isWriteMethod(r.Method) {
			auditf("machine-request", "id", id, "method", r.Method, "path", machinePathClass(rest), "by", auditBy(a))
			limit := machineBodyLimit("/api/mux/" + rest)
			r.Body = http.MaxBytesReader(w, r.Body, limit)
			wait := uploadReadTimeout
			if isFilesUploadPath("/api/mux/" + rest) {
				wait = uploadMaxDuration
			}
			_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(wait))
		}
		// Ending the request's context makes the transport close the
		// connection (and its ssh), which frees the slot.
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		r = r.WithContext(ctx)
		var idle, most *time.Timer
		defer func() {
			if idle != nil {
				idle.Stop()
				most.Stop()
			}
		}()
		proxy := &httputil.ReverseProxy{
			Transport: l.transport,
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.Out.URL = &url.URL{Scheme: "http", Host: localSocketHost, Path: "/api/mux/" + rest, RawPath: "/api/mux/" + restEsc, RawQuery: r.URL.RawQuery}
				pr.Out.Host = localSocketHost
				stripMachineHeaders(pr.Out.Header, proxyHeader)
				pr.Out.Header.Set(bridgeRoleHeader, string(requestRole(r.Context())))
				if origin := originAuth(a); origin != "" {
					pr.Out.Header.Set(bridgeOriginAuthHeader, origin)
				}
			},
			ModifyResponse: func(resp *http.Response) error {
				confineMachineResponse(resp)
				if resp.StatusCode != http.StatusSwitchingProtocols {
					idle = time.AfterFunc(machineResponseIdleWait, cancel)
					most = time.AfterFunc(machineResponseBodyMost, cancel)
					resp.Body = &idleBody{ReadCloser: resp.Body, idle: idle}
				}
				return nil
			},
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				if errors.Is(err, context.Canceled) {
					return
				}
				st, lerr := l.state()
				if lerr == nil {
					lerr = err
				}
				log.Printf("machine %s: %s %s: %v (%s)", l.rec.Label, r.Method, machinePathClass(rest), err, st)
				writeCoded(w, machineErrorCode(lerr))
			},
			FlushInterval: -1,
		}
		l.begin()
		defer l.end()
		if rest != "stream" || !isWebSocket(r) {
			proxy.ServeHTTP(w, r)
			return
		}
		serveForwardedStream(w, r, proxy, fwd, a)
	})
}

// serveForwardedStream forwards a terminal stream while it is registered
// with fwd under the request's device and session: a revoke, a sign-out or
// an expiry (checked every forwardedStreamRecheck) closes it.
func serveForwardedStream(w http.ResponseWriter, r *http.Request, proxy *httputil.ReverseProxy, fwd *streamHub, a authInfo) {
	ctx, cancel := context.WithCancelCause(r.Context())
	defer cancel(nil)
	entry, err := fwd.addFor(cancel, requestRole(r.Context()), a.DeviceID, a.SessionID)
	if err != nil {
		switch {
		case errors.Is(err, errDeviceRevoked), errors.Is(err, errSessionRevoked):
			jsonError(w, "signed out", http.StatusUnauthorized)
		case errors.Is(err, errTooManyViewers):
			jsonError(w, "too many viewers", http.StatusTooManyRequests)
		default:
			jsonError(w, "server shutting down", http.StatusServiceUnavailable)
		}
		return
	}
	defer fwd.remove(entry)
	done := make(chan struct{})
	defer close(done)
	go func() {
		t := time.NewTicker(forwardedStreamRecheck)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				if err := fwd.recheck(entry); err != nil {
					cancel(err)
					return
				}
			}
		}
	}()
	proxy.ServeHTTP(w, r.WithContext(ctx))
}

// machineResponseKeep are the headers of a machine's answer passed on, in
// canonical form; every other one is dropped. A header can act on this
// server's origin on behalf of another computer (Set-Cookie, a service
// worker's scope, Clear-Site-Data, NEL and Report-To sending later requests'
// URLs elsewhere, WWW-Authenticate asking for a password in this origin's
// name) or send the browser elsewhere (Refresh, Location), and a list of
// those kept missing some. termote answers no route a machine serves with
// a redirect or a challenge.
var machineResponseKeep = map[string]bool{
	"Content-Type": true, "Content-Length": true, "Content-Disposition": true, "Content-Encoding": true,
	"Content-Range": true, "Accept-Ranges": true, "Content-Security-Policy": true,
	"Cache-Control": true, "Pragma": true, "Etag": true, "Last-Modified": true, "Vary": true,
	"Allow": true, "Retry-After": true, "Date": true, "X-Content-Type-Options": true,
}

// machineUpgradeKeep are the headers a WebSocket upgrade answers with.
var machineUpgradeKeep = map[string]bool{
	"Connection": true, "Upgrade": true, "Sec-Websocket-Accept": true,
	"Sec-Websocket-Protocol": true, "Sec-Websocket-Extensions": true, "Date": true,
}

// confineMachineResponse keeps a machine's answer from acting as a page of
// this origin: only the headers it needs pass, and what it serves runs
// sandboxed (an opaque origin, no script), as this server's own downloads
// do, so a machine that turned hostile cannot reach this server's routes or
// the other machines with the user's cookies. A WebSocket upgrade carries
// no page.
func confineMachineResponse(resp *http.Response) {
	keep := machineResponseKeep
	if resp.StatusCode == http.StatusSwitchingProtocols {
		keep = machineUpgradeKeep
	}
	for k := range resp.Header {
		if !keep[http.CanonicalHeaderKey(k)] {
			delete(resp.Header, k)
		}
	}
	if resp.StatusCode == http.StatusSwitchingProtocols {
		return
	}
	resp.Header.Add("Content-Security-Policy", svgPolicy)
	resp.Header.Set("X-Content-Type-Options", "nosniff")
}

// originAuth names how a request signed in here, for the machine's audit.
func originAuth(a authInfo) string {
	switch a.Kind {
	case authDevice:
		return "device"
	case authSession, authBasic:
		return "password"
	}
	return ""
}

// machinePathClass is the first segment of rest, for logs: never an id or
// a file name.
func machinePathClass(rest string) string {
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		return rest[:i]
	}
	return rest
}
