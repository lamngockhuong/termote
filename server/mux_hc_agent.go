package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
)

// The Files, Chat and Tasks views of an hc pane. The core runs on this
// machine (hc connect never reaches another one: remote terminals are not
// shown), so the agent is found under the terminal's own process, as under a
// tmux pane's shell; what is typed goes through an attach, never argv.

// PaneDir is where the pane's foreground program works now, else the folder
// the terminal started in. The key is the terminal's address: an hc address
// is never reused.
func (m *hcMux) PaneDir(ctx context.Context, paneID string) (string, string, error) {
	t, err := m.requirePane(ctx, paneID)
	if err != nil {
		return "", "", err
	}
	dir := processCwd(hcLiveFolder(&t))
	if dir == "" {
		return "", "", errUnsupported
	}
	return dir, paneID, nil
}

func (m *hcMux) AgentSession(ctx context.Context, paneID string) (AgentSession, bool, error) {
	return m.agentSession(ctx, paneID, false)
}

// AgentSessionNow looks the agent up again without a cache, for the checks
// right before a write.
func (m *hcMux) AgentSessionNow(ctx context.Context, paneID string) (AgentSession, bool, error) {
	return m.agentSession(ctx, paneID, true)
}

// agentSession finds Claude Code or Codex under the terminal's program. A
// terminal whose program is gone (lost, waiting for its new shell) has none.
func (m *hcMux) agentSession(ctx context.Context, paneID string, fresh bool) (AgentSession, bool, error) {
	t, err := m.requirePane(ctx, paneID)
	if err != nil {
		return AgentSession{}, false, err
	}
	if t.Pid == nil || *t.Pid <= 0 {
		return AgentSession{}, false, nil
	}
	var s AgentSession
	var ok bool
	if fresh {
		s, ok = findClaudeSessionNow(*t.Pid)
	} else {
		s, ok = findClaudeSession(paneID, *t.Pid)
	}
	s.Target = paneID
	return s, ok, nil
}

// hcCaptureMax bounds what is read of a first paint.
const hcCaptureMax = 4 << 20

// hcPaintEnd marks the end of the screen in a first paint: the core adds
// whether the program wants win32 key events right after it (herdr-core
// viewers.rs paint_state), then the program's 7501 reports.
var hcPaintEnd = []byte("\x1b[?9001")

// Capture returns the pane's screen with its SGR attributes: the first paint
// a new observer gets, which the core makes from its own screen (Ghostty's
// VT formatter: rows with their SGR, between mode and cursor escapes the
// screen reader drops). An observer never types or resizes.
func (m *hcMux) Capture(ctx context.Context, target string) (string, error) {
	t, err := m.requirePane(ctx, target)
	if err != nil {
		return "", err
	}
	conn, err := m.conn(ctx)
	if err != nil {
		return "", err
	}
	size := hcSize(t)
	ch, err := attachHc(ctx, conn, hcAttachParams{Terminal: target, Cols: size.Cols, Rows: size.Rows, Observe: true})
	if err != nil {
		return "", hcError(err)
	}
	defer ch.close()
	var paint []byte
	for {
		f, err := ch.next(ctx)
		if err != nil {
			return "", hcError(err)
		}
		if f.kind != hcKindData {
			continue
		}
		paint = append(paint, f.payload...)
		if i := bytes.Index(paint, hcPaintEnd); i >= 0 {
			return hcScreenOf(paint[:i]), nil
		}
		if len(paint) > hcCaptureMax {
			return "", errors.New("hc capture: first paint too large")
		}
	}
}

// hcScreenOf is the screen part of a first paint: what follows the cursor
// home that starts the rows (after the soft reset, the clear and the tab
// stops).
func hcScreenOf(paint []byte) string {
	s := string(paint)
	if i := strings.LastIndex(s, "\x1b[2J"); i >= 0 {
		s = s[i+len("\x1b[2J"):]
		if j := strings.Index(s, "\x1b[H"); j >= 0 {
			s = s[j+len("\x1b[H"):]
		}
	}
	return s
}

// Paste types text as one bracketed paste, in one input.
func (m *hcMux) Paste(ctx context.Context, target, text string) error {
	if _, err := m.requirePane(ctx, target); err != nil {
		return err
	}
	return m.typeInput(ctx, target, []byte(pasteStart+text+pasteEnd))
}

// SendKeySequence types the keys' bytes in one input.
func (m *hcMux) SendKeySequence(ctx context.Context, target string, keys []string) error {
	if !validAgentKeys(keys) {
		return inputError("invalid keys")
	}
	if _, err := m.requirePane(ctx, target); err != nil {
		return err
	}
	var b []byte
	for _, k := range keys {
		b = append(b, agentKeys[k]...)
	}
	return m.typeInput(ctx, target, b)
}

// NewTaskTab opens a tab in groupID whose shell starts in dir. A tab's name
// is herdr-app's to give.
func (m *hcMux) NewTaskTab(ctx context.Context, groupID, _, dir string) (taskTab, error) {
	g, err := m.group(ctx, groupID)
	if err != nil {
		return taskTab{}, err
	}
	tab := newHcID("tb")
	addr, err := m.run(ctx, g.ID, tab, dir)
	if err != nil {
		return taskTab{}, err
	}
	return taskTab{TabID: tab, PaneID: addr, Target: addr}, nil
}

// IdleShell names the terminal's shell, its process id and whether it is the
// foreground program (the core reports the foreground process group's
// leader). The pid is known busy or not, so a tab whose shell never came
// back idle is still the task's next one.
func (m *hcMux) IdleShell(ctx context.Context, target string) (string, int, bool, error) {
	t, err := m.requirePane(ctx, target)
	if paneMissing(err) {
		return "", 0, false, errTaskTargetGone
	}
	if err != nil {
		return "", 0, false, err
	}
	if t.Pid == nil || *t.Pid <= 0 {
		return "", 0, false, nil
	}
	pid := *t.Pid
	shell := procExeBase(pid)
	if shell == "" && t.Foreground != nil {
		shell = t.Foreground.Name
	}
	return shell, pid, t.Foreground != nil && t.Foreground.Pid == pid, nil
}

func (m *hcMux) Interrupt(ctx context.Context, target string) error {
	if _, err := m.requirePane(ctx, target); err != nil {
		return err
	}
	return m.typeInput(ctx, target, []byte(agentKeys["C-c"]))
}

// TypeLine types line and a carriage return as keystrokes.
func (m *hcMux) TypeLine(ctx context.Context, target, line string) error {
	if _, err := m.requirePane(ctx, target); err != nil {
		return err
	}
	return m.typeInput(ctx, target, []byte(line+"\r"))
}

func (m *hcMux) ReadTaskText(ctx context.Context, target string, lines int) (string, error) {
	var b strings.Builder
	_, err := m.ReadText(ctx, target, lines, &b)
	return b.String(), err
}

// The interfaces the routes look for.
var (
	_ Mux                 = (*hcMux)(nil)
	_ viewAttacher        = (*hcMux)(nil)
	_ PaneDirer           = (*hcMux)(nil)
	_ agentSessionLocator = (*hcMux)(nil)
	_ agentWriter         = (*hcMux)(nil)
	_ taskMux             = (*hcMux)(nil)
	_ snapshotPeeker      = (*hcMux)(nil)
	_ sizeReporter        = (*hcStream)(nil)
	_ sizeDriver          = (*hcStream)(nil)
)
