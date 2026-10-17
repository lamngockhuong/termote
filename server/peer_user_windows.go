package main

import (
	"errors"
	"net/netip"
	"unsafe"

	"golang.org/x/sys/windows"
)

// peerIDKey names the id in a local-user-refused audit line.
const peerIDKey = "sid"

// tcpTableOwnerModuleConnections is TCP_TABLE_OWNER_MODULE_CONNECTIONS:
// every socket but the listeners, with its owner's PID and the time it was
// bound.
const tcpTableOwnerModuleConnections = 7

// mibTCPStateEstab is MIB_TCP_STATE_ESTAB.
const mibTCPStateEstab = 5

// serviceProcessID stands for a process whose token this user cannot read
// but that the Service Control Manager runs as a service (tailscaled, a
// reverse proxy installed as a service): their token is out of a normal
// user's reach, and registering a service takes an administrator. A
// per-user service is not one: it runs as whoever logged on.
const serviceProcessID = "service"

// errPeerPIDReused means the process now holding the PID the TCP table
// names for the client end was created after that socket was bound: the
// socket outlived the process that made it (its handle passed on) and the
// PID went to another process.
var errPeerPIDReused = errors.New("the process at the connection's PID started after its socket")

// peerOwner reads the client end's PID and bind time from the TCP tables,
// then the user the process holding that PID runs as.
var peerOwner = func(client, server netip.AddrPort) (string, error) {
	row, found := tcpConnTables.get()[[2]netip.AddrPort{client, server}]
	if !found {
		return "", errPeerNotFound
	}
	return connProcessUser(row)
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
		if table, ok := tcpTable(family, tcpTableOwnerModuleConnections); ok {
			x.add(table, family)
		}
	}
	return x
})

// tcpConnOwner is the owner PID of a connection's socket and the time it
// was bound (a FILETIME, 0 when the table gives none).
type tcpConnOwner struct {
	pid   uint32
	bound uint64
}

// tcpConnIndex holds the owner of each established connection by its local
// and remote ends.
type tcpConnIndex map[[2]netip.AddrPort]tcpConnOwner

// peerProcess is a process opened for a lookup: while it is open its PID
// cannot go to another process.
type peerProcess interface {
	// created is its creation time, a FILETIME.
	created() (uint64, error)
	// user is the SID its token holds; an error when this user may not read
	// the token.
	user() (string, error)
	close()
}

// openPeerProcess opens the process holding pid. Tests replace it.
var openPeerProcess = func(pid uint32) (peerProcess, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return nil, err
	}
	return winProcess(h), nil
}

// runningServicePIDs returns the PIDs of the services running now, read
// after it was called. Tests replace it.
var runningServicePIDs = func() map[uint32]bool { return serviceTables.get() }

// connProcessUser returns the SID of the process that owns a socket. The
// process holding the PID must have been created no later than the socket
// was bound, else the PID is another process's now. A process whose token
// this user may not read is serviceProcessID only as a running service's
// process, by a list read after the process was opened, so with its PID
// pinned: another user's process is never one, even in session 0 (an SSH
// logon, a scheduled task) or with its DACL opened to everyone.
func connProcessUser(row tcpConnOwner) (string, error) {
	proc, err := openPeerProcess(row.pid)
	if err != nil {
		return "", err
	}
	defer proc.close()
	created, err := proc.created()
	if err != nil {
		return "", err
	}
	if row.bound == 0 || created > row.bound {
		return "", errPeerPIDReused
	}
	sid, err := proc.user()
	if err != nil {
		if runningServicePIDs()[row.pid] {
			return serviceProcessID, nil
		}
		return "", err
	}
	return sid, nil
}

// winProcess is a process handle opened with
// PROCESS_QUERY_LIMITED_INFORMATION.
type winProcess windows.Handle

func (p winProcess) created() (uint64, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(windows.Handle(p), &created, &exited, &kernel, &user); err != nil {
		return 0, err
	}
	return uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), nil
}

func (p winProcess) user() (string, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.Handle(p), windows.TOKEN_QUERY, &token); err != nil {
		return "", err
	}
	defer token.Close()
	u, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

func (p winProcess) close() { windows.CloseHandle(windows.Handle(p)) }

// serviceTables lists the running services' PIDs once for every lookup
// waiting at the time, like tcpConnTables. A list that cannot be read is
// empty: no service is trusted then.
var serviceTables = newTableSnapshots(func() map[uint32]bool {
	pids := map[uint32]bool{}
	m, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_ENUMERATE_SERVICE)
	if err != nil {
		return pids
	}
	defer windows.CloseServiceHandle(m)
	buf := make([]byte, 64<<10)
	var resume uint32
	for {
		var needed, count uint32
		err := windows.EnumServicesStatusEx(m, windows.SC_ENUM_PROCESS_INFO, windows.SERVICE_WIN32,
			windows.SERVICE_ACTIVE, &buf[0], uint32(len(buf)), &needed, &count, &resume, nil)
		if err != nil && err != windows.ERROR_MORE_DATA {
			return pids
		}
		addServicePIDs(pids, unsafe.Slice((*windows.ENUM_SERVICE_STATUS_PROCESS)(unsafe.Pointer(&buf[0])), count))
		if err == nil {
			return pids
		}
		if count == 0 {
			// Nothing returned: only a bigger buffer can make progress.
			if needed <= uint32(len(buf)) {
				return pids
			}
			buf = make([]byte, needed)
		}
	}
})

const (
	// serviceUserService and serviceUserServiceInstance are
	// SERVICE_USER_SERVICE and SERVICE_USERSERVICE_INSTANCE: a per-user
	// service (CDPUserSvc_<luid>, ...) runs as the user who logged on, who
	// can open and drive that process like any other of its own.
	serviceUserService         = 0x40
	serviceUserServiceInstance = 0x80
)

// addServicePIDs adds the PID of each running service of services to pids,
// except a per-user service's.
func addServicePIDs(pids map[uint32]bool, services []windows.ENUM_SERVICE_STATUS_PROCESS) {
	for _, s := range services {
		st := s.ServiceStatusProcess
		if st.ProcessId != 0 && st.ServiceType&(serviceUserService|serviceUserServiceInstance) == 0 {
			pids[st.ProcessId] = true
		}
	}
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
// running services.
func trustedPeerIDs() []string { return []string{localSystemSID, serviceProcessID} }

// foreignLoopbackPossible is false: every loopback connection has both ends
// in Windows' own tables.
func foreignLoopbackPossible() bool { return false }

// add indexes the established rows of table.
func (x tcpConnIndex) add(table []byte, family uint32) {
	tcpModuleRows(table, family, func(state uint32, l, r netip.AddrPort, o tcpConnOwner) {
		if state == mibTCPStateEstab {
			x[[2]netip.AddrPort{l, r}] = o
		}
	})
}
