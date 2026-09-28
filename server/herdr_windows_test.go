//go:build windows

package main

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func TestHerdrSocketPath(t *testing.T) {
	temp := os.TempDir()
	cases := []struct {
		name                                string
		socket, xdg, appdata, profile, home string
		want                                string
	}{
		{"explicit", `\\.\pipe\x`, `C:\xdg`, `C:\ad`, `C:\u`, `C:\h`, `\\.\pipe\x`},
		{"xdg", "", `C:\xdg`, `C:\ad`, `C:\u`, `C:\h`, `C:\xdg\herdr\herdr.sock`},
		{"xdg with separator", "", `C:\xdg\`, "", "", "", `C:\xdg\herdr\herdr.sock`},
		{"appdata", "", "", `C:\Users\u\AppData\Roaming`, `C:\u`, `C:\h`, `C:\Users\u\AppData\Roaming\herdr\herdr.sock`},
		{"profile", "", "", "", `C:\Users\u`, `C:\h`, `C:\Users\u\AppData\Roaming\herdr\herdr.sock`},
		// herdr joins ".config/herdr" as one element, keeping its slash.
		{"home", "", "", "", "", `C:\h`, `C:\h\.config/herdr\herdr.sock`},
		{"temp", "", "", "", "", "", herdrJoin(herdrJoin(temp, "herdr"), "herdr.sock")},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			// Set after TempDir is read: it looks at TMP, not these.
			t.Setenv("HERDR_SOCKET_PATH", tt.socket)
			t.Setenv("XDG_CONFIG_HOME", tt.xdg)
			t.Setenv("APPDATA", tt.appdata)
			t.Setenv("USERPROFILE", tt.profile)
			t.Setenv("HOME", tt.home)
			if got := herdrSocketPath(); got != tt.want {
				t.Errorf("herdrSocketPath = %q, want %q", got, tt.want)
			}
		})
	}
}

// A pipe's deadline error is winio's own, not os.ErrDeadlineExceeded.
func TestHerdrReadErrorPipeTimeout(t *testing.T) {
	if err := herdrReadError(context.Background(), "ping", winio.ErrTimeout); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("pipe timeout: %v, want context.DeadlineExceeded", err)
	}
}

func TestHerdrPipeName(t *testing.T) {
	for path, want := range map[string]string{
		`C:\Users\u\AppData\Roaming\herdr\herdr.sock`: `\\.\pipe\C:\Users\u\AppData\Roaming\herdr\herdr.sock`,
		`\\.\pipe\custom`: `\\.\pipe\custom`,
	} {
		if got := herdrPipeName(path); got != want {
			t.Errorf("herdrPipeName(%q) = %q, want %q", path, got, want)
		}
	}
}

// startTestObserver runs the fake observe in its job and returns it with its
// pid.
func startTestObserver(t *testing.T) (*observer, int) {
	t.Helper()
	pids := useFakeObserve(t, false)
	p, err := startObserver("wR:p3", Size{Cols: 80, Rows: 24}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "observer pid", func() bool { return len(pids()) == 1 })
	pid := pids()[0]
	t.Cleanup(func() { killPID(pid) })
	return p, pid
}

func TestHerdrObserverKillTerminatesJob(t *testing.T) {
	p, pid := startTestObserver(t)
	start := time.Now()
	p.kill()
	if d := time.Since(start); d > processKillWait {
		t.Errorf("kill took %v", d)
	}
	waitDead(t, pid, "observer")
	p.killGroup() // a second close must be harmless
	p.kill()      // and so must killing an observer that has exited
}

// Closing the job handle is what happens when the server dies: the observer
// must die with it.
func TestHerdrObserverDiesWithJobHandle(t *testing.T) {
	p, pid := startTestObserver(t)
	p.killGroup()
	waitDead(t, pid, "observer")
	select {
	case <-p.waited:
	case <-time.After(5 * time.Second):
		t.Fatal("observer not reaped")
	}
}

func TestHerdrObserverAttachError(t *testing.T) {
	// No process has pid 0.
	if err := (&observer{cmd: &exec.Cmd{Process: &os.Process{Pid: 0}}}).attach(); err == nil {
		t.Error("attach to pid 0 succeeded")
	}
}

// A pipe served by another user is refused; one served by this user (the
// fake herdr, in this process) is kept.
func TestHerdrPipeServerUser(t *testing.T) {
	f := newFakeHerdr(t)
	conn, err := dialHerdr(context.Background(), f.path)
	if err != nil {
		t.Fatalf("own pipe refused: %v", err)
	}
	conn.Close()

	old := herdrExpectedUser
	t.Cleanup(func() { herdrExpectedUser = old })
	herdrExpectedUser = func() (*windows.SID, error) {
		return windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	}
	if _, err := dialHerdr(context.Background(), f.path); err == nil {
		t.Error("pipe of another user accepted")
	}
	herdrExpectedUser = func() (*windows.SID, error) { return nil, errors.New("no token") }
	if _, err := dialHerdr(context.Background(), f.path); err == nil {
		t.Error("pipe accepted without knowing the current user")
	}
}

func TestCheckPipeServerUserErrors(t *testing.T) {
	a, b := net.Pipe() // no Fd
	defer a.Close()
	defer b.Close()
	if err := checkPipeServerUser(a); err == nil {
		t.Error("conn without a handle accepted")
	}
	if _, err := pipeServerUser(windows.InvalidHandle); err == nil {
		t.Error("invalid handle accepted")
	}
}
