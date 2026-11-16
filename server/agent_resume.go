package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// Reading an old session of the history and resuming it. The transcript of
// a session found by the history is read as the Chat view reads a running
// one. Resuming types a command line the server builds (claude --resume,
// codex resume, opencode --session) into a shell, as Tasks does: the shell
// of a new tab in the pane's group, or the pane's own when it waits at its
// prompt. A session already running in a pane is never opened a second
// time, since two processes appending to one transcript break it; it can be
// forked into a new session instead (claude --resume --fork-session, codex
// fork; OpenCode's service forks it, and the fork is opened).

var (
	errSessionNotFound = &codedError{"session_not_found", "no such session in this pane's directory", http.StatusNotFound}
	errSessionLive     = &codedError{"session_live", "this session is running in another tab", http.StatusConflict}
)

// resumeRequest is the body of POST .../agent/resume.
type resumeRequest struct {
	Agent   string `json:"agent"`
	Session string `json:"session"`
	Where   string `json:"where"` // tab | here
	Fork    bool   `json:"fork"`
}

// registerResumeRoutes adds the routes of an old session.
func (a *agentAPI) registerResumeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/mux/panes/{id}/agent/history/{session}/transcript", a.handleHistoryTranscript)
	mux.HandleFunc("/api/mux/panes/{id}/agent/resume", a.handleResume)
}

// findHistorySession finds session id of agent among root's history: only a
// session the listing would show, so every rule of the scan holds.
func (a *agentAPI) findHistorySession(root, agent, id string) (historySession, bool) {
	for _, s := range a.history.scan(root).sessions {
		if s.Agent == agent && s.ID == id {
			return s, true
		}
	}
	return historySession{}, false
}

// historyAgentSession is what reads s's transcript: the file the scan
// found, through the journal adapter's own checks.
func (a *agentAPI) historyAgentSession(s historySession) AgentSession {
	dirs := a.history.dirs()
	if s.Agent == "opencode" {
		return AgentSession{Agent: "opencode", ID: s.ID}
	}
	if s.Agent == "codex" {
		return AgentSession{Agent: "codex", ID: s.ID, CodexHome: dirs.codex, Rollout: s.path}
	}
	return AgentSession{Agent: "claude", ID: s.ID, ClaudeDir: dirs.claude}
}

