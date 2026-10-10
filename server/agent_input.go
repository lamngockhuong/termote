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
// box, read the dialog the agent (Claude Code, Codex) has open, answer it.
// Every write follows
// one rule: write only on positive evidence. The pane must still run the
// session the client saw, and the screen must show exactly the state the
// write expects; anything else answers 409 and sends nothing.

const (
	// agentMessageBody caps a message request; agentMaxText caps its text in
	// UTF-8 bytes (16 KB of Vietnamese is about 5,500 characters).
	agentMessageBody = 64 * 1024
	agentMaxText     = 16 * 1024
	// agentMaxImages caps the uploads one message attaches.
	agentMaxImages = 5
	// agentMaxFreeText caps an answer typed into a question's free-text
	// option: it wraps under the option, and must fit on the screen to be
	// checked before Enter.
	agentMaxFreeText = 1024
	// agentPromptTTL is how long a promptId can be used.
	agentPromptTTL  = 60 * time.Second
	agentMaxPrompts = 256
)

// agentConfirmWait bounds how long a write polls the screen for its effect
// (the pasted text showing, a dialog closing); agentImageWait for a pasted
// image path to become the agent's image token, which reads the file first
// (twice the slowest measured, a 10 MB PNG). Tests shorten both.
var (
	agentConfirmWait = 2 * time.Second
	agentImageWait   = 11 * time.Second
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
	"Enter": "\r", "Escape": "\x1b", "C-c": "\x03", "Left": "\x1b[D", "Right": "\x1b[C", "Up": "\x1b[A", "Down": "\x1b[B",
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
	limit  int      // bytes, for text_too_long
	images []string // upload ids that resolve to no image, for invalid_request
}

func (f *agentFailure) Error() string { return f.msg }

func fail(status int, code, msg string) *agentFailure {
	return &agentFailure{status: status, code: code, msg: msg}
}

