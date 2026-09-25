package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var tmuxSocket = os.Getenv("TMUX_SOCKET")
var tmuxSession = envOr("TMUX_SESSION", "main")

func init() {
	if !validateTmuxTarget(tmuxSession) {
		log.Fatalf("invalid TMUX_SESSION value: %q", tmuxSession)
	}
}

// invalidTmuxChars matches control characters and null bytes that should be blocked
// tmux supports Unicode and spaces; Go's exec.Command is safe from shell injection
var invalidTmuxChars = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// validateTmuxTarget checks if target is a safe tmux identifier
// Allows Unicode, spaces, and printable chars; blocks control chars and empty/too-long strings
func validateTmuxTarget(target string) bool {
	return target != "" && len(target) <= 64 && !invalidTmuxChars.MatchString(target)
}

// validTmuxID accepts a window index or a window name inside TMUX_SESSION.
// A ':' would let the caller address another session, and a leading '-' would
// be parsed as a flag. psmux silently ignores commands that contain "--", so
// rejecting a leading '-' is the only guard that works on both tmux and psmux.
func validTmuxID(id string) bool {
	return validateTmuxTarget(id) && !strings.HasPrefix(id, "-") && !strings.Contains(id, ":")
}

// validTmuxName accepts a window name passed as a flag value or positional
// argument; a leading '-' would be parsed as a flag.
func validTmuxName(name string) bool {
	return validateTmuxTarget(name) && !strings.HasPrefix(name, "-")
}

// qualifyTarget prefixes a validated window index/name with the session name
// so that psmux (and tmux) can resolve it correctly, e.g. "0" → "main:0".
func qualifyTarget(id string) string {
	return tmuxSession + ":" + id
}

// tmuxArgv returns the full tmux command line, with the socket flag if set.
func tmuxArgv(args ...string) []string {
	argv := []string{"tmux"}
	if tmuxSocket != "" {
		argv = append(argv, "-S", tmuxSocket)
	}
	return append(argv, args...)
}

// tmuxCmd creates a tmux command with optional socket flag
func tmuxCmd(ctx context.Context, args ...string) *exec.Cmd {
	argv := tmuxArgv(args...)
	return exec.CommandContext(ctx, argv[0], argv[1:]...)
}

// tmuxAttachArgv is the command every terminal stream runs.
func tmuxAttachArgv() []string {
	return tmuxArgv("attach", "-t", tmuxSession)
}

// isTmuxAttachCmdline matches exactly the command line of tmuxAttachArgv, for
// reapOrphanTerminals.
func isTmuxAttachCmdline(cmdline string) bool {
	return cmdline == strings.Join(tmuxAttachArgv(), " ")
}

// tmuxMux drives one tmux (or psmux on Windows) session. The session is the
// only group, each window is a tab, and each tab exposes its active pane, so
// pane IDs equal window IDs.
type tmuxMux struct{}

func (tmuxMux) Name() string { return "tmux" }

func (tmuxMux) Caps() Caps { return Caps{CopyMode: true} }

// listWindowsAttempts bounds retries of an empty list-windows reply.
const listWindowsAttempts = 5

// listWindows returns the raw list-windows output. A live session always has
// at least one window, yet psmux intermittently prints nothing with exit 0
// (measured 8-12 of 40 calls); retry instead of reporting an empty session,
// which would make the PWA create a stray "shell" tab.
func listWindows(ctx context.Context) (string, error) {
	for i := 0; i < listWindowsAttempts; i++ {
		// Name goes last: SplitN keeps any ':' inside it. psmux mangles some
		// other separators (e.g. '|'), ':' works on both.
		out, err := tmuxCmd(ctx, "list-windows", "-t", tmuxSession, "-F",
			"#{window_index}:#{window_active}:#{window_name}").Output()
		if err != nil {
			return "", err
		}
		if s := strings.TrimSpace(string(out)); s != "" {
			return s, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(30 * time.Millisecond):
		}
	}
	return "", errors.New("list-windows returned no windows")
}

func (tmuxMux) Snapshot(ctx context.Context) (Snapshot, error) {
	out, err := listWindows(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	tabs := []Tab{}
	for _, line := range strings.Split(out, "\n") {
		parts := strings.SplitN(strings.TrimRight(line, "\r"), ":", 3)
		if len(parts) != 3 {
			continue
		}
		active := parts[1] == "1"
		tabs = append(tabs, Tab{
			ID:     parts[0],
			Name:   parts[2],
			Active: active,
			Panes:  []Pane{{ID: parts[0], Active: active}},
		})
	}
	return Snapshot{Groups: []Group{{ID: tmuxSession, Name: tmuxSession, Tabs: tabs}}}, nil
}

// SelectTab switches the shared session's current window, so every attached
// client follows (same as 0.x).
func (tmuxMux) SelectTab(ctx context.Context, tabID string) error {
	if !validTmuxID(tabID) {
		return inputError("invalid tab id")
	}
	return tmuxCmd(ctx, "select-window", "-t", qualifyTarget(tabID)).Run()
}

func (tmuxMux) NewTab(ctx context.Context, groupID, name string) (string, error) {
	if groupID != "" && groupID != tmuxSession {
		return "", inputError("unknown group")
	}
	args := []string{"new-window", "-t", tmuxSession, "-P", "-F", "#{window_index}"}
	if name != "" {
		if !validTmuxName(name) {
			return "", inputError("invalid tab name")
		}
		args = append(args, "-n", name)
	}
	out, err := tmuxCmd(ctx, args...).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func (tmuxMux) CloseTab(ctx context.Context, tabID string) error {
	if !validTmuxID(tabID) {
		return inputError("invalid tab id")
	}
	return tmuxCmd(ctx, "kill-window", "-t", qualifyTarget(tabID)).Run()
}

func (tmuxMux) RenameTab(ctx context.Context, tabID, name string) error {
	if !validTmuxID(tabID) {
		return inputError("invalid tab id")
	}
	if name == "" {
		return inputError("name is required")
	}
	if !validTmuxName(name) {
		return inputError("invalid tab name")
	}
	return tmuxCmd(ctx, "rename-window", "-t", qualifyTarget(tabID), name).Run()
}

// SendKeys passes keys as one tmux send-keys argument, so key names such as
// "Enter" or "C-c" are interpreted by tmux.
func (tmuxMux) SendKeys(ctx context.Context, paneID, keys string) error {
	if !validTmuxID(paneID) {
		return inputError("invalid pane id")
	}
	if strings.HasPrefix(keys, "-") {
		return inputError("keys must not start with '-'")
	}
	return tmuxCmd(ctx, "send-keys", "-t", qualifyTarget(paneID), keys).Run()
}

// Attach makes paneID the session's current window, then attaches a new tmux
// client to the session. Like 0.x, every client shares the current window and
// the window follows the most recently active client's size.
func (m tmuxMux) Attach(ctx context.Context, paneID string, size Size) (TermStream, error) {
	if err := m.SelectTab(ctx, paneID); err != nil {
		return nil, err
	}
	return startTerminal(tmuxAttachArgv(), size)
}

// Health reports ok without touching tmux, as in 0.x: the PWA creates the
// first window itself when the session is empty.
func (tmuxMux) Health(context.Context) error { return nil }
