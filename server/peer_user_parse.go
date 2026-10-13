package main

import (
	"encoding/binary"
	"encoding/hex"
	"net/netip"
	"strings"
)

// procNetConnOwner returns the uid of the socket in a /proc/net/tcp or tcp6
// listing whose local end is client and remote end is server: the client
// end of a connection to this server. Only an ESTABLISHED row (01) with an
// inode counts: the kernel prints uid 0 for a socket already closed
// (TIME_WAIT, FIN_WAIT), so such a row would pass for root.
//
//	sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode
//	0: 0100007F:D431 0100007F:1E00 01 00000000:00000000 00:00000000 00000000  1000        0 12345
//
// closed reports a row of the connection in another state: its client end
// exists but is no longer live.
// procNetIndex holds the rows of /proc/net/tcp listings by their local and
// remote ends, read once and asked for many connections.
type procNetIndex map[[2]netip.AddrPort]procNetConn

// procNetConn is a connection's row: its uid, and whether it is live
// (ESTABLISHED with an inode).
type procNetConn struct {
	uid  string
	live bool
}

// add indexes the rows of table; a live row wins over a closed one of the
// same ends.
func (x procNetIndex) add(table string) {
	for line := range strings.Lines(table) {
		f := strings.Fields(line)
		if len(f) < 10 {
			continue
		}
		local, ok1 := parseProcNetAddr(f[1])
		remote, ok2 := parseProcNetAddr(f[2])
		if !ok1 || !ok2 {
			continue
		}
		k := [2]netip.AddrPort{local, remote}
		if x[k].live {
			continue
		}
		x[k] = procNetConn{uid: f[7], live: f[3] == "01" && f[9] != "0"}
	}
}

// owner returns the uid of the indexed row whose local end is client and
// remote end is server: the client end of a connection to this server.
// closed reports a row of the connection that is no longer live.
func (x procNetIndex) owner(client, server netip.AddrPort) (uid string, found, closed bool) {
	c, ok := x[[2]netip.AddrPort{client, server}]
	switch {
	case !ok:
		return "", false, false
	case !c.live:
		return "", false, true
	}
	return c.uid, true, false
}

// parseProcNetAddr reads "ADDR:PORT" of /proc/net/tcp: the address as 32-bit
// words in host byte order (one for IPv4, four for IPv6), the port as a
// plain hex number. An IPv4-mapped address comes back unmapped.
func parseProcNetAddr(s string) (netip.AddrPort, bool) {
	hexAddr, hexPort, ok := strings.Cut(s, ":")
	if !ok || len(hexPort) != 4 {
		return netip.AddrPort{}, false
	}
	raw, err := hex.DecodeString(hexAddr)
	if err != nil || len(raw) != 4 && len(raw) != 16 {
		return netip.AddrPort{}, false
	}
	b := make([]byte, len(raw))
	for i := 0; i < len(raw); i += 4 {
		binary.NativeEndian.PutUint32(b[i:], binary.BigEndian.Uint32(raw[i:]))
	}
	addr, _ := netip.AddrFromSlice(b)
	port, err := hex.DecodeString(hexPort)
	if err != nil {
		return netip.AddrPort{}, false
	}
	return netip.AddrPortFrom(addr.Unmap(), binary.BigEndian.Uint16(port)), true
}
