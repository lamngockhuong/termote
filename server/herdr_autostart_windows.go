//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// herdrServerSysProcAttrs start herdr without a console window and in a
// process group of its own, first out of any job serve runs in (the
// Scheduled Task's), so ending the task, the Startup launcher or serve itself
// leaves it running. A job that forbids breaking away refuses the first; the
// second then starts herdr inside it, like the psmux server serve starts.
// Serve itself is never in a kill-on-close job (only its terminals are,
// pty_windows.go).
func herdrServerSysProcAttrs() []*syscall.SysProcAttr {
	flags := uint32(windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP)
	return []*syscall.SysProcAttr{
		{HideWindow: true, CreationFlags: flags | windows.CREATE_BREAKAWAY_FROM_JOB},
		{HideWindow: true, CreationFlags: flags},
	}
}

// herdrStartRefused reports a start refused for breaking away from the job.
func herdrStartRefused(err error) bool { return errors.Is(err, windows.ERROR_ACCESS_DENIED) }

// herdrNotListening reports whether err means no pipe is named after herdr's
// socket. A pipe whose server is another user's, or busy, is not that.
func herdrNotListening(err error) bool {
	var pe *herdrPipeUserError
	if errors.As(err, &pe) {
		return false
	}
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND)
}

// herdrExeName names the .exe: looking up a bare name would also match a
// herdr.cmd shim first in PATHEXT order.
func herdrExeName(name string) string {
	if filepath.Ext(name) == "" {
		return name + ".exe"
	}
	return name
}

// herdrRunnable allows only an .exe, never a script cmd.exe would run.
func herdrRunnable(path string) bool { return strings.EqualFold(filepath.Ext(path), ".exe") }

// openHerdrLog opens herdr's log to append to. The herdr server keeps it open
// for as long as it runs, which outlives termote: FILE_SHARE_DELETE lets
// `termote logs clean` and `uninstall --purge` delete it meanwhile, which a
// file opened by os.OpenFile would refuse.
func openHerdrLog(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.FILE_APPEND_DATA|windows.SYNCHRONIZE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}
