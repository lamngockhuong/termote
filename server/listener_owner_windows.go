package main

import (
	"encoding/binary"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetExtendedTcpTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

const (
	tcpTableOwnerPIDListener = 3 // TCP_TABLE_OWNER_PID_LISTENER
	tcpRowOwnerPIDSize       = 24
	tcp6RowOwnerPIDSize      = 56
)

// listenerOwnedLocally finds the processes listening on port in the TCP
// tables, then the user each runs as. A process that cannot be opened (one
// of another user, usually) counts as another user's.
func listenerOwnedLocally(port int) listenerOwner {
	var pids []uint32
	for _, family := range []uint32{windows.AF_INET, windows.AF_INET6} {
		table, ok := tcpListenerTable(family)
		if !ok {
			return listenerNoneSeen
		}
		pids = append(pids, tcpTablePIDs(table, family, port)...)
	}
	if len(pids) == 0 {
		return listenerNoneSeen
	}
	self, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return listenerNoneSeen
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return listenerNoneSeen
	}
	for _, pid := range pids {
		sid, err := processUser(pid)
		if err != nil || !windows.EqualSid(sid, self.User.Sid) && !windows.EqualSid(sid, system) {
			return listenerOtherOwner
		}
	}
	return listenerTrustedOwner
}

// tcpListenerTable returns the listening sockets of family with their PIDs
// (MIB_TCPTABLE_OWNER_PID or MIB_TCP6TABLE_OWNER_PID).
func tcpListenerTable(family uint32) ([]byte, bool) {
	var size uint32
	for range 3 {
		buf := make([]byte, max(size, 4))
		size = uint32(len(buf))
		r, _, _ := procGetExtendedTcpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)),
			0, uintptr(family), tcpTableOwnerPIDListener, 0)
		switch windows.Errno(r) {
		case 0:
			return buf[:size], true
		case windows.ERROR_INSUFFICIENT_BUFFER:
			continue // size now holds what the table needs
		default:
			return nil, false
		}
	}
	return nil, false
}

// tcpTablePIDs returns the owner of each row of table that is on port.
// dwLocalPort holds the port in network byte order in its low 16 bits.
func tcpTablePIDs(table []byte, family uint32, port int) []uint32 {
	if len(table) < 4 {
		return nil
	}
	n := binary.LittleEndian.Uint32(table)
	rowSize, portOff, pidOff := tcpRowOwnerPIDSize, 8, 20
	if family == windows.AF_INET6 {
		rowSize, portOff, pidOff = tcp6RowOwnerPIDSize, 20, 52
	}
	var pids []uint32
	for i := range int(n) {
		row := table[4+i*rowSize:]
		if len(row) < rowSize {
			break
		}
		p := binary.BigEndian.Uint16(row[portOff : portOff+2])
		if int(p) == port {
			pids = append(pids, binary.LittleEndian.Uint32(row[pidOff:pidOff+4]))
		}
	}
	return pids
}

// processUser returns the user process pid runs as.
func processUser(pid uint32) (*windows.SID, error) {
	proc, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(proc)
	var token windows.Token
	if err := windows.OpenProcessToken(proc, windows.TOKEN_QUERY, &token); err != nil {
		return nil, err
	}
	defer token.Close()
	u, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	return u.User.Sid.Copy()
}
