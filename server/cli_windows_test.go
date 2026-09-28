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
	if err := tc.saveConfig(savedConfig{Port: 7690, Password: "Real-DPAPI"}); err != nil {
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
