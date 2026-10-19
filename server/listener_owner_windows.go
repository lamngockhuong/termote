package main

import (
	"encoding/binary"
	"net/netip"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetExtendedTcpTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

// tcpTableOwnerModuleListener is TCP_TABLE_OWNER_MODULE_LISTENER: the
// listening sockets, with each one's owner PID and the time it was bound.
const tcpTableOwnerModuleListener = 6

const (
	tcpRowOwnerModuleSize  = 160 // MIB_TCPROW_OWNER_MODULE
	tcp6RowOwnerModuleSize = 192 // MIB_TCP6ROW_OWNER_MODULE
	// tcpModuleRowsOffset is where the rows start: after dwNumEntries,
	// padded to the 8-byte alignment of their liCreateTimestamp.
	tcpModuleRowsOffset = 8
)

// localSystemSID is SYSTEM's SID.
const localSystemSID = "S-1-5-18"

// listenerOwnedLocally finds the sockets listening on port in the TCP
// tables, then the user each one's process runs as. A process that cannot
// be opened, whose token cannot be read (another user's, usually) or that
// was created after the socket was bound (its PID now another process's)
// counts as another user's.
func listenerOwnedLocally(port int) listenerOwner {
	var owners []tcpConnOwner
	for _, family := range []uint32{windows.AF_INET, windows.AF_INET6} {
		table, ok := tcpTable(family, tcpTableOwnerModuleListener)
		if !ok {
			return listenerNoneSeen
		}
		owners = append(owners, tcpListenerOwners(table, family, port)...)
	}
	return listenerOwnersTrusted(owners)
}

// tcpListenerOwners returns the owner of each row of a listener table that
// is on port.
func tcpListenerOwners(table []byte, family uint32, port int) []tcpConnOwner {
	var owners []tcpConnOwner
	tcpModuleRows(table, family, func(_ uint32, local, _ netip.AddrPort, o tcpConnOwner) {
		if int(local.Port()) == port {
			owners = append(owners, o)
		}
	})
	return owners
}

// listenerOwnersTrusted judges the owners of the sockets listening on a
// port: each must run as the current user or SYSTEM. A service whose token
// cannot be read (serviceProcessID) is not trusted with the password.
func listenerOwnersTrusted(owners []tcpConnOwner) listenerOwner {
	if len(owners) == 0 {
		return listenerNoneSeen
	}
	self := selfPeerID()
	if self == "" {
		return listenerNoneSeen
	}
	for _, o := range owners {
		if sid, err := connProcessUser(o); err != nil || sid != self && sid != localSystemSID {
			return listenerOtherOwner
		}
	}
	return listenerTrustedOwner
}

// tcpTable returns the TCP table of family of the given class.
func tcpTable(family, class uint32) ([]byte, bool) {
	var size uint32
	for range 3 {
		buf := make([]byte, max(size, 4))
		size = uint32(len(buf))
		r, _, _ := procGetExtendedTcpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)),
			0, uintptr(family), uintptr(class), 0)
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

// tcpModuleRows calls fn with each row of table (MIB_TCPROW_OWNER_MODULE, 160
// bytes, or MIB_TCP6ROW_OWNER_MODULE, 192 bytes, after a count padded to 8
// bytes). Addresses are in network order, ports in network order in the
// low 16 bits of their DWORD; IPv4-mapped addresses are unmapped.
func tcpModuleRows(table []byte, family uint32, fn func(state uint32, local, remote netip.AddrPort, o tcpConnOwner)) {
	if len(table) < tcpModuleRowsOffset {
		return
	}
	n := binary.LittleEndian.Uint32(table)
	rowSize, boundOff := tcpRowOwnerModuleSize, 24
	if family == windows.AF_INET6 {
		rowSize, boundOff = tcp6RowOwnerModuleSize, 56
	}
	for i := range int(n) {
		off := tcpModuleRowsOffset + i*rowSize
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
		fn(state, l, r, tcpConnOwner{pid, binary.LittleEndian.Uint64(row[boundOff:])})
	}
}
