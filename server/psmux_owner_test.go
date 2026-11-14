package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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
	owner := func(port int) listenerOwner { return owners[port] }
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
	psmuxPorts = &psmuxGuard{dir: func() string { return dir }, owner: func(int) listenerOwner { return listenerOtherOwner }}
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
