package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"
)

// Starting an agent (POST /api/mux/panes/{id}/agent/start {kind}) in a pane
// that shows only its shell, and following that start (GET of the same
// path). Herdr types the agent's command line into the shell and answers at
// once; readiness is read afterwards from agent.get, so the POST never waits
// for the agent and the PWA polls the GET.

// agentStartArgs are the kinds a client may start and the arguments each one
// gets. Nothing in a request adds to them.
var agentStartArgs = map[string][]string{
	"claude": nil,
	"codex":  {"--no-daemon"},
}

// agentStartTimeout is Herdr's startup deadline (timeout_ms); a start not
// ready agentStartGrace after it is reported as timed out.
const (
	// agentStartSettle: a pane that shows only its shell again this long
	// after the command was typed, with no agent seen, ran a command that
	// ended (not installed, failed at once). Herdr itself keeps the start
	// pending until its deadline.
	agentStartSettle  = 4 * time.Second
	agentStartTimeout = 30 * time.Second
	agentStartGrace   = 5 * time.Second
	// agentStartKeep is how long a finished start is still reported.
	agentStartKeep = 60 * time.Second
)

// The idle check waits for a shell still starting (agentStartIdleWait,
// polled every agentStartIdlePoll); after the C-c that clears the input
// line, the shell is checked again agentStartClearWait later. Tests shorten
// them.
// Each backend call of a start gets agentStartCallTimeout.
var (
	agentStartIdleWait    = 1500 * time.Millisecond
	agentStartIdlePoll    = 250 * time.Millisecond
	agentStartClearWait   = 200 * time.Millisecond
	agentStartCallTimeout = muxTimeout
)

// The states of a start, as GET reports them.
const (
	startStarting = "starting"
	startReady    = "ready"
	startBlocked  = "blocked"
	startExited   = "exited"
	startTimeout  = "timeout"
)

var (
	errStartPaneBusy    = &codedError{code: "pane_busy", msg: "the pane is running something other than its shell", status: http.StatusConflict}
	errStartUnsupported = &codedError{code: "unsupported", msg: "this backend cannot start agents", status: http.StatusNotImplemented}
	errStartNotFound    = &codedError{code: "not_found", msg: "pane not found", status: http.StatusNotFound}
	// errStartUnknown: the start request timed out, so whether Herdr typed
	// the command is not known; the start is followed as if it had.
	errStartUnknown = &codedError{code: "start_unknown", msg: "the start did not answer in time", status: http.StatusGatewayTimeout}
	errStartFailed  = &codedError{code: "start_failed", msg: "could not start the agent", status: http.StatusInternalServerError}
	errStarting     = &codedError{code: "starting", msg: "an agent is already starting in this pane", status: http.StatusConflict}
	// errStartPending: a start in the pane ended (its command failed) but
	// Herdr holds it until its deadline and would refuse a new one.
	errStartPending = &codedError{code: "start_pending", msg: "Herdr still holds the last start in this pane", status: http.StatusConflict}
	errNoStart      = &codedError{code: "no_start", msg: "no agent was started in this pane", status: http.StatusNotFound}
)

// agentStarter is a backend that can start an agent in an idle pane.
type agentStarter interface {
	// requirePane validates the pane id and checks the pane exists.
	requirePane(ctx context.Context, id string) (Size, error)
	// StartAgent clears the pane's input line and asks the backend to start
	// kind with args, under an alias it picks, which it returns. ctx bounds
	// the whole start; each backend call gets its own agentStartCallTimeout.
	StartAgent(ctx context.Context, paneID, kind string, args []string) (name string, err error)
	// AgentStartState reads how the start of the agent named name, made
	// elapsed ago in paneID, is going: one of the start states, never
	// startTimeout (the caller decides).
	AgentStartState(ctx context.Context, paneID, name, kind string, elapsed time.Duration) (string, error)
}

// agentStartName is a fresh alias for a started agent, within Herdr's
// grammar [a-z][a-z0-9_-]{0,31}.
func agentStartName(kind string) string {
	b := make([]byte, 4)
	rand.Read(b)
	return "termote-" + kind + "-" + hex.EncodeToString(b)
}

// pendingStart is a start this server made in one pane.
type pendingStart struct {
	kind, name string
	started    time.Time
	ended      time.Time // zero while the start is followed
	state      string
}

// agentStarts holds each pane's latest start.
type agentStarts struct {
	mu    sync.Mutex
	panes map[string]*pendingStart
}

func newAgentStarts() *agentStarts {
	return &agentStarts{panes: map[string]*pendingStart{}}
}

// get returns a copy of the pane's start, after dropping every start that
// ended more than agentStartKeep ago.
func (s *agentStarts) get(pane string, now time.Time) (pendingStart, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, p := range s.panes {
		if !p.ended.IsZero() && now.Sub(p.ended) > agentStartKeep {
			delete(s.panes, id)
		}
	}
	p, ok := s.panes[pane]
	if !ok {
		return pendingStart{}, false
	}
	return *p, true
}

func (s *agentStarts) put(pane string, p pendingStart) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.panes[pane] = &p
}

func (s *agentStarts) drop(pane string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.panes, pane)
}

