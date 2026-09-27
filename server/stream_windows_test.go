//go:build windows

package main

import (
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func helperTermSize() (int, int) {
	var info windows.ConsoleScreenBufferInfo
	if windows.GetConsoleScreenBufferInfo(windows.Handle(os.Stdout.Fd()), &info) != nil {
		return 0, 0
	}
	w := info.Window
	return int(w.Right-w.Left) + 1, int(w.Bottom-w.Top) + 1
}

func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if windows.GetExitCodeProcess(h, &code) != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE
}

func killPID(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		p.Kill()
	}
}

// stopModes: Windows has no SIGTERM to send, so only the hard kill
// (TerminateProcess, like Stop-Process -Force) is tested.
func stopModes() []bool { return []bool{true} }

// hardKillEndsTree: the Job Object kills the whole tree.
const hardKillEndsTree = true

func stopServer(t *testing.T, p *os.Process, _ bool) {
	t.Helper()
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
}
