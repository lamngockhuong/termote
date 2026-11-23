package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"
)

// POST /api/mux/panes/{id}/agent/interrupt ends the turn an agent is
// running, as Esc does in its terminal: Claude Code and Codex get one Escape,
// OpenCode is interrupted through its service, never with a key. Only the
// session the caller saw (its cursor) is interrupted, only while it works and
// shows no dialog: Escape is a dialog's "cancel", and the route never answers
// one. Claude Code gets it only while its screen shows the working line: a
// turn whose answer is written and that waits on background agents is busy
// in its session file, and Escape stops nothing there. It answers once the
// key is sent; the caller follows the status.

// agentInterruptBody bounds the request: a cursor and nothing else.
const agentInterruptBody = 1 << 10

// agentInterruptGap is how long a pane takes no second interrupt: a second
// Escape soon after the first opens Claude Code's rewind and Codex's
// backtrack instead of interrupting anything.
var agentInterruptGap = 3 * time.Second

var (
	errAgentNotWorking = fail(http.StatusConflict, "agent_not_working", "the agent is not working")
	errAgentBlocked    = fail(http.StatusConflict, "agent_blocked", "the agent waits for an answer to a dialog")
	// errAgentNoTurn: Claude Code's session says busy, but its screen
	// shows no working line, only an answer written and a turn waiting on
	// background agents, which Esc does not stop.
	errAgentNoTurn       = fail(http.StatusConflict, "agent_no_turn", "the agent runs no turn that Esc would stop; it may only wait for background work")
	errInterruptPending  = fail(http.StatusConflict, "interrupt_pending", "the agent was just interrupted")
	agentInterruptWork   = muxTimeout + agentConfirmWait
	agentInterruptLastMu sync.Mutex
	// agentInterruptLast: when each pane (by its backend address) was last
	// interrupted.
	agentInterruptLast = map[string]time.Time{}
)

// interruptRecent records an interrupt of target now, or reports that one
// was made within agentInterruptGap.
func interruptRecent(target string, now time.Time) bool {
	agentInterruptLastMu.Lock()
	defer agentInterruptLastMu.Unlock()
	for t, at := range agentInterruptLast {
		if now.Sub(at) >= agentInterruptGap {
			delete(agentInterruptLast, t)
		}
	}
	if _, ok := agentInterruptLast[target]; ok {
		return true
	}
	agentInterruptLast[target] = now
	return false
}

// forgetInterrupt drops the record of an interrupt that was not made.
func forgetInterrupt(target string) {
	agentInterruptLastMu.Lock()
	defer agentInterruptLastMu.Unlock()
	delete(agentInterruptLast, target)
}

func (a *agentAPI) handleInterrupt(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
		return
	}
	wr, ok := a.writer(w)
	if !ok {
		return
	}
	var body struct {
		Cursor string `json:"cursor"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, agentInterruptBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		a.writeFailure(w, fail(http.StatusBadRequest, "invalid_request", "invalid JSON body"))
		return
	}
	if body.Cursor == "" {
		a.writeFailure(w, fail(http.StatusBadRequest, "invalid_request", "cursor is required"))
		return
	}
	// A cursor the server cannot verify was issued before a restart: the
	// client reloads the conversation, as for a changed session.
	c, ok := decodeCursor(body.Cursor)
	if !ok {
		a.writeFailure(w, errSessionChanged)
		return
	}
	holdForLock(w)
	paneID := r.PathValue("id")
	unlock, err := a.lockPane(r.Context(), paneID, agentInterruptWork)
	if err != nil {
		a.writeFailure(w, err)
		return
	}
	defer unlock()
	// Once a key goes, the request finishes even if the client goes away.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), agentInterruptWork)
	defer cancel()
	if err := a.interrupt(ctx, wr, paneID, c.Session); err != nil {
		a.writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// interrupt ends the turn of session in paneID, under the pane's lock. Every
// refusal sends nothing.
func (a *agentAPI) interrupt(ctx context.Context, wr agentWriter, paneID, session string) error {
	s, err := sessionNow(ctx, wr, paneID)
	if err != nil {
		return err
	}
	if s.ID != session {
		return errSessionChanged
	}
	if s.Agent == "opencode" {
		return a.interruptOpencode(ctx, s)
	}
	if s.InMode {
		return fail(http.StatusConflict, "input_not_ready", "the pane is in copy mode")
	}
	if s.Status == "blocked" {
		return errAgentBlocked
	}
	screen, err := wr.Capture(ctx, s.Target)
	if err != nil {
		return err
	}
	sc := readAgentScreen(s.Agent, screen)
	switch {
	case sc.prompt != nil:
		return errAgentBlocked
	case !agentWorking(s, sc):
		return errAgentNotWorking
	case s.Agent == "claude" && (sc.activity == nil || sc.activity.Background != ""):
		// Escape goes only to a turn the screen shows running: with its
		// answer written and only background agents left, Claude Code
		// stays busy and Escape changes nothing.
		return errAgentNoTurn
	}
	// The same agent still, right before the key: the capture took time.
	now, err := sessionNow(ctx, wr, paneID)
	if err != nil {
		return err
	}
	if !sameAgent(now, s) {
		return errSessionChanged
	}
	if now.InMode {
		return fail(http.StatusConflict, "input_not_ready", "the pane is in copy mode")
	}
	if interruptRecent(s.Target, time.Now()) {
		return errInterruptPending
	}
	if err := wr.SendKeySequence(ctx, s.Target, []string{"Escape"}); err != nil {
		forgetInterrupt(s.Target)
		return err
	}
	return nil
}

// interruptOpencode interrupts s through OpenCode's own service, which says
// whether a turn ran.
func (a *agentAPI) interruptOpencode(ctx context.Context, s AgentSession) error {
	if s.Status == "blocked" {
		return errAgentBlocked
	}
	if !isOpencodeSessionID(s.ID) {
		return errAgentNotWorking
	}
	if interruptRecent(s.Target, time.Now()) {
		return errInterruptPending
	}
	c, err := opencodeConnect()
	if err != nil {
		forgetInterrupt(s.Target)
		return errOpencodeNoReply
	}
	ctx, cancel := context.WithTimeout(ctx, opencodeWriteTimeout)
	defer cancel()
	var res struct {
		Interrupted *bool `json:"interrupted"`
		Data        struct {
			Interrupted *bool `json:"interrupted"`
		} `json:"data"`
	}
	if err := c.write(ctx, http.MethodPost, "/api/session/"+s.ID+"/interrupt", nil, &res); err != nil {
		forgetInterrupt(s.Target)
		if !errors.Is(err, errOpencodeUnavailable) {
			log.Printf("opencode interrupt: %v", err)
		}
		return errOpencodeNoReply
	}
	done := res.Interrupted
	if done == nil {
		done = res.Data.Interrupted
	}
	if done != nil && !*done {
		forgetInterrupt(s.Target)
		return errAgentNotWorking
	}
	opencodeActive.forgetPrefix("")
	return nil
}
