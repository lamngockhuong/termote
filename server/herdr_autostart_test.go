package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeStarts records the herdr starts a test sees, instead of real ones.
type fakeStarts struct {
	mu      sync.Mutex
	n       int
	stopped int
	bin     string
	env     []string
	logs    string
}

func (s *fakeStarts) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.n
}

// autostartTest makes starts immediate and short, resolves herdr to the test
// binary, and installs start as herdrStartServer, recording each call.
func autostartTest(t *testing.T, start func(path string) (<-chan struct{}, error)) *fakeStarts {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	grace, wait, poll, stable, bin, server := herdrStartGrace, herdrStartWait, herdrStartPoll, herdrStableAfter, herdrBin, herdrStartServer
	t.Cleanup(func() {
		herdrStartGrace, herdrStartWait, herdrStartPoll, herdrStableAfter, herdrBin, herdrStartServer = grace, wait, poll, stable, bin, server
	})
	herdrStartGrace, herdrStartWait, herdrStartPoll, herdrBin = 0, 2*time.Second, 10*time.Millisecond, self
	// herdr's config dir holds no session file unless a test writes one.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	s := &fakeStarts{}
	herdrStartServer = func(bin string, env []string, logPath string) (herdrServerProc, error) {
		s.mu.Lock()
		s.n++
		s.bin, s.env, s.logs = bin, env, logPath
		s.mu.Unlock()
		exited, err := start(envValue(env, "HERDR_SOCKET_PATH"))
		return herdrServerProc{exited: exited, stop: func() {
			s.mu.Lock()
			s.stopped++
			s.mu.Unlock()
		}}, err
	}
	return s
}

func envValue(env []string, key string) string {
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			return v
		}
	}
	return ""
}

// listenFakeHerdr serves a fake herdr at path with the fixture's workspaces.
func listenFakeHerdr(t *testing.T, path, version string) *fakeHerdr {
	f := &fakeHerdr{t: t, protocol: herdrProtocol, calls: map[string]int{}, params: map[string][]json.RawMessage{},
		snapshot: loadHerdrFixture(t), version: version}
	f.listen(path)
	return f
}

func newDeadHerdrMux(t *testing.T) *herdrMux {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m, _ := newHerdrMux(ctx, fakeSocketPath(t))
	return m
}

func waitStarted(t *testing.T, m *herdrMux) {
	t.Helper()
	waitUntil(t, "the start to finish", func() bool { return !m.starter.starting() })
}

func captureSyncLog(t *testing.T) *syncBuffer {
	t.Helper()
	var buf syncBuffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

func TestHerdrAutostartOnFullSnapshot(t *testing.T) {
	var mu sync.Mutex
	starts := autostartTest(t, func(path string) (<-chan struct{}, error) {
		mu.Lock()
		defer mu.Unlock()
		listenFakeHerdr(t, path, "0.9.5")
		return make(chan struct{}), nil
	})
	t.Setenv("TERMOTE_PASSWORD", "secret")
	t.Setenv("HERDR_PANE_ID", "w1:p1")
	m := newDeadHerdrMux(t)
	m.setAutostart(filepath.Join(t.TempDir(), "herdr-autostart.log"), true)
	// Let the event subscription back off to seconds: the start must wake
	// it, not wait for its next try.
	time.Sleep(3800 * time.Millisecond)

	began := time.Now()
	if _, err := m.startingSnapshot(context.Background()); err == nil {
		t.Fatal("first snapshot without herdr succeeded")
	}
	if d := time.Since(began); d > time.Second {
		t.Fatalf("the request waited %s for the start", d)
	}
	waitStarted(t, m)
	snap, err := m.startingSnapshot(context.Background())
	if err != nil || len(snap.Groups) == 0 {
		t.Fatalf("snapshot after the start = %d groups, %v", len(snap.Groups), err)
	}
	if starts.count() != 1 {
		t.Fatalf("%d starts, want 1", starts.count())
	}
	if starts.bin != herdrBin || starts.logs != m.starter.logPath {
		t.Errorf("start %q logging to %q", starts.bin, starts.logs)
	}
	if got := envValue(starts.env, "HERDR_SOCKET_PATH"); got != m.rpc.socket {
		t.Errorf("HERDR_SOCKET_PATH = %q, want %q", got, m.rpc.socket)
	}
	for _, kv := range starts.env {
		if isTermoteEnv(kv) || strings.HasPrefix(kv, "HERDR_PANE_ID=") {
			t.Errorf("herdr gets %q", kv)
		}
	}
	if v, _ := m.version.Load().(string); v != "0.9.5" {
		t.Errorf("version after the start = %q", v)
	}
	waitUntil(t, "the subscription", func() bool {
		if time.Since(began) > 3*time.Second {
			t.Fatal("the subscription waited for its backoff")
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.connected
	})
}

func TestHerdrAutostartOnce(t *testing.T) {
	starts := autostartTest(t, func(path string) (<-chan struct{}, error) {
		time.Sleep(100 * time.Millisecond)
		listenFakeHerdr(t, path, "")
		return make(chan struct{}), nil
	})
	m := newDeadHerdrMux(t)
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() {
			for end := time.Now().Add(300 * time.Millisecond); time.Now().Before(end); {
				m.startingSnapshot(context.Background())
				time.Sleep(5 * time.Millisecond)
			}
		})
	}
	wg.Wait()
	waitStarted(t, m)
	if starts.count() != 1 {
		t.Fatalf("%d starts, want 1", starts.count())
	}
}

