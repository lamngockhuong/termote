//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
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

// The shim can hand the CLI an 8.3 install path (C:\Users\LAMNGO~1.KHU\...),
// while QueryFullProcessImageName reports the long form.
func TestServerMatcherAcrossShortAndLongPaths(t *testing.T) {
	tc := newTestCLI(t, "windows")
	long := filepath.Join(t.TempDir(), "long directory name")
	server := filepath.Join(long, "server", "termote-server.exe")
	if err := os.MkdirAll(filepath.Dir(server), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(server, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	src, _ := windows.UTF16PtrFromString(long)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetShortPathName(src, &buf[0], uint32(len(buf)))
	short := windows.UTF16ToString(buf[:n])
	if err != nil || strings.EqualFold(short, long) {
		t.Skipf("no 8.3 name for %s (8.3 names disabled on this volume?)", long)
	}
	tc.projectDir = short
	if !tc.isServerProcess(procInfo{Exe: server}) {
		t.Errorf("long image path %s not matched for install dir %s", server, short)
	}
}
