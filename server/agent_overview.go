package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// The overview (/api/mux/overview) gives, for every pane with an agent in the
// last snapshot the activity tracker observed, what the snapshot does not: the
// agent's last message, when it last wrote, how full its context is, and the
// branch and number of changed files of its directory, plus the rate limits
// of every Codex account a pane uses (agent_context_window.go). One read serves every
// card, so the PWA polls once instead of once per card. The request never
// reads the panes itself and never runs git: changes come from a cache filled
// in the background, one git status at a time, only when a slot is free.

const (
	// overviewTTL: every client polling the overview shares one read.
	overviewTTL = 2 * time.Second
	// overviewMaxPanes panes with an agent are summarized, in snapshot order.
	overviewMaxPanes = 64
	// overviewParallel transcripts are read at once.
	overviewParallel = 4
	// overviewTextMax runes of the last message are sent.
	overviewTextMax = 280
	// overviewChangesTTL: a directory's changes are read again after this.
	overviewChangesTTL = 30 * time.Second
	// overviewChangesKeep: changes of a pane not asked for in this long are
	// dropped.
	overviewChangesKeep = 5 * time.Minute
)

// overviewBudget bounds the transcript reads of one overview; a pane not
// read by then answers unavailable: ["transcript"]. A variable for tests.
var overviewBudget = 3 * time.Second

// overviewUsage is how full a pane's context is. ContextPercent is absent
// when the window is not known; Exact is false when it is assumed (Claude
// Code without --model in its argv).
type overviewUsage struct {
	ContextTokens  int64    `json:"contextTokens"`
	Model          string   `json:"model,omitempty"`
	ContextWindow  int64    `json:"contextWindow,omitempty"`
	ContextPercent *float64 `json:"contextPercent,omitempty"`
	Exact          bool     `json:"exact"`
}

// overviewAccount is one Codex account's rate limits, as the newest
// token_count row of any pane using it recorded them. Key is a keyed hash of
// its CODEX_HOME (accountKey), never the path.
type overviewAccount struct {
	Key       string        `json:"key"`
	Agent     string        `json:"agent"`
	Plan      string        `json:"plan,omitempty"`
	Windows   []usageWindow `json:"windows"`
	UpdatedAt string        `json:"updatedAt"`
}

// usageWindow is one rate limit window: the share used, its length and when
// it resets (RFC 3339, absent when unknown).
type usageWindow struct {
	UsedPercent   float64 `json:"usedPercent"`
	WindowMinutes int     `json:"windowMinutes"`
	ResetsAt      string  `json:"resetsAt,omitempty"`
}

// overviewPane is one card's data. Unavailable names what could not be read
// this time ("transcript", "changes"); the client shows it as pending.
type overviewPane struct {
	PaneID           string         `json:"paneId"`
	Key              string         `json:"key"`
	LastText         string         `json:"lastText,omitempty"`
	LastTS           string         `json:"lastTs,omitempty"`
	Branch           string         `json:"branch,omitempty"`
	Changed          *int           `json:"changed,omitempty"`
	ChangedTruncated bool           `json:"changedTruncated,omitempty"`
	Usage            *overviewUsage `json:"usage,omitempty"`
	AccountKey       string         `json:"accountKey,omitempty"`
	Unavailable      []string       `json:"unavailable,omitempty"`
	// change: the pane's directory as last read, for the role check of
	// each request (a view-only client never sees a home dir's changes).
	change *overviewChange
}

type overviewResponse struct {
	ServerNow string            `json:"serverNow"`
	Panes     []overviewPane    `json:"panes"`
	Accounts  []overviewAccount `json:"accounts,omitempty"`
}

// overviewRead is one read of the overview, shared by every client.
type overviewRead struct {
	panes    []overviewPane
	accounts []overviewAccount
}

