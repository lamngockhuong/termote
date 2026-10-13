package main

import (
	"bytes"
	"context"
	"strconv"
)

// The Chat view and the Files/Changes views of a Zellij pane. The agent is
// found under the pane's shell (zellij_pane_pid.go), as under a tmux pane's;
// what is typed goes through a Termote client, never through argv.

// zellijAgentPane places one snapshot pane for the agent lookup.
type zellijAgentPane struct {
	group, tab, pane int
	session          string
	n                int
}

// fillAgents sets each pane's agent. The shells are found first (one server
// lookup per session, cached), then lookupAgentsWith walks each shell's
// process tree within agentLookupWait.
func (m *zellijMux) fillAgents(ctx context.Context, groups []Group, panes []zellijAgentPane) {
	lookups := make([]agentPane, 0, len(panes))
	placed := make([]zellijAgentPane, 0, len(panes))
	children, err := procTables.do("", procChildrenFunc)
	if err != nil {
		return
	}
	for _, p := range panes {
		pid, ok := zellijPaneShellIn(p.session, p.n, false, children)
		if !ok {
			continue
		}
		lookups = append(lookups, agentPane{group: p.group, tab: p.tab,
			paneID: zellijPaneKey(p.session, p.n), panePID: strconv.Itoa(pid)})
		placed = append(placed, p)
	}
	if len(lookups) == 0 {
		return
	}
	found := lookupAgentsWith(ctx, lookups, func(a agentPane) (AgentSession, bool) {
		pid, err := strconv.Atoi(a.panePID)
		if err != nil {
			return AgentSession{}, false
		}
		return findClaudeSession(a.paneID, pid)
	})
	for i, a := range found {
		if a != nil {
			p := placed[i]
			groups[p.group].Tabs[p.tab].Panes[p.pane].Agent = a
		}
	}
}

// PaneDir reports a pane's working directory, as Zellij lists it. The key
// is the pane's own (group id and terminal_N), never a lookup's guess.
func (m *zellijMux) PaneDir(ctx context.Context, paneID string) (string, string, error) {
	session, n, ok := parseZellijPaneID(paneID)
	if !ok {
		return "", "", inputError("invalid pane id")
	}
	p, err := zellijFindPane(ctx, session, n)
	if err != nil {
		return "", "", err
	}
	if p.Cwd == "" {
		return "", "", errUnsupported
	}
	return p.Cwd, zellijPaneKey(session, n), nil
}

func (m *zellijMux) AgentSession(ctx context.Context, paneID string) (AgentSession, bool, error) {
	return m.agentSession(ctx, paneID, false)
}

// AgentSessionNow looks the server, the shell and the agent up again,
// without a cache, for the checks right before a write.
func (m *zellijMux) AgentSessionNow(ctx context.Context, paneID string) (AgentSession, bool, error) {
	return m.agentSession(ctx, paneID, true)
}

func (m *zellijMux) agentSession(ctx context.Context, paneID string, fresh bool) (AgentSession, bool, error) {
	session, n, err := m.requirePane(ctx, paneID)
	if err != nil {
		return AgentSession{}, false, err
	}
	pid, ok := zellijPaneShell(session, n, fresh)
	if !ok {
		return AgentSession{}, false, nil
	}
	var s AgentSession
	if fresh {
		s, ok = findClaudeSessionNow(pid)
	} else {
		s, ok = findClaudeSession(zellijPaneKey(session, n), pid)
	}
	s.Target = paneID
	return s, ok, nil
}

// Capture returns the pane's screen with its SGR attributes. It is read
// twice and must match: the screen check before an agent write must never
// stand on another command's output (see zellijGate). A screen changing
// between the reads is read again.
func (m *zellijMux) Capture(ctx context.Context, target string) (string, error) {
	session, n, ok := parseZellijPaneID(target)
	if !ok {
		return "", inputError("invalid pane")
	}
	read := func() ([]byte, error) {
		return zellijQuery(ctx, session, zellijAnyOutput, "dump-screen", "--pane-id", zellijTerminal(n), "--ansi")
	}
	prev, err := read()
	for range 3 {
		if err != nil {
			return "", err
		}
		cur, err2 := read()
		if err2 != nil {
			return "", err2
		}
		if bytes.Equal(cur, prev) {
			return string(cur), nil
		}
		prev = cur
	}
	return "", errZellijBusy
}

// Paste types text as one bracketed paste through a Termote client.
func (m *zellijMux) Paste(ctx context.Context, target, text string) error {
	session, n, err := m.requirePane(ctx, target)
	if err != nil {
		return err
	}
	return m.writeToPane(ctx, session, n, []byte(pasteStart+text+pasteEnd))
}

// SendKeySequence types the keys' bytes through a Termote client.
func (m *zellijMux) SendKeySequence(ctx context.Context, target string, keys []string) error {
	if !validAgentKeys(keys) {
		return inputError("invalid keys")
	}
	session, n, err := m.requirePane(ctx, target)
	if err != nil {
		return err
	}
	var b []byte
	for _, k := range keys {
		b = append(b, agentKeys[k]...)
	}
	return m.writeToPane(ctx, session, n, b)
}
