package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"
)

// /api/mux/asks: the orchestrator's questions for the user (ask_store.go).
// Only termote agents, over the local socket, adds, closes or marks one
// reported; the orchestrator is the pane named in the body, whose agent the
// server looks up itself (never a key or an identity from the request). A
// full client reads them and answers one: the server types a fixed English
// message into the input box of the orchestrator that asked, checked under
// the pane's lock as sendCI checks a job's agent, and records the answer. A
// view-only client sees how many wait and their ids, never their text.
//
// The machine proxy does not forward these routes (machine_proxy.go): a
// question is answered in the PWA of the server that holds it.

var (
	errAskBusy    = &codedError{"ask_busy", "an answer to the question is being sent", http.StatusConflict}
	errAskNoAgent = &codedError{"ask_no_agent", "the orchestrator that asked no longer runs in its pane", http.StatusConflict}
)

// askReservations holds the ids of the asks a write is in flight for: an
// answer being sent, or a close. A second one is ask_busy.
type askReservations struct {
	mu  sync.Mutex
	ids map[string]bool
}

// take reserves id, or reports that it is taken; release frees it.
func (r *askReservations) take(id string) (release func(), ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ids[id] {
		return nil, false
	}
	if r.ids == nil {
		r.ids = map[string]bool{}
	}
	r.ids[id] = true
	return func() {
		r.mu.Lock()
		delete(r.ids, id)
		r.mu.Unlock()
	}, true
}

// askLive is whether the orchestrator that asked still runs in its pane.
type askLive struct {
	// Status: running, or gone (the pane runs no agent, or another one).
	Status string `json:"status"`
	PaneID string `json:"paneId,omitempty"`
	Ref    string `json:"ref,omitempty"`
}

// askView is an ask as a full client reads it: for an open one, whether its
// orchestrator still runs; the title of its job, if any.
type askView struct {
	ask
	Live     *askLive `json:"live,omitempty"`
	JobTitle string   `json:"jobTitle,omitempty"`
}

// askBrief is an open ask as a view-only client reads it: never its text,
// its choices, its answer or who asked.
type askBrief struct {
	ID      string    `json:"id"`
	State   string    `json:"state"`
	Job     string    `json:"job,omitempty"`
	Created time.Time `json:"created"`
}

type askInput struct {
	Pane    string   `json:"pane"`
	Text    string   `json:"text"`
	Choices []string `json:"choices"`
	Job     string   `json:"job"`
	Answer  string   `json:"answer"`
}

type askAnswerInput struct {
	Updated string  `json:"updated"`
	Choice  *int    `json:"choice"`
	Text    *string `json:"text"`
}

func (a *agentAPI) registerAskRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/mux/asks", a.handleAsks)
	mux.HandleFunc("/api/mux/asks/{id}/close", a.handleAskClose)
	mux.HandleFunc("/api/mux/asks/{id}/reported", a.handleAskReported)
	mux.HandleFunc("/api/mux/asks/{id}/answer", a.handleAskAnswer)
}

func (a *agentAPI) handleAsks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if msg := crossSiteRejection(a.allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		if a.jobs == nil {
			writeJobError(w, errJobsUnavailable)
			return
		}
		a.listAsks(w, r)
	case http.MethodPost:
		in, ok := a.askSocketWrite(w, r)
		if !ok {
			return
		}
		a.addAskRoute(w, r, in)
	default:
		w.Header().Set("Allow", "GET, POST")
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// askSocketWrite checks a write only termote agents makes: the write role,
// the local socket, the body, the ledger.
func (a *agentAPI) askSocketWrite(w http.ResponseWriter, r *http.Request) (askInput, bool) {
	var in askInput
	if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
		return in, false
	}
	if !isLocalSocket(r.Context()) {
		jsonErrorCode(w, "socket_only", "only termote agents adds, closes or reports a question", http.StatusForbidden)
		return in, false
	}
	if !decodeAskBody(w, r, &in) {
		return in, false
	}
	if a.jobs == nil {
		writeJobError(w, errJobsUnavailable)
		return in, false
	}
	return in, true
}

// askOrchestrator is the agent pane runs now, the orchestrator writing, and
// gives its open asks that agent (repinAsks): after a /clear or a resume it
// still gets the PWA's answers.
func (a *agentAPI) askOrchestrator(pane string) (jobAgent, error) {
	ag, err := a.jobAgentFor(pane)
	if err != nil {
		return jobAgent{}, err
	}
	return ag, a.jobs.repinAsks(ag.Key, ag)
}

