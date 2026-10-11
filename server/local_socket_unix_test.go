//go:build !windows

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// shortDir is a temp dir short enough for a socket path (t.TempDir's names
// grow with the test's).
func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "tl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

// headerLog serves the local socket for port in dir with a handler that
// records each request's Authorization and Host, answering health as ok.
type headerLog struct {
	mu    sync.Mutex
	auth  []string
	hosts []string
}

func (l *headerLog) serve(t *testing.T, dir string, port int) {
	t.Helper()
	ln, cleanup, err := openLocalSocket(dir, strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		l.mu.Lock()
		l.auth = append(l.auth, r.Header.Get("Authorization"))
		l.hosts = append(l.hosts, r.Host)
		l.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok","version":"9.9.9","backend":"fake","pid":42,"sessions":[]}`)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close(); cleanup() })
}

func TestOpenLocalSocketModes(t *testing.T) {
	dir := filepath.Join(shortDir(t), "run")
	ln, cleanup, err := openLocalSocket(dir, "7680")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	defer ln.Close()
	if fi, err := os.Lstat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("dir mode = %v (%v), want 0700", fi.Mode().Perm(), err)
	}
	fi, err := os.Lstat(filepath.Join(dir, "7680.sock"))
	if err != nil || fi.Mode().Type() != os.ModeSocket || fi.Mode().Perm() != 0o600 {
		t.Fatalf("socket = %v (%v), want a 0600 socket", fi.Mode(), err)
	}
	// A dir left wider than 0700 is tightened.
	ln.Close()
	cleanup()
	os.Chmod(dir, 0o755)
	ln2, cleanup2, err := openLocalSocket(dir, "7680")
	if err != nil {
		t.Fatal(err)
	}
	ln2.Close()
	cleanup2()
	if fi, _ := os.Lstat(dir); fi.Mode().Perm() != 0o700 {
		t.Errorf("dir mode after reopen = %v, want 0700", fi.Mode().Perm())
	}
}

func TestOpenLocalSocketRefusals(t *testing.T) {
	base := shortDir(t)
	// Too long for sun_path: nothing is made.
	long := filepath.Join(base, strings.Repeat("d", 120))
	if _, _, err := openLocalSocket(long, "7680"); err == nil {
		t.Error("a path past sun_path was opened")
	}
	if _, err := os.Lstat(long); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("too long: the dir was made (%v)", err)
	}
	// A symlinked dir is refused.
	real := filepath.Join(base, "real")
	os.Mkdir(real, 0o700)
	link := filepath.Join(base, "link")
	os.Symlink(real, link)
	if _, _, err := openLocalSocket(link, "7680"); err == nil {
		t.Error("a symlinked dir was used")
	}
	// A dir of another user is refused.
	other := filepath.Join(base, "other")
	old := fileOwner
	fileOwner = func(os.FileInfo) (int, bool) { return os.Getuid() + 1, true }
	_, _, err := openLocalSocket(other, "7680")
	fileOwner = old
	if err == nil {
		t.Error("a dir of another user was used")
	}
	// A file that is not a socket is never removed.
	dir := filepath.Join(base, "run")
	os.Mkdir(dir, 0o700)
	plain := filepath.Join(dir, "7680.sock")
	os.WriteFile(plain, []byte("x"), 0o600)
	if _, _, err := openLocalSocket(dir, "7680"); err == nil {
		t.Error("a plain file at the socket path was replaced")
	}
	if b, _ := os.ReadFile(plain); string(b) != "x" {
		t.Error("the plain file was changed")
	}
}

// A socket a live server answers on is left to it; one left by a server
// that died is replaced.
func TestOpenLocalSocketBusyAndStale(t *testing.T) {
	dir := filepath.Join(shortDir(t), "run")
	ln, cleanup, err := openLocalSocket(dir, "7680")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	if _, _, err := openLocalSocket(dir, "7680"); !errors.Is(err, errLocalSocketBusy) {
		t.Fatalf("second server on a live socket: %v, want errLocalSocketBusy", err)
	}
	// Dies without its cleanup: the socket file stays.
	ln.Close()
	_ = cleanup
	if _, err := os.Lstat(filepath.Join(dir, "7680.sock")); err != nil {
		t.Fatalf("closing removed the socket: %v", err)
	}
	ln2, cleanup2, err := openLocalSocket(dir, "7680")
	if err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	ln2.Close()
	cleanup2()
}

