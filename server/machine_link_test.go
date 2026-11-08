package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// helperSSHMaster stands in for `ssh -M`: it listens on the control socket
// until it is killed.
func helperSSHMaster() {
	ln, err := net.Listen("unix", os.Getenv("TEST_SSH_CTL"))
	if err != nil {
		os.Exit(1)
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			os.Exit(0)
		}
		c.Close()
	}
}

// fakeDialer answers each dial with err, or a connection whose far end
// answers health with apiVersion v.
type fakeDialer struct {
	t       *testing.T
	mu      sync.Mutex
	err     error
	stderr  string
	v       int
	dials   int
	forgot  []string
	idled   []string
	stopped bool
}

func (d *fakeDialer) dial(ctx context.Context, m machineRecord) (net.Conn, string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.dials++
	if d.err != nil {
		return nil, d.stderr, d.err
	}
	return newHealthConn(d.t, d.v), "", nil
}
func (d *fakeDialer) idle(id string)   { d.mu.Lock(); d.idled = append(d.idled, id); d.mu.Unlock() }
func (d *fakeDialer) forget(id string) { d.mu.Lock(); d.forgot = append(d.forgot, id); d.mu.Unlock() }
func (d *fakeDialer) stop()            { d.mu.Lock(); d.stopped = true; d.mu.Unlock() }

func (d *fakeDialer) set(err error, v int) {
	d.mu.Lock()
	d.err, d.v = err, v
	d.mu.Unlock()
}

// A machine is connecting until its first connection, online after a
// health check that matched, and after a failure waits out a backoff that
// doubles up to its cap, failing requests at once meanwhile.
func TestMachineLinkStatusAndBackoff(t *testing.T) {
	logs := captureLog(t)
	d := &fakeDialer{t: t, v: apiVersion}
	l := newMachineLink(testMachine("0123456789abcdef", "Box", "box"), d)
	if s, _ := l.state(); s != machineConnecting {
		t.Errorf("initial status %q", s)
	}
	c, err := l.dial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if s, _ := l.state(); s != "online" || d.dials != 2 {
		t.Errorf("after the first dial: %q, %d dials (health + connection)", s, d.dials)
	}
	if c, err := l.dial(context.Background()); err != nil || d.dials != 3 {
		t.Errorf("checked machine dials once: %v %d", err, d.dials)
	} else {
		c.Close()
	}

	d.set(errMachineUnauthorized, apiVersion)
	d.stderr = "user@box: Permission denied (publickey)."
	if _, err := l.dial(context.Background()); !errors.Is(err, errMachineUnauthorized) {
		t.Fatalf("unauthorized: %v", err)
	}
	if s, _ := l.state(); s != "unauthorized" {
		t.Errorf("status %q", s)
	}
	if !strings.Contains(logs.String(), "machine Box: ssh: user@box: Permission denied") {
		t.Errorf("ssh stderr not logged:\n%s", logs)
	}
	n := d.dials
	if _, err := l.dial(context.Background()); !errors.Is(err, errMachineUnauthorized) || d.dials != n {
		t.Errorf("during backoff: %v, dialled %d more", err, d.dials-n)
	}
	l.mu.Lock()
	first := l.backoff
	l.nextTry = time.Time{}
	l.mu.Unlock()
	l.dial(context.Background())
	l.mu.Lock()
	second := l.backoff
	l.backoff = machineBackoffMax
	l.nextTry = time.Time{}
	l.mu.Unlock()
	l.dial(context.Background())
	if first != machineBackoffMin || second != 2*machineBackoffMin || l.backoff != machineBackoffMax {
		t.Errorf("backoff %v, %v, %v", first, second, l.backoff)
	}

	// Back online once retried; an older termote there is incompatible.
	d.set(nil, apiVersion+1)
	l.retryNow()
	if _, err := l.dial(context.Background()); !errors.Is(err, errMachineIncompatible) {
		t.Errorf("other apiVersion: %v", err)
	}
	d.set(nil, apiVersion)
	l.retryNow()
	if c, err := l.dial(context.Background()); err != nil {
		t.Errorf("back online: %v", err)
	} else {
		c.Close()
	}
	// The connection itself failing after a good health check.
	d.mu.Lock()
	d.err = nil
	d.mu.Unlock()
	l.mu.Lock()
	l.checked = true
	l.mu.Unlock()
	d.set(errMachineOffline, apiVersion)
	if _, err := l.dial(context.Background()); !errors.Is(err, errMachineOffline) {
		t.Errorf("connection failed: %v", err)
	}
	// A cancelled request does not count as the machine failing.
	before, _ := l.state()
	l.fail(context.Canceled, "")
	if s, _ := l.state(); s != before {
		t.Errorf("cancel changed the status to %q", s)
	}
}

