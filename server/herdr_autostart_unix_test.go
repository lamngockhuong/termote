//go:build !windows

package main

import (
	"context"
	"net"
	"syscall"
	"testing"
)

// A socket file left by a herdr that died refuses connections: nobody
// listens, so herdr is started (and replaces the file).
func TestHerdrNotListeningStaleSocket(t *testing.T) {
	path := fakeSocketPath(t)
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	ln.Close()
	_, err = dialHerdr(context.Background(), path)
	if err == nil || !herdrNotListening(err) {
		t.Fatalf("dial of a stale socket = %v, not taken as no herdr", err)
	}
}

func TestHerdrAutostartUnixHelpers(t *testing.T) {
	if herdrExeName("herdr") != "herdr" || !herdrRunnable("/usr/bin/herdr") || herdrStartRefused(syscall.EACCES) {
		t.Error("unix helpers")
	}
	attrs := herdrServerSysProcAttrs()
	if len(attrs) != 1 || !attrs[0].Setsid {
		t.Errorf("attrs = %+v", attrs)
	}
}
