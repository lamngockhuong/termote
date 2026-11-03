package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// The Files, Chat and Tasks views of an hc pane, when the terminal's shell is
// not known yet, its folder is not absolute, or the core refuses.

func TestHcAgentPaneDirAndShellLookups(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	if _, _, err := s.m.PaneDir(ctx, "t99"); err != errUnknownPane {
		t.Fatalf("unknown pane: %v", err)
	}
	// A folder that is not absolute is no folder to offer.
	editHcTerm(t, s, "t2", func(h *hcTerminal) { h.Cwd = "relative" })
	if _, _, err := s.m.PaneDir(ctx, "t2"); err != errUnsupported {
		t.Fatalf("relative folder: %v", err)
	}
	// Without its shell's pid there is no agent session to find.
	editHcTerm(t, s, "t2", func(h *hcTerminal) { h.Pid = ptr(0) })
	for _, fresh := range []bool{false, true} {
		if _, ok, err := s.m.agentSession(ctx, "t2", fresh); err != nil || ok {
			t.Fatalf("fresh %v: ok %v err %v", fresh, ok, err)
		}
	}

	// No pid yet: no shell, and it is not the foreground program.
	editHcTerm(t, s, "t2", func(h *hcTerminal) { h.Pid = nil })
	if shell, pid, idle, err := s.m.IdleShell(ctx, "t2"); err != nil || shell != "" || pid != 0 || idle {
		t.Fatalf("no pid: %q %d %v %v", shell, pid, idle, err)
	}
	// A shell whose executable is unknown is named by its foreground program.
	editHcTerm(t, s, "t2", func(h *hcTerminal) {
		h.Pid = ptr(999999999) // no such process
		h.Foreground = &hcForeground{Pid: 5, Name: "vim"}
	})
	if shell, pid, idle, err := s.m.IdleShell(ctx, "t2"); err != nil || shell != "vim" || pid != 999999999 || idle {
		t.Fatalf("named by foreground: %q %d %v %v", shell, pid, idle, err)
	}

	// A core that does not run is not a missing terminal.
	down := newHcMuxDown(t)
	if _, _, _, err := down.IdleShell(ctx, "t1"); err != errHcUnavailable {
		t.Fatalf("core down: %v", err)
	}
}

func TestHcAgentCaptureErrors(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	if _, err := s.m.Capture(ctx, "t99"); err != errUnknownPane {
		t.Fatalf("unknown pane: %v", err)
	}

	// A RESIZE before the first paint is not part of the screen.
	attachTo(s.core, func(core *fakeHcCore, ch uint32) {
		core.frame(ch, hcKindResize, hcSizePayload(80, 24))
		core.send(ch, []byte("x\x1b[?9001"))
	})
	if screen, err := s.m.Capture(ctx, "t2"); err != nil || screen != "x" {
		t.Fatalf("screen %q %v", screen, err)
	}

	// The core ends the attach before its first paint.
	attachTo(s.core, func(core *fakeHcCore, ch uint32) { core.closeChannel(ch, "exited") })
	var closed *hcClosed
	if _, err := s.m.Capture(ctx, "t2"); !errors.As(err, &closed) || !closed.final() {
		t.Fatalf("closed before the paint: %v", err)
	}

	// A first paint that never ends is cut off.
	attachTo(s.core, func(core *fakeHcCore, ch uint32) {
		core.send(ch, bytes.Repeat([]byte("a"), hcCaptureMax+1))
	})
	if _, err := s.m.Capture(ctx, "t2"); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("endless paint: %v", err)
	}

	refuseAttach(s.core, "not_found")
	if _, err := s.m.Capture(ctx, "t2"); err != errUnknownPane {
		t.Fatalf("refused attach: %v", err)
	}
	// The state still follows the core, but the client holds no connection.
	dropHcClient(s)
	if _, err := s.m.Capture(ctx, "t2"); err != errHcUnavailable {
		t.Fatalf("no connection: %v", err)
	}
}

// Typing into a pane that is gone fails before anything is sent.
func TestHcAgentTypingIntoAGonePane(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	if err := s.m.Paste(ctx, "t99", "x"); err != errUnknownPane {
		t.Errorf("Paste: %v", err)
	}
	if err := s.m.SendKeySequence(ctx, "t99", []string{"Enter"}); err != errUnknownPane {
		t.Errorf("SendKeySequence: %v", err)
	}
	if err := s.m.Interrupt(ctx, "t99"); err != errUnknownPane {
		t.Errorf("Interrupt: %v", err)
	}
	if err := s.m.TypeLine(ctx, "t99", "ls"); err != errUnknownPane {
		t.Errorf("TypeLine: %v", err)
	}
	if n := len(s.core.callsOf("terminal.attach")); n != 0 {
		t.Errorf("%d attaches for a gone pane", n)
	}
}

// A task tab the core refuses to start, or starts without a local terminal,
// is not reported as made.
func TestHcAgentTaskTabFailures(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	s.core.handle("terminal.run", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
		core.replyError(id, "conflict", "no room")
	})
	if _, err := s.m.NewTaskTab(ctx, "sp1", "build", "/w"); hcErrorKind(err) != "conflict" {
		t.Fatalf("refused run: %v", err)
	}
	s.core.handle("terminal.run", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
		core.reply(id, map[string]any{"address": "box/t1"})
	})
	if _, err := s.m.NewTaskTab(ctx, "sp1", "build", "/w"); err == nil {
		t.Fatal("a reply without a local terminal was taken")
	}
}
