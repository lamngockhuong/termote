package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// helperEnv selects a helper mode when the test binary re-executes itself as
// a terminal process or as a server.
const helperEnv = "TERMOTE_TEST_HELPER"

func TestMain(m *testing.M) {
	switch os.Getenv(helperEnv) {
	case "":
		os.Exit(m.Run())
	case "tree":
		helperTree()
	case "sleep":
		time.Sleep(5 * time.Minute)
	case "serve":
		helperServe()
	case "herdr-observe":
		helperHerdrObserve()
	case "serve-herdr":
		helperServeHerdr()
	}
	os.Exit(0)
}

// helperTree starts a grandchild, prints both PIDs, then answers commands on
// stdin: "size" prints the terminal size, "exit N" exits with code N, any
// other line is echoed.
func helperTree() {
	self, _ := os.Executable()
	gc := exec.Command(self)
	gc.Env = append(os.Environ(), helperEnv+"=sleep")
	if err := gc.Start(); err != nil {
		fmt.Println("ERR", err)
		os.Exit(1)
	}
	fmt.Printf("PIDS=%d,%d\n", os.Getpid(), gc.Process.Pid)
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case line == "size":
			cols, rows := helperTermSize()
			fmt.Printf("SIZE=%dx%d\n", cols, rows)
		case strings.HasPrefix(line, "exit "):
			code, _ := strconv.Atoi(strings.TrimPrefix(line, "exit "))
			os.Exit(code)
		default:
			fmt.Printf("ECHO:%s\n", line)
		}
	}
	time.Sleep(5 * time.Minute)
}

// helperServe runs the real server with a backend whose single pane runs
// helperTree, and prints its address.
func helperServe() {
	os.Setenv(helperEnv, "tree")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Println("ERR", err)
		os.Exit(1)
	}
	fmt.Printf("ADDR=%s\n", ln.Addr())
	cfg := serveConfig{PWADir: os.TempDir(), NoAuth: true}
	ctx, stop := signalContext()
	defer stop()
	if err := runServer(ctx, cfg, helperMux(), ln); err != nil {
		fmt.Println("ERR", err)
		os.Exit(1)
	}
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

func helperMux() *fakeMux {
	self, _ := os.Executable()
	return &fakeMux{
		snap:   oneTabSnapshot(),
		attach: func(_ string, size Size) (TermStream, error) { return startTerminal([]string{self}, size) },
	}
}

func oneTabSnapshot() Snapshot {
	return Snapshot{Groups: []Group{{ID: "main", Name: "main", Tabs: []Tab{
		{ID: "0", Name: "shell", Active: true, Panes: []Pane{{ID: "0", Active: true}}},
	}}}}
}

// fakeTerm is an in-memory TermStream for protocol tests.
type fakeTerm struct {
	out       chan []byte
	mu        sync.Mutex
	in        []byte
	inCh      chan struct{}
	sizes     []Size
	done      chan struct{}
	code      int
	closed    chan struct{}
	closeOnce sync.Once
}

func newFakeTerm() *fakeTerm {
	return &fakeTerm{
		out:    make(chan []byte, 16),
		inCh:   make(chan struct{}, 64),
		done:   make(chan struct{}),
		closed: make(chan struct{}),
	}
}

func (f *fakeTerm) Read(p []byte) (int, error) {
	select {
	case b := <-f.out:
		return copy(p, b), nil
	case <-f.closed:
		return 0, io.EOF
	}
}

func (f *fakeTerm) Write(p []byte) (int, error) {
	f.mu.Lock()
	f.in = append(f.in, p...)
	f.mu.Unlock()
	f.inCh <- struct{}{}
	return len(p), nil
}

func (f *fakeTerm) Resize(s Size) error {
	f.mu.Lock()
	f.sizes = append(f.sizes, s)
	f.mu.Unlock()
	f.inCh <- struct{}{}
	return nil
}

func (f *fakeTerm) Done() <-chan struct{} { return f.done }
func (f *fakeTerm) ExitCode() int         { return f.code }
func (f *fakeTerm) Close() error {
	f.closeOnce.Do(func() { close(f.closed) })
	return nil
}

func (f *fakeTerm) isClosed() bool {
	select {
	case <-f.closed:
		return true
	default:
		return false
	}
}

