package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// errHerdrStarting answers a snapshot while termote starts herdr or herdr
// restores its session: the PWA keeps polling, and an empty snapshot now
// would make it create a tab next to the workspaces being restored.
var errHerdrStarting = errors.New("herdr is starting")

var (
	// herdrStartGrace is how long after serve starts herdr is never started:
	// Homebrew's service or the user may be starting it at the same time.
	herdrStartGrace = 15 * time.Second
	// herdrStartWait bounds how long a started herdr has to answer a ping,
	// and then to restore at least one workspace from its session file.
	herdrStartWait = 10 * time.Second
	// herdrStartPoll is how often a starting herdr is asked again.
	herdrStartPoll = 100 * time.Millisecond
	// herdrStableAfter is how long a started herdr must run before its
	// answers end the backoff: one that dies right after answering is
	// started again later and later, not at every poll.
	herdrStableAfter = time.Minute
)

// The delay before another start once one failed, doubled per failure.
const (
	herdrStartBackoffMin = 30 * time.Second
	herdrStartBackoffMax = 10 * time.Minute
)

// herdrStartServer starts bin as `herdr server` detached from serve, with its
// output appended to logPath. Tests replace it so no test ever starts a real
// herdr.
var herdrStartServer = startHerdrServer

// herdrServerProc is a herdr server termote started.
type herdrServerProc struct {
	exited <-chan struct{} // closed when it exits
	stop   func()          // kills it
}

// herdrStarter starts the herdr server when a full client opens the page and
// nothing listens on herdr's socket, like tmux makes its default session.
// Only one start runs at a time, outside any request.
type herdrStarter struct {
	m        *herdrMux
	logPath  string // where herdr's output goes; empty discards it
	disabled bool   // never start herdr (the container's entrypoint does)
	// session is herdr's session file: when it exists, herdr restores
	// workspaces from it, and a start waits for them.
	session string

	running atomic.Bool // a start (or its checks) is in progress

	mu        sync.Mutex
	startedAt time.Time // when serve started: herdrStartGrace counts from it
	nextTry   time.Time // no start before this, after a failed one
	delay     time.Duration
	lastStart time.Time // when the last herdr termote started answered
	lastAudit string    // the last refused pipe audited, so polls do not repeat it
}

func newHerdrStarter(m *herdrMux) *herdrStarter {
	return &herdrStarter{m: m, session: filepath.Join(herdrConfigDir(), "session.json"), startedAt: time.Now()}
}

// starting reports whether a start is in progress.
func (s *herdrStarter) starting() bool { return s.running.Load() }

// kick starts a start in the background unless one is in progress. It never
// waits: the request that called it answers with its own error.
func (s *herdrStarter) kick() {
	if !s.running.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer s.running.Store(false)
		s.run(context.Background())
	}()
}

// answered resets the backoff: herdr answers again, and has run for
// herdrStableAfter if termote started it.
func (s *herdrStarter) answered() {
	s.mu.Lock()
	if time.Since(s.lastStart) >= herdrStableAfter {
		s.delay, s.nextTry = 0, time.Time{}
	}
	s.mu.Unlock()
}

// failed pushes the next start back, doubling the delay up to its maximum.
func (s *herdrStarter) failed(format string, args ...any) {
	s.mu.Lock()
	s.delay = min(max(s.delay*2, herdrStartBackoffMin), herdrStartBackoffMax)
	s.nextTry = time.Now().Add(s.delay)
	delay := s.delay
	s.mu.Unlock()
	log.Printf("herdr autostart: "+format+" (next try in %s)", append(args, delay)...)
}

// due reports whether a start may run now: past the grace period after serve
// started and past the backoff of a failed start.
func (s *herdrStarter) due(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return now.Sub(s.startedAt) >= herdrStartGrace && !now.Before(s.nextTry)
}

// run starts herdr once if nothing answers its socket, then waits until it
// answers and has restored its session.
func (s *herdrStarter) run(ctx context.Context) {
	// Someone (the user, Homebrew's service) may have started it already.
	if s.ping(ctx) == nil {
		s.answered()
		s.m.wake()
		return
	}
	if !s.due(time.Now()) {
		return
	}
	bin, err := herdrResolveBin(herdrBin)
	if err != nil {
		s.failed("cannot find herdr: %v", err)
		return
	}
	_, statErr := os.Stat(s.session)
	hadSession := statErr == nil
	log.Printf("herdr autostart: starting %s server", bin)
	proc, err := herdrStartServer(bin, herdrServerEnv(s.m.rpc.socket), s.logPath)
	if err != nil {
		s.failed("cannot start herdr: %v", err)
		return
	}
	deadline := time.Now().Add(herdrStartWait)
	var p herdrPong
	for {
		if p, err = s.pingPong(ctx); err == nil {
			break
		}
		if !time.Now().Before(deadline) {
			// Each later try would leave one more behind.
			proc.stop()
			s.failed("herdr did not answer within %s: %v", herdrStartWait, err)
			return
		}
		select {
		case <-proc.exited:
			// Another herdr may have won the socket (it refuses to run
			// twice): only an exit while nothing answers is a failure.
			if s.ping(ctx) == nil {
				s.answered()
				s.m.wake()
				return
			}
			s.failed("herdr exited before it answered (see %s)", s.logName())
			return
		case <-time.After(herdrStartPoll):
		}
	}
	s.m.version.Store(p.Version)
	started := time.Now()
	s.mu.Lock()
	s.lastStart = started
	s.mu.Unlock()
	go func() {
		<-proc.exited
		if d := time.Since(started); d < herdrStableAfter {
			s.failed("herdr exited %s after it answered (see %s)", d.Round(time.Second), s.logName())
		}
	}()
	if hadSession {
		s.waitRestored(ctx, time.Now().Add(herdrStartWait))
	}
	log.Printf("herdr autostart: herdr %s answers", p.Version)
	s.m.wake()
}

