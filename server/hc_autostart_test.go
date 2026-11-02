package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHcChildEnv(t *testing.T) {
	t.Setenv("HC_TERMINAL_ID", "t7")
	t.Setenv("HC_SESSION", "from-shell")
	t.Setenv("hc_lower", "x")
	t.Setenv("TERMOTE_SECRET", "pw")
	t.Setenv("KEEP_ME", "1")
	env := hcChildEnv(hcEnv{Session: "work", Socket: "/run/s.sock"})
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(strings.ToUpper(k), "TERMOTE_") || k == "HC_TERMINAL_ID" || k == "hc_lower" {
			t.Errorf("%s passed on", kv)
		}
	}
	if !slices.Contains(env, "KEEP_ME=1") || hcEnvValue(env, "HC_SESSION") != "work" || hcEnvValue(env, "HC_SOCKET") != "/run/s.sock" {
		t.Fatalf("env %v", env)
	}
	if strings.Count(strings.Join(env, "\n"), "HC_SESSION=") != 1 {
		t.Fatal("the shell's HC_SESSION kept beside the saved one")
	}
	if e := hcChildEnv(hcEnv{}); hcEnvValue(e, "HC_SESSION") != "" || hcEnvValue(e, "HC_SOCKET") != "" {
		t.Fatal("unset hc variables added")
	}
}

func TestHcStateDir(t *testing.T) {
	sep := string(filepath.Separator)
	if got := hcStateDir([]string{"XDG_STATE_HOME=/s", "HC_SESSION= work "}); got != filepath.Join("/s", "herdr-core", "work") {
		t.Errorf("got %s", got)
	}
	if got := hcStateDir([]string{"XDG_STATE_HOME=/s", "XDG_STATE_HOME=/t"}); got != filepath.Join("/t", "herdr-core", "default") {
		t.Errorf("last value must win: %s", got)
	}
	got := hcStateDir([]string{"HOME=/h", "LOCALAPPDATA=C:\\L", "XDG_STATE_HOME="})
	if runtime.GOOS == "windows" {
		if !strings.HasPrefix(got, `C:\L`) {
			t.Errorf("got %s", got)
		}
	} else if got != filepath.Join("/h", ".local", "state", "herdr-core", "default") {
		t.Errorf("got %s", got)
	}
	if !strings.HasSuffix(got, sep+"default") {
		t.Errorf("no default session: %s", got)
	}
}

func TestHcCoreRunningProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("named pipes: the probe uses dialHerdr, tested with herdr")
	}
	probe := hcCoreRunningDefault
	state := t.TempDir()
	env := []string{"XDG_STATE_HOME=" + state, "HC_SESSION=s"}
	if probe(context.Background(), env) {
		t.Fatal("running without a core.lock")
	}
	lockDir := filepath.Join(state, "herdr-core", "s")
	os.MkdirAll(lockDir, 0o700)
	sock := filepath.Join(shortTempDir(t), "c.sock")
	os.WriteFile(filepath.Join(lockDir, "core.lock"), []byte(sock), 0o600)
	if probe(context.Background(), env) {
		t.Fatal("running with a stale core.lock")
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	if !probe(context.Background(), env) {
		t.Fatal("not running with a listening socket")
	}
	// HC_SOCKET wins over core.lock.
	if probe(context.Background(), append(env, "HC_SOCKET="+sock+".other")) {
		t.Fatal("core.lock used despite HC_SOCKET")
	}
	if !probe(context.Background(), []string{"HC_SOCKET=" + sock}) {
		t.Fatal("HC_SOCKET not probed")
	}
	os.WriteFile(filepath.Join(lockDir, "core.lock"), []byte(" \n"), 0o600)
	if probe(context.Background(), env) {
		t.Fatal("running with an empty core.lock")
	}
}

// shortTempDir is a temp dir short enough for a Unix socket path.
func shortTempDir(t *testing.T) string {
	d, err := os.MkdirTemp("/tmp", "hc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

// fakeHcStarts makes a client whose starts connect a new fake core each,
// with hcCoreRunning reporting *running.
func fakeHcStarts(t *testing.T, running *atomic.Bool, fail *atomic.Bool) (*hcClient, *atomic.Int32) {
	var starts atomic.Int32
	oldRunning := hcCoreRunning
	oldGrace := herdrStartGrace
	t.Cleanup(func() {
		hcCoreRunning = oldRunning
		herdrStartGrace = oldGrace
	})
	hcCoreRunning = func(context.Context, []string) bool { return running.Load() }
	c := newHcClient("/usr/bin/hc", nil)
	c.connect = func(ctx context.Context, bin string, env []string) (*hcConn, error) {
		starts.Add(1)
		time.Sleep(20 * time.Millisecond)
		if fail != nil && fail.Load() {
			return nil, errors.New("cannot start core")
		}
		_, c := startFakeHc(t, nil)
		running.Store(true)
		return c, nil
	}
	return c, &starts
}

func TestHcClientNeverStartsTheCoreForReads(t *testing.T) {
	var running atomic.Bool
	c, starts := fakeHcStarts(t, &running, nil)
	herdrStartGrace = 0
	// Peek, view-only, health and the push watcher read with mayStart false.
	for i := 0; i < 3; i++ {
		if _, err := c.get(context.Background(), false); !errors.Is(err, errHcNotRunning) {
			t.Fatalf("err = %v", err)
		}
	}
	time.Sleep(50 * time.Millisecond)
	if starts.Load() != 0 {
		t.Fatalf("%d starts", starts.Load())
	}
}

func TestHcClientStartsOnceForAFullClient(t *testing.T) {
	var running atomic.Bool
	c, starts := fakeHcStarts(t, &running, nil)
	herdrStartGrace = 0
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.get(context.Background(), true)
		}()
	}
	wg.Wait()
	waitFor(t, func() bool { conn, _ := c.current(); return conn != nil })
	if starts.Load() != 1 {
		t.Fatalf("%d starts", starts.Load())
	}
	conn, err := c.get(context.Background(), false)
	if err != nil || conn == nil {
		t.Fatalf("get after start: %v", err)
	}
	c.close()
	if conn.alive() {
		t.Fatal("close left the connection up")
	}
}

