package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// The write half of the agent routes: send a message into the pane's input
// box, read the dialog Claude Code has open, answer it. Every write follows
// one rule: write only on positive evidence. The pane must still run the
// session the client saw, and the screen must show exactly the state the
// write expects; anything else answers 409 and sends nothing.

const (
	// agentMessageBody caps a message request; agentMaxText caps its text in
	// UTF-8 bytes (16 KB of Vietnamese is about 5,500 characters).
	agentMessageBody = 64 * 1024
	agentMaxText     = 16 * 1024
	// agentPromptTTL is how long a promptId can be used.
	agentPromptTTL  = 60 * time.Second
	agentMaxPrompts = 256
)

// agentConfirmWait bounds how long a write polls the screen for its effect
// (the pasted text showing, a dialog closing); tests shorten it.
var (
	agentConfirmWait = 2 * time.Second
	agentPollEvery   = 100 * time.Millisecond
)

// agentWriter is implemented by backends that can write to an agent's pane.
// target is AgentSession.Target, never client input.
type agentWriter interface {
	// AgentSessionNow is AgentSession without any cache, for the checks
	// right before a write.
	AgentSessionNow(ctx context.Context, paneID string) (AgentSession, bool, error)
	// Capture returns the visible screen with SGR escapes.
	Capture(ctx context.Context, target string) (string, error)
	// Paste types text as one bracketed paste, without a trailing Enter.
	Paste(ctx context.Context, target, text string) error
	// SendKeySequence sends keys (names from agentKeys) in order.
	SendKeySequence(ctx context.Context, target string, keys []string) error
}

// agentKeys are the only keys a route sends, with the bytes a raw-input
// backend (herdr) types for them.
var agentKeys = map[string]string{
	"Enter": "\r", "Escape": "\x1b",
	"1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
}

func validAgentKeys(keys []string) bool {
	for _, k := range keys {
		if _, ok := agentKeys[k]; !ok {
			return false
		}
	}
	return len(keys) > 0
}

// agentFailure is a refused write: an HTTP status, a stable code the PWA
// branches on, and a message safe to show.
type agentFailure struct {
	status int
	code   string
	msg    string
	prompt *AgentPrompt
	limit  int // bytes, for text_too_long
}

func (f *agentFailure) Error() string { return f.msg }

func fail(status int, code, msg string) *agentFailure {
	return &agentFailure{status: status, code: code, msg: msg}
}

var (
	errTextTooLong    = &agentFailure{status: http.StatusRequestEntityTooLarge, code: "text_too_long", msg: "text is longer than 16 KB", limit: agentMaxText}
	errTargetChanged  = fail(http.StatusConflict, "target_changed", "the agent is no longer in this pane")
	errSessionChanged = fail(http.StatusConflict, "session_changed", "the pane runs another session now")
)

// promptRecord is a dialog a client was shown, bound to the pane, the
// session and the screen region it was read from.
type promptRecord struct {
	id      string
	pane    string
	session AgentSession
	sig     string
	prompt  AgentPrompt
	expires time.Time
}

type answeredMark struct {
	sig   string
	until time.Time
}

// agentInput holds the per-pane locks and the issued promptIds.
type agentInput struct {
	locksMu sync.Mutex
	locks   map[string]*sync.Mutex

	promptsMu   sync.Mutex
	prompts     map[string]*promptRecord // id → record
	answeredSig map[string]answeredMark  // pane → dialog just answered
	captures    *ttlCache[string]
}

func newAgentInput() *agentInput {
	return &agentInput{
		locks:       map[string]*sync.Mutex{},
		prompts:     map[string]*promptRecord{},
		answeredSig: map[string]answeredMark{},
		captures:    newTTLCache[string](agentCacheTTL),
	}
}

// lock serialises every check → capture → write → confirm sequence on one
// pane, so two requests never interleave their keys.
func (in *agentInput) lock(pane string) func() {
	in.locksMu.Lock()
	m := in.locks[pane]
	if m == nil {
		m = &sync.Mutex{}
		in.locks[pane] = m
	}
	in.locksMu.Unlock()
	m.Lock()
	return m.Unlock
}