func (a *agentAPI) addAskRoute(w http.ResponseWriter, r *http.Request, in askInput) {
	text, err := validAskText(in.Text)
	if err != nil {
		writeJobError(w, err)
		return
	}
	choices, err := validAskChoices(in.Choices)
	if err != nil {
		writeJobError(w, err)
		return
	}
	if in.Job != "" && !validTemplateID(in.Job) {
		writeJobError(w, invalidAsk("no unfinished job of this pane has that id"))
		return
	}
	ag, err := a.askOrchestrator(in.Pane)
	if err != nil {
		writeJobError(w, err)
		return
	}
	q, err := a.jobs.addAsk(ask{Text: text, Choices: choices, Job: in.Job, CreatedBy: ag.Key, Agent: ag})
	if err != nil {
		writeJobError(w, err)
		return
	}
	// Who asked, never what: any process of the user's can reach the
	// socket and name the orchestrator's pane, as it can agents send there.
	auditf("ask_added", "ask", q.ID, "pane", ag.PaneID, "peer_pid", localPeerPID(r.Context()))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"ask": a.viewAsk(q)})
}

// listAsks answers every ask to a full client, the open ones' ids to a
// view-only one. A pane named by termote agents (ask list) is the
// orchestrator's, whose asks get its agent now.
func (a *agentAPI) listAsks(w http.ResponseWriter, r *http.Request) {
	if pane := r.URL.Query().Get("pane"); pane != "" && isLocalSocket(r.Context()) {
		// A list never fails for it: the asks are read as they are.
		if _, err := a.askOrchestrator(pane); err != nil {
			log.Printf("asks: repin for %s: %v", pane, err)
		}
	}
	list, readOnly := a.jobs.asksList()
	if isViewOnly(r) {
		brief := []askBrief{}
		for _, q := range list {
			if q.State == askOpen {
				brief = append(brief, askBrief{ID: q.ID, State: q.State, Job: q.Job, Created: q.Created})
			}
		}
		jsonOK(w, map[string]any{"asks": brief, "readOnly": true})
		return
	}
	snap, _ := a.activity.lastSnapshot()
	jobs, _ := a.jobs.jobs()
	out := make([]askView, 0, len(list))
	for _, q := range list {
		out = append(out, a.askViewIn(snap, jobs, q))
	}
	jsonOK(w, map[string]any{"asks": out, "readOnly": readOnly})
}

func (a *agentAPI) viewAsk(q ask) askView {
	snap, _ := a.activity.lastSnapshot()
	jobs, _ := a.jobs.jobs()
	return a.askViewIn(snap, jobs, q)
}

func (a *agentAPI) askViewIn(snap Snapshot, jobs []job, q ask) askView {
	v := askView{ask: q}
	if i := slices.IndexFunc(jobs, func(j job) bool { return j.ID == q.Job }); q.Job != "" && i >= 0 {
		v.JobTitle = jobs[i].Title
	}
	if q.State != askOpen {
		return v
	}
	v.Live = &askLive{Status: "gone", PaneID: q.Agent.PaneID, Ref: q.Agent.Ref}
	if p, ok := findJobPane(snap, q.Agent.Key); ok {
		if s, err := a.session(p.pane.ID); err == nil && q.Agent.matches(p, s) {
			v.Live = &askLive{Status: "running", PaneID: p.pane.ID, Ref: p.ref()}
		}
	}
	return v
}

