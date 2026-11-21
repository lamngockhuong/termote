package main

import (
	"context"
	"errors"
	"strings"
	"time"
)

// shellStarter starts an agent on a backend without Herdr's agent.start
// (tmux, Zellij, herdr-core): it types the agent's command line into the
// pane's shell, as resumeHere types a resume line, and follows the start by
// pane id from what the Chat view already reads (the agent process under the
// pane's shell, its session file or rollout). There is no alias: the name it
// returns only tells this server's starts apart.
type shellStarter struct {
	tm taskMux
	wr agentWriter
}

// shellStarterOf is m's shellStarter when it runs tasks (not psmux) and can
// find an agent under a pane's shell.
func shellStarterOf(m Mux) (shellStarter, bool) {
	tm, ok := m.(taskMux)
	if !ok || isPsmux(m) {
		return shellStarter{}, false
	}
	wr, ok := m.(agentWriter)
	return shellStarter{tm: tm, wr: wr}, ok
}

// canShellStart is what the Caps of a backend with a shellStarter offer: a
// start where the agent is found under a pane's shell (agentProcSupported),
// Codex too where it has a Chat view.
func canShellStart() (start, codex bool) {
	return agentProcSupported, agentProcSupported && agentStartKind("codex")
}

// requirePane checks that the pane exists through its shell.
func (s shellStarter) requirePane(ctx context.Context, id string) (Size, error) {
	_, _, _, err := s.tm.IdleShell(ctx, id)
	if errors.Is(err, errTaskTargetGone) {
		return Size{}, errStartNotFound
	}
	return Size{}, err
}

// StartAgent waits for a shell still starting, clears the input line with
// C-c (half-typed text, a continuation prompt, a heredoc or a read would
// otherwise take the command), checks the shell again and types the
// command line, its arguments quoted for the shell. Nothing is typed into a
// busy pane or a shell whose quoting is not known.
func (s shellStarter) StartAgent(ctx context.Context, paneID, kind string, args []string) (string, error) {
	// A shell whose quoting is not known gets nothing, not even the C-c.
	shell, err := s.waitIdle(ctx, paneID)
	if err != nil {
		return "", err
	}
	if resumeShellKind(shell) == "" {
		return "", errTaskShell
	}
	if err := callStep(ctx, func(ctx context.Context) error { return s.tm.Interrupt(ctx, paneID) }); err != nil {
		return "", startStepError(err)
	}
	if err := taskSleep(ctx, agentStartClearWait); err != nil {
		return "", err
	}
	if shell, err = s.waitIdle(ctx, paneID); err != nil {
		return "", err
	}
	sh := resumeShellKind(shell)
	if sh == "" {
		return "", errTaskShell
	}
	line := agentStartLine(sh, kind, args)
	name := agentStartName(kind)
	err = callStep(ctx, func(ctx context.Context) error { return s.tm.TypeLine(ctx, paneID, line) })
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return name, errStartUnknown // part of the line may have been typed
	}
	return name, startStepError(err)
}

// agentStartLine is the command line that starts kind: its program, then
// each argument quoted for the shell (the server's own, never a client's).
func agentStartLine(shell, kind string, args []string) string {
	words := []string{kind}
	for _, a := range args {
		words = append(words, shellQuote(shell, a))
	}
	return strings.Join(words, " ")
}

// waitIdle reads the pane's shell, again every agentStartIdlePoll for up to
// agentStartIdleWait while it is busy; errStartPaneBusy when it stays so.
func (s shellStarter) waitIdle(ctx context.Context, paneID string) (string, error) {
	deadline := time.Now().Add(agentStartIdleWait)
	for {
		var shell string
		var idle bool
		err := callStep(ctx, func(ctx context.Context) (err error) {
			shell, _, idle, err = s.tm.IdleShell(ctx, paneID)
			return err
		})
		switch {
		case err != nil:
			return "", startStepError(err)
		case idle:
			return shell, nil
		case !time.Now().Add(agentStartIdlePoll).Before(deadline):
			return "", errStartPaneBusy
		}
		if err := taskSleep(ctx, agentStartIdlePoll); err != nil {
			return "", err
		}
	}
}

// startStepError maps a gone pane to not_found.
func startStepError(err error) error {
	if errors.Is(err, errTaskTargetGone) {
		return errStartNotFound
	}
	return err
}

// shellStartProc names the agent running in the foreground under rootPID, a
// fresh walk: Codex has no session to read before its first message, and
// Claude Code none before it writes its session file. Tests replace it.
var shellStartProc = func(rootPID int) (string, bool) {
	if rootPID <= 0 || !agentProcSupported {
		return "", false
	}
	children, err := procChildrenFunc()
	if err != nil {
		return "", false
	}
	p, ok := walkForClaude(rootPID, children)
	if !ok || !procForeground(p.pid) {
		return "", false
	}
	return p.agent, true
}

// AgentStartState reads the pane as it is now: the agent started is ready
// once its process runs there in the foreground, blocked when its status
// says so; the pane showing only its shell again agentStartSettle after the
// line was typed, with no agent seen, or another agent there, is exited.
// Each read gets its own agentStartCallTimeout.
func (s shellStarter) AgentStartState(ctx context.Context, paneID, _, kind string, elapsed time.Duration) (string, error) {
	var sess AgentSession
	var found bool
	err := callStep(ctx, func(ctx context.Context) (err error) {
		sess, found, err = s.wr.AgentSessionNow(ctx, paneID)
		return err
	})
	if paneMissing(err) || errors.Is(err, errTaskTargetGone) {
		return startExited, nil
	}
	if err != nil {
		return "", err
	}
	switch {
	case found && sess.Agent != kind:
		return startExited, nil
	case found && sess.Status == "blocked":
		return startBlocked, nil
	case found:
		return startReady, nil
	}
	var pid int
	var idle bool
	err = callStep(ctx, func(ctx context.Context) (err error) {
		_, pid, idle, err = s.tm.IdleShell(ctx, paneID)
		return err
	})
	if paneMissing(err) || errors.Is(err, errTaskTargetGone) {
		return startExited, nil
	}
	if err != nil {
		return "", err
	}
	if agent, ok := shellStartProc(pid); ok {
		if agent != kind {
			return startExited, nil
		}
		return startReady, nil
	}
	if idle && elapsed >= agentStartSettle {
		return startExited, nil
	}
	return startStarting, nil
}

// callStep runs one backend call of a start with its own timeout. A call
// cut short reports the context's error, whatever the backend made of it (a
// killed tmux is an exit error).
func callStep(ctx context.Context, call func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(ctx, agentStartCallTimeout)
	defer cancel()
	err := call(ctx)
	if err != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
