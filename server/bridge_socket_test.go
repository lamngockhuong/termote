package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// onBridge makes req look as if another termote sent it over the machine
// bridge: the context mark localSocketConnContext sets, the socket's fixed
// Host, no credentials and none of a browser's headers.
func onBridge(req *http.Request) *http.Request {
	req.Host = localSocketHost
	for _, h := range []string{"Authorization", "Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"} {
		req.Header.Del(h)
	}
	return req.WithContext(context.WithValue(req.Context(), bridgeKey{}, true))
}

// withBridgeRole sets the role header the other termote sends.
func withBridgeRole(req *http.Request, r string) *http.Request {
	req.Header.Set(bridgeRoleHeader, r)
	return req
}

// newBridgeServer is a server with devices, push, templates and sign-in on
// (or off with noAuth).
func newBridgeServer(t *testing.T, noAuth bool) http.Handler {
	t.Helper()
	cfg := testConfig(t)
	cfg.NoAuth = noAuth
	cfg.DevicesDir = filepath.Join(t.TempDir(), "devices")
	cfg.PushDir = filepath.Join(t.TempDir(), "push")
	cfg.TemplatesDir = filepath.Join(t.TempDir(), "templates")
	h, err := newServeHandler(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// Another termote never pairs, revokes, signs in or out, makes a sign-in
// link or subscribes to Web Push here, whatever role it sends and whether
// this server signs in or not.
func TestBridgeForbidsPasswordOnlyRoutes(t *testing.T) {
	routes := []struct{ method, path string }{
		{"POST", "/api/mux/devices/pair"},
		{"GET", "/api/mux/devices"},
		{"DELETE", "/api/mux/devices/abc"},
		{"GET", "/api/mux/signins"},
		{"DELETE", "/api/mux/signins"},
		{"DELETE", "/api/mux/signins/abc"},
		{"GET", "/api/mux/push/key"},
		{"POST", "/api/mux/push/subscribe"},
		{"DELETE", "/api/mux/push/subscribe"},
		{"POST", "/api/mux/login-links"},
		{"POST", "/api/mux/logout"},
		{"POST", "/login"},
		{"GET", "/pair"},
		{"POST", "/login/link"},
		{"GET", "/api/mux/devices/../devices"},
	}
	for _, noAuth := range []bool{false, true} {
		h := newBridgeServer(t, noAuth)
		for _, rt := range routes {
			for _, r := range []string{"full", "view", ""} {
				req := onBridge(apiRequest(rt.method, rt.path, `{}`))
				if r != "" {
					withBridgeRole(req, r)
				}
				rec := serve(h, req)
				if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"machine_forbidden"`) {
					t.Errorf("noAuth=%v %s %s as %q over the bridge: %d %s", noAuth, rt.method, rt.path, r, rec.Code, rec.Body)
				}
			}
		}
	}
}

// The role comes from X-Termote-Role: view without it, an unknown value
// refused, and a view request cannot write; with --no-auth on this server
// too.
func TestBridgeRoleHeader(t *testing.T) {
	for _, noAuth := range []bool{false, true} {
		h := newBridgeServer(t, noAuth)
		write := func(r string) *http.Request {
			req := onBridge(apiRequest("POST", "/api/mux/templates", `{"name":"n`+r+`","text":"t"}`))
			if r != "" {
				withBridgeRole(req, r)
			}
			return req
		}
		if rec := serve(h, write("")); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "view_only") {
			t.Errorf("noAuth=%v write without a role: %d %s, want view_only", noAuth, rec.Code, rec.Body)
		}
		if rec := serve(h, write("view")); rec.Code != http.StatusForbidden {
			t.Errorf("noAuth=%v write as view: %d %s", noAuth, rec.Code, rec.Body)
		}
		if rec := serve(h, write("full")); rec.Code/100 != 2 {
			t.Errorf("noAuth=%v write as full: %d %s", noAuth, rec.Code, rec.Body)
		}
		if rec := serve(h, write("admin")); rec.Code != http.StatusBadRequest {
			t.Errorf("noAuth=%v unknown role: %d, want 400", noAuth, rec.Code)
		}
		if rec := serve(h, onBridge(apiRequest("GET", "/api/mux/snapshot", ""))); rec.Code != http.StatusOK {
			t.Errorf("noAuth=%v snapshot as view: %d %s", noAuth, rec.Code, rec.Body)
		}
	}
}

// Over TCP the role header means nothing: the password still signs the
// request in as full, and without credentials it is asked for them.
func TestBridgeRoleHeaderIgnoredOverTCP(t *testing.T) {
	h := newBridgeServer(t, false)
	req := withBridgeRole(apiRequest("POST", "/api/mux/templates", `{"name":"n","text":"t"}`), "view")
	if rec := serve(h, req); rec.Code/100 != 2 {
		t.Errorf("TCP write with a view header and the password: %d %s", rec.Code, rec.Body)
	}
	anon := withBridgeRole(apiRequest("GET", "/api/mux/snapshot", ""), "full")
	anon.Header.Del("Authorization")
	if rec := serve(h, anon); rec.Code != http.StatusUnauthorized {
		t.Errorf("TCP read with a full header, no credentials: %d, want 401", rec.Code)
	}
}

// The bridge is never the CLI: login-links, which only the CLI may make, is
// refused, and isCLI is false for authMachine.
func TestAuthMachineIsNotCLI(t *testing.T) {
	if isCLI(authInfo{Kind: authMachine, Role: roleFull}) {
		t.Error("authMachine counts as the CLI")
	}
}

// The socket's fixed Host passes hostGuard on the bridge, as on the local
// socket, and not over TCP.
func TestBridgeHostGuard(t *testing.T) {
	h := newBridgeServer(t, false)
	if rec := serve(h, onBridge(apiRequest("GET", "/api/mux/health", ""))); rec.Code != http.StatusOK {
		t.Errorf("health over the bridge: %d %s", rec.Code, rec.Body)
	}
	tcp := apiRequest("GET", "/api/mux/health", "")
	tcp.Host = localSocketHost
	if rec := serve(h, tcp); rec.Code != http.StatusForbidden {
		t.Errorf("TCP naming the socket's host: %d, want 403", rec.Code)
	}
}

// Audit lines name another termote: ip=machine, by=machine, and how the
// request signed in there.
func TestBridgeAuditNames(t *testing.T) {
	req := onBridge(apiRequest("GET", "/", ""))
	if got := requestIP(req); got != "machine" {
		t.Errorf("requestIP over the bridge = %q", got)
	}
	a := authInfo{Kind: authMachine, Role: roleView, OriginAuth: "device"}
	if got := auditBy(a); got != "machine" {
		t.Errorf("auditBy(machine) = %q", got)
	}
	by, via := auditWho(req.WithContext(withAuth(req.Context(), a)))
	if by != "machine" || via != "machine:device" {
		t.Errorf("auditWho = %q %q", by, via)
	}
	a.OriginAuth = ""
	if _, via := auditWho(req.WithContext(withAuth(req.Context(), a))); via != "machine" {
		t.Errorf("auditWho without origin = %q", via)
	}
}

// Only the origin values the other termote may send are kept.
func TestBridgeOriginAuthHeader(t *testing.T) {
	var got authInfo
	h := bridgeAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = authFrom(r.Context())
	}), http.NotFoundHandler())
	for v, want := range map[string]string{"password": "password", "device": "device", "cli": "", "": ""} {
		req := onBridge(apiRequest("GET", "/api/mux/snapshot", ""))
		req.Header.Set(bridgeOriginAuthHeader, v)
		serve(h, req)
		if got.Kind != authMachine || got.OriginAuth != want {
			t.Errorf("origin %q: %+v, want %q", v, got, want)
		}
	}
}

// Only a connection the bridge's listener accepted is marked as the bridge,
// and never as the CLI's local socket.
func TestBridgeConnContext(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	ctx := localSocketConnContext(context.Background(), &bridgeConn{a})
	if !isBridge(ctx) || isLocalSocket(ctx) {
		t.Errorf("bridge conn: bridge %v, local %v", isBridge(ctx), isLocalSocket(ctx))
	}
	ctx = localSocketConnContext(context.Background(), &localSocketConn{a})
	if isBridge(ctx) {
		t.Error("a local socket connection was marked as the bridge")
	}
	if isBridge(localSocketConnContext(context.Background(), a)) {
		t.Error("a plain connection was marked as the bridge")
	}
}

type failListener struct{ net.Listener }

func (failListener) Accept() (net.Conn, error) { return nil, errors.New("accept failed") }

func TestBridgeListenerAccept(t *testing.T) {
	if _, err := (bridgeListener{failListener{}}).Accept(); err == nil {
		t.Error("an accept error was swallowed")
	}
}

func TestBridgeSocketName(t *testing.T) {
	want := "7680.bridge"
	if runtime.GOOS == "windows" {
		want = "7680-bridge"
	}
	if got := bridgeSocketName("7680"); got != want {
		t.Errorf("bridgeSocketName = %q, want %q", got, want)
	}
}

func TestMachineForbiddenPath(t *testing.T) {
	for p, want := range map[string]bool{
		"/api/mux/devices":      true,
		"/api/mux/devicesx":     false,
		"/api/mux/push":         true,
		"/api/mux/pushed":       false,
		"/api/mux/signins/x":    true,
		"/api/mux/snapshot":     false,
		"/api/mux/stream-token": false,
	} {
		if got := machineForbiddenPath(p); got != want {
			t.Errorf("machineForbiddenPath(%q) = %v", p, got)
		}
	}
}
