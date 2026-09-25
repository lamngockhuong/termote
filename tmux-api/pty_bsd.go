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

// reapOrphanTerminals kills terminal clients left behind by a previous
// tmux-api that was killed hard. Only processes re-parented to launchd (PID 1)
// whose command line is exactly argv are touched, so a user's own `tmux attach`
// running under a shell is never matched.
func reapOrphanTerminals(argv []string) {
	out, err := exec.Command("ps", "-axo", "pid=,ppid=,command=").Output()
	if err != nil {
		log.Printf("orphan terminal scan: %v", err)
		return
	}
	for _, pid := range findOrphans(string(out), strings.Join(argv, " ")) {
		log.Printf("killing orphaned terminal client (pid %d)", pid)
		syscall.Kill(pid, syscall.SIGTERM)
	}
}

// findOrphans parses `ps -axo pid=,ppid=,command=` output.
func findOrphans(psOut, cmdline string) []int {
	var pids []int
	for _, line := range strings.Split(psOut, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || f[1] != "1" || strings.Join(f[2:], " ") != cmdline {
			continue
		}
		if pid, err := strconv.Atoi(f[0]); err == nil {
			pids = append(pids, pid)
		}
	}
	return pids
}
