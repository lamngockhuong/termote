package main

// Telling the agent a job was given to from another one at the same pane
// address. A pane's activity key (tmux %N or @N, a psmux index, a Herdr or
// Zellij id) is unique only while the backend runs: once tmux restarts,
// %3 can name any other pane. The agent process's pid and start time are
// unique on the host, and every backend that restarts starts its agents
// again, so they settle it where the backend finds the process (tmux,
// psmux, Zellij, herdr-core); where it does not (PID 0, as Herdr's own
// agent records), the agent's session id stands in, so an agent that
// starts another conversation there reads as gone: never as the same.

// jobAgentOf records the agent session s runs in pane p.
func jobAgentOf(p snapPane, s AgentSession) jobAgent {
	return jobAgent{Key: p.key(), PaneID: p.pane.ID, Kind: s.Agent, GroupID: p.group.ID, Ref: p.ref(),
		PID: s.PID, Start: s.ProcStart, Session: s.ID}
}

// matches reports whether session s, running in pane p now, is the agent
// a recorded.
func (a jobAgent) matches(p snapPane, s AgentSession) bool {
	if a.Key != p.key() || a.Kind == "" || a.Kind != s.Agent {
		return false
	}
	if a.PID != 0 || s.PID != 0 {
		return a.PID == s.PID && a.Start != "" && a.Start == s.ProcStart
	}
	return a.Session != "" && a.Session == s.ID
}

// findJobPane is the pane of snap whose activity key is key and that runs
// an agent.
func findJobPane(snap Snapshot, key string) (snapPane, bool) {
	for _, p := range snapshotPanes(snap) {
		if p.key() == key && p.pane.Agent != nil {
			return p, true
		}
	}
	return snapPane{}, false
}
