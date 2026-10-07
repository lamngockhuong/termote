package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var tmuxSocket = os.Getenv("TMUX_SOCKET")

// tmuxBin is the tmux executable; tests replace it with a script.
var tmuxBin = "tmux"
var tmuxSession = envOr("TMUX_SESSION", "main")

func init() {
	if !validTmuxSessionName(tmuxSession) {
		log.Fatalf("invalid TMUX_SESSION value: %q", tmuxSession)
	}
}

// validTmuxSessionName accepts a name for TMUX_SESSION. tmux turns ':' and
// '.' in a session name into '_', a leading '=' would make "=<name>" mean
// something else, and a leading '$' would read as a session id ($N), which
// other sessions' group ids are.
func validTmuxSessionName(name string) bool {
	return validTmuxName(name) && !strings.ContainsAny(name, ":.") &&
		!strings.HasPrefix(name, "=") && !strings.HasPrefix(name, "$")
}

// invalidTmuxChars matches control characters and null bytes that should be blocked
// tmux supports Unicode and spaces; Go's exec.Command is safe from shell injection
var invalidTmuxChars = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// validateTmuxTarget checks if target is a safe tmux identifier
// Allows Unicode, spaces, and printable chars; blocks control chars and empty/too-long strings.
// tmux (and psmux) take an argument ending in ';' as the end of the command,
// so "0;" would turn the arguments after it into a second command.
func validateTmuxTarget(target string) bool {
	return target != "" && len(target) <= 64 && !invalidTmuxChars.MatchString(target) &&
		!strings.HasSuffix(target, ";")
}

// validTmuxName accepts a window name passed as a flag value or positional
// argument; a leading '-' would be parsed as a flag.
func validTmuxName(name string) bool {
	return validateTmuxTarget(name) && !strings.HasPrefix(name, "-")
}

// tmuxLiteral escapes a validated name or directory for tmux arguments that
// it expands as formats (new-window -n, rename-window, new-session -s and
// -c, rename-session): tmux would run a #() job and replace #{...}, so a '#'
// is doubled to keep the text as typed. A run of '#' right before '[' (a
// style) is the one thing tmux leaves as it is, so it is kept. psmux is left
// as it was: whether it expands formats is unchecked, so a new session's
// name and directory are refused there when they hold a '#'.
func tmuxLiteral(name string) string {
	if tmuxIsPsmux {
		return name
	}
	return tmuxHashRun.ReplaceAllStringFunc(name, func(run string) string {
		if strings.HasSuffix(run, "[") {
			return run
		}
		return run + run
	})
}

// tmuxHashRun matches a whole run of '#', with the '[' after it if any.
var tmuxHashRun = regexp.MustCompile(`#+\[?`)

// Tab and group ids. Every session on the tmux server is a group. The
// default session (TMUX_SESSION) keeps the ids it always had, so links and
// saved selections still work: its group id is its name and its tab ids are
// bare window indexes ("0"). Any other session is addressed by tmux's own
// session id, which a rename does not change and which any session name can
// have: group "$3", tabs "$3:1". A tab's single pane has the tab's id.
//
// Every target built from them matches exactly: "$N" can only mean that
// session and "=name" turns off tmux's prefix and pattern matching, so an id
// never reaches a session whose name merely starts like it.
var (
	tmuxIndexRe     = regexp.MustCompile(`^[0-9]{1,9}$`)
	tmuxTabIDRe     = regexp.MustCompile(`^\$[0-9]{1,9}:[0-9]{1,9}$`)
	tmuxSessionIDRe = regexp.MustCompile(`^\$[0-9]{1,9}$`)
)

// tmuxWindow is a window a tab id names.
type tmuxWindow struct {
	// session is the exact target of its session: "=<TMUX_SESSION>" or "$N".
	session string
	// sessionID is "$N", empty for the default session (known by name).
	sessionID string
	index     string
}

// tmuxIsPsmux is set on Windows, where the tmux server is psmux. It differs
// from tmux in two things the targets here rely on: it has no "=" before a
// window index (it answers "can't find window: =0" with exit 0, and
// select-window and send-keys silently do nothing), and it numbers panes per
// session, so every session has a %1 and "-t %1" reaches the most recent one.
// A variable so that tests on Unix cover both.
var tmuxIsPsmux = runtime.GOOS == "windows"

