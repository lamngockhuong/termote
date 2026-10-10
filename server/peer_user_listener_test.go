package main

import (
	"bytes"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/user"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// newTestPeerCheck returns a check trusting "1000" whose lookup is owner.
func newTestPeerCheck(owner func(client, server netip.AddrPort) (string, error)) *localPeerCheck {
	return &localPeerCheck{
		owner:          owner,
		trusted:        map[string]bool{"1000": true, "0": true},
		interfaceAddrs: func() ([]net.Addr, error) { return nil, nil },
		slots:          make(chan struct{}, peerLookupSlots),
		timeout:        peerLookupTimeout,
		logs:           map[string]*peerLog{},
	}
}

// servePeerChecked serves on 127.0.0.1 behind check and counts the requests
// that reach the handler.
func servePeerChecked(t *testing.T, check *localPeerCheck) (string, *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int32
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		io.WriteString(w, "ok")
	})}
	go srv.Serve(check.listener(ln))
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().String(), &hits
}

// peerTestGet sends one request and returns what the server answered ("" when
// it closed the connection).
func peerTestGet(t *testing.T, addr string) string {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(c, "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
	b, _ := io.ReadAll(c)
	return string(b)
}

func TestPeerCheckServesTrustedUsers(t *testing.T) {
	for _, id := range []string{"1000", "0"} {
		addr, hits := servePeerChecked(t, newTestPeerCheck(func(client, server netip.AddrPort) (string, error) {
			if !client.Addr().IsLoopback() || server.String() == "" {
				return "", errors.New("bad addresses")
			}
			return id, nil
		}))
		if got := peerTestGet(t, addr); !strings.Contains(got, "200 OK") || hits.Load() != 1 {
			t.Errorf("user %s: %q, %d requests", id, got, hits.Load())
		}
	}
}

// Another user, no socket found, a failed lookup: the connection is closed
// and the handler never sees the request, whatever the auth mode.
func TestPeerCheckRefusesOtherUsers(t *testing.T) {
	buf := captureLockedLog(t)
	for name, owner := range map[string]func(netip.AddrPort, netip.AddrPort) (string, error){
		"other user": func(netip.AddrPort, netip.AddrPort) (string, error) { return "1001", nil },
		"not found":  func(netip.AddrPort, netip.AddrPort) (string, error) { return "", errPeerNotFound },
		"error":      func(netip.AddrPort, netip.AddrPort) (string, error) { return "", errors.New("access denied") },
	} {
		addr, hits := servePeerChecked(t, newTestPeerCheck(owner))
		if got := peerTestGet(t, addr); got != "" || hits.Load() != 0 {
			t.Errorf("%s: answered %q, %d requests", name, got, hits.Load())
		}
	}
	logs := buf.String()
	for _, want := range []string{`audit: local-user-refused ` + peerIDKey + `="1001"`, `reason="other user"`, `reason="` + errPeerNotFound.Error() + `"`, `reason="access denied"`} {
		if !strings.Contains(logs, want) {
			t.Errorf("log lacks %s:\n%s", want, logs)
		}
	}
}

// A lookup past the timeout refuses the connection; one waiting for a slot
// too.
func TestPeerCheckTimeout(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	check := newTestPeerCheck(func(netip.AddrPort, netip.AddrPort) (string, error) {
		<-release
		return "1000", nil
	})
	check.timeout = 50 * time.Millisecond
	check.slots = make(chan struct{}, 1)
	addr, hits := servePeerChecked(t, check)
	start := time.Now()
	if got := peerTestGet(t, addr); got != "" || hits.Load() != 0 {
		t.Errorf("hung lookup: %q, %d requests", got, hits.Load())
	}
	// The hung lookup still holds the only slot.
	if got := peerTestGet(t, addr); got != "" || time.Since(start) > 3*time.Second {
		t.Errorf("no slot: %q after %v", got, time.Since(start))
	}
}

// A connection from another machine is not looked up; one to this
// machine's own non-loopback address is.
func TestPeerCheckOnlyLocalConnections(t *testing.T) {
	var lookups atomic.Int32
	check := newTestPeerCheck(func(netip.AddrPort, netip.AddrPort) (string, error) {
		lookups.Add(1)
		return "1001", nil
	})
	reads := 0
	check.interfaceAddrs = func() ([]net.Addr, error) {
		reads++
		return []net.Addr{&net.IPNet{IP: net.ParseIP("192.168.1.20"), Mask: net.CIDRMask(24, 32)}}, nil
	}
	if !check.fromThisMachine(netip.MustParseAddr("127.0.0.2")) || !check.fromThisMachine(netip.MustParseAddr("::1")) {
		t.Error("loopback not local")
	}
	if !check.fromThisMachine(netip.MustParseAddr("192.168.1.20")) {
		t.Error("own LAN address not local")
	}
	if check.fromThisMachine(netip.MustParseAddr("192.168.1.30")) {
		t.Error("another machine counted as local")
	}
	// A miss right after a read does not list the interfaces again.
	if reads != 1 {
		t.Errorf("interfaces read %d times", reads)
	}
	// Past machineAddrsMissEvery a miss reads them again (a new address).
	check.addrsRead = time.Now().Add(-2 * machineAddrsMissEvery)
	check.fromThisMachine(netip.MustParseAddr("192.168.1.30"))
	if reads != 2 {
		t.Errorf("miss after a while: %d reads", reads)
	}
	// A failed read keeps the last list.
	check.addrsRead = time.Time{}
	check.interfaceAddrs = func() ([]net.Addr, error) { return nil, errors.New("no netlink") }
	if !check.fromThisMachine(netip.MustParseAddr("192.168.1.20")) {
		t.Error("failed read dropped the known address")
	}
	// Real connections: a fake one from another machine passes unchecked.
	c := &peerCheckedConn{Conn: fakeAddrConn{remote: "192.168.1.30:5000", local: "192.168.1.20:7680"}, check: check}
	if err := c.verify(); err != nil || lookups.Load() != 0 {
		t.Errorf("remote: %v, %d lookups", err, lookups.Load())
	}
	c = &peerCheckedConn{Conn: fakeAddrConn{remote: "192.168.1.20:5000", local: "192.168.1.20:7680"}, check: check}
	if err := c.verify(); !errors.Is(err, errPeerRefused) || lookups.Load() != 1 {
		t.Errorf("own LAN address: %v, %d lookups", err, lookups.Load())
	}
	// Reads and writes of a refused connection fail without touching it.
	if _, err := c.Write([]byte("x")); !errors.Is(err, errPeerRefused) {
		t.Errorf("write: %v", err)
	}
	if _, err := c.Read(make([]byte, 1)); !errors.Is(err, errPeerRefused) {
		t.Errorf("read: %v", err)
	}
	// Without TCP addresses there is nothing to check: refused.
	c = &peerCheckedConn{Conn: fakeAddrConn{}, check: check}
	if err := c.verify(); !errors.Is(err, errPeerRefused) {
		t.Errorf("no address: %v", err)
	}
}

// Refusals are rate limited per user: a flood from one does not hide
// another's audit line, and only a user's first refusal says how to allow it.
func TestPeerCheckLogsPerUser(t *testing.T) {
	buf := captureLockedLog(t)
	check := newTestPeerCheck(nil)
	from := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1}
	for range 5 {
		check.refused("1001", "other user", from)
	}
	check.refused("1002", "other user", from)
	logs := buf.String()
	if n := strings.Count(logs, `="1001"`); n != 1 {
		t.Errorf("1001 logged %d times:\n%s", n, logs)
	}
	if !strings.Contains(logs, `="1002"`) {
		t.Errorf("1002 hidden:\n%s", logs)
	}
	// Past peerLogUsers, users share one limit.
	for i := range peerLogUsers + 5 {
		check.refused("x"+string(rune('a'+i%26))+strings.Repeat("y", i), "other user", from)
	}
	if len(check.logs) > peerLogUsers+1 {
		t.Errorf("%d log limits kept", len(check.logs))
	}
}