// handleAskClose: the orchestrator records that the user answered the ask
// somewhere else. One answered already is ask_closed, with its answer.
func (a *agentAPI) handleAskClose(w http.ResponseWriter, r *http.Request) {
	in, ok := a.askSocketWrite(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !validAskID(id) {
		writeJobError(w, errAskNotFound)
		return
	}
	answer, err := validAskAnswer(in.Answer)
	if err != nil {
		writeJobError(w, err)
		return
	}
	ag, err := a.askOrchestrator(in.Pane)
	if err != nil {
		writeJobError(w, err)
		return
	}
	// Not while an answer from the PWA is on its way
	release, ok := a.asking.take(id)
	if !ok {
		writeJobError(w, errAskBusy)
		return
	}
	defer release()
	q, err := a.jobs.closeAsk(id, ag.Key, answer)
	if err != nil {
		writeJobError(w, err)
		return
	}
	auditf("ask_closed", "ask", q.ID, "pane", ag.PaneID, "peer_pid", localPeerPID(r.Context()))
	jsonOK(w, map[string]any{"ask": a.viewAsk(q)})
}

// handleAskReported: wait --mine told the orchestrator of the PWA's answer.
func (a *agentAPI) handleAskReported(w http.ResponseWriter, r *http.Request) {
	in, ok := a.askSocketWrite(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !validAskID(id) {
		writeJobError(w, errAskNotFound)
		return
	}
	ag, err := a.jobAgentFor(in.Pane)
	if err != nil {
		writeJobError(w, err)
		return
	}
	if err := a.jobs.markAskReported(id, ag.Key); err != nil {
		writeJobError(w, err)
		return
	}
	jsonOK(w, map[string]bool{"ok": true})
}

// askMessage is what the orchestrator gets for an answer: fixed English
// the skill knows, the choice's label taken from the ask, never the client.
func askMessage(id string, choice int, text string) string {
	if choice > 0 {
		return "Answer to " + id + " (choice " + strconv.Itoa(choice) + "): " + text
	}
	return "Answer to " + id + ": " + text
}

// handleAskAnswer: the user answers an ask in the PWA, with one of its
// choices or text. The answer is typed into the orchestrator's input box,
// then recorded; a refused send (a draft in the box, a dialog) leaves the
// ask open.
func (a *agentAPI) handleAskAnswer(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
		return
	}
	var in askAnswerInput
	if !decodeAskBody(w, r, &in) {
		return
	}
	if a.jobs == nil {
		writeJobError(w, errJobsUnavailable)
		return
	}
	id := r.PathValue("id")
	if !validAskID(id) {
		writeJobError(w, errAskNotFound)
		return
	}
	if (in.Choice == nil) == (in.Text == nil) {
		writeJobError(w, invalidAsk("answer with a choice or with text"))
		return
	}
	release, ok := a.asking.take(id)
	if !ok {
		writeJobError(w, errAskBusy)
		return
	}
	defer release()
	q, ok := a.jobs.askByID(id)
	switch {
	case !ok:
		writeJobError(w, errAskNotFound)
		return
	case q.State != askOpen:
		writeJobError(w, askClosed(q))
		return
	case q.Updated.Format(time.RFC3339Nano) != in.Updated:
		writeJobError(w, askConflict(q))
		return
	}
	choice, answer := 0, ""
	if in.Choice != nil {
		if choice = *in.Choice; choice < 1 || choice > len(q.Choices) {
			writeJobError(w, invalidAsk("no such choice"))
			return
		}
		answer = q.Choices[choice-1]
	} else {
		var err error
		if answer, err = validAskAnswer(*in.Text); err != nil {
			writeJobError(w, err)
			return
		}
		if answer == "" {
			writeJobError(w, invalidAsk("the answer is empty"))
			return
		}
	}
	holdForLock(w)
	queued, err := a.sendAskAnswer(r.Context(), q, askMessage(id, choice, answer))
	if err != nil {
		a.writeCIError(w, err)
		return
	}
	by := "socket"
	if auth, ok := authFrom(r.Context()); ok {
		by = auditBy(auth)
	}
	// Never the answer's text
	auditf("ask_answered", "ask", id, "by", by)
	saved, err := a.jobs.answerAsk(id, in.Updated, answer, choice)
	recorded := err == nil
	if !recorded {
		// The orchestrator has the answer: it closes the ask itself.
		log.Printf("asks: record the answer to %s: %v", id, err)
		saved = q
	}
	jsonOK(w, map[string]any{"ask": a.viewAsk(saved), "queued": queued, "recorded": recorded})
}

// sendAskAnswer types msg into the input box of the orchestrator q was
// asked by, once the pane is found to run that very agent under its lock.
func (a *agentAPI) sendAskAnswer(ctx context.Context, q ask, msg string) (queued bool, err error) {
	wr, ok := a.m.(agentWriter)
	if !ok || a.loc == nil {
		return false, errAgentUnsupported
	}
	p, err := a.askPane(ctx, q)
	if err != nil {
		return false, err
	}
	paneID := p.pane.ID
	budget := messageBudget(0, pasteGrowMost(msg))
	unlock, err := a.lockPane(ctx, paneID, budget)
	if err != nil {
		return false, askAgentErr(err)
	}
	defer unlock()
	// Once text is pasted, the Enter must follow even if the client goes
	// away, or the text stays stranded in the input box.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), budget)
	defer cancel()
	// Under the pane's lock: the pane still runs the agent that asked (a
	// pane reused since would get another agent's answer).
	s, err := sessionNow(ctx, wr, paneID)
	if err != nil {
		return false, askAgentErr(err)
	}
	if p, err = a.askPane(ctx, q); err != nil || p.pane.ID != paneID || !q.Agent.matches(p, s) {
		return false, askAgentErr(err)
	}
	parts, _ := messageParts(msg, nil, 0)
	err = a.sendMessage(ctx, wr, paneID, s.ID, parts, nil, false)
	if err != nil && !errors.Is(err, errQueued) {
		return false, err
	}
	a.follower.follow(paneID)
	return errors.Is(err, errQueued), nil
}

// askPane is the pane of the snapshot whose activity key is the one q was
// asked from, running an agent.
func (a *agentAPI) askPane(ctx context.Context, q ask) (snapPane, error) {
	snap, err := peekSnapshot(ctx, a.m)
	if err != nil {
		return snapPane{}, err
	}
	p, ok := findJobPane(snap, q.Agent.Key)
	if !ok {
		return snapPane{}, errAskNoAgent
	}
	return p, nil
}

// askAgentErr is ask_no_agent for a pane that runs no agent taking
// messages any more (or for no error: another agent runs there), err
// otherwise.
func askAgentErr(err error) error {
	if err == nil || errors.Is(err, errTargetChanged) || errors.Is(err, errAgentUnsupported) {
		return errAskNoAgent
	}
	return err
}

// decodeAskBody reads a JSON body of at most askBody bytes into v.
func decodeAskBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, askBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			writeJobError(w, errJobsTooLarge)
		} else {
			jsonError(w, "invalid JSON body", http.StatusBadRequest)
		}
		return false
	}
	return true
}