// end records a final state, unless another start replaced name meanwhile.
func (s *agentStarts) end(pane, name, state string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.panes[pane]; p != nil && p.name == name && p.ended.IsZero() {
		p.state, p.ended = state, now
	}
}

// startFinal: the start is over, the PWA stops following it.
func startFinal(state string) bool {
	return state != startStarting
}

// starter returns the backend as an agentStarter when it can start agents
// now, else answers 501.
func (a *agentAPI) starter(w http.ResponseWriter) (agentStarter, bool) {
	st, ok := a.m.(agentStarter)
	if !ok || !a.m.Caps().AgentStart {
		jsonErrorCode(w, errStartUnsupported.code, errStartUnsupported.msg, errStartUnsupported.status)
		return nil, false
	}
	return st, true
}

func (a *agentAPI) handleStart(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		a.startAgent(w, r)
	case http.MethodGet:
		a.startState(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *agentAPI) startAgent(w http.ResponseWriter, r *http.Request) {
	if !requireWriteRole(w, r) {
		return
	}
	// Only kind is read: arguments and the alias are the server's.
	var body struct {
		Kind string `json:"kind"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			jsonError(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		jsonErrorCode(w, "invalid_request", "invalid JSON body", http.StatusBadRequest)
		return
	}
	args, ok := agentStartArgs[body.Kind]
	if !ok {
		jsonErrorCode(w, "invalid_kind", "kind must be claude or codex", http.StatusBadRequest)
		return
	}
	st, ok := a.starter(w)
	if !ok {
		return
	}
	paneID := r.PathValue("id")
	// The pane is resolved before its lock, so the locks map only ever
	// holds panes that exist.
	rctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
	_, err := st.requirePane(rctx, paneID)
	cancel()
	if err != nil {
		a.startError(w, err)
		return
	}
	// The pane's lock is the one message and answer take (Herdr's
	// AgentSession.Target is the pane id).
	unlock := a.input.lock(paneID)
	defer unlock()
	// Once the line is cleared the start must go on even if the client
	// leaves, or the pane is left with nothing typed for no reason.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), agentStartIdleWait+agentStartClearWait+4*agentStartCallTimeout)
	defer cancel()
	if p, ok := a.starts.get(paneID, time.Now()); ok && p.ended.IsZero() {
		if !startFinal(a.followStart(ctx, st, paneID, p)) {
			a.startError(w, errStarting)
			return
		}
	}
	// Recorded before Herdr is asked, so a GET while the POST runs (which
	// can take seconds) reports it starting rather than no_start.
	a.starts.put(paneID, pendingStart{kind: body.Kind, started: time.Now(), state: startStarting})
	name, err := st.StartAgent(ctx, paneID, body.Kind, args)
	if err == nil || errors.Is(err, errStartUnknown) {
		a.starts.put(paneID, pendingStart{kind: body.Kind, name: name, started: time.Now(), state: startStarting})
	} else {
		a.starts.drop(paneID)
	}
	if err != nil {
		a.startError(w, err)
		return
	}
	jsonOK(w, map[string]any{"ok": true, "state": startStarting})
}

// startState answers GET: the state of this server's latest start in the
// pane.
func (a *agentAPI) startState(w http.ResponseWriter, r *http.Request) {
	// A read, but a cross-site page has no reason to make the server ask.
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	st, ok := a.starter(w)
	if !ok {
		return
	}
	paneID := r.PathValue("id")
	p, ok := a.starts.get(paneID, time.Now())
	if !ok {
		a.startError(w, errNoStart)
		return
	}
	state := p.state
	if p.ended.IsZero() {
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		state = a.followStart(ctx, st, paneID, p)
	}
	jsonOK(w, map[string]any{"kind": p.kind, "state": state})
}

// followStart reads a followed start's state, records it when final and
// returns it. A failed read keeps it starting until its deadline.
func (a *agentAPI) followStart(ctx context.Context, st agentStarter, paneID string, p pendingStart) string {
	if p.name == "" {
		return startStarting // the POST has not reached Herdr yet
	}
	state, err := st.AgentStartState(ctx, paneID, p.name, p.kind, time.Since(p.started))
	if err != nil {
		log.Printf("agent start state %s: %v", p.name, err)
		state = startStarting
	}
	now := time.Now()
	if state == startStarting && now.Sub(p.started) > agentStartTimeout+agentStartGrace {
		state = startTimeout
	}
	if startFinal(state) {
		a.starts.end(paneID, p.name, state, now)
	}
	return state
}

// startError answers a refused or failed start; anything not coded is
// logged and answered as start_failed.
func (a *agentAPI) startError(w http.ResponseWriter, err error) {
	var ce *codedError
	var ie inputError
	switch {
	case errors.As(err, &ce):
	case errors.As(err, &ie):
		ce = errStartNotFound // a bad or unknown pane id, or the pane vanished
	case errors.Is(err, errUnsupported):
		ce = errStartUnsupported
	default:
		log.Printf("%s agent start: %v", a.m.Name(), err)
		ce = errStartFailed
	}
	jsonErrorCode(w, ce.code, ce.msg, ce.status)
}