func TestNewLocalPeerCheck(t *testing.T) {
	check := newLocalPeerCheck([]string{"no-such-user-termote"})
	if peerOwner == nil {
		if check != nil {
			t.Fatal("check without a lookup")
		}
		return
	}
	if check == nil || len(check.trusted) < 2 {
		t.Fatalf("check %+v", check)
	}
	for _, id := range trustedPeerIDs() {
		if !check.trusted[id] {
			t.Errorf("%s not trusted", id)
		}
	}
}

type fakeAddrConn struct {
	net.Conn
	remote, local string
}

func (c fakeAddrConn) RemoteAddr() net.Addr { return tcpAddrOrNil(c.remote) }
func (c fakeAddrConn) LocalAddr() net.Addr  { return tcpAddrOrNil(c.local) }
func (c fakeAddrConn) Close() error         { return nil }
func (c fakeAddrConn) Read([]byte) (int, error) {
	return 0, io.EOF
}
func (c fakeAddrConn) Write(b []byte) (int, error) { return len(b), nil }

func tcpAddrOrNil(s string) net.Addr {
	if s == "" {
		return &net.UnixAddr{Name: "@", Net: "unix"}
	}
	a, _ := net.ResolveTCPAddr("tcp", s)
	return a
}

// lockedLog is a log capture safe to read while a server goroutine writes.
type lockedLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func captureLockedLog(t *testing.T) *lockedLog {
	t.Helper()
	l := &lockedLog{}
	log.SetOutput(l)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return l
}

