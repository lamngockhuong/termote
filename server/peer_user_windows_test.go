package main

import (
	"encoding/binary"
	"net"
	"net/netip"
	"testing"

	"golang.org/x/sys/windows"
)

// tcpConnRow builds a MIB_TCPROW_OWNER_PID or MIB_TCP6ROW_OWNER_PID.
func tcpConnRow(family uint32, state uint32, local, remote netip.AddrPort, pid uint32) []byte {
	if family == windows.AF_INET6 {
		b := make([]byte, tcp6RowOwnerPIDSize)
		l, r := local.Addr().As16(), remote.Addr().As16()
		copy(b[0:], l[:])
		binary.BigEndian.PutUint16(b[20:], local.Port())
		copy(b[24:], r[:])
		binary.BigEndian.PutUint16(b[44:], remote.Port())
		binary.LittleEndian.PutUint32(b[48:], state)
		binary.LittleEndian.PutUint32(b[52:], pid)
		return b
	}
	b := make([]byte, tcpRowOwnerPIDSize)
	l, r := local.Addr().As4(), remote.Addr().As4()
	binary.LittleEndian.PutUint32(b[0:], state)
	copy(b[4:], l[:])
	binary.BigEndian.PutUint16(b[8:], local.Port())
	copy(b[12:], r[:])
	binary.BigEndian.PutUint16(b[16:], remote.Port())
	binary.LittleEndian.PutUint32(b[20:], pid)
	return b
}

func TestTCPConnPID(t *testing.T) {
	server := netip.MustParseAddrPort("127.0.0.1:7690")
	client := netip.MustParseAddrPort("127.0.0.2:50000")
	closed := netip.MustParseAddrPort("127.0.0.1:50001")
	table := binary.LittleEndian.AppendUint32(nil, 3)
	table = append(table, tcpConnRow(windows.AF_INET, mibTCPStateEstab, server, client, 10)...) // the server's end
	table = append(table, tcpConnRow(windows.AF_INET, mibTCPStateEstab, client, server, 11)...)
	table = append(table, tcpConnRow(windows.AF_INET, 11, closed, server, 12)...) // TIME_WAIT
	if pid, ok := tcpConnPID(table, windows.AF_INET, client, server); !ok || pid != 11 {
		t.Errorf("client: %d %v", pid, ok)
	}
	if _, ok := tcpConnPID(table, windows.AF_INET, closed, server); ok {
		t.Error("TIME_WAIT row found")
	}
	// IPv6 and IPv4-mapped rows.
	server6 := netip.MustParseAddrPort("[::1]:7690")
	client6 := netip.MustParseAddrPort("[::1]:50002")
	mapped := netip.AddrPortFrom(netip.AddrFrom16(client.Addr().As16()), 50003)
	mappedServer := netip.AddrPortFrom(netip.AddrFrom16(server.Addr().As16()), server.Port())
	table6 := binary.LittleEndian.AppendUint32(nil, 2)
	table6 = append(table6, tcpConnRow(windows.AF_INET6, mibTCPStateEstab, client6, server6, 13)...)
	table6 = append(table6, tcpConnRow(windows.AF_INET6, mibTCPStateEstab, mapped, mappedServer, 14)...)
	if pid, ok := tcpConnPID(table6, windows.AF_INET6, client6, server6); !ok || pid != 13 {
		t.Errorf("IPv6: %d %v", pid, ok)
	}
	if pid, ok := tcpConnPID(table6, windows.AF_INET6, netip.AddrPortFrom(client.Addr(), 50003), server); !ok || pid != 14 {
		t.Errorf("mapped: %d %v", pid, ok)
	}
	// A count larger than the rows present stops at the end.
	short := binary.LittleEndian.AppendUint32(nil, 9)
	short = append(short, table[4:]...)
	if _, ok := tcpConnPID(short, windows.AF_INET, netip.MustParseAddrPort("127.0.0.1:1"), server); ok {
		t.Error("short table")
	}
	if _, ok := tcpConnPID(nil, windows.AF_INET, client, server); ok {
		t.Error("empty table")
	}
}

// The real table finds this process's own client end, which runs as the
// current user.
func TestPeerOwnerWindows(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	s, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	client, _ := connAddrPort(s.RemoteAddr())
	server, _ := connAddrPort(s.LocalAddr())
	self, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	if id, err := peerOwner(client, server); err != nil || id != self.User.Sid.String() {
		t.Errorf("own connection: %q %v, want %s", id, err, self.User.Sid)
	}
}
