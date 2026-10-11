package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The CLI's pairing over the local socket is a full code: a paired device
// may not make one, the password and the CLI may.
func TestLocalSocketPairsFullDevice(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	makePairCode(t, h, `{"role":"view"}`) // unrelated code, keeps the server busy
	rec := serve(h, onLocalSocket(apiRequest("POST", "/api/mux/devices/pair", `{"role":"full","name":"Laptop"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("full code over the local socket: %d %s", rec.Code, rec.Body)
	}
}

// Revoking a device from the local socket is logged as the CLI's, by the
// password, like a revoke with Basic auth.
func TestLocalSocketRevokesDeviceAsCLI(t *testing.T) {
	logs := captureLog(t)
	h, _, _, _ := newDeviceServer(t)
	pairWith(t, h, apiRequest("POST", "/api/mux/devices/pair", `{"role":"view","name":"Phone"}`))
	id := deviceIDOf(t, h, "Phone")
	rec := serve(h, onLocalSocket(apiRequest("DELETE", "/api/mux/devices/"+id, "")))
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke over the local socket: %d %s", rec.Code, rec.Body)
	}
	if want := `by="password" via="cli"`; !strings.Contains(logs.String(), want) {
		t.Errorf("audit line missing %s:\n%s", want, logs.String())
	}
}

// Only what the server's listener marked is local: a plain connection, the
// kind TCP gives, never is.
func TestLocalSocketConnContextMarksOnlySocketConns(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	if isLocalSocket(localSocketConnContext(context.Background(), a)) {
		t.Error("a plain connection was marked as the local socket")
	}
	if !isLocalSocket(localSocketConnContext(context.Background(), &localSocketConn{a})) {
		t.Error("a local socket connection was not marked")
	}
}

// The socket's directory comes from the saved config only: the environment
// cannot point the server at another socket, and a container (no saved
// config) opens none.
func TestServeConfigLocalSocketDirFromSavedConfig(t *testing.T) {
	tc := newTestCLI(t, "linux")
	state := t.TempDir()
	tc.env["XDG_STATE_HOME"] = state
	t.Setenv("TERMOTE_LOCAL_SOCKET_DIR", "/tmp/elsewhere")
	tc.saveConfig(savedConfig{Password: "pw"})
	cfg, err := tc.loadServeConfig()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(state, "termote", "run"); cfg.LocalSocketDir != want {
		t.Errorf("LocalSocketDir = %q, want %q", cfg.LocalSocketDir, want)
	}
	os.Remove(tc.configFile())
	if cfg, _ = tc.loadServeConfig(); cfg.LocalSocketDir != "" {
		t.Errorf("container config opened a socket dir: %q", cfg.LocalSocketDir)
	}
}

// status --json names how the CLI reached the server, and nothing when no
// server answered.
func TestStatusJSONViaTCPAndNotRunning(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.env["XDG_STATE_HOME"] = t.TempDir()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	restore := trustAllListeners(t)
	defer restore()

	var r statusReport
	tc.stdout.Reset()
	tc.printStatusJSON(port)
	if err := json.Unmarshal(tc.stdout.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if r.Via != "tcp" {
		t.Errorf("status --json via = %q, want tcp", r.Via)
	}
	if !strings.Contains(tc.stdout.String(), `"via"`) {
		t.Error("status --json omits via when a server answered")
	}

	// Nothing listens: no via at all.
	dead := deadPort(t)
	tc.stdout.Reset()
	tc.printStatusJSON(dead)
	if strings.Contains(tc.stdout.String(), `"via"`) {
		t.Errorf("status --json names a transport with no server:\n%s", tc.stdout)
	}
}

// Over TCP, status says so in its text output.
func TestStatusPrintsViaTCP(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.env["XDG_STATE_HOME"] = t.TempDir()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	restore := trustAllListeners(t)
	defer restore()
	tc.cmdStatus([]string{"--port", strconv.Itoa(port)})
	if !strings.Contains(tc.stdout.String(), "Via: TCP") {
		t.Errorf("status over TCP does not say so:\n%s", tc.stdout)
	}
	if strings.Contains(tc.stdout.String(), "Via: socket") {
		t.Errorf("status over TCP claims the socket:\n%s", tc.stdout)
	}
}

// trustAllListeners makes every port's listener look like the current
// user's, so the CLI's TCP checks pass against an httptest server.
func trustAllListeners(t *testing.T) func() {
	t.Helper()
	old := listenerOwnerOf
	listenerOwnerOf = func(int) listenerOwner { return listenerTrustedOwner }
	return func() { listenerOwnerOf = old }
}

// deadPort is a loopback port nothing listens on.
func deadPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}
