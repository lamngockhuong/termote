package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const agentProcSupported = true

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
	b, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil || len(b) < 4 {
		return "", false
	}
	// argc, then the exec path, then argc arguments, then the environment,
	// each NUL-terminated (with padding NULs after the exec path).
	argc := int(binary.LittleEndian.Uint32(b))
	fields := bytes.Split(b[4:], []byte{0})
	i := 1 // skip the exec path
	for i < len(fields) && len(fields[i]) == 0 {
		i++
	}
	i += argc
	var home string
	for ; i < len(fields); i++ {
		k, v, ok := strings.Cut(string(fields[i]), "=")
		if !ok {
			continue
		}
		switch k {
		case "CLAUDE_CONFIG_DIR":
			if v != "" {
				return v, filepath.IsAbs(v)
			}
		case "HOME":
			home = v
		}
	}
	// A relative value would resolve against the server's cwd.
	if !filepath.IsAbs(home) {
		return "", false
	}
	return filepath.Join(home, ".claude"), true
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
