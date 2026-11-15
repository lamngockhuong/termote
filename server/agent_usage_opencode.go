package main

import (
	"context"
	"errors"
	"log"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The tokens and cost of OpenCode sessions, from the user's own service
// (never opencode.db), with the cost OpenCode itself recorded at the prices
// of the user's provider: termote's price table is not used. Checked on
// OpenCode 2.3.0:
//
//   - A session's tokens and cost (session.get) add up its own requests,
//     the one that made its title among them; a subagent's are in its own
//     session, never in its parent's. A fork starts from 0.
//   - Each assistant message has the tokens and cost of its request; the
//     title's request has no message. A fork copies its parent's messages,
//     tokens and cost too, under ids ending in _<n>: those are skipped.
//   - experimental.session.stats adds a range up, with no tokens by day:
//     the totals by 15 minutes add the messages up instead.
//
// A model whose cost OpenCode records as 0 (a local provider, a free
// model) shows its tokens, no money. A service that does not run or answer
// adds nothing, and no route fails for it.

const (
	// opencodeUsagePage is how many messages or sessions one read asks for.
	opencodeUsagePage = 100
	// opencodeUsageMaxMessages bounds the messages of one session read for
	// the totals by 15 minutes, the newest first.
	opencodeUsageMaxMessages = 5000
	// opencodeUsageTimeout bounds one read of a session's usage.
	opencodeUsageTimeout = 10 * time.Second
	// opencodeUsageSummaryTimeout bounds the OpenCode share of one summary;
	// the sessions read before it are kept, so the next summary goes on.
	opencodeUsageSummaryTimeout = 30 * time.Second
	// opencodeUsageKeep: a session's records are read again this long after
	// they were read, even when it did not change.
	opencodeUsageKeep = time.Hour
)

// opencodeUsageRecs keeps a session's records by its id and its time of
// last update, so a session that has not changed is not read again.
var opencodeUsageRecs = newTTLCache[opencodeRecs](opencodeUsageKeep)

// opencodeRecs is what was read of one session: its records since a day
// of the summary, and whether some were left out.
type opencodeRecs struct {
	recs      []usageRecord
	truncated bool
}

// opencodeUsageMessage is the part of an assistant message the usage reads.
type opencodeUsageMessage struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Time struct {
		Created float64 `json:"created"`
	} `json:"time"`
	Model  opencodeModelRef `json:"model"`
	Cost   float64          `json:"cost"`
	Tokens *opencodeTokens  `json:"tokens"`
}

// opencodeModelName is a model as the usage names it: provider/id.
func opencodeModelName(m opencodeModelRef) string {
	switch {
	case m.ID == "":
		return "unknown"
	case m.ProviderID == "":
		return m.ID
	}
	return m.ProviderID + "/" + m.ID
}

// opencodeCost is a recorded cost, 0 when it is not a usable amount.
func opencodeCost(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0
	}
	return v
}

// opencodeTokensRecord is a record of tokens t costing cost (as OpenCode
// recorded it) on model; OpenCode counts reasoning apart from output.
func opencodeTokensRecord(t opencodeTokens, cost float64, model string) usageRecord {
	return usageRecord{model: model, input: max(t.Input, 0), cacheRead: max(t.Cache.Read, 0),
		cacheWrite5m: max(t.Cache.Write, 0), output: max(t.Output, 0) + max(t.Reasoning, 0),
		reasoning: max(t.Reasoning, 0), cost: opencodeCost(cost), reported: true}
}

// opencodeUsageRecord is the record of message m: none for a message
// without tokens, nor for a fork's copy of its parent's (id ending in _<n>).
func opencodeUsageRecord(m opencodeUsageMessage) (usageRecord, bool) {
	if m.Type != "assistant" || m.Tokens == nil || !opencodeMessageIDRe.MatchString(m.ID) ||
		strings.Contains(strings.TrimPrefix(m.ID, "msg_"), "_") || m.Time.Created <= 0 {
		return usageRecord{}, false
	}
	r := opencodeTokensRecord(*m.Tokens, m.Cost, opencodeModelName(m.Model))
	r.at, r.key = time.UnixMilli(int64(m.Time.Created)), m.ID
	return r, true
}

