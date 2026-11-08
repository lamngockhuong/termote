package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// The server reaches each machine of machines.json through one ssh master
// (Unix) and, for every HTTP connection its http.Transport opens, one ssh
// on that master running the machine's `termote bridge`. Windows has no
// ControlMaster: each connection is its own ssh. Every ssh is tracked and
// stopped with the server; a master is never left running by
// ControlPersist.

// machineDialer opens a bridge connection to a machine. The SSH one is the
// default; tests and the E2E suite join a bridge socket directly.
type machineDialer interface {
	dial(ctx context.Context, m machineRecord) (net.Conn, string, error)
	// idle stops what keeps a machine reachable without a client (a
	// master), forget stops it for a machine removed.
	idle(id string)
	forget(id string)
	stop()
}

// Machine statuses beside machineStatus's: before the first connection.
const (
	machineConnecting = "connecting"
)

// machineBackoffMin and machineBackoffMax bound the wait after a failure
// before a machine is tried again; requests meanwhile fail at once.
var (
	machineBackoffMin = 5 * time.Second
	machineBackoffMax = 5 * time.Minute
)

// machineMaxConns bounds the connections (ssh processes) open to a machine.
const machineMaxConns = 16

// machineResponseHeaderWait bounds the wait for a machine's answer to a
// request, so one that never answers does not hold the connections; what a
// machine does for a request is bounded below it, the longest a write to an
// agent (agentRequestMost: the wait for the pane's lock, then at most an
// agent message, five images and 16 KB pasted slowly, about 7 minutes),
// then a worktree change (worktreeLockWait + worktreeTimeout). A test checks
// both.
var machineResponseHeaderWait = 8 * time.Minute

// machineLink is one machine: its record, status and HTTP transport.
type machineLink struct {
	rec       machineRecord
	dialer    machineDialer
	transport *http.Transport

	mu       sync.Mutex
	status   string
	err      error
	backoff  time.Duration
	nextTry  time.Time
	checked  bool // health compared since the last failure
	lastUsed time.Time
	// active counts the requests and streams forwarded to the machine now:
	// a machine in use is never idle, even on pooled connections.
	active int
	// conns are the bridge connections open now (in use or idle): closed
	// when the machine is removed, a forwarded stream with them, also
	// where no master's exit would end them (Windows).
	conns map[*linkConn]struct{}
}

// linkConn is a bridge connection its link keeps track of.
type linkConn struct {
	net.Conn
	l    *machineLink
	once sync.Once
}

func (c *linkConn) Close() error {
	c.once.Do(func() {
		c.l.mu.Lock()
		delete(c.l.conns, c)
		c.l.mu.Unlock()
	})
	return c.Conn.Close()
}

// closeAll closes every connection open to the machine.
func (l *machineLink) closeAll() {
	l.transport.CloseIdleConnections()
	l.mu.Lock()
	open := make([]*linkConn, 0, len(l.conns))
	for c := range l.conns {
		open = append(open, c)
	}
	l.mu.Unlock()
	for _, c := range open {
		c.Close()
	}
}

// begin and end bracket a request (or stream) forwarded to the machine.
func (l *machineLink) begin() {
	l.mu.Lock()
	l.active++
	l.lastUsed = time.Now()
	l.mu.Unlock()
}

func (l *machineLink) end() {
	l.mu.Lock()
	l.active--
	l.lastUsed = time.Now()
	l.mu.Unlock()
}

func newMachineLink(rec machineRecord, d machineDialer) *machineLink {
	l := &machineLink{rec: rec, dialer: d, status: machineConnecting, conns: map[*linkConn]struct{}{}}
	l.transport = &http.Transport{
		DialContext:           func(ctx context.Context, _, _ string) (net.Conn, error) { return l.dial(ctx) },
		MaxConnsPerHost:       machineMaxConns,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: machineResponseHeaderWait,
		DisableCompression:    true,
	}
	return l
}

