package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// A connection to another termote is an ssh process: its stdin and stdout
// are the bytes of `termote bridge` there, after the greeting line. Closing
// the connection stops the process and anything in its group (Unix) or job
// (Windows); on Linux it also dies with the server (Pdeathsig).

// Why a machine cannot be reached, as a status the PWA shows and the CLI
// prints. ssh's own text stays in the server log.
var (
	errMachineOffline      = errors.New("offline")
	errMachineUnauthorized = errors.New("unauthorized")
	errMachineHostKey      = errors.New("host key changed")
	errMachineIncompatible = errors.New("incompatible")
	errMachineNoServer     = errors.New("no termote server")
)

// machineStatus names err as a status of GET /api/mux/machines.
func machineStatus(err error) string {
	switch {
	case err == nil:
		return "online"
	case errors.Is(err, errMachineUnauthorized):
		return "unauthorized"
	case errors.Is(err, errMachineHostKey):
		return "hostkey"
	case errors.Is(err, errMachineIncompatible):
		return "incompatible"
	}
	return "offline"
}

// bridgeGreetingWait bounds reading the greeting: the SSH handshake, or the
// master's channel, then the bridge's first line.
var bridgeGreetingWait = 10 * time.Second

// sshStderrMax keeps that much of an ssh's stderr for the log and the
// classification.
const sshStderrMax = 4096

// lockedCapped is a capped buffer safe to read while ssh still writes it.
type lockedCapped struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedCapped) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := sshStderrMax - b.buf.Len(); room > 0 {
		b.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

func (b *lockedCapped) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// sshProc is one running ssh.
type sshProc struct {
	sshProcOS
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr *lockedCapped
	waited chan struct{}
	once   sync.Once
}

// startSSH runs argv with its stdio piped.
var startSSH = func(argv []string) (*sshProc, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = observerSysProcAttr()
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	p := &sshProc{cmd: cmd, stdin: in, stdout: bufio.NewReader(out), stderr: &lockedCapped{}, waited: make(chan struct{})}
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	if err := p.attach(); err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return nil, err
	}
	go func() {
		cmd.Wait()
		close(p.waited)
	}()
	return p, nil
}

// stop ends the process and its group, once, and waits for it.
func (p *sshProc) stop() {
	p.once.Do(func() {
		p.stdin.Close()
		p.kill()
		<-p.waited
	})
}

// exited reports whether ssh exited within d.
func (p *sshProc) exited(d time.Duration) bool {
	select {
	case <-p.waited:
		return true
	case <-time.After(d):
		return false
	}
}

// classifySSHError names why ssh gave no greeting, from its stderr: the
// remote bridge's own line, or OpenSSH's.
func classifySSHError(stderr string) error {
	switch {
	case strings.Contains(stderr, "Permission denied"):
		return errMachineUnauthorized
	case strings.Contains(stderr, "Host key verification failed"),
		strings.Contains(stderr, "REMOTE HOST IDENTIFICATION HAS CHANGED"),
		strings.Contains(stderr, "host key is known"):
		return errMachineHostKey
	case strings.Contains(stderr, "not running here"), strings.Contains(stderr, "no native termote here"):
		return errMachineNoServer
	case strings.Contains(stderr, "command not found"), strings.Contains(stderr, "not recognized"),
		strings.Contains(stderr, "unknown command: bridge"):
		// A key without the forced command (the shell ran "bridge"), or a
		// termote too old to bridge.
		return errMachineIncompatible
	}
	return errMachineOffline
}

// machineConn is a net.Conn over an ssh's stdio.
type machineConn struct {
	p *sshProc
}

func (c *machineConn) Read(b []byte) (int, error)  { return c.p.stdout.Read(b) }
func (c *machineConn) Write(b []byte) (int, error) { return c.p.stdin.Write(b) }
func (c *machineConn) Close() error                { c.p.stop(); return nil }

func (c *machineConn) LocalAddr() net.Addr              { return machineAddr{} }
func (c *machineConn) RemoteAddr() net.Addr             { return machineAddr{} }
func (c *machineConn) SetDeadline(time.Time) error      { return nil }
func (c *machineConn) SetReadDeadline(time.Time) error  { return nil }
func (c *machineConn) SetWriteDeadline(time.Time) error { return nil }
func (machineAddr) Network() string                     { return "ssh" }
func (machineAddr) String() string                      { return "machine" }

type machineAddr struct{}

// dialMachineSSH runs argv and returns the connection once the bridge's
// greeting came, or why it did not (an error of machineStatus, with ssh's
// stderr for the log only).
func dialMachineSSH(ctx context.Context, argv []string) (net.Conn, string, error) {
	p, err := startSSH(argv)
	if err != nil {
		return nil, err.Error(), errMachineOffline
	}
	type result struct {
		line string
		err  error
	}
	got := make(chan result, 1)
	go func() {
		line, err := p.stdout.ReadString('\n')
		got <- result{line, err}
	}()
	timer := time.NewTimer(bridgeGreetingWait)
	defer timer.Stop()
	var r result
	select {
	case r = <-got:
	case <-timer.C:
		p.stop()
		return nil, "no greeting from the bridge in time\n" + p.stderr.String(), errMachineOffline
	case <-ctx.Done():
		p.stop()
		return nil, "", ctx.Err()
	}
	if r.err != nil {
		// Let ssh finish writing why it gave up.
		p.exited(2 * time.Second)
		p.stop()
		stderr := p.stderr.String()
		return nil, stderr, classifySSHError(stderr)
	}
	if !strings.HasPrefix(r.line, bridgeGreeting) {
		// A shell answered: a key installed without the forced command,
		// or a termote too old to bridge.
		p.stop()
		return nil, "unexpected first line from the machine", errMachineIncompatible
	}
	return &machineConn{p: p}, "", nil
}
