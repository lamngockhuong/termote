package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// usageRow is an assistant row of message id at at, with input and output
// tokens.
func usageRow(id, model string, at time.Time, input, output int) string {
	return claudeAssistantRow(id, model, at.UTC().Format(time.RFC3339Nano), map[string]any{"input_tokens": input, "output_tokens": output})
}

func getUsageJSON(t *testing.T, h http.Handler, req *http.Request, v any) int {
	t.Helper()
	rec := serve(h, req)
	if rec.Code == 200 {
		if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
			t.Fatal(err)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s: Cache-Control = %q", req.URL, cc)
		}
	}
	return rec.Code
}

func TestSessionUsageRoute(t *testing.T) {
	fx := newHistoryFixture(t)
	gitInit(t, fx.root)
	now := time.Now()
	body := claudeRows(fx.root, "main", "hi",
		usageRow("msg_1", "claude-opus-5-5", now, 1_000_000, 0),
		usageRow("msg_1", "claude-opus-5-5", now, 1_000_000, 0),
		usageRow("msg_2", "mystery-1", now, 10, 5))
	writeClaudeSession(t, fx.claude, fx.root, histID1, body, now)
	subs := filepath.Join(fx.claude, "projects", claudeProjectName(fx.root), histID1, "subagents")
	writeFile(t, filepath.Join(subs, "agent-a1.jsonl"), usageRow("msg_s", "claude-haiku-5-5", now, 0, 1_000_000)+"\n")
	m := newHistoryMux(t, fx.root)
	m.sessions["0"] = AgentSession{Agent: "claude", ID: histID1, ClaudeDir: fx.claude}
	h := historyServer(t, fx, m)

	var res usageSummary
	if code := getUsageJSON(t, h, apiRequest("GET", "/api/mux/panes/0/agent/usage", ""), &res); code != 200 {
		t.Fatalf("pane session = %d", code)
	}
	if res.Tokens.Total != 2_000_015 || res.Tokens.Input != 1_000_010 || res.Tokens.Output != 1_000_005 {
		t.Errorf("tokens = %+v", res.Tokens)
	}
	// Opus 1M input $4, Haiku 1M output $0.50; the unknown model only counts
	// tokens.
	if res.CostUSD == nil || *res.CostUSD != 4.5 || res.UnpricedTokens != 15 || len(res.UnpricedModels) != 1 || res.UnpricedModels[0] != "mystery-1" {
		t.Errorf("cost = %v, unpriced %d %v", res.CostUSD, res.UnpricedTokens, res.UnpricedModels)
	}
	if res.Sub == nil || res.Sub.Tokens != 1_000_000 || res.Sub.CostUSD == nil || *res.Sub.CostUSD != 0.5 {
		t.Errorf("sub = %+v", res.Sub)
	}
	if len(res.Models) != 3 || res.Models[0].ID != "claude-haiku-5-5" || res.Models[2].CostUSD != nil || res.PricesUpdated != pricesUpdated {
		t.Errorf("models = %+v", res.Models)
	}

	// The same session through the history, a view-only client too.
	q := "/api/mux/panes/0/agent/usage?agent=claude&session=" + histID1
	var hist usageSummary
	if code := getUsageJSON(t, h, viewRequest("GET", q, ""), &hist); code != 200 || hist.Tokens.Total != res.Tokens.Total {
		t.Errorf("history session = %d %+v", code, hist)
	}
	for q, want := range map[string]int{
		"?agent=claude&session=" + histID2: 404,
		"?agent=gemini&session=" + histID1: 400,
		"?agent=claude&session=x":          400,
		"?session=" + histID1:              400,
	} {
		if rec := serve(h, apiRequest("GET", "/api/mux/panes/0/agent/usage"+q, "")); rec.Code != want {
			t.Errorf("%s = %d, want %d", q, rec.Code, want)
		}
	}
	// A pane without an agent; a transcript not written yet uses nothing.
	if rec := serve(h, apiRequest("GET", "/api/mux/panes/1/agent/usage", "")); rec.Code != 404 {
		t.Errorf("no agent = %d", rec.Code)
	}
	m.sessions["2"] = AgentSession{Agent: "claude", ID: histID3, ClaudeDir: fx.claude}
	var none usageSummary
	if code := getUsageJSON(t, h, apiRequest("GET", "/api/mux/panes/2/agent/usage", ""), &none); code != 200 || none.Tokens.Total != 0 || none.CostUSD != nil || none.Sub != nil {
		t.Errorf("not written = %d %+v", code, none)
	}
	m.sessions["3"] = AgentSession{Agent: "claude", ID: histID3}
	if rec := serve(h, apiRequest("GET", "/api/mux/panes/3/agent/usage", "")); rec.Code != 404 {
		t.Errorf("no transcript = %d", rec.Code)
	}

	req := apiRequest("GET", "/api/mux/panes/0/agent/usage", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != 403 {
		t.Errorf("cross-site = %d", rec.Code)
	}
	if rec := serve(h, apiRequest("POST", "/api/mux/panes/0/agent/usage", "{}")); rec.Code != 405 {
		t.Errorf("POST = %d", rec.Code)
	}
	if strings.Contains(serve(h, apiRequest("GET", "/api/mux/panes/0/agent/usage", "")).Body.String(), fx.claude) {
		t.Error("a path was sent")
	}
}

// bucketTotal adds a summary's tokens up, for one agent or all.
func bucketTotal(b usageBuckets, agent string) (tokens int64, cost float64) {
	for _, x := range b.Buckets {
		if agent == "" || x.Agent == agent {
			tokens += x.Tokens
			if x.CostUSD != nil {
				cost += *x.CostUSD
			}
		}
	}
	return tokens, cost
}

func TestRootUsageRoute(t *testing.T) {
	fx := newHistoryFixture(t)
	gitInit(t, fx.root)
	now := time.Now()
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "hi",
		usageRow("msg_1", "claude-opus-5-5", now, 100, 0),
		usageRow("msg_old", "claude-opus-5-5", now.Add(-9*24*time.Hour), 1000, 0)), now)
	// A fork repeats msg_1: counted once.
	writeClaudeSession(t, fx.claude, fx.root, histID2, claudeRows(fx.root, "main", "fork",
		usageRow("msg_1", "claude-opus-5-5", now, 100, 0),
		usageRow("msg_2", "claude-opus-5-5", now, 20, 0)), now)
	// Written 9 days ago: not read.
	writeClaudeSession(t, fx.claude, fx.root, histID3, claudeRows(fx.root, "main", "old",
		usageRow("msg_3", "claude-opus-5-5", now, 5000, 0)), now.Add(-9*24*time.Hour))
	// A Codex thread with a subagent of its own.
	rollout := writeCodexFile(t, fx.codex, codexParent, codexMetaLine(codexParent, fx.root, nil)+"\n"+codexUserLine("go")+"\n"+
		codexRecordLine(codexParent, "r1", now, 300, 30)+"\n", now)
	_ = rollout
	writeCodexFile(t, fx.codex, codexChild, codexMetaLine(codexChild, fx.root, map[string]any{"thread_source": "subagent", "parent_thread_id": codexParent})+"\n"+
		codexRecordLine(codexChild, "r2", now, 40, 4)+"\n", now.Add(time.Second))
	h := historyServer(t, fx, newHistoryMux(t, fx.root))

	var res usageBuckets
	if code := getUsageJSON(t, h, apiRequest("GET", "/api/mux/panes/0/agent/usage/summary", ""), &res); code != 200 {
		t.Fatalf("summary = %d", code)
	}
	if tok, _ := bucketTotal(res, "claude"); tok != 120 {
		t.Errorf("claude = %d, %+v", tok, res)
	}
	if tok, _ := bucketTotal(res, "codex"); tok != 374 {
		t.Errorf("codex = %d, %+v", tok, res)
	}
	since, err := time.Parse(time.RFC3339, res.Since)
	if err != nil || now.Sub(since) < 8*24*time.Hour || now.Sub(since) > 8*24*time.Hour+usageBucket || res.Truncated {
		t.Errorf("since = %q truncated %v", res.Since, res.Truncated)
	}
	for _, b := range res.Buckets {
		bt, _ := time.Parse(time.RFC3339, b.T)
		if bt.Minute()%15 != 0 || bt.Second() != 0 {
			t.Errorf("bucket %s is not on 15 minutes", b.T)
		}
	}
	// A view-only client reads it in a repo, not outside one.
	if rec := serve(h, viewRequest("GET", "/api/mux/panes/0/agent/usage/summary", "")); rec.Code != 200 {
		t.Errorf("view-only in a repo = %d", rec.Code)
	}
	plain := newHistoryFixture(t)
	assertViewOnly(t, "no repo", serve(historyServer(t, plain, newHistoryMux(t, plain.root)), viewRequest("GET", "/api/mux/panes/0/agent/usage/summary", "")))
	req := apiRequest("GET", "/api/mux/panes/0/agent/usage/summary", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != 403 {
		t.Errorf("cross-site = %d", rec.Code)
	}
}