// state is the machine's status and the error behind it.
func (l *machineLink) state() (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.status, l.err
}

// dial opens a bridge connection, or fails at once while the machine waits
// out its backoff. The first connection after a failure also compares the
// machine's apiVersion with this server's (over a connection of its own).
func (l *machineLink) dial(ctx context.Context) (net.Conn, error) {
	l.mu.Lock()
	l.lastUsed = time.Now()
	if l.err != nil && time.Now().Before(l.nextTry) {
		err := l.err
		l.mu.Unlock()
		return nil, err
	}
	checked := l.checked
	l.mu.Unlock()
	if !checked {
		conn, stderr, err := l.dialer.dial(ctx, l.rec)
		if err == nil {
			err = checkMachineHealth(ctx, conn)
			conn.Close()
		}
		if err != nil {
			l.fail(err, stderr)
			return nil, err
		}
		l.mu.Lock()
		l.checked = true
		l.mu.Unlock()
	}
	conn, stderr, err := l.dialer.dial(ctx, l.rec)
	if err != nil {
		l.fail(err, stderr)
		return nil, err
	}
	l.succeed()
	tc := &linkConn{Conn: conn, l: l}
	l.mu.Lock()
	l.conns[tc] = struct{}{}
	l.mu.Unlock()
	return tc, nil
}

// fail records a failed connection: the status, ssh's stderr in the log
// (never in a client's answer) and the next try.
func (l *machineLink) fail(err error, stderr string) {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	status := machineStatus(err)
	if status != l.status {
		log.Printf("machine %s: %s", l.rec.Label, status)
		logSSHStderr(l.rec.Label, stderr)
	}
	l.status, l.err, l.checked = status, err, false
	if l.backoff == 0 {
		l.backoff = machineBackoffMin
	} else {
		l.backoff = min(2*l.backoff, machineBackoffMax)
	}
	l.nextTry = time.Now().Add(l.backoff)
}

func (l *machineLink) succeed() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.status != "online" {
		log.Printf("machine %s: online", l.rec.Label)
	}
	l.status, l.err, l.backoff, l.nextTry = "online", nil, 0, time.Time{}
}

// retryNow drops the backoff, so the next request tries again.
func (l *machineLink) retryNow() {
	l.mu.Lock()
	l.nextTry = time.Time{}
	l.mu.Unlock()
}

// logSSHStderr writes a few lines of ssh's stderr to the log, without
// control characters: the machine writes some of it, and a \r or an escape
// sequence would rewrite the log in a terminal.
func logSSHStderr(label, stderr string) {
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	for i, line := range lines {
		if line = strings.TrimSpace(stripUnsafeRunes(line)); line == "" {
			continue
		}
		if i == 5 {
			log.Printf("machine %s: ssh: (%d more lines)", label, len(lines)-i)
			return
		}
		log.Printf("machine %s: ssh: %.200s", label, line)
	}
}

// machineManager holds the links of every stored machine.
type machineManager struct {
	storePath string
	// fixed replaces the store (the E2E suite's bridges).
	fixed  []machineRecord
	dialer machineDialer
	// keepUp reports whether each machine's master stays up without a
	// client: Web Push has a subscription, so every machine is polled. nil:
	// never.
	keepUp func() bool

	mu    sync.Mutex
	links map[string]*machineLink
	order []string
	done  chan struct{}
	once  sync.Once
}

// machineJanitorEvery is how often idle masters are looked for.
var machineJanitorEvery = time.Minute

// machineIdleStop is how long a master without a client stays up when
// nothing polls it.
var machineIdleStop = 10 * time.Minute

func newMachineManager(storePath string, d machineDialer) *machineManager {
	mm := &machineManager{storePath: storePath, dialer: d, links: map[string]*machineLink{}, done: make(chan struct{})}
	if err := mm.reload(); err != nil {
		log.Printf("machines: %v", err)
	}
	go mm.janitor(machineJanitorEvery)
	return mm
}

