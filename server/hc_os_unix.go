//go:build !windows

package main

import (
	"context"
	"net"
	"path/filepath"
	"syscall"
)

// hcConnectSysProcAttr: hc connect stays in serve's process group, and ends
// when its stdin closes.
func hcConnectSysProcAttr() *syscall.SysProcAttr { return nil }

// hcDefaultStateHome is herdr-core's state home without XDG_STATE_HOME:
// $HOME/.local/state (platform/unix.rs data_dirs).
func hcDefaultStateHome(env []string) string {
	home := hcEnvValue(env, "HOME")
	if home == "" {
		home = "/"
	}
	return filepath.Join(home, ".local", "state")
}

// hcDialProbe connects to the core's Unix socket, only to see it answer.
func hcDialProbe(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", path)
}
