package main

import (
	"encoding/json"
	"os"
	"slices"
	"time"
)

// Token usage read from the agents' own journals, for the token and cost
// estimates. Nothing is read from a terminal.
//
// Claude Code writes one transcript row per content block of a reply, every
// row of one message repeating the message's usage, so a message counts
// once, by its message.id; rows of the <synthetic> model are Claude Code's
// own and cost nothing. Codex (0.165) writes a token_usage_record row per
// response with the thread it belongs to, a subagent's rollout repeating its
// parent's rows (thread_id the parent's), so only the rollout's own thread
// counts, once per response_id. A rollout from before token_usage_record
// only has token_count events, whose total_token_usage adds up the thread:
// the difference between two of them is what the responses between cost.

const usageBucket = 15 * time.Minute

// usageRecord is one request's tokens. input leaves cached input out,
// output counts reasoning in (reasoning is shown, never priced apart).
type usageRecord struct {
	at                         time.Time
	model                      string
	input, cacheRead           int64
	cacheWrite5m, cacheWrite1h int64
	output, reasoning          int64
	key                        string
}

// tokenCounts adds records up; cost is in USD, 0 for a model without a
// price.
type tokenCounts struct {
	input, cacheRead, cacheWrite5m, cacheWrite1h, output, reasoning int64
	cost                                                            float64
}

func (t *tokenCounts) add(r usageRecord) {
	t.input += r.input
	t.cacheRead += r.cacheRead
	t.cacheWrite5m += r.cacheWrite5m
	t.cacheWrite1h += r.cacheWrite1h
	t.output += r.output
	t.reasoning += r.reasoning
}

func (t *tokenCounts) plus(o tokenCounts) {
	t.add(usageRecord{input: o.input, cacheRead: o.cacheRead, cacheWrite5m: o.cacheWrite5m,
		cacheWrite1h: o.cacheWrite1h, output: o.output, reasoning: o.reasoning})
	t.cost += o.cost
}

// total is every token the requests sent or got: reasoning is in output.
func (t tokenCounts) total() int64 {
	return t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.output
}

// usageBucketKey is one agent's 15 minutes (UTC).
type usageBucketKey struct {
	t     time.Time
	agent string
}

// usageTotals adds records up by model, the session's own requests apart
// from its subagents', and by agent and 15 minutes.
type usageTotals struct {
	main, sub map[string]tokenCounts
	buckets   map[usageBucketKey]map[string]tokenCounts
}

func newUsageTotals() *usageTotals {
	return &usageTotals{main: map[string]tokenCounts{}, sub: map[string]tokenCounts{},
		buckets: map[usageBucketKey]map[string]tokenCounts{}}
}

// add counts r, priced at its own size (a long request may cost more per
// token).
func (u *usageTotals) add(agent string, sub bool, r usageRecord) {
	var cost float64
	if p, ok := priceOf(r.model); ok {
		cost = costOf(p, r)
	}
	by := u.main
	if sub {
		by = u.sub
	}
	c := by[r.model]
	c.add(r)
	c.cost += cost
	by[r.model] = c
	k := usageBucketKey{r.at.UTC().Truncate(usageBucket), agent}
	b := u.buckets[k]
	if b == nil {
		b = map[string]tokenCounts{}
		u.buckets[k] = b
	}
	c = b[r.model]
	c.add(r)
	c.cost += cost
	b[r.model] = c
}

// usageRecords keeps a journal's records by key: a later row of a key
// replaces the earlier one in place.
type usageRecords struct {
	recs []usageRecord
	keys map[string]int
}

func (u *usageRecords) put(r usageRecord) {
	if u.keys == nil {
		u.keys = map[string]int{}
	}
	if i, ok := u.keys[r.key]; ok {
		u.recs[i] = r
		return
	}
	u.keys[r.key] = len(u.recs)
	u.recs = append(u.recs, r)
}

// claudeUsageState is what a Claude Code transcript's rows made so far.
type claudeUsageState struct{ usageRecords }

