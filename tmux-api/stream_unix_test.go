//go:build !windows

package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

func helperTermSize() (int, int) {
	ws, err := unix.IoctlGetWinsize(int(os.Stdin.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0, 0
	}
	return int(ws.Col), int(ws.Row)
}

// processAlive treats a zombie as dead: it has exited and only waits to be
// reaped by its new parent.
func processAlive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	if runtime.GOOS == "linux" {
		stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if err != nil {
			return false
		}
		if i := strings.LastIndexByte(string(stat), ')'); i >= 0 && i+2 < len(stat) && stat[i+2] == 'Z' {
			return false
		}
	}
	return true
}

func killPID(pid int) { syscall.Kill(pid, syscall.SIGKILL) }

// stopModes: SIGTERM everywhere; SIGKILL only where Pdeathsig ends the child.
func stopModes() []bool {
	if runtime.GOOS == "linux" {
		return []bool{false, true}
	}
	return []bool{false}
}

// hardKillEndsTree: Pdeathsig reaches the direct child only.
const hardKillEndsTree = false

func stopServer(t *testing.T, p *os.Process, hard bool) {
	t.Helper()
	sig := syscall.SIGTERM
	if hard {
		sig = syscall.SIGKILL
	}
	if err := p.Signal(sig); err != nil {
		t.Fatal(err)
	}
}
