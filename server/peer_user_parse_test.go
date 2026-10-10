package main

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/netip"
	"strings"
	"testing"
)

// procNetHex writes an address as /proc/net/tcp does: 32-bit words in host
// byte order, the port as plain hex.
func procNetHex(ap netip.AddrPort, v6 bool) string {
	var raw []byte
	if v6 {
		a := ap.Addr().As16()
		raw = a[:]
	} else {
		a := ap.Addr().As4()
		raw = a[:]
	}
	out := make([]byte, len(raw))
	for i := 0; i < len(raw); i += 4 {
		binary.BigEndian.PutUint32(out[i:], binary.NativeEndian.Uint32(raw[i:]))
	}
	return strings.ToUpper(hex.EncodeToString(out)) + fmt.Sprintf(":%04X", ap.Port())
}

func procNetRow(local, remote netip.AddrPort, v6 bool, state string, uid, inode int) string {
	return fmt.Sprintf("   0: %s %s %s 00000000:00000000 00:00000000 00000000 %5d        0 %d 1 0000000000000000 20 4 30 10 -1",
		procNetHex(local, v6), procNetHex(remote, v6), state, uid, inode)
}

func TestParseProcNetAddr(t *testing.T) {
	// 127.0.0.1:7680 on a little-endian host, as the kernel prints it.
	if binary.NativeEndian.Uint16([]byte{1, 0}) == 1 {
		if ap, ok := parseProcNetAddr("0100007F:1E00"); !ok || ap != netip.MustParseAddrPort("127.0.0.1:7680") {
			t.Errorf("IPv4: %v %v", ap, ok)
		}
	}
	for _, s := range []string{"127.0.0.2:40000", "[::1]:7680", "[fe80::1]:1"} {
		ap := netip.MustParseAddrPort(s)
		if got, ok := parseProcNetAddr(procNetHex(ap, ap.Addr().Is6())); !ok || got != ap {
			t.Errorf("%s: %v %v", s, got, ok)
		}
	}
	// IPv4-mapped in tcp6 comes back as plain IPv4.
	mapped := netip.AddrPortFrom(netip.AddrFrom16(netip.MustParseAddr("127.0.0.1").As16()), 80)
	if got, ok := parseProcNetAddr(procNetHex(mapped, true)); !ok || got != netip.MustParseAddrPort("127.0.0.1:80") {
		t.Errorf("mapped: %v %v", got, ok)
	}
	for _, bad := range []string{"", "0100007F", "0100007F:1E", "XYZ:1E00", "01000:1E00", "0100007F:1E0Z"} {
		if _, ok := parseProcNetAddr(bad); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestProcNetConnOwner(t *testing.T) {
	server := netip.MustParseAddrPort("127.0.0.1:7680")
	other := netip.MustParseAddrPort("127.0.0.1:50000")
	mine := netip.MustParseAddrPort("127.0.0.1:50001")
	alias := netip.MustParseAddrPort("127.0.0.2:50002")
	closed := netip.MustParseAddrPort("127.0.0.1:50003")
	server6 := netip.MustParseAddrPort("[::1]:7680")
	v6 := netip.MustParseAddrPort("[::1]:50004")
	mapped := netip.MustParseAddrPort("127.0.0.1:50005")
	accepted := netip.MustParseAddrPort("127.0.0.1:50006")
	tcp := strings.Join([]string{
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		procNetRow(server, netip.MustParseAddrPort("0.0.0.0:0"), false, "0A", 1000, 10),
		procNetRow(other, server, false, "01", 1001, 11),
		procNetRow(server, other, false, "01", 1000, 12), // the server's end
		procNetRow(mine, server, false, "01", 1000, 13),
		procNetRow(alias, server, false, "01", 1002, 14),
		// Closed: the kernel prints uid 0 and no inode.
		procNetRow(closed, server, false, "06", 0, 0),
		// The server's end of a connection whose client end is gone.
		procNetRow(server, accepted, false, "01", 1000, 15),
	}, "\n")
	tcp6 := strings.Join([]string{
		procNetRow(v6, server6, true, "01", 1003, 16),
		procNetRow(mapped, server, true, "01", 1004, 17),
		procNetRow(netip.MustParseAddrPort("[::1]:50007"), server6, true, "01", 0, 0),
	}, "\n")
	for _, tc := range []struct {
		table          string
		client, server netip.AddrPort
		want           string
		found, closed  bool
	}{
		{tcp, other, server, "1001", true, false},
		{tcp, mine, server, "1000", true, false},
		{tcp, alias, server, "1002", true, false},
		{tcp, closed, server, "", false, true},
		// Only the server's end: the client end is absent, not closed.
		{tcp, accepted, server, "", false, false},
		{tcp6, v6, server6, "1003", true, false},
		{tcp6, mapped, server, "1004", true, false},
		{tcp6, netip.MustParseAddrPort("[::1]:50007"), server6, "", false, true},
		{tcp, other, netip.MustParseAddrPort("127.0.0.1:7681"), "", false, false},
	} {
		got, found, isClosed := procNetConnOwner(tc.table, tc.client, tc.server)
		if got != tc.want || found != tc.found || isClosed != tc.closed {
			t.Errorf("%v → %v: %q %v %v, want %q %v %v", tc.client, tc.server, got, found, isClosed, tc.want, tc.found, tc.closed)
		}
	}
}
