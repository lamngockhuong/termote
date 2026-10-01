//go:build windows

package main

import (
	"fmt"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// observerProc holds the Job Object the observer runs in. The job has
// KILL_ON_JOB_CLOSE, so the observer dies with the server even when the
// server is killed hard (Stop-Process -Force), as a ConPTY terminal does.
type observerProc struct {
	job       windows.Handle
	closeOnce sync.Once
}

// observerSysProcAttr starts observe without a console window: the server
// runs as a Scheduled Task with no console to share.
func observerSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

// attach puts the started observer in a new kill-on-close job. The process
// runs for a moment before it joins; observe starts no child in that time.
func (p *observer) attach() error {
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

// kill terminates the job at once: observe only reads, so it has nothing to
// finish, and control is released by closing its stdin before it gets here.
// The process itself is killed if it is still there after processKillWait.
func (p *observer) kill() {
	select {
	case <-p.waited:
	default:
		if p.job != 0 {
			windows.TerminateJobObject(p.job, 1)
		}
	}
	select {
	case <-p.waited:
	case <-time.After(processKillWait):
		p.cmd.Process.Kill()
		<-p.waited
	}
	p.killGroup()
}

// killGroup closes the job, which ends anything still in it. It is safe to
// call more than once; the handle is cleared so that a later kill does not
// reach a handle value Windows has given to something else.
func (p *observer) killGroup() {
	p.closeOnce.Do(func() {
		windows.CloseHandle(p.job)
		p.job = 0
	})
}
