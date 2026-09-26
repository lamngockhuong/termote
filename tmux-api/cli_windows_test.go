//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDPAPIRoundTripMatchesConfigFormat(t *testing.T) {
	blob, err := protectCurrentUser([]byte("Win-Pass-04"))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := unprotectCurrentUser(blob)
	if err != nil || string(plain) != "Win-Pass-04" {
		t.Fatalf("unprotect = %q, %v", plain, err)
	}
	tc := newTestCLI(t, "windows")
	if err := tc.saveConfig(savedConfig{Mode: "native", Port: 7690, Password: "Real-DPAPI"}); err != nil {
		t.Fatal(err)
	}
	cfg, err := tc.loadConfig()
	if err != nil || cfg.Password != "Real-DPAPI" {
		t.Fatalf("load = %+v, %v", cfg, err)
	}
}

func TestListProcessesFindsSelf(t *testing.T) {
	procs, err := listProcesses()
	if err != nil {
		t.Fatal(err)
	}
	self, _ := os.Executable()
	for _, p := range procs {
		if p.PID == os.Getpid() {
			if !strings.EqualFold(filepath.Clean(p.Exe), filepath.Clean(self)) {
				t.Fatalf("self image %q, want %q", p.Exe, self)
			}
			return
		}
	}
	t.Fatal("own process not listed")
}

func TestReplaceRunningFileRenamesAside(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.exe")
	os.WriteFile(path, []byte("x"), 0o644)
	if err := replaceRunningFile(path); err != nil {
		t.Fatal(err)
	}
	if fileExists(path) {
		t.Fatal("file still in place")
	}
	if m, _ := filepath.Glob(path + ".old-*"); len(m) != 1 {
		t.Fatalf("renamed copies: %v", m)
	}
}
