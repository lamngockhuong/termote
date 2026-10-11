package main

import (
	"errors"
	"net/http"
	"strconv"
	"testing"

	"golang.org/x/sys/windows"
)

// The pipe takes the CLI's request without the password, a second server
// on the port cannot take the name, and a pipe served by another user is
// never used.
func TestLocalPipe(t *testing.T) {
	const port = 47913
	ln, cleanup, err := openLocalSocket("", strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Host != localSocketHost {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		w.Write([]byte(`{"status":"ok","version":"9.9.9"}`))
	})}
	go srv.Serve(ln)
	defer srv.Close()

	if _, _, err := openLocalSocket("", strconv.Itoa(port)); err == nil {
		t.Error("a second pipe of the same name was created")
	}
	c, err := dialLocalServerOS("", port)
	if err != nil {
		t.Fatalf("own pipe: %v", err)
	}
	c.Close()
	tc := newTestCLI(t, "windows")
	if h, code, via := tc.fetchHealthVia(port, "admin", "secret"); code != http.StatusOK || via != transportSocket || h.Version != "9.9.9" {
		t.Fatalf("health over the pipe: %d %s %+v", code, via, h)
	}

	old := pipeServerTrusted
	pipeServerTrusted = func(windows.Handle) bool { return false }
	defer func() { pipeServerTrusted = old }()
	if _, err := dialLocalServerOS("", port); !errors.Is(err, errLocalServerUntrusted) {
		t.Errorf("pipe of another user: %v, want errLocalServerUntrusted", err)
	}
}
