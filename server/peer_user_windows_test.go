package main

import (
	"encoding/binary"
	"errors"
	"maps"
	"net"
	"net/netip"
	"slices"
	"testing"

	"golang.org/x/sys/windows"
)

// tcpConnRow builds a MIB_TCPROW_OWNER_MODULE or MIB_TCP6ROW_OWNER_MODULE.
func tcpConnRow(family uint32, state uint32, local, remote netip.AddrPort, pid uint32, bound uint64) []byte {
	if family == windows.AF_INET6 {
		b := make([]byte, tcp6RowOwnerModuleSize)
		l, r := local.Addr().As16(), remote.Addr().As16()
		copy(b[0:], l[:])
		binary.BigEndian.PutUint16(b[20:], local.Port())
		copy(b[24:], r[:])
		binary.BigEndian.PutUint16(b[44:], remote.Port())
		binary.LittleEndian.PutUint32(b[48:], state)
		binary.LittleEndian.PutUint32(b[52:], pid)
		binary.LittleEndian.PutUint64(b[56:], bound)
		return b
	}
	b := make([]byte, tcpRowOwnerModuleSize)
	l, r := local.Addr().As4(), remote.Addr().As4()
	binary.LittleEndian.PutUint32(b[0:], state)
	copy(b[4:], l[:])
	binary.BigEndian.PutUint16(b[8:], local.Port())
	copy(b[12:], r[:])
	binary.BigEndian.PutUint16(b[16:], remote.Port())
	binary.LittleEndian.PutUint32(b[20:], pid)
	binary.LittleEndian.PutUint64(b[24:], bound)
	return b
}

// tcpConnTable is a table of rows: their count, padded to 8 bytes, then the
// rows.
func tcpConnTable(n uint32, rows ...[]byte) []byte {
	table := binary.LittleEndian.AppendUint32(nil, n)
	table = append(table, 0, 0, 0, 0)
	for _, r := range rows {
		table = append(table, r...)
	}
	return table
}

func TestTCPConnPID(t *testing.T) {
	server := netip.MustParseAddrPort("127.0.0.1:7690")
	client := netip.MustParseAddrPort("127.0.0.2:50000")
	closed := netip.MustParseAddrPort("127.0.0.1:50001")
	table := tcpConnTable(3,
		tcpConnRow(windows.AF_INET, mibTCPStateEstab, server, client, 10, 100), // the server's end
		tcpConnRow(windows.AF_INET, mibTCPStateEstab, client, server, 11, 101),
		tcpConnRow(windows.AF_INET, 11, closed, server, 12, 102)) // TIME_WAIT
	if row, ok := tcpConnPID(table, windows.AF_INET, client, server); !ok || row != (tcpConnOwner{11, 101}) {
		t.Errorf("client: %+v %v", row, ok)
	}
	if _, ok := tcpConnPID(table, windows.AF_INET, closed, server); ok {
		t.Error("TIME_WAIT row found")
	}
	// IPv6 and IPv4-mapped rows.
	server6 := netip.MustParseAddrPort("[::1]:7690")
	client6 := netip.MustParseAddrPort("[::1]:50002")
	mapped := netip.AddrPortFrom(netip.AddrFrom16(client.Addr().As16()), 50003)
	mappedServer := netip.AddrPortFrom(netip.AddrFrom16(server.Addr().As16()), server.Port())
	table6 := tcpConnTable(2,
		tcpConnRow(windows.AF_INET6, mibTCPStateEstab, client6, server6, 13, 103),
		tcpConnRow(windows.AF_INET6, mibTCPStateEstab, mapped, mappedServer, 14, 104))
	if row, ok := tcpConnPID(table6, windows.AF_INET6, client6, server6); !ok || row != (tcpConnOwner{13, 103}) {
		t.Errorf("IPv6: %+v %v", row, ok)
	}
	if row, ok := tcpConnPID(table6, windows.AF_INET6, netip.AddrPortFrom(client.Addr(), 50003), server); !ok || row != (tcpConnOwner{14, 104}) {
		t.Errorf("mapped: %+v %v", row, ok)
	}
	// A count larger than the rows present stops at the end.
	short := tcpConnTable(9)
	short = append(short, table[tcpModuleRowsOffset:]...)
	if _, ok := tcpConnPID(short, windows.AF_INET, netip.MustParseAddrPort("127.0.0.1:1"), server); ok {
		t.Error("short table")
	}
	if _, ok := tcpConnPID(nil, windows.AF_INET, client, server); ok {
		t.Error("empty table")
	}
}

// The real table finds this process's own client end, with a bind time no
// earlier than this process was created, and it runs as the current user.
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

// tcpConnPID looks one connection up in a TCP table of family.
func tcpConnPID(table []byte, family uint32, local, remote netip.AddrPort) (tcpConnOwner, bool) {
	x := tcpConnIndex{}
	x.add(table, family)
	row, ok := x[[2]netip.AddrPort{local, remote}]
	return row, ok
}

