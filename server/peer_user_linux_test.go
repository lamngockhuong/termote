package main

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// sockDiagReply builds the kernel's reply to an exact lookup.
func sockDiagReply(family, state byte, src, dst netip.AddrPort, uid, inode uint32) []byte {
	b := make([]byte, nlmsgHdrLen+inetDiagMsgLen)
	binary.NativeEndian.PutUint32(b[0:], uint32(len(b)))
	binary.NativeEndian.PutUint16(b[4:], unix.SOCK_DIAG_BY_FAMILY)
	m := b[nlmsgHdrLen:]
	m[0], m[1] = family, state
	putDiagSockID(m[4:], family, src, dst)
	binary.NativeEndian.PutUint32(m[64:], uid)
	binary.NativeEndian.PutUint32(m[68:], inode)
	return b
}

func sockDiagError(errno unix.Errno) []byte {
	b := make([]byte, nlmsgHdrLen+4)
	binary.NativeEndian.PutUint16(b[4:], unix.NLMSG_ERROR)
	binary.NativeEndian.PutUint32(b[nlmsgHdrLen:], uint32(-int32(errno)))
	return b
}

func TestParseSockDiagReply(t *testing.T) {
	client := netip.MustParseAddrPort("127.0.0.2:50000")
	server := netip.MustParseAddrPort("127.0.0.1:7680")
	client6 := netip.MustParseAddrPort("[::1]:50000")
	server6 := netip.MustParseAddrPort("[::1]:7680")
	for name, tc := range map[string]struct {
		reply          []byte
		client, server netip.AddrPort
		want           string
		err            error
	}{
		"established": {sockDiagReply(unix.AF_INET, 1, client, server, 1001, 9), client, server, "1001", nil},
		"ipv6":        {sockDiagReply(unix.AF_INET6, 1, client6, server6, 1002, 9), client6, server6, "1002", nil},
		// Closed sockets carry uid 0 and no inode: never root.
		"time wait": {sockDiagReply(unix.AF_INET, 6, client, server, 0, 0), client, server, "", errPeerNotFound},
		"no inode":  {sockDiagReply(unix.AF_INET, 1, client, server, 0, 0), client, server, "", errPeerNotFound},
		// The kernel falls back to a listener when no connection matches.
		// The kernel falls back to a listener when no connection matches:
		// the client end is absent.
		"listener": {sockDiagReply(unix.AF_INET, 10, server, netip.MustParseAddrPort("0.0.0.0:0"), 1000, 9), client, server, "", errPeerAbsent},
		"other connection": {sockDiagReply(unix.AF_INET, 1, netip.MustParseAddrPort("127.0.0.1:50001"), server, 1000, 9),
			client, server, "", errPeerAbsent},
		"enoent":        {sockDiagError(unix.ENOENT), client, server, "", errPeerAbsent},
		"eperm":         {sockDiagError(unix.EPERM), client, server, "", errSockDiagUnavailable},
		"short":         {[]byte{1, 2}, client, server, "", errSockDiagUnavailable},
		"truncated":     {sockDiagReply(unix.AF_INET, 1, client, server, 1, 1)[:40], client, server, "", errSockDiagUnavailable},
		"other message": {diagMsgType(sockDiagReply(unix.AF_INET, 1, client, server, 1, 1), unix.NLMSG_DONE), client, server, "", errSockDiagUnavailable},
	} {
		got, err := parseSockDiagReply(tc.reply, tc.client, tc.server)
		if got != tc.want || !errors.Is(err, tc.err) {
			t.Errorf("%s: %q %v, want %q %v", name, got, err, tc.want, tc.err)
		}
	}
}

// diagMsgType sets the netlink message type of a reply.
func diagMsgType(b []byte, typ uint16) []byte {
	binary.NativeEndian.PutUint16(b[4:], typ)
	return b
}