// target is the window's exact tmux target. The '=' before the index makes
// tmux take it as an index only: without it, a missing index 9 would match
// a window named "9x". psmux never matches a window name, so it gets the
// bare index.
func (w tmuxWindow) target() string {
	if tmuxIsPsmux {
		return w.session + ":" + w.index
	}
	return w.session + ":=" + w.index
}

// agentTarget is the target the agent routes read and type into, from
// tmux's own reply: tmux's pane id, unique on the server, which stays on the
// pane even when the window is split. On psmux a pane id is not unique, so
// it is the window ("$N:i", whichever pane has focus). Built from the reply,
// never from the client's id, so one window always has one target (the
// pane lock's key): "1" and "$0:1" may name the same window.
func agentTarget(sessionID, index, paneID string) string {
	if tmuxIsPsmux {
		return sessionID + ":" + index
	}
	return paneID
}

// validAgentTarget accepts only what agentTarget returns: a pane id on tmux,
// "$N:i" on psmux.
func validAgentTarget(target string) bool {
	if tmuxIsPsmux {
		return tmuxTabIDRe.MatchString(target)
	}
	return tmuxPaneIDRe.MatchString(target)
}

// matches reports whether a reply's session id, session name and window
// index are this window's. tmux answers a target that no longer exists with
// another window (the current one) or nothing, so every reply is checked.
func (w tmuxWindow) matches(sessionID, sessionName, index string) bool {
	if index != w.index {
		return false
	}
	if w.sessionID == "" {
		return sessionName == tmuxSession
	}
	return sessionID == w.sessionID
}

// defaultSessionTarget is the exact target of TMUX_SESSION.
func defaultSessionTarget() string { return "=" + tmuxSession }

// parseTmuxID reads a tab (or pane) id: a bare window index in the default
// session, or "$N:index" in another one. A window name is not an id.
func parseTmuxID(id string) (tmuxWindow, bool) {
	if tmuxIndexRe.MatchString(id) {
		return tmuxWindow{session: defaultSessionTarget(), index: id}, true
	}
	if !tmuxTabIDRe.MatchString(id) {
		return tmuxWindow{}, false
	}
	sid, index, _ := strings.Cut(id, ":")
	return tmuxWindow{session: sid, sessionID: sid, index: index}, true
}

// parseTmuxGroupID reads a group id ("" is the default session) and returns
// the session's exact target.
func parseTmuxGroupID(id string) (string, bool) {
	switch {
	case id == "" || id == tmuxSession:
		return defaultSessionTarget(), true
	case tmuxSessionIDRe.MatchString(id):
		return id, true
	}
	return "", false
}

