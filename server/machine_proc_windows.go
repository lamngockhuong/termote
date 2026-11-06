//go:build windows

package main

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

// sshProcOS holds the kill-on-close Job Object ssh runs in, so it dies with
// the server even when the server is killed hard.
type sshProcOS struct {
	job windows.Handle
}

func (p *sshProc) attach() error {
	job, err := newKillOnCloseJob()
	if err != nil {
		return fmt.Errorf("create job: %w", err)
	}
	proc, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(p.cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("open process: %w", err)
	}
	defer windows.CloseHandle(proc)
	if err := windows.AssignProcessToJobObject(job, proc); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("assign to job: %w", err)
	}
	p.job = job
	return nil
}

// kill terminates the job and closes it; stop calls it once.
func (p *sshProc) kill() {
	if p.job != 0 {
		windows.TerminateJobObject(p.job, 1)
	}
	if !p.exited(sshKillWait) {
		p.cmd.Process.Kill()
	}
	if p.job != 0 {
		windows.CloseHandle(p.job)
		p.job = 0
	}
}

// sshKillWait is how long a stopped ssh gets before it is killed directly.
const sshKillWait = time.Second