// usageMessages reads the records of session id's assistant messages made
// since since, newest first, at most max; truncated: older ones in the
// range were left out. The page cursor is the service's own, only ever
// passed back to it.
func (c *opencodeClient) usageMessages(ctx context.Context, id string, since time.Time, max int) (recs []usageRecord, truncated bool, err error) {
	if !isOpencodeSessionID(id) {
		return nil, false, errOpencodeNotFound
	}
	cursor := ""
	read := 0
	for {
		q := url.Values{"limit": {strconv.Itoa(opencodeUsagePage)}, "type": {"assistant"}}
		if cursor != "" {
			q.Set("cursor", cursor)
		} else {
			q.Set("order", "desc")
		}
		var res struct {
			Data   []opencodeUsageMessage `json:"data"`
			Cursor struct {
				Next *string `json:"next"`
			} `json:"cursor"`
		}
		if err := c.get(ctx, "/api/session/"+id+"/message", q, opencodeMessagesMax, &res); err != nil {
			return recs, false, err
		}
		for _, m := range res.Data {
			if m.Time.Created > 0 && time.UnixMilli(int64(m.Time.Created)).Before(since) {
				return recs, false, nil
			}
			if read == max {
				return recs, true, nil
			}
			read++
			if r, ok := opencodeUsageRecord(m); ok {
				recs = append(recs, r)
			}
		}
		// The service gives a cursor even after the last page; a page
		// shorter than asked is the last.
		if len(res.Data) < opencodeUsagePage || res.Cursor.Next == nil || *res.Cursor.Next == "" ||
			len(*res.Cursor.Next) > 1024 {
			return recs, false, nil
		}
		cursor = *res.Cursor.Next
	}
}

// sessionsSince lists every session the service holds (subagents' and
// archived ones too) updated since since, newest first, at most max;
// truncated: some were left out.
func (c *opencodeClient) sessionsSince(ctx context.Context, since time.Time, max int) ([]opencodeSessionInfo, bool, error) {
	list, err := c.listSessions(ctx, url.Values{}, max, func(s opencodeSessionInfo) bool {
		return time.UnixMilli(s.Time.Updated).Before(since)
	})
	return list.sessions, list.truncated, err
}

// opencodeSessionRecords reads the records of session id, updated at
// updated (ms), since since: cached until it is updated again.
func opencodeSessionRecords(ctx context.Context, c *opencodeClient, id string, updated int64, since time.Time) opencodeRecs {
	key := id + "\x00" + strconv.FormatInt(updated, 10)
	recs, err := opencodeUsageRecs.do(key, func() (opencodeRecs, error) {
		recs, truncated, err := c.usageMessages(ctx, id, since, opencodeUsageMaxMessages)
		return opencodeRecs{recs, truncated}, err
	})
	if err != nil {
		opencodeUsageRecs.forgetFunc(func(k string) bool { return k == key })
		if errors.Is(err, errOpencodeNotFound) {
			return opencodeRecs{} // deleted since it was listed: nothing left out
		}
		if !errors.Is(err, errOpencodeUnavailable) {
			log.Printf("opencode usage: %v", err)
		}
		return opencodeRecs{recs: recs.recs, truncated: true}
	}
	return recs
}

// opencodeRootUsage adds the records of the history's OpenCode sessions
// (the pane root's, updated since d.since) and of their subagents to d;
// true when some were left out.
func opencodeRootUsage(sessions []historySession, d *usageDedup) bool {
	if len(sessions) == 0 {
		return false
	}
	c, err := opencodeConnect()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), opencodeUsageSummaryTimeout)
	defer cancel()
	truncated := false
	budget := subagentsMaxNodes * len(sessions)
	for _, s := range sessions {
		r := opencodeSessionRecords(ctx, c, s.ID, s.updated.UnixMilli(), d.since)
		d.add("opencode", r.recs)
		truncated = truncated || r.truncated
		if opencodeSubagentRecords(ctx, c, s.ID, 1, &budget, d) {
			truncated = true
		}
	}
	return truncated
}

// opencodeSubagentRecords adds the records of session id's subagents
// updated since d.since, and of theirs down to opencodeSubagentDepth, to d;
// true when some were left out.
func opencodeSubagentRecords(ctx context.Context, c *opencodeClient, id string, depth int, budget *int, d *usageDedup) bool {
	if *budget <= 0 {
		return true
	}
	kids, more, err := c.children(ctx, id, *budget)
	if err != nil {
		return !errors.Is(err, errOpencodeNotFound)
	}
	truncated := more
	*budget -= len(kids)
	for _, k := range kids {
		updated := int64(k.Time.Updated)
		if time.UnixMilli(updated).Before(d.since) {
			continue
		}
		r := opencodeSessionRecords(ctx, c, k.ID, updated, d.since)
		d.add("opencode", r.recs)
		truncated = truncated || r.truncated
		if depth < opencodeSubagentDepth && opencodeSubagentRecords(ctx, c, k.ID, depth+1, budget, d) {
			truncated = true
		}
	}
	return truncated
}

