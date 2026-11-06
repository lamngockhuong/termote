package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
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
	case errors.Is(err, errMachineUnauthorized):
		return &codedError{code: "machine_unauthorized", msg: "the machine refused this server's key", status: http.StatusBadGateway}
	case errors.Is(err, errMachineIncompatible), errors.Is(err, errMachineHostKey):
		// A changed host key is never connected to: to a client it is a
		// machine that cannot be used until the CLI fixes it.
		code := "machine_incompatible"
		if errors.Is(err, errMachineHostKey) {
			code = "machine_unauthorized"
		}
		return &codedError{code: code, msg: "the machine cannot be used (see termote machine status)", status: http.StatusBadGateway}
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

func registerMachineProxy(mux *http.ServeMux, agent *agentAPI, fwd *streamHub, allowed hostAllowlist, proxyHeader string) {
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
				resp.Header.Del("Set-Cookie")
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
