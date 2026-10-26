package main

import (
	"context"
	"errors"
	"strings"
)

// NewTaskTab opens a tab in groupID's session whose shell starts in dir,
// without focusing it. A session with no client gets errZellijNoClient.
func (m *zellijMux) NewTaskTab(ctx context.Context, groupID, name, dir string) (taskTab, error) {
	session, ok := parseZellijGroupID(groupID)
	if !ok {
		return taskTab{}, inputError("invalid group id")
	}
	if !validZellijTabName(name) {
		name = ""
	}
	id, n, err := m.newTab(ctx, session, name, dir)
	if err != nil {
		return taskTab{}, err
	}
	pane := zellijPaneID(session, n)
	return taskTab{TabID: zellijTabID(session, id), PaneID: pane, Target: pane}, nil
}

// IdleShell finds the pane's shell under the session's server
// (zellijPaneShell, as the Chat view does) and whether it is its terminal's
// foreground process. A shell that cannot be found is not idle.
func (m *zellijMux) IdleShell(ctx context.Context, target string) (string, bool, error) {
	session, n, ok := parseZellijPaneID(target)
	if !ok {
		return "", false, inputError("invalid pane id")
	}
	p, err := zellijFindPane(ctx, session, n)
	var ie inputError
	if errors.As(err, &ie) || err == nil && p.Exited {
		return "", false, errTaskTargetGone
	}
	if err != nil {
		return "", false, err
	}
	pid, ok := zellijPaneShell(session, n, true)
	if !ok {
		return "", false, nil
	}
	return procExeBase(pid), procForeground(pid), nil
}

func (m *zellijMux) Interrupt(ctx context.Context, target string) error {
	session, n, ok := parseZellijPaneID(target)
	if !ok {
		return inputError("invalid pane id")
	}
	return m.writeToPane(ctx, session, n, []byte(agentKeys["C-c"]))
}

// TypeLine types line and a carriage return through a Termote client, as
// SendKeys does (never bracketed as a paste).
func (m *zellijMux) TypeLine(ctx context.Context, target, line string) error {
	session, n, ok := parseZellijPaneID(target)
	if !ok {
		return inputError("invalid pane id")
	}
	return m.writeToPane(ctx, session, n, []byte(line+"\r"))
}

func (m *zellijMux) ReadTaskText(ctx context.Context, target string, lines int) (string, error) {
	var b strings.Builder
	_, err := m.ReadText(ctx, target, lines, &b)
	return b.String(), err
}
