package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// startEnvChild runs the test binary asleep with extra environment entries;
// the PEB holds them from creation, so nothing has to be waited for.
func startEnvChild(t *testing.T, env ...string) int {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(append(os.Environ(), helperEnv+"=sleep"), env...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	return cmd.Process.Pid
}

// A CLAUDE_CONFIG_DIR or CODEX_HOME set only inside the pane (#791) is read
// from the process's own environment block, as on Linux and macOS.
func TestWindowsProcEnvConfigDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	work := filepath.Join(t.TempDir(), ".claude-work")
	codexWork := filepath.Join(t.TempDir(), ".codex-work")

	pid := startEnvChild(t, "CLAUDE_CONFIG_DIR="+work, "CODEX_HOME="+codexWork)
	if got, ok := procClaudeDir(pid); !ok || got != work {
		t.Errorf("procClaudeDir = %q, %v, want %q", got, ok, work)
	}
	if got, ok := procCodexHome(pid); !ok || got != codexWork {
		t.Errorf("procCodexHome = %q, %v, want %q", got, ok, codexWork)
	}

	// Names are case-insensitive on Windows.
	pid = startEnvChild(t, "claude_config_dir="+work)
	if got, ok := procClaudeDir(pid); !ok || got != work {
		t.Errorf("lower-case name: procClaudeDir = %q, %v", got, ok)
	}

	// Unset or empty: the server user's own folders.
	pid = startEnvChild(t)
	if got, ok := procClaudeDir(pid); !ok || got != filepath.Join(home, ".claude") {
		t.Errorf("unset: procClaudeDir = %q, %v", got, ok)
	}
	if got, ok := procCodexHome(pid); !ok || got != filepath.Join(home, ".codex") {
		t.Errorf("unset: procCodexHome = %q, %v", got, ok)
	}

	// A relative value would resolve against the server's cwd.
	pid = startEnvChild(t, "CLAUDE_CONFIG_DIR=.claude-work", "CODEX_HOME=codex")
	if got, ok := procClaudeDir(pid); ok {
		t.Errorf("relative: procClaudeDir = %q", got)
	}
	if got, ok := procCodexHome(pid); ok {
		t.Errorf("relative: procCodexHome = %q", got)
	}

	// A UNC or device path would make the server open a share or a device.
	pid = startEnvChild(t, `CLAUDE_CONFIG_DIR=\\host\share\.claude`, `CODEX_HOME=\\.\pipe\codex`)
	if got, ok := procClaudeDir(pid); ok {
		t.Errorf("UNC: procClaudeDir = %q", got)
	}
	if got, ok := procCodexHome(pid); ok {
		t.Errorf("device: procCodexHome = %q", got)
	}

	// No such process: the server user's folder, whose session file then
	// cannot match a pid and start time.
	if got, ok := procClaudeDir(-1); !ok || got != filepath.Join(home, ".claude") {
		t.Errorf("no process: procClaudeDir = %q, %v", got, ok)
	}
}

// The issue's case end to end: the session file is under the pane's own
// CLAUDE_CONFIG_DIR and the process is found as Claude Code.
func TestWindowsClaudeProcOfConfigDir(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	work := filepath.Join(t.TempDir(), ".claude-work")
	pid := startEnvChild(t, "CLAUDE_CONFIG_DIR="+work)
	start, ok := procStartTime(pid)
	if !ok {
		t.Fatal("procStartTime")
	}
	if err := os.MkdirAll(filepath.Join(work, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"pid":%d,"procStartFt":%q}`, pid, start)
	if err := os.WriteFile(filepath.Join(work, "sessions", fmt.Sprintf("%d.json", pid)), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	p, ok := claudeProcOf(pid, claudePIDDomain())
	if !ok || p.claudeDir != work {
		t.Fatalf("claudeProcOf = %+v, %v", p, ok)
	}
}