// opencodeMachineUsage adds the records of every session of the user's
// service updated since d.since to d, subagents' included; true when some
// were left out.
func opencodeMachineUsage(d *usageDedup) bool {
	c, err := opencodeConnect()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), opencodeUsageSummaryTimeout)
	defer cancel()
	sessions, truncated, err := c.sessionsSince(ctx, d.since, usageMaxFiles)
	if err != nil {
		if !errors.Is(err, errOpencodeUnavailable) {
			log.Printf("opencode usage: %v", err)
		}
		truncated = true
	}
	for _, s := range sessions {
		r := opencodeSessionRecords(ctx, c, s.ID, s.Time.Updated, d.since)
		d.add("opencode", r.recs)
		truncated = truncated || r.truncated
	}
	return truncated
}

// opencodeUsageOf is one session's share: its tokens by kind and its cost.
type opencodeUsageOf struct {
	tokens opencodeTokens
	cost   float64
}

// opencodeSessionUsage is session id's usage: its own tokens and cost and
// its subagents' (their sessions, down to opencodeSubagentDepth), as the
// service totals them. A session not made yet (a TUI started with
// --session waits for its first message) has used nothing; a service that
// does not run has no transcript.
func opencodeSessionUsage(id string) (usageSummary, error) {
	c, err := opencodeConnect()
	if err != nil {
		return usageSummary{}, errNoTranscript
	}
	ctx, cancel := context.WithTimeout(context.Background(), opencodeUsageTimeout)
	defer cancel()
	s, err := c.session(ctx, id)
	switch {
	case errors.Is(err, errOpencodeNotFound):
		return opencodeSummaryOf(opencodeUsageOf{}, nil), nil
	case errors.Is(err, errOpencodeUnavailable):
		return usageSummary{}, errNoTranscript
	case err != nil:
		return usageSummary{}, err
	}
	own := opencodeUsageOf{tokens: s.Tokens, cost: opencodeCost(s.Cost)}
	budget := subagentsMaxNodes
	return opencodeSummaryOf(own, opencodeSubagentUsage(ctx, c, id, 1, &budget)), nil
}

// opencodeSubagentUsage is the share of session id's subagents, and of
// theirs down to opencodeSubagentDepth. The ones read before a failure
// still count.
func opencodeSubagentUsage(ctx context.Context, c *opencodeClient, id string, depth int, budget *int) []opencodeUsageOf {
	if *budget <= 0 {
		return nil
	}
	kids, _, err := c.children(ctx, id, *budget)
	if err != nil {
		if !errors.Is(err, errOpencodeNotFound) && !errors.Is(err, errOpencodeUnavailable) {
			log.Printf("opencode usage: %v", err)
		}
		return nil
	}
	*budget -= len(kids)
	var out []opencodeUsageOf
	for _, k := range kids {
		out = append(out, opencodeUsageOf{tokens: k.Tokens, cost: opencodeCost(k.Cost)})
		if depth < opencodeSubagentDepth {
			out = append(out, opencodeSubagentUsage(ctx, c, k.ID, depth+1, budget)...)
		}
	}
	return out
}

// opencodeSummaryOf is a session's response from its own share and its
// subagents'. Tokens add both up, as a Claude Code session's do. No model is
// listed: a session's totals are not split by model (its model is the last
// one it used), and the client shows none.
func opencodeSummaryOf(own opencodeUsageOf, subs []opencodeUsageOf) usageSummary {
	t := newUsageTotals()
	add := func(u opencodeUsageOf, sub bool) {
		r := opencodeTokensRecord(u.tokens, u.cost, "opencode")
		// A session with no tokens has nothing to show apart.
		if r.input+r.cacheRead+r.cacheWrite5m+r.output == 0 && r.cost == 0 {
			return
		}
		t.add("opencode", sub, r)
	}
	add(own, false)
	for _, s := range subs {
		add(s, true)
	}
	res := summaryOf(t)
	res.Models = []usageModel{}
	return res
}
