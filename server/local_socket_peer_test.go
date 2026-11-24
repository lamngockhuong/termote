//go:build linux || darwin

package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// A request over the local socket carries the pid of the process at its
// other end, for the audit log; a TCP one carries none.
func TestLocalPeerPID(t *testing.T) {
	dir, err := os.MkdirTemp("", "tp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	ln, err := net.Listen("unix", filepath.Join(dir, "s.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	c, err := net.Dial("unix", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	s, err := localSocketListener{ln}.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if got := localPeerPID(localSocketConnContext(context.Background(), s)); got != os.Getpid() {
		t.Errorf("peer pid %d, want %d", got, os.Getpid())
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	if got := localPeerPID(localSocketConnContext(context.Background(), a)); got != 0 {
		t.Errorf("a connection not on the socket: %d", got)
	}
}