// formatTmuxID is the tab id of a window: bare in the default session.
func formatTmuxID(sessionID string, isDefault bool, index string) string {
	if isDefault {
		return index
	}
	return sessionID + ":" + index
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

// tmuxAttachArgv is the command a terminal stream runs for one session
// (its exact target). -E keeps the client's environment (the server's, less
// TERMOTE_*) out of the session's update-environment, which suits a session
// the user may also attach to, and marks the command as termote's, so the
// reaper never mistakes a user's own "tmux attach -t x" for an orphan.
func tmuxAttachArgv(session string) []string {
	return tmuxArgv("attach", "-E", "-t", session)
}

// isTmuxAttachCmdline matches exactly the command line of a stream's
// tmuxAttachArgv, for reapOrphanTerminals, plus the one releases before
// several sessions ran ("attach -t <TMUX_SESSION>"), which an update may
// have left behind. Nothing else matches, a prefix of either included.
func isTmuxAttachCmdline(cmdline string) bool {
	if cmdline == strings.Join(tmuxArgv("attach", "-t", tmuxSession), " ") ||
		cmdline == strings.Join(tmuxAttachArgv(defaultSessionTarget()), " ") {
		return true
	}
	prefix := strings.Join(tmuxArgv("attach", "-E", "-t"), " ") + " "
	rest, ok := strings.CutPrefix(cmdline, prefix)
	return ok && tmuxSessionIDRe.MatchString(rest)
}

// tmuxMux drives every session on a tmux (or psmux on Windows) server. A
// session is a group, each window is a tab, and each tab exposes its active
// pane, so pane IDs equal window IDs. tmux's own pane id (%N) is used only
// where the exact pane matters (the agent routes, except on psmux: see
// agentTarget), since a window can be
// split.
type tmuxMux struct{}

func (tmuxMux) Name() string { return "tmux" }

func (tmuxMux) Caps() Caps {
	return Caps{CopyMode: true, AgentChat: agentProcSupported, Files: tmuxFilesSupported, Groups: true}
}

// tmuxListFormat is one window per line, every session's.
const tmuxListFormat = "#{session_id}:#{window_index}:#{window_active}:#{pane_id}:#{pane_pid}:#{session_name}:#{window_name}"

// listWindowsAttempts bounds retries of an empty list-windows reply.
const listWindowsAttempts = 5

// listWindows returns the raw list-windows output of every session. A live
// server always has at least one window, yet psmux intermittently prints nothing with exit 0
// (measured 8-12 of 40 calls); retry instead of reporting an empty session,
// which would make the PWA create a stray "shell" tab.
func listWindows(ctx context.Context) (string, error) {
	for i := 0; i < listWindowsAttempts; i++ {
		// The window name goes last: SplitN keeps any ':' inside it, and a
		// session name never holds one (tmux turns it into '_'). psmux
		// mangles some other separators (e.g. '|'), ':' works on both.
		// pane_id and pane_pid are the window's active pane.
		out, err := tmuxCmd(ctx, "list-windows", "-a", "-F", tmuxListFormat).Output()
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
	if tmuxCmd(ctx, "has-session", "-t", defaultSessionTarget()).Run() == nil {
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
	if (err != nil || !hasDefaultSession(out)) && ensureSession(ctx) {
		out, err = listWindows(ctx)
	}
	if err != nil {
		return Snapshot{}, err
	}
	groups := parseTmuxWindows(out)
	// A live server always lists a window; none read means a tmux (psmux)
	// that does not know this format. An empty snapshot would make the PWA
	// create a tab on every poll.
	if len(groups) == 0 {
		return Snapshot{}, errors.New("list-windows: no window could be read")
	}
	var agentPanes []agentPane
	for gi, g := range groups {
		for ti := range g.Tabs {
			agentPanes = append(agentPanes, agentPane{gi, ti, g.paneIDs[ti], g.panePIDs[ti]})
		}
	}
	for i, a := range lookupAgents(ctx, agentPanes) {
		if a != nil {
			groups[agentPanes[i].group].Tabs[agentPanes[i].tab].Panes[0].Agent = a
		}
	}
	attachTmuxProcesses(groups, tmuxPaneProcesses(ctx))
	snap := Snapshot{Groups: make([]Group, len(groups))}
	for i, g := range groups {
		snap.Groups[i] = g.Group
	}
	return snap, nil
}

// tmuxGroup is a group with the tmux pane of each tab, for the agent lookup,
// and its session id and window indexes, for the process lookup.
type tmuxGroup struct {
	Group
	sessionID                    string
	paneIDs, panePIDs, windowIdx []string
}

// tmuxListLine is one line of tmuxListFormat.
type tmuxListLine struct {
	sessionID, index, paneID, panePID, sessionName, windowName string
	active                                                     bool
}

func parseTmuxListLine(line string) (tmuxListLine, bool) {
	parts := strings.SplitN(strings.TrimRight(line, "\r"), ":", 7)
	if len(parts) != 7 || !tmuxSessionIDRe.MatchString(parts[0]) || !tmuxIndexRe.MatchString(parts[1]) {
		return tmuxListLine{}, false
	}
	return tmuxListLine{sessionID: parts[0], index: parts[1], active: parts[2] == "1",
		paneID: parts[3], panePID: parts[4], sessionName: parts[5], windowName: parts[6]}, true
}

// hasDefaultSession reports whether list-windows output has a window of
// TMUX_SESSION, compared by exact name.
func hasDefaultSession(out string) bool {
	for _, line := range strings.Split(out, "\n") {
		if l, ok := parseTmuxListLine(line); ok && l.sessionName == tmuxSession {
			return true
		}
	}
	return false
}

// parseTmuxWindows groups list-windows output by session: the default
// session first, then the others in the order tmux lists them.
func parseTmuxWindows(out string) []tmuxGroup {
	var groups []tmuxGroup
	at := map[string]int{}
	for _, line := range strings.Split(out, "\n") {
		l, ok := parseTmuxListLine(line)
		if !ok {
			continue
		}
		isDefault := l.sessionName == tmuxSession
		i, seen := at[l.sessionID]
		if !seen {
			g := tmuxGroup{Group: Group{ID: l.sessionID, Name: l.sessionName, Tabs: []Tab{}}, sessionID: l.sessionID}
			if isDefault {
				g.ID = tmuxSession
			}
			i = len(groups)
			at[l.sessionID] = i
			groups = append(groups, g)
		}
		id := formatTmuxID(l.sessionID, isDefault, l.index)
		g := &groups[i]
		g.Tabs = append(g.Tabs, Tab{ID: id, Name: l.windowName, Active: l.active,
			Panes: []Pane{{ID: id, Active: l.active}}})
		g.paneIDs = append(g.paneIDs, l.paneID)
		g.panePIDs = append(g.panePIDs, l.panePID)
		g.windowIdx = append(g.windowIdx, l.index)
	}
	for i := range groups {
		if groups[i].ID == tmuxSession && i > 0 {
			d := groups[i]
			copy(groups[1:i+1], groups[:i])
			groups[0] = d
			break
		}
	}
	return groups
}

// tmuxPaneFormat is every pane of every session: its window, its index and
// whether it is the window's active one, then the command and the directory,
// each after its length in bytes (#{n:}). A directory can hold a newline or
// a ':', so the output is read by those lengths, never split into lines.
const tmuxPaneFormat = "#{session_id}:#{window_index}:#{pane_index}:#{pane_active}:" +
	"#{n:pane_current_command}:#{pane_current_command}#{n:pane_current_path}:#{pane_current_path}"

// tmuxWindowKey names a window across sessions: psmux numbers panes per
// session, so a pane id (%N) is not one.
type tmuxWindowKey struct{ sessionID, index string }

// tmuxPaneProc is one pane's process, as tmuxPaneFormat reports it.
type tmuxPaneProc struct {
	index  int
	active bool
	proc   ProcessInfo
}

// parseTmuxPanes reads tmuxPaneFormat output into each window's panes, in
// pane order. It stops at the first entry it cannot read (a psmux that does
// not expand #{n:}, a length that does not match), keeping the windows
// before it but not the one it was in, which would be missing panes; a pane
// listed twice is dropped altogether.
func parseTmuxPanes(out []byte) map[tmuxWindowKey][]tmuxPaneProc {
	type paneKey struct {
		w     tmuxWindowKey
		index int
	}
	seen := map[paneKey]int{}
	var order []paneKey
	procs := map[paneKey]tmuxPaneProc{}
	field := func(b []byte) (string, []byte, bool) {
		i := bytes.IndexByte(b, ':')
		if i < 0 || i > 16 {
			return "", nil, false
		}
		return string(b[:i]), b[i+1:], true
	}
	sized := func(b []byte) (string, []byte, bool) {
		n, rest, ok := field(b)
		size, err := strconv.Atoi(n)
		if !ok || err != nil || size < 0 || size > len(rest) || !tmuxIndexRe.MatchString(n) {
			return "", nil, false
		}
		return string(rest[:size]), rest[size:], true
	}
	// broken is the window of the entry that could not be read: the one it
	// names, else (its window unreadable) the last one read, to be safe.
	var broken *tmuxWindowKey
	complete := false
	for b := out; ; {
		if len(b) == 0 {
			complete = true
			break
		}
		var sid, win, idx, active, cmd, path string
		var ok bool
		if sid, b, ok = field(b); !ok || !tmuxSessionIDRe.MatchString(sid) {
			break
		}
		if win, b, ok = field(b); !ok || !tmuxIndexRe.MatchString(win) {
			break
		}
		broken = &tmuxWindowKey{sid, win}
		if idx, b, ok = field(b); !ok || !tmuxIndexRe.MatchString(idx) {
			break
		}
		if active, b, ok = field(b); !ok || (active != "0" && active != "1") {
			break
		}
		if cmd, b, ok = sized(b); !ok {
			break
		}
		if path, b, ok = sized(b); !ok {
			break
		}
		b = bytes.TrimPrefix(b, []byte("\r"))
		if len(b) > 0 {
			if b[0] != '\n' {
				break
			}
			b = b[1:]
		}
		n, _ := strconv.Atoi(idx)
		k := paneKey{tmuxWindowKey{sid, win}, n}
		if seen[k]++; seen[k] == 1 {
			order = append(order, k)
		}
		if name := processName(cmd); name != "" {
			procs[k] = tmuxPaneProc{index: n, active: active == "1", proc: ProcessInfo{Name: name, Cwd: processCwd(path)}}
		}
	}
	windows := map[tmuxWindowKey][]tmuxPaneProc{}
	for _, k := range order {
		if p, ok := procs[k]; ok && seen[k] == 1 {
			windows[k.w] = append(windows[k.w], p)
		}
	}
	if broken != nil && !complete {
		delete(windows, *broken)
	}
	for _, panes := range windows {
		sort.Slice(panes, func(i, j int) bool { return panes[i].index < panes[j].index })
	}
	return windows
}

const (
	// tmuxProcKeep is how long a window's last processes stand in for a
	// reply that lacks them (psmux sometimes prints nothing with exit 0).
	tmuxProcKeep = 10 * time.Second
	// tmuxProcLogEvery spaces out the log line of a failing list-panes.
	tmuxProcLogEvery = time.Minute
)

// tmuxProcs is the last processes read per window, and when.
var tmuxProcs struct {
	sync.Mutex
	windows map[tmuxWindowKey]tmuxProcWindow
	logged  time.Time
}

type tmuxProcWindow struct {
	panes []tmuxPaneProc
	at    time.Time
}

// tmuxPaneProcesses lists every pane's process. A window missing from the
// reply keeps what was read for it in the last tmuxProcKeep, so names do not
// blink between polls; a failure never fails the snapshot.
func tmuxPaneProcesses(ctx context.Context) map[tmuxWindowKey][]tmuxPaneProc {
	args := []string{"list-panes", "-a", "-F", tmuxPaneFormat}
	// Without a UTF-8 locale (a service, env -i) tmux prints each multibyte
	// character as '_', and the lengths no longer match; -u makes it send
	// UTF-8 whatever the locale. psmux (Windows) is not known to take it.
	if !tmuxIsPsmux {
		args = append([]string{"-u"}, args...)
	}
	out, err := tmuxCmd(ctx, args...).Output()
	var got map[tmuxWindowKey][]tmuxPaneProc
	if err == nil {
		got = parseTmuxPanes(out)
	}
	now := time.Now()
	tmuxProcs.Lock()
	defer tmuxProcs.Unlock()
	if err != nil && now.Sub(tmuxProcs.logged) >= tmuxProcLogEvery {
		tmuxProcs.logged = now
		log.Printf("tmux list-panes: %v", err)
	}
	if tmuxProcs.windows == nil {
		tmuxProcs.windows = map[tmuxWindowKey]tmuxProcWindow{}
	}
	for k, w := range tmuxProcs.windows {
		if now.Sub(w.at) >= tmuxProcKeep {
			delete(tmuxProcs.windows, k)
		}
	}
	for k, panes := range got {
		tmuxProcs.windows[k] = tmuxProcWindow{panes: panes, at: now}
	}
	all := make(map[tmuxWindowKey][]tmuxPaneProc, len(tmuxProcs.windows))
	for k, w := range tmuxProcs.windows {
		all[k] = w.panes
	}
	return all
}

// attachTmuxProcesses gives each tab's pane (the window's active one) its
// process, and the tab every pane's, in pane order.
func attachTmuxProcesses(groups []tmuxGroup, windows map[tmuxWindowKey][]tmuxPaneProc) {
	for gi := range groups {
		g := &groups[gi]
		for ti := range g.Tabs {
			panes := windows[tmuxWindowKey{g.sessionID, g.windowIdx[ti]}]
			if len(panes) == 0 {
				continue
			}
			tab := &g.Tabs[ti]
			tab.Processes = make([]ProcessInfo, len(panes))
			for i, p := range panes {
				tab.Processes[i] = p.proc
				if p.active {
					tab.Panes[0].Process = &p.proc
				}
			}
		}
	}
}

// SelectTab switches its session's current window, so every client attached
// to that session follows.
func (tmuxMux) SelectTab(ctx context.Context, tabID string) error {
	w, ok := parseTmuxID(tabID)
	if !ok {
		return inputError("invalid tab id")
	}
	// psmux answers select-window on a missing window with exit 0, so Attach
	// would show the session's current window instead: ask for it first.
	if tmuxIsPsmux {
		out, err := tmuxCmd(ctx, "display-message", "-p", "-t", w.target(),
			"#{session_id}:#{window_index}:#{session_name}").Output()
		parts := strings.SplitN(strings.TrimRight(string(out), "\r\n"), ":", 3)
		if err != nil || len(parts) != 3 || !w.matches(parts[0], parts[2], parts[1]) {
			return inputError("unknown tab")
		}
	}
	return tmuxCmd(ctx, "select-window", "-t", w.target()).Run()
}

// NewTab opens a window in a group: the default session when groupID is
// empty.
func (tmuxMux) NewTab(ctx context.Context, groupID, name string) (string, error) {
	session, ok := parseTmuxGroupID(groupID)
	if !ok {
		return "", inputError("unknown group")
	}
	isDefault := session == defaultSessionTarget()
	// The ':' makes the target a session: without it tmux first looks for a
	// window of that name in the current session.
	args := []string{"new-window", "-t", session + ":", "-P", "-F",
		"#{session_id}:#{window_index}:#{session_name}"}
	if name != "" {
		if !validTmuxName(name) {
			return "", inputError("invalid tab name")
		}
		args = append(args, "-n", tmuxLiteral(name))
	}
	out, err := tmuxCmd(ctx, args...).Output()
	// A client may create a tab before anything asked for a snapshot (a
	// script right after install): create the session and retry, as Snapshot
	// does. Only on failure, since every psmux call costs ~100ms.
	if err != nil && isDefault && ensureSession(ctx) {
		out, err = tmuxCmd(ctx, args...).Output()
	}
	if err != nil {
		if !isDefault && tmuxMissing(err) {
			return "", inputError("unknown group")
		}
		return "", err
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), ":", 3)
	if len(parts) != 3 || !tmuxIndexRe.MatchString(parts[1]) || (!isDefault && parts[0] != session) {
		return "", fmt.Errorf("new-window printed %q", out)
	}
	// "$N" may name the default session too; its tabs keep bare ids.
	return formatTmuxID(parts[0], parts[2] == tmuxSession, parts[1]), nil
}

// tmuxMissing reports whether a tmux command failed because its target
// session or window does not exist.
func tmuxMissing(err error) bool {
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		return false
	}
	msg := string(ee.Stderr)
	return strings.Contains(msg, "can't find session") || strings.Contains(msg, "can't find window")
}

func (tmuxMux) CloseTab(ctx context.Context, tabID string) error {
	w, ok := parseTmuxID(tabID)
	if !ok {
		return inputError("invalid tab id")
	}
	return tmuxCmd(ctx, "kill-window", "-t", w.target()).Run()
}

func (tmuxMux) RenameTab(ctx context.Context, tabID, name string) error {
	w, ok := parseTmuxID(tabID)
	if !ok {
		return inputError("invalid tab id")
	}
	if name == "" {
		return inputError("name is required")
	}
	if !validTmuxName(name) {
		return inputError("invalid tab name")
	}
	return tmuxCmd(ctx, "rename-window", "-t", w.target(), tmuxLiteral(name)).Run()
}

// validTmuxGroupName accepts the name of a new session: a valid name with
// none of the characters tmux reads in a target (":", ".", a pattern's "*?["),
// not starting with "=" (an exact-name target), and no "\", which tmux stores
// escaped ("\\"), so the session would not get the name asked for. Sessions
// that exist are addressed by id, so this binds only names Termote gives.
func validTmuxGroupName(name string) bool {
	return validTmuxName(name) && !strings.ContainsAny(name, ":.*?[\\") &&
		!strings.HasPrefix(name, "=") && !(tmuxIsPsmux && strings.Contains(name, "#"))
}

// tmuxSessionInfo is one line of list-sessions.
type tmuxSessionInfo struct{ id, name string }

// listTmuxSessions lists every session by id and exact name.
func listTmuxSessions(ctx context.Context) ([]tmuxSessionInfo, error) {
	out, err := tmuxCmd(ctx, "list-sessions", "-F", "#{session_id}:#{session_name}").Output()
	if err != nil {
		return nil, err
	}
	var list []tmuxSessionInfo
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		id, name, ok := strings.Cut(strings.TrimRight(line, "\r"), ":")
		if ok && tmuxSessionIDRe.MatchString(id) {
			list = append(list, tmuxSessionInfo{id, name})
		}
	}
	return list, nil
}