// waitRestored waits until herdr's snapshot has a workspace, at most until
// deadline: a session file with none left restores none.
func (s *herdrStarter) waitRestored(ctx context.Context, deadline time.Time) {
	for time.Now().Before(deadline) {
		var res struct {
			Snapshot herdrSnapshot `json:"snapshot"`
		}
		cctx, cancel := context.WithTimeout(ctx, muxTimeout)
		err := s.m.rpc.call(cctx, "session.snapshot", nil, &res)
		cancel()
		if err == nil && len(res.Snapshot.Workspaces) > 0 {
			return
		}
		time.Sleep(herdrStartPoll)
	}
}

func (s *herdrStarter) ping(ctx context.Context) error {
	_, err := s.pingPong(ctx)
	return err
}

func (s *herdrStarter) pingPong(ctx context.Context) (herdrPong, error) {
	cctx, cancel := context.WithTimeout(ctx, muxTimeout)
	defer cancel()
	return s.m.rpc.ping(cctx)
}

func (s *herdrStarter) logName() string {
	if s.logPath == "" {
		return "the server log"
	}
	return s.logPath
}

// startingSnapshot is Snapshot for a full client opening the page, the only
// read that starts herdr: when nothing listens on herdr's socket it starts it
// in the background and answers with the error; a later poll finds herdr.
func (m *herdrMux) startingSnapshot(ctx context.Context) (Snapshot, error) {
	if m.starter.starting() {
		return Snapshot{}, errHerdrStarting
	}
	snap, err := m.Snapshot(ctx)
	m.starter.observe(err)
	return snap, err
}

// observe acts on the result of a full client's snapshot: an answer resets
// the backoff, nothing listening starts herdr, and a pipe served by another
// user is audited, never answered with a start.
func (s *herdrStarter) observe(err error) {
	var pe *herdrPipeUserError
	switch {
	case s.disabled:
	case err == nil:
		s.answered()
	case errors.As(err, &pe):
		reason := pe.Err.Error()
		s.mu.Lock()
		repeated := reason == s.lastAudit
		s.lastAudit = reason
		s.mu.Unlock()
		if !repeated {
			auditf("herdr pipe refused", "reason", reason)
		}
	case herdrNotListening(err):
		s.kick()
	}
}

// herdrServerEnv is the environment of a herdr server termote starts: the
// terminals' (no TERMOTE_*), without herdr's own variables of a pane serve
// may run in, and with the socket serve dials, so both use the same one.
func herdrServerEnv(socket string) []string {
	var env []string
	for _, kv := range terminalEnv() {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(strings.ToUpper(k), "HERDR_") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "HERDR_SOCKET_PATH="+socket)
}

// herdrResolveBin finds the herdr executable by name. A match in the current
// directory is refused, and on Windows only an .exe is run: a .cmd or .bat
// would go through cmd.exe.
func herdrResolveBin(name string) (string, error) {
	name = herdrExeName(name)
	p, err := exec.LookPath(name)
	if err != nil {
		return "", err
	}
	if !herdrRunnable(p) {
		return "", fmt.Errorf("%s is not an executable termote runs", p)
	}
	return p, nil
}

// startHerdrServer runs `bin server` detached from serve: it outlives
// termote stop, restart and update, like a tmux server.
func startHerdrServer(bin string, env []string, logPath string) (herdrServerProc, error) {
	out := os.DevNull
	if logPath != "" {
		out = logPath
	}
	f, err := openHerdrLog(out)
	if err != nil && out != os.DevNull {
		// Herdr still starts; only its output is lost.
		log.Printf("herdr autostart: cannot open %s: %v", out, err)
		out = os.DevNull
		f, err = openHerdrLog(out)
	}
	if err != nil {
		return herdrServerProc{}, err
	}
	defer f.Close()
	fmt.Fprintf(f, "%s termote: starting %s server\n", time.Now().Format(time.RFC3339), bin)
	var cmd *exec.Cmd
	for _, attr := range herdrServerSysProcAttrs() {
		cmd = exec.Command(bin, "server")
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = f, f
		cmd.SysProcAttr = attr
		if err = cmd.Start(); !herdrStartRefused(err) {
			break
		}
	}
	if err != nil {
		return herdrServerProc{}, err
	}
	exited := make(chan struct{})
	go func() {
		err := cmd.Wait()
		if lf, ferr := openHerdrLog(out); ferr == nil {
			fmt.Fprintf(lf, "%s termote: herdr server exited: %v\n", time.Now().Format(time.RFC3339), exitStatus(err))
			lf.Close()
		}
		log.Printf("herdr autostart: herdr server exited: %v", exitStatus(err))
		close(exited)
	}()
	return herdrServerProc{exited: exited, stop: func() { cmd.Process.Kill() }}, nil
}

// exitStatus names how a process ended.
func exitStatus(err error) string {
	if err == nil {
		return "status 0"
	}
	return err.Error()
}