// Only a full client's snapshot route starts herdr: never a view-only
// device, a peek, the stream's snapshot or the event subscription.
func TestHerdrAutostartOnlyFromFullSnapshotRoute(t *testing.T) {
	starts := autostartTest(t, func(string) (<-chan struct{}, error) { return nil, errors.New("no herdr") })
	m := newDeadHerdrMux(t)
	ctx := context.Background()
	m.Snapshot(ctx)
	m.peekSnapshot(ctx)
	viewSnapshot(ctx, m)
	h, _ := newRoleHandler(t, m, false)
	if rec := serve(h, viewRequest("GET", "/api/mux/snapshot", "")); rec.Code != http.StatusInternalServerError {
		t.Fatalf("view snapshot = %d %s", rec.Code, rec.Body)
	}
	serve(h, apiRequest("GET", "/api/mux/snapshot?peek=1", ""))
	time.Sleep(100 * time.Millisecond)
	if starts.count() != 0 || m.starter.starting() {
		t.Fatalf("%d starts before a full client's snapshot", starts.count())
	}
	if rec := serve(h, apiRequest("GET", "/api/mux/snapshot", "")); rec.Code != http.StatusInternalServerError ||
		strings.Contains(rec.Body.String(), "no herdr") {
		t.Fatalf("full snapshot = %d %s", rec.Code, rec.Body)
	}
	waitStarted(t, m)
	if starts.count() != 1 {
		t.Fatalf("%d starts after a full client's snapshot, want 1", starts.count())
	}
}

func TestHerdrAutostartWaitsGrace(t *testing.T) {
	starts := autostartTest(t, func(string) (<-chan struct{}, error) { return nil, errors.New("no herdr") })
	herdrStartGrace = time.Hour
	m := newDeadHerdrMux(t)
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if starts.count() != 0 {
		t.Fatalf("%d starts within the grace period", starts.count())
	}
	if !m.starter.nextTry.IsZero() {
		t.Error("the grace period set a backoff")
	}
}

func TestHerdrAutostartBackoff(t *testing.T) {
	logs := captureSyncLog(t)
	starts := autostartTest(t, func(string) (<-chan struct{}, error) { return nil, errors.New("no herdr") })
	m := newDeadHerdrMux(t)
	s := m.starter
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if starts.count() != 1 || s.delay != herdrStartBackoffMin || time.Until(s.nextTry) < 29*time.Second {
		t.Fatalf("after a failed start: %d starts, delay %s, next in %s", starts.count(), s.delay, time.Until(s.nextTry))
	}
	if !strings.Contains(logs.String(), "cannot start herdr: no herdr") {
		t.Errorf("log: %s", logs)
	}
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if starts.count() != 1 {
		t.Fatal("started again within the backoff")
	}
	s.mu.Lock()
	s.nextTry = time.Now()
	s.mu.Unlock()
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if starts.count() != 2 || s.delay != 2*herdrStartBackoffMin {
		t.Fatalf("after a second failure: %d starts, delay %s", starts.count(), s.delay)
	}
	for range 10 {
		s.failed("test")
	}
	if s.delay != herdrStartBackoffMax {
		t.Fatalf("delay grew to %s", s.delay)
	}
	s.answered()
	if s.delay != 0 || !s.nextTry.IsZero() {
		t.Fatal("an answer kept the backoff")
	}
}

