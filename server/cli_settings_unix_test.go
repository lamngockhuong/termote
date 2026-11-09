//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// startSettingsServer runs the real server with cfg on a free port, its
// local socket in dir, until the test ends.
func startSettingsServer(t *testing.T, dir string, cfg serveConfig) (int, *agentAPI) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	cfg.LocalSocketDir = dir
	h, hub, _, agent, err := buildServerWith(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h, ConnContext: localSocketConnContext}
	go srv.Serve(ln)
	cleanup := serveLocalSocket(srv, cfg, ln)
	t.Cleanup(func() { srv.Close(); cleanup(); hub.shutdown(context.Background()) })
	sock := filepath.Join(dir, strconv.Itoa(port)+".sock")
	for deadline := time.Now().Add(5 * time.Second); ; {
		if _, err := os.Lstat(sock); err == nil {
			return port, agent
		}
		if time.Now().After(deadline) {
			t.Fatal("no local socket")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The proposal goes over the local socket, with or without sign-in, and
// the server keeps it.
func TestSettingsProposeOverLocalSocket(t *testing.T) {
	for _, noAuth := range []bool{false, true} {
		tc, dir := socketCLI(t)
		cfg := testConfig(t)
		if noAuth {
			cfg.NoAuth, cfg.Pass = true, ""
		}
		port, agent := startSettingsServer(t, dir, cfg)
		tc.saveConfig(savedConfig{Port: port, Password: cfg.Pass, NoAuth: noAuth})
		if err := tc.dispatch("settings", []string{"propose", `{"editorVim":true,"theme":"dark"}`}); err != nil {
			t.Fatalf("noAuth=%v: %v (%s)", noAuth, err, tc.stderr)
		}
		p := agent.settings.get()
		if p == nil || string(p.Values["theme"]) != `"dark"` {
			t.Fatalf("noAuth=%v: kept %+v", noAuth, p)
		}
		out := tc.stdout.String()
		if !strings.Contains(out, "Proposed 2 changes (id "+p.ID+")") || !strings.Contains(out, "open termote") {
			t.Errorf("noAuth=%v: stdout %s", noAuth, out)
		}
	}
}

func TestSettingsProposeServerNotRunning(t *testing.T) {
	tc, _ := socketCLI(t)
	tc.saveConfig(savedConfig{Port: 7999, Password: "secret"})
	if err := tc.dispatch("settings", []string{"propose", `{"editorVim":true}`}); err == nil || !strings.Contains(err.Error(), "not running on port 7999") {
		t.Errorf("err = %v", err)
	}
}

// serveSettingsAnswer serves the local socket for port with one fixed
// answer to every request.
func serveSettingsAnswer(t *testing.T, dir string, port, status int, body string) {
	t.Helper()
	ln, cleanup, err := openLocalSocket(dir, strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if status == 0 {
			// Read the request, then drop the connection unanswered.
			conn, _, _ := http.NewResponseController(w).Hijack()
			conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close(); cleanup() })
}

func TestSettingsProposeAnswers(t *testing.T) {
	for i, c := range []struct {
		status int
		body   string
		want   string
		exit1  bool
	}{
		{403, `{"code":"cli_only","error":"x"}`, "only from the termote CLI", false},
		{404, `{"error":"not found"}`, "termote update", false},
		{400, `{"code":"invalid_settings","problems":[{"key":"theme","reason":"bad‮"},{"key":"","reason":"all of it"}]}`, "theme: bad", true},
		{500, `{"error":"mux command failed\u001b[2J"}`, "the server refused: mux command failed[2J", false},
		{502, `nope`, "the server answered HTTP 502", false},
		{200, `{}`, "the server answered HTTP 200", false},
		{0, ``, "may have been made", false},
	} {
		tc, dir := socketCLI(t)
		port := 7600 + i
		tc.saveConfig(savedConfig{Port: port, Password: "secret"})
		serveSettingsAnswer(t, dir, port, c.status, c.body)
		err := tc.dispatch("settings", []string{"propose", `{"editorVim":true}`})
		var ee *exitError
		switch {
		case c.exit1:
			if !errors.As(err, &ee) || ee.code != 1 || !strings.Contains(tc.stderr.String(), c.want) || !strings.Contains(tc.stderr.String(), "[ERROR] all of it") || strings.Contains(tc.stderr.String(), "‮") {
				t.Errorf("%d: %v %s", c.status, err, tc.stderr)
			}
		case err == nil || !strings.Contains(err.Error(), c.want):
			t.Errorf("%d: err = %v, want %q", c.status, err, c.want)
		}
	}
	// An expiry the CLI cannot read is printed as it came.
	tc, dir := socketCLI(t)
	tc.saveConfig(savedConfig{Port: 7650, Password: "secret"})
	serveSettingsAnswer(t, dir, 7650, 200, `{"id":"0123456789abcdef","count":1,"expiresAt":"soon"}`)
	if err := tc.dispatch("settings", []string{"propose", `{"editorVim":true}`}); err != nil || !strings.Contains(tc.stdout.String(), "Proposed 1 change (id 0123456789abcdef), waiting until soon") {
		t.Errorf("%v %s", err, tc.stdout)
	}
}
