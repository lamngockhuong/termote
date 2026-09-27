//go:build linux

package main

import "syscall"

// terminalSysProcAttr starts the child in its own session with the PTY as
// controlling terminal. Pdeathsig kills it if the server dies without cleaning
// up (SIGKILL, OOM killer).
func terminalSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true, Setctty: true, Pdeathsig: syscall.SIGKILL}
}

// observerSysProcAttr puts a piped helper (herdr observe) in its own process
// group, killed with the server like a terminal.
func observerSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

// reapOrphanTerminals is a no-op on Linux: Pdeathsig already ends terminals
// whose server died.
func reapOrphanTerminals(func(cmdline string) bool) {}