// findTmuxGroup returns the session a group id names, compared exactly: by
// name for the default session, by id for any other; and every session.
func findTmuxGroup(ctx context.Context, groupID string) (tmuxSessionInfo, []tmuxSessionInfo, error) {
	if groupID == "" {
		return tmuxSessionInfo{}, nil, errInvalidGroupID
	}
	if _, ok := parseTmuxGroupID(groupID); !ok {
		return tmuxSessionInfo{}, nil, errInvalidGroupID
	}
	list, err := listTmuxSessions(ctx)
	if err != nil {
		return tmuxSessionInfo{}, nil, err
	}
	for _, s := range list {
		if groupID == tmuxSession && s.name == tmuxSession || s.id == groupID {
			return s, list, nil
		}
	}
	return tmuxSessionInfo{}, nil, errUnknownGroup
}

// tmuxRun runs a group command, telling a missing session (gone between the
// check and the command) and a taken name from other failures.
func tmuxRun(ctx context.Context, args ...string) error {
	_, err := tmuxCmd(ctx, args...).Output()
	var ee *exec.ExitError
	switch {
	case err == nil:
		return nil
	case tmuxMissing(err):
		return errUnknownGroup
	case errors.As(err, &ee) && strings.Contains(string(ee.Stderr), "duplicate session"):
		return errGroupExists
	}
	return err
}

