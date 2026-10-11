//go:build !windows

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// maxSocketPath is the longest socket path both Linux (108 bytes) and macOS
// (104) take, the terminating NUL left out.
const maxSocketPath = 103

// localSocketPath is the socket of the server on port, in dir.
func localSocketPath(dir, port string) string { return filepath.Join(dir, port+".sock") }

// fileOwner is the uid owning fi. Tests replace it.
var fileOwner = func(fi os.FileInfo) (int, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(st.Uid), true
}

// checkSocketDir fails unless dir is a directory (not a symlink) of the
// current user that only that user can enter (mode 0700).
func checkSocketDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	if uid, ok := fileOwner(fi); !ok || uid != os.Getuid() {
		return fmt.Errorf("%s is not owned by the current user", dir)
	}
	if fi.Mode().Perm() != 0o700 {
		return fmt.Errorf("%s has mode %#o, not 0700", dir, fi.Mode().Perm())
	}
	return nil
}

// ensureSocketDir makes dir, the local socket's, as only the current user
// can enter (0700), and checks it is: never through a symlink, or another
// user's dir. The CLI writes its sign-in link files there too.
func ensureSocketDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// MkdirAll keeps the mode of a dir already there; an umask can widen
	// a new one.
	if fi, err := os.Lstat(dir); err != nil {
		return err
	} else if uid, ok := fileOwner(fi); !fi.IsDir() || !ok || uid != os.Getuid() {
		return fmt.Errorf("%s is not a directory of the current user", dir)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	return checkSocketDir(dir)
}

// openLocalSocket listens on <dir>/<port>.sock and returns a cleanup to run
// once the listener is closed. dir is made 0700 and checked; the socket is
// chmod 0600 right after it is made, and checked again. A socket left by a
// server that died is replaced; one a live server answers on is not
// (errLocalSocketBusy). The cleanup, run once the listener is closed,
// removes the socket only while it is the one made here and nothing answers
// on it: during an update or restart the old server, still shutting down,
// must not remove the socket the new one has made.
func openLocalSocket(dir, port string) (net.Listener, func(), error) {
	path := localSocketPath(dir, port)
	if len(path) > maxSocketPath {
		return nil, nil, fmt.Errorf("the path %s is longer than %d bytes", path, maxSocketPath)
	}
	if err := ensureSocketDir(dir); err != nil {
		return nil, nil, err
	}
	if fi, err := os.Lstat(path); err == nil {
		if fi.Mode().Type() != os.ModeSocket {
			return nil, nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		if c, err := net.DialTimeout("unix", path, localDialTimeout); err == nil {
			c.Close()
			return nil, nil, errLocalSocketBusy
		}
		if err := os.Remove(path); err != nil {
			return nil, nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, nil, err
	}
	// Closing never unlinks: the cleanup does, after its own check.
	ln.SetUnlinkOnClose(false)
	fail := func(err error) (net.Listener, func(), error) {
		ln.Close()
		os.Remove(path)
		return nil, nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fail(err)
	}
	made, err := os.Lstat(path)
	if err != nil {
		return fail(err)
	}
	if uid, ok := fileOwner(made); made.Mode().Type() != os.ModeSocket || made.Mode().Perm() != 0o600 || !ok || uid != os.Getuid() {
		return fail(fmt.Errorf("%s did not get mode 0600 for the current user", path))
	}
	cleanup := func() {
		cur, err := os.Lstat(path)
		if err != nil || !os.SameFile(made, cur) {
			return
		}
		// The same inode is not proof enough: a filesystem can give a new
		// socket the number of the one just removed (tmpfs does), so one a
		// server answers on is another server's.
		if c, err := net.DialTimeout("unix", path, localDialTimeout); err == nil {
			c.Close()
			return
		}
		os.Remove(path)
	}
	return ln, cleanup, nil
}

// localPeerUID is the uid of the process at the other end of a Unix socket
// connection. Tests replace it.
var localPeerUID = unixPeerUID

// dialLocalServerOS connects to <dir>/<port>.sock after checking dir is the
// current user's own 0700 dir, then checks the server end belongs to the
// current user or root.
func dialLocalServerOS(dir string, port int) (net.Conn, error) {
	if err := checkSocketDir(dir); err != nil {
		return nil, err
	}
	path := localSocketPath(dir, strconv.Itoa(port))
	if len(path) > maxSocketPath {
		return nil, fmt.Errorf("the path %s is longer than %d bytes", path, maxSocketPath)
	}
	c, err := net.DialTimeout("unix", path, localDialTimeout)
	if err != nil {
		return nil, err
	}
	uc, ok := c.(*net.UnixConn)
	if !ok {
		c.Close()
		return nil, errLocalServerUntrusted
	}
	uid, err := localPeerUID(uc)
	if err != nil || uid != os.Getuid() && uid != 0 {
		c.Close()
		return nil, errLocalServerUntrusted
	}
	return c, nil
}