var (
	errTextTooLong    = &agentFailure{status: http.StatusRequestEntityTooLarge, code: "text_too_long", msg: "text is longer than 16 KB", limit: agentMaxText}
	errFreeTooLong    = &agentFailure{status: http.StatusRequestEntityTooLarge, code: "text_too_long", msg: "text is longer than 1 KB", limit: agentMaxFreeText}
	errTargetChanged  = fail(http.StatusConflict, "target_changed", "the agent is no longer in this pane")
	errSessionChanged = fail(http.StatusConflict, "session_changed", "the pane runs another session now")
	errPartialPaste   = fail(http.StatusConflict, "partial_paste", "the input box holds part of this message; clear it in the terminal")
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
			// The latest read: the signature leaves out the pointer, which
			// decides whether a multiSelect tab offers FreeText.
			r.prompt = p
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
// same pane address, and for Codex writing the same rollout.
func sameAgent(a, b AgentSession) bool {
	return a.Agent == b.Agent && a.ID == b.ID && a.Target == b.Target && a.PID == b.PID && a.ProcStart == b.ProcStart &&
		a.Rollout == b.Rollout && a.RolloutID == b.RolloutID
}

func (a *agentAPI) registerInputRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/mux/panes/{id}/agent/message", a.handleMessage)
	mux.HandleFunc("/api/mux/panes/{id}/agent/prompt", a.handlePrompt)
	mux.HandleFunc("/api/mux/panes/{id}/agent/answer", a.handleAnswer)
	mux.HandleFunc("/api/mux/panes/{id}/agent/start", a.handleStart)
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
	if agentScreenReaders[s.Agent] == nil {
		return nil, errAgentUnsupported
	}
	// By the pane alone: two agents in turn on one pane share its lock.
	return a.input.lock(s.Target), nil
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
	if agentScreenReaders[s.Agent] == nil {
		return AgentSession{}, errAgentUnsupported // another agent took the pane
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
		Text   string   `json:"text"`
		Cursor string   `json:"cursor"`
		Images []string `json:"images"`
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
	if strings.TrimSpace(text) == "" && len(body.Images) == 0 {
		a.writeFailure(w, fail(http.StatusBadRequest, "invalid_request", "text is empty"))
		return
	}
	paths, err := a.imagePaths(body.Images)
	if err != nil {
		a.writeFailure(w, err)
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
	budget := messageBudget(len(paths))
	if len(paths) > 0 {
		// The body is read: the read deadline only has to outlast the
		// pastes, which may pass requestReadTimeout with several images.
		// Fails only on a writer without a connection (tests).
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(budget + muxTimeout))
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), budget)
	defer cancel()
	if err := a.sendMessage(ctx, wr, paneID, c.Session, text, paths); err != nil {
		a.writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// messageBudget is how long a message with n images may take: a redraw to
// settle, each paste and the Enter wait for the screen, and the backend
// calls around them.
func messageBudget(n int) time.Duration {
	if n == 0 {
		return 4*agentConfirmWait + muxTimeout
	}
	return time.Duration(n+3)*max(agentConfirmWait, agentImageWait) + muxTimeout
}

// imagePaths resolves a message's upload ids to their files. A client never
// names a path: an id that is not a finished upload of this server is
// refused, and the bad ids are returned so the composer can mark them.
func (a *agentAPI) imagePaths(ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if len(ids) > agentMaxImages {
		return nil, fail(http.StatusBadRequest, "invalid_request", "too many images")
	}
	if a.uploads == nil {
		return nil, fail(http.StatusServiceUnavailable, "uploads_unavailable", "uploads are not available on this server")
	}
	var paths, bad []string
	for _, id := range ids {
		p, ok := a.uploads.lookup(id)
		if !ok {
			bad = append(bad, id)
			continue
		}
		paths = append(paths, p)
	}
	if len(bad) > 0 {
		return nil, &agentFailure{status: http.StatusBadRequest, code: "invalid_request", msg: "an image is no longer on the server", images: bad}
	}
	return paths, nil
}

// sendMessage pastes the images, each path on its own, then text into an
// empty input box of session and submits it.
func (a *agentAPI) sendMessage(ctx context.Context, wr agentWriter, paneID, session, text string, paths []string) error {
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
	sc := readAgentScreen(s.Agent, screen)
	// Neither the box nor a dialog: the agent may be redrawing (an answer
	// returns as soon as its dialog leaves the screen, before the box is
	// back). Wait for the screen to settle, then read the session again.
	if sc.input == inputNone && sc.prompt == nil {
		pollScreen(ctx, wr, s.Agent, s.Target, func(now agentScreen) bool {
			sc = now
			return now.input != inputNone || now.prompt != nil
		})
		now, err := sessionNow(ctx, wr, paneID)
		if err != nil {
			return err
		}
		if !sameAgent(now, s) {
			return errSessionChanged
		}
		if err := inputReady(now); err != nil {
			return err
		}
	}
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
	// The same idle agent before every paste that follows an image.
	stillReady := func() bool {
		now, err := sessionNow(ctx, wr, paneID)
		return err == nil && sameAgent(now, s) && inputReady(now) == nil
	}
	// An image path becomes the agent's token only when pasted alone, so
	// each goes in its own paste, confirmed before the next.
	for i, p := range paths {
		if i > 0 && !stillReady() {
			return a.abandon(ctx, wr, paneID, s, i, "", errPartialPaste)
		}
		if err := wr.Paste(ctx, s.Target, pasteablePath(p)); err != nil {
			return a.abandon(ctx, wr, paneID, s, i+1, "", err)
		}
		n := i + 1
		shown := pollScreenFor(ctx, wr, s.Agent, s.Target, agentImageWait, func(sc agentScreen) bool {
			return sc.input == inputDraft && draftShowsImages(sc.draft, n, "")
		})
		if !shown {
			return a.abandon(ctx, wr, paneID, s, n, "", fail(http.StatusConflict, "paste_not_confirmed", "the image did not show in the input box"))
		}
	}
	n := len(paths)
	pasted := text
	if n > 0 {
		pasted = ""
		if strings.TrimSpace(text) != "" {
			pasted = " " + text // Claude Code adds no space after an image token
		}
	}
	// Text alone is read again right before it goes: an agent that exited
	// since the screen check leaves a shell, which runs each line of it.
	if n == 0 {
		now, err := sessionNow(ctx, wr, paneID)
		if err != nil {
			return err
		}
		if !sameAgent(now, s) {
			return errSessionChanged
		}
		if err := inputReady(now); err != nil {
			return err
		}
	}
	if pasted != "" {
		if n > 0 && !stillReady() {
			return a.abandon(ctx, wr, paneID, s, n, "", errPartialPaste)
		}
		if err := wr.Paste(ctx, s.Target, pasted); err != nil {
			if n > 0 {
				return a.abandon(ctx, wr, paneID, s, n, pasted, err)
			}
			return err
		}
	}
	shows := func(sc agentScreen) bool {
		if n == 0 {
			return sc.input == inputDraft && draftShows(sc.draft, text)
		}
		return sc.input == inputDraft && draftShowsImages(sc.draft, n, pasted)
	}
	if !pollScreen(ctx, wr, s.Agent, s.Target, shows) {
		notShown := fail(http.StatusConflict, "paste_not_confirmed", "the pasted text did not show in the input box")
		if n > 0 {
			return a.abandon(ctx, wr, paneID, s, n, pasted, notShown)
		}
		return notShown
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
	// Submitted: the box holds no draft. A different draft is no submit:
	// Enter can take a completion instead (Codex's `@` mention popup turns
	// "@a" into a file or plugin name and keeps the text in the composer).
	if !pollScreen(ctx, wr, s.Agent, s.Target, func(sc agentScreen) bool { return sc.input != inputDraft }) {
		return fail(http.StatusBadGateway, "delivered_not_submitted", "the text was pasted but not submitted")
	}
	return nil
}

// abandon ends a message with images that failed after its first paste. The
// box is cleared (C-c, sent once: on an empty box it arms the agent's exit)
// only when the same agent still runs and the box holds nothing but what this
// request pasted, k images at most and then pasted; then failure is returned
// as is. Anything else is left for the user, as partial_paste.
func (a *agentAPI) abandon(ctx context.Context, wr agentWriter, paneID string, s AgentSession, k int, pasted string, failure error) error {
	var f *agentFailure
	if !errors.As(failure, &f) {
		log.Printf("agent message: paste: %v", failure)
		failure = fail(http.StatusBadGateway, "paste_not_confirmed", "the message could not be pasted")
	}
	// C-c to a working agent would interrupt it.
	now, err := sessionNow(ctx, wr, paneID)
	if err != nil || !sameAgent(now, s) || inputReady(now) != nil {
		return errPartialPaste
	}
	screen, err := wr.Capture(ctx, s.Target)
	if err != nil {
		return errPartialPaste
	}
	sc := readAgentScreen(s.Agent, screen)
	if sc.input == inputEmpty {
		return failure
	}
	if sc.input != inputDraft || !ownDraft(sc.draft, k, pasted) {
		return errPartialPaste
	}
	if err := wr.SendKeySequence(ctx, s.Target, []string{"C-c"}); err != nil {
		return errPartialPaste
	}
	if !pollScreen(ctx, wr, s.Agent, s.Target, func(sc agentScreen) bool { return sc.input == inputEmpty }) {
		return errPartialPaste
	}
	return failure
}

// ownDraft: the box holds part of what a request pasted, k images and then
// pasted (empty when no text was pasted): k-1 or k image tokens, and with
// k tokens the text or nothing. A path the agent left as text is not ours to
// recognise, so it is not cleared.
func ownDraft(draft string, k int, pasted string) bool {
	if draftShowsImages(draft, k, "") || (k > 1 && draftShowsImages(draft, k-1, "")) {
		return true
	}
	return pasted != "" && draftShowsImages(draft, k, pasted)
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
func pollScreen(ctx context.Context, wr agentWriter, agent, target string, ok func(agentScreen) bool) bool {
	return pollScreenFor(ctx, wr, agent, target, agentConfirmWait, ok)
}

// pollScreenFor captures until ok holds or wait passes.
func pollScreenFor(ctx context.Context, wr agentWriter, agent, target string, wait time.Duration, ok func(agentScreen) bool) bool {
	deadline := time.Now().Add(wait)
	for {
		if screen, err := wr.Capture(ctx, target); err == nil && ok(readAgentScreen(agent, screen)) {
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
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	// A read, but a cross-site page has no reason to start one (with
	// --no-auth it would make the server read the transcript for nothing).
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	wr, ok := a.writer(w)
	if !ok {
		return
	}
	paneID := r.PathValue("id")
	s, err := a.session(paneID)
	if err == nil && agentScreenReaders[s.Agent] == nil {
		err = errAgentUnsupported
	}
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
	sc := readAgentScreen(s.Agent, screen)
	if isViewOnly(r) {
		jsonOK(w, promptResponse{Prompt: viewPrompt(sc)})
		return
	}
	jsonOK(w, promptResponse{Prompt: a.promptOf(paneID, s, sc)})
}

// viewPrompt is the card a view-only client gets: the dialog without a
// promptId, and nothing recorded about it.
func viewPrompt(sc agentScreen) *AgentPrompt {
	if sc.prompt == nil {
		return nil
	}
	p := *sc.prompt
	p.PromptID = ""
	return &p
}

// promptOf turns a screen's dialog into the card the client gets.
func (a *agentAPI) promptOf(paneID string, s AgentSession, sc agentScreen) *AgentPrompt {
	if sc.prompt == nil {
		a.input.answered(paneID, "") // the screen left the dialog
		return nil
	}
	p := *sc.prompt
	if s.DialogsReadOnly {
		// Never answerable here: the card says to answer in the terminal
		// instead of waiting for a status that never comes.
		p.Kind, p.Options = "unsupported", nil
	}
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
	// A typed answer takes up to one poll per key; once text is typed, the
	// key that submits it must follow even if the client goes away.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 12*agentConfirmWait+muxTimeout)
	defer cancel()
	if err := a.answer(ctx, wr, paneID, body.PromptID, body.Choice); err != nil {
		a.writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *agentAPI) answer(ctx context.Context, wr agentWriter, paneID, promptID string, choice json.RawMessage) error {
	var key, text string
	step := -1
	typed := false
	rec, err := a.input.consumePrompt(paneID, promptID, func(r *promptRecord) error {
		key = choiceKey(r.prompt, choice)
		if key == "" {
			step = choiceStep(r.prompt, choice)
		}
		if key == "" && step < 0 {
			var err error
			if text, typed, err = choiceText(r.prompt, choice); typed || err != nil {
				return err
			}
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
	sc := readAgentScreen(s.Agent, screen)
	// A typed answer also needs the free-text option ready now: the
	// signature leaves out the pointer, which a multiSelect tab moves from.
	if sc.prompt == nil || sc.sig != rec.sig || sc.prompt.Kind == "unsupported" || !dialogStatus(s) || (typed && sc.prompt.FreeText == nil) {
		f := fail(http.StatusConflict, "prompt_changed", "the screen changed; check the dialog again")
		f.prompt = a.promptOf(paneID, s, sc)
		return f
	}
	// From here the dialog counts as answered: no new id is issued for it
	// until the screen moves on, so a second device cannot answer the
	// dialog that follows in its place.
	a.input.markAnswered(paneID, rec.sig)
	if step >= 0 {
		return a.moveToStep(ctx, wr, paneID, s, rec, step)
	}
	if typed {
		return a.typeAnswer(ctx, wr, paneID, s, rec, sc, text)
	}
	closeFrom := rec.sig
	if n, err := strconv.Atoi(key); err == nil && rec.prompt.moveThenEnter {
		// A question with previews: the digit moves the pointer, then Enter
		// picks the option, once the screen shows the pointer on it.
		if sc.prompt.pointer != n {
			moved, err := a.movePointer(ctx, wr, paneID, s, rec, key, n)
			if err != nil {
				return err
			}
			closeFrom = moved
		}
		key = "Enter"
	}
	if err := wr.SendKeySequence(ctx, s.Target, []string{key}); err != nil {
		return err
	}
	closed := pollScreen(ctx, wr, s.Agent, s.Target, func(sc agentScreen) bool { return sc.sig != closeFrom })
	if !closed {
		return fail(http.StatusBadGateway, "answer_not_confirmed", "the key was sent but the dialog is still open")
	}
	return nil
}

// movePointer sends an option's digit to a question with previews and
// waits for the pointer to be on that option of the same question. It
// returns the signature of that screen. Enter follows without another
// read: a pointer moved in the terminal within that poll interval would get
// the Enter, a window as small as the one between any check and its key.
func (a *agentAPI) movePointer(ctx context.Context, wr agentWriter, paneID string, s AgentSession, rec *promptRecord, key string, n int) (string, error) {
	if err := wr.SendKeySequence(ctx, s.Target, []string{key}); err != nil {
		return "", err
	}
	var next agentScreen
	moved := pollScreen(ctx, wr, s.Agent, s.Target, func(sc agentScreen) bool {
		next = sc
		return sc.prompt != nil && sc.prompt.pointer == n
	})
	if !moved || !sameQuestion(next.prompt, &rec.prompt) {
		f := fail(http.StatusConflict, "prompt_changed", "the screen changed; check the dialog again")
		if !moved && next.prompt != nil && sameQuestion(next.prompt, &rec.prompt) {
			f = fail(http.StatusBadGateway, "answer_not_confirmed", "the pointer did not move to that option")
		}
		f.prompt = a.promptOf(paneID, s, next)
		return "", f
	}
	a.input.markAnswered(paneID, next.sig)
	return next.sig, nil
}

// sameQuestion: the same question, by its title, text, tabs and options.
func sameQuestion(a, b *AgentPrompt) bool {
	if a == nil || a.Kind != b.Kind || a.Title != b.Title || a.Body != b.Body || !sameTabs(a.Steps, b.Steps) || len(a.Options) != len(b.Options) {
		return false
	}
	for i := range a.Options {
		if a.Options[i].Index != b.Options[i].Index || a.Options[i].Label != b.Options[i].Label {
			return false
		}
	}
	return true
}

// moveToStep opens another tab of a wizard one arrow at a time. After each
// key the screen must show the same wizard (its tabs by label: one that asks
// the very same questions again in between is not told apart) with the next
// tab open, and a tab the arrow passes must be one this code reads (not one
// with text being typed); anything else stops before the next key and
// answers with the dialog on screen. The pane's lock is held throughout.
func (a *agentAPI) moveToStep(ctx context.Context, wr agentWriter, paneID string, s AgentSession, rec *promptRecord, target int) error {
	cur := currentStep(rec.prompt.Steps)
	key, dir := "Right", 1
	if target < cur {
		key, dir = "Left", -1
	}
	prev := rec.sig
	for cur != target {
		if err := wr.SendKeySequence(ctx, s.Target, []string{key}); err != nil {
			return err
		}
		var next agentScreen
		moved := pollScreen(ctx, wr, s.Agent, s.Target, func(sc agentScreen) bool {
			next = sc
			return sc.sig != prev
		})
		if !moved {
			f := fail(http.StatusBadGateway, "step_not_confirmed", "the tab did not change")
			f.prompt = a.promptOf(paneID, s, next)
			return f
		}
		cur += dir
		passing := cur != target && next.prompt != nil && next.prompt.Kind == "unsupported"
		if next.prompt == nil || passing || !sameTabs(next.prompt.Steps, rec.prompt.Steps) || currentStep(next.prompt.Steps) != cur {
			f := fail(http.StatusConflict, "prompt_changed", "the screen changed; check the dialog again")
			f.prompt = a.promptOf(paneID, s, next)
			return f
		}
		if cur != target {
			a.input.markAnswered(paneID, next.sig)
		}
		prev = next.sig
	}
	return nil
}

// sameTabs: the same wizard, its tabs read by label (moving across a
// multiSelect tab can mark it answered).
func sameTabs(a, b []PromptStep) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Label != b[i].Label {
			return false
		}
	}
	return true
}

// dialogStatus: the agent's own status must say a dialog is open; the screen
// alone is not enough. Claude Code: where its status is known from its
// session file (tmux, PID set), it must say blocked. Codex: herdr reports it
// blocked; on tmux its rollout records no approval request, so it never is
// (DialogsReadOnly).
func dialogStatus(s AgentSession) bool {
	switch s.Agent {
	case "claude":
		return s.PID == 0 || s.Status == "blocked"
	case "codex":
		return s.Status == "blocked"
	}
	return false
}

// choiceKey is the key for a choice: an option's number, "cancel" for
// Escape, or "next" for Right on a multiSelect tab (it leaves the tab with
// the options ticked). Anything else is "".
func choiceKey(p AgentPrompt, choice json.RawMessage) string {
	var name string
	if json.Unmarshal(choice, &name) == nil {
		switch {
		case name == "cancel":
			return "Escape"
		case name == "next" && p.Kind == "multiselect":
			return "Right"
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

// choiceStep is the tab a choice {"step": n} opens: another tab of the
// wizard on screen. Anything else is -1.
func choiceStep(p AgentPrompt, choice json.RawMessage) int {
	var c struct {
		Step *int `json:"step"`
	}
	if json.Unmarshal(choice, &c) != nil || c.Step == nil || !wholeTabs(p.Steps) {
		return -1
	}
	if n := *c.Step; n >= 0 && n < len(p.Steps) && n != currentStep(p.Steps) {
		return n
	}
	return -1
}

// choiceText is the text of a choice {"text": "..."}: typed reports a
// choice of that shape, err why it is refused. The text is refused whole,
// never cut or cleaned: a control character (a newline included) or more
// than agentMaxFreeText bytes is not sent at all.
func choiceText(p AgentPrompt, choice json.RawMessage) (text string, typed bool, err error) {
	var c struct {
		Text *string `json:"text"`
	}
	if json.Unmarshal(choice, &c) != nil || c.Text == nil {
		return "", false, nil
	}
	text = *c.Text
	switch {
	case p.FreeText == nil:
		return "", true, fail(http.StatusBadRequest, "invalid_choice", "this question takes no typed answer")
	case len(text) > agentMaxFreeText:
		return "", true, errFreeTooLong
	case strings.TrimSpace(text) == "":
		return "", true, fail(http.StatusBadRequest, "invalid_text", "text is empty")
	case strings.IndexFunc(text, unicode.IsControl) >= 0:
		return "", true, fail(http.StatusBadRequest, "invalid_text", "text has a control character")
	}
	return text, true, nil
}

// typeAnswer answers a question with text typed into its free-text option,
// one key at a time, each followed by a read of the screen:
//
//  1. the pointer onto the option: its digit on a single-choice question,
//     Down a row at a time on a multiSelect tab (a digit there toggles it);
//  2. the text, pasted once the option shows its placeholder under the
//     pointer;
//  3. once the option shows the text: Enter on a single-choice question,
//     which picks it; Up on a multiSelect tab, which leaves the text ticked
//     and the tab answerable again.
//
// Escape is never sent: inside the option it leaves the whole dialog. Any
// read that does not show the step's effect on the same question stops
// before the next key and answers with the dialog on screen.
func (a *agentAPI) typeAnswer(ctx context.Context, wr agentWriter, paneID string, s AgentSession, rec *promptRecord, sc agentScreen, text string) error {
	want := rec.prompt.free
	multi := rec.prompt.Kind == "multiselect"
	var next agentScreen
	// step sends key and waits for ok on the same question. A screen
	// reached on the way (hold) gets no promptId while it shows.
	step := func(key string, ok func(*AgentPrompt) bool, missed string, hold bool) error {
		if err := wr.SendKeySequence(ctx, s.Target, []string{key}); err != nil {
			return err
		}
		done := pollScreen(ctx, wr, s.Agent, s.Target, func(sc agentScreen) bool {
			next = sc
			return sameFreeQuestion(sc.prompt, &rec.prompt) && ok(sc.prompt)
		})
		if done {
			if hold {
				a.input.markAnswered(paneID, next.sig)
			}
			return nil
		}
		f := fail(http.StatusConflict, "prompt_changed", "the screen changed; check the dialog again")
		if sameFreeQuestion(next.prompt, &rec.prompt) {
			f = fail(http.StatusBadGateway, "answer_not_confirmed", missed)
		}
		f.prompt = a.promptOf(paneID, s, next)
		return f
	}
	inField := func(p *AgentPrompt) bool { return p.pointer == want.index && p.free.empty }
	if multi {
		for row := sc.prompt.pointer + 1; row <= want.index; row++ {
			at := row
			if err := step("Down", func(p *AgentPrompt) bool {
				return p.pointer == at && (at < want.index || inField(p))
			}, "the pointer did not move to the free-text option", true); err != nil {
				return err
			}
		}
	} else if err := step(strconv.Itoa(want.index), inField, "the pointer did not move to the free-text option", true); err != nil {
		return err
	}
	// The same process and session, still on the dialog, right before the
	// text; the same again before the key that submits it.
	still := func() bool {
		now, err := sessionNow(ctx, wr, paneID)
		return err == nil && sameAgent(now, s) && !now.InMode && dialogStatus(now)
	}
	if !still() {
		return errTargetChanged
	}
	if err := wr.Paste(ctx, s.Target, text); err != nil {
		return err
	}
	// The text itself, rows joined, spaces aside: not a token standing for
	// a paste, which would be the text submitted.
	strip := func(s string) string { return strings.Join(strings.Fields(s), "") }
	shows := func(p *AgentPrompt) bool {
		return !p.free.empty && strip(p.free.value) == strip(text) && (!multi || p.free.checked)
	}
	shown := pollScreen(ctx, wr, s.Agent, s.Target, func(sc agentScreen) bool {
		next = sc
		return sameFreeQuestion(sc.prompt, &rec.prompt) && sc.prompt.pointer == want.index && shows(sc.prompt)
	})
	if !shown {
		f := fail(http.StatusBadGateway, "text_not_confirmed", "the text did not show in the free-text option; check it in the terminal")
		f.prompt = a.promptOf(paneID, s, next)
		return f
	}
	a.input.markAnswered(paneID, next.sig)
	if !still() {
		return fail(http.StatusBadGateway, "text_not_confirmed", "the text is in the free-text option but was not submitted")
	}
	if multi {
		// Up leaves the option, onto the tab the card answers again.
		return step("Up", func(p *AgentPrompt) bool { return p.pointer == want.index-1 && shows(p) },
			"the text is ticked but the pointer is still in it", false)
	}
	typedSig := next.sig
	if err := wr.SendKeySequence(ctx, s.Target, []string{"Enter"}); err != nil {
		return err
	}
	if !pollScreen(ctx, wr, s.Agent, s.Target, func(sc agentScreen) bool { return sc.sig != typedSig }) {
		return fail(http.StatusBadGateway, "answer_not_confirmed", "Enter was sent but the dialog is still open")
	}
	return nil
}

// sameFreeQuestion: the question a typed answer was meant for, by its title,
// text, tabs and free-text option. The options themselves are not compared:
// with the pointer on the free-text option the card has none.
func sameFreeQuestion(a, b *AgentPrompt) bool {
	return a != nil && a.Title == b.Title && a.Body == b.Body && sameTabs(a.Steps, b.Steps) && a.free.index == b.free.index
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
	if len(f.images) > 0 {
		body["images"] = f.images
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(f.status)
	json.NewEncoder(w).Encode(body)
}