func TestHerdrAutostartObserve(t *testing.T) {
	logs := captureSyncLog(t)
	starts := autostartTest(t, func(string) (<-chan struct{}, error) { return nil, errors.New("no herdr") })
	m := newDeadHerdrMux(t)
	_, missing := m.rpc.ping(context.Background())
	if !herdrNotListening(missing) {
		t.Fatalf("a missing socket is not taken as no herdr: %v", missing)
	}
	for _, err := range []error{&herdrError{Code: "internal", Message: "x"}, context.DeadlineExceeded, &herdrPipeUserError{Err: missing}} {
		m.starter.observe(err)
	}
	time.Sleep(50 * time.Millisecond)
	if starts.count() != 0 || m.starter.starting() {
		t.Fatal("started after an error that is not a missing herdr")
	}
	if !strings.Contains(logs.String(), `audit: herdr pipe refused reason=`) {
		t.Errorf("no audit line for a pipe of another user: %s", logs)
	}
	if herdrNotListening(&herdrError{Code: "x"}) || herdrNotListening(context.DeadlineExceeded) {
		t.Error("an answer or a timeout taken as no herdr")
	}
}

// A herdr with a session file answers before it has restored every
// workspace on some systems: the page sees "starting" until one is back,
// not an empty snapshot it would add a tab to.
func TestHerdrAutostartWaitsRestore(t *testing.T) {
	var mu sync.Mutex
	var f *fakeHerdr
	autostartTest(t, func(path string) (<-chan struct{}, error) {
		mu.Lock()
		defer mu.Unlock()
		f = listenFakeHerdr(t, path, "")
		f.mu.Lock()
		f.snapshot = map[string]any{"workspaces": []any{}}
		f.mu.Unlock()
		return make(chan struct{}), nil
	})
	dir := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "herdr")
	os.MkdirAll(dir, 0o700)
	writeFile(t, filepath.Join(dir, "session.json"), "{}")
	m := newDeadHerdrMux(t)
	m.startingSnapshot(context.Background())
	waitUntil(t, "herdr to answer", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return f != nil
	})
	time.Sleep(100 * time.Millisecond)
	if _, err := m.startingSnapshot(context.Background()); !errors.Is(err, errHerdrStarting) {
		t.Fatalf("snapshot while restoring = %v", err)
	}
	f.mu.Lock()
	f.snapshot = loadHerdrFixture(t)
	f.mu.Unlock()
	waitStarted(t, m)
	if !m.starter.nextTry.IsZero() {
		t.Fatal("a restored session counted as a failed start")
	}
}

func TestHerdrAutostartRestoreDeadline(t *testing.T) {
	autostartTest(t, func(path string) (<-chan struct{}, error) {
		f := listenFakeHerdr(t, path, "")
		f.mu.Lock()
		f.snapshot = map[string]any{"workspaces": []any{}}
		f.mu.Unlock()
		return make(chan struct{}), nil
	})
	herdrStartWait = 300 * time.Millisecond
	dir := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "herdr")
	os.MkdirAll(dir, 0o700)
	writeFile(t, filepath.Join(dir, "session.json"), "{}")
	m := newDeadHerdrMux(t)
	began := time.Now()
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if d := time.Since(began); d < 250*time.Millisecond {
		t.Fatalf("a session with no workspace left ended the start after %s", d)
	}
	if !m.starter.nextTry.IsZero() {
		t.Error("an empty restored session counted as a failed start")
	}
}

func TestHerdrAutostartExitedEarly(t *testing.T) {
	logs := captureSyncLog(t)
	autostartTest(t, func(string) (<-chan struct{}, error) {
		exited := make(chan struct{})
		close(exited)
		return exited, nil
	})
	m := newDeadHerdrMux(t)
	if m.starter.logName() != "the server log" {
		t.Errorf("log name without a log = %q", m.starter.logName())
	}
	logPath := filepath.Join(t.TempDir(), "herdr-autostart.log")
	m.setAutostart(logPath, true)
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if m.starter.delay != herdrStartBackoffMin || !strings.Contains(logs.String(), "herdr exited before it answered (see "+logPath+")") {
		t.Fatalf("delay %s, log: %s", m.starter.delay, logs)
	}
}

// herdr refuses to run twice: one that exits because another took the
// socket meanwhile is no failure.
func TestHerdrAutostartAnotherWon(t *testing.T) {
	autostartTest(t, func(path string) (<-chan struct{}, error) {
		exited := make(chan struct{})
		go func() {
			time.Sleep(30 * time.Millisecond)
			listenFakeHerdr(t, path, "")
			close(exited)
		}()
		return exited, nil
	})
	// No poll between the listen and the exit: one landing there would take
	// the other herdr for this one answering, then crashing.
	herdrStartPoll = time.Minute
	m := newDeadHerdrMux(t)
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if !m.starter.nextTry.IsZero() {
		t.Fatal("another herdr taking the socket counted as a failure")
	}
	if _, err := m.startingSnapshot(context.Background()); err != nil {
		t.Fatalf("snapshot after another herdr started: %v", err)
	}
}

