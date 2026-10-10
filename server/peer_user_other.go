//go:build !linux && !windows

package main

import "net/netip"

// peerOwner is nil here: macOS can tell a connection's owner only through
// lsof, 50 to 200 ms a connection, so a native server on it checks no
// connection's user.
var peerOwner func(client, server netip.AddrPort) (string, error)

const peerIDKey = "uid"

func trustedPeerIDs() []string { return nil }

func selfPeerID() string { return "" }

func foreignLoopbackPossible() bool { return false }
