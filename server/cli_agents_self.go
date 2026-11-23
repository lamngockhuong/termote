package main

import (
	"strconv"
	"strings"
)

// selfPaneID is the pane this command runs in, when its environment says so
// for sure, else "": the orchestrator must never send to its own pane, and
// list --json names it so the agent need not ask. Each backend's variables
// are compared with the snapshot of the server reached, never guessed:
//
//   - Herdr: HERDR_WORKSPACE_ID, HERDR_TAB_ID and HERDR_PANE_ID, all three
//     the ids of one pane of the snapshot.
//   - Zellij: ZELLIJ_SESSION_NAME and ZELLIJ_PANE_ID, the id of a pane of
//     that session in the snapshot.
//   - tmux: TMUX_PANE (with TMUX set) a pane id of the snapshot, whose
//     window id and session name, as the tmux that TMUX names reports them
//     (argv only), are its tab's key and its workspace's name: a pane id
//     alone is a small number another tmux server reuses. Not psmux.
//
// herdr-core is not named: its terminals carry no variable that a CLI can
// compare with the snapshot's addresses.
func (c *cli) selfPaneID(s Snapshot) string {
	panes := snapshotPanes(s)
	var found []snapPane
	switch s.Backend {
	case "herdr":
		ws, tab, pane := c.getenv("HERDR_WORKSPACE_ID"), c.getenv("HERDR_TAB_ID"), c.getenv("HERDR_PANE_ID")
		if ws == "" || tab == "" || pane == "" {
			return ""
		}
		for _, p := range panes {
			if p.pane.ID == pane && p.tab.ID == tab && p.group.ID == ws {
				found = append(found, p)
			}
		}
	case "zellij":
		session := c.getenv("ZELLIJ_SESSION_NAME")
		n, err := strconv.Atoi(c.getenv("ZELLIJ_PANE_ID"))
		if session == "" || err != nil || n < 0 {
			return ""
		}
		id, group := zellijPaneID(session, n), zellijGroupID(session)
		for _, p := range panes {
			if p.pane.ID == id && p.group.ID == group {
				found = append(found, p)
			}
		}
	case "tmux":
		pane := c.getenv("TMUX_PANE")
		if c.goos == "windows" || c.getenv("TMUX") == "" || !tmuxPaneIDRe.MatchString(pane) {
			return ""
		}
		for _, p := range panes {
			if p.pane.ID == pane {
				found = append(found, p)
			}
		}
		if len(found) != 1 || c.run == nil {
			return ""
		}
		out, err := c.run.Output("", nil, "tmux", "display-message", "-p", "-t", pane, "#{window_id}\t#{session_name}")
		if err != nil {
			return ""
		}
		window, session, ok := strings.Cut(strings.TrimRight(string(out), "\r\n"), "\t")
		if !ok || window != found[0].tab.Key || cleanLabel(session) != found[0].group.Name {
			return ""
		}
	}
	if len(found) != 1 {
		return ""
	}
	return found[0].pane.ID
}