// An update or restart: the old server, slow to shut down, runs its cleanup
// after the new one made its socket, which must stay.
func TestLocalSocketCleanupKeepsNewServersSocket(t *testing.T) {
	dir := filepath.Join(shortDir(t), "run")
	oldLn, oldCleanup, err := openLocalSocket(dir, "7680")
	if err != nil {
		t.Fatal(err)
	}
	oldLn.Close() // shutting down: no longer answers
	newLn, newCleanup, err := openLocalSocket(dir, "7680")
	if err != nil {
		t.Fatal(err)
	}
	defer newLn.Close()
	go func() {
		for {
			c, err := newLn.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	// Its socket can even take the old one's inode number (tmpfs reuses
	// them): the cleanup still leaves a socket a server answers on.
	oldCleanup()
	c, err := net.Dial("unix", filepath.Join(dir, "7680.sock"))
	if err != nil {
		t.Fatalf("the old server's cleanup removed the new socket: %v", err)
	}
	c.Close()
	newLn.Close()
	newCleanup()
	if _, err := os.Lstat(filepath.Join(dir, "7680.sock")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the new server's cleanup left its socket: %v", err)
	}
}

func TestDialLocalServerChecks(t *testing.T) {
	dir := filepath.Join(shortDir(t), "run")
	var l headerLog
	l.serve(t, dir, 7680)
	c, err := dialLocalServerOS(dir, 7680)
	if err != nil {
		t.Fatalf("own server: %v", err)
	}
	c.Close()

	// A server end of another user is never trusted.
	old := localPeerUID
	localPeerUID = func(*net.UnixConn) (int, error) { return os.Getuid() + 1, nil }
	_, err = dialLocalServerOS(dir, 7680)
	localPeerUID = old
	if !errors.Is(err, errLocalServerUntrusted) {
		t.Errorf("server of another user: %v, want errLocalServerUntrusted", err)
	}
	localPeerUID = func(*net.UnixConn) (int, error) { return 0, errors.New("no creds") }
	_, err = dialLocalServerOS(dir, 7680)
	localPeerUID = old
	if !errors.Is(err, errLocalServerUntrusted) {
		t.Errorf("unreadable peer credentials: %v, want errLocalServerUntrusted", err)
	}
	// Root (uid 0) is trusted.
	localPeerUID = func(*net.UnixConn) (int, error) { return 0, nil }
	c, err = dialLocalServerOS(dir, 7680)
	localPeerUID = old
	if err != nil {
		t.Errorf("root's server: %v", err)
	} else {
		c.Close()
	}

	// A dir others can enter is never used.
	os.Chmod(dir, 0o755)
	if _, err := dialLocalServerOS(dir, 7680); err == nil {
		t.Error("a 0755 dir was trusted")
	}
	os.Chmod(dir, 0o700)
	if _, err := dialLocalServerOS(dir, 1); err == nil {
		t.Error("dialled a port with no socket")
	}
	if _, err := dialLocalServerOS(filepath.Join(dir, strings.Repeat("d", 120)), 7680); err == nil {
		t.Error("dialled a path past sun_path")
	}
}

// socketCLI is a test CLI whose state dir is short enough for a socket.
func socketCLI(t *testing.T) (*testCLI, string) {
	t.Helper()
	tc := newTestCLI(t, "linux")
	state := shortDir(t)
	tc.env["XDG_STATE_HOME"] = state
	return tc, tc.localSocketDir()
}

// With the local socket, the CLI never sends the password; without one,
// it falls back to TCP with it.
func TestCLIUsesLocalSocket(t *testing.T) {
	tc, dir := socketCLI(t)
	var l headerLog
	l.serve(t, dir, 7680)
	h, code, via := tc.fetchHealthVia(7680, "admin", "secret")
	if code != http.StatusOK || via != transportSocket || h.Version != "9.9.9" {
		t.Fatalf("health over the socket: %d %s %+v", code, via, h)
	}
	if l.auth[0] != "" || l.hosts[0] != localSocketHost {
		t.Errorf("request over the socket: Authorization %q, Host %q", l.auth[0], l.hosts[0])
	}

	// A device call needs no saved password over the socket.
	var out struct{ Sessions []any }
	if err := tc.serverCall(deviceTarget{port: 7680, user: "admin"}, http.MethodGet, "/api/mux/signins", nil, &out, signinCallErrs); err != nil {
		t.Fatalf("serverCall over the socket without a password: %v", err)
	}
	if l.auth[len(l.auth)-1] != "" {
		t.Error("serverCall sent credentials over the socket")
	}
}

func TestCLIFallsBackToTCP(t *testing.T) {
	tc, dir := socketCLI(t)
	got := make(chan string, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Get("Authorization")
		w.Write([]byte(`{"status":"ok"}`))
	}))
	t.Cleanup(srv.Close)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	old := listenerOwnerOf
	listenerOwnerOf = func(int) listenerOwner { return listenerTrustedOwner }
	t.Cleanup(func() { listenerOwnerOf = old })

	// No socket at all (a server from before it, or the container).
	if _, code, via := tc.fetchHealthVia(port, "admin", "secret"); code != http.StatusOK || via != transportTCP {
		t.Fatalf("no socket: %d %s", code, via)
	}
	if a := <-got; a == "" {
		t.Error("TCP fallback sent no credentials")
	}
	// A socket whose server end is not trusted: nothing sent there.
	var l headerLog
	l.serve(t, dir, port)
	oldUID := localPeerUID
	localPeerUID = func(*net.UnixConn) (int, error) { return os.Getuid() + 1, nil }
	t.Cleanup(func() { localPeerUID = oldUID })
	if _, code, via := tc.fetchHealthVia(port, "admin", "secret"); code != http.StatusOK || via != transportTCP {
		t.Fatalf("untrusted socket: %d %s", code, via)
	}
	if len(l.auth) != 0 {
		t.Errorf("a request went to an untrusted socket: %v", l.auth)
	}
	// Without a password, a device call does not go over TCP.
	err := tc.serverCall(deviceTarget{port: port, user: "admin"}, http.MethodGet, "/api/mux/signins", nil, &struct{}{}, signinCallErrs)
	if err == nil || !strings.Contains(err.Error(), "no saved password") {
		t.Errorf("serverCall without a password or socket: %v", err)
	}
}

