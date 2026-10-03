package main

import (
	"encoding/binary"
	"net"
	"testing"

	"golang.org/x/sys/windows"
)

// A MIB_TCPTABLE_OWNER_PID and a MIB_TCP6TABLE_OWNER_PID with one row on
// port 7690 and one elsewhere: only the first row's PID comes back.
func TestTCPTablePIDs(t *testing.T) {
	row := func(size, portOff, pidOff int, port uint16, pid uint32) []byte {
		b := make([]byte, size)
		binary.BigEndian.PutUint16(b[portOff:], port)
		binary.LittleEndian.PutUint32(b[pidOff:], pid)
		return b
	}
	for _, tt := range []struct {
		family                uint32
		size, portOff, pidOff int
	}{
		{windows.AF_INET, tcpRowOwnerPIDSize, 8, 20},
		{windows.AF_INET6, tcp6RowOwnerPIDSize, 20, 52},
	} {
		table := binary.LittleEndian.AppendUint32(nil, 2)
		table = append(table, row(tt.size, tt.portOff, tt.pidOff, 7690, 42)...)
		table = append(table, row(tt.size, tt.portOff, tt.pidOff, 8080, 43)...)
		if got := tcpTablePIDs(table, tt.family, 7690); len(got) != 1 || got[0] != 42 {
			t.Errorf("family %d: pids = %v, want [42]", tt.family, got)
		}
		// A count larger than the rows present stops at the end.
		short := binary.LittleEndian.AppendUint32(nil, 5)
		short = append(short, table[4:]...)
		if got := tcpTablePIDs(short, tt.family, 8080); len(got) != 1 || got[0] != 43 {
			t.Errorf("family %d short table: pids = %v", tt.family, got)
		}
	}
}

// The real tables find this process's own listener, which runs as the
// current user.
func TestListenerOwnedLocallyWindows(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	table, ok := tcpListenerTable(windows.AF_INET)
	if !ok {
		t.Fatal("no TCP table")
	}
	if pids := tcpTablePIDs(table, windows.AF_INET, port); len(pids) != 1 || pids[0] != windows.GetCurrentProcessId() {
		t.Fatalf("pids on %d = %v, want this process", port, pids)
	}
	if got := listenerOwnedLocally(port); got != listenerTrustedOwner {
		t.Errorf("own listener = %v", got)
	}
}
