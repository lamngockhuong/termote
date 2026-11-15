//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestHcDefaultEndpointWindows(t *testing.T) {
	cases := []struct {
		env  []string
		want string
	}{
		// platform/windows.rs endpoints: USERNAME's ASCII letters and digits only.
		{[]string{"USERNAME=lam.ngoc.khuong"}, `\\.\pipe\herdr-core-lamngockhuong-default.sock`},
		{[]string{"username=Ab.c_d-E f9", "HC_SESSION= work "}, `\\.\pipe\herdr-core-AbcdEf9-work.sock`},
		{[]string{"USERNAME=Đức"}, `\\.\pipe\herdr-core-c-default.sock`},
		{nil, `\\.\pipe\herdr-core--default.sock`},
	}
	for _, c := range cases {
		if got := hcDefaultEndpoint(c.env); got != c.want {
			t.Errorf("%v: got %s, want %s", c.env, got, c.want)
		}
	}
}

// A running core holds byte 0 of core.lock (herdr-core platform/windows.rs
// try_lock, a mandatory lock on Windows), so the file cannot be read while
// the core runs; the probe finds the core on the pipe hc itself dials.
func TestHcCoreRunningProbeWindows(t *testing.T) {
	session := fmt.Sprintf("termote-test-%d-%d", os.Getpid(), time.Now().UnixNano())
	state := t.TempDir()
	env := []string{"XDG_STATE_HOME=" + state, "HC_SESSION=" + session, "USERNAME=te.st_User-1"}
	pipe := `\\.\pipe\herdr-core-testUser1-` + session + ".sock"

	if hcCoreRunningDefault(context.Background(), env) {
		t.Fatal("running with no pipe and no core.lock")
	}
	dir := filepath.Join(state, "herdr-core", session)
	os.MkdirAll(dir, 0o700)
	lock, err := os.OpenFile(filepath.Join(dir, "core.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	lock.WriteString(pipe)
	ov := new(windows.Overlapped)
	if err := windows.LockFileEx(windows.Handle(lock.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ov); err != nil {
		t.Fatal(err)
	}
	if _, err := os.ReadFile(filepath.Join(dir, "core.lock")); err == nil {
		t.Fatal("core.lock readable while locked: the test does not hold the core's lock")
	}
	if hcCoreRunningDefault(context.Background(), env) {
		t.Fatal("running with a locked core.lock and no pipe")
	}

	ln := listenHerdrTest(t, pipe)
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	if !hcCoreRunningDefault(context.Background(), env) {
		t.Fatal("core on the default pipe not found while core.lock is locked")
	}
	// HC_SOCKET still wins over the default pipe.
	if hcCoreRunningDefault(context.Background(), append(env, `HC_SOCKET=\\.\pipe\`+session+".other")) {
		t.Fatal("default pipe used despite HC_SOCKET")
	}
	// Another user's USERNAME names another pipe.
	if hcCoreRunningDefault(context.Background(), append(env, "USERNAME=someoneelse")) {
		t.Fatal("pipe found under another USERNAME")
	}
}