// The real server: a native config opens the socket, the CLI's status
// reaches it without the password and says so, and the socket goes once
// the server stops.
func TestRunServerLocalSocket(t *testing.T) {
	tc, dir := socketCLI(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	cfg := testConfig(t)
	cfg.LocalSocketDir = dir
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runServer(ctx, cfg, &fakeMux{snap: oneTabSnapshot()}, ln) }()
	sock := filepath.Join(dir, strconv.Itoa(port)+".sock")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Lstat(sock); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the server opened no local socket")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The saved password is wrong: only the socket can succeed.
	if _, code, via := tc.fetchHealthVia(port, "admin", "wrong"); code != http.StatusOK || via != transportSocket {
		t.Fatalf("health over the server's socket: %d %s", code, via)
	}
	var out struct{ Sessions []signinView }
	if err := tc.serverCall(deviceTarget{port: port, user: "admin", pass: "wrong"}, http.MethodGet, "/api/mux/signins", nil, &out, signinCallErrs); err != nil {
		t.Fatalf("signins over the server's socket: %v", err)
	}
	if err := tc.saveConfig(savedConfig{Port: port, Password: "wrong"}); err != nil {
		t.Fatal(err)
	}
	tc.stdout.Reset()
	tc.cmdStatus(nil)
	if !strings.Contains(tc.stdout.String(), "Via: socket") {
		t.Errorf("status does not say it went over the socket:\n%s", tc.stdout)
	}
	// Over a real TCP connection nothing makes a request authLocal: not
	// the socket's Host, not missing credentials.
	for host, want := range map[string]int{localSocketHost: http.StatusForbidden, "127.0.0.1": http.StatusUnauthorized} {
		req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/api/mux/signins", port), nil)
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("TCP with Host %s: %d, want %d", host, resp.StatusCode, want)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(sock); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("socket left after the server stopped: %v", err)
	}
}

