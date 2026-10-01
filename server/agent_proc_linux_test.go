package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// startFakeClaude starts `sh -c 'sleep 30'`-style tree (sh → sleep) whose
// sleep has CLAUDE_CONFIG_DIR=dir, and returns the root (sh) and leaf pids.
func startFakeClaude(t *testing.T, env ...string) (root, leaf int) {
	t.Helper()
	cmd := exec.Command("sh", "-c", "sleep 30 & wait")
	cmd.Env = append(os.Environ(), env...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	children, err := procChildrenFunc()
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c := children(cmd.Process.Pid); len(c) == 1 {
			return cmd.Process.Pid, c[0]
		}
		time.Sleep(10 * time.Millisecond)
		children, _ = procChildrenFunc()
	}
	t.Fatal("sleep child did not appear")
	return 0, 0
}

func TestFindClaudeSessionUnderPane(t *testing.T) {
	dir := t.TempDir()
	root, leaf := startFakeClaude(t, "CLAUDE_CONFIG_DIR="+dir)
	start, ok := procStartTime(leaf)
	if !ok {
		t.Fatal("no start time for the child")
	}
	domain := claudePIDDomain()
	if domain == "" {
		t.Skip("no machine-id")
	}

	cases := []struct {
		name, procStart, domain string
		want                    bool
	}{
		{"start time and namespace match", start, domain, true},
		{"start time differs (pid reused)", start + "1", domain, false},
		{"other pid namespace", start, domain + "x", false},
		{"no start time recorded", "", domain, false},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			writeSessionFile(t, dir, leaf, tc.procStart, tc.domain, "busy")
			s, ok := findClaudeSession(fmt.Sprintf("test-%d", i), root)
			if ok != tc.want {
				t.Fatalf("found = %v, want %v", ok, tc.want)
			}
			if ok && (s.ID != testSessionID || s.PID != leaf || s.ClaudeDir != dir || s.Status != "working" || s.ProcStart != start) {
				t.Errorf("session = %+v", s)
			}
		})
	}

	// The walk is cached, the session file is not: /clear shows at once.
	writeSessionFile(t, dir, leaf, start, domain, "idle")
	key := "test-cached"
	if _, ok := findClaudeSession(key, root); !ok {
		t.Fatal("not found")
	}
	writeSessionFile(t, dir, leaf, start, domain, "busy")
	if s, _ := findClaudeSession(key, root); s.Status != "working" {
		t.Errorf("status after change = %q", s.Status)
	}
	if !claudeProcAlive(leaf, start) || claudeProcAlive(leaf, start+"1") {
		t.Error("claudeProcAlive")
	}
}

func TestFindClaudeSessionDeadPID(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("true")
	cmd.Env = append(os.Environ(), "CLAUDE_CONFIG_DIR="+dir)
	cmd.Run()
	pid := cmd.Process.Pid
	writeSessionFile(t, dir, pid, "1", claudePIDDomain(), "busy")
	if _, ok := findClaudeSession("dead", pid); ok {
		t.Error("a dead pid's session file was accepted")
	}
	if _, ok := findClaudeSession("zero", 0); ok {
		t.Error("pid 0 accepted")
	}
}

func TestProcClaudeDirFallsBackToHome(t *testing.T) {
	root, leaf := startFakeClaude(t, "HOME=/home/someone", "CLAUDE_CONFIG_DIR=")
	_ = root
	if d, ok := procClaudeDir(leaf); !ok || d != "/home/someone/.claude" {
		t.Errorf("procClaudeDir = %q, %v", d, ok)
	}
	if _, ok := procClaudeDir(1 << 30); ok {
		t.Error("missing process accepted")
	}
}

// A fake /proc covers the stat parsing and the fallback without
// task/*/children.
func TestFakeProcRoot(t *testing.T) {
	root := t.TempDir()
	orig := procRoot
	procRoot = root
	t.Cleanup(func() { procRoot = orig })
	mk := func(pid int, stat string) {
		os.MkdirAll(filepath.Join(root, strconv.Itoa(pid)), 0o755)
		os.WriteFile(filepath.Join(root, strconv.Itoa(pid), "stat"), []byte(stat), 0o644)
	}
	os.MkdirAll(filepath.Join(root, "self", "task"), 0o755)
	// A command name with spaces and ')' must not shift the fields.
	mk(10, "10 (a) (b c)) S 1 10 10 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 555 0 0")
	mk(11, "11 (sh) S 10 10 10 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0")
	mk(12, "12 (x) S 10 10 10 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 778 0 0")
	mk(13, "garbage")
	if s, ok := procStartTime(10); !ok || s != "555" {
		t.Errorf("procStartTime(10) = %q, %v", s, ok)
	}
	if _, ok := procStartTime(13); ok {
		t.Error("garbage stat accepted")
	}
	children, err := procChildrenFunc()
	if err != nil {
		t.Fatal(err)
	}
	if c := children(10); len(c) != 2 {
		t.Errorf("children(10) = %v", c)
	}
	os.RemoveAll(filepath.Join(root, "self"))
	if _, err := procChildrenFunc(); err == nil {
		t.Error("procChildrenFunc without /proc/self/task")
	}
}

func TestProcClaudeDirRejectsRelative(t *testing.T) {
	_, leaf := startFakeClaude(t, "CLAUDE_CONFIG_DIR=rel/claude")
	if d, ok := procClaudeDir(leaf); ok {
		t.Errorf("relative CLAUDE_CONFIG_DIR accepted: %q", d)
	}
	_, leaf = startFakeClaude(t, "HOME=relhome", "CLAUDE_CONFIG_DIR=")
	if d, ok := procClaudeDir(leaf); ok {
		t.Errorf("relative HOME accepted: %q", d)
	}
}

func TestProcForeground(t *testing.T) {
	// A child of the test runs in the test's process group, which is not a
	// terminal's foreground group here: its tpgid differs from its pgrp.
	_, leaf := startFakeClaude(t)
	f := procStatFields(leaf)
	if got, want := procForeground(leaf), f[2] == f[5]; got != want {
		t.Errorf("procForeground = %v, want %v (pgrp %s tpgid %s)", got, want, f[2], f[5])
	}
	syscall.Kill(leaf, syscall.SIGSTOP)
	defer syscall.Kill(leaf, syscall.SIGCONT)
	waitUntil(t, "stopped", func() bool { s := procStatFields(leaf); return len(s) > 0 && s[0] == "T" })
	if procForeground(leaf) {
		t.Error("a stopped process is foreground")
	}
	if procForeground(1 << 30) {
		t.Error("missing process is foreground")
	}
}
