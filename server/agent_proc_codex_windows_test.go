package main

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const testCodexID2 = "01a0fbc2-4df0-7f32-864d-eb33100e552e"

func codexMeta(id string) string {
	return `{"type":"session_meta","payload":{"id":"` + id + `","thread_source":"user"}}` + "\n"
}

// fakeCodexExe copies the test binary to <tmp>\codex.exe: the lookup goes by
// executable name.
func fakeCodexExe(t *testing.T) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	src, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	exe := filepath.Join(t.TempDir(), "codex.exe")
	dst, err := os.Create(exe)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		t.Fatal(err)
	}
	dst.Close()
	return exe
}

// startFakeCodex runs exe holding the rollouts open (helperCodexRollout) and
// waits until the handle table cache sees them.
func startFakeCodex(t *testing.T, exe string, args []string, rollouts ...string) int {
	t.Helper()
	cmd := exec.Command(exe, args...)
	cmd.Env = append(os.Environ(), helperEnv+"=codex-rollout",
		"FAKE_ROLLOUT="+strings.Join(rollouts, string(os.PathListSeparator)))
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	if line, _ := bufio.NewReader(out).ReadString('\n'); strings.TrimSpace(line) != "READY" {
		t.Fatalf("fake codex: %q", line)
	}
	waitHandleCache()
	return cmd.Process.Pid
}

func TestWindowsProcHooks(t *testing.T) {
	self, _ := os.Executable()
	want := strings.TrimSuffix(strings.ToLower(filepath.Base(self)), ".exe")
	if got := procExeBase(os.Getpid()); got != want {
		t.Errorf("procExeBase = %q, want %q", got, want)
	}
	if args := procArgs(os.Getpid()); len(args) == 0 || !strings.EqualFold(filepath.Base(args[0]), filepath.Base(self)) {
		t.Errorf("procArgs = %q", args)
	}
	if procExeBase(-1) != "" || procArgs(-1) != nil {
		t.Error("hooks answered for no process")
	}
	if !slices.Contains(procAllPIDs(), os.Getpid()) {
		t.Error("procAllPIDs misses this process")
	}
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	if got, ok := procCodexHome(0); !ok || got != filepath.Join(home, ".codex") {
		t.Errorf("procCodexHome = %q, %v", got, ok)
	}
}

func TestCodexOnWindowsFakeTUI(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	codexHome := filepath.Join(home, ".codex")
	p := writeRollout(t, codexHome, testCodexID, codexMeta(testCodexID))
	pid := startFakeCodex(t, fakeCodexExe(t), []string{"--no-daemon"}, p)

	proc, ok := codexProcOf(pid)
	if !ok || proc.codexHome != codexHome {
		t.Fatalf("codexProcOf = %+v, %v", proc, ok)
	}
	real, _ := filepath.EvalSymlinks(p)
	s, ok := codexSessionOf(proc, "", true)
	if !ok || s.ID != testCodexID || s.Rollout != real || s.RolloutID == "" ||
		s.RolloutID != rolloutIdentity(real, nil, nil) || s.PID != pid || !s.DialogsReadOnly {
		t.Fatalf("codexSessionOf = %+v, %v", s, ok)
	}
	if got, ok := findCodexSession(testCodexID); !ok || got.PID != pid || got.Rollout != real {
		t.Errorf("findCodexSession = %+v, %v", got, ok)
	}
	if _, ok := codexProcOf(os.Getpid()); ok {
		t.Error("a process not named codex taken for Codex")
	}
}

func TestCodexOnWindowsDaemonAndNew(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	codexHome := filepath.Join(home, ".codex")
	p := writeRollout(t, codexHome, testCodexID, codexMeta(testCodexID))
	exe := fakeCodexExe(t)

	// The shared daemon writes every pane's rollout: never this pane's.
	if _, ok := codexProcOf(startFakeCodex(t, exe, []string{"app-server", "--managed-daemon"}, p)); ok {
		t.Error("app-server taken for a Codex TUI")
	}
	// After /new the TUI holds two rollouts: no telling which one it shows.
	p2 := writeRollout(t, codexHome, testCodexID2, codexMeta(testCodexID2))
	proc, ok := codexProcOf(startFakeCodex(t, exe, []string{"--no-daemon"}, p, p2))
	if !ok {
		t.Fatal("codexProcOf refused the TUI")
	}
	if s, ok := codexSessionOf(proc, "", true); ok {
		t.Errorf("two rollouts gave %+v", s)
	}
}