func (a *agentAPI) handleHistoryTranscript(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	q := r.URL.Query()
	agent, id := q.Get("agent"), r.PathValue("session")
	if !historySessionID(agent, id) {
		jsonErrorCode(w, "invalid_request", "invalid agent or session", http.StatusBadRequest)
		return
	}
	cursor, before := q.Get("cursor"), q.Get("before")
	if _, ok := decodeCursor(cursor); !ok {
		cursor = ""
	}
	if _, ok := decodeCursor(before); before != "" && !ok {
		a.agentError(w, "history transcript", errInvalidBefore)
		return
	}
	root, ok := a.historyRoot(w, r)
	if !ok {
		return
	}
	s, ok := a.findHistorySession(root.Root, agent, id)
	if !ok {
		writeCoded(w, errSessionNotFound)
		return
	}
	res, err := a.readCached(a.historyAgentSession(s), cursor, before)
	if errors.Is(err, errNoTranscript) || errors.Is(err, errAgentUnsupported) {
		writeCoded(w, errSessionNotFound)
		return
	}
	if err != nil {
		a.agentError(w, "history transcript", err)
		return
	}
	if isViewOnly(r) {
		res = viewTranscript(res)
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonOK(w, res)
}

// liveSessions finds the panes running an agent session now, by agent and
// id, through the cached session lookup of each pane the snapshot shows
// with an agent.
func (a *agentAPI) liveSessions(ctx context.Context) map[string]historyLive {
	live := map[string]historyLive{}
	if a.loc == nil || a.m == nil {
		return live
	}
	snap, err := peekSnapshot(ctx, a.m)
	if err != nil {
		return live
	}
	for _, g := range snap.Groups {
		for _, t := range g.Tabs {
			for _, p := range t.Panes {
				if p.Agent == nil || !historyAgent(p.Agent.Name) {
					continue
				}
				s, err := a.session(p.ID)
				if err != nil || !historySessionID(s.Agent, s.ID) {
					continue
				}
				live[s.Agent+"\x00"+s.ID] = historyLive{TabID: t.ID, PaneID: p.ID}
			}
		}
	}
	return live
}

// markLive sets Live on the sessions running in a pane.
func (a *agentAPI) markLive(ctx context.Context, sessions []historySession) {
	if len(sessions) == 0 {
		return
	}
	live := a.liveSessions(ctx)
	for i := range sessions {
		if l, ok := live[sessions[i].Agent+"\x00"+sessions[i].ID]; ok {
			sessions[i].Live = &l
		}
	}
}

// resumeCommand is the line that resumes s in kind's shell, after a cd to
// dir when it is not "". An OpenCode fork is made by its service before
// (resumeSession), so its line opens the fork as any session.
func resumeCommand(kind, agent, id string, fork bool, dir string) string {
	cmd := "claude --resume " + id
	switch {
	case agent == "opencode":
		cmd = "opencode --session " + id
	case agent == "codex" && fork:
		cmd = "codex fork --no-daemon " + id
	case agent == "codex":
		cmd = "codex resume --no-daemon " + id
	case fork:
		cmd += " --fork-session"
	}
	if dir == "" {
		return cmd
	}
	switch kind {
	case shellFish:
		return "cd " + shellQuote(kind, dir) + "; and " + cmd
	case shellPwsh:
		return "Set-Location -LiteralPath " + shellQuote(kind, dir) + "; " + cmd
	}
	return "cd " + shellQuote(kind, dir) + " && " + cmd
}

// resumeDir is where a session resumes: the directory it ran in when it is
// still a directory inside root, else root.
func resumeDir(root string, s historySession) string {
	if _, ok := inHistoryRoot(root, s.absCwd); ok {
		if real, err := evalSymlinks(filepath.Clean(s.absCwd)); err == nil && validTaskDir(real) {
			if fi, err := os.Stat(real); err == nil && fi.IsDir() {
				if _, ok := inHistoryRoot(root, real); ok {
					return real
				}
			}
		}
	}
	return root
}

func (a *agentAPI) handleResume(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
		return
	}
	var body resumeRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			jsonErrorCode(w, "too_large", "request body too large", http.StatusRequestEntityTooLarge)
		} else {
			jsonErrorCode(w, "invalid_request", "invalid JSON body", http.StatusBadRequest)
		}
		return
	}
	if !historySessionID(body.Agent, body.Session) ||
		(body.Where != "tab" && body.Where != "here") {
		jsonErrorCode(w, "invalid_request", "invalid agent, session or where", http.StatusBadRequest)
		return
	}
	tm, ok := a.m.(taskMux)
	if !ok || !runsTasks(a.m) {
		jsonErrorCode(w, "unsupported", "this backend cannot resume sessions", http.StatusNotImplemented)
		return
	}
	root, ok := a.historyRoot(w, r)
	if !ok {
		return
	}
	s, ok := a.findHistorySession(root.Root, body.Agent, body.Session)
	if !ok {
		writeCoded(w, errSessionNotFound)
		return
	}
	paneID := r.PathValue("id")
	rctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
	live, isLive := a.liveSessions(rctx)[s.Agent+"\x00"+s.ID]
	snap, err := peekSnapshot(rctx, a.m)
	cancel()
	if err != nil {
		muxError(w, a.m, "resume snapshot", err)
		return
	}
	if isLive && !body.Fork {
		jsonCodeBody(w, errSessionLive.status, map[string]string{"error": errSessionLive.msg, "code": errSessionLive.code,
			"tabId": live.TabID, "paneId": live.PaneID})
		return
	}
	g, t, pane, ok := findSnapshotPane(snap, paneID, !a.m.Caps().ClientSideSelect)
	if !ok {
		writeCoded(w, errUnknownPane)
		return
	}
	dir := resumeDir(root.Root, s)
	if !validTaskDir(dir) {
		writeCoded(w, errTaskInvalidRoot)
		return
	}
	// Not cut short by the client leaving: a half-typed line is worse than
	// one it never sees run.
	ctx, cancelRun := context.WithTimeout(context.WithoutCancel(r.Context()), taskNewShellWait+3*agentStartIdleWait+3*muxTimeout)
	defer cancelRun()
	var tab taskTab
	if body.Where == "tab" {
		tab, err = a.resumeInTab(ctx, tm, g.ID, s, body.Fork, dir)
	} else {
		holdForLock(w)
		tab = taskTab{TabID: t.ID, PaneID: pane.ID, Target: pane.ID}
		err = a.resumeHere(ctx, tm, pane.ID, root.Dir, s, body.Fork, dir)
	}
	if err != nil {
		var ce *codedError
		var af *agentFailure
		switch {
		case errors.As(err, &ce):
			writeCoded(w, ce)
		case errors.As(err, &af):
			a.writeFailure(w, err)
		default:
			muxError(w, a.m, "resume", err)
		}
		return
	}
	by, via := auditWho(r)
	auditf("agent-resume", "agent", s.Agent, "session", shortSessionID(s.ID), "where", body.Where, "fork", body.Fork, "by", by, "via", via)
	jsonOK(w, map[string]any{"ok": true, "tabId": tab.TabID, "paneId": tab.PaneID})
}

