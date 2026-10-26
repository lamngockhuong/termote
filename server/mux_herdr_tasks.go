package main

import (
	"context"
	"errors"
	"strings"
)

// NewTaskTab opens a tab in groupID's workspace whose shell starts in dir
// (tab.create's cwd), without focusing it; its root pane is the target.
func (m *herdrMux) NewTaskTab(ctx context.Context, groupID, name, dir string) (taskTab, error) {
	if !herdrWorkspaceIDRe.MatchString(groupID) {
		return taskTab{}, inputError("invalid group id")
	}
	if err := m.requireGroup(ctx, groupID); err != nil {
		return taskTab{}, err
	}
	params := map[string]any{"focus": false, "workspace_id": groupID, "cwd": dir}
	if validateTmuxTarget(name) {
		params["label"] = name
	}
	var res struct {
		Tab struct {
			ID string `json:"tab_id"`
		} `json:"tab"`
		RootPane struct {
			ID string `json:"pane_id"`
		} `json:"root_pane"`
	}
	err := m.rpc.call(ctx, "tab.create", params, &res)
	m.invalidate()
	if err != nil {
		return taskTab{}, herdrInputError(err)
	}
	if !herdrTabIDRe.MatchString(res.Tab.ID) || !herdrPaneIDRe.MatchString(res.RootPane.ID) {
		return taskTab{}, errors.New("tab.create: no tab or root pane")
	}
	return taskTab{TabID: res.Tab.ID, PaneID: res.RootPane.ID, Target: res.RootPane.ID}, nil
}

// IdleShell reads the pane's foreground processes (pane.process_info): the
// shell alone is idle, and names itself.
func (m *herdrMux) IdleShell(ctx context.Context, target string) (string, bool, error) {
	if !herdrPaneIDRe.MatchString(target) {
		return "", false, inputError("invalid pane id")
	}
	info, err := m.paneProcess(ctx, target)
	var he *herdrError
	if errors.As(err, &he) && strings.HasSuffix(he.Code, "_not_found") {
		return "", false, errTaskTargetGone
	}
	if err != nil {
		return "", false, err
	}
	idle, err := herdrIdle(info)
	if err != nil || !idle {
		return "", false, err
	}
	_, name, _ := info.leader()
	return name, true, nil
}

func (m *herdrMux) Interrupt(ctx context.Context, target string) error {
	if !herdrPaneIDRe.MatchString(target) {
		return inputError("invalid pane id")
	}
	return m.typeInput(ctx, target, agentKeys["C-c"])
}

// TypeLine queues line and a carriage return as one input (pane.send_text
// types, it does not paste).
func (m *herdrMux) TypeLine(ctx context.Context, target, line string) error {
	if !herdrPaneIDRe.MatchString(target) {
		return inputError("invalid pane id")
	}
	return m.typeInput(ctx, target, line+"\r")
}

func (m *herdrMux) ReadTaskText(ctx context.Context, target string, lines int) (string, error) {
	var b strings.Builder
	_, err := m.ReadText(ctx, target, lines, &b)
	return b.String(), err
}
