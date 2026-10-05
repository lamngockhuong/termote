//go:build !windows

package main

import (
	"io/fs"
	"os"
	"syscall"
)

// tmuxFilesSupported: tmux reports #{pane_current_path}.
const tmuxFilesSupported = true

// openNonblock opens a FIFO without waiting for a writer, so a request for
// one never hangs; regular files ignore it.
const openNonblock = syscall.O_NONBLOCK

// createBadChars: a Unix file name takes every character but '/' and NUL.
const createBadChars = ""

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

// fileLinks is the number of hard links to the file fi describes.
func fileLinks(_ *os.File, fi fs.FileInfo) (uint64, error) {
	return uint64(fi.Sys().(*syscall.Stat_t).Nlink), nil
}

// fileOwnedByServer reports whether the file fi describes belongs to the
// user the server runs as.
func fileOwnedByServer(fi fs.FileInfo) bool {
	return int(fi.Sys().(*syscall.Stat_t).Uid) == os.Geteuid()
}