// reload reads the store again: a new machine gets a link, a removed one's
// link is stopped, a changed one is replaced.
func (mm *machineManager) reload() error {
	list := mm.fixed
	if mm.storePath != "" {
		var err error
		if list, err = loadMachines(mm.storePath); err != nil {
			return err
		}
	}
	mm.mu.Lock()
	keep := map[string]bool{}
	var dropped []*machineLink
	mm.order = mm.order[:0]
	for _, rec := range list {
		keep[rec.ID] = true
		mm.order = append(mm.order, rec.ID)
		if l, ok := mm.links[rec.ID]; ok && l.rec == rec {
			l.retryNow()
			continue
		} else if ok {
			dropped = append(dropped, l)
		}
		mm.links[rec.ID] = newMachineLink(rec, mm.dialer)
	}
	for id, l := range mm.links {
		if !keep[id] {
			dropped = append(dropped, l)
			delete(mm.links, id)
		}
	}
	mm.mu.Unlock()
	// Stopping an ssh takes up to a second: never while the list is held
	// (the snapshot reads it).
	for _, l := range dropped {
		l.closeAll()
		mm.dialer.forget(l.rec.ID)
	}
	return nil
}

// link is the machine with id, or nil.
func (mm *machineManager) link(id string) *machineLink {
	if mm == nil {
		return nil
	}
	mm.mu.Lock()
	defer mm.mu.Unlock()
	return mm.links[id]
}

// all is every machine, in the store's order.
func (mm *machineManager) all() []*machineLink {
	if mm == nil {
		return nil
	}
	mm.mu.Lock()
	defer mm.mu.Unlock()
	out := make([]*machineLink, 0, len(mm.order))
	for _, id := range mm.order {
		out = append(out, mm.links[id])
	}
	return out
}

// janitor stops the master of a machine nothing used for machineIdleStop,
// unless keepUp.
func (mm *machineManager) janitor(every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-mm.done:
			return
		case <-t.C:
			mm.stopIdle()
		}
	}
}

func (mm *machineManager) stopIdle() {
	if mm.keptUp() {
		return
	}
	for _, l := range mm.all() {
		l.mu.Lock()
		idle := l.active == 0 && !l.lastUsed.IsZero() && time.Since(l.lastUsed) > machineIdleStop
		l.mu.Unlock()
		if idle {
			l.transport.CloseIdleConnections()
			mm.dialer.idle(l.rec.ID)
		}
	}
}

// keptUp reports whether every machine stays up and polled (keepUp).
func (mm *machineManager) keptUp() bool { return mm.keepUp != nil && mm.keepUp() }

// stop closes every connection and stops every ssh.
func (mm *machineManager) stop() {
	if mm == nil {
		return
	}
	mm.once.Do(func() {
		close(mm.done)
		for _, l := range mm.all() {
			l.transport.CloseIdleConnections()
		}
		mm.dialer.stop()
	})
}

// sshDialer is the default dialer: OpenSSH, through a master per machine
// when the OS has ControlMaster.
type sshDialer struct {
	paths  sshPaths
	ctlDir string // "" without multiplexing (Windows)

	mu      sync.Mutex
	masters map[string]*sshProc
	// starting serialises a machine's master start, without holding up
	// the other machines.
	starting map[string]*sync.Mutex
}

func newSSHDialer(paths sshPaths, ctlDir string) *sshDialer {
	d := &sshDialer{paths: paths, masters: map[string]*sshProc{}, starting: map[string]*sync.Mutex{}}
	if runtime.GOOS != "windows" {
		d.ctlDir = ctlDir
		// macOS has no Pdeathsig: masters a server killed hard left
		// behind (re-parented to launchd) go now.
		reapOrphanTerminals(isMachineSSHCmdline)
	}
	return d
}