func (a *agentAPI) handleOverview(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	// A read naming every agent's last words: same-site only, as the
	// transcript.
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	// ?pane=<id> (the header's usage chip): that pane alone, without changes.
	// Only a pane with an agent in the snapshot gets a cache entry, so an
	// arbitrary id costs nothing.
	only := r.URL.Query().Get("pane")
	if only != "" {
		// A tmux tab id names its active pane (findSnapshotPane).
		snap, _ := a.activity.lastSnapshot()
		if _, _, p, ok := findSnapshotPane(snap, only, !a.m.Caps().ClientSideSelect); ok {
			only = p.ID
		}
	}
	var read overviewRead
	switch {
	case only == "":
		read, _ = a.overview.do("", func() (overviewRead, error) { return a.readOverview(""), nil })
	case a.agentPaneInSnapshot(only):
		read, _ = a.overview.do("pane\x00"+only, func() (overviewRead, error) { return a.readOverview(only), nil })
	default:
		read = overviewRead{panes: []overviewPane{}}
	}
	res := overviewResponse{ServerNow: time.Now().UTC().Format(activityTimeFormat),
		Panes: make([]overviewPane, len(read.panes)), Accounts: read.accounts}
	viewOnly := isViewOnly(r)
	for i, p := range read.panes {
		if c := p.change; c != nil && c.status && !(viewOnly && c.viewHidden) {
			n := c.changed
			p.Branch, p.Changed, p.ChangedTruncated = c.branch, &n, c.truncated
		}
		res.Panes[i] = p
	}
	jsonOK(w, res)
}

// agentPaneInSnapshot reports whether the tracker's last snapshot has an
// agent in pane id.
func (a *agentAPI) agentPaneInSnapshot(id string) bool {
	snap, _ := a.activity.lastSnapshot()
	for _, g := range snap.Groups {
		for _, t := range g.Tabs {
			for _, p := range t.Panes {
				if p.ID == id && p.Agent != nil {
					return true
				}
			}
		}
	}
	return false
}

// readOverview summarizes every pane with an agent in the tracker's last
// snapshot, and gathers the accounts of the Codex panes read in time. With
// only set, it reads that pane alone and leaves its changes out (no git
// status is queued for it).
func (a *agentAPI) readOverview(only string) overviewRead {
	snap, _ := a.activity.lastSnapshot()
	var panes []overviewPane
	for _, g := range snap.Groups {
		for _, t := range g.Tabs {
			for _, p := range t.Panes {
				if p.Agent != nil && len(panes) < overviewMaxPanes && (only == "" || p.ID == only) {
					panes = append(panes, overviewPane{PaneID: p.ID, Key: activityKey(t, p)})
				}
			}
		}
	}
	if panes == nil {
		return overviewRead{panes: []overviewPane{}}
	}
	f := a.files
	filesOn := f != nil && f.dirs != nil && a.m.Caps().Files
	for i := range panes {
		if only != "" {
			break
		}
		p := &panes[i]
		if !filesOn {
			p.Unavailable = append(p.Unavailable, "changes")
			continue
		}
		c, ok := a.changes.lookup(f, p.Key, p.PaneID)
		switch {
		case !ok || c.failed:
			p.Unavailable = append(p.Unavailable, "changes")
		default:
			p.change = &c
		}
	}

	type result struct {
		i   int
		sum transcriptSummary
		err error
	}
	results := make(chan result, len(panes))
	sem := make(chan struct{}, overviewParallel)
	for i := range panes {
		go func() {
			sem <- struct{}{}
			defer func() { <-sem }()
			sum, err := a.summarizePane(panes[i].PaneID)
			results <- result{i, sum, err}
		}()
	}
	deadline := time.NewTimer(overviewBudget)
	defer deadline.Stop()
	done := make([]bool, len(panes))
	// By pane, so the accounts keep the panes' order whatever read ends first.
	limits := make([]*codexLimits, len(panes))
	for left := len(panes); left > 0; left-- {
		select {
		case r := <-results:
			done[r.i] = true
			p := &panes[r.i]
			switch {
			case r.err == nil:
				p.LastText, p.LastTS, p.Usage = r.sum.lastText, r.sum.lastTS, r.sum.usage
				if r.sum.limits != nil {
					p.AccountKey = accountKey(r.sum.codexHome)
					limits[r.i] = r.sum.limits
				}
			case errors.Is(r.err, errNoAgentSession), errors.Is(r.err, errNoTranscript), errors.Is(r.err, errAgentUnsupported):
				// Nothing to summarize: no card text, nothing pending.
			default:
				log.Printf("overview: pane %s: %v", p.PaneID, r.err)
				p.Unavailable = append(p.Unavailable, "transcript")
			}
		case <-deadline.C:
			// The reads still running fill the caches for the next one.
			for i := range panes {
				if !done[i] {
					panes[i].Unavailable = append(panes[i].Unavailable, "transcript")
				}
			}
			return overviewRead{panes, gatherAccounts(paneLimitsOf(panes, limits))}
		}
	}
	return overviewRead{panes, gatherAccounts(paneLimitsOf(panes, limits))}
}

