//go:build !windows

package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
)

// herdrSocketPath returns $HERDR_SOCKET_PATH, else herdr.sock in herdr's
// config directory.
func herdrSocketPath() string {
	if p := os.Getenv("HERDR_SOCKET_PATH"); p != "" {
		return p
	}
	return filepath.Join(herdrConfigDir(), "herdr.sock")
}

// herdrConfigDir is herdr's config directory, where it keeps its session
// file whatever socket it serves: $XDG_CONFIG_HOME/herdr, else
// ~/.config/herdr (the order herdr itself uses).
func herdrConfigDir() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "herdr")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "herdr")
}

// dialHerdr connects to herdr's Unix socket at path, kept only when the
// process serving it runs as this user or root, as the Windows pipe is: a
// socket another user made first (HERDR_SOCKET_PATH in a shared directory)
// would get the keys typed and answer with a screen of its own. Such a
// socket is a herdrPipeUserError, never a reason to start herdr.
func dialHerdr(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		conn.Close()
		return nil, &herdrPipeUserError{errLocalServerUntrusted}
	}
	uid, err := localPeerUID(uc)
	if err != nil {
		conn.Close()
		return nil, &herdrPipeUserError{err}
	}
	if uid != os.Getuid() && uid != 0 {
		conn.Close()
		return nil, &herdrPipeUserError{fmt.Errorf("the herdr socket is served by uid %d", uid)}
	}
	return conn, nil
}
