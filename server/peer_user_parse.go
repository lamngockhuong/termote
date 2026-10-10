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
func procNetConnOwner(table string, client, server netip.AddrPort) (uid string, found, closed bool) {
	for _, line := range strings.Split(table, "\n") {
		f := strings.Fields(line)
		if len(f) < 10 {
			continue
		}
		local, ok1 := parseProcNetAddr(f[1])
		remote, ok2 := parseProcNetAddr(f[2])
		if !ok1 || !ok2 || local != client || remote != server {
			continue
		}
		if f[3] != "01" || f[9] == "0" {
			closed = true
			continue
		}
		return f[7], true, false
	}
	return "", false, closed
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
