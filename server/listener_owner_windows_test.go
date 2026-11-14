package main

import (
	"errors"
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
	table, err := tcpTable(windows.AF_INET, tcpTableOwnerModuleListener)
	if err != nil {
		t.Fatal(err)
	}
	if owners := tcpListenerOwners(table, windows.AF_INET, port); len(owners) != 1 ||
		owners[0].pid != windows.GetCurrentProcessId() || owners[0].bound == 0 {
		t.Fatalf("owners on %d = %v, want this process with a bind time", port, owners)
	}
	if got := listenerOwnedLocally(port); got != listenerTrustedOwner {
		t.Errorf("own listener = %v", got)
	}
}

// fakeTCPTable answers GetExtendedTcpTable for a table of size bytes: each
// read the table first grows by grow bytes, as when sockets open between the
// size asked and the read; with never it always needs a byte more than the
// buffer. It records the buffer sizes it was given.
type fakeTCPTable struct {
	size, grow int
	never      bool
	errno      windows.Errno
	bufs       []int
}

func (f *fakeTCPTable) read(buf []byte, size *uint32, _, _ uint32) windows.Errno {
	f.bufs = append(f.bufs, len(buf))
	if f.errno != 0 {
		return f.errno
	}
	if f.never {
		*size = uint32(len(buf) + 1)
		return windows.ERROR_INSUFFICIENT_BUFFER
	}
	f.size += f.grow
	if int(*size) < f.size {
		*size = uint32(f.size)
		return windows.ERROR_INSUFFICIENT_BUFFER
	}
	*size = uint32(f.size)
	return 0
}

// A table that grew past the buffer is read again with room for what it
// needed and more; one that cannot be read gives its reason, and a caller
// that must not take that for nothing listening (psmux) sees the error.
func TestTCPTableRetriesAndFails(t *testing.T) {
	orig := getExtendedTCPTable
	t.Cleanup(func() { getExtendedTCPTable = orig })

	f := &fakeTCPTable{size: 3 * tcpTableHeadroom}
	getExtendedTCPTable = f.read
	if table, err := tcpTable(windows.AF_INET, tcpTableOwnerModuleListener); err != nil || len(table) != f.size {
		t.Fatalf("a table larger than the first buffer: %d bytes, %v", len(table), err)
	}
	if len(f.bufs) != 2 || f.bufs[1] < 3*tcpTableHeadroom+tcpTableHeadroom {
		t.Errorf("buffers %v: the second must hold what was needed with headroom", f.bufs)
	}

	// Growing by less than the headroom each time still fits on the next read.
	f = &fakeTCPTable{size: tcpTableHeadroom, grow: tcpTableHeadroom / 2}
	getExtendedTCPTable = f.read
	if _, err := tcpTable(windows.AF_INET, tcpTableOwnerModuleListener); err != nil {
		t.Fatalf("a table growing between reads: %v (buffers %v)", err, f.bufs)
	}

	// Growing faster than every buffer: an error after tcpTableTries reads.
	f = &fakeTCPTable{never: true}
	getExtendedTCPTable = f.read
	if _, err := tcpTable(windows.AF_INET, tcpTableOwnerModuleListener); err == nil || len(f.bufs) != tcpTableTries {
		t.Fatalf("a table outgrowing every buffer: %v after %d reads", err, len(f.bufs))
	}
	if _, err := psmuxPortOwner(7690); err == nil {
		t.Error("psmux took an unreadable table for a free port")
	}
	if got := listenerOwnedLocally(7690); got != listenerNoneSeen {
		t.Errorf("listenerOwnedLocally = %v", got)
	}

	f = &fakeTCPTable{errno: windows.ERROR_NOT_SUPPORTED}
	getExtendedTCPTable = f.read
	if _, err := tcpTable(windows.AF_INET6, tcpTableOwnerModuleListener); !errors.Is(err, windows.ERROR_NOT_SUPPORTED) {
		t.Fatalf("a failed read: %v", err)
	}
	if _, err := psmuxPortOwner(7690); !errors.Is(err, windows.ERROR_NOT_SUPPORTED) {
		t.Errorf("psmux port owner on a failed read: %v", err)
	}
}
