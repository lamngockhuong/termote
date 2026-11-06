//go:build !windows

package main

import (
	"syscall"
	"time"
)

// sshProcOS is empty on Unix: ssh runs in its own process group
// (observerSysProcAttr; on Linux it also dies with the server).
type sshProcOS struct{}

func (p *sshProc) attach() error { return nil }

// kill ends ssh's process group: SIGTERM, then SIGKILL if it is still there
// after a moment. ssh keeps no state worth a longer wait.
func (p *sshProc) kill() {
	pid := p.cmd.Process.Pid
	syscall.Kill(-pid, syscall.SIGTERM)
	if !p.exited(sshKillWait) {
		syscall.Kill(-pid, syscall.SIGKILL)
	}
}

// sshKillWait is how long a stopped ssh gets before SIGKILL.
const sshKillWait = time.Second
