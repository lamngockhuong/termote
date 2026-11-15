package main

import (
	"errors"
	"log"
	"strings"
	"sync"
	"time"
)

// A card's session totals (overviewPane.sessionUsage) are read in the
// background, one session at a time, as a pane's changes are: the overview
// request only reads what is cached, so a first read of a long transcript
// never holds it up. The field is absent until a read finished.

const (
	// overviewUsageTTL: a session's totals are read again after this; the
	// read is incremental, only what was appended is decoded.
	overviewUsageTTL = 15 * time.Second
	// overviewUsageKeep: the totals of a session not asked for in this long
	// are dropped.
	overviewUsageKeep = 5 * time.Minute
)

// overviewSessionUsage is a card's session totals: every token of the
// session and its estimated cost (absent when none has a price), and the
// share of its subagents (absent without any).
type overviewSessionUsage struct {
	Tokens         int64    `json:"tokens"`
	CostUSD        *float64 `json:"costUsd,omitempty"`
	UnpricedTokens int64    `json:"unpricedTokens,omitempty"`
	SubTokens      *int64   `json:"subTokens,omitempty"`
	SubCostUSD     *float64 `json:"subCostUsd,omitempty"`
	PricesUpdated  string   `json:"pricesUpdated"`
}

func overviewSessionUsageOf(s usageSummary) *overviewSessionUsage {
	u := &overviewSessionUsage{Tokens: s.Tokens.Total, CostUSD: s.CostUSD, UnpricedTokens: s.UnpricedTokens,
		PricesUpdated: s.PricesUpdated}
	if s.Sub != nil {
		n := s.Sub.Tokens
		u.SubTokens, u.SubCostUSD = &n, s.Sub.CostUSD
	}
	return u
}

type overviewUsageEntry struct {
	usage  *overviewSessionUsage
	failed bool
	at     time.Time // when read
	asked  time.Time // when last looked up
}

type overviewUsageJob struct {
	key string
	s   AgentSession
}

// overviewUsageJobs caches each session's totals by its key, read by one
// worker at a time.
type overviewUsageJobs struct {
	now     func() time.Time
	mu      sync.Mutex
	byKey   map[string]overviewUsageEntry
	queue   []overviewUsageJob
	queued  map[string]bool
	running bool
}

func newOverviewUsageJobs() *overviewUsageJobs {
	return &overviewUsageJobs{now: time.Now, byKey: map[string]overviewUsageEntry{}, queued: map[string]bool{}}
}

// lookup returns s's cached totals, and queues a read with run when there
// are none or they are older than overviewUsageTTL.
func (j *overviewUsageJobs) lookup(s AgentSession, run func(AgentSession) (usageSummary, error)) (overviewUsageEntry, bool) {
	key := strings.Join([]string{s.Agent, s.ID, s.ClaudeDir, s.CodexHome, s.Rollout, s.RolloutID}, "\x00")
	j.mu.Lock()
	defer j.mu.Unlock()
	now := j.now()
	for k, v := range j.byKey {
		if now.Sub(v.asked) >= overviewUsageKeep {
			delete(j.byKey, k)
		}
	}
	v, ok := j.byKey[key]
	if ok {
		v.asked = now
		j.byKey[key] = v
	}
	if (!ok || now.Sub(v.at) >= overviewUsageTTL) && !j.queued[key] {
		j.queued[key] = true
		j.queue = append(j.queue, overviewUsageJob{key, s})
		if !j.running {
			j.running = true
			go j.work(run)
		}
	}
	return v, ok
}

// work reads the queued sessions one at a time until none is left.
func (j *overviewUsageJobs) work(run func(AgentSession) (usageSummary, error)) {
	for {
		j.mu.Lock()
		if len(j.queue) == 0 {
			j.running = false
			j.mu.Unlock()
			return
		}
		job := j.queue[0]
		j.queue = j.queue[1:]
		j.mu.Unlock()
		v := overviewUsageEntry{at: j.now()}
		sum, err := run(job.s)
		switch {
		case err == nil:
			v.usage = overviewSessionUsageOf(sum)
		case errors.Is(err, errNoTranscript), errors.Is(err, errAgentUnsupported):
			// no journal: nothing to show, nothing pending
		default:
			log.Printf("overview: usage of session %s: %v", job.s.ID, err)
			v.failed = true
		}
		j.mu.Lock()
		delete(j.queued, job.key)
		if v.failed {
			v.usage = j.byKey[job.key].usage // the last totals read still hold
		}
		v.asked = j.now()
		j.byKey[job.key] = v
		j.mu.Unlock()
	}
}

// paneSessionUsage is the cached totals of the pane's session; failed: the
// last read failed (the card shows the totals as pending).
func (a *agentAPI) paneSessionUsage(paneID string) (u *overviewSessionUsage, failed bool) {
	if a.usage == nil || a.history == nil {
		return nil, false
	}
	s, err := a.session(paneID)
	if err != nil || (s.Agent != "claude" && s.Agent != "codex") {
		return nil, false
	}
	v, ok := a.usageJobs.lookup(s, a.sessionUsage)
	if !ok {
		return nil, false
	}
	return v.usage, v.failed
}
