package main

import (
	"net"
	"net/netip"
	"testing"

	"golang.org/x/sys/windows"
)

// A listener table of each family with one row on port 7690 and one
// elsewhere: only the first row's owner comes back, with its bind time.
func TestTCPListenerOwners(t *testing.T) {
	any4 := netip.MustParseAddrPort("0.0.0.0:0")
	for _, tt := range []struct {
		family     uint32
		on, others netip.AddrPort
	}{
		{windows.AF_INET, netip.MustParseAddrPort("127.0.0.1:7690"), netip.MustParseAddrPort("127.0.0.1:8080")},
		{windows.AF_INET6, netip.MustParseAddrPort("[::1]:7690"), netip.MustParseAddrPort("[::1]:8080")},
	} {
		const listen = 2 // MIB_TCP_STATE_LISTEN
		table := tcpConnTable(2,
			tcpConnRow(tt.family, listen, tt.on, any4, 42, 500),
			tcpConnRow(tt.family, listen, tt.others, any4, 43, 501))
		if got := tcpListenerOwners(table, tt.family, 7690); len(got) != 1 || got[0] != (tcpConnOwner{42, 500}) {
			t.Errorf("family %d: owners = %v, want [{42 500}]", tt.family, got)
		}
		// A count larger than the rows present stops at the end.
		short := tcpConnTable(5)
		short = append(short, table[tcpModuleRowsOffset:]...)
		if got := tcpListenerOwners(short, tt.family, 8080); len(got) != 1 || got[0].pid != 43 {
			t.Errorf("family %d short table: owners = %v", tt.family, got)
		}
	}
}

// A listener counts as trusted only when every owner runs as this user or
// SYSTEM and was created before its socket was bound; a service
// whose token cannot be read is not trusted here.
func TestListenerOwnersTrusted(t *testing.T) {
	oldOpen, oldServices := openPeerProcess, runningServicePIDs
	defer func() { openPeerProcess, runningServicePIDs = oldOpen, oldServices }()
	self := selfPeerID()
	procs := map[uint32]fakePeerProcess{
		1: {createdAt: 100, sid: self},
		2: {createdAt: 100, sid: localSystemSID},
		3: {createdAt: 100, sid: "S-1-5-21-9"},
		4: {createdAt: 100}, // token unreadable
		5: {createdAt: 300, sid: localSystemSID},
	}
	openPeerProcess = func(pid uint32) (peerProcess, error) {
		p, ok := procs[pid]
		if !ok {
			return nil, windows.ERROR_ACCESS_DENIED
		}
		open := true
		p.open = &open
		return p, nil
	}
	runningServicePIDs = func() map[uint32]bool { return map[uint32]bool{4: true} }
	for _, tt := range []struct {
		name   string
		owners []tcpConnOwner
		want   listenerOwner
	}{
		{"none", nil, listenerNoneSeen},
		{"own", []tcpConnOwner{{1, 200}}, listenerTrustedOwner},
		{"own and SYSTEM", []tcpConnOwner{{1, 200}, {2, 200}}, listenerTrustedOwner},
		{"another user", []tcpConnOwner{{1, 200}, {3, 200}}, listenerOtherOwner},
		{"unreadable service", []tcpConnOwner{{4, 200}}, listenerOtherOwner},
		{"SYSTEM younger than the socket", []tcpConnOwner{{5, 200}}, listenerOtherOwner},
		{"own, as old as the socket", []tcpConnOwner{{1, 100}}, listenerOtherOwner},
		{"no bind time", []tcpConnOwner{{1, 0}}, listenerOtherOwner},
		{"cannot be opened", []tcpConnOwner{{6, 200}}, listenerOtherOwner},
	} {
		if got := listenerOwnersTrusted(tt.owners); got != tt.want {
			t.Errorf("%s: %v, want %v", tt.name, got, tt.want)
		}
	}
}

// The real tables find this process's own listener, bound after this
// process started, which runs as the current user.
func TestListenerOwnedLocallyWindows(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	table, ok := tcpTable(windows.AF_INET, tcpTableOwnerModuleListener)
	if !ok {
		t.Fatal("no TCP table")
	}
	if owners := tcpListenerOwners(table, windows.AF_INET, port); len(owners) != 1 ||
		owners[0].pid != windows.GetCurrentProcessId() || owners[0].bound == 0 {
		t.Fatalf("owners on %d = %v, want this process with a bind time", port, owners)
	}
	if got := listenerOwnedLocally(port); got != listenerTrustedOwner {
		t.Errorf("own listener = %v", got)
	}
}
