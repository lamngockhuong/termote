//go:build !linux && !darwin && !windows

package main

import (
	"errors"
	"net"
)

// unixPeerUID cannot tell the server's user here, so the CLI never trusts
// the local socket and uses TCP.
func unixPeerUID(*net.UnixConn) (int, error) {
	return 0, errors.New("peer credentials are not supported on this OS")
}

// connPeerPID cannot tell the peer's pid here.
func connPeerPID(net.Conn) int { return 0 }