// isMachineSSHCmdline matches an ssh this server runs for a machine.
func isMachineSSHCmdline(cmdline string) bool {
	return strings.HasPrefix(cmdline, "ssh ") && strings.Contains(cmdline, "HostKeyAlias=termote-")
}

// maxControlPath is the longest ControlPath: OpenSSH binds
// <path>.<16 random characters> first, then renames it, and the longest
// socket path is maxSocketPath (103).
const maxControlPath = 103 - 17

// controlPath is the master socket of machine id, or "" when no dir gives
// a path short enough (the machine then runs without multiplexing).
func (d *sshDialer) controlPath(id string) string {
	if d.ctlDir == "" {
		return ""
	}
	for _, dir := range []string{d.ctlDir, filepath.Join(os.TempDir(), fmt.Sprintf("termote-%d", os.Getuid()))} {
		p := filepath.Join(dir, id)
		if len(p) > maxControlPath {
			continue
		}
		if err := ensureSocketDir(dir); err != nil {
			log.Printf("machines: control dir %s: %v", dir, err)
			continue
		}
		return p
	}
	return ""
}

// masterWait bounds a master's start: until its socket answers.
var masterWait = 15 * time.Second

func (d *sshDialer) dial(ctx context.Context, m machineRecord) (net.Conn, string, error) {
	ctl := d.controlPath(m.ID)
	if ctl != "" {
		if stderr, err := d.ensureMaster(ctx, m, ctl); err != nil {
			return nil, stderr, err
		}
	}
	return dialMachineSSH(ctx, sshBridgeArgv(d.paths, m, ctl))
}

// ensureMaster starts the master of m at ctl unless it runs: a master left
// at ctl by an earlier server is asked to exit, its socket removed.
func (d *sshDialer) ensureMaster(ctx context.Context, m machineRecord, ctl string) (string, error) {
	d.mu.Lock()
	start := d.starting[m.ID]
	if start == nil {
		start = &sync.Mutex{}
		d.starting[m.ID] = start
	}
	d.mu.Unlock()
	start.Lock()
	defer start.Unlock()
	d.mu.Lock()
	p := d.masters[m.ID]
	d.mu.Unlock()
	if p != nil {
		if !p.exited(0) && socketAnswers(ctl) {
			return "", nil
		}
		d.forget(m.ID)
	}
	if fileExists(ctl) {
		exit := sshMasterExitArgv(d.paths, m, ctl)
		if p, err := startSSH(exit); err == nil {
			if !p.exited(2 * time.Second) {
				p.stop()
			}
		}
		os.Remove(ctl)
	}
	p, err := startSSH(sshMasterArgv(d.paths, m, ctl))
	if err != nil {
		return err.Error(), errMachineOffline
	}
	deadline := time.Now().Add(masterWait)
	for !socketAnswers(ctl) {
		if p.exited(50 * time.Millisecond) {
			stderr := p.stderr.String()
			p.stop()
			return stderr, classifySSHError(stderr)
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			stderr := p.stderr.String()
			p.stop()
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			return "the master did not start in time\n" + stderr, errMachineOffline
		}
	}
	d.mu.Lock()
	d.masters[m.ID] = p
	d.mu.Unlock()
	return "", nil
}

// socketAnswers reports whether a Unix socket at path takes a connection.
func socketAnswers(path string) bool {
	c, err := net.DialTimeout("unix", path, 200*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func (d *sshDialer) idle(id string) { d.forget(id) }

// forget stops the master of id.
func (d *sshDialer) forget(id string) {
	d.mu.Lock()
	p := d.masters[id]
	delete(d.masters, id)
	d.mu.Unlock()
	if p != nil {
		p.stop()
	}
}

func (d *sshDialer) stop() {
	d.mu.Lock()
	ids := make([]string, 0, len(d.masters))
	for id := range d.masters {
		ids = append(ids, id)
	}
	d.mu.Unlock()
	for _, id := range ids {
		d.forget(id)
	}
}
