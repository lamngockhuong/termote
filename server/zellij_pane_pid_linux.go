package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// Netlink sock_diag for AF_UNIX (linux/unix_diag.h).
const (
	unixDiagReqLen  = 24
	unixDiagMsgLen  = 16
	unixDiagShowVFS = 0x2
	unixDiagVFS     = 1 // UNIX_DIAG_VFS attribute
	tcpListen       = 10
)

// procEnviron is pid's environment.
func procEnviron(pid int) ([]string, bool) { return procNULFields(pid, "environ") }

// zellijSocketOwner finds the process listening on the socket file at path:
// the kernel names the listening socket bound to that file (its inode, which
// a rename keeps), and the one zellij server of this user holding it is the
// owner.
func zellijSocketOwner(path string) (int, error) {
	fi, err := os.Lstat(path)
	if err != nil || fi.Mode()&os.ModeSocket == 0 {
		return 0, errZellijServerNotFound
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) != os.Getuid() {
		return 0, errZellijServerNotFound
	}
	// st_dev is the user-space encoding; the kernel reports s_dev.
	kdev := uint32(unix.Major(st.Dev))<<20 | uint32(unix.Minor(st.Dev))
	inode, err := unixListenerByVFS(uint32(st.Ino), kdev)
	if err != nil {
		return 0, err
	}
	return socketHolder(inode)
}

// unixListenerByVFS dumps the listening AF_UNIX sockets with their bound
// file and returns the socket inode of the one bound to (vfsIno, vfsDev).
func unixListenerByVFS(vfsIno, vfsDev uint32) (uint32, error) {
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, unix.NETLINK_SOCK_DIAG)
	if err != nil {
		return 0, errZellijServerNotFound
	}
	defer unix.Close(fd)
	tv := unix.NsecToTimeval(peerLookupTimeout.Nanoseconds())
	_ = unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv)
	req := make([]byte, nlmsgHdrLen+unixDiagReqLen)
	binary.NativeEndian.PutUint32(req[0:], uint32(len(req)))
	binary.NativeEndian.PutUint16(req[4:], unix.SOCK_DIAG_BY_FAMILY)
	binary.NativeEndian.PutUint16(req[6:], unix.NLM_F_REQUEST|unix.NLM_F_DUMP)
	r := req[nlmsgHdrLen:]
	r[0] = unix.AF_UNIX
	binary.NativeEndian.PutUint32(r[4:], 1<<tcpListen)
	binary.NativeEndian.PutUint32(r[12:], unixDiagShowVFS)
	if err := unix.Sendto(fd, req, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return 0, errZellijServerNotFound
	}
	buf := make([]byte, 32*1024)
	var found []uint32
	for {
		n, _, err := unix.Recvfrom(fd, buf, 0)
		if err != nil || n == 0 {
			return 0, errZellijServerNotFound
		}
		done, err := parseUnixDiagDump(buf[:n], vfsIno, vfsDev, &found)
		if err != nil {
			return 0, err
		}
		if done {
			break
		}
	}
	if len(found) != 1 {
		return 0, errZellijServerNotFound
	}
	return found[0], nil
}

// parseUnixDiagDump reads one buffer of a unix_diag dump, appending the
// socket inode of every socket bound to (vfsIno, vfsDev). done: the dump
// ended.
func parseUnixDiagDump(b []byte, vfsIno, vfsDev uint32, found *[]uint32) (bool, error) {
	for len(b) >= nlmsgHdrLen {
		l := int(binary.NativeEndian.Uint32(b[0:]))
		typ := binary.NativeEndian.Uint16(b[4:])
		if l < nlmsgHdrLen || l > len(b) {
			return false, errZellijServerNotFound
		}
		switch typ {
		case unix.NLMSG_DONE:
			return true, nil
		case unix.NLMSG_ERROR:
			return false, errZellijServerNotFound
		case unix.SOCK_DIAG_BY_FAMILY:
			m := b[nlmsgHdrLen:l]
			if len(m) >= unixDiagMsgLen {
				inode := binary.NativeEndian.Uint32(m[4:])
				for a := m[unixDiagMsgLen:]; len(a) >= 4; {
					al := int(binary.NativeEndian.Uint16(a[0:]))
					at := binary.NativeEndian.Uint16(a[2:])
					if al < 4 || al > len(a) {
						break
					}
					if at == unixDiagVFS && al >= 12 &&
						binary.NativeEndian.Uint32(a[4:]) == vfsIno && binary.NativeEndian.Uint32(a[8:]) == vfsDev {
						*found = append(*found, inode)
					}
					a = a[min((al+3)&^3, len(a)):]
				}
			}
		}
		b = b[min((l+3)&^3, len(b)):]
	}
	return false, nil
}

// socketHolder returns the one zellij server of this user holding the
// socket inode.
func socketHolder(inode uint32) (int, error) {
	want := "socket:[" + strconv.FormatUint(uint64(inode), 10) + "]"
	uid := os.Getuid()
	owner := 0
	for _, pid := range procAllPIDs() {
		fi, err := os.Stat(filepath.Join(procRoot, strconv.Itoa(pid)))
		if err != nil {
			continue
		}
		if st, ok := fi.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != uid {
			continue
		}
		if procExeBase(pid) != "zellij" {
			continue
		}
		args := procArgs(pid)
		if len(args) < 2 || args[1] != "--server" {
			continue
		}
		fds, err := os.ReadDir(filepath.Join(procRoot, strconv.Itoa(pid), "fd"))
		if err != nil {
			continue
		}
		for _, fd := range fds {
			link, err := os.Readlink(filepath.Join(procRoot, strconv.Itoa(pid), "fd", fd.Name()))
			if err == nil && strings.EqualFold(link, want) {
				if owner != 0 && owner != pid {
					return 0, errZellijServerNotFound
				}
				owner = pid
				break
			}
		}
	}
	if owner == 0 {
		return 0, errZellijServerNotFound
	}
	return owner, nil
}
