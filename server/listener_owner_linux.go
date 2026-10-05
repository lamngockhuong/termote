package main

import (
	"net"
	"os"
)

// listenerOwnedLocally reads the owners of the sockets listening on port from
// /proc/net/tcp and tcp6, which list every user's sockets with their uid.
// Every listener on the port counts, whatever its address.
func listenerOwnedLocally(port int) listenerOwner {
	var uids []int
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		uids = append(uids, procNetListenerUIDs(string(b), port)...)
	}
	return ownerOf(uids, os.Getuid())
}

// connPeerOwner reads the owner of conn's server end from /proc/net/tcp and
// tcp6: the socket on port whose peer is conn's local port, both on
// 127.0.0.1. It holds the uid of the listener that took the connection, even
// before it is accepted or once that listener is closed.
func connPeerOwner(port int, conn net.Conn) listenerOwner {
	local, ok := conn.LocalAddr().(*net.TCPAddr)
	if !ok {
		return listenerNoneSeen
	}
	var uids []int
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		uids = append(uids, procNetPeerUIDs(string(b), port, local.Port)...)
	}
	return ownerOf(uids, os.Getuid())
}