func TestLogSSHStderr(t *testing.T) {
	logs := captureLog(t)
	logSSHStderr("Box", "a\n\nb\nc\nd\ne\nf\ng\n")
	out := logs.String()
	if !strings.Contains(out, "ssh: a") || strings.Contains(out, "ssh: g") || !strings.Contains(out, "more lines") {
		t.Errorf("stderr log:\n%s", out)
	}
	// What the machine wrote cannot move the cursor or color the log
	logs.Reset()
	logSSHStderr("Box", "x\rforged line\x1b[2K\x1b[31m\u202e\n")
	if out := logs.String(); strings.ContainsAny(out, "\r\x1b\u202e") || !strings.Contains(out, "ssh: xforged line[2K[31m") {
		t.Errorf("control characters reached the log: %q", out)
	}
}

// reload follows the store: new machines get a link, removed ones are
// forgotten (their master stopped), changed ones replaced.
func TestMachineManagerReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machines.json")
	a, b := testMachine("0123456789abcdef", "A", "a"), testMachine("1123456789abcdef", "B", "b")
	saveMachines(path, []machineRecord{a, b})
	d := &fakeDialer{t: t, v: apiVersion}
	mm := newMachineManager(path, d)
	t.Cleanup(mm.stop)
	if all := mm.all(); len(all) != 2 || all[0].rec.Label != "A" || mm.link(b.ID) == nil || mm.link("nope") != nil {
		t.Fatalf("links: %+v", all)
	}
	b.Label = "B2"
	saveMachines(path, []machineRecord{b})
	if err := mm.reload(); err != nil {
		t.Fatal(err)
	}
	if mm.link(a.ID) != nil || mm.link(b.ID).rec.Label != "B2" || len(d.forgot) != 2 {
		t.Errorf("after reload: a %v, b %+v, forgot %v", mm.link(a.ID), mm.link(b.ID), d.forgot)
	}
	same := mm.link(b.ID)
	mm.reload()
	if mm.link(b.ID) != same {
		t.Error("an unchanged machine got a new link")
	}
	writeFile(t, path, "{")
	if err := mm.reload(); err == nil {
		t.Error("a broken store was reloaded")
	}
	mm.stop()
	mm.stop()
	if !d.stopped {
		t.Error("stop did not stop the dialer")
	}
	var nilMM *machineManager
	if nilMM.link("x") != nil || nilMM.all() != nil {
		t.Error("nil manager")
	}
	nilMM.stop()
}

// A machine nobody used for machineIdleStop has its master stopped, unless
// Web Push keeps them all up.
func TestMachineManagerStopIdle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machines.json")
	saveMachines(path, []machineRecord{testMachine("0123456789abcdef", "A", "a")})
	d := &fakeDialer{t: t, v: apiVersion}
	mm := newMachineManager(path, d)
	t.Cleanup(mm.stop)
	l := mm.link("0123456789abcdef")
	mm.stopIdle()
	if len(d.idled) != 0 {
		t.Error("a never used machine was idled")
	}
	l.mu.Lock()
	l.lastUsed = time.Now().Add(-machineIdleStop - time.Second)
	l.mu.Unlock()
	mm.keepUp = func() bool { return true }
	mm.stopIdle()
	if len(d.idled) != 0 {
		t.Error("idled while Web Push keeps masters up")
	}
	mm.keepUp = func() bool { return false }
	// A stream still forwarded keeps it in use, however long ago it began
	l.begin()
	l.mu.Lock()
	l.lastUsed = time.Now().Add(-machineIdleStop - time.Second)
	l.mu.Unlock()
	mm.stopIdle()
	if len(d.idled) != 0 {
		t.Error("a machine with an open stream was idled")
	}
	l.end()
	l.mu.Lock()
	l.lastUsed = time.Now().Add(-machineIdleStop - time.Second)
	l.mu.Unlock()
	mm.stopIdle()
	if len(d.idled) != 1 {
		t.Error("an idle machine kept its master")
	}
}