// paneLimitsOf pairs each pane's account key with the limits its read
// found, in pane order.
func paneLimitsOf(panes []overviewPane, limits []*codexLimits) []paneLimits {
	var out []paneLimits
	for i, l := range limits {
		if l != nil {
			out = append(out, paneLimits{panes[i].AccountKey, l})
		}
	}
	return out
}

// paneLimits is the rate limits a pane's transcript recorded for its account.
type paneLimits struct {
	key    string
	limits *codexLimits
}

// gatherAccounts keeps, for each account, the limits recorded last by any of
// its panes, in the order the panes came.
func gatherAccounts(limits []paneLimits) []overviewAccount {
	var out []overviewAccount
	at := map[string]int{}
	for _, l := range limits {
		acc := overviewAccount{Key: l.key, Agent: "codex", Plan: l.limits.plan, Windows: l.limits.windows, UpdatedAt: l.limits.ts}
		i, ok := at[l.key]
		switch {
		case !ok:
			at[l.key] = len(out)
			out = append(out, acc)
		case l.limits.ts > out[i].UpdatedAt: // one UTC format: text order is time order
			out[i] = acc
		}
	}
	return out
}

// summarizePane reads the end of the pane's transcript through the cache
// the Chat view's first read uses.
func (a *agentAPI) summarizePane(paneID string) (transcriptSummary, error) {
	s, err := a.session(paneID)
	if err != nil {
		return transcriptSummary{}, err
	}
	res, err := a.readCached(s, "", "")
	if err != nil {
		return transcriptSummary{}, err
	}
	if s.Agent == "claude" {
		s.ClaudeWindow = a.claudeWindow(s)
	}
	sum := summarizeTranscript(res.Entries, s)
	if sum.limits != nil {
		sum.codexHome = codexAccountHome(s, os.Getenv, a.home)
	}
	// An agent waiting on its subagents writes nothing itself: when one of
	// them wrote later, that is the agent's last activity.
	if w, err := a.subagentLastWrite(s); err == nil && !w.IsZero() {
		if last, err := time.Parse(time.RFC3339Nano, sum.lastTS); err != nil || w.After(last) {
			sum.lastTS = w.UTC().Format(activityTimeFormat)
		}
	}
	return sum, nil
}

// claudeWindow is the context window of s's model: the one its transcript
// last names, else the one its argv chose (0: neither tells).
func (a *agentAPI) claudeWindow(s AgentSession) int64 {
	path, err := claudeJournal{}.Locate(s)
	if err != nil {
		return s.ClaudeWindow
	}
	model, err := a.claudeModels.model(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, errClaudeModelBusy) {
			log.Printf("overview: claude model: %v", err)
		}
		return s.ClaudeWindow
	}
	if w, ok := claudeWindowOfModel(model); ok {
		return w
	}
	return s.ClaudeWindow
}

// transcriptSummary is what a card shows of a transcript, and the rate
// limits it recorded for the account of codexHome.
type transcriptSummary struct {
	lastText  string
	lastTS    string
	usage     *overviewUsage
	limits    *codexLimits
	codexHome string
}

// summarizeTranscript reads, from the newest entry back: the time of the
// last one that has one, the text of the last assistant entry with text
// (never a tool result), the usage of the last assistant row that has one,
// and the last rate limits. Every row of one message repeats its usage, so
// the last one is the message's, never a sum. s gives the agent and the
// session's Claude window.
func summarizeTranscript(entries []TranscriptEntry, s AgentSession) transcriptSummary {
	var sum transcriptSummary
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if sum.lastTS == "" && e.TS != "" {
			sum.lastTS = e.TS
		}
		if e.Role != "assistant" {
			continue
		}
		if u := e.usage; u != nil {
			if sum.usage == nil && !u.noContext {
				sum.usage = &overviewUsage{ContextTokens: u.contextTokens, Model: u.model}
				window, pct, exact := contextShare(s.Agent, u.contextTokens, u.model, s.ClaudeWindow, u.window)
				if window > 0 {
					sum.usage.ContextWindow, sum.usage.ContextPercent, sum.usage.Exact = window, &pct, exact
				}
			}
			if sum.limits == nil {
				sum.limits = u.limits
			}
		}
		if sum.lastText == "" {
			for j := len(e.Parts) - 1; j >= 0; j-- {
				if p := e.Parts[j]; p.Kind == "text" && strings.TrimSpace(p.Text) != "" {
					sum.lastText = cutRunes(strings.Join(strings.Fields(p.Text), " "), overviewTextMax)
					break
				}
			}
		}
	}
	return sum
}

