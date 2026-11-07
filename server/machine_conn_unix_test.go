//go:build !windows

package main

import (
	"context"
	"errors"
	"io"
	"strings"
	"syscall"
	"testing"
	"time"
)

// shArgv stands in for ssh: a shell script with the same stdio.
func shArgv(script string) []string { return []string{"sh", "-c", script} }

// A process that greets like the bridge is a connection: bytes go both
// ways, and Close stops it.
func TestDialMachineSSHGreeting(t *testing.T) {
	conn, _, err := dialMachineSSH(context.Background(), shArgv(`printf 'TERMOTE-BRIDGE 1 2.0.0\n'; exec cat`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write([]byte("echo\n")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "echo\n" {
		t.Fatalf("echo: %q %v", buf, err)
	}
	if conn.LocalAddr().String() != "machine" || conn.RemoteAddr().Network() != "ssh" {
		t.Error("addresses")
	}
	if conn.SetDeadline(time.Time{}) != nil || conn.SetReadDeadline(time.Time{}) != nil || conn.SetWriteDeadline(time.Time{}) != nil {
		t.Error("deadlines")
	}
	mc := conn.(*machineConn)
	pid := mc.p.cmd.Process.Pid
	conn.Close()
	conn.Close()
	if err := syscall.Kill(pid, 0); err == nil {
		t.Errorf("ssh %d still runs after Close", pid)
	}
}

// What ssh says on stderr when it gives no greeting names the status.
func TestDialMachineSSHFailures(t *testing.T) {
	cases := map[string]error{
		`echo 'user@box: Permission denied (publickey).' >&2; exit 255`:             errMachineUnauthorized,
		`echo 'Host key verification failed.' >&2; exit 255`:                        errMachineHostKey,
		`echo '[ERROR] the termote server is not running here: x' >&2; exit 1`:      errMachineNoServer,
		`echo 'ssh: connect to host box port 22: Connection refused' >&2; exit 255`: errMachineOffline,
		`echo 'sh: 1: bridge: command not found' >&2; exit 127`:                     errMachineIncompatible,
		`echo 'Welcome to Ubuntu'; exec cat`:                                        errMachineIncompatible,
		`printf 'TERMOTE-BRIDGE 2 9.0.0\n'; exec cat`:                               errMachineIncompatible,
	}
	for script, want := range cases {
		_, stderr, err := dialMachineSSH(context.Background(), shArgv(script))
		if !errors.Is(err, want) {
			t.Errorf("%s: %v (stderr %q), want %v", script, err, stderr, want)
		}
	}
	if _, _, err := dialMachineSSH(context.Background(), []string{"/nonexistent/ssh"}); !errors.Is(err, errMachineOffline) {
		t.Errorf("missing ssh: %v", err)
	}
}

// No greeting in time: offline, and the process is gone. A cancelled
// context ends the wait too.
func TestDialMachineSSHTimeoutAndCancel(t *testing.T) {
	old := bridgeGreetingWait
	bridgeGreetingWait = 50 * time.Millisecond
	t.Cleanup(func() { bridgeGreetingWait = old })
	if _, _, err := dialMachineSSH(context.Background(), shArgv(`exec sleep 30`)); !errors.Is(err, errMachineOffline) {
		t.Errorf("timeout: %v", err)
	}
	bridgeGreetingWait = 10 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	if _, _, err := dialMachineSSH(ctx, shArgv(`exec sleep 30`)); !errors.Is(err, context.Canceled) {
		t.Errorf("cancel: %v", err)
	}
}

// A child ssh leaves behind (a ProxyCommand, a shell's job) dies with the
// group when the connection closes.
func TestDialMachineSSHKillsGroup(t *testing.T) {
	conn, _, err := dialMachineSSH(context.Background(), shArgv(`sleep 30 & echo $! >&2; printf 'TERMOTE-BRIDGE 1 x\n'; exec cat`))
	if err != nil {
		t.Fatal(err)
	}
	mc := conn.(*machineConn)
	time.Sleep(50 * time.Millisecond)
	child := strings.TrimSpace(mc.p.stderr.String())
	conn.Close()
	var pid int
	for _, c := range child {
		pid = pid*10 + int(c-'0')
	}
	time.Sleep(50 * time.Millisecond)
	if pid == 0 {
		t.Fatalf("no child pid in %q", child)
	}
	if err := syscall.Kill(pid, 0); err == nil {
		t.Errorf("child %d of ssh survived Close", pid)
	}
}

// An ssh that ignores SIGTERM is killed.
func TestSSHProcKillEscalates(t *testing.T) {
	p, err := startSSH(shArgv(`trap '' TERM; printf 'TERMOTE-BRIDGE 1 x\n'; while :; do sleep 0.05; done`))
	if err != nil {
		t.Fatal(err)
	}
	p.stdout.ReadString('\n')
	start := time.Now()
	p.stop()
	if time.Since(start) < sshKillWait/2 {
		t.Error("stop did not wait for SIGTERM first")
	}
}

func TestMachineStatusNames(t *testing.T) {
	for err, want := range map[error]string{nil: "online", errMachineUnauthorized: "unauthorized", errMachineHostKey: "hostkey",
		errMachineIncompatible: "incompatible", errMachineOffline: "offline", errMachineNoServer: "offline"} {
		if got := machineStatus(err); got != want {
			t.Errorf("machineStatus(%v) = %q", err, got)
		}
	}
	var b lockedCapped
	b.Write([]byte(strings.Repeat("x", sshStderrMax+10)))
	if len(b.String()) != sshStderrMax {
		t.Errorf("capped at %d", len(b.String()))
	}
}
