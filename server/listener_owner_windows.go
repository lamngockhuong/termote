package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"slices"
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
// was not created before the socket was bound (its PID maybe another
// process's now) counts as another user's.
func listenerOwnedLocally(port int) listenerOwner {
	owner, err := listenerOwnersOn(port)
	if err != nil {
		return listenerNoneSeen
	}
	return owner
}

// listenerOwnersOn is listenerOwnedLocally that also trusts the accounts
// named by SID in also, with the reason the owners could not be read (the
// TCP tables, or the server's own account while something listens), for a
// caller that must refuse then rather than see nothing listening.
func listenerOwnersOn(port int, also ...string) (listenerOwner, error) {
	var owners []tcpConnOwner
	for _, family := range []uint32{windows.AF_INET, windows.AF_INET6} {
		table, err := tcpTable(family, tcpTableOwnerModuleListener)
		if err != nil {
			return listenerNoneSeen, err
		}
		owners = append(owners, tcpListenerOwners(table, family, port)...)
	}
	if len(owners) > 0 && selfPeerID() == "" {
		return listenerNoneSeen, errors.New("cannot read the server's own account to compare the listeners with")
	}
	return listenerOwnersTrusted(owners, also...), nil
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
func listenerOwnersTrusted(owners []tcpConnOwner, also ...string) listenerOwner {
	if len(owners) == 0 {
		return listenerNoneSeen
	}
	self := selfPeerID()
	if self == "" {
		return listenerNoneSeen
	}
	for _, o := range owners {
		if sid, err := connProcessUser(o); err != nil || sid != self && sid != localSystemSID && !slices.Contains(also, sid) {
			return listenerOtherOwner
		}
	}
	return listenerTrustedOwner
}

// getExtendedTCPTable is GetExtendedTcpTable into buf; on
// ERROR_INSUFFICIENT_BUFFER size holds what the table needs. Tests replace it.
var getExtendedTCPTable = func(buf []byte, size *uint32, family, class uint32) windows.Errno {
	r, _, _ := procGetExtendedTcpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(size)),
		0, uintptr(family), uintptr(class), 0)
	return windows.Errno(r)
}

const (
	// tcpTableTries bounds the reads of a table that keeps outgrowing the
	// buffer between the size asked and the read.
	tcpTableTries = 5
	// tcpTableHeadroom is room for this many more rows than the table last
	// needed, so sockets opened meanwhile still fit.
	tcpTableHeadroom = 64 * tcp6RowOwnerModuleSize
)

// tcpTable returns the TCP table of family of the given class, or why it
// could not be read.
func tcpTable(family, class uint32) ([]byte, error) {
	var need uint32
	for range tcpTableTries {
		buf := make([]byte, int(need)+int(need)/2+tcpTableHeadroom)
		size := uint32(len(buf))
		switch errno := getExtendedTCPTable(buf, &size, family, class); errno {
		case 0:
			return buf[:min(int(size), len(buf))], nil
		case windows.ERROR_INSUFFICIENT_BUFFER:
			need = size
		default:
			return nil, fmt.Errorf("reading the TCP table: %w", errno)
		}
	}
	return nil, fmt.Errorf("the TCP table outgrew the buffer %d times", tcpTableTries)
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
