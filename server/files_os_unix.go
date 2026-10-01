//go:build !windows

package main

import (
	"os"
	"syscall"
)

// tmuxFilesSupported: tmux reports #{pane_current_path}.
const tmuxFilesSupported = true

// openNonblock opens a FIFO without waiting for a writer, so a request for
// one never hangs; regular files ignore it.
const openNonblock = syscall.O_NONBLOCK

// systemDenyDirs hold process environments and devices; never served.
var systemDenyDirs = []string{"/proc", "/sys", "/dev"}

// ownedByServer reports whether path belongs to the user the server runs as.
func ownedByServer(path string) bool {
	fi, err := os.Lstat(path)
	if err != nil {
		return false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Geteuid()
}
