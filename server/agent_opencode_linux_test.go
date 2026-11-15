package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// startFakeOpencode runs `sh → opencode -c 'sleep 30 & wait' opencode args...`,
// the opencode being sh under another name (its -c script reads to the TUI
// as --continue and a directory), and returns the root sh and the opencode
// pid.
func startFakeOpencode(t *testing.T, args ...string) (root, oc int) {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	b, err := os.ReadFile(sh)
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(t.TempDir(), opencodeExeName)
	if err := os.WriteFile(exe, b, 0o755); err != nil {
		t.Fatal(err)
	}
	argv := append([]string{"-c", `"$FAKE_OPENCODE" -c 'sleep 30 & wait' opencode "$@" & wait`, "sh"}, args...)
	cmd := exec.Command("sh", argv...)
	cmd.Env = append(os.Environ(), "FAKE_OPENCODE="+exe)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		children, _ := procChildrenFunc()
		for _, c := range children(cmd.Process.Pid) {
			for _, gc := range children(c) {
				syscallKill(gc)
			}
			syscallKill(c)
		}
		cmd.Process.Kill()
		cmd.Wait()
	})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		children, _ := procChildrenFunc()
		for _, c := range children(cmd.Process.Pid) {
			if procExeBase(c) == opencodeExeName && len(children(c)) > 0 {
				return cmd.Process.Pid, c
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("fake opencode did not start")
	return 0, 0
}

func TestFindOpencodeSessionUnderPane(t *testing.T) {
	f := newFakeOpencode(t)
	f.set(func() { f.active = []string{"ses_abc123"} })
	root, oc := startFakeOpencode(t, "--session", "ses_abc123")
	s, ok := findClaudeSession("oc-a", root)
	if !ok || s.Agent != "opencode" || s.ID != "ses_abc123" || s.Status != "working" || s.PID != oc || s.ProcStart == "" {
		t.Fatalf("session = %+v, %v", s, ok)
	}
	if s, ok := tmuxPaneAgent("%9", strconv.Itoa(root)); !ok || s.ID != "ses_abc123" || s.Target != "%9" {
		t.Errorf("tmux pane = %+v, %v", s, ok)
	}
	// Without --session the pane is OpenCode's, with no session.
	root, _ = startFakeOpencode(t)
	if s, ok := findClaudeSession("oc-b", root); !ok || s.Agent != "opencode" || s.ID != "" || s.Status != "unknown" {
		t.Errorf("no --session = %+v, %v", s, ok)
	}
}

func TestOpencodeProcOfRefusals(t *testing.T) {
	if _, ok := opencodeProcOf(os.Getpid()); ok {
		t.Error("the test binary read as opencode")
	}
}