// issuePrompt returns the promptId for a dialog, reusing one not yet used
// for the same pane, session and region, so every client polling one dialog
// holds the same id and only the first answer is sent.
func (in *agentInput) issuePrompt(pane string, s AgentSession, sig string, p AgentPrompt) string {
	in.promptsMu.Lock()
	defer in.promptsMu.Unlock()
	now := time.Now()
	for id, r := range in.prompts {
		if now.After(r.expires) {
			delete(in.prompts, id)
			continue
		}
		if r.pane == pane && r.sig == sig && sameAgent(r.session, s) {
			r.expires = now.Add(agentPromptTTL)
			return id
		}
	}
	if len(in.prompts) >= agentMaxPrompts {
		for id := range in.prompts {
			delete(in.prompts, id) // any one: an evicted id just answers 409
			break
		}
	}
	b := make([]byte, 16)
	rand.Read(b)
	id := hex.EncodeToString(b)
	in.prompts[id] = &promptRecord{id: id, pane: pane, session: s, sig: sig, prompt: p, expires: now.Add(agentPromptTTL)}
	return id
}

// agentAnsweredHold is how long a dialog just answered gets no new id while
// it stays on screen (Claude Code takes ~100–300 ms to close it).
const agentAnsweredHold = 3 * time.Second

// markAnswered records that pane's dialog sig was answered, and drops every
// other id for it.
func (in *agentInput) markAnswered(pane, sig string) {
	in.promptsMu.Lock()
	defer in.promptsMu.Unlock()
	in.answeredSig[pane] = answeredMark{sig, time.Now().Add(agentAnsweredHold)}
	for id, r := range in.prompts {
		if r.pane == pane && r.sig == sig {
			delete(in.prompts, id)
		}
	}
}

// answered reports whether sig is pane's dialog just answered; any other
// screen clears the mark.
func (in *agentInput) answered(pane, sig string) bool {
	in.promptsMu.Lock()
	defer in.promptsMu.Unlock()
	m, ok := in.answeredSig[pane]
	if !ok {
		return false
	}
	if m.sig != sig || time.Now().After(m.until) {
		delete(in.answeredSig, pane)
		return false
	}
	return true
}

// consumePrompt removes and returns a live promptId of pane, unless accept
// rejects it (a bad choice leaves the id usable).
func (in *agentInput) consumePrompt(pane, id string, accept func(*promptRecord) error) (*promptRecord, error) {
	in.promptsMu.Lock()
	defer in.promptsMu.Unlock()
	r, ok := in.prompts[id]
	if !ok || r.pane != pane || time.Now().After(r.expires) {
		return nil, fail(http.StatusConflict, "prompt_expired", "this dialog was already answered or has expired")
	}
	if err := accept(r); err != nil {
		return nil, err
	}
	delete(in.prompts, id)
	return r, nil
}

// sameAgent: the same process (where known) running the same session in the
// same pane address.
func sameAgent(a, b AgentSession) bool {
	return a.Agent == b.Agent && a.ID == b.ID && a.Target == b.Target && a.PID == b.PID && a.ProcStart == b.ProcStart
}

func (a *agentAPI) registerInputRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/mux/panes/{id}/agent/message", a.handleMessage)
	mux.HandleFunc("/api/mux/panes/{id}/agent/prompt", a.handlePrompt)
	mux.HandleFunc("/api/mux/panes/{id}/agent/answer", a.handleAnswer)
}

func (a *agentAPI) writer(w http.ResponseWriter) (agentWriter, bool) {
	wr, ok := a.m.(agentWriter)
	if !ok || a.loc == nil {
		jsonError(w, errAgentUnsupported.Error(), http.StatusNotFound)
	}
	return wr, ok && a.loc != nil
}

// lockPane takes the write lock of the pane paneID resolves to, keyed by the
// backend address, so the locks map only holds panes that exist and two ids
// of one pane share a lock.
func (a *agentAPI) lockPane(paneID string) (func(), error) {
	s, err := a.session(paneID)
	if err != nil {
		var ie inputError
		if errors.As(err, &ie) || errors.Is(err, errAgentUnsupported) {
			return nil, errTargetChanged
		}
		return nil, err
	}
	return a.input.lock(s.Agent + "\x00" + s.Target), nil
}

// sessionNow re-reads the pane's session, bypassing every cache.
func sessionNow(ctx context.Context, wr agentWriter, paneID string) (AgentSession, error) {
	s, ok, err := wr.AgentSessionNow(ctx, paneID)
	var ie inputError
	if errors.As(err, &ie) {
		return AgentSession{}, errTargetChanged // the window or pane is gone
	}
	if err != nil {
		return AgentSession{}, err
	}
	if !ok {
		return AgentSession{}, errTargetChanged
	}
	return s, nil
}

// cleanText drops control characters other than newline and tab: C0, DEL and
// C1 (U+0080–U+009F) included, so the text cannot end the bracketed paste
// early or carry a terminal command.
func cleanText(s string) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, s)
}

