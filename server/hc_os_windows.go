//go:build windows

package main

import (
	"context"
	"net"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// hcConnectSysProcAttr starts hc connect without a console window.
func hcConnectSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

// hcDefaultStateHome is herdr-core's state home without XDG_STATE_HOME:
// %LOCALAPPDATA%, else %USERPROFILE%\AppData\Local (platform/windows.rs
// data_dirs).
func hcDefaultStateHome(env []string) string {
	if local := hcEnvValue(env, "LOCALAPPDATA"); local != "" {
		return local
	}
	profile := hcEnvValue(env, "USERPROFILE")
	if profile == "" {
		profile = `C:\`
	}
	return filepath.Join(profile, "AppData", "Local")
}

// hcDialProbe connects to the core's named pipe, only to see it answer. Like
// Herdr's pipe, it is kept only when its server runs as this user.
func hcDialProbe(ctx context.Context, path string) (net.Conn, error) {
	return dialHerdr(ctx, path)
}