// Under WSL 2 a loopback connection from Windows has no client socket on
// the Linux side: accepted only while the server end stays established,
// and only where foreignLoopback is on.
func TestPeerCheckForeignLoopback(t *testing.T) {
	client := netip.MustParseAddrPort("127.0.0.1:55041")
	server := netip.MustParseAddrPort("127.0.0.1:7680")
	for name, tc := range map[string]struct {
		on         bool
		serverEnds []error // the server end at each look
		clientLate error   // the client end at the second look
		want       bool
	}{
		"windows":               {true, []error{nil, nil}, errPeerAbsent, true},
		"not under WSL":         {false, []error{nil, nil}, errPeerAbsent, false},
		"server end gone":       {true, []error{errPeerNotFound}, errPeerAbsent, false},
		"reset during the wait": {true, []error{nil, errPeerNotFound}, errPeerAbsent, false},
		"client end appeared":   {true, []error{nil, nil}, nil, false},
	} {
		serverLooks, clientLooks := 0, 0
		check := newTestPeerCheck(func(c, s netip.AddrPort) (string, error) {
			if c == server {
				err := errPeerNotFound
				if serverLooks < len(tc.serverEnds) {
					err = tc.serverEnds[serverLooks]
				}
				serverLooks++
				return "1000", err
			}
			clientLooks++
			if clientLooks == 1 {
				return "", errPeerAbsent
			}
			return "1001", tc.clientLate
		})
		check.trusted[foreignPeerID] = true
		check.foreignLoopback = tc.on
		conn := fakeAddrConn{remote: client.String(), local: server.String()}
		if got := check.allows(conn); got != tc.want {
			t.Errorf("%s: allowed = %v", name, got)
		}
	}
	// A closed client end (TIME_WAIT) is never taken for Windows.
	check := newTestPeerCheck(func(netip.AddrPort, netip.AddrPort) (string, error) { return "", errPeerNotFound })
	check.trusted[foreignPeerID], check.foreignLoopback = true, true
	if check.allows(fakeAddrConn{remote: client.String(), local: server.String()}) {
		t.Error("closed client end allowed")
	}
}

// Each user is named by the account name or by the numeric id.
func TestLookupLocalUser(t *testing.T) {
	me, err := user.Current()
	if err != nil || me.Username == "" {
		t.Skip("no account name for the current user")
	}
	for _, name := range []string{me.Username, me.Uid} {
		if id, err := lookupLocalUser(name); err != nil || id != me.Uid {
			t.Errorf("%s: %q %v, want %s", name, id, err, me.Uid)
		}
	}
	if _, err := lookupLocalUser("no-such-user-termote"); err == nil {
		t.Error("unknown user found")
	}
}

// A check built with --allow-local-user trusts the named user and skips an
// unknown one; without an owner lookup there is no check at all.
func TestNewLocalPeerCheckAllowList(t *testing.T) {
	me, err := user.Current()
	if err != nil || me.Username == "" {
		t.Skip("no account name for the current user")
	}
	if peerOwner == nil {
		t.Skip("no owner lookup on this OS")
	}
	captureLockedLog(t)
	check := newLocalPeerCheck([]string{me.Username, "no-such-user-termote"})
	if check == nil || !check.trusted[me.Uid] || check.trusted["no-such-user-termote"] {
		t.Fatalf("check %+v", check)
	}
}

func TestNewLocalPeerCheckWithoutOwner(t *testing.T) {
	saved := peerOwner
	peerOwner = nil
	t.Cleanup(func() { peerOwner = saved })
	if newLocalPeerCheck(nil) != nil {
		t.Error("check without an owner lookup")
	}
}

// The first refusal of a named user says how to allow it; later ones do not.
func TestPeerCheckRefusedHint(t *testing.T) {
	me, err := user.Current()
	if err != nil || me.Username == "" {
		t.Skip("no account name for the current user")
	}
	buf := captureLockedLog(t)
	check := newTestPeerCheck(nil)
	from := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1}
	check.refused(me.Uid, "other user", from)
	check.refused(me.Uid, "other user", from)
	logs := buf.String()
	if hint := "--allow-local-user " + me.Username; strings.Count(logs, hint) != 1 {
		t.Errorf("hint %q logged %d times:\n%s", hint, strings.Count(logs, hint), logs)
	}
}

// A failed interface read keeps the last list: a local address stays local,
// and with no list yet nothing counts as this machine's.
func TestPeerCheckKeepsAddrsOnReadFailure(t *testing.T) {
	buf := captureLockedLog(t)
	ip := netip.MustParseAddr("192.0.2.7")
	failing := func() ([]net.Addr, error) { return nil, errors.New("no interfaces") }

	check := newTestPeerCheck(nil)
	check.interfaceAddrs = failing
	check.addrs = map[netip.Addr]bool{ip: true}
	check.addrsRead = time.Now().Add(-time.Hour)
	if !check.fromThisMachine(ip) {
		t.Error("last list dropped on a failed read")
	}

	fresh := newTestPeerCheck(nil)
	fresh.interfaceAddrs = failing
	if fresh.fromThisMachine(ip) {
		t.Error("address counted as local with no list")
	}
	if !strings.Contains(buf.String(), "cannot list this machine's addresses") {
		t.Errorf("read failure not logged:\n%s", buf.String())
	}
}
