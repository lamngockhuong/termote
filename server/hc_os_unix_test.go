//go:build !windows

package main

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// hcTestListenPipe: named pipes are Windows only.
func hcTestListenPipe(t *testing.T, _ string) net.Listener {
	t.Fatal("no named pipes here")
	return nil
}

// hcForeignSocket listens on a Unix socket whose peer reads as uid (a
// stubbed peer check: the test runs as one user), and returns its path.
func hcForeignSocket(t *testing.T, uid int) string {
	t.Helper()
	sock := filepath.Join(shortTempDir(t), "c.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	old := localPeerUID
	t.Cleanup(func() { localPeerUID = old })
	localPeerUID = func(*net.UnixConn) (int, error) { return uid, nil }
	return sock
}

// A core socket another user serves (HC_SOCKET, or socket in config.toml,
// in a shared directory) is refused, never taken as a core that is not
// running; root's is kept, as Herdr's is.
func TestHcCoreRunningRefusesAnotherUsersSocket(t *testing.T) {
	sock := hcForeignSocket(t, os.Getuid()+4242)
	running, err := hcCoreRunningDefault(context.Background(), []string{"HC_SOCKET=" + sock})
	var pe *herdrPipeUserError
	if running || !errors.As(err, &pe) {
		t.Fatalf("another user's socket: running=%v err=%v", running, err)
	}
	localPeerUID = func(*net.UnixConn) (int, error) { return 0, nil }
	if running, err := hcCoreRunningDefault(context.Background(), []string{"HC_SOCKET=" + sock}); !running || err != nil {
		t.Fatalf("root's socket: running=%v err=%v", running, err)
	}
}

// A full client opening the page never starts hc connect for another user's
// socket: the client is told errHcRefused and the refusal is audited once
// per reason.
func TestHcClientNeverConnectsToAnotherUsersSocket(t *testing.T) {
	logs := captureSyncLog(t)
	sock := hcForeignSocket(t, os.Getuid()+4242)
	c := newHcClient("/usr/bin/hc", []string{"HC_SOCKET=" + sock})
	c.running = hcCoreRunningDefault
	c.starter.setGrace(0)
	var connects atomic.Int32
	c.connect = func(context.Context, string, []string) (*hcConn, error) {
		connects.Add(1)
		return nil, errHcLost
	}
	for range 3 {
		if _, err := c.get(context.Background(), true); !errors.Is(err, errHcRefused) {
			t.Fatalf("err = %v", err)
		}
	}
	time.Sleep(50 * time.Millisecond)
	if n := connects.Load(); n != 0 || c.starter.starting() {
		t.Fatalf("hc connect ran %d times for another user's socket", n)
	}
	if n := strings.Count(logs.String(), "audit: hc socket refused reason="); n != 1 {
		t.Fatalf("%d audit lines for one refused socket:\n%s", n, logs.String())
	}
	if strings.Contains(errHcRefused.msg, sock) {
		t.Fatal("the client is told the socket's path")
	}
}