// streamServer runs the full handler chain behind a real listener.
type streamServer struct {
	*httptest.Server
	hub    *streamHub
	mu     sync.Mutex
	terms  []*fakeTerm
	sizes  []Size
	tokens *tokenStore
}

func newStreamServer(t *testing.T) *streamServer {
	t.Helper()
	s := &streamServer{}
	m := &fakeMux{snap: oneTabSnapshot()}
	m.attach = func(_ string, size Size) (TermStream, error) {
		ft := newFakeTerm()
		s.mu.Lock()
		s.terms = append(s.terms, ft)
		s.sizes = append(s.sizes, size)
		s.mu.Unlock()
		return ft, nil
	}
	h, hub, err := buildServer(testConfig(t), m)
	if err != nil {
		t.Fatal(err)
	}
	s.hub = hub
	s.Server = httptest.NewServer(h)
	t.Cleanup(func() {
		hub.shutdown(context.Background())
		s.Close()
	})
	return s
}

func (s *streamServer) term(t *testing.T, i int) *fakeTerm {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		if i < len(s.terms) {
			ft := s.terms[i]
			s.mu.Unlock()
			return ft
		}
		s.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("terminal %d never attached", i)
	return nil
}

func authHeader() http.Header {
	h := http.Header{}
	req, _ := http.NewRequest("GET", "/", nil)
	req.SetBasicAuth("admin", "secret")
	h.Set("Authorization", req.Header.Get("Authorization"))
	return h
}

func fetchToken(t *testing.T, base string, auth bool) string {
	t.Helper()
	req, _ := http.NewRequest("GET", base+"/api/mux/stream-token", nil)
	if auth {
		req.SetBasicAuth("admin", "secret")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct{ Token string }
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Token == "" {
		t.Fatalf("stream-token: status %d, err %v", resp.StatusCode, err)
	}
	return body.Token
}

func wsURL(base, query string) string {
	return "ws" + strings.TrimPrefix(base, "http") + "/api/mux/stream?" + query
}

// dialStream opens a stream with a fresh token and the given extra headers.
func dialStream(t *testing.T, base, query string, hdr http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, wsURL(base, query), &websocket.DialOptions{HTTPHeader: hdr})
}

func mustDial(t *testing.T, s *streamServer, query string) *websocket.Conn {
	t.Helper()
	hdr := authHeader()
	hdr.Set("Origin", s.URL)
	c, _, err := dialStream(t, s.URL, "token="+fetchToken(t, s.URL, true)+"&"+query, hdr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c
}

func readFrame(t *testing.T, c *websocket.Conn) (websocket.MessageType, []byte, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.Read(ctx)
}

func TestStreamRejectsBadRequests(t *testing.T) {
	s := newStreamServer(t)
	cases := []struct {
		name   string
		query  string
		hdr    func(http.Header)
		token  bool
		status int
	}{
		{"foreign origin", "pane=0", func(h http.Header) { h.Set("Origin", "http://evil.example") }, true, http.StatusForbidden},
		{"cross-site fetch", "pane=0", func(h http.Header) { h.Set("Sec-Fetch-Site", "cross-site") }, true, http.StatusForbidden},
		{"no token", "pane=0", nil, false, http.StatusUnauthorized},
		{"bad token", "pane=0&token=deadbeef", nil, false, http.StatusUnauthorized},
		{"no pane", "", nil, true, http.StatusBadRequest},
		{"unknown pane", "pane=9", nil, true, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hdr := authHeader()
			if tc.hdr != nil {
				tc.hdr(hdr)
			}
			q := tc.query
			if tc.token {
				q += "&token=" + fetchToken(t, s.URL, true)
			}
			_, resp, err := dialStream(t, s.URL, q, hdr)
			if err == nil {
				t.Fatal("dial succeeded, want rejection")
			}
			if resp == nil || resp.StatusCode != tc.status {
				t.Fatalf("status = %v, want %d", resp, tc.status)
			}
		})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.terms) != 0 {
		t.Errorf("rejected requests attached %d terminals", len(s.terms))
	}
}

func TestStreamRequiresAuth(t *testing.T) {
	s := newStreamServer(t)
	tok := fetchToken(t, s.URL, true)
	_, resp, err := dialStream(t, s.URL, "pane=0&token="+tok, http.Header{"Origin": {s.URL}})
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated dial: err %v, resp %v; want 401", err, resp)
	}
}

