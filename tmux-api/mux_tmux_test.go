package main

import (
	"context"
	"errors"
	"testing"
)

func TestValidateTmuxTarget(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		// Valid targets - basic
		{"main", true},
		{"0", true},
		{"session:window", true},
		{"my-session", true},
		{"my_session", true},
		{"session.pane", true},
		{"Session123", true},

		// Valid targets - spaces and Unicode (tmux supports these)
		{"session name", true},   // space allowed
		{"tên tiếng việt", true}, // Vietnamese
		{"会话名称", true},           // Chinese
		{"セッション", true},          // Japanese
		{" leading", true},       // leading space
		{"trailing ", true},      // trailing space

		// Valid targets - special chars (safe with exec.Command, no shell injection)
		{"$(whoami)", true},   // not executed - passed literally to tmux
		{"; rm -rf /", true},  // not executed - passed literally to tmux
		{"session`id`", true}, // backticks safe with exec.Command
		{"session|cat", true}, // pipe safe with exec.Command

		// Invalid targets - empty or too long
		{"", false},
		{string(make([]byte, 65)), false}, // too long (65 chars)

		// Invalid targets - control characters
		{"session\nid", false},        // newline
		{"session\x00id", false},      // null byte
		{"session\tid", false},        // tab (control char)
		{"session\rid", false},        // carriage return
		{"\x1b[31mred\x1b[0m", false}, // ANSI escape
	}

	for _, tt := range tests {
		if got := validateTmuxTarget(tt.input); got != tt.want {
			t.Errorf("validateTmuxTarget(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestValidTmuxID(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"0", true},
		{"12", true},
		{"my-window", true},
		{"tên", true},
		{"-x", false},      // would be parsed as a flag
		{"-t", false},      // would be parsed as a flag
		{"other:0", false}, // would address another session
		{"main:0", false},  // qualified targets are built server-side only
		{"a\nb", false},    // control character
		{"", false},
	}
	for _, tt := range tests {
		if got := validTmuxID(tt.input); got != tt.want {
			t.Errorf("validTmuxID(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestValidTmuxName(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"shell", true},
		{"a:b c", true}, // ':' is fine inside a name
		{"-dash", false},
		{"bad\tname", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := validTmuxName(tt.input); got != tt.want {
			t.Errorf("validTmuxName(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestQualifyTarget(t *testing.T) {
	orig := tmuxSession
	defer func() { tmuxSession = orig }()

	tmuxSession = "main"
	if got := qualifyTarget("0"); got != "main:0" {
		t.Errorf("qualifyTarget(0) = %q, want main:0", got)
	}
	tmuxSession = "custom"
	if got := qualifyTarget("win"); got != "custom:win" {
		t.Errorf("qualifyTarget(win) = %q, want custom:win", got)
	}
}

func TestTmuxCmd(t *testing.T) {
	cmd := tmuxCmd(context.Background(), "list-windows")
	if cmd.Path == "" {
		t.Error("tmuxCmd should create a command")
	}
	if args := cmd.Args; args[0] != "tmux" || args[1] != "list-windows" {
		t.Errorf("tmuxCmd args = %v, want [tmux list-windows]", args)
	}
}

func TestTmuxCmdWithSocket(t *testing.T) {
	orig := tmuxSocket
	defer func() { tmuxSocket = orig }()

	tmuxSocket = "/tmp/test.sock"
	args := tmuxCmd(context.Background(), "list-windows").Args
	// Should have: tmux -S /tmp/test.sock list-windows
	if len(args) < 4 || args[1] != "-S" || args[2] != "/tmp/test.sock" {
		t.Errorf("tmuxCmd with socket args = %v, want [-S /tmp/test.sock ...]", args)
	}
}

func TestTmuxMuxCaps(t *testing.T) {
	m := tmuxMux{}
	if m.Name() != "tmux" {
		t.Errorf("Name() = %q, want tmux", m.Name())
	}
	if c := m.Caps(); !c.CopyMode || c.ClientSideSelect {
		t.Errorf("Caps() = %+v, want CopyMode only", c)
	}
	if err := m.Health(context.Background()); err != nil {
		t.Errorf("Health() = %v, want nil", err)
	}
}

// Invalid input must be rejected before any tmux process is started, so these
// cases run without tmux installed.
func TestTmuxMuxRejectsInvalidInput(t *testing.T) {
	m := tmuxMux{}
	ctx := context.Background()
	tests := []struct {
		name string
		call func() error
	}{
		{"select flag-like id", func() error { return m.SelectTab(ctx, "-t") }},
		{"select other session", func() error { return m.SelectTab(ctx, "other:0") }},
		{"close control char", func() error { return m.CloseTab(ctx, "a\x00b") }},
		{"rename bad id", func() error { return m.RenameTab(ctx, "x:1", "ok") }},
		{"rename empty name", func() error { return m.RenameTab(ctx, "0", "") }},
		{"rename flag-like name", func() error { return m.RenameTab(ctx, "0", "-n") }},
		{"rename control char name", func() error { return m.RenameTab(ctx, "0", "a\nb") }},
		{"new flag-like name", func() error { _, err := m.NewTab(ctx, "", "-d"); return err }},
		{"new unknown group", func() error { _, err := m.NewTab(ctx, "other", "x"); return err }},
		{"keys bad pane", func() error { return m.SendKeys(ctx, "other:1", "ls") }},
		{"keys flag-like", func() error { return m.SendKeys(ctx, "0", "-la") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var ie inputError
			if err := tt.call(); !errors.As(err, &ie) {
				t.Errorf("got %v, want inputError", err)
			}
		})
	}
}