func TestHcClientStartGraceAndBackoff(t *testing.T) {
	var running, fail atomic.Bool
	fail.Store(true)
	c, starts := fakeHcStarts(t, &running, &fail)
	herdrStartGrace = time.Hour
	if _, err := c.get(context.Background(), true); !errors.Is(err, errHcStarting) {
		t.Fatalf("err = %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if starts.Load() != 0 {
		t.Fatal("started within the grace period")
	}
	herdrStartGrace = 0
	c.get(context.Background(), true)
	waitFor(t, func() bool { return starts.Load() == 1 && !c.starter.starting() })
	// The failure backs off: no second start right away.
	c.get(context.Background(), true)
	time.Sleep(50 * time.Millisecond)
	if starts.Load() != 1 {
		t.Fatalf("%d starts during the backoff", starts.Load())
	}
	// Past the backoff it starts again, and a core that answers is kept.
	c.starter.mu.Lock()
	c.starter.nextTry = time.Time{}
	c.starter.mu.Unlock()
	fail.Store(false)
	c.get(context.Background(), true)
	waitFor(t, func() bool { conn, _ := c.current(); return conn != nil })
	// A core that goes away right after it answered counts as a failure.
	conn, changed := c.current()
	conn.close()
	waitFor(t, func() bool {
		c.starter.mu.Lock()
		defer c.starter.mu.Unlock()
		return !c.starter.nextTry.IsZero()
	})
	if _, err := c.get(context.Background(), false); !errors.Is(err, errHcNotRunning) && err != nil {
		t.Fatalf("err = %v", err)
	}
	select {
	case <-changed:
	default:
		t.Fatal("changed not closed on a new connection")
	}
	c.starter.answered() // not stable yet: keeps the backoff
	c.starter.mu.Lock()
	still := !c.starter.nextTry.IsZero()
	c.starter.mu.Unlock()
	if !still {
		t.Fatal("backoff reset by a core that did not stay up")
	}
}

func TestHcClientDialsOnceWhenTheCoreRuns(t *testing.T) {
	var running atomic.Bool
	running.Store(true)
	c, starts := fakeHcStarts(t, &running, nil)
	var wg sync.WaitGroup
	conns := make([]*hcConn, 8)
	for i := range conns {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			conns[i], _ = c.get(context.Background(), false)
		}(i)
	}
	wg.Wait()
	for _, conn := range conns {
		if conn == nil || conn != conns[0] {
			t.Fatal("callers got different or no connections")
		}
	}
	if starts.Load() != 1 {
		t.Fatalf("%d dials", starts.Load())
	}
	// A dial that fails is reported to every waiter.
	conns[0].close()
	c.connect = func(context.Context, string, []string) (*hcConn, error) { return nil, errors.New("boom") }
	if _, err := c.get(context.Background(), false); err == nil || err.Error() != "boom" {
		t.Fatalf("err = %v", err)
	}
	// A caller's context ends its wait.
	block := make(chan struct{})
	defer close(block)
	c.connect = func(context.Context, string, []string) (*hcConn, error) { <-block; return nil, errors.New("late") }
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := c.get(ctx, false); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}

// The real hc connect path: a child process with the filtered environment,
// framed mode over its stdin/stdout, and its end when the connection closes.
func TestHcConnectChildProcess(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Setenv("HC_TERMINAL_ID", "t3")
	env := append(hcChildEnv(hcEnv{Session: "isolated"}), helperEnv+"=hc-connect",
		hcFakeEnvFile+"="+filepath.Join(dir, "env.json"), hcFakeArgs+"="+filepath.Join(dir, "args.json"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := startHcConnect(ctx, self, env)
	if err != nil {
		t.Fatal(err)
	}
	var status struct{ Version string }
	if err := c.call(ctx, hcStatusParams{}, &status); err != nil || status.Version != "0.1.16" {
		t.Fatalf("status %+v %v", status, err)
	}
	var args, childEnv []string
	b, _ := os.ReadFile(filepath.Join(dir, "args.json"))
	json.Unmarshal(b, &args)
	b, _ = os.ReadFile(filepath.Join(dir, "env.json"))
	json.Unmarshal(b, &childEnv)
	if !slices.Equal(args, []string{"connect"}) {
		t.Fatalf("args %v", args)
	}
	if hcEnvValue(childEnv, "HC_TERMINAL_ID") != "" || hcEnvValue(childEnv, "HC_SESSION") != "isolated" {
		t.Fatalf("child env: HC_TERMINAL_ID=%q HC_SESSION=%q", hcEnvValue(childEnv, "HC_TERMINAL_ID"), hcEnvValue(childEnv, "HC_SESSION"))
	}
	c.close()
	select {
	case <-c.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("hc connect still runs after close")
	}

	// hc connect that cannot reach the core prints an error and exits.
	_, err = startHcConnect(ctx, self, append(env, hcFakeMode+"=error"))
	if hcErrorKind(err) != "unavailable" {
		t.Fatalf("err = %v", err)
	}
	if _, err := startHcConnect(ctx, filepath.Join(dir, "no-such-hc"), env); err == nil {
		t.Fatal("started a missing binary")
	}
}
