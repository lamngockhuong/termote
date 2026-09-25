//go:build integration

package main

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// setupStreamTmux starts an isolated session: a private socket on Unix, a
// uniquely named session on Windows (psmux has no -S).
func setupStreamTmux(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSession = fmt.Sprintf("termote-stream-%d", os.Getpid())
	args := []string{"new-session", "-d", "-s", tmuxSession, "-x", "100", "-y", "30"}
	if runtime.GOOS != "windows" {
		tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
		args = append([]string{"-f", "/dev/null"}, args...)
	}
	if out, err := tmuxCmd(context.Background(), args...).CombinedOutput(); err != nil {
		t.Fatalf("new-session: %v %s", err, out)
	}
	t.Cleanup(func() {
		if runtime.GOOS == "windows" {
			tmuxCmd(context.Background(), "kill-session", "-t", tmuxSession).Run()
		} else {
			tmuxCmd(context.Background(), "kill-server").Run()
		}
		tmuxSocket, tmuxSession = origSocket, origSession
	})
}

func tmuxQuery(t *testing.T, format string) string {
	t.Helper()
	out, err := tmuxCmd(context.Background(), "display-message", "-p", "-t", tmuxSession, format).Output()
	if err != nil {
		t.Fatalf("display-message: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func waitTmux(t *testing.T, format, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		got := tmuxQuery(t, format)
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s = %q, want %q", format, got, want)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// TestIntegrationStreamTmux drives a real tmux/psmux session through the full
// handler chain, the way websocat or the PWA would.
func TestIntegrationStreamTmux(t *testing.T) {
	setupStreamTmux(t)
	h, hub, err := buildServer(testConfig(t), tmuxMux{})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	defer hub.shutdown(context.Background())

	hdr := authHeader()
	hdr.Set("Origin", srv.URL)
	c, _, err := dialStream(t, srv.URL, "pane=0&cols=100&rows=30&token="+fetchToken(t, srv.URL, true), hdr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	out := newOutputReader(wsReader{c})
	waitTmux(t, "#{session_attached}", "1")

	ctx := context.Background()
	// Split the marker so the echoed command line cannot match it.
	c.Write(ctx, websocket.MessageBinary, []byte("echo stream-\"ok\"\r"))
	out.waitFor(t, `stream-ok`)

	c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":120,"rows":40}`))
	// One row is the status line.
	waitTmux(t, "#{window_width}x#{window_height}", "120x39")

	c.Close(websocket.StatusNormalClosure, "")
	waitTmux(t, "#{session_attached}", "0")
}