func TestNewServeMachines(t *testing.T) {
	if newServeMachines(serveConfig{}, nil) != nil {
		t.Error("a manager without machines")
	}
	if newServeMachines(serveConfig{MachineBridges: "bad"}, nil) != nil {
		t.Error("a manager from a bridge list with no valid entry")
	}
	mm := newServeMachines(serveConfig{MachineBridges: "Remote=7681@/tmp/run, x, =1@/d, L=x@/d", MachinesFile: "/ignored"}, func() bool { return true })
	t.Cleanup(mm.stop)
	all := mm.all()
	if len(all) != 1 || all[0].rec.Label != "Remote" || !machineIDRe.MatchString(all[0].rec.ID) || !mm.keptUp() {
		t.Fatalf("bridges: %+v", all)
	}
	mm.reload()
	if len(mm.all()) != 1 {
		t.Error("reload changed fixed machines")
	}
	sd := mm.dialer.(*socketDialer)
	old := dialBridgeServer
	t.Cleanup(func() { dialBridgeServer = old })
	var got socketTarget
	dialBridgeServer = func(dir string, port int) (net.Conn, error) {
		got = socketTarget{dir, port}
		return nil, errors.New("none")
	}
	if _, _, err := sd.dial(context.Background(), all[0].rec); !errors.Is(err, errMachineNoServer) || got != (socketTarget{"/tmp/run", 7681}) {
		t.Errorf("socket dial: %v %+v", err, got)
	}
	if _, _, err := sd.dial(context.Background(), machineRecord{ID: "x"}); !errors.Is(err, errMachineOffline) {
		t.Errorf("unknown target: %v", err)
	}
	a, b := net.Pipe()
	defer b.Close()
	dialBridgeServer = func(string, int) (net.Conn, error) { return a, nil }
	if c, _, err := sd.dial(context.Background(), all[0].rec); err != nil || c != a {
		t.Errorf("socket dial ok: %v", err)
	}
	sd.idle("x")
	sd.forget("x")
	sd.stop()

	file := newServeMachines(serveConfig{MachinesFile: filepath.Join(t.TempDir(), "m.json"), MachineSSHDir: "/s", MachineCtlDir: ""}, nil)
	t.Cleanup(file.stop)
	if file == nil || len(file.all()) != 0 {
		t.Error("a store manager")
	}
	bad := filepath.Join(t.TempDir(), "m.json")
	writeFile(t, bad, "{")
	captureLog(t)
	if m := newMachineManager(bad, &fakeDialer{t: t}); m == nil {
		t.Error("a broken store gave no manager")
	} else {
		m.stop()
	}
}

// silentDialer connects to a machine that reads requests and never answers
// them, after answering the first connection's health check when healthy.
type silentDialer struct {
	fakeDialer
	healthy bool
}

func (d *silentDialer) dial(context.Context, machineRecord) (net.Conn, string, error) {
	d.mu.Lock()
	d.dials++
	first := d.dials == 1
	d.mu.Unlock()
	if first && d.healthy {
		return newHealthConn(d.t, apiVersion), "", nil
	}
	mine, theirs := net.Pipe()
	go io.Copy(io.Discard, theirs)
	d.t.Cleanup(func() { theirs.Close() })
	return mine, "", nil
}

// The wait for a machine's answer outlasts the longest request a machine
// serves: an agent message at its limits, and a worktree change.
func TestMachineResponseHeaderWaitBound(t *testing.T) {
	// The longest: every image, the text split around them, the draft
	// replaced first (agentInput's message handler).
	var textWait time.Duration
	for range agentMaxImages + 1 {
		textWait += pasteGrowMost(strings.Repeat("x", agentMaxText/(agentMaxImages+1)))
	}
	message := messageBudget(agentMaxImages, textWait) + agentConfirmWait + muxTimeout
	if machineResponseHeaderWait <= message || machineResponseHeaderWait <= worktreeLockWait+worktreeTimeout {
		t.Errorf("machineResponseHeaderWait %v, an agent message takes up to %v", machineResponseHeaderWait, message)
	}
}

// A machine that never answers its health check or a request frees the
// connection after machineHealthWait or machineResponseHeaderWait, not when
// the client gives up.
func TestMachineLinkResponseHeaderWait(t *testing.T) {
	old, oldHealth := machineResponseHeaderWait, machineHealthWait
	machineResponseHeaderWait, machineHealthWait = 50*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() { machineResponseHeaderWait, machineHealthWait = old, oldHealth })
	for _, healthy := range []bool{false, true} {
		l := newMachineLink(testMachine("0123456789abcdef", "Box", "box"), &silentDialer{fakeDialer: fakeDialer{t: t}, healthy: healthy})
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "GET", "http://machine/api/mux/snapshot", nil)
		start := time.Now()
		_, err := l.transport.RoundTrip(req)
		cancel()
		if err == nil || time.Since(start) > 2*time.Second {
			t.Errorf("healthy=%v: RoundTrip = %v after %v, want a header timeout", healthy, err, time.Since(start))
		}
	}
}
