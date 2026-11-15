package main

import (
	"cmp"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Token and cost estimates, read from the agents' journals (OpenCode: its
// service's API, with the cost OpenCode itself recorded):
//
//	GET /api/mux/panes/{id}/agent/usage[?agent=&session=]  one session, its subagents apart
//	GET /api/mux/panes/{id}/agent/usage/summary            the pane root's sessions, by 15 minutes
//	GET /api/mux/usage                                     every session of the server's user, by 15 minutes
//
// Only numbers, model ids and times are returned: no path, title or text.
// The last two cover usageDays days, in buckets of 15 minutes (UTC) that the
// client folds into its own days.

const (
	// usageDays: the summaries cover today and the 7 days before in any
	// time zone.
	usageDays = 8
	// usageTTL: every client polling a summary shares one read.
	usageTTL = 30 * time.Second
	// usageSessionTTL: every client asking for one session shares a read.
	usageSessionTTL = 5 * time.Second
)

// usageMaxFiles is how many files of one agent the machine summary reads
// at most, the newest first; a variable so tests can lower it.
var usageMaxFiles = 5000

// usageTokens is a total by kind; cacheWrite adds both cache durations.
type usageTokens struct {
	Input      int64 `json:"input"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
	Output     int64 `json:"output"`
	Reasoning  int64 `json:"reasoning"`
	Total      int64 `json:"total"`
}

func usageTokensOf(c tokenCounts) usageTokens {
	return usageTokens{Input: c.input, CacheRead: c.cacheRead, CacheWrite: c.cacheWrite5m + c.cacheWrite1h,
		Output: c.output, Reasoning: c.reasoning, Total: c.total()}
}

// usageModel is one model's share. CostUSD is absent for a model without a
// price.
type usageModel struct {
	ID      string   `json:"id"`
	Tokens  int64    `json:"tokens"`
	CostUSD *float64 `json:"costUsd,omitempty"`
}

// usagePart is a total and its estimated cost (absent when none of its
// tokens has a price), with the tokens of models without one.
type usagePart struct {
	Tokens         int64    `json:"tokens"`
	CostUSD        *float64 `json:"costUsd,omitempty"`
	UnpricedTokens int64    `json:"unpricedTokens,omitempty"`
}

// usageSummary is one session's usage: every token, by kind and by model,
// and the share of its subagents (absent without any).
type usageSummary struct {
	Tokens         usageTokens  `json:"tokens"`
	CostUSD        *float64     `json:"costUsd,omitempty"`
	UnpricedTokens int64        `json:"unpricedTokens,omitempty"`
	UnpricedModels []string     `json:"unpricedModels,omitempty"`
	Models         []usageModel `json:"models"`
	Sub            *usagePart   `json:"sub,omitempty"`
	PricesUpdated  string       `json:"pricesUpdated"`
}

// usageBucketJSON is one agent's 15 minutes.
type usageBucketJSON struct {
	T     string `json:"t"`
	Agent string `json:"agent"`
	usagePart
}

// usageBuckets is a summary over usageDays days: the buckets with tokens,
// oldest first. Truncated: not every file was read.
type usageBuckets struct {
	Buckets       []usageBucketJSON `json:"buckets"`
	Since         string            `json:"since"`
	Truncated     bool              `json:"truncated"`
	PricesUpdated string            `json:"pricesUpdated"`
}

// usagePartOf adds models' counts up.
func usagePartOf(models map[string]tokenCounts) usagePart {
	var p usagePart
	var cost float64
	priced := false
	for m, c := range models {
		p.Tokens += c.total()
		switch ok, unpriced := pricing(m, c); {
		case ok:
			cost += c.cost
			priced = true
		case unpriced:
			p.UnpricedTokens += c.total()
		}
	}
	if priced {
		p.CostUSD = usd(cost)
	}
	return p
}

// usd rounds to a hundredth of a cent.
func usd(v float64) *float64 {
	r := math.Round(v*1e4) / 1e4
	return &r
}

// summaryOf is a session's response from its totals.
func summaryOf(t *usageTotals) usageSummary {
	all := map[string]tokenCounts{}
	for _, by := range []map[string]tokenCounts{t.main, t.sub} {
		for m, c := range by {
			a := all[m]
			a.plus(c)
			all[m] = a
		}
	}
	res := usageSummary{Models: []usageModel{}, PricesUpdated: pricesUpdated}
	var sum tokenCounts
	for m, c := range all {
		sum.plus(c)
		um := usageModel{ID: m, Tokens: c.total()}
		switch ok, unpriced := pricing(m, c); {
		case ok:
			um.CostUSD = usd(c.cost)
		case unpriced:
			res.UnpricedModels = append(res.UnpricedModels, m)
		}
		res.Models = append(res.Models, um)
	}
	part := usagePartOf(all)
	res.Tokens, res.CostUSD, res.UnpricedTokens = usageTokensOf(sum), part.CostUSD, part.UnpricedTokens
	slices.SortFunc(res.Models, func(a, b usageModel) int {
		if c := cmp.Compare(b.Tokens, a.Tokens); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	slices.Sort(res.UnpricedModels)
	if len(t.sub) > 0 {
		sub := usagePartOf(t.sub)
		res.Sub = &sub
	}
	return res
}

// bucketsOf is a summary's response from its totals.
func bucketsOf(t *usageTotals, since time.Time, truncated bool) usageBuckets {
	res := usageBuckets{Buckets: []usageBucketJSON{}, Since: since.UTC().Format(time.RFC3339),
		Truncated: truncated, PricesUpdated: pricesUpdated}
	keys := make([]usageBucketKey, 0, len(t.buckets))
	for k := range t.buckets {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b usageBucketKey) int {
		if c := a.t.Compare(b.t); c != 0 {
			return c
		}
		return strings.Compare(a.agent, b.agent)
	})
	for _, k := range keys {
		p := usagePartOf(t.buckets[k])
		if p.Tokens > 0 {
			res.Buckets = append(res.Buckets, usageBucketJSON{T: k.t.Format(time.RFC3339), Agent: k.agent, usagePart: p})
		}
	}
	return res
}

// usageAPI holds the usage scanners and the shared reads.
type usageAPI struct {
	reader   *usageReader
	sessions *ttlCache[usageSummary]
	summary  *ttlCache[usageBuckets]
	now      func() time.Time
}

func newUsageAPI() *usageAPI {
	return &usageAPI{reader: newUsageReader(), sessions: newTTLCache[usageSummary](usageSessionTTL),
		summary: newTTLCache[usageBuckets](usageTTL), now: time.Now}
}

// registerUsageRoutes adds the usage routes, after registerHistoryRoutes.
func (a *agentAPI) registerUsageRoutes(mux *http.ServeMux) {
	a.usage = newUsageAPI()
	mux.HandleFunc("/api/mux/panes/{id}/agent/usage", a.handleSessionUsage)
	mux.HandleFunc("/api/mux/panes/{id}/agent/usage/summary", a.handleRootUsage)
	mux.HandleFunc("/api/mux/usage", a.handleMachineUsage)
}

// usageRead checks a usage request: a same-site GET of a client that may
// read agents.
func (a *agentAPI) usageRead(w http.ResponseWriter, r *http.Request) bool {
	if !requireMethod(w, r, http.MethodGet) {
		return false
	}
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return false
	}
	if !requireAgentRead(w, r) {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	return true
}

func (a *agentAPI) handleSessionUsage(w http.ResponseWriter, r *http.Request) {
	if !a.usageRead(w, r) {
		return
	}
	s, ok := a.sessionTarget(w, r)
	if !ok {
		return
	}
	res, err := a.sessionUsage(s)
	if err != nil {
		a.agentError(w, "agent usage", err)
		return
	}
	jsonOK(w, res)
}

// sessionUsage adds up every file of s, shared by the requests for it
// within usageSessionTTL. A session whose transcript is not written yet has
// used nothing.
func (a *agentAPI) sessionUsage(s AgentSession) (usageSummary, error) {
	key := strings.Join([]string{s.Agent, s.ID, s.ClaudeDir, s.CodexHome, s.Rollout, s.RolloutID}, "\x00")
	return a.usage.sessions.do(key, func() (usageSummary, error) {
		if s.Agent == "opencode" {
			return opencodeSessionUsage(s.ID)
		}
		t := newUsageTotals()
		files, err := a.history.sessionFiles(s)
		if errors.Is(err, errTranscriptNotWritten) {
			return summaryOf(t), nil
		}
		if err != nil {
			return usageSummary{}, err
		}
		defer closeSessionFiles(files)
		for _, f := range files {
			for _, rec := range a.usage.reader.records(s.Agent, f.path, f.f, f.fi) {
				t.add(s.Agent, f.sub, rec)
			}
		}
		return summaryOf(t), nil
	})
}

// usageSince is where a summary starts: usageDays days back, on a bucket.
func (u *usageAPI) usageSince() time.Time {
	return u.now().UTC().Add(-usageDays * 24 * time.Hour).Truncate(usageBucket)
}

// usageDedup adds the records of the files read to t, each request once
// whichever file repeats it (a forked session copies its messages).
type usageDedup struct {
	t     *usageTotals
	seen  map[string]bool
	since time.Time
}

func (d *usageDedup) add(agent string, recs []usageRecord) {
	for _, r := range recs {
		k := agent + "\x00" + r.key
		if r.at.Before(d.since) || d.seen[k] {
			continue
		}
		d.seen[k] = true
		d.t.add(agent, false, r)
	}
}

func (a *agentAPI) handleRootUsage(w http.ResponseWriter, r *http.Request) {
	if !a.usageRead(w, r) {
		return
	}
	root, ok := a.historyRoot(w, r)
	if !ok {
		return
	}
	res, _ := a.usage.summary.do("root\x00"+root.Root, func() (usageBuckets, error) {
		scan := a.history.scan(root.Root)
		since := a.usage.usageSince()
		d := usageDedup{t: newUsageTotals(), seen: map[string]bool{}, since: since}
		var opencode []historySession
		for _, s := range scan.sessions {
			if s.updated.Before(since) {
				continue
			}
			if s.Agent == "opencode" {
				opencode = append(opencode, s)
				continue
			}
			as := a.historyAgentSession(s)
			files, err := a.history.sessionFiles(as)
			if err != nil {
				continue
			}
			for _, f := range files {
				if !f.fi.ModTime().Before(since) {
					d.add(s.Agent, a.usage.reader.records(s.Agent, f.path, f.f, f.fi))
				}
			}
			closeSessionFiles(files)
		}
		ot := opencodeRootUsage(opencode, &d)
		return bucketsOf(d.t, since, scan.truncated || ot), nil
	})
	jsonOK(w, res)
}

func (a *agentAPI) handleMachineUsage(w http.ResponseWriter, r *http.Request) {
	if !a.usageRead(w, r) {
		return
	}
	dirs := a.history.dirs()
	res, _ := a.usage.summary.do("machine\x00"+dirs.claude+"\x00"+dirs.codex, func() (usageBuckets, error) {
		since := a.usage.usageSince()
		d := usageDedup{t: newUsageTotals(), seen: map[string]bool{}, since: since}
		ct := a.machineClaudeUsage(dirs.claude, &d)
		xt := a.machineCodexUsage(dirs.codex, &d)
		ot := opencodeMachineUsage(&d)
		return bucketsOf(d.t, since, ct || xt || ot), nil
	})
	jsonOK(w, res)
}

// usageCandidate is a file a machine summary may read.
type usageCandidate struct {
	path  string
	mtime time.Time
	// proj, id: a Claude Code subagent's session; its file is opened
	// through the session's subagents directory.
	proj, id string
}

// newestFiles keeps the usageMaxFiles newest candidates; truncated: some
// were left out.
func newestFiles(c []usageCandidate) ([]usageCandidate, bool) {
	slices.SortFunc(c, func(a, b usageCandidate) int { return b.mtime.Compare(a.mtime) })
	if len(c) > usageMaxFiles {
		return c[:usageMaxFiles], true
	}
	return c, false
}

// machineClaudeUsage reads every transcript under claudeDir's projects
// written since d.since: projects/<dir>/<id>.jsonl and its subagents'
// projects/<dir>/<id>/subagents/agent-*.jsonl, nothing deeper.
func (a *agentAPI) machineClaudeUsage(claudeDir string, d *usageDedup) bool {
	if claudeDir == "" || !filepath.IsAbs(claudeDir) {
		return false
	}
	root, err := filepath.EvalSymlinks(claudeDir)
	if err != nil {
		return false
	}
	projects := filepath.Join(root, "projects")
	dirs, err := os.ReadDir(projects)
	if err != nil {
		return false
	}
	var cands []usageCandidate
	for _, dir := range dirs {
		if !dir.IsDir() {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(projects, dir.Name()))
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if id, ok := strings.CutSuffix(name, ".jsonl"); ok && isSessionID(id) && e.Type().IsRegular() {
				if fi, err := e.Info(); err == nil && !fi.ModTime().Before(d.since) {
					cands = append(cands, usageCandidate{path: filepath.Join(projects, dir.Name(), name), mtime: fi.ModTime()})
				}
				continue
			}
			if !isSessionID(name) || !e.IsDir() {
				continue
			}
			subs, err := os.ReadDir(filepath.Join(projects, dir.Name(), name, "subagents"))
			if err != nil {
				continue
			}
			for _, s := range subs {
				if m := subagentFileRe.FindStringSubmatch(s.Name()); m == nil || m[2] != "jsonl" || !s.Type().IsRegular() {
					continue
				}
				if fi, err := s.Info(); err == nil && !fi.ModTime().Before(d.since) {
					cands = append(cands, usageCandidate{path: s.Name(), mtime: fi.ModTime(), proj: dir.Name(), id: name})
				}
			}
		}
	}
	cands, truncated := newestFiles(cands)
	subs := map[string][]string{} // by proj and session: the subagent files kept
	for _, c := range cands {
		if c.id != "" {
			k := c.proj + "/" + c.id
			subs[k] = append(subs[k], c.path)
			continue
		}
		if f, fi, real, ok := openHistoryFile(root, c.path); ok {
			d.add("claude", a.usage.reader.records("claude", real, f, fi))
			f.Close()
		}
	}
	for k, names := range subs {
		proj, id, _ := strings.Cut(k, "/")
		a.claudeSubagentUsage(root, proj, id, names, d)
	}
	return truncated
}

// claudeSubagentUsage reads a session's subagent files of names through its
// subagents directory, with the subagent tree's checks.
func (a *agentAPI) claudeSubagentUsage(root, proj, id string, names []string, d *usageDedup) {
	dir, err := openSubagentsDir(root, proj, id)
	if err != nil {
		return
	}
	defer dir.Close()
	for _, e := range listSubagentDir(dir) {
		if !slices.Contains(names, e.Name()) {
			continue
		}
		if f, fi, ok := openPlainFile(dir, e); ok {
			p := filepath.Join(root, "projects", proj, id, "subagents", e.Name())
			d.add("claude", a.usage.reader.records("claude", p, f, fi))
			f.Close()
		}
	}
}

// usageCodexDayDirs is how many Codex day dirs the machine summary lists,
// the newest first; a variable so tests can lower it.
var usageCodexDayDirs = 400

// machineCodexUsage reads every rollout under codexHome's sessions written
// since d.since, whatever day it started on (a day dir is the local day a
// rollout started, and a resumed one is written to long after): the
// usageCodexDayDirs newest day dirs are listed, each rollout kept by its
// own mtime.
func (a *agentAPI) machineCodexUsage(codexHome string, d *usageDedup) bool {
	if codexHome == "" || !filepath.IsAbs(codexHome) {
		return false
	}
	sessions, err := filepath.EvalSymlinks(filepath.Join(codexHome, "sessions"))
	if err != nil {
		return false
	}
	var cands []usageCandidate
	days := 0
walk:
	for _, y := range numberedDirs(sessions) {
		for _, m := range numberedDirs(filepath.Join(sessions, y)) {
			for _, dd := range numberedDirs(filepath.Join(sessions, y, m)) {
				if days == usageCodexDayDirs {
					break walk
				}
				days++
				day := filepath.Join(sessions, y, m, dd)
				entries, err := os.ReadDir(day)
				if err != nil {
					continue
				}
				for _, e := range entries {
					if codexRolloutRe.MatchString(e.Name()) && e.Type().IsRegular() {
						if fi, err := e.Info(); err == nil && !fi.ModTime().Before(d.since) {
							cands = append(cands, usageCandidate{path: filepath.Join(day, e.Name()), mtime: fi.ModTime()})
						}
					}
				}
			}
		}
	}
	cands, truncated := newestFiles(cands)
	for _, c := range cands {
		if f, fi, real, ok := openHistoryFile(sessions, c.path); ok {
			d.add("codex", a.usage.reader.records("codex", real, f, fi))
			f.Close()
		}
	}
	return truncated
}
