//go:build !windows && !linux

package main

import (
	"log"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// terminalSysProcAttr starts the child in its own session with the PTY as
// controlling terminal. macOS has no Pdeathsig; see reapOrphanTerminals.
func terminalSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true, Setctty: true}
}

// observerSysProcAttr puts a piped helper (herdr observe) in its own process
// group. macOS has no Pdeathsig; see reapOrphanTerminals.
func observerSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// reapOrphanTerminals kills terminal clients left behind by a previous
// tmux-api that was killed hard. Only processes re-parented to launchd (PID 1)
// whose command line matches are touched, so a user's own `tmux attach`
// running under a shell is never matched.
func reapOrphanTerminals(match func(cmdline string) bool) {
	out, err := exec.Command("ps", "-axo", "pid=,ppid=,command=").Output()
	if err != nil {
		log.Printf("orphan terminal scan: %v", err)
		return
	}
	for _, pid := range findOrphans(string(out), match) {
		log.Printf("killing orphaned terminal client (pid %d)", pid)
		syscall.Kill(pid, syscall.SIGTERM)
	}
}

// findOrphans parses `ps -axo pid=,ppid=,command=` output.
func findOrphans(psOut string, match func(cmdline string) bool) []int {
	var pids []int
	for _, line := range strings.Split(psOut, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || f[1] != "1" || !match(strings.Join(f[2:], " ")) {
			continue
		}
		if pid, err := strconv.Atoi(f[0]); err == nil {
			pids = append(pids, pid)
		}
	}
	return pids
}