func (a *agentAPI) handleMessage(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
		return
	}
	wr, ok := a.writer(w)
	if !ok {
		return
	}
	var body struct {
		Text   string `json:"text"`
		Cursor string `json:"cursor"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, agentMessageBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			a.writeFailure(w, errTextTooLong)
			return
		}
		a.writeFailure(w, fail(http.StatusBadRequest, "invalid_request", "invalid JSON body"))
		return
	}
	text := cleanText(body.Text)
	if len(text) > agentMaxText {
		a.writeFailure(w, errTextTooLong)
		return
	}
	if strings.TrimSpace(text) == "" {
		a.writeFailure(w, fail(http.StatusBadRequest, "invalid_request", "text is empty"))
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
	paneID := r.PathValue("id")
	unlock, err := a.lockPane(paneID)
	if err != nil {
		a.writeFailure(w, err)
		return
	}
	defer unlock()
	// Once text is pasted, the Enter must follow even if the client goes
	// away, or the text stays stranded in the input box.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 3*agentConfirmWait+muxTimeout)
	defer cancel()
	if err := a.sendMessage(ctx, wr, paneID, c.Session, text); err != nil {
		a.writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// sendMessage pastes text into an empty input box of session and submits it.
func (a *agentAPI) sendMessage(ctx context.Context, wr agentWriter, paneID, session, text string) error {
	s, err := sessionNow(ctx, wr, paneID)
	if err != nil {
		return err
	}
	if s.ID != session {
		return errSessionChanged
	}
	// The agent queues a message sent while it works; a message the user
	// cannot see land is not sent.
	if err := inputReady(s); err != nil {
		return err
	}
	screen, err := wr.Capture(ctx, s.Target)
	if err != nil {
		return err
	}
	sc := readClaudeScreen(screen)
	switch sc.input {
	case inputEmpty:
	case inputDraft:
		return fail(http.StatusConflict, "input_not_ready", "the input box already holds a draft")
	default:
		if sc.prompt != nil {
			return fail(http.StatusConflict, "input_not_ready", "a dialog is open")
		}
		return fail(http.StatusConflict, "input_not_ready", "the screen is not the input box")
	}
	if err := wr.Paste(ctx, s.Target, text); err != nil {
		return err
	}
	shown := pollScreen(ctx, wr, s.Target, func(sc claudeScreen) bool {
		return sc.input == inputDraft && draftShows(sc.draft, text)
	})
	if !shown {
		return fail(http.StatusConflict, "paste_not_confirmed", "the pasted text did not show in the input box")
	}
	// The same process and session, still idle, right before the key that
	// submits; otherwise the text stays in the box for the user to see.
	if now, err := sessionNow(ctx, wr, paneID); err != nil || !sameAgent(now, s) || inputReady(now) != nil {
		return fail(http.StatusBadGateway, "delivered_not_submitted", "the text is in the input box but was not submitted")
	}
	if err := wr.SendKeySequence(ctx, s.Target, []string{"Enter"}); err != nil {
		log.Printf("agent message: enter: %v", err)
		return fail(http.StatusBadGateway, "delivered_not_submitted", "the text was pasted but not submitted")
	}
	// Submitted: the box no longer holds the text.
	gone := pollScreen(ctx, wr, s.Target, func(sc claudeScreen) bool {
		return !(sc.input == inputDraft && draftShows(sc.draft, text))
	})
	if !gone {
		return fail(http.StatusBadGateway, "delivered_not_submitted", "the text was pasted but not submitted")
	}
	return nil
}

// inputReady: the agent waits for a message and the pane passes keys to it.
// A message sent while it works is queued, out of the user's sight.
func inputReady(s AgentSession) error {
	if s.InMode {
		return fail(http.StatusConflict, "input_not_ready", "the pane is in copy mode")
	}
	if s.Status != "idle" && s.Status != "done" {
		return fail(http.StatusConflict, "input_not_ready", "the agent is "+agentStatusWord(s.Status))
	}
	return nil
}

func agentStatusWord(s string) string {
	switch s {
	case "working":
		return "working"
	case "blocked":
		return "waiting for an answer"
	}
	return "not ready"
}

// pollScreen captures until ok holds or agentConfirmWait passes.
func pollScreen(ctx context.Context, wr agentWriter, target string, ok func(claudeScreen) bool) bool {
	deadline := time.Now().Add(agentConfirmWait)
	for {
		if screen, err := wr.Capture(ctx, target); err == nil && ok(readClaudeScreen(screen)) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(agentPollEvery):
		}
	}
}

type promptResponse struct {
	Prompt *AgentPrompt `json:"prompt"`
}

func (a *agentAPI) handlePrompt(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) || !requireAgentRead(w, r) {
		return
	}
	wr, ok := a.writer(w)
	if !ok {
		return
	}
	paneID := r.PathValue("id")
	s, err := a.session(paneID)
	if err != nil {
		a.agentError(w, "agent session", err)
		return
	}
	screen, err := a.input.captures.do(paneID+"\x00"+s.Target, func() (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
		defer cancel()
		return wr.Capture(ctx, s.Target)
	})
	if err != nil {
		a.agentError(w, "capture", err)
		return
	}
	jsonOK(w, promptResponse{Prompt: a.promptOf(paneID, s, readClaudeScreen(screen))})
}

// promptOf turns a screen's dialog into the card the client gets.
func (a *agentAPI) promptOf(paneID string, s AgentSession, sc claudeScreen) *AgentPrompt {
	if sc.prompt == nil {
		a.input.answered(paneID, "") // the screen left the dialog
		return nil
	}
	p := *sc.prompt
	if p.Kind != "unsupported" && dialogStatus(s) && !a.input.answered(paneID, sc.sig) {
		p.PromptID = a.input.issuePrompt(paneID, s, sc.sig, p)
	}
	return &p
}

func (a *agentAPI) handleAnswer(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
		return
	}
	wr, ok := a.writer(w)
	if !ok {
		return
	}
	var body struct {
		PromptID string          `json:"promptId"`
		Choice   json.RawMessage `json:"choice"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	paneID := r.PathValue("id")
	unlock, err := a.lockPane(paneID)
	if err != nil {
		a.writeFailure(w, err)
		return
	}
	defer unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*agentConfirmWait+muxTimeout)
	defer cancel()
	if err := a.answer(ctx, wr, paneID, body.PromptID, body.Choice); err != nil {
		a.writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *agentAPI) answer(ctx context.Context, wr agentWriter, paneID, promptID string, choice json.RawMessage) error {
	var key string
	rec, err := a.input.consumePrompt(paneID, promptID, func(r *promptRecord) error {
		key = choiceKey(r.prompt, choice)
		if key == "" {
			return fail(http.StatusBadRequest, "invalid_choice", "choice is not one of the options")
		}
		return nil
	})
	if err != nil {
		return err
	}
	s, err := sessionNow(ctx, wr, paneID)
	if err != nil {
		return err
	}
	if !sameAgent(s, rec.session) {
		return errTargetChanged
	}
	if s.InMode {
		return fail(http.StatusConflict, "input_not_ready", "the pane is in copy mode")
	}
	screen, err := wr.Capture(ctx, s.Target)
	if err != nil {
		return err
	}
	sc := readClaudeScreen(screen)
	if sc.prompt == nil || sc.sig != rec.sig || sc.prompt.Kind == "unsupported" || !dialogStatus(s) {
		f := fail(http.StatusConflict, "prompt_changed", "the screen changed; check the dialog again")
		f.prompt = a.promptOf(paneID, s, sc)
		return f
	}
	// From here the dialog counts as answered: no new id is issued for it
	// until the screen moves on, so a second device cannot answer the
	// dialog that follows in its place.
	a.input.markAnswered(paneID, rec.sig)
	if err := wr.SendKeySequence(ctx, s.Target, []string{key}); err != nil {
		return err
	}
	closed := pollScreen(ctx, wr, s.Target, func(sc claudeScreen) bool { return sc.sig != rec.sig })
	if !closed {
		return fail(http.StatusBadGateway, "answer_not_confirmed", "the key was sent but the dialog is still open")
	}
	return nil
}