// A connection that no table lists is absent, not a failed read.
func TestProcNetOwnerAbsent(t *testing.T) {
	client := netip.MustParseAddrPort("127.0.0.1:1")
	server := netip.MustParseAddrPort("127.0.0.1:2")
	if _, err := procNetOwner(client, server); !errors.Is(err, errPeerAbsent) {
		t.Errorf("err %v, want errPeerAbsent", err)
	}
}

// The lookups find this process's own connection, on IPv4, on a dual-stack
// listener and on IPv6.
func TestPeerOwnerFindsOwnConnection(t *testing.T) {
	me := strconv.Itoa(os.Getuid())
	for _, l := range []struct{ listen, dial string }{{"127.0.0.1:0", "127.0.0.1"}, {"[::]:0", "127.0.0.1"}, {"[::1]:0", "::1"}} {
		ln, err := net.Listen("tcp", l.listen)
		if err != nil {
			t.Logf("%s: %v", l.listen, err)
			continue
		}
		c, err := net.Dial("tcp", net.JoinHostPort(l.dial, strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)))
		if err != nil {
			t.Fatal(err)
		}
		s, err := ln.Accept()
		if err != nil {
			t.Fatal(err)
		}
		client, _ := connAddrPort(s.RemoteAddr())
		server, _ := connAddrPort(s.LocalAddr())
		for name, lookup := range map[string]func(netip.AddrPort, netip.AddrPort) (string, error){
			"peerOwner": peerOwner, "procNetOwner": procNetOwner,
		} {
			if id, err := lookup(client, server); id != me || err != nil {
				t.Errorf("%s %s: %q %v, want %s", l.listen, name, id, err, me)
			}
		}
		c.Close()
		s.Close()
		ln.Close()
	}
}

func TestIsWSLRelease(t *testing.T) {
	for release, want := range map[string]bool{
		"6.18.33.2-microsoft-standard-WSL2\n": true,
		"5.10.16.3-Microsoft-standard":        true,
		"6.8.0-45-generic\n":                  false,
	} {
		if got := isWSLRelease(release); got != want {
			t.Errorf("%q: %v", release, got)
		}
	}
}

// A client that aborts its socket (SO_LINGER 0) right after sending leaves
// no row at all; even where Windows' connections are accepted without one
// (WSL), its request never reaches the handler.
func TestPeerCheckAbortedClient(t *testing.T) {
	sent := make(chan struct{})
	var first atomic.Bool
	first.Store(true)
	check := newTestPeerCheck(func(client, server netip.AddrPort) (string, error) {
		if first.CompareAndSwap(true, false) {
			<-sent
			time.Sleep(50 * time.Millisecond)
		}
		return peerOwner(client, server)
	})
	check.trusted = map[string]bool{strconv.Itoa(os.Getuid()): true, foreignPeerID: true}
	check.foreignLoopback = true
	addr, hits := servePeerChecked(t, check)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(c, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
	c.(*net.TCPConn).SetLinger(0)
	c.Close()
	close(sent)
	time.Sleep(300 * time.Millisecond)
	if hits.Load() != 0 {
		t.Fatal("request of an aborted client reached the handler")
	}
}

// A client that sends its request and closes at once leaves only a closed
// socket (uid 0 to the kernel): the request never reaches the handler.
func TestPeerCheckSendThenClose(t *testing.T) {
	closed := make(chan struct{})
	var waitClose atomic.Bool
	waitClose.Store(true)
	check := newTestPeerCheck(func(client, server netip.AddrPort) (string, error) {
		if waitClose.Load() {
			<-closed
			time.Sleep(50 * time.Millisecond) // let the FIN reach the server
		}
		return peerOwner(client, server)
	})
	check.trusted = map[string]bool{"0": true, strconv.Itoa(os.Getuid()): true}
	addr, hits := servePeerChecked(t, check)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(c, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
	c.Close()
	close(closed)
	time.Sleep(300 * time.Millisecond)
	if hits.Load() != 0 {
		t.Fatalf("request of a closed client reached the handler")
	}
	// The same user with the connection open is served.
	waitClose.Store(false)
	if got := peerTestGet(t, addr); hits.Load() != 1 {
		t.Fatalf("open connection: %q", got)
	}
}
