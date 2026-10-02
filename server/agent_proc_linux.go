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

const (
	agentProcSupported = true
	codexProcSupported = true
)

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

// procNULFields reads a NUL-separated /proc/<pid> file (cmdline, environ).
func procNULFields(pid int, name string) ([]string, bool) {
	b, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), name))
	if err != nil {
		return nil, false
	}
	return strings.Split(strings.TrimRight(string(b), "\x00"), "\x00"), true
}

// procExeBase is the name of the file pid executes; a binary replaced by an
// update reads "codex (deleted)", which is still the same program.
func procExeBase(pid int) string {
	exe, err := os.Readlink(filepath.Join(procRoot, strconv.Itoa(pid), "exe"))
	if err != nil {
		return ""
	}
	return filepath.Base(strings.TrimSuffix(exe, " (deleted)"))
}

// procArgs is pid's command line.
func procArgs(pid int) []string {
	args, _ := procNULFields(pid, "cmdline")
	return args
}

// procCodexHome reads CODEX_HOME, else HOME, from the process's environment.
func procCodexHome(pid int) (string, bool) {
	env, ok := procNULFields(pid, "environ")
	if !ok {
		return "", false
	}
	return codexHomeFromEnv(envGetter(env))
}

// The access mode bits of the open flags fdinfo prints in octal: O_WRONLY
// (1) and O_RDWR (2) allow writing; O_APPEND alone does not.
const procAccMode = 0o3

// procWriteFiles lists the files pid holds open for writing whose name
// passes match: the fd link, its fdinfo flags, and the identity of the open
// file (a stat through the fd).
func procWriteFiles(pid int, match func(name string) bool) []procFile {
	dir := filepath.Join(procRoot, strconv.Itoa(pid))
	fds, err := os.ReadDir(filepath.Join(dir, "fd"))
	if err != nil {
		return nil
	}
	var out []procFile
	for _, fd := range fds {
		target, err := os.Readlink(filepath.Join(dir, "fd", fd.Name()))
		if err != nil || !filepath.IsAbs(target) || !match(filepath.Base(target)) {
			continue
		}
		info, err := os.ReadFile(filepath.Join(dir, "fdinfo", fd.Name()))
		if err != nil || procFDFlags(string(info))&procAccMode == 0 {
			continue
		}
		f := procFile{path: target}
		if fi, err := os.Stat(filepath.Join(dir, "fd", fd.Name())); err == nil {
			f.id = fileIdentity(fi)
		}
		out = append(out, f)
	}
	return out
}

// procFDFlags reads the "flags:" line of an fdinfo file (octal).
func procFDFlags(info string) int64 {
	for _, l := range strings.Split(info, "\n") {
		if v, ok := strings.CutPrefix(l, "flags:"); ok {
			n, err := strconv.ParseInt(strings.TrimSpace(v), 8, 64)
			if err == nil {
				return n
			}
		}
	}
	return 0
}

// procAllPIDs lists every process.
func procAllPIDs() []int {
	dirs, _ := os.ReadDir(procRoot)
	var out []int
	for _, d := range dirs {
		if pid, err := strconv.Atoi(d.Name()); err == nil {
			out = append(out, pid)
		}
	}
	return out
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

// procForeground reports whether pid runs (not stopped) in the foreground
// process group of its terminal: state is field 3, pgrp field 5, tpgid field 8.
func procForeground(pid int) bool {
	f := procStatFields(pid)
	if len(f) < 6 || f[0] == "T" || f[0] == "t" {
		return false
	}
	return f[2] == f[5]
}