// fakePeerProcess is a process for connProcessUser, and records whether it
// is still open.
type fakePeerProcess struct {
	createdAt uint64
	sid       string
	open      *bool
}

func (p fakePeerProcess) created() (uint64, error) { return p.createdAt, nil }

func (p fakePeerProcess) user() (string, error) {
	if p.sid == "" {
		return "", windows.ERROR_ACCESS_DENIED
	}
	return p.sid, nil
}

func (p fakePeerProcess) close() { *p.open = false }

// The process holding the PID must not be younger than the socket, and a
// token that cannot be read is trusted only for a running service's PID,
// listed while the process is open.
func TestConnProcessUser(t *testing.T) {
	oldOpen, oldServices := openPeerProcess, runningServicePIDs
	defer func() { openPeerProcess, runningServicePIDs = oldOpen, oldServices }()
	const pid = 4242
	var proc fakePeerProcess
	open, listed := false, 0
	openPeerProcess = func(p uint32) (peerProcess, error) {
		if p != pid {
			return nil, windows.ERROR_INVALID_PARAMETER
		}
		open = true
		proc.open = &open
		return proc, nil
	}
	services := map[uint32]bool{}
	runningServicePIDs = func() map[uint32]bool {
		if !open {
			t.Error("services listed with the process not open")
		}
		listed++
		return services
	}
	user := func(createdAt uint64, sid string, bound uint64) (string, error) {
		proc = fakePeerProcess{createdAt: createdAt, sid: sid}
		id, err := connProcessUser(tcpConnOwner{pid, bound})
		if open {
			t.Error("process left open")
		}
		return id, err
	}

	if id, err := user(100, "S-1-5-21-1", 100); err != nil || id != "S-1-5-21-1" {
		t.Errorf("process as old as its socket: %q %v", id, err)
	}
	if id, err := user(100, "S-1-5-21-1", 200); err != nil || id != "S-1-5-21-1" {
		t.Errorf("process older than its socket: %q %v", id, err)
	}
	if _, err := user(201, "S-1-5-18", 200); !errors.Is(err, errPeerPIDReused) {
		t.Errorf("SYSTEM process younger than the socket: %v, want errPeerPIDReused", err)
	}
	if _, err := user(100, "S-1-5-18", 0); !errors.Is(err, errPeerPIDReused) {
		t.Errorf("socket with no bind time: %v, want errPeerPIDReused", err)
	}
	if listed != 0 {
		t.Errorf("services listed %d times for readable tokens", listed)
	}
	// Unreadable token: another user's process opened to everyone, in any
	// session, is refused; a running service's process is trusted.
	if id, err := user(100, "", 200); err == nil {
		t.Errorf("unreadable token of a process that is no service: %q", id)
	}
	services[pid] = true
	if id, err := user(100, "", 200); err != nil || id != serviceProcessID {
		t.Errorf("running service: %q %v", id, err)
	}
	if _, err := user(300, "", 200); !errors.Is(err, errPeerPIDReused) {
		t.Errorf("service younger than the socket: %v, want errPeerPIDReused", err)
	}
	if _, err := connProcessUser(tcpConnOwner{pid + 1, 200}); err == nil {
		t.Error("a process that cannot be opened was trusted")
	}
	if !slices.Contains(trustedPeerIDs(), serviceProcessID) {
		t.Error("services are not trusted")
	}
}

// The Service Control Manager's list holds running services, and this test
// process is none of them.
func TestRunningServicePIDs(t *testing.T) {
	pids := runningServicePIDs()
	if len(pids) == 0 {
		t.Fatal("no running service listed")
	}
	if pids[windows.GetCurrentProcessId()] {
		t.Error("the test process listed as a service")
	}
}

// A per-user service runs as the user who logged on, so its process is not
// trusted as a service's.
func TestAddServicePIDs(t *testing.T) {
	entry := func(pid, typ uint32) windows.ENUM_SERVICE_STATUS_PROCESS {
		var e windows.ENUM_SERVICE_STATUS_PROCESS
		e.ServiceStatusProcess.ProcessId = pid
		e.ServiceStatusProcess.ServiceType = typ
		return e
	}
	pids := map[uint32]bool{}
	addServicePIDs(pids, []windows.ENUM_SERVICE_STATUS_PROCESS{
		entry(10, windows.SERVICE_WIN32_OWN_PROCESS),
		entry(11, windows.SERVICE_WIN32_SHARE_PROCESS),
		entry(0, windows.SERVICE_WIN32_OWN_PROCESS), // starting, no process yet
		entry(12, 0x50), // SERVICE_USER_OWN_PROCESS: the template
		entry(13, 0xd0), // its instance, as the logged-on user
		entry(14, 0xe0), // a shared per-user instance
	})
	if want := map[uint32]bool{10: true, 11: true}; !maps.Equal(pids, want) {
		t.Errorf("service PIDs %v, want %v", pids, want)
	}
}
