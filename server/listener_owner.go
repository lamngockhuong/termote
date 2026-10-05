package main

import "net"

// The CLI sends the saved password to whatever answers on 127.0.0.1:port.
// While the server is stopped, any local user can listen there, so the
// password goes only to a listener the current user (or root/SYSTEM, which
// can read the config anyway) runs; root also runs a container runtime's
// port proxy.

// healthUntrusted is fetchHealth's code when the port answers and a
// listener of another user was seen on it: the password was not sent.
const healthUntrusted = -1

// healthUnverified is fetchHealth's code when the port answers but no
// listener could be seen at all (a container runtime that forwards the port
// without a proxy process, lsof missing on macOS): the password was not sent.
const healthUnverified = -2

// untrustedListenerMsg and unverifiedListenerMsg explain the two codes.
const (
	untrustedListenerMsg  = "the port is held by a process of another user; the saved password was not sent"
	unverifiedListenerMsg = "cannot tell which user listens on the port; the saved password was not sent"
)

// listenerOwner is what the sockets listening on a port show of their owners.
type listenerOwner int

const (
	listenerNoneSeen     listenerOwner = iota // nothing seen listening
	listenerTrustedOwner                      // each the current user or root/SYSTEM
	listenerOtherOwner                        // at least one of another user
)

// listenerOwnerOf finds who listens on port. Tests replace it.
var listenerOwnerOf = listenerOwnedLocally

// untrustedConn checks conn, just made to 127.0.0.1:port, before anything is
// sent on it: every listener on port, then the owner of conn's server end
// where the system shows it. It returns 0 when the password may go, else
// healthUntrusted or healthUnverified.
func untrustedConn(port int, conn net.Conn) int {
	owner := listenerOwnerOf(port)
	if owner == listenerTrustedOwner {
		owner = connPeerOwner(port, conn)
	}
	switch owner {
	case listenerTrustedOwner:
		return 0
	case listenerOtherOwner:
		return healthUntrusted
	default:
		return healthUnverified
	}
}

// ownerOf judges the owners seen: each self or root (uid 0), or not.
func ownerOf(uids []int, self int) listenerOwner {
	if len(uids) == 0 {
		return listenerNoneSeen
	}
	for _, uid := range uids {
		if uid != self && uid != 0 {
			return listenerOtherOwner
		}
	}
	return listenerTrustedOwner
}
