package main

import (
	"encoding/binary"
	"net/netip"

	"golang.org/x/sys/windows"
)

// peerIDKey names the id in a local-user-refused audit line.
const peerIDKey = "sid"

// tcpTableOwnerPIDConnections is TCP_TABLE_OWNER_PID_CONNECTIONS: every
// socket but the listeners, with its owner's PID.
const tcpTableOwnerPIDConnections = 4

// mibTCPStateEstab is MIB_TCP_STATE_ESTAB.
const mibTCPStateEstab = 5

// serviceSessionID stands for a process whose token cannot be opened but
// that runs in session 0, where only services run (tailscaled, a reverse
// proxy installed as a service): their token is out of a normal user's
// reach, and installing a service takes an administrator anyway.
const serviceSessionID = "session-0"

// peerOwner reads the client end's PID from the TCP tables, then the user
// that process runs as.
var peerOwner = func(client, server netip.AddrPort) (string, error) {
	pid, found := tcpConnTables.get()[[2]netip.AddrPort{client, server}]
	if !found {
		return "", errPeerNotFound
	}
	return connProcessUser(pid)
}

// tcpConnTables copies both TCP tables once for every lookup waiting at the
// time: a copy holds every connection of the machine, and a flood of
// connections from another user would otherwise make one copy per
// connection of tables that grow with the flood. An IPv4 connection can sit
// in the IPv6 table too (a dual-stack socket connected to an IPv4 address),
// as IPv4-mapped addresses, unmapped in the index.
var tcpConnTables = newTableSnapshots(func() tcpConnIndex {
	x := tcpConnIndex{}
	for _, family := range []uint32{windows.AF_INET, windows.AF_INET6} {
		if table, ok := tcpTable(family, tcpTableOwnerPIDConnections); ok {
			x.add(table, family)
		}
	}
	return x
})

// tcpConnIndex holds the owner PID of each established connection by its
// local and remote ends.
type tcpConnIndex map[[2]netip.AddrPort]uint32

// connProcessUser returns the SID process pid runs as. A process this user
// may open but whose token it may not read, in session 0, is a service
// (SYSTEM's token is out of a normal user's reach): serviceSessionID. A
// process it may not open at all, another user's, is never trusted, even in
// session 0 (an SSH logon, a scheduled task).
func connProcessUser(pid uint32) (string, error) {
	proc, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(proc)
	var token windows.Token
	if err := windows.OpenProcessToken(proc, windows.TOKEN_QUERY, &token); err != nil {
		var session uint32
		if windows.ProcessIdToSessionId(pid, &session) == nil && session == 0 {
			return serviceSessionID, nil
		}
		return "", err
	}
	defer token.Close()
	u, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

// selfPeerID is the server's own SID.
func selfPeerID() string {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return ""
	}
	return u.User.Sid.String()
}

// trustedPeerIDs are trusted besides the server's own user: SYSTEM and the
// services of session 0.
func trustedPeerIDs() []string { return []string{"S-1-5-18", serviceSessionID} }

// foreignLoopbackPossible is false: every loopback connection has both ends
// in Windows' own tables.
func foreignLoopbackPossible() bool { return false }

// add indexes the established rows of table (MIB_TCPROW_OWNER_PID, 24
// bytes, or MIB_TCP6ROW_OWNER_PID, 56 bytes). Addresses are in network
// order, ports in network order in the low 16 bits of their DWORD.
func (x tcpConnIndex) add(table []byte, family uint32) {
	if len(table) < 4 {
		return
	}
	n := binary.LittleEndian.Uint32(table)
	rowSize := tcpRowOwnerPIDSize
	if family == windows.AF_INET6 {
		rowSize = tcp6RowOwnerPIDSize
	}
	for i := range int(n) {
		off := 4 + i*rowSize
		if off+rowSize > len(table) {
			break
		}
		row := table[off : off+rowSize]
		var state, pid uint32
		var l, r netip.AddrPort
		if family == windows.AF_INET6 {
			l = netip.AddrPortFrom(netip.AddrFrom16([16]byte(row[0:16])).Unmap(), binary.BigEndian.Uint16(row[20:22]))
			r = netip.AddrPortFrom(netip.AddrFrom16([16]byte(row[24:40])).Unmap(), binary.BigEndian.Uint16(row[44:46]))
			state, pid = binary.LittleEndian.Uint32(row[48:]), binary.LittleEndian.Uint32(row[52:])
		} else {
			state = binary.LittleEndian.Uint32(row[0:])
			l = netip.AddrPortFrom(netip.AddrFrom4([4]byte(row[4:8])), binary.BigEndian.Uint16(row[8:10]))
			r = netip.AddrPortFrom(netip.AddrFrom4([4]byte(row[12:16])), binary.BigEndian.Uint16(row[16:18]))
			pid = binary.LittleEndian.Uint32(row[20:])
		}
		if state == mibTCPStateEstab {
			x[[2]netip.AddrPort{l, r}] = pid
		}
	}
}
