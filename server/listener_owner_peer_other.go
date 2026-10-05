//go:build !linux

package main

import "net"

// connPeerOwner has nothing to add here to the listeners checked after the
// connection was made: lsof run by a user does not see another user's
// sockets, and the Windows TCP table is read by listener.
func connPeerOwner(int, net.Conn) listenerOwner { return listenerTrustedOwner }
