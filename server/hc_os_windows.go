//go:build windows

package main

import (
	"context"
	"net"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"

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

// hcDefaultEndpoint is the pipe hc dials without HC_SOCKET (herdr-core
// paths.rs, platform/windows.rs endpoints): \\.\pipe\herdr-core-<USERNAME's
// ASCII letters and digits>-<session>.sock. A running core holds byte 0 of
// core.lock (platform/windows.rs try_lock), a mandatory lock on Windows, so
// that file cannot be read while the core runs.
func hcDefaultEndpoint(env []string) string {
	var user strings.Builder
	for _, r := range hcEnvValue(env, "USERNAME") {
		if r < 0x80 && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
			user.WriteRune(r)
		}
	}
	return `\\.\pipe\herdr-core-` + user.String() + "-" + hcSession(env) + ".sock"
}

// hcDialProbe connects to the core's named pipe, only to see it answer. Like
// Herdr's pipe, it is kept only when its server runs as this user.
func hcDialProbe(ctx context.Context, path string) (net.Conn, error) {
	return dialHerdr(ctx, path)
}
