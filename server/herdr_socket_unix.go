//go:build !windows

package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
)

// herdrSocketPath returns $HERDR_SOCKET_PATH, else herdr.sock in herdr's
// config directory: $XDG_CONFIG_HOME/herdr, else ~/.config/herdr (the order
// herdr itself uses).
func herdrSocketPath() string {
	if p := os.Getenv("HERDR_SOCKET_PATH"); p != "" {
		return p
	}
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "herdr", "herdr.sock")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "herdr", "herdr.sock")
}

// dialHerdr connects to herdr's Unix socket at path.
func dialHerdr(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", path)
}