// cutRunes is s cut to at most n runes.
func cutRunes(s string, n int) string {
	i := 0
	for j := range s {
		if i == n {
			return s[:j]
		}
		i++
	}
	return s
}

// overviewChange is a pane's directory as the background read found it:
// its root, and with status set its branch and number of changed files.
// failed: the root or the status could not be read.
type overviewChange struct {
	root      filesRoot
	status    bool
	branch    string
	changed   int
	truncated bool
	failed    bool
	// viewHidden: a view-only client may not read the root (viewHidesRoot)
	viewHidden bool
	at         time.Time // when read
	asked      time.Time // when last looked up
}

type overviewJob struct{ key, paneID string }

// overviewChanges caches each pane's changes by its key, read in the
// background by one worker at a time. A status runs only when a git slot is
// free (tryOnly) and its timeout never backs the root off, so a client's
// Changes view never waits for it; a status the Changes view has just read
// is used instead of running one.
type overviewChanges struct {
	now     func() time.Time
	mu      sync.Mutex
	byKey   map[string]overviewChange
	queue   []overviewJob
	queued  map[string]bool
	running bool
	// runJob is refresh; a test replaces it.
	runJob func(f *filesAPI, j overviewJob) (overviewChange, bool)
}

func newOverviewChanges() *overviewChanges {
	c := &overviewChanges{now: time.Now, byKey: map[string]overviewChange{}, queued: map[string]bool{}}
	c.runJob = c.refresh
	return c
}

// lookup returns the pane's cached changes, and queues a read when there are
// none or they are older than overviewChangesTTL.
func (c *overviewChanges) lookup(f *filesAPI, key, paneID string) (overviewChange, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, v := range c.byKey {
		if now.Sub(v.asked) >= overviewChangesKeep {
			delete(c.byKey, k)
		}
	}
	v, ok := c.byKey[key]
	if ok {
		v.asked = now
		c.byKey[key] = v
	}
	if (!ok || now.Sub(v.at) >= overviewChangesTTL) && !c.queued[key] {
		c.queued[key] = true
		c.queue = append(c.queue, overviewJob{key, paneID})
		if !c.running {
			c.running = true
			go c.work(f)
		}
	}
	return v, ok
}

// work reads the queued panes one at a time until none is left.
func (c *overviewChanges) work(f *filesAPI) {
	for {
		c.mu.Lock()
		if len(c.queue) == 0 {
			c.running = false
			c.mu.Unlock()
			return
		}
		j := c.queue[0]
		c.queue = c.queue[1:]
		c.mu.Unlock()
		v, ok := c.runJob(f, j)
		c.mu.Lock()
		delete(c.queued, j.key)
		if ok {
			v.asked = c.now()
			c.byKey[j.key] = v
		}
		c.mu.Unlock()
	}
}

// refresh reads the pane's root and status; ok is false when every git slot
// was taken (nothing is stored: the next lookup queues it again).
func (c *overviewChanges) refresh(f *filesAPI, j overviewJob) (overviewChange, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), filesTimeout)
	defer cancel()
	v := overviewChange{at: c.now()}
	root, err := f.paneRootForRead(ctx, j.paneID)
	if err != nil {
		log.Printf("overview: root of pane %s: %v", j.paneID, err)
		v.failed = true
		return v, true
	}
	v.root, v.viewHidden = root, f.viewHidesRoot(root)
	if !root.IsRepo {
		return v, true
	}
	st, ok := f.statuses.peek(statusKey(root))
	if !ok {
		out, cut, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, noFilters: true,
			heavy: true, noBackoff: true, tryOnly: true, limit: maxStatusOutput}, gitStatusArgs...)
		if errors.Is(err, errGitBusy) {
			return v, false
		}
		if err != nil {
			log.Printf("overview: git status of pane %s: %v", j.paneID, err)
			v.failed = true
			return v, true
		}
		st = parseStatus(out, cut)
	}
	v.status, v.branch, v.changed, v.truncated = true, st.Branch, len(st.Entries), st.Truncated
	return v, true
}
