//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The socket's dir cannot be made when a file sits where it goes: nothing
// is listened on.
func TestOpenLocalSocketDirUnmakeable(t *testing.T) {
	base := shortDir(t)
	file := filepath.Join(base, "file")
	os.WriteFile(file, []byte("x"), 0o600)
	if _, _, err := openLocalSocket(filepath.Join(file, "run"), "7680"); err == nil {
		t.Fatal("a socket dir under a regular file was opened")
	}
}

// status reports "socket" when the local socket answered, sending no
// password.
func TestStatusViaSocket(t *testing.T) {
	tc, dir := socketCLI(t)
	var l headerLog
	l.serve(t, dir, 7680)
	tc.stdout.Reset()
	if err := tc.printStatusJSON(7680); err != nil {
		t.Fatalf("status --json over the socket: %v", err)
	}
	var r statusReport
	if err := json.Unmarshal(tc.stdout.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if r.Via != transportSocket || !r.Running {
		t.Errorf("status --json = via %q running %v, want socket and running", r.Via, r.Running)
	}
	if len(l.auth) == 0 || l.auth[0] != "" {
		t.Errorf("status over the socket sent credentials: %v", l.auth)
	}
	tc.stdout.Reset()
	tc.cmdStatus([]string{"--port", "7680"})
	if !strings.Contains(tc.stdout.String(), "Via: socket (no password sent)") {
		t.Errorf("status text over the socket:\n%s", tc.stdout)
	}
}

// A server whose listener cannot serve returns the error, and the socket it
// opened for the CLI is removed on the way out.
func TestRunServerRemovesSocketOnServeError(t *testing.T) {
	_, dir := socketCLI(t)
	buf := captureLog(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	cfg := testConfig(t)
	cfg.LocalSocketDir = dir
	if err := runServer(context.Background(), cfg, &fakeMux{snap: oneTabSnapshot()}, ln); err == nil {
		t.Fatal("serving a closed listener returned no error")
	}
	if !strings.Contains(buf.String(), "local socket for the CLI: ") {
		t.Fatalf("the socket was never opened, so the check is vacuous:\n%s", buf.String())
	}
	if _, err := os.Lstat(filepath.Join(dir, strconv.Itoa(port)+".sock")); !os.IsNotExist(err) {
		t.Errorf("socket left after serve failed: %v", err)
	}
}