func TestStreamRequiresUpgrade(t *testing.T) {
	s := newStreamServer(t)
	req, _ := http.NewRequest("GET", s.URL+"/api/mux/stream?pane=0&token="+fetchToken(t, s.URL, true), nil)
	req.SetBasicAuth("admin", "secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("plain GET status = %d, want 400", resp.StatusCode)
	}
}

func TestStreamTokenSingleUse(t *testing.T) {
	s := newStreamServer(t)
	hdr := authHeader()
	tok := fetchToken(t, s.URL, true)
	c, _, err := dialStream(t, s.URL, "pane=0&token="+tok, hdr)
	if err != nil {
		t.Fatalf("first use: %v", err)
	}
	c.CloseNow()
	if _, resp, err := dialStream(t, s.URL, "pane=0&token="+tok, hdr); err == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("reused token: want 401, got %v", resp)
	}
}

func TestStreamTokenExpired(t *testing.T) {
	// Mount the route alone so the test owns the token store.
	tokens := newStreamTokenStore()
	hub := newStreamHub(maxStreams)
	mux := http.NewServeMux()
	registerStreamRoutes(mux, &fakeMux{snap: oneTabSnapshot()}, tokens, parseAllowedHosts(""), hub)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	tok, _ := tokens.generate()
	tokens.tokens[tok] = time.Now().Add(-time.Second)
	if _, resp, err := dialStream(t, srv.URL, "pane=0&token="+tok, nil); err == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expired token: want 401, got %v", resp)
	}
}

func TestTerminalTokenStoreCap(t *testing.T) {
	st := newStreamTokenStore()
	first, _ := st.generate()
	for i := 0; i < maxStreamTokens; i++ {
		st.generate()
	}
	if n := len(st.tokens); n != maxStreamTokens {
		t.Errorf("live tokens = %d, want %d", n, maxStreamTokens)
	}
	if st.validate(first) {
		t.Error("oldest token must be dropped once the cap is reached")
	}
}

func TestStreamClampsSize(t *testing.T) {
	s := newStreamServer(t)
	mustDial(t, s, "pane=0&cols=65535&rows=0")
	s.term(t, 0)
	mustDial(t, s, "pane=0&cols=abc")
	s.term(t, 1)
	s.mu.Lock()
	defer s.mu.Unlock()
	if got := s.sizes[0]; got != (Size{Cols: maxTermDim, Rows: 1}) {
		t.Errorf("clamped size = %+v", got)
	}
	if got := s.sizes[1]; got != (Size{Cols: defaultTermCols, Rows: defaultTermRows}) {
		t.Errorf("default size = %+v", got)
	}
}

