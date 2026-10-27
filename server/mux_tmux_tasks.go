package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// A task runs in a window of its own, addressed by its pane's id (%N):
// a window index shifts with a move or renumber-windows, a pane id never
// names another pane. Not on psmux, which has no Files (so no root).

// NewTaskTab opens a window in groupID's session whose shell starts in dir,
// without making it the session's current window (-d). dir and name go
// through tmuxLiteral: tmux expands both as formats.
func (tmuxMux) NewTaskTab(ctx context.Context, groupID, name, dir string) (taskTab, error) {
	if tmuxIsPsmux {
		return taskTab{}, errUnsupported
	}
	session, ok := parseTmuxGroupID(groupID)
	if !ok {
		return taskTab{}, inputError("unknown group")
	}
	args := []string{"new-window", "-d", "-t", session + ":", "-c", tmuxLiteral(dir), "-P", "-F",
		"#{session_id}:#{window_index}:#{pane_id}:#{session_name}"}
	if validTmuxName(name) {
		args = append(args, "-n", tmuxLiteral(name))
	}
	out, err := tmuxCmd(ctx, args...).Output()
	if err != nil {
		if tmuxMissing(err) {
			return taskTab{}, inputError("unknown group")
		}
		return taskTab{}, err
	}
	// The name goes last: tmux turns a ':' in it into '_', but keep it whole.
	parts := strings.SplitN(strings.TrimSpace(string(out)), ":", 4)
	if len(parts) != 4 || !tmuxIndexRe.MatchString(parts[1]) || !tmuxPaneIDRe.MatchString(parts[2]) ||
		(session != defaultSessionTarget() && parts[0] != session) {
		return taskTab{}, fmt.Errorf("new-window printed %q", out)
	}
	id := formatTmuxID(parts[0], parts[3] == tmuxSession, parts[1])
	return taskTab{TabID: id, PaneID: parts[2], Target: parts[2]}, nil
}

// IdleShell reads target's shell (its pane_pid) and whether it is the
// terminal's foreground process, the pane not in copy mode.
func (tmuxMux) IdleShell(ctx context.Context, target string) (string, bool, error) {
	if tmuxIsPsmux {
		return "", false, errUnsupported
	}
	if !tmuxPaneIDRe.MatchString(target) {
		return "", false, inputError("invalid pane")
	}
	out, err := tmuxCmd(ctx, "display-message", "-p", "-t", target,
		"#{pane_id}:#{pane_dead}:#{pane_in_mode}:#{pane_pid}").Output()
	var ee *exec.ExitError
	if errors.As(err, &ee) && strings.Contains(string(ee.Stderr), "can't find") {
		return "", false, errTaskTargetGone
	}
	if err != nil {
		return "", false, err
	}
	parts := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(parts) != 4 || parts[0] != target || parts[1] == "1" {
		return "", false, errTaskTargetGone
	}
	pid, err := strconv.Atoi(parts[3])
	if err != nil {
		return "", false, fmt.Errorf("pane_pid %q", parts[3])
	}
	return procExeBase(pid), parts[2] == "0" && procForeground(pid), nil
}

func (tmuxMux) Interrupt(ctx context.Context, target string) error {
	if !tmuxPaneIDRe.MatchString(target) {
		return inputError("invalid pane")
	}
	return tmuxCmd(ctx, "send-keys", "-t", target, "C-c").Run()
}

// TypeLine sends line as literal keys (-l: no key names), then Enter.
func (tmuxMux) TypeLine(ctx context.Context, target, line string) error {
	if !tmuxPaneIDRe.MatchString(target) {
		return inputError("invalid pane")
	}
	if err := tmuxCmd(ctx, "send-keys", "-l", "-t", target, "--", line).Run(); err != nil {
		return err
	}
	return tmuxCmd(ctx, "send-keys", "-t", target, "Enter").Run()
}

// ReadTaskText captures target's last lines, wrapped rows joined (-J).
func (tmuxMux) ReadTaskText(ctx context.Context, target string, lines int) (string, error) {
	if !tmuxPaneIDRe.MatchString(target) {
		return "", inputError("invalid pane")
	}
	out, err := tmuxCmd(ctx, "capture-pane", "-p", "-J", "-S", "-"+strconv.Itoa(lines), "-t", target).Output()
	return string(out), err
}