// dialogStatus: where the agent's own status is known from its session
// file (tmux), it must say a dialog is open; the screen alone is not enough.
func dialogStatus(s AgentSession) bool {
	return s.PID == 0 || s.Status == "blocked"
}

// choiceKey is the key for a choice: an option's number, or "cancel" for
// Escape. Anything else is "".
func choiceKey(p AgentPrompt, choice json.RawMessage) string {
	var name string
	if json.Unmarshal(choice, &name) == nil {
		if name == "cancel" {
			return "Escape"
		}
		return ""
	}
	var n int
	if json.Unmarshal(choice, &n) != nil {
		return ""
	}
	for _, o := range p.Options {
		if o.Index == n {
			return strconv.Itoa(n)
		}
	}
	return ""
}

// writeFailure answers a refused write; other errors go through muxError.
func (a *agentAPI) writeFailure(w http.ResponseWriter, err error) {
	var f *agentFailure
	if !errors.As(err, &f) {
		a.agentError(w, "agent write", err)
		return
	}
	body := map[string]any{"error": f.msg, "code": f.code}
	if f.prompt != nil || f.code == "prompt_changed" {
		body["prompt"] = f.prompt
	}
	if f.limit > 0 {
		body["limit"] = f.limit
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(f.status)
	json.NewEncoder(w).Encode(body)
}