// codexRecordLine is a token_usage_record of thread at at.
func codexRecordLine(thread, resp string, at time.Time, input, output int) string {
	b, _ := json.Marshal(map[string]any{"timestamp": at.UTC().Format(time.RFC3339Nano), "type": "token_usage_record",
		"payload": map[string]any{"thread_id": thread, "response_id": resp, "usage": map[string]any{"input_tokens": input, "output_tokens": output}}})
	return string(b)
}

func TestMachineUsageRoute(t *testing.T) {
	fx := newHistoryFixture(t)
	now := time.Now()
	other := realTemp(t) // a project outside any pane's root
	writeClaudeSession(t, fx.claude, other, histID1, claudeRows(other, "main", "hi",
		usageRow("msg_1", "claude-opus-5-5", now, 1_000_000, 0)), now)
	subs := filepath.Join(fx.claude, "projects", claudeProjectName(other), histID1, "subagents")
	writeFile(t, filepath.Join(subs, "agent-a1.jsonl"), usageRow("msg_s", "claude-opus-5-5", now, 10, 0)+"\n")
	writeFile(t, filepath.Join(subs, "agent-a1.meta.json"), "{}")
	writeFile(t, filepath.Join(fx.claude, "projects", claudeProjectName(other), "notes.jsonl"), "{}\n")
	writeClaudeSession(t, fx.claude, other, histID3, claudeRows(other, "main", "old", usageRow("msg_3", "claude-opus-5-5", now, 7, 0)), now.Add(-9*24*time.Hour))
	writeCodexFile(t, fx.codex, codexParent, codexMetaLine(codexParent, other, nil)+"\n"+codexRecordLine(codexParent, "r1", now, 300, 30)+"\n", now)
	// A rollout in a day dir from before the summary starts.
	writeCodexFile(t, fx.codex, codexOther, codexMetaLine(codexOther, other, nil)+"\n"+codexRecordLine(codexOther, "r9", now, 1, 1)+"\n", now.Add(-12*24*time.Hour))
	// A rollout started 20 days ago and resumed today: its mtime counts,
	// not its day dir.
	resumed := writeCodexFile(t, fx.codex, codexChild, codexMetaLine(codexChild, other, nil)+"\n"+codexRecordLine(codexChild, "r5", now, 2000, 0)+"\n", now.Add(-20*24*time.Hour))
	if err := os.Chtimes(resumed, now, now); err != nil {
		t.Fatal(err)
	}
	h := historyServer(t, fx, newHistoryMux(t, fx.root))

	var res usageBuckets
	// A view-only client reads it: numbers only.
	if code := getUsageJSON(t, h, viewRequest("GET", "/api/mux/usage", ""), &res); code != 200 {
		t.Fatalf("machine = %d", code)
	}
	if tok, cost := bucketTotal(res, "claude"); tok != 1_000_010 || cost < 4 || cost > 4.0001 {
		t.Errorf("claude = %d $%v", tok, cost)
	}
	if tok, _ := bucketTotal(res, "codex"); tok != 2330 {
		t.Errorf("codex = %d", tok)
	}
	if body := serve(h, apiRequest("GET", "/api/mux/usage", "")).Body.String(); strings.Contains(body, other) || strings.Contains(body, fx.claude) {
		t.Errorf("a path was sent: %s", body)
	}

	// Past usageMaxFiles files per agent: the newest only, truncated.
	old := usageMaxFiles
	usageMaxFiles = 1
	t.Cleanup(func() { usageMaxFiles = old })
	a := newAgentAPI(nil)
	a.history = fx.h
	a.usage = newUsageAPI()
	d := usageDedup{t: newUsageTotals(), seen: map[string]bool{}, since: a.usage.usageSince()}
	if !a.machineClaudeUsage(fx.claude, &d) {
		t.Error("not truncated")
	}
	// Past usageCodexDayDirs day dirs: the newest only, the resumed
	// rollout's day left out.
	oldDays := usageCodexDayDirs
	usageCodexDayDirs = 1
	t.Cleanup(func() { usageCodexDayDirs = oldDays })
	usageMaxFiles = old
	days := usageDedup{t: newUsageTotals(), seen: map[string]bool{}, since: a.usage.usageSince()}
	a.machineCodexUsage(fx.codex, &days)
	if b := bucketsOf(days.t, days.since, false); len(b.Buckets) != 1 || b.Buckets[0].Tokens != 330 {
		t.Errorf("one day dir = %+v", b.Buckets)
	}
	// Dirs that are not there.
	for _, dir := range []string{"", "rel", filepath.Join(fx.root, "none")} {
		if a.machineClaudeUsage(dir, &d) || a.machineCodexUsage(dir, &d) {
			t.Errorf("%q truncated", dir)
		}
	}

	req := apiRequest("GET", "/api/mux/usage", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != 403 {
		t.Errorf("cross-site = %d", rec.Code)
	}
}

func TestMachineUsageSkipsLinks(t *testing.T) {
	canSymlink(t)
	fx := newHistoryFixture(t)
	now := time.Now()
	outside := realTemp(t)
	p := filepath.Join(outside, histID1+".jsonl")
	writeFile(t, p, usageRow("msg_1", "claude-opus-5-5", now, 100, 0)+"\n")
	proj := filepath.Join(fx.claude, "projects", "-p")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(p, filepath.Join(proj, histID2+".jsonl")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(fx.claude, "projects", "-linked")); err != nil {
		t.Fatal(err)
	}
	a := newAgentAPI(nil)
	a.history = fx.h
	a.usage = newUsageAPI()
	d := usageDedup{t: newUsageTotals(), seen: map[string]bool{}, since: a.usage.usageSince()}
	a.machineClaudeUsage(fx.claude, &d)
	if len(d.seen) != 0 {
		t.Errorf("a link out of the dir was read: %v", d.seen)
	}
}

func TestOverviewSessionUsage(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeTranscript(t, dir, testSessionID, usageRow("msg_1", "claude-opus-5-5", now, 1_000_000, 0)+"\n")
	m := &overviewFakeMux{filesFakeMux: filesFakeMux{fakeMux: fakeMux{snap: agentPanes(1)}, dir: dir},
		s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}, found: true}
	mux, agent := newOverviewServer(t, m)
	agent.history = newHistoryAPI()
	agent.usage = newUsageAPI()
	serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/snapshot", nil))

	// The first overview never waits for the read: the field comes later.
	var p overviewPane
	waitUntil(t, "session usage", func() bool {
		p = getOverview(t, mux, false).Panes[0]
		return p.SessionUsage != nil
	})
	if u := p.SessionUsage; u.Tokens != 1_000_000 || u.CostUSD == nil || *u.CostUSD != 4 || u.SubTokens != nil || u.PricesUpdated == "" {
		t.Errorf("session usage = %+v", u)
	}
	// A read that failed: the last totals, marked pending.
	agent.usageJobs.mu.Lock()
	for k, v := range agent.usageJobs.byKey {
		v.failed = true
		agent.usageJobs.byKey[k] = v
	}
	agent.usageJobs.mu.Unlock()
	p = getOverview(t, mux, false).Panes[0]
	if p.SessionUsage == nil || !slices.Contains(p.Unavailable, "sessionUsage") {
		t.Errorf("failed read: usage %+v, unavailable %v", p.SessionUsage, p.Unavailable)
	}
}

