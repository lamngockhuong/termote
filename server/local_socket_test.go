package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// onLocalSocket makes req look as if it arrived on the local socket: the
// context mark localSocketConnContext sets, and the socket's fixed Host.
func onLocalSocket(req *http.Request) *http.Request {
	req.Host = localSocketHost
	req.Header.Del("Authorization")
	return req.WithContext(context.WithValue(req.Context(), localSocketKey{}, true))
}

// A request on the local socket is the CLI, signed in without the password;
// the same request over TCP gets nothing for its Host or its missing
// credentials.
func TestLocalSocketSignsInWithoutPassword(t *testing.T) {
	h, _ := newSigninServer(t, true)
	if rec := serve(h, onLocalSocket(apiRequest("GET", "/api/mux/signins", ""))); rec.Code != http.StatusOK {
		t.Fatalf("signins over the local socket: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, onLocalSocket(apiRequest("GET", "/api/mux/health", ""))); rec.Code != http.StatusOK {
		t.Fatalf("health over the local socket: %d %s", rec.Code, rec.Body)
	}

	// TCP with the socket's Host: refused by hostGuard, credentials or not.
	tcp := apiRequest("GET", "/api/mux/signins", "")
	tcp.Host = localSocketHost
	if rec := serve(h, tcp); rec.Code != http.StatusForbidden {
		t.Errorf("TCP request naming the socket's host: %d, want 403", rec.Code)
	}
	// TCP without credentials: still asked for them.
	anon := apiRequest("GET", "/api/mux/signins", "")
	anon.Header.Del("Authorization")
	if rec := serve(h, anon); rec.Code != http.StatusUnauthorized {
		t.Errorf("TCP request without credentials: %d, want 401", rec.Code)
	}
}

// --allow-host listing the socket's name does not open it to TCP.
func TestLocalSocketHostNotAllowedOverTCP(t *testing.T) {
	cfg := testConfig(t)
	cfg.AllowedHosts = localSocketHost
	h, err := newServeHandler(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	req := apiRequest("GET", "/api/mux/health", "")
	req.Host = localSocketHost
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("TCP with an allowed socket host: %d, want 403", rec.Code)
	}
}

// Revokes from the local socket are logged as the CLI's.
func TestLocalSocketAuditsAsCLI(t *testing.T) {
	buf := captureLog(t)
	h, _ := newSigninServer(t, true)
	signIn(t, h, "Browser A")
	rec := serve(h, onLocalSocket(apiRequest("DELETE", "/api/mux/signins", "")))
	if body := decodeBody(t, rec); rec.Code != http.StatusOK || body["revoked"] != float64(1) {
		t.Fatalf("revoke all over the local socket: %d %v", rec.Code, body)
	}
	if want := `by="password" via="cli"`; !strings.Contains(buf.String(), want) {
		t.Errorf("audit line missing %s:\n%s", want, buf.String())
	}
}

func TestIsCLI(t *testing.T) {
	for kind, want := range map[authKind]bool{authBasic: true, authLocal: true, authSession: false, authDevice: false} {
		if got := isCLI(authInfo{Kind: kind}); got != want {
			t.Errorf("isCLI(%d) = %v, want %v", kind, got, want)
		}
	}
}

func TestRequestIPLocalSocket(t *testing.T) {
	req := onLocalSocket(apiRequest("GET", "/", ""))
	req.RemoteAddr = "@"
	if got := requestIP(req); got != "local" {
		t.Errorf("requestIP over the local socket = %q, want local", got)
	}
}
