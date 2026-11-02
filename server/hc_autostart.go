package main

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	// errHcStarting answers a full client's snapshot while termote starts
	// the core: the PWA keeps polling.
	errHcStarting = errors.New("hc core is starting")
	// errHcNotRunning: the core does not run, and this read may not start
	// it (peek, view-only, health, the push watcher).
	errHcNotRunning = errors.New("hc core is not running")
)

// hcDialWait bounds starting hc connect and its hello. Starting the core as
// well (autostart) waits for its socket, which takes longer.
var (
	hcDialWait  = 10 * time.Second
	hcStartWait = 30 * time.Second
	// hcDialBackoff is how long a failed dial answers for itself.
	hcDialBackoff = 2 * time.Second
)

// hcEnv is what termote passes on of the user's hc environment: saved by
// start, so the service talks to the core the user's shell does.
type hcEnv struct {
	Session string `json:"session,omitempty"`
	Socket  string `json:"socket,omitempty"`
}

// hcChildEnv is the environment of hc connect, and through it of a core it
// starts: the terminals' (no TERMOTE_*), without any HC_* (a pane's
// HC_TERMINAL_ID would make termote that terminal's caller), plus the saved
// HC_SESSION and HC_SOCKET.
func hcChildEnv(saved hcEnv) []string {
	var env []string
	for _, kv := range terminalEnv() {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(strings.ToUpper(k), "HC_") {
			continue
		}
		env = append(env, kv)
	}
	if saved.Session != "" {
		env = append(env, "HC_SESSION="+saved.Session)
	}
	if saved.Socket != "" {
		env = append(env, "HC_SOCKET="+saved.Socket)
	}
	return env
}

// hcEnvValue is key's value in env, the last one winning; keys are matched
// without case on Windows, as the OS does.
func hcEnvValue(env []string, key string) string {
	val := ""
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if k == key || (runtime.GOOS == "windows" && strings.EqualFold(k, key)) {
			val = v
		}
	}
	return val
}

// hcStateDir is the core's state directory for env, as herdr-core's
// paths.rs finds it: $XDG_STATE_HOME (else the OS's default) /herdr-core/
// <HC_SESSION, trimmed, else "default">.
func hcStateDir(env []string) string {
	base := hcEnvValue(env, "XDG_STATE_HOME")
	if base == "" {
		base = hcDefaultStateHome(env)
	}
	session := strings.TrimSpace(hcEnvValue(env, "HC_SESSION"))
	if session == "" {
		session = "default"
	}
	return filepath.Join(base, "herdr-core", session)
}

// hcCoreRunning reports whether a core answers for env, without starting
// one: HC_SOCKET when set, else the endpoint the core recorded in its
// core.lock (herdr-core server.rs writes it there; client.rs reads it back
// the same way). Dialing the socket or pipe starts nothing; hc connect would
// (client.rs connect_or_start).
var hcCoreRunning = hcCoreRunningDefault