func TestOverviewUsageJobs(t *testing.T) {
	j := newOverviewUsageJobs()
	now := time.Unix(1000, 0)
	var mu sync.Mutex
	j.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	step := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
	release := make(chan struct{})
	var err error
	run := func(AgentSession) (usageSummary, error) {
		<-release
		return usageSummary{Tokens: usageTokens{Total: 5}, Sub: &usagePart{Tokens: 2}}, err
	}
	s := AgentSession{Agent: "claude", ID: testSessionID}
	// Nothing yet: queued, the lookup does not wait.
	if _, ok := j.lookup(s, run); ok {
		t.Fatal("a value before any read")
	}
	release <- struct{}{}
	var v overviewUsageEntry
	waitUntil(t, "first read", func() bool {
		var ok bool
		v, ok = j.lookup(s, run)
		return ok
	})
	if v.usage == nil || v.usage.Tokens != 5 || *v.usage.SubTokens != 2 {
		t.Errorf("first = %+v", v.usage)
	}
	// After the TTL, a failed read keeps the last totals and says so.
	err = errNoAgentSession
	step(overviewUsageTTL)
	j.lookup(s, run)
	release <- struct{}{}
	waitUntil(t, "failed read", func() bool {
		v, _ = j.lookup(s, run)
		return v.failed
	})
	if v.usage == nil || v.usage.Tokens != 5 {
		t.Errorf("failed = %+v", v)
	}
	// No transcript: nothing, nothing pending.
	err = errNoTranscript
	step(overviewUsageTTL)
	j.lookup(s, run)
	release <- struct{}{}
	waitUntil(t, "no transcript", func() bool {
		v, _ = j.lookup(s, run)
		return !v.failed
	})
	if v.usage != nil {
		t.Errorf("no transcript = %+v", v)
	}
	// Not asked for in overviewUsageKeep: dropped.
	step(overviewUsageKeep)
	j.lookup(AgentSession{Agent: "codex", ID: testSessionID}, func(AgentSession) (usageSummary, error) { return usageSummary{}, nil })
	j.mu.Lock()
	n := len(j.byKey)
	j.mu.Unlock()
	if n > 1 {
		t.Errorf("%d sessions kept", n)
	}
}
