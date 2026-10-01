package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var tmuxSocket = os.Getenv("TMUX_SOCKET")

// tmuxBin is the tmux executable; tests replace it with a script.
var tmuxBin = "tmux"
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
	argv := []string{tmuxBin}
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
// pane IDs equal window IDs. tmux's own pane id (%N) is used only where the
// exact pane matters (the agent routes), since a window can be split.
type tmuxMux struct{}

func (tmuxMux) Name() string { return "tmux" }

func (tmuxMux) Caps() Caps { return Caps{CopyMode: true, AgentChat: agentProcSupported} }

// listWindowsAttempts bounds retries of an empty list-windows reply.
const listWindowsAttempts = 5

// listWindows returns the raw list-windows output. A live session always has
// at least one window, yet psmux intermittently prints nothing with exit 0
// (measured 8-12 of 40 calls); retry instead of reporting an empty session,
// which would make the PWA create a stray "shell" tab.
func listWindows(ctx context.Context) (string, error) {
	for i := 0; i < listWindowsAttempts; i++ {
		// Name goes last: SplitN keeps any ':' inside it. psmux mangles some
		// other separators (e.g. '|'), ':' works on both. pane_id and
		// pane_pid are the window's active pane.
		out, err := tmuxCmd(ctx, "list-windows", "-t", tmuxSession, "-F",
			"#{window_index}:#{window_active}:#{pane_id}:#{pane_pid}:#{window_name}").Output()
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

// scrubTmuxSecrets removes secrets from a tmux server that is already
// running. A tmux server started from a shell that had TERMOTE_* exported
// keeps them, and restarting Termote keeps that server, so without this every
// new tab would inherit the password.
// Shells already open keep theirs. Errors (no server yet, psmux without
// set-environment -u) are fine: a server started now gets terminalEnv.
func scrubTmuxSecrets(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, muxTimeout)
	defer cancel()
	for _, k := range termoteEnvKeys {
		tmuxCmd(ctx, "set-environment", "-g", "-u", k).Run()
	}
}

// ensureSession starts TMUX_SESSION detached when it does not exist. The
// server is the only thing that attaches to it, so the first snapshot creates
// it. A concurrent
// creation makes new-session fail, which is fine: the session then exists.
func ensureSession(ctx context.Context) bool {
	if tmuxCmd(ctx, "has-session", "-t", tmuxSession).Run() == nil {
		return false
	}
	cmd := tmuxCmd(ctx, "new-session", "-d", "-s", tmuxSession)
	cmd.Env = terminalEnv()
	if err := cmd.Run(); err != nil {
		log.Printf("tmux new-session %q: %v", tmuxSession, err)
	}
	return true
}

func (tmuxMux) Snapshot(ctx context.Context) (Snapshot, error) {
	out, err := listWindows(ctx)
	if err != nil && ensureSession(ctx) {
		out, err = listWindows(ctx)
	}
	if err != nil {
		return Snapshot{}, err
	}
	tabs := []Tab{}
	var agentPanes []agentPane
	for _, line := range strings.Split(out, "\n") {
		parts := strings.SplitN(strings.TrimRight(line, "\r"), ":", 5)
		if len(parts) != 5 {
			continue
		}
		active := parts[1] == "1"
		tabs = append(tabs, Tab{
			ID:     parts[0],
			Name:   parts[4],
			Active: active,
			Panes:  []Pane{{ID: parts[0], Active: active}},
		})
		agentPanes = append(agentPanes, agentPane{len(tabs) - 1, parts[2], parts[3]})
	}
	for i, a := range lookupAgents(ctx, agentPanes) {
		if a != nil {
			tabs[agentPanes[i].tab].Panes[0].Agent = a
		}
	}
	return Snapshot{Groups: []Group{{ID: tmuxSession, Name: tmuxSession, Tabs: tabs}}}, nil
}

// SelectTab switches the shared session's current window, so every attached
// client follows.
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
	// A client may create a tab before anything asked for a snapshot (a
	// script right after install): create the session and retry, as Snapshot
	// does. Only on failure, since every psmux call costs ~100ms.
	if err != nil && ensureSession(ctx) {
		out, err = tmuxCmd(ctx, args...).Output()
	}
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

// ClosePane is not offered: a tab here is one window shown as one pane, and
// it is closed as a tab.
func (tmuxMux) ClosePane(context.Context, string) error { return errUnsupported }

// Scroll is not offered: tmux history is scrolled in copy mode.
func (tmuxMux) Scroll(context.Context, string, int) error { return errUnsupported }

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
// client to the session. Every client shares the current window and the
// window follows the most recently active client's size.
func (m tmuxMux) Attach(ctx context.Context, paneID string, size Size) (TermStream, error) {
	if err := m.SelectTab(ctx, paneID); err != nil {
		return nil, err
	}
	return startTerminal(tmuxAttachArgv(), size)
}

// agentLookupWait bounds how long a snapshot waits for agent lookups, which
// read files in each agent's config dir (possibly a network mount).
const agentLookupWait = 300 * time.Millisecond

type agentPane struct {
	tab             int
	paneID, panePID string
}

// lookupAgents finds the agent of each pane. A snapshot that would wait past
// agentLookupWait is answered without agents; the lookup keeps running and
// fills the caches for the next one.
func lookupAgents(ctx context.Context, panes []agentPane) []*AgentInfo {
	done := make(chan []*AgentInfo, 1)
	go func() {
		out := make([]*AgentInfo, len(panes))
		for i, p := range panes {
			if s, ok := tmuxPaneAgent(p.paneID, p.panePID); ok {
				out[i] = &AgentInfo{Name: s.Agent, Status: s.Status}
			}
		}
		done <- out
	}()
	select {
	case out := <-done:
		return out
	case <-ctx.Done():
	case <-time.After(agentLookupWait):
	}
	log.Printf("tmux snapshot: agent lookup took longer than %s, skipped", agentLookupWait)
	return make([]*AgentInfo, len(panes))
}

// tmuxPaneIDRe matches tmux's own pane id, which never starts with '-'.
var tmuxPaneIDRe = regexp.MustCompile(`^%[0-9]+$`)

// tmuxPaneAgent finds the Claude Code session under a pane's process.
func tmuxPaneAgent(paneID, panePID string) (AgentSession, bool) {
	return tmuxPaneAgentWith(paneID, panePID, findClaudeSession)
}

func tmuxPaneAgentWith(paneID, panePID string, find func(string, int) (AgentSession, bool)) (AgentSession, bool) {
	pid, err := strconv.Atoi(panePID)
	if !tmuxPaneIDRe.MatchString(paneID) || err != nil {
		return AgentSession{}, false
	}
	s, ok := find(paneID, pid)
	s.Target = paneID
	return s, ok
}

// AgentSession reports the agent session of a window's active pane. It asks
// tmux for that one pane instead of listing every window. tmux answers a
// target that does not exist with the current window instead of an error, so
// the window index in the reply must be the one asked for.
func (tmuxMux) AgentSession(ctx context.Context, paneID string) (AgentSession, bool, error) {
	return tmuxAgentSession(ctx, paneID, findClaudeSession)
}

// AgentSessionNow is AgentSession with a fresh process walk: the window's
// active pane, its process tree and the session file as they are now, plus
// whether the pane is in copy mode.
func (tmuxMux) AgentSessionNow(ctx context.Context, paneID string) (AgentSession, bool, error) {
	return tmuxAgentSession(ctx, paneID, func(_ string, pid int) (AgentSession, bool) { return findClaudeSessionNow(pid) })
}

func tmuxAgentSession(ctx context.Context, paneID string, find func(string, int) (AgentSession, bool)) (AgentSession, bool, error) {
	if !validTmuxID(paneID) {
		return AgentSession{}, false, inputError("invalid pane id")
	}
	if _, err := strconv.Atoi(paneID); err != nil {
		return AgentSession{}, false, inputError("invalid pane id")
	}
	out, err := tmuxCmd(ctx, "display-message", "-p", "-t", qualifyTarget(paneID),
		"#{window_index}:#{pane_in_mode}:#{pane_id}:#{pane_pid}").Output()
	parts := strings.Split(strings.TrimSpace(string(out)), ":")
	if err != nil || len(parts) != 4 || parts[0] != paneID {
		return AgentSession{}, false, inputError("unknown pane")
	}
	s, ok := tmuxPaneAgentWith(parts[2], parts[3], find)
	s.InMode = parts[1] == "1"
	return s, ok, nil
}

// Capture returns the pane's visible screen with its SGR attributes.
func (tmuxMux) Capture(ctx context.Context, target string) (string, error) {
	if !tmuxPaneIDRe.MatchString(target) {
		return "", inputError("invalid pane")
	}
	out, err := tmuxCmd(ctx, "capture-pane", "-p", "-e", "-t", target).Output()
	return string(out), err
}

// Paste loads text into a buffer of its own name and pastes it bracketed
// (-p), deleting the buffer (-d): the user's own buffers, and a concurrent
// paste, are never touched.
func (tmuxMux) Paste(ctx context.Context, target, text string) error {
	if !tmuxPaneIDRe.MatchString(target) {
		return inputError("invalid pane")
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	name := "termote-" + hex.EncodeToString(b)
	load := tmuxCmd(ctx, "load-buffer", "-b", name, "-")
	load.Stdin = strings.NewReader(text)
	if err := load.Run(); err != nil {
		return err
	}
	if err := tmuxCmd(ctx, "paste-buffer", "-b", name, "-p", "-d", "-t", target).Run(); err != nil {
		tmuxCmd(context.Background(), "delete-buffer", "-b", name).Run()
		return err
	}
	return nil
}

// SendKeySequence passes each key as its own send-keys argument.
func (tmuxMux) SendKeySequence(ctx context.Context, target string, keys []string) error {
	if !tmuxPaneIDRe.MatchString(target) || !validAgentKeys(keys) {
		return inputError("invalid keys")
	}
	return tmuxCmd(ctx, append([]string{"send-keys", "-t", target}, keys...)...).Run()
}

// Health reports ok without touching tmux: the PWA creates the
// first window itself when the session is empty.
func (tmuxMux) Health(context.Context) error { return nil }
