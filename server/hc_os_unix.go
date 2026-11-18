//go:build !windows

package main

import (
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

// hcDefaultConfigHome is herdr-core's config home without XDG_CONFIG_HOME:
// $HOME/.config (platform/unix.rs data_dirs).
func hcDefaultConfigHome(env []string) string {
	home := hcEnvValue(env, "HOME")
	if home == "" {
		home = "/"
	}
	return filepath.Join(home, ".config")
}

// hcDefaultEndpoint: none, core.lock is read (its flock does not stop a
// read) and names the socket.
func hcDefaultEndpoint([]string) string { return "" }