// NewGroup starts a detached session named name in cwd and returns its id.
// Both go through tmuxLiteral, and the session's name and start directory are
// read back: a tmux that expanded either anyway loses the session again.
func (tmuxMux) NewGroup(ctx context.Context, name, cwd string) (string, error) {
	if !validTmuxGroupName(name) {
		return "", errInvalidGroupName
	}
	if tmuxIsPsmux && strings.Contains(cwd, "#") {
		return "", errInvalidCwd
	}
	list, err := listTmuxSessions(ctx)
	if err != nil && !tmuxNoServer(err) {
		return "", err
	}
	for _, s := range list {
		if s.name == name {
			return "", errGroupExists
		}
	}
	args := []string{"new-session", "-d", "-s", tmuxLiteral(name), "-P", "-F", "#{session_id}"}
	if cwd != "" {
		args = append(args, "-c", tmuxLiteral(cwd))
	}
	cmd := tmuxCmd(ctx, args...)
	cmd.Env = terminalEnv()
	out, err := cmd.Output()
	var ee *exec.ExitError
	if errors.As(err, &ee) && strings.Contains(string(ee.Stderr), "duplicate session") {
		return "", errGroupExists
	}
	if err != nil {
		return "", err
	}
	sid := strings.TrimSpace(string(out))
	if !tmuxSessionIDRe.MatchString(sid) {
		return "", fmt.Errorf("new-session printed %q", out)
	}
	got, err := tmuxCmd(ctx, "display-message", "-p", "-t", sid, "#{session_id}:#{session_path}").Output()
	gotID, gotPath, _ := strings.Cut(strings.TrimRight(string(got), "\r\n"), ":")
	gotName := ""
	if list, lerr := listTmuxSessions(ctx); lerr == nil {
		for _, s := range list {
			if s.id == sid {
				gotName = s.name
			}
		}
	}
	if err != nil || gotID != sid || gotName != name || cwd != "" && gotPath != cwd {
		tmuxCmd(context.WithoutCancel(ctx), "kill-session", "-t", sid).Run()
		return "", fmt.Errorf("new session %s came out as %q in %q, want %q in %q", sid, gotName, gotPath, name, cwd)
	}
	return sid, nil
}