func hcCoreRunningDefault(ctx context.Context, env []string) bool {
	endpoint := hcEnvValue(env, "HC_SOCKET")
	if endpoint == "" {
		b, err := os.ReadFile(filepath.Join(hcStateDir(env), "core.lock"))
		if err != nil {
			return false
		}
		endpoint = strings.TrimSpace(string(b))
	}
	if endpoint == "" {
		return false
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	conn, err := hcDialProbe(cctx, endpoint)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// hcClient owns the server's one connection to the core.
type hcClient struct {
	bin string   // absolute path of hc, saved by start
	env []string // hc connect's environment (hcChildEnv)
	// connect starts hc connect (hcConnectStart; tests replace it).
	connect func(ctx context.Context, bin string, env []string) (*hcConn, error)

	mu         sync.Mutex
	conn       *hcConn
	changed    chan struct{} // closed and replaced when conn changes
	dialing    chan struct{} // closed when the dial in progress ends
	dialErr    error
	dialFailed time.Time // when the last dial failed
	// dialBackoff is hcDialBackoff, read once.
	dialBackoff time.Duration

	starter hcStarter
}

func newHcClient(bin string, env []string) *hcClient {
	c := &hcClient{bin: bin, env: env, connect: hcConnectStart, changed: make(chan struct{}), dialBackoff: hcDialBackoff}
	c.starter = hcStarter{c: c, startedAt: time.Now()}
	return c
}

// current is the live connection (nil when none) and a channel closed when
// another one replaces it.
func (c *hcClient) current() (*hcConn, <-chan struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != nil && !c.conn.alive() {
		c.conn = nil
	}
	return c.conn, c.changed
}

func (c *hcClient) set(conn *hcConn) {
	c.mu.Lock()
	c.conn = conn
	close(c.changed)
	c.changed = make(chan struct{})
	c.mu.Unlock()
}

// get returns the live connection, connecting when the core runs. When it
// does not, only mayStart (a full client's snapshot) starts it, in the
// background under the autostart policy, and answers errHcStarting.
func (c *hcClient) get(ctx context.Context, mayStart bool) (*hcConn, error) {
	if conn, _ := c.current(); conn != nil {
		c.starter.answered()
		return conn, nil
	}
	if c.starter.starting() {
		return nil, errHcStarting
	}
	if !hcCoreRunning(ctx, c.env) {
		if !mayStart {
			return nil, errHcNotRunning
		}
		c.starter.kick()
		return nil, errHcStarting
	}
	return c.dial(ctx, hcDialWait)
}

// dial starts hc connect once for every caller waiting meanwhile.
func (c *hcClient) dial(ctx context.Context, wait time.Duration) (*hcConn, error) {
	c.mu.Lock()
	if c.conn != nil && c.conn.alive() {
		conn := c.conn
		c.mu.Unlock()
		return conn, nil
	}
	ch := c.dialing
	// A dial that just failed is not tried again at once: every poll and
	// every stream waiting would start another hc connect.
	if ch == nil && c.dialErr != nil && time.Since(c.dialFailed) < c.dialBackoff {
		err := c.dialErr
		c.mu.Unlock()
		return nil, err
	}
	if ch == nil {
		ch = make(chan struct{})
		c.dialing = ch
		go func() {
			dctx, cancel := context.WithTimeout(context.Background(), wait)
			conn, err := c.connect(dctx, c.bin, c.env)
			cancel()
			if err == nil {
				c.set(conn)
			}
			c.mu.Lock()
			c.dialErr = err
			if err != nil {
				c.dialFailed = time.Now()
			}
			c.dialing = nil
			c.mu.Unlock()
			close(ch)
		}()
	}
	c.mu.Unlock()
	select {
	case <-ch:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != nil && c.conn.alive() {
		return c.conn, nil
	}
	if c.dialErr != nil {
		return nil, c.dialErr
	}
	return nil, errHcLost
}

// close ends the connection (serve stops).
func (c *hcClient) close() {
	if conn, _ := c.current(); conn != nil {
		conn.close()
	}
}

// hcStarter starts the core the way termote starts Herdr (herdr_autostart.go):
// only for a full client's snapshot, never within herdrStartGrace of serve
// starting, one start at a time, backing off after a failure, and a core
// that dies within herdrStableAfter counts as a failure.
type hcStarter struct {
	c        *hcClient
	disabled bool

	running atomic.Bool

	mu        sync.Mutex
	startedAt time.Time
	nextTry   time.Time
	delay     time.Duration
	lastStart time.Time
}

func (s *hcStarter) starting() bool { return s.running.Load() }

// kick starts the core in the background unless a start runs, the grace
// period after serve started has not passed, or a failure's backoff has not.
func (s *hcStarter) kick() {
	if s.disabled || !s.due(time.Now()) || !s.running.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer s.running.Store(false)
		s.run()
	}()
}

func (s *hcStarter) due(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return now.Sub(s.startedAt) >= herdrStartGrace && !now.Before(s.nextTry)
}

func (s *hcStarter) failed(format string, args ...any) {
	s.mu.Lock()
	s.delay = min(max(s.delay*2, herdrStartBackoffMin), herdrStartBackoffMax)
	s.nextTry = time.Now().Add(s.delay)
	delay := s.delay
	s.mu.Unlock()
	log.Printf("hc autostart: "+format+" (next try in %s)", append(args, delay)...)
}

// answered resets the backoff once a core termote started has stayed up.
func (s *hcStarter) answered() {
	s.mu.Lock()
	if time.Since(s.lastStart) >= herdrStableAfter {
		s.delay, s.nextTry = 0, time.Time{}
	}
	s.mu.Unlock()
}

// run connects through hc connect, which starts the core when nothing
// answers (herdr-core client.rs connect_or_start).
func (s *hcStarter) run() {
	log.Printf("hc autostart: starting the core through %s connect", s.c.bin)
	conn, err := s.c.dial(context.Background(), hcStartWait)
	if err != nil {
		s.failed("cannot start the core: %v", err)
		return
	}
	started := time.Now()
	s.mu.Lock()
	s.lastStart = started
	s.mu.Unlock()
	log.Printf("hc autostart: core %s answers", conn.hello.Version)
	go func() {
		<-conn.Done()
		if d := time.Since(started); d < herdrStableAfter {
			s.failed("the core went away %s after it answered", d.Round(time.Second))
		}
	}()
}
