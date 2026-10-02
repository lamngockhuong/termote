package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	agentProcSupported = true
	codexProcSupported = true
)

// procChildrenFunc lists every process once with ps and answers from that.
func procChildrenFunc() (func(int) []int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-A", "-o", "pid=,ppid=").Output()
	if err != nil {
		return nil, err
	}
	byParent := map[int][]int{}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 == nil && err2 == nil {
			byParent[ppid] = append(byParent[ppid], pid)
		}
	}
	return func(pid int) []int { return byParent[pid] }, nil
}

// procStartTime is what Claude Code records as procStart on macOS: the
// output of `ps -o lstart= -p <pid>` in the C locale and UTC.
func procStartTime(pid int) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ps", "-o", "lstart=", "-p", strconv.Itoa(pid))
	cmd.Env = append(os.Environ(), "LC_ALL=C", "TZ=UTC")
	out, err := cmd.Output()
	s := strings.TrimSpace(string(out))
	if err != nil || s == "" {
		return "", false
	}
	return s, true
}

// procClaudeDir reads CLAUDE_CONFIG_DIR, else HOME, from the process's
// environment through kern.procargs2, which only the process's own user (or
// root) can read.
func procClaudeDir(pid int) (string, bool) {
	get, ok := procEnv(pid)
	if !ok {
		return "", false
	}
	if v := get("CLAUDE_CONFIG_DIR"); v != "" {
		return v, filepath.IsAbs(v)
	}
	// A relative value would resolve against the server's cwd.
	home := get("HOME")
	if !filepath.IsAbs(home) {
		return "", false
	}
	return filepath.Join(home, ".claude"), true
}

// procArgs2 reads and splits pid's kern.procargs2.
func procArgs2(pid int) (execPath string, args, env []string, ok bool) {
	b, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return "", nil, nil, false
	}
	return parseProcArgs2(b)
}

func procEnv(pid int) (func(string) string, bool) {
	_, _, env, ok := procArgs2(pid)
	return envGetter(env), ok
}

// procExeBase is the name of the exec path kern.procargs2 records.
func procExeBase(pid int) string {
	execPath, _, _, ok := procArgs2(pid)
	if !ok || execPath == "" {
		return ""
	}
	return filepath.Base(execPath)
}

func procArgs(pid int) []string {
	_, args, _, _ := procArgs2(pid)
	return args
}

// procCodexHome reads CODEX_HOME, else HOME, from the process's environment.
func procCodexHome(pid int) (string, bool) {
	get, ok := procEnv(pid)
	if !ok {
		return "", false
	}
	return codexHomeFromEnv(get)
}

var lsofMissing sync.Once

// procWriteFiles asks lsof for the files pid holds open, with their access
// mode. Only a process already known to be codex gets here. -n and -P keep
// lsof from resolving the addresses of Codex's network sockets.
func procWriteFiles(pid int, match func(name string) bool) []procFile {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lsof", "-w", "-n", "-P", "-a", "-p", strconv.Itoa(pid), "-F0an").Output()
	if err != nil && len(out) == 0 {
		if errors.Is(err, exec.ErrNotFound) {
			lsofMissing.Do(func() { log.Printf("agent chat: lsof not found, Codex panes are not detected") })
		}
		return nil
	}
	return parseLsofWriteFiles(out, match)
}

// procAllPIDs lists every process through kern.proc.all.
func procAllPIDs() []int {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil
	}
	out := make([]int, 0, len(procs))
	for _, p := range procs {
		out = append(out, int(p.Proc.P_pid))
	}
	return out
}

// claudePIDDomain is empty: macOS has no pid namespaces to tell apart, so
// the start time alone identifies the process.
func claudePIDDomain() string { return "" }

func fileIdentity(fi os.FileInfo) string {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d", st.Dev, st.Ino)
	}
	return ""
}

// procForeground reports whether pid runs in its terminal's foreground
// process group: ps marks that with '+' in STAT, and a stopped one with 'T'.
func procForeground(pid int) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	st := strings.TrimSpace(string(out))
	return err == nil && strings.Contains(st, "+") && !strings.Contains(st, "T")
}