// tmuxNoServer reports whether a command failed because no tmux server is
// running yet (the first session starts it).
func tmuxNoServer(err error) bool {
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		return false
	}
	msg := string(ee.Stderr)
	return strings.Contains(msg, "no server running") || strings.Contains(msg, "error connecting to")
}

// CloseGroup ends a session and everything running in it. The default one
// may be closed too: the next snapshot starts it again, empty.
func (tmuxMux) CloseGroup(ctx context.Context, groupID string) error {
	s, _, err := findTmuxGroup(ctx, groupID)
	if err != nil {
		return err
	}
	return tmuxRun(ctx, "kill-session", "-t", s.id)
}

// RenameGroup renames a session other than the default one: renaming that
// would make the next snapshot start a new, empty one under its name.
func (tmuxMux) RenameGroup(ctx context.Context, groupID, name string) error {
	s, list, err := findTmuxGroup(ctx, groupID)
	if err != nil {
		return err
	}
	if s.name == tmuxSession {
		return errDefaultSession
	}
	if !validTmuxGroupName(name) {
		return errInvalidGroupName
	}
	if s.name == name {
		return nil
	}
	for _, o := range list {
		if o.name == name {
			return errGroupExists
		}
	}
	return tmuxRun(ctx, "rename-session", "-t", s.id, tmuxLiteral(name))
}

