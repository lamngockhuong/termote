package main

import (
	"context"
	"encoding/binary"
	"errors"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// peerIDKey names the id in a local-user-refused audit line.
const peerIDKey = "uid"

// peerOwner finds the client end's owner through sock_diag, which looks the
// one socket up by its addresses (a /proc/net/tcp read lists every socket
// of the machine, too slow under a flood of connections). Where netlink is
// not allowed (a seccomp profile), it falls back to /proc/net/tcp.
//
// The kernel also answers ENOENT when its TCP diag handler is missing (a
// module not loaded): an absent client end is checked against the server
// end, which always exists, and only when that is absent too do the
// tables of /proc decide.
var peerOwner = func(client, server netip.AddrPort) (string, error) {
	uid, err := sockDiagOwner(client, server)
	if errors.Is(err, errPeerAbsent) {
		if _, serverErr := sockDiagOwner(server, client); errors.Is(serverErr, errPeerAbsent) {
			err = errSockDiagUnavailable
		}
	}
	if errors.Is(err, errSockDiagUnavailable) {
		return procNetOwner(client, server)
	}
	return uid, err
}

// selfPeerID is the server's own uid.
func selfPeerID() string { return strconv.Itoa(os.Getuid()) }

// trustedPeerIDs are trusted besides the server's own user: root.
func trustedPeerIDs() []string { return []string{"0"} }

// foreignLoopbackPossible reports whether this Linux runs under WSL 2 with
// mirrored networking, which delivers Windows' loopback connections to this
// one with no socket for their client end on this side. NAT mode reaches
// the server through a relay process of root, and WSL 1 shares Windows'
// own sockets: neither needs the exception.
func foreignLoopbackPossible() bool {
	b, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil || !isWSLRelease(string(b)) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "wslinfo", "--networking-mode").Output()
	return err == nil && strings.TrimSpace(string(out)) == "mirrored"
}

func isWSLRelease(release string) bool {
	return strings.Contains(strings.ToLower(release), "microsoft")
}

func procNetOwner(client, server netip.AddrPort) (string, error) {
	sawClosed := false
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		uid, found, closed := procNetConnOwner(string(b), client, server)
		if found {
			return uid, nil
		}
		sawClosed = sawClosed || closed
	}
	if sawClosed {
		return "", errPeerNotFound
	}
	return "", errPeerAbsent
}

// errSockDiagUnavailable means netlink could not be used at all.
var errSockDiagUnavailable = errors.New("sock_diag unavailable")

// inet_diag request and reply layouts (linux/inet_diag.h).
const (
	nlmsgHdrLen      = 16
	inetDiagReqLen   = 56 // family, protocol, ext, pad, states, inet_diag_sockid
	inetDiagMsgLen   = 72
	tcpEstablished   = 1
	inetDiagNoCookie = 0xffffffff
)

// sockDiagOwner asks the kernel for the socket whose local end is client and
// remote end server (inet_diag_dump_one: an exact lookup, not a dump).
func sockDiagOwner(client, server netip.AddrPort) (string, error) {
	family := byte(unix.AF_INET)
	if client.Addr().Is6() || server.Addr().Is6() {
		family = unix.AF_INET6
	}
	req := make([]byte, nlmsgHdrLen+inetDiagReqLen)
	binary.NativeEndian.PutUint32(req[0:], uint32(len(req)))
	binary.NativeEndian.PutUint16(req[4:], unix.SOCK_DIAG_BY_FAMILY)
	binary.NativeEndian.PutUint16(req[6:], unix.NLM_F_REQUEST)
	r := req[nlmsgHdrLen:]
	r[0], r[1] = family, unix.IPPROTO_TCP
	binary.NativeEndian.PutUint32(r[4:], 1<<tcpEstablished)
	putDiagSockID(r[8:], family, client, server)
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, unix.NETLINK_INET_DIAG)
	if err != nil {
		return "", errSockDiagUnavailable
	}
	defer unix.Close(fd)
	tv := unix.NsecToTimeval(peerLookupTimeout.Nanoseconds())
	_ = unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv)
	if err := unix.Sendto(fd, req, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return "", errSockDiagUnavailable
	}
	buf := make([]byte, 8192)
	n, _, err := unix.Recvfrom(fd, buf, 0)
	if err != nil {
		return "", errSockDiagUnavailable
	}
	return parseSockDiagReply(buf[:n], client, server)
}

// putDiagSockID writes inet_diag_sockid: ports and addresses in network
// order, src being the socket's local end; no interface, no cookie.
func putDiagSockID(b []byte, family byte, src, dst netip.AddrPort) {
	binary.BigEndian.PutUint16(b[0:], src.Port())
	binary.BigEndian.PutUint16(b[2:], dst.Port())
	putDiagAddr(b[4:20], family, src.Addr())
	putDiagAddr(b[20:36], family, dst.Addr())
	binary.NativeEndian.PutUint32(b[40:], inetDiagNoCookie)
	binary.NativeEndian.PutUint32(b[44:], inetDiagNoCookie)
}

// putDiagAddr writes an AF_INET address in the first word, an AF_INET6 one
// in all four (an IPv4 end of an IPv6 request as ::ffff:a.b.c.d).
func putDiagAddr(b []byte, family byte, a netip.Addr) {
	if family == unix.AF_INET {
		v4 := a.As4()
		copy(b, v4[:])
		return
	}
	v6 := a.As16()
	copy(b, v6[:])
}

// parseSockDiagReply reads the one reply to an exact lookup: an
// inet_diag_msg, or an error (ENOENT: no such socket).
func parseSockDiagReply(b []byte, client, server netip.AddrPort) (string, error) {
	if len(b) < nlmsgHdrLen {
		return "", errSockDiagUnavailable
	}
	switch binary.NativeEndian.Uint16(b[4:]) {
	case unix.NLMSG_ERROR:
		if len(b) >= nlmsgHdrLen+4 {
			if errno := -int32(binary.NativeEndian.Uint32(b[nlmsgHdrLen:])); errno == int32(unix.ENOENT) {
				return "", errPeerAbsent
			}
		}
		return "", errSockDiagUnavailable
	case unix.SOCK_DIAG_BY_FAMILY:
	default:
		return "", errSockDiagUnavailable
	}
	m := b[nlmsgHdrLen:]
	if len(m) < inetDiagMsgLen {
		return "", errSockDiagUnavailable
	}
	state := m[1]
	id := m[4:52]
	uid := binary.NativeEndian.Uint32(m[64:])
	inode := binary.NativeEndian.Uint32(m[68:])
	// The kernel falls back to a listener when no connection matches: then
	// the connection has no socket here. It reports a closed one (TIME_WAIT)
	// with uid 0: only the very connection asked for, established and still
	// owned, counts.
	if !diagIDMatches(id, m[0], client, server) {
		return "", errPeerAbsent
	}
	if state != tcpEstablished || inode == 0 {
		return "", errPeerNotFound
	}
	return strconv.FormatUint(uint64(uid), 10), nil
}

func diagIDMatches(id []byte, family byte, client, server netip.AddrPort) bool {
	src, dst := diagAddr(id[4:20], family), diagAddr(id[20:36], family)
	return binary.BigEndian.Uint16(id[0:]) == client.Port() && binary.BigEndian.Uint16(id[2:]) == server.Port() &&
		src == client.Addr() && dst == server.Addr()
}

func diagAddr(b []byte, family byte) netip.Addr {
	if family == unix.AF_INET {
		return netip.AddrFrom4([4]byte(b[:4]))
	}
	return netip.AddrFrom16([16]byte(b)).Unmap()
}