func TestHerdrAutostartNoAnswer(t *testing.T) {
	logs := captureSyncLog(t)
	starts := autostartTest(t, func(string) (<-chan struct{}, error) { return make(chan struct{}), nil })
	herdrStartWait = 150 * time.Millisecond
	m := newDeadHerdrMux(t)
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if m.starter.delay != herdrStartBackoffMin || !strings.Contains(logs.String(), "herdr did not answer within 150ms") {
		t.Fatalf("delay %s, log: %s", m.starter.delay, logs)
	}
	// A herdr that never answers is not left behind, one more per try.
	if starts.stopped != 1 {
		t.Fatalf("stopped %d herdr servers, want 1", starts.stopped)
	}
}

func TestHerdrAutostartNoBinary(t *testing.T) {
	logs := captureSyncLog(t)
	starts := autostartTest(t, func(string) (<-chan struct{}, error) { return make(chan struct{}), nil })
	herdrBin = "termote-no-such-herdr"
	m := newDeadHerdrMux(t)
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if starts.count() != 0 || m.starter.delay != herdrStartBackoffMin || !strings.Contains(logs.String(), "cannot find herdr") {
		t.Fatalf("%d starts, delay %s, log: %s", starts.count(), m.starter.delay, logs)
	}
}

// A herdr someone else started between the failed snapshot and the start
// is used as it is.
func TestHerdrAutostartAlreadyRunning(t *testing.T) {
	starts := autostartTest(t, func(string) (<-chan struct{}, error) { return nil, errors.New("no herdr") })
	f := newFakeHerdr(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m, _ := newHerdrMux(ctx, f.path)
	m.starter.nextTry = time.Now().Add(time.Hour)
	m.starter.kick()
	waitStarted(t, m)
	if starts.count() != 0 || !m.starter.nextTry.IsZero() {
		t.Fatalf("%d starts, backoff kept: %v", starts.count(), !m.starter.nextTry.IsZero())
	}
}

func TestHerdrResolveBin(t *testing.T) {
	self, _ := os.Executable()
	if p, err := herdrResolveBin(self); err != nil || p != self {
		t.Errorf("herdrResolveBin(%q) = %q, %v", self, p, err)
	}
	if _, err := herdrResolveBin("termote-no-such-herdr"); err == nil {
		t.Error("a missing herdr resolved")
	}
	// A herdr found only through "." in PATH is refused.
	dir := t.TempDir()
	name := "herdr-dot"
	file := name
	if runtime.GOOS == "windows" {
		file += ".exe"
	}
	if err := os.WriteFile(filepath.Join(dir, file), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	t.Setenv("PATH", ".")
	if p, err := herdrResolveBin(name); err == nil {
		t.Errorf("herdr in the current directory resolved to %q", p)
	}
}

func TestHerdrServerEnv(t *testing.T) {
	t.Setenv("TERMOTE_PASSWORD", "secret")
	t.Setenv("HERDR_SOCKET_PATH", "/elsewhere.sock")
	t.Setenv("HERDR_ENV", "1")
	env := herdrServerEnv("/run/herdr.sock")
	var sockets []string
	for _, kv := range env {
		if isTermoteEnv(kv) || strings.HasPrefix(kv, "HERDR_ENV=") {
			t.Errorf("herdr gets %q", kv)
		}
		if strings.HasPrefix(kv, "HERDR_SOCKET_PATH=") {
			sockets = append(sockets, kv)
		}
	}
	if len(sockets) != 1 || sockets[0] != "HERDR_SOCKET_PATH=/run/herdr.sock" {
		t.Errorf("sockets = %v", sockets)
	}
}

func TestStartHerdrServer(t *testing.T) {
	self, _ := os.Executable()
	env := append(os.Environ(), helperEnv+"=herdr-server")
	logPath := filepath.Join(t.TempDir(), "herdr-autostart.log")
	proc, err := startHerdrServer(self, env, logPath)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-proc.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("the helper did not exit")
	}
	b, _ := os.ReadFile(logPath)
	for _, want := range []string{"termote: starting " + self + " server", "herdr-server [server]", "termote: herdr server exited: exit status 3"} {
		if !bytes.Contains(b, []byte(want)) {
			t.Errorf("log lacks %q:\n%s", want, b)
		}
	}
	if fi, err := os.Stat(logPath); runtime.GOOS != "windows" && (err != nil || fi.Mode().Perm() != 0o600) {
		t.Errorf("log mode %v, %v", fi.Mode(), err)
	}

	// Without a log path, or with one it cannot open, the output is
	// discarded and herdr still starts.
	logs := captureSyncLog(t)
	for _, path := range []string{"", filepath.Join(t.TempDir(), "missing", "x.log")} {
		proc, err := startHerdrServer(self, env, path)
		if err != nil {
			t.Fatalf("log %q: %v", path, err)
		}
		<-proc.exited
	}
	if !strings.Contains(logs.String(), "herdr autostart: cannot open") {
		t.Errorf("log: %s", logs)
	}
	if _, err := startHerdrServer(filepath.Join(t.TempDir(), "no-herdr"), env, ""); err == nil {
		t.Error("started a missing binary")
	}
	if exitStatus(nil) != "status 0" {
		t.Error(exitStatus(nil))
	}
}

// A running herdr keeps its log open: the log can still be deleted (logs
// clean, uninstall --purge), and stop kills it.
func TestStartHerdrServerStop(t *testing.T) {
	self, _ := os.Executable()
	env := append(os.Environ(), helperEnv+"=sleep")
	logPath := filepath.Join(t.TempDir(), "herdr-autostart.log")
	proc, err := startHerdrServer(self, env, logPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(logPath); err != nil {
		t.Errorf("remove the log of a running herdr: %v", err)
	}
	proc.stop()
	select {
	case <-proc.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("stop left the helper running")
	}
}

// A herdr that answers, then dies at once, is started again only after the
// backoff, growing each time: its answers do not reset it.
func TestHerdrAutostartCrashAfterAnswer(t *testing.T) {
	logs := captureSyncLog(t)
	var mu sync.Mutex
	var f *fakeHerdr
	exited := make(chan struct{})
	autostartTest(t, func(path string) (<-chan struct{}, error) {
		mu.Lock()
		defer mu.Unlock()
		f = listenFakeHerdr(t, path, "")
		return exited, nil
	})
	m := newDeadHerdrMux(t)
	m.startingSnapshot(context.Background())
	waitStarted(t, m)
	if _, err := m.startingSnapshot(context.Background()); err != nil {
		t.Fatal(err)
	}
	m.starter.mu.Lock()
	m.starter.delay = herdrStartBackoffMin
	m.starter.mu.Unlock()
	mu.Lock()
	f.close()
	mu.Unlock()
	close(exited)
	// failed logs after it unlocks: wait for the line too, not only the delay.
	waitUntil(t, "the crash to count and be logged", func() bool {
		m.starter.mu.Lock()
		defer m.starter.mu.Unlock()
		return m.starter.delay == 2*herdrStartBackoffMin && strings.Contains(logs.String(), "after it answered")
	})
	// An answer from a herdr started just now keeps the backoff; one that
	// has run past herdrStableAfter ends it.
	m.starter.answered()
	if m.starter.delay != 2*herdrStartBackoffMin {
		t.Fatal("an answer right after the start reset the backoff")
	}
	herdrStableAfter = 0
	m.starter.answered()
	if m.starter.delay != 0 {
		t.Fatal("a stable herdr kept the backoff")
	}
}

// The container's entrypoint starts herdr: serve there never does.
func TestHerdrAutostartDisabled(t *testing.T) {
	starts := autostartTest(t, func(string) (<-chan struct{}, error) { return nil, errors.New("no herdr") })
	m := newDeadHerdrMux(t)
	m.setAutostart("", false)
	if _, err := m.startingSnapshot(context.Background()); err == nil {
		t.Fatal("snapshot without herdr succeeded")
	}
	time.Sleep(50 * time.Millisecond)
	if starts.count() != 0 || m.starter.starting() {
		t.Fatal("started herdr with autostart off")
	}
}

func TestHerdrAutostartAuditsOnce(t *testing.T) {
	logs := captureSyncLog(t)
	m := newDeadHerdrMux(t)
	pe := &herdrPipeUserError{Err: errors.New("herdr pipe is served by another user (S-1)")}
	if pe.Error() != pe.Err.Error() || !errors.Is(pe, pe.Err) {
		t.Fatal("herdrPipeUserError hides its cause")
	}
	for range 3 {
		m.starter.observe(pe)
	}
	if n := strings.Count(logs.String(), "audit: herdr pipe refused"); n != 1 {
		t.Fatalf("%d audit lines for one refused pipe", n)
	}
	m.starter.observe(&herdrPipeUserError{Err: errors.New("another reason")})
	if n := strings.Count(logs.String(), "audit: herdr pipe refused"); n != 2 {
		t.Fatalf("%d audit lines after a new reason", n)
	}
}