// resumeTabName is a new tab's name from the session's title, cut short;
// the backend drops a name it cannot take.
func resumeTabName(s historySession) string {
	name := s.Title
	if r := []rune(name); len(r) > 32 {
		name = string(r[:32])
	}
	if name == "" || !validPaneName(name) {
		return s.Agent + ":" + shortSessionID(s.ID)
	}
	return name
}

// shortSessionID is the first 8 characters of a session id, as an audit
// line and a tab's name show it.
func shortSessionID(id string) string {
	return id[:min(8, len(id))]
}

// resumeSession is the session a resume line opens, made right before the
// line is typed: s itself, or for an OpenCode fork the new session its
// service forks from s (in s's directory). fork then no longer applies.
func resumeSession(ctx context.Context, s historySession, fork bool) (historySession, bool, error) {
	if s.Agent != "opencode" || !fork {
		return s, fork, nil
	}
	f, err := opencodeForkSession(ctx, s)
	return f, false, err
}

// resumeInTab opens a tab in groupID at dir, waits for its shell and types
// the resume line there. A tab whose shell is not supported is closed again.
func (a *agentAPI) resumeInTab(ctx context.Context, tm taskMux, groupID string, s historySession, fork bool, dir string) (taskTab, error) {
	tab, err := tm.NewTaskTab(ctx, groupID, resumeTabName(s), dir)
	if err != nil {
		return taskTab{}, err
	}
	unlock := a.input.lock(tab.Target)
	defer unlock()
	shell, _, err := waitTaskShell(ctx, tm, tab.Target, true)
	if err == nil && resumeShellKind(shell) == "" {
		err = errTaskShell
	}
	if err != nil {
		if errors.Is(err, errTaskShell) {
			if cerr := a.m.CloseTab(ctx, tab.TabID, ""); cerr != nil {
				log.Printf("resume: close tab %s: %v", tab.TabID, cerr)
			}
		}
		return taskTab{}, err
	}
	if s, fork, err = resumeSession(ctx, s, fork); err != nil {
		if cerr := a.m.CloseTab(ctx, tab.TabID, ""); cerr != nil {
			log.Printf("resume: close tab %s: %v", tab.TabID, cerr)
		}
		return taskTab{}, err
	}
	return tab, tm.TypeLine(ctx, tab.Target, resumeCommand(resumeShellKind(shell), s.Agent, s.ID, fork, ""))
}

// resumeHere types the resume line into target's own shell, when it waits
// at its prompt before and after its input line is cleared, under the
// pane's input lock; with a cd first when the pane is elsewhere.
func (a *agentAPI) resumeHere(ctx context.Context, tm taskMux, target, paneDir string, s historySession, fork bool, dir string) error {
	unlock, err := a.input.lockWithin(ctx, target, agentRequestMost-(taskNewShellWait+3*agentStartIdleWait+3*muxTimeout))
	if err != nil {
		return err
	}
	defer unlock()
	if _, _, idle, err := tm.IdleShell(ctx, target); err != nil || !idle {
		if err == nil {
			err = errStartPaneBusy
		}
		return err
	}
	if err := tm.Interrupt(ctx, target); err != nil {
		return err
	}
	// An ended ctx fails the check that follows.
	_ = taskSleep(ctx, agentStartClearWait)
	shell, _, idle, err := tm.IdleShell(ctx, target)
	if err != nil {
		return err
	}
	if !idle {
		return errStartPaneBusy
	}
	kind := resumeShellKind(shell)
	if kind == "" {
		return errTaskShell
	}
	cd := dir
	if samePath(dir, paneDir) {
		cd = ""
	}
	s, fork, err = resumeSession(ctx, s, fork)
	if err != nil {
		return err
	}
	return tm.TypeLine(ctx, target, resumeCommand(kind, s.Agent, s.ID, fork, cd))
}