// A server that cannot open its socket runs all the same.
func TestRunServerWithoutLocalSocket(t *testing.T) {
	buf := captureLog(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.LocalSocketDir = filepath.Join(shortDir(t), strings.Repeat("d", 120))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runServer(ctx, cfg, &fakeMux{snap: oneTabSnapshot()}, ln) }()
	port := ln.Addr().(*net.TCPAddr).Port
	// It serves over TCP all the same.
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/mux/health", port))
	if err != nil {
		t.Fatalf("server without its socket does not answer: %v", err)
	}
	resp.Body.Close()
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "local socket for the CLI not opened") {
		t.Errorf("no log line for the missing socket:\n%s", buf.String())
	}
}

// A socket that takes the connection but never answers: the CLI falls back
// to TCP instead of failing.
func TestCLISocketWithoutAnswerFallsBack(t *testing.T) {
	tc, dir := socketCLI(t)
	ln, cleanup, err := openLocalSocket(dir, "7681")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close(); cleanup() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	if _, code, via := tc.fetchHealthVia(7681, "admin", "secret"); via != transportTCP {
		t.Errorf("socket hung up: %d via %s, want tcp", code, via)
	}
}

// A write the socket took but never answered is not sent again over TCP:
// the server may have applied it (a second pairing code, a revoke reported
// as an unknown device).
func TestCLISocketWriteNotResentOverTCP(t *testing.T) {
	tc, dir := socketCLI(t)
	tcpHits := make(chan string, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tcpHits <- r.Method
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	old := listenerOwnerOf
	listenerOwnerOf = func(int) listenerOwner { return listenerTrustedOwner }
	t.Cleanup(func() { listenerOwnerOf = old })

	ln, cleanup, err := openLocalSocket(dir, strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close(); cleanup() })
	// Reads the whole request, then hangs up without an answer.
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			http.ReadRequest(bufio.NewReader(c))
			c.Close()
		}
	}()
	err = tc.serverCall(deviceTarget{port: port, user: "admin", pass: "secret"}, http.MethodDelete, "/api/mux/devices/abc", nil, &struct{}{}, deviceCallErrs)
	if err == nil || !strings.Contains(err.Error(), "did not answer over the local socket") {
		t.Errorf("unanswered write: %v", err)
	}
	if _, code, via := tc.localRequest(port, "admin", "secret", http.MethodPost, "/api/mux/devices/pair", []byte(`{}`)); code != socketNoAnswer || via != transportSocket {
		t.Errorf("localRequest unanswered write: %d %s", code, via)
	}
	select {
	case m := <-tcpHits:
		t.Errorf("the write was sent again over TCP (%s)", m)
	default:
	}
	// A read is sent again: it changes nothing.
	if _, code, via := tc.fetchHealthVia(port, "admin", "secret"); code != http.StatusOK || via != transportTCP {
		t.Errorf("unanswered read: %d %s, want TCP", code, via)
	}
}

// A symlinked socket dir is refused without changing what it points to.
func TestOpenLocalSocketSymlinkTargetUntouched(t *testing.T) {
	base := shortDir(t)
	target := filepath.Join(base, "target")
	os.Mkdir(target, 0o755)
	os.Chmod(target, 0o755)
	link := filepath.Join(base, "run")
	os.Symlink(target, link)
	if _, _, err := openLocalSocket(link, "7680"); err == nil {
		t.Fatal("a symlinked dir was used")
	}
	if fi, _ := os.Stat(target); fi.Mode().Perm() != 0o755 {
		t.Errorf("the symlink's target was chmod'ed to %v", fi.Mode().Perm())
	}
}
