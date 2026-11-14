package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A port psmux recorded that another user's process listens on fails the
// check; a free one, the user's own, a file that is no port or no data dir
// at all pass.
func TestPsmuxPortsOwned(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("work.port", "50001\r\n")
	write("free.port", "50002")
	write("junk.port", "not a port")
	write("work.key", "50003")
	owners := map[int]listenerOwner{50001: listenerTrustedOwner, 50002: listenerNoneSeen, 50003: listenerOtherOwner}
	unread := map[int]error{}
	owner := func(port int) (listenerOwner, error) { return owners[port], unread[port] }
	if err := psmuxPortsOwned(dir, owner); err != nil {
		t.Fatalf("own, free and junk ports: %v", err)
	}
	if err := psmuxPortsOwned("", owner); err != nil {
		t.Fatalf("no data dir: %v", err)
	}
	if err := psmuxPortsOwned(filepath.Join(dir, "missing"), owner); err != nil {
		t.Fatalf("missing data dir: %v", err)
	}
	owners[50002] = listenerOtherOwner
	err := psmuxPortsOwned(dir, owner)
	var pe *psmuxPortError
	if !errors.Is(err, errPsmuxPortTaken) || !errors.As(err, &pe) || pe.session != "free" || pe.port != 50002 ||
		pe.file != filepath.Join(dir, "free.port") {
		t.Fatalf("port of another user = %v", err)
	}

	// Listeners that cannot be read refuse too, with the reason for the log.
	owners[50002] = listenerNoneSeen
	unread[50001] = errors.New("the TCP table outgrew the buffer")
	err = psmuxPortsOwned(dir, owner)
	if !errors.Is(err, errPsmuxPortsUnverified) || errors.Is(err, errPsmuxPortTaken) || !errors.As(err, &pe) ||
		pe.session != "work" || !strings.Contains(err.Error(), "outgrew the buffer") {
		t.Fatalf("unreadable listeners = %v", err)
	}
	if err := psmuxPortsOwned(filepath.Join(dir, "missing"), owner); err != nil {
		t.Fatalf("missing data dir with unreadable listeners: %v", err)
	}
}

// A data dir that exists but cannot be listed, and a .port file that cannot
// be read, refuse as unverified: only a missing dir means no server.
func TestPsmuxPortsUnreadableDirOrFile(t *testing.T) {
	free := func(int) (listenerOwner, error) { return listenerNoneSeen, nil }
	notDir := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(notDir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err := psmuxPortsOwned(notDir, free)
	var pe *psmuxPortError
	if !errors.Is(err, errPsmuxPortsUnverified) || !errors.As(err, &pe) || pe.file != notDir ||
		!strings.Contains(err.Error(), "data dir") {
		t.Fatalf("a data dir that is a file = %v", err)
	}
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		return // no mode bits to take the read right away with
	}
	dir := t.TempDir()
	port := filepath.Join(dir, "s.port")
	if err := os.WriteFile(port, []byte("50020"), 0o000); err != nil {
		t.Fatal(err)
	}
	err = psmuxPortsOwned(dir, free)
	if !errors.Is(err, errPsmuxPortsUnverified) || !errors.As(err, &pe) || pe.session != "s" || pe.file != port {
		t.Fatalf("an unreadable .port file = %v", err)
	}
}

// On psmux, a tmux command and a terminal attach do not start while a
// recorded port is another user's; tmux is not checked.
func TestPsmuxCommandsRefusedOnATakenPort(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "s.port"), []byte("50010"), 0o600); err != nil {
		t.Fatal(err)
	}
	orig, origPsmux := psmuxPorts, tmuxIsPsmux
	t.Cleanup(func() { psmuxPorts, tmuxIsPsmux = orig, origPsmux })
	psmuxPorts = &psmuxGuard{dir: func() string { return dir }, owner: func(int) (listenerOwner, error) { return listenerOtherOwner, nil }}
	tmuxIsPsmux = true
	if err := tmuxCmd(context.Background(), "list-sessions").Run(); !errors.Is(err, errPsmuxPortTaken) {
		t.Errorf("psmux command = %v", err)
	}
	if _, err := startTmuxTerminal(tmuxAttachArgv("$1"), Size{Cols: 80, Rows: 24}); !errors.Is(err, errPsmuxPortTaken) {
		t.Errorf("psmux attach = %v", err)
	}
	tmuxIsPsmux = false
	if cmd := tmuxCmd(context.Background(), "list-sessions"); cmd.Err != nil && errors.Is(cmd.Err, errPsmuxPortTaken) {
		t.Errorf("tmux command checked: %v", cmd.Err)
	}
}
