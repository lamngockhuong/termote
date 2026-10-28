package main

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// taskMux is a backend that can run a task: open a tab at a directory, tell
// whether a pane's shell waits at its prompt, clear and type into it, and
// read its text, each by the backend's own pane target (tmux %N, a Herdr or
// Zellij pane id), so the tab is found again after a move or a rename.
type taskMux interface {
	// NewTaskTab opens a tab in groupID whose shell starts in dir, without
	// focusing it. name may be empty.
	NewTaskTab(ctx context.Context, groupID, name, dir string) (taskTab, error)
	// IdleShell names target's shell and whether it waits at its prompt:
	// the shell itself in the terminal's foreground (no program it runs,
	// no nested shell), and not in a mode that takes keys (tmux copy mode).
	// errTaskTargetGone when target is no pane any more.
	IdleShell(ctx context.Context, target string) (shell string, idle bool, err error)
	// Interrupt sends C-c: a half-typed line, a continuation prompt or a
	// read waiting there is dropped.
	Interrupt(ctx context.Context, target string) error
	// TypeLine types line then Enter as keystrokes, never as a bracketed
	// paste (a shell without bracketed paste mode would take its markers as
	// input).
	TypeLine(ctx context.Context, target, line string) error
	// ReadTaskText reads target's last lines, wrapped rows joined.
	ReadTaskText(ctx context.Context, target string, lines int) (string, error)
}

// taskTab is a tab opened for a task: its ids as clients know them, and its
// one pane's target.
type taskTab struct {
	TabID, PaneID, Target string
}

// errTaskTargetGone: the task's pane was closed.
var errTaskTargetGone = &codedError{"tab_gone", "the task's tab was closed", http.StatusConflict}

// Shells a task line is built for. Any other shell is refused: its quoting
// and its exit status are unknown, so neither the command nor its markers
// could be typed safely.
const (
	shellPOSIX = "posix"
	shellFish  = "fish"
	shellPwsh  = "pwsh"
)

// taskShellKind maps a shell's process name to how a line is built for it,
// "" for one that is not supported (PowerShell 5.1, cmd, nu, csh, ...).
func taskShellKind(name string) string {
	n := strings.TrimSuffix(strings.ToLower(processName(name)), ".exe")
	switch strings.TrimPrefix(n, "-") { // a login shell's argv0
	case "bash", "zsh", "sh", "dash", "ash", "ksh", "mksh", "yash":
		return shellPOSIX
	case "fish":
		return shellFish
	case "pwsh":
		return shellPwsh
	}
	return ""
}

// shellQuote quotes s as one word of kind's syntax, with nothing in it
// expanded.
func shellQuote(kind, s string) string {
	switch kind {
	case shellFish:
		// In fish's single quotes only \\ and \' are escapes.
		s = strings.ReplaceAll(s, `\`, `\\`)
		return "'" + strings.ReplaceAll(s, "'", `\'`) + "'"
	case shellPwsh:
		// PowerShell takes the typographic single quotes as quotes too; a
		// quote is doubled to stand for itself.
		return "'" + strings.NewReplacer("'", "''", "‘", "‘‘", "’", "’’",
			"‚", "‚‚", "‛", "‛‛").Replace(s) + "'"
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// taskCommand is what runs a task in kind's syntax: the package manager's
// run or make with the name quoted, a tool's program with its arguments
// quoted, or the user's own command handed whole to the shell's eval, so a
// trailing &, ; or comment cannot reach the end marker. "" for a kind it
// does not know: nothing is typed.
func taskCommand(kind string, t resolvedTask) string {
	switch t.Kind {
	case taskKindScript:
		return t.PackageManager + " run " + shellQuote(kind, t.Name)
	case taskKindMake:
		return "make " + shellQuote(kind, t.Name)
	case taskKindUser:
		if kind == shellPwsh {
			return "Invoke-Expression " + shellQuote(kind, t.Command)
		}
		return "eval " + shellQuote(kind, t.Command)
	}
	if !isToolKind(t.Kind) || t.Head == "" {
		return ""
	}
	line := t.Head
	if kind == shellPwsh {
		line = t.PwshHead
	}
	for _, a := range t.Args {
		line += " " + shellQuote(kind, a)
	}
	return line
}

// buildTaskLine wraps cmd between a start and an end marker naming nonce;
// the end marker carries the exit status. The line as the terminal echoes
// it holds neither marker whole (the end one has %d, the start one its
// printf), so only what runs prints them.
func buildTaskLine(kind, cmd, nonce string) string {
	start, end := "[termote-task "+nonce+" start]", "[termote-task "+nonce+" exit "
	switch kind {
	case shellFish:
		return fmt.Sprintf(`printf '\n%s\n'; %s; printf '\n%s%%d]\n' $status`, start, cmd, end)
	case shellPwsh:
		// $LASTEXITCODE, reset first, holds a native command's code even
		// inside Invoke-Expression, whose own $? stays true; else $? is
		// false after a failed cmdlet.
		return fmt.Sprintf("Write-Host \"`n%s\"; $global:LASTEXITCODE=0; %s; Write-Host \"`n%s$(if($LASTEXITCODE){$LASTEXITCODE}elseif($?){0}else{1})]\"", start, cmd, end)
	}
	return fmt.Sprintf(`printf '\n%s\n'; %s; printf '\n%s%%d]\n' "$?"`, start, cmd, end)
}

var taskExitRe = regexp.MustCompile(`^\[termote-task ([0-9a-f]{16}) exit (-?[0-9]{1,10})\]$`)

// parseTaskExit finds nonce's end marker in a pane's text: the exit status
// the run printed, when it ended.
func parseTaskExit(text, nonce string) (int, bool) {
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		m := taskExitRe.FindStringSubmatch(strings.TrimRightFunc(lines[i], unicode.IsSpace))
		if m == nil || m[1] != nonce {
			continue
		}
		code, _ := strconv.Atoi(m[2])
		return code, true
	}
	return 0, false
}

// validTaskDir refuses a directory a backend could not be handed as typed:
// a control character, a line break or one that shows nothing.
func validTaskDir(dir string) bool {
	return dir != "" && !strings.ContainsFunc(dir, func(r rune) bool {
		return unicode.IsControl(r) || hiddenRune(r) || r == unicode.ReplacementChar
	})
}
