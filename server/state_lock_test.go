package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLockStateFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.lock")
	unlock, err := lockStateFile(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockStateFile(path, 3*stateLockRetry); !errors.Is(err, errStateLockTimeout) {
		t.Fatalf("second lock = %v, want a timeout", err)
	}
	unlock()
	unlock2, err := lockStateFile(path, 0)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	unlock2()
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("lock file mode = %v, %v; want 0600", fi.Mode().Perm(), err)
		}
	}
}

func TestLockStateFileRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "x.lock")
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if unlock, err := lockStateFile(path, 0); err == nil {
		unlock()
		t.Fatal("a symlinked lock file was used")
	}
}