// ClosePane is not offered: a tab here is one window shown as one pane, and
// it is closed as a tab.
func (tmuxMux) ClosePane(context.Context, string) error { return errUnsupported }

// Scroll is not offered: tmux history is scrolled in copy mode.
func (tmuxMux) Scroll(context.Context, string, int) error { return errUnsupported }

// SendKeys passes keys as one tmux send-keys argument, so key names such as
// "Enter" or "C-c" are interpreted by tmux.
func (tmuxMux) SendKeys(ctx context.Context, paneID, keys string) error {
	w, ok := parseTmuxID(paneID)
	if !ok {
		return inputError("invalid pane id")
	}
	if strings.HasPrefix(keys, "-") {
		return inputError("keys must not start with '-'")
	}
	return tmuxCmd(ctx, "send-keys", "-t", w.target(), keys).Run()
}

// Attach makes paneID its session's current window, then attaches a new tmux
// client to that session. Every client of a session shares its current window
// and the window follows the most recently active client's size.
func (m tmuxMux) Attach(ctx context.Context, paneID string, size Size) (TermStream, error) {
	if err := m.SelectTab(ctx, paneID); err != nil {
		return nil, err
	}
	w, _ := parseTmuxID(paneID)
	return startTerminal(tmuxAttachArgv(w.session), size)
}

