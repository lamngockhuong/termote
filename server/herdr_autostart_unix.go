//go:build !windows

package main

import (
	"errors"
	"os"
	"syscall"
)

// herdrServerSysProcAttrs puts a started herdr server in its own session, so
// stopping serve's process group or terminal leaves it running; the systemd
// unit (KillMode=process) and the launchd agent (AbandonProcessGroup) leave
// it running too.
func herdrServerSysProcAttrs() []*syscall.SysProcAttr {
	return []*syscall.SysProcAttr{{Setsid: true}}
}

// herdrStartRefused never asks for another attempt: there is one way to start.
func herdrStartRefused(error) bool { return false }

// herdrNotListening reports whether err means nobody serves herdr's socket:
// it does not exist, or is left over from a herdr that died.
func herdrNotListening(err error) bool {
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED)
}

func herdrExeName(name string) string { return name }

func herdrRunnable(string) bool { return true }

// openHerdrLog opens herdr's log to append to, readable by the user only.
func openHerdrLog(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
}
