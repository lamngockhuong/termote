package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

const agentProcSupported = true

// procRoot is /proc; tests point it at a fake tree.
var procRoot = "/proc"

// procChildrenFunc lists children from /proc/<pid>/task/*/children, or, on a
// kernel without that file, from the parent field of every /proc/<pid>/stat.
func procChildrenFunc() (func(int) []int, error) {
	if _, err := os.Stat(filepath.Join(procRoot, "self", "task")); err != nil {
		return nil, err
	}
	// The function is shared between concurrent walks: build the fallback
	// table once.
	var once sync.Once
	var byParent map[int][]int
	return func(pid int) []int {
		files, _ := filepath.Glob(filepath.Join(procRoot, strconv.Itoa(pid), "task", "*", "children"))
		if len(files) > 0 {
			var out []int
			for _, f := range files {
				b, _ := os.ReadFile(f)
				for _, s := range strings.Fields(string(b)) {
					if c, err := strconv.Atoi(s); err == nil {
						out = append(out, c)
					}
				}
			}
			return out
		}
		once.Do(func() { byParent = scanParents() })
		return byParent[pid]
	}, nil
}

func scanParents() map[int][]int {
	m := map[int][]int{}
	dirs, _ := os.ReadDir(procRoot)
	for _, d := range dirs {
		pid, err := strconv.Atoi(d.Name())
		if err != nil {
			continue
		}
		if f := procStatFields(pid); len(f) > 1 {
			if ppid, err := strconv.Atoi(f[1]); err == nil {
				m[ppid] = append(m[ppid], pid)
			}
		}
	}
	return m
}

// procStatFields returns /proc/<pid>/stat from field 3 (state) on: the
// command name in field 2 can hold spaces and parentheses.
func procStatFields(pid int) []string {
	b, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return nil
	}
	i := bytes.LastIndexByte(b, ')')
	if i < 0 || i+2 > len(b) {
		return nil
	}
	return strings.Fields(string(b[i+2:]))
}

// procStartTime is field 22 of /proc/<pid>/stat (start time in clock ticks
// since boot), which is what Claude Code records as procStart on Linux.
func procStartTime(pid int) (string, bool) {
	f := procStatFields(pid)
	if len(f) < 20 {
		return "", false
	}
	return f[19], true
}

// procClaudeDir reads CLAUDE_CONFIG_DIR, else HOME, from the process's own
// environment. A process of another user cannot be read and is skipped.
func procClaudeDir(pid int) (string, bool) {
	b, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "environ"))
	if err != nil {
		return "", false
	}
	var home string
	for _, kv := range bytes.Split(b, []byte{0}) {
		k, v, ok := strings.Cut(string(kv), "=")
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

// claudePIDDomain is how Claude Code names this pid namespace in pidDomain:
// "linux:<machine-id>:" plus the target of /proc/self/ns/pid. A session file
// from a container (another namespace) does not match.
func claudePIDDomain() string {
	id, err := os.ReadFile("/etc/machine-id")
	if err != nil {
		return ""
	}
	ns, err := os.Readlink(filepath.Join(procRoot, "self", "ns", "pid"))
	if err != nil {
		return ""
	}
	return "linux:" + strings.TrimSpace(string(id)) + ":" + ns
}

// fileIdentity is the device and inode of a file, so a cursor into a file
// that was replaced is not applied to the new one.
func fileIdentity(fi os.FileInfo) string {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d", st.Dev, st.Ino)
	}
	return ""
}