// agentLookupWait bounds how long a snapshot waits for agent lookups, which
// read files in each agent's config dir (possibly a network mount).
const agentLookupWait = 300 * time.Millisecond

type agentPane struct {
	group, tab      int
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
// target that does not exist with the current window (or nothing) instead of
// an error, so the session and window index in the reply must be the ones
// asked for.
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
	w, ok := parseTmuxID(paneID)
	if !ok {
		return AgentSession{}, false, inputError("invalid pane id")
	}
	out, err := tmuxCmd(ctx, "display-message", "-p", "-t", w.target(),
		"#{session_id}:#{window_index}:#{pane_in_mode}:#{pane_id}:#{pane_pid}:#{session_name}").Output()
	parts := strings.SplitN(strings.TrimRight(string(out), "\r\n"), ":", 6)
	if err != nil || len(parts) != 6 || !w.matches(parts[0], parts[5], parts[1]) {
		return AgentSession{}, false, inputError("unknown pane")
	}
	s, ok := tmuxPaneAgentWith(parts[3], parts[4], find)
	s.InMode = parts[2] == "1"
	if ok {
		s.Target = agentTarget(parts[0], parts[1], s.Target)
	}
	return s, ok, nil
}

// PaneDir reports the working directory of a window's active pane. As in
// tmuxAgentSession, the session and window index in the reply must be the
// ones asked for: tmux would otherwise answer with another window. The path
// goes last so a ':' in it is kept; a session name has none (tmux turns it
// into '_'). The pane id it returns keys the root's state, so it must be
// unique on the server: never on psmux, which has no Files (and no
// directory to report).
func (tmuxMux) PaneDir(ctx context.Context, paneID string) (string, string, error) {
	if !tmuxFilesSupported {
		return "", "", errUnsupported
	}
	w, ok := parseTmuxID(paneID)
	if !ok {
		return "", "", inputError("invalid pane id")
	}
	out, err := tmuxCmd(ctx, "display-message", "-p", "-t", w.target(),
		"#{session_id}:#{window_index}:#{pane_id}:#{session_name}:#{pane_current_path}").Output()
	parts := strings.SplitN(strings.TrimRight(string(out), "\r\n"), ":", 5)
	if err != nil || len(parts) != 5 || !w.matches(parts[0], parts[3], parts[1]) ||
		!tmuxPaneIDRe.MatchString(parts[2]) {
		return "", "", inputError("unknown pane")
	}
	if parts[4] == "" || strings.HasPrefix(parts[4], "#{") {
		return "", "", errUnsupported
	}
	return parts[4], parts[2], nil
}

// Capture returns the pane's visible screen with its SGR attributes.
func (tmuxMux) Capture(ctx context.Context, target string) (string, error) {
	if !validAgentTarget(target) {
		return "", inputError("invalid pane")
	}
	out, err := tmuxCmd(ctx, "capture-pane", "-p", "-e", "-t", target).Output()
	return string(out), err
}

// Paste loads text into a buffer of its own name and pastes it bracketed
// (-p), deleting the buffer (-d): the user's own buffers, and a concurrent
// paste, are never touched.
func (tmuxMux) Paste(ctx context.Context, target, text string) error {
	if !validAgentTarget(target) {
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
	if !validAgentTarget(target) || !validAgentKeys(keys) {
		return inputError("invalid keys")
	}
	return tmuxCmd(ctx, append([]string{"send-keys", "-t", target}, keys...)...).Run()
}

// Health reports ok without touching tmux: the PWA creates the
// first window itself when the session is empty.
func (tmuxMux) Health(context.Context) error { return nil }
