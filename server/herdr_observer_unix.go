//go:build !windows

package main

import (
	"syscall"
	"time"
)

// observerProc is empty on Unix: the observer runs in its own process group
// (observerSysProcAttr), found again from its pid.
type observerProc struct{}

// attach has nothing to do on Unix; the process group exists from the start.
func (p *observer) attach() error { return nil }

// kill ends the observer: SIGTERM, then SIGKILL after processKillWait.
func (p *observer) kill() {
	pid := p.cmd.Process.Pid
	select {
	case <-p.waited:
	default:
		syscall.Kill(-pid, syscall.SIGTERM)
	}
	select {
	case <-p.waited:
	case <-time.After(processKillWait):
		syscall.Kill(-pid, syscall.SIGKILL)
		<-p.waited
	}
	p.killGroup()
}

// killGroup removes anything left in the observer's process group. The kernel
// does not reuse a pid while it still names a live group.
func (p *observer) killGroup() {
	syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
}