// claudeUsageRow is the part of an assistant row the usage reads.
type claudeUsageRow struct {
	Type      string `json:"type"`
	UUID      string `json:"uuid"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage *struct {
			InputTokens              int64 `json:"input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheCreation            *struct {
				Ephemeral5m int64 `json:"ephemeral_5m_input_tokens"`
				Ephemeral1h int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
			OutputTokens        int64 `json:"output_tokens"`
			OutputTokensDetails *struct {
				ThinkingTokens int64 `json:"thinking_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
	} `json:"message"`
}

func newClaudeUsageScanner() *journalScanner[claudeUsageState] {
	return newJournalScanner([]string{`"usage"`}, func() claudeUsageState { return claudeUsageState{} }, stepClaudeUsage)
}

func stepClaudeUsage(st *claudeUsageState, line []byte) {
	var row claudeUsageRow
	if json.Unmarshal(line, &row) != nil || row.Type != "assistant" || row.Message == nil || row.Message.Usage == nil {
		return
	}
	m, u := row.Message, row.Message.Usage
	at, err := time.Parse(time.RFC3339Nano, row.Timestamp)
	if err != nil || m.Model == "" || m.Model == "<synthetic>" {
		return
	}
	key := m.ID
	if key == "" {
		key = "row:" + row.UUID
	}
	r := usageRecord{at: at, model: m.Model, input: u.InputTokens, cacheRead: u.CacheReadInputTokens,
		output: u.OutputTokens, key: key}
	if c := u.CacheCreation; c != nil && c.Ephemeral5m+c.Ephemeral1h > 0 {
		r.cacheWrite5m, r.cacheWrite1h = c.Ephemeral5m, c.Ephemeral1h
	} else {
		r.cacheWrite5m = u.CacheCreationInputTokens
	}
	if d := u.OutputTokensDetails; d != nil {
		r.reasoning = d.ThinkingTokens
	}
	st.put(r)
}

// codexUsageState is what a rollout's rows made so far.
type codexUsageState struct {
	// thread: the rollout's own id, from its session_meta; start: the
	// ordinal from which a subagent's rows are its own (before, they are
	// copied from its parent).
	thread string
	start  int64
	model  string
	// forked: a fork (a user's or a subagent's), whose token_count total
	// goes on from its parent's
	forked bool
	// records: token_usage_record rows; legacy: token_count differences
	// from before the first of them.
	records, legacy usageRecords
	sawRecord       bool
	total           *codexTokenTotals
}

// codexTokenTotals is a token_count's or token_usage_record's usage.
type codexTokenTotals struct {
	InputTokens       int64 `json:"input_tokens"`
	CachedInputTokens int64 `json:"cached_input_tokens"`
	CacheWriteInput   int64 `json:"cache_write_input_tokens"`
	OutputTokens      int64 `json:"output_tokens"`
	ReasoningOutput   int64 `json:"reasoning_output_tokens"`
}

// codexUsageRow is the part of a rollout row the usage reads.
type codexUsageRow struct {
	Timestamp string `json:"timestamp"`
	Ordinal   *int64 `json:"ordinal"`
	Type      string `json:"type"`
	Payload   struct {
		Type string `json:"type"`
		// session_meta
		ID           string `json:"id"`
		ThreadSource string `json:"thread_source"`
		StartOrdinal int64  `json:"subagent_history_start_ordinal"`
		ForkedFrom   string `json:"forked_from_id"`
		// turn_context
		Model string `json:"model"`
		// token_usage_record
		ThreadID   string            `json:"thread_id"`
		ResponseID string            `json:"response_id"`
		Usage      *codexTokenTotals `json:"usage"`
		// token_count
		Info *struct {
			Total *codexTokenTotals `json:"total_token_usage"`
		} `json:"info"`
	} `json:"payload"`
}

func newCodexUsageScanner() *journalScanner[codexUsageState] {
	return newJournalScanner([]string{`"session_meta"`, `"turn_context"`, `"token_usage_record"`, `"token_count"`},
		func() codexUsageState { return codexUsageState{} }, stepCodexUsage)
}

func stepCodexUsage(st *codexUsageState, line []byte) {
	var row codexUsageRow
	if json.Unmarshal(line, &row) != nil {
		return
	}
	p := &row.Payload
	switch {
	case row.Type == "session_meta":
		if st.thread == "" && isSessionID(p.ID) {
			st.thread = p.ID
			st.forked = p.ForkedFrom != ""
			if p.ThreadSource == "subagent" {
				st.start = p.StartOrdinal
			}
		}
		return
	case row.Type == "turn_context":
		if p.Model != "" {
			st.model = p.Model
		}
		return
	}
	at, err := time.Parse(time.RFC3339Nano, row.Timestamp)
	if err != nil || st.thread == "" {
		return
	}
	copied := row.Ordinal != nil && *row.Ordinal < st.start
	switch {
	case row.Type == "token_usage_record":
		if p.ThreadID != st.thread || p.ResponseID == "" || p.Usage == nil || copied {
			return
		}
		st.sawRecord = true
		st.records.put(codexRecord(at, st.model, *p.Usage, p.ResponseID))
	case row.Type == "event_msg" && p.Type == "token_count" && p.Info != nil && p.Info.Total != nil:
		cur, prev := *p.Info.Total, st.total
		st.total = &cur
		if prev == nil || st.sawRecord || copied {
			// The first total is a baseline only when it is not the
			// thread's first: a rollout read from its start counts it,
			// unless it is a fork's (Codex 0.169 goes on from the
			// parent's total there).
			if prev == nil && !st.sawRecord && !copied && !st.forked {
				st.legacy.put(codexRecord(at, st.model, cur, "count:"+st.thread+row.Timestamp))
			}
			return
		}
		d := codexTokenTotals{
			InputTokens: cur.InputTokens - prev.InputTokens, CachedInputTokens: cur.CachedInputTokens - prev.CachedInputTokens,
			CacheWriteInput: cur.CacheWriteInput - prev.CacheWriteInput, OutputTokens: cur.OutputTokens - prev.OutputTokens,
			ReasoningOutput: cur.ReasoningOutput - prev.ReasoningOutput,
		}
		if d.InputTokens < 0 || d.CachedInputTokens < 0 || d.CacheWriteInput < 0 || d.OutputTokens < 0 || d.ReasoningOutput < 0 {
			// Smaller than the last: taken as a new base, never counted, so
			// nothing is counted twice. Not seen in real rollouts, where a
			// thread resumed days later goes on from its total.
			return
		}
		if d.InputTokens+d.OutputTokens == 0 {
			return // the same total again (a rate limit update)
		}
		st.legacy.put(codexRecord(at, st.model, d, "count:"+st.thread+row.Timestamp))
	}
}

// codexRecord makes a record of Codex usage, where input_tokens counts the
// cached and cache-written input in.
func codexRecord(at time.Time, model string, u codexTokenTotals, key string) usageRecord {
	return usageRecord{at: at, model: model, key: key,
		input:     max(u.InputTokens-u.CachedInputTokens-u.CacheWriteInput, 0),
		cacheRead: u.CachedInputTokens, cacheWrite5m: u.CacheWriteInput,
		output: u.OutputTokens, reasoning: u.ReasoningOutput}
}

// all is every record of the rollout: token_count differences from before
// its first token_usage_record, then the records.
func (st *codexUsageState) all() []usageRecord {
	return slices.Concat(st.legacy.recs, st.records.recs)
}

// usageReader reads usage records with one incremental scanner per agent.
type usageReader struct {
	claude *journalScanner[claudeUsageState]
	codex  *journalScanner[codexUsageState]
}

func newUsageReader() *usageReader {
	return &usageReader{claude: newClaudeUsageScanner(), codex: newCodexUsageScanner()}
}

// records is a copy of the records of the journal f of agent, opened from
// path (the resolved path, the scanner's key).
func (u *usageReader) records(agent, path string, f *os.File, fi os.FileInfo) []usageRecord {
	var out []usageRecord
	if agent == "codex" {
		u.codex.scan(path, f, fi, func(st *codexUsageState) { out = st.all() })
	} else {
		u.claude.scan(path, f, fi, func(st *claudeUsageState) { out = slices.Clone(st.recs) })
	}
	return out
}
