package main

import (
	"context"
	"log"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A terminal client of the backend's own (a desktop terminal attached to
// tmux or Zellij) counts as looking at the panes it shows, for the activity
// tracker's unseen turns, when its user was active there lately. Termote's
// own clients (its streams) never count: a stream counts only while the PWA
// shows its pane (activityWatch).

// nativeViewerIdle is how long after its last key a tmux client still counts
// as a viewer: a desktop terminal left open does not swallow every turn.
const nativeViewerIdle = 5 * time.Minute

// ownTerminals holds the pids of the terminal processes Termote runs (a
// stream's `tmux attach` is one), so list-clients can leave them out.
var ownTerminals = struct {
	sync.Mutex
	pids map[int]int
}{pids: map[int]int{}}

func addOwnTerminal(pid int) {
	ownTerminals.Lock()
	defer ownTerminals.Unlock()
	ownTerminals.pids[pid]++
}

func removeOwnTerminal(pid int) {
	ownTerminals.Lock()
	defer ownTerminals.Unlock()
	if ownTerminals.pids[pid]--; ownTerminals.pids[pid] <= 0 {
		delete(ownTerminals.pids, pid)
	}
}

func isOwnTerminal(pid int) bool {
	ownTerminals.Lock()
	defer ownTerminals.Unlock()
	return ownTerminals.pids[pid] > 0
}

// tmuxClientsFormat is one client a line: its pid, its last activity (Unix
// seconds) and the window it shows.
const tmuxClientsFormat = "#{client_pid}:#{client_activity}:#{window_id}"

// tmuxViewedWindows parses list-clients (tmuxClientsFormat): the windows a
// client that is not Termote's shows, active within nativeViewerIdle of now.
// A line that does not parse is skipped.
func tmuxViewedWindows(out string, now time.Time, own func(int) bool) map[string]bool {
	windows := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(strings.TrimRight(line, "\r"), ":")
		if len(f) != 3 || !tmuxWindowIDRe.MatchString(f[2]) {
			continue
		}
		pid, err := strconv.Atoi(f[0])
		if err != nil || own(pid) {
			continue
		}
		at, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil || now.Sub(time.Unix(at, 0)) > nativeViewerIdle {
			continue
		}
		windows[f[2]] = true
	}
	return windows
}

// tmuxNativeViewers is the panes (by paneKey) that a tmux client of the
// user's shows, by the windows it has current: every pane of such a tab.
// psmux is left out (its list-clients and ConPTY pids are unchecked), and a
// failed list-clients is logged and counts no one.
func tmuxNativeViewers(ctx context.Context, groups []Group, now time.Time) map[string]bool {
	if tmuxIsPsmux {
		return nil
	}
	out, err := tmuxCmd(ctx, "list-clients", "-F", tmuxClientsFormat).Output()
	if err != nil {
		log.Printf("tmux list-clients: %v", err)
		return nil
	}
	return panesOfWindows(groups, tmuxViewedWindows(string(out), now, isOwnTerminal))
}

// panesOfWindows is every pane key of the tabs whose key (a tmux window id)
// is in windows; nil when none.
func panesOfWindows(groups []Group, windows map[string]bool) map[string]bool {
	if len(windows) == 0 {
		return nil
	}
	viewers := map[string]bool{}
	for _, g := range groups {
		for _, tab := range g.Tabs {
			if !windows[tab.Key] {
				continue
			}
			for _, p := range tab.Panes {
				viewers[paneKey(p)] = true
			}
		}
	}
	return viewers
}

// panesOfTabsShowing is every pane key of the tabs that hold a pane in
// shown: a Zellij client shows its whole tab, the pane with focus and the
// others beside it; nil when none.
func panesOfTabsShowing(groups []Group, shown map[string]bool) map[string]bool {
	if len(shown) == 0 {
		return nil
	}
	viewers := map[string]bool{}
	for _, g := range groups {
		for _, tab := range g.Tabs {
			if !slices.ContainsFunc(tab.Panes, func(p Pane) bool { return shown[paneKey(p)] }) {
				continue
			}
			for _, p := range tab.Panes {
				viewers[paneKey(p)] = true
			}
		}
	}
	return viewers
}

// zellijNativeViewers adds to viewers the pane with focus of each client of
// session that is not Termote's (clients: list-clients, id to pane);
// panesOfTabsShowing widens it to its tab. Zellij reports no activity, so
// every such client counts.
func zellijNativeViewers(viewers map[string]bool, session string, clients map[string]string, own map[string]bool) {
	for id, pane := range clients {
		n, ok := strings.CutPrefix(pane, "terminal_")
		if !ok || own[id] {
			continue
		}
		if i, err := strconv.Atoi(n); err == nil {
			viewers[zellijPaneKey(session, i)] = true
		}
	}
}
