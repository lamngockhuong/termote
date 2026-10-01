//go:build !windows

package main

import (
	"io"
	"path/filepath"
	"testing"
	"time"
)

func TestHerdrSocketPath(t *testing.T) {
	home := t.TempDir()
	cases := []struct {
		name, socket, xdg, want string
	}{
		{"explicit", "/run/h.sock", "/xdg", "/run/h.sock"},
		{"xdg", "", "/xdg", "/xdg/herdr/herdr.sock"},
		{"home", "", "", filepath.Join(home, ".config", "herdr", "herdr.sock")},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("HOME", home)
			t.Setenv("HERDR_SOCKET_PATH", tt.socket)
			t.Setenv("XDG_CONFIG_HOME", tt.xdg)
			if got := herdrSocketPath(); got != tt.want {
				t.Errorf("herdrSocketPath = %q, want %q", got, tt.want)
			}
		})
	}
}

// An observer that ignores SIGTERM is killed with SIGKILL after
// processKillWait.
func TestHerdrObserverKillEscalates(t *testing.T) {
	pids := useFakeObserve(t, false)
	t.Setenv(observeNoTermEnv, "1")
	p, err := startHerdrStream(herdrObserveArgv("wR:p3", Size{Cols: 80, Rows: 24}), false, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "observer pid", func() bool { return len(pids()) == 1 })
	pid := pids()[0]
	t.Cleanup(func() { killPID(pid) })
	start := time.Now()
	p.kill()
	if d := time.Since(start); d < processKillWait {
		t.Errorf("kill returned after %v, before the SIGKILL escalation", d)
	}
	waitDead(t, pid, "observer")
}
