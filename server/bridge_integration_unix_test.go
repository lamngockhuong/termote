//go:build !windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// bridgeTestServer runs a real server, sign-in on, with its local socket and
// bridge in a short dir, and returns that dir and its port.
func bridgeTestServer(t *testing.T) (string, int) {
	t.Helper()
	dir := filepath.Join(shortDir(t), "run")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.LocalSocketDir = dir
	// A backend that can watch a pane: the stream of a view role.
	m := &viewMux{fakeMux: &fakeMux{snap: oneTabSnapshot()}, canView: true, attached: make(chan string, 16)}
	m.attach = func(string, Size) (TermStream, error) { return newFakeTerm(), nil }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runServer(ctx, cfg, m, ln) }()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	port := ln.Addr().(*net.TCPAddr).Port
	sock := filepath.Join(dir, bridgeSocketName(strconv.Itoa(port))+".sock")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if fi, err := os.Lstat(sock); err == nil && fi.Mode().Type() == os.ModeSocket {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the bridge socket %s never appeared", sock)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return dir, port
}

// bufConn reads what a bufio.Reader already took from the connection first.
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// runBridge runs `termote bridge --socket-dir dir` for a CLI whose saved
// config names port, on a pipe, and returns the other termote's end once it
// read the greeting.
func runBridge(t *testing.T, dir string, port int) net.Conn {
	t.Helper()
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	mine, theirs := net.Pipe()
	tc.in = bufio.NewReader(theirs)
	tc.out = theirs
	go func() {
		tc.cmdBridge([]string{"--socket-dir", dir})
		theirs.Close()
	}()
	rd := bufio.NewReader(mine)
	line, err := rd.ReadString('\n')
	if err != nil || !strings.HasPrefix(line, bridgeGreeting) {
		t.Fatalf("greeting %q, %v", line, err)
	}
	return &bufConn{Conn: mine, r: rd}
}

// bridgeClient is an HTTP client whose every connection is a new bridge.
func bridgeClient(t *testing.T, dir string, port int) *http.Client {
	var mu sync.Mutex
	var conns []net.Conn
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			c.Close()
		}
	})
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			c := runBridge(t, dir, port)
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
			return c, nil
		},
	}}
}

func bridgeDo(t *testing.T, cl *http.Client, method, path, role, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, "http://"+localSocketHost+path, strings.NewReader(body))
	if role != "" {
		req.Header.Set(bridgeRoleHeader, role)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := cl.Do(req)
	if err != nil {
		t.Fatalf("%s %s over the bridge: %v", method, path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// Through `termote bridge`, another termote reads the snapshot, is held to
// the role it sends, never reaches the CLI's routes, and opens a terminal
// stream with a token it fetched the same way.
func TestBridgeEndToEnd(t *testing.T) {
	dir, port := bridgeTestServer(t)
	cl := bridgeClient(t, dir, port)

	if code, body := bridgeDo(t, cl, "GET", "/api/mux/snapshot", "view", ""); code != http.StatusOK || body["groups"] == nil {
		t.Fatalf("snapshot over the bridge: %d %v", code, body)
	}
	if code, body := bridgeDo(t, cl, "POST", "/api/mux/tabs", "view", `{"groupId":"g"}`); code != http.StatusForbidden || body["code"] != "view_only" {
		t.Errorf("write as view over the bridge: %d %v", code, body)
	}
	if code, body := bridgeDo(t, cl, "POST", "/api/mux/login-links", "full", `{}`); code != http.StatusForbidden || body["code"] != "machine_forbidden" {
		t.Errorf("login-links over the bridge: %d %v", code, body)
	}

	code, body := bridgeDo(t, cl, "GET", "/api/mux/stream-token", "view", "")
	token, _ := body["token"].(string)
	if code != http.StatusOK || token == "" {
		t.Fatalf("stream-token over the bridge: %d %v", code, body)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws://"+localSocketHost+"/api/mux/stream?pane=0&token="+token, &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: &http.Transport{
			DialContext: func(context.Context, string, string) (net.Conn, error) { return runBridge(t, dir, port), nil },
		}},
	})
	if err != nil {
		t.Fatalf("stream over the bridge: %v", err)
	}
	ws.CloseNow()
}

// The CLI's local socket and the bridge are two sockets: the CLI's still
// signs in as the CLI, the bridge never does.
func TestBridgeSocketBesideLocalSocket(t *testing.T) {
	dir, port := bridgeTestServer(t)
	for _, name := range []string{strconv.Itoa(port), bridgeSocketName(strconv.Itoa(port))} {
		fi, err := os.Lstat(filepath.Join(dir, name+".sock"))
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("socket %s: %v %v", name, fi, err)
		}
	}
	c, err := dialBridgeServer(dir, port)
	if err != nil {
		t.Fatalf("dial bridge: %v", err)
	}
	c.Close()
}
