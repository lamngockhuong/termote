package main

import (
	"net"
	"testing"
)

// The server end of a connection to a listener this process opened is the
// current user's, accepted or not.
func TestConnPeerOwnerSelf(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if got := connPeerOwner(port, conn); got != listenerTrustedOwner {
		t.Errorf("own connection = %v", got)
	}
	if got := untrustedConn(port, conn); got != 0 {
		t.Errorf("untrustedConn = %d", got)
	}
	// Not a TCP connection: nothing seen.
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	if got := connPeerOwner(port, a); got != listenerNoneSeen {
		t.Errorf("pipe = %v", got)
	}
}