func TestStreamPipesBytesAndResize(t *testing.T) {
	s := newStreamServer(t)
	c := mustDial(t, s, "pane=0")
	ft := s.term(t, 0)
	ctx := context.Background()

	if err := c.Write(ctx, websocket.MessageBinary, []byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":9999,"rows":30}`))
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize"}`))
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"bogus"}`))
	c.Write(ctx, websocket.MessageText, []byte(`not json`))
	for i := 0; i < 2; i++ {
		select {
		case <-ft.inCh:
		case <-time.After(5 * time.Second):
			t.Fatal("input never reached the terminal")
		}
	}
	ft.mu.Lock()
	in, sizes := string(ft.in), ft.sizes
	ft.mu.Unlock()
	if in != "ls\r" {
		t.Errorf("terminal input = %q", in)
	}
	if len(sizes) != 1 || sizes[0] != (Size{Cols: maxTermDim, Rows: 30}) {
		t.Errorf("resizes = %+v", sizes)
	}

	ft.out <- []byte("\x1b[1mhi\x1b[0m")
	typ, data, err := readFrame(t, c)
	if err != nil || typ != websocket.MessageBinary || string(data) != "\x1b[1mhi\x1b[0m" {
		t.Errorf("output frame = %v %q %v", typ, data, err)
	}
}

func TestStreamSendsExitCode(t *testing.T) {
	s := newStreamServer(t)
	c := mustDial(t, s, "pane=0")
	ft := s.term(t, 0)
	ft.code = 3
	close(ft.done)
	typ, data, err := readFrame(t, c)
	if err != nil || typ != websocket.MessageText || string(data) != `{"type":"exit","code":3}` {
		t.Fatalf("exit frame = %v %s %v", typ, data, err)
	}
	if _, _, err := readFrame(t, c); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Errorf("close after exit = %v", err)
	}
	if !ft.isClosed() {
		t.Error("terminal not closed after exit")
	}
}

func TestStreamClosesOnOversizedMessage(t *testing.T) {
	s := newStreamServer(t)
	c := mustDial(t, s, "pane=0")
	ft := s.term(t, 0)
	c.Write(context.Background(), websocket.MessageBinary, make([]byte, maxStreamMessage+1))
	if _, _, err := readFrame(t, c); websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Errorf("close status = %v, want %v", err, websocket.StatusMessageTooBig)
	}
	waitClosed(t, ft)
}

func TestStreamEvictsOldest(t *testing.T) {
	s := newStreamServer(t)
	var conns []*websocket.Conn
	for i := 0; i < maxStreams; i++ {
		conns = append(conns, mustDial(t, s, "pane=0"))
		s.term(t, i)
	}
	mustDial(t, s, "pane=0")
	s.term(t, maxStreams)

	typ, data, err := readFrame(t, conns[0])
	if err != nil || typ != websocket.MessageText || !strings.Contains(string(data), "too many open streams") {
		t.Fatalf("evicted stream frame = %v %s %v", typ, data, err)
	}
	if _, _, err := readFrame(t, conns[0]); websocket.CloseStatus(err) != closeEvicted {
		t.Errorf("evicted close = %v", err)
	}
	waitClosed(t, s.term(t, 0))
	for i := 1; i <= maxStreams; i++ {
		if s.term(t, i).isClosed() {
			t.Errorf("stream %d closed, only the oldest should be", i)
		}
	}
}

func TestStreamShutdownClosesStreams(t *testing.T) {
	s := newStreamServer(t)
	c := mustDial(t, s, "pane=0")
	ft := s.term(t, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.hub.shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if !ft.isClosed() {
		t.Error("terminal still open after shutdown")
	}
	if _, _, err := readFrame(t, c); websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Errorf("close status = %v, want going away", err)
	}
	// New streams are refused once shutdown started.
	c2 := mustDial(t, s, "pane=0")
	if _, _, err := readFrame(t, c2); websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Errorf("stream after shutdown = %v", err)
	}
}

func waitClosed(t *testing.T, ft *fakeTerm) {
	t.Helper()
	select {
	case <-ft.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("terminal was not closed")
	}
}

// --- real processes ---

// startHelperTerminal runs helperTree on a real PTY/ConPTY and returns the
// stream plus the child and grandchild PIDs it reports.
func startHelperTerminal(t *testing.T, size Size) (TermStream, *outputReader, int, int) {
	t.Helper()
	t.Setenv(helperEnv, "tree")
	self, _ := os.Executable()
	ts, err := startTerminal([]string{self}, size)
	if err != nil {
		t.Fatalf("startTerminal: %v", err)
	}
	t.Cleanup(func() { ts.Close() })
	out := newOutputReader(ts)
	m := out.waitFor(t, `PIDS=(\d+),(\d+)`)
	child, _ := strconv.Atoi(m[1])
	grandchild, _ := strconv.Atoi(m[2])
	return ts, out, child, grandchild
}

func TestTerminalCloseKillsProcessTree(t *testing.T) {
	ts, _, child, grandchild := startHelperTerminal(t, Size{Cols: 80, Rows: 24})
	if !processAlive(child) || !processAlive(grandchild) {
		t.Fatal("helper processes not running")
	}
	start := time.Now()
	if err := ts.Close(); err != nil {
		t.Fatal(err)
	}
	waitDead(t, child, "child")
	waitDead(t, grandchild, "grandchild")
	if d := time.Since(start); d > processKillWait+2*time.Second {
		t.Errorf("Close took %v", d)
	}
}

func TestTerminalExitCodeAndResize(t *testing.T) {
	ts, out, _, _ := startHelperTerminal(t, Size{Cols: 90, Rows: 30})
	ts.Write([]byte("size\r"))
	out.waitFor(t, `SIZE=90x30`)
	if err := ts.Resize(Size{Cols: 120, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	ts.Write([]byte("size\r"))
	out.waitFor(t, `SIZE=120x40`)

	ts.Write([]byte("exit 3\r"))
	select {
	case <-ts.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("terminal did not exit")
	}
	if code := ts.ExitCode(); code != 3 {
		t.Errorf("exit code = %d, want 3", code)
	}
}

// TestServerStopKillsTerminals stops a real server while a stream is open and
// checks that no terminal process survives it.
func TestServerStopKillsTerminals(t *testing.T) {
	for _, hard := range stopModes() {
		name := "graceful"
		if hard {
			name = "hard kill"
		}
		t.Run(name, func(t *testing.T) {
			self, _ := os.Executable()
			srv := exec.Command(self)
			srv.Env = append(os.Environ(), helperEnv+"=serve")
			stdout, _ := srv.StdoutPipe()
			srv.Stderr = os.Stderr
			if err := srv.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { srv.Process.Kill(); srv.Wait() })
			line, err := bufio.NewReader(stdout).ReadString('\n')
			if err != nil || !strings.HasPrefix(line, "ADDR=") {
				t.Fatalf("server did not start: %q %v", line, err)
			}
			base := "http://" + strings.TrimSpace(strings.TrimPrefix(line, "ADDR="))

			c, _, err := dialStream(t, base, "pane=0&token="+fetchToken(t, base, false), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer c.CloseNow()
			out := newOutputReader(wsReader{c})
			m := out.waitFor(t, `PIDS=(\d+),(\d+)`)
			child, _ := strconv.Atoi(m[1])
			grandchild, _ := strconv.Atoi(m[2])
			t.Cleanup(func() { killPID(child); killPID(grandchild) })

			stopServer(t, srv.Process, hard)
			exited := make(chan struct{})
			go func() { srv.Wait(); close(exited) }()
			select {
			case <-exited:
			case <-time.After(shutdownTimeout + 5*time.Second):
				t.Fatal("server did not exit")
			}
			waitDead(t, child, "child")
			if !hard || hardKillEndsTree {
				waitDead(t, grandchild, "grandchild")
			}
		})
	}
}

func waitDead(t *testing.T, pid int, what string) {
	t.Helper()
	deadline := time.Now().Add(processKillWait + 2*time.Second)
	for processAlive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("%s (pid %d) still alive", what, pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// wsReader adapts a stream WebSocket to io.Reader over its binary frames.
type wsReader struct{ c *websocket.Conn }

func (r wsReader) Read(p []byte) (int, error) {
	for {
		typ, data, err := r.c.Read(context.Background())
		if err != nil {
			return 0, err
		}
		if typ == websocket.MessageBinary {
			return copy(p, data), nil
		}
	}
}

// outputReader collects everything a terminal prints so tests can wait for a
// pattern.
type outputReader struct {
	mu   sync.Mutex
	buf  strings.Builder
	more chan struct{}
}

func newOutputReader(r io.Reader) *outputReader {
	o := &outputReader{more: make(chan struct{}, 1)}
	go func() {
		p := make([]byte, 4096)
		for {
			n, err := r.Read(p)
			o.mu.Lock()
			o.buf.Write(p[:n])
			o.mu.Unlock()
			select {
			case o.more <- struct{}{}:
			default:
			}
			if err != nil {
				return
			}
		}
	}()
	return o
}

// waitFor returns the submatches of the first match of pattern in the output
// seen so far; the matched text is consumed.
func (o *outputReader) waitFor(t *testing.T, pattern string) []string {
	t.Helper()
	re := regexp.MustCompile(pattern)
	deadline := time.After(10 * time.Second)
	for {
		o.mu.Lock()
		s := o.buf.String()
		if loc := re.FindStringSubmatchIndex(s); loc != nil {
			m := re.FindStringSubmatch(s)
			rest := s[loc[1]:]
			o.buf.Reset()
			o.buf.WriteString(rest)
			o.mu.Unlock()
			return m
		}
		o.mu.Unlock()
		select {
		case <-o.more:
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			t.Fatalf("output never matched %q; got %q", pattern, s)
		}
	}
}
