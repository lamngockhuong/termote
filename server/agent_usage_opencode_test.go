package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// testOpencodeUsageSession is a session as session.list and session.get give
// it (OpenCode 2.3.0, testdata/opencode/session-get-cost.json): its own
// tokens, cost and model (none when model is "").
func testOpencodeUsageSession(id, parent, dir string, updated int64, input, output int64, cost float64, model string) json.RawMessage {
	s := map[string]any{"id": id, "cost": cost, "title": "t",
		"tokens":   map[string]any{"input": input, "output": output, "reasoning": 0, "cache": map[string]any{"read": 0, "write": 0}},
		"time":     map[string]any{"created": updated - 1000, "updated": updated},
		"location": map[string]any{"directory": dir}}
	if parent != "" {
		s["parentID"] = parent
	}
	if model != "" {
		s["model"] = map[string]any{"id": model, "providerID": "fake", "variant": "default"}
	}
	data, _ := json.Marshal(s)
	return data
}

// testOpencodeAssistant is an assistant message as message.list gives it
// (testdata/opencode/message-list-assistant-cost.json).
func testOpencodeAssistant(id string, at time.Time, input, output int64, cost float64) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"id": id, "type": "assistant", "agent": "build",
		"time":    map[string]any{"created": at.UnixMilli(), "completed": at.UnixMilli() + 10},
		"model":   map[string]any{"id": "m2", "providerID": "fake", "variant": "default"},
		"content": []any{map[string]any{"type": "text", "text": "hello"}}, "finish": "stop", "cost": cost,
		"tokens": map[string]any{"input": input, "output": output, "reasoning": 0, "cache": map[string]any{"read": 0, "write": 0}}})
	return data
}

func testOpencodeUser(id string, at time.Time) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"id": id, "type": "user", "text": "hi", "time": map[string]any{"created": at.UnixMilli()}})
	return data
}

func sessionInfoJSON(s json.RawMessage) json.RawMessage {
	return json.RawMessage(`{"data":` + string(s) + `}`)
}

// The recorded shapes: an assistant message's tokens and the cost OpenCode
// put on it at the provider's price, a session's total with its model.
func TestOpencodeUsageFixtures(t *testing.T) {
	oc := newFakeOpencode(t)
	oc.set(func() {
		oc.messages["ses_c1"] = testOpencodeMessages(t, "message-list-assistant-cost.json")
		oc.sessions["ses_c1"] = testOpencodeFixture(t, "session-get-cost.json")
	})
	c, err := opencodeConnect()
	if err != nil {
		t.Fatal(err)
	}
	recs, truncated, err := c.usageMessages(context.Background(), "ses_c1", time.Unix(0, 0), 100)
	if err != nil || truncated || len(recs) != 1 {
		t.Fatalf("records = %+v %v %v", recs, truncated, err)
	}
	r := recs[0]
	if r.model != "fake/m2" || r.input != 1200 || r.output != 30 || r.cost != 0.00405 || !r.reported || r.at.UnixMilli() != 1794754595336 {
		t.Errorf("record = %+v", r)
	}
	if q := oc.reqs()[len(oc.reqs())-1]; !strings.Contains(q, "type=assistant") || !strings.Contains(q, "order=desc") {
		t.Errorf("asked %q", q)
	}
	sum, err := opencodeSessionUsage("ses_c1")
	if err != nil {
		t.Fatal(err)
	}
	// The session's own total holds the request that made its title.
	if sum.Tokens.Total != 2460 || sum.CostUSD == nil || *sum.CostUSD != 0.0041 || sum.Sub != nil ||
		len(sum.Models) != 0 || sum.UnpricedTokens != 0 {
		t.Errorf("summary = %+v", sum)
	}
	// A fork's copies of its parent's messages are not its own.
	oc.set(func() { oc.messages["ses_f"] = testOpencodeMessages(t, "message-list-assistant-fork.json") })
	if recs, _, err := c.usageMessages(context.Background(), "ses_f", time.Unix(0, 0), 100); err != nil || len(recs) != 0 {
		t.Errorf("fork records = %+v %v", recs, err)
	}
}

func TestOpencodeUsageRecord(t *testing.T) {
	tok := &opencodeTokens{Input: 10, Output: 5, Reasoning: 3}
	tok.Cache.Read, tok.Cache.Write = 7, 2
	ok := opencodeUsageMessage{ID: "msg_A1", Type: "assistant", Model: opencodeModelRef{ID: "m", ProviderID: "p"}, Cost: 0.25, Tokens: tok}
	ok.Time.Created = 1794754595336
	r, got := opencodeUsageRecord(ok)
	// Reasoning goes into output, as termote counts it; the total is
	// OpenCode's own.
	if !got || r.input != 10 || r.output != 8 || r.reasoning != 3 || r.cacheRead != 7 || r.cacheWrite5m != 2 ||
		r.model != "p/m" || r.key != "msg_A1" || r.cost != 0.25 || !r.reported {
		t.Errorf("record = %+v", r)
	}
	var c tokenCounts
	c.add(r)
	if c.total() != tok.total() {
		t.Errorf("total %d, OpenCode's %d", c.total(), tok.total())
	}
	for name, m := range map[string]func(*opencodeUsageMessage){
		"copy":    func(m *opencodeUsageMessage) { m.ID = "msg_A1_3" },
		"bad id":  func(m *opencodeUsageMessage) { m.ID = "../x" },
		"user":    func(m *opencodeUsageMessage) { m.Type = "user" },
		"no time": func(m *opencodeUsageMessage) { m.Time.Created = 0 },
		"nothing": func(m *opencodeUsageMessage) { m.Tokens = nil },
	} {
		bad := ok
		m(&bad)
		if _, got := opencodeUsageRecord(bad); got {
			t.Errorf("%s: counted", name)
		}
	}
	for _, v := range []float64{-1, math.NaN(), math.Inf(1)} {
		if opencodeCost(v) != 0 {
			t.Errorf("cost %v kept", v)
		}
	}
	for m, want := range map[opencodeModelRef]string{{}: "unknown", {ID: "m"}: "m", {ID: "m", ProviderID: "p"}: "p/m"} {
		if got := opencodeModelName(m); got != want {
			t.Errorf("%+v = %q", m, got)
		}
	}
	// A cost the agent recorded: shown above 0, its tokens never unpriced.
	for _, tc := range []struct {
		c                tokenCounts
		priced, unpriced bool
	}{
		{tokenCounts{reported: true, cost: 0.1}, true, false},
		{tokenCounts{reported: true}, false, false},
		{tokenCounts{}, false, true},
	} {
		if p, u := pricing("fake/m2", tc.c); p != tc.priced || u != tc.unpriced {
			t.Errorf("%+v = %v %v", tc.c, p, u)
		}
	}
}

// A session's usage is the service's totals: its own, then its subagents'
// (children and grandchildren) apart, never another session's subagents.
func TestOpencodeSessionUsage(t *testing.T) {
	oc := newFakeOpencode(t)
	logs := captureLogs(t)
	oc.set(func() {
		oc.sessions["sesP"] = sessionInfoJSON(testOpencodeUsageSession("sesP", "", "/work/proj", 5000, 1000, 50, 0.5, "m2"))
		oc.sessions["sesFree"] = sessionInfoJSON(testOpencodeUsageSession("sesFree", "", "/work/proj", 5000, 400, 10, 0, ""))
		oc.list = []json.RawMessage{
			testOpencodeUsageSession("ses_kid", "sesP", "/work/proj", 4000, 300, 20, 0.1, "m1"),
			testOpencodeUsageSession("ses_grand", "ses_kid", "/work/proj", 3000, 100, 0, 0, ""),
			testOpencodeUsageSession("ses_great", "ses_grand", "/work/proj", 2000, 9000, 0, 9, ""),
			testOpencodeUsageSession("ses_other", "sesFree", "/work/proj", 4000, 77, 0, 0, ""),
		}
	})
	sum, err := opencodeSessionUsage("sesP")
	if err != nil {
		t.Fatal(err)
	}
	// Two levels of subagents, as the tree: a great-grandchild is left out.
	if sum.Tokens.Total != 1050+320+100 || sum.Tokens.Input != 1400 || sum.CostUSD == nil || *sum.CostUSD != 0.6 ||
		sum.Sub == nil || sum.Sub.Tokens != 420 || sum.Sub.CostUSD == nil || *sum.Sub.CostUSD != 0.1 || sum.UnpricedTokens != 0 {
		t.Errorf("summary = %+v sub %+v", sum, sum.Sub)
	}
	// Not split by model: a session's model is the last one it used.
	if sum.Models == nil || len(sum.Models) != 0 {
		t.Errorf("models = %+v", sum.Models)
	}
	// Cost 0 (a local or free model): tokens only, nothing unpriced.
	free, err := opencodeSessionUsage("sesFree")
	if err != nil || free.Tokens.Total != 410+77 || free.CostUSD != nil || free.UnpricedTokens != 0 ||
		len(free.UnpricedModels) != 0 || free.Sub == nil || free.Sub.CostUSD != nil {
		t.Errorf("free = %+v %v", free, err)
	}
	// A session the service does not hold yet has used nothing.
	if none, err := opencodeSessionUsage("sesNew"); err != nil || none.Tokens.Total != 0 || none.Sub != nil {
		t.Errorf("new = %+v %v", none, err)
	}
	if _, err := opencodeSessionUsage("../x"); err != nil {
		t.Errorf("bad id: %v", err)
	}
	// A failing service is an error, its words never in it.
	oc.set(func() { oc.status = http.StatusInternalServerError })
	if _, err := opencodeSessionUsage("sesP"); err == nil || strings.Contains(err.Error(), "internal words") {
		t.Errorf("failing service: %v", err)
	}
	// No service: no transcript.
	stubOpencodeStateDir(t, t.TempDir())
	if _, err := opencodeSessionUsage("sesP"); err != errNoTranscript {
		t.Errorf("no service: %v", err)
	}
	if strings.Contains(logs.String(), testOpencodePassword) {
		t.Error("password logged")
	}
}

// The usage route for an OpenCode session of the history (a view-only
// client too) and the card of a pane running one.
func TestOpencodeUsageRoutes(t *testing.T) {
	fx := newOpencodeHistoryFixture(t)
	now := time.Now().UnixMilli()
	fx.oc.set(func() {
		fx.oc.sessions["sesRoot"] = sessionInfoJSON(testOpencodeUsageSession("sesRoot", "", fx.root, now-1000, 2000, 100, 0.25, "m2"))
	})
	var res usageSummary
	q := "/api/mux/panes/0/agent/usage?agent=opencode&session=sesRoot"
	if code := getUsageJSON(t, fx.h, viewRequest("GET", q, ""), &res); code != 200 || res.Tokens.Total != 2100 ||
		res.CostUSD == nil || *res.CostUSD != 0.25 {
		t.Errorf("history session = %d %+v", code, res)
	}
	// Another root's session is not found.
	if rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/0/agent/usage?agent=opencode&session=sesOut", "")); rec.Code != 404 {
		t.Errorf("another root's session = %d", rec.Code)
	}
	// A failing service: an error with none of its words.
	fx.oc.set(func() { fx.oc.status = http.StatusBadGateway })
	newer := "/api/mux/panes/0/agent/usage?agent=opencode&session=sesSub"
	if rec := serve(fx.h, apiRequest("GET", newer, "")); rec.Code < 400 || strings.Contains(rec.Body.String(), "internal words") {
		t.Errorf("failing service = %d %s", rec.Code, rec.Body)
	}

	// The card of a pane running an OpenCode session.
	oc := newFakeOpencode(t)
	oc.set(func() {
		oc.sessions["sesPane"] = sessionInfoJSON(testOpencodeUsageSession("sesPane", "", "/work/proj", now, 500, 20, 0, "m1"))
	})
	a := newAgentAPI(nil)
	a.loc = fakeOpencodeLocator{AgentSession{Agent: "opencode", ID: "sesPane", Status: "idle"}}
	a.history = fx.historyFixture.h
	a.usage = newUsageAPI()
	deadline := time.Now().Add(5 * time.Second)
	var u *overviewSessionUsage
	for u == nil && time.Now().Before(deadline) {
		u, _ = a.paneSessionUsage("0")
		time.Sleep(10 * time.Millisecond)
	}
	if u == nil || u.Tokens != 520 || u.CostUSD != nil || u.UnpricedTokens != 0 || u.SubTokens != nil {
		t.Errorf("card = %+v", u)
	}
}

// opencodeUsageFixture is the history fixture with assistant messages: in
// the root sesRoot (one older than the summary, one a fork's copy), its
// subagent ses_child1, sesSub under the root, sesOut of another root.
func opencodeUsageFixture(t *testing.T) *opencodeHistoryFixture {
	t.Helper()
	fx := newOpencodeHistoryFixture(t)
	now := time.Now()
	fx.oc.set(func() {
		fx.oc.messages["sesRoot"] = []json.RawMessage{
			testOpencodeAssistant("msg_old", now.Add(-9*24*time.Hour), 5000, 0, 5),
			testOpencodeUser("msg_u1", now),
			testOpencodeAssistant("msg_r1_2", now, 7000, 0, 7),
			testOpencodeAssistant("msg_r1", now, 100, 10, 0.5),
		}
		fx.oc.messages["ses_child1"] = []json.RawMessage{testOpencodeAssistant("msg_c1", now, 40, 0, 0.25)}
		fx.oc.messages["sesSub"] = []json.RawMessage{testOpencodeAssistant("msg_s1", now, 3, 0, 0)}
		fx.oc.messages["sesOut"] = []json.RawMessage{testOpencodeAssistant("msg_o1", now, 900, 0, 1)}
		fx.oc.messages["sesSibling"] = []json.RawMessage{testOpencodeAssistant("msg_x1", now, 60, 0, 0)}
	})
	return fx
}

func TestOpencodeRootUsage(t *testing.T) {
	fx := opencodeUsageFixture(t)
	var res usageBuckets
	if code := getUsageJSON(t, fx.h, viewRequest("GET", "/api/mux/panes/0/agent/usage/summary", ""), &res); code != 200 {
		t.Fatalf("summary = %d", code)
	}
	// The root's sessions and their subagents, in the range, copies left
	// out; sesOut and the sibling folder's are not the root's.
	if tok, cost := bucketTotal(res, "opencode"); tok != 110+40+3 || math.Abs(cost-0.75) > 1e-9 || res.Truncated {
		t.Errorf("opencode = %d $%v truncated %v %+v", tok, cost, res.Truncated, res.Buckets)
	}
	// Cost 0 only: tokens, no money, nothing unpriced.
	for _, b := range res.Buckets {
		if b.Agent == "opencode" && b.UnpricedTokens != 0 {
			t.Errorf("bucket %+v", b)
		}
	}
	for _, r := range fx.oc.reqs() {
		if strings.Contains(r, "sesOut") || strings.Contains(r, "sesSibling") {
			t.Errorf("read %s", r)
		}
	}
}

func TestOpencodeMachineUsage(t *testing.T) {
	fx := opencodeUsageFixture(t)
	now := time.Now().UnixMilli()
	fx.oc.set(func() {
		fx.oc.list = append(fx.oc.list, testOpencodeSession("sesOld", "", "old", fx.root, now-10*24*3600*1000))
		fx.oc.messages["sesOld"] = []json.RawMessage{testOpencodeAssistant("msg_z", time.Now(), 1, 0, 0)}
	})
	var res usageBuckets
	if code := getUsageJSON(t, fx.h, viewRequest("GET", "/api/mux/usage", ""), &res); code != 200 {
		t.Fatalf("machine = %d", code)
	}
	// Every session, subagents' and other roots' too, updated in the range.
	if tok, cost := bucketTotal(res, "opencode"); tok != 110+40+3+900+60 || math.Abs(cost-1.75) > 1e-9 || res.Truncated {
		t.Errorf("opencode = %d $%v truncated %v", tok, cost, res.Truncated)
	}
	for _, r := range fx.oc.reqs() {
		if strings.Contains(r, "sesOld/") {
			t.Errorf("read a session not updated in the range: %s", r)
		}
	}
	// Read again within the cache: a session not updated is not.
	n := len(fx.oc.reqs())
	d := usageDedup{t: newUsageTotals(), seen: map[string]bool{}, since: time.Now().Add(-usageDays * 24 * time.Hour)}
	opencodeMachineUsage(&d)
	for _, r := range fx.oc.reqs()[n:] {
		if strings.Contains(r, "/message") {
			t.Errorf("read again: %s", r)
		}
	}

	// Past usageMaxFiles sessions: the newest only, truncated.
	old := usageMaxFiles
	usageMaxFiles = 2
	t.Cleanup(func() { usageMaxFiles = old })
	d = usageDedup{t: newUsageTotals(), seen: map[string]bool{}, since: d.since}
	if !opencodeMachineUsage(&d) {
		t.Error("not truncated")
	}
	usageMaxFiles = old
	// Past opencodeUsageMaxMessages of one session: truncated.
	c, _ := opencodeConnect()
	if recs, truncated, err := c.usageMessages(context.Background(), "sesRoot", d.since, 1); err != nil || !truncated || len(recs) != 1 {
		t.Errorf("one message = %+v %v %v", recs, truncated, err)
	}
}

// A service that does not run adds nothing; one that fails adds nothing
// and marks the summary truncated: Claude Code's share is still there, and
// none of the service's words reach the client or the log.
func TestOpencodeUsageServiceDown(t *testing.T) {
	fx := newHistoryFixture(t)
	gitInit(t, fx.root)
	now := time.Now()
	writeClaudeSession(t, fx.claude, fx.root, histID1, claudeRows(fx.root, "main", "hi",
		usageRow("msg_1", "claude-opus-5-5", now, 100, 0)), now)
	h := historyServer(t, fx, newHistoryMux(t, fx.root))
	logs := captureLogs(t)
	stubOpencodeStateDir(t, t.TempDir())
	for _, path := range []string{"/api/mux/usage", "/api/mux/panes/0/agent/usage/summary"} {
		var res usageBuckets
		if code := getUsageJSON(t, h, apiRequest("GET", path, ""), &res); code != 200 || res.Truncated {
			t.Fatalf("%s = %d %+v", path, code, res)
		}
		if tok, _ := bucketTotal(res, "claude"); tok != 100 {
			t.Errorf("%s: claude = %d", path, tok)
		}
		if tok, _ := bucketTotal(res, "opencode"); tok != 0 {
			t.Errorf("%s: opencode = %d", path, tok)
		}
	}
	oc := newFakeOpencode(t)
	oc.set(func() { oc.status = http.StatusInternalServerError })
	d := usageDedup{t: newUsageTotals(), seen: map[string]bool{}, since: now.Add(-usageDays * 24 * time.Hour)}
	if !opencodeMachineUsage(&d) {
		t.Error("a failing service is not truncated")
	}
	oc.set(func() {
		oc.status = 0
		oc.list = []json.RawMessage{testOpencodeSession("sesA", "", "t", "/w", now.UnixMilli())}
	})
	oc.set(func() { oc.status = http.StatusInternalServerError })
	if opencodeRootUsage([]historySession{{Agent: "opencode", ID: "sesA", updated: now}}, &d) != true {
		t.Error("a failing session read is not truncated")
	}
	if bucketsOf(d.t, d.since, false).Buckets == nil || strings.Contains(logs.String(), "internal words") ||
		strings.Contains(logs.String(), testOpencodePassword) {
		t.Errorf("logged: %s", logs)
	}
	// No session of OpenCode in the root: the service is not asked.
	n := len(oc.reqs())
	if opencodeRootUsage(nil, &d) || len(oc.reqs()) != n {
		t.Error("asked for nothing")
	}
}

// The messages are read a page at a time, newest first, until one older
// than the summary.
func TestOpencodeUsageMessagesPages(t *testing.T) {
	oc := newFakeOpencode(t)
	now := time.Now()
	since := now.Add(-time.Hour)
	var msgs []json.RawMessage
	msgs = append(msgs, testOpencodeAssistant("msg_old", now.Add(-2*time.Hour), 9, 0, 0))
	for i := range 250 {
		msgs = append(msgs, testOpencodeAssistant("msg_n"+strconv.Itoa(i), now.Add(time.Duration(i-300)*time.Second), 1, 0, 0))
	}
	oc.set(func() { oc.messages["sesP"] = msgs })
	c, _ := opencodeConnect()
	recs, truncated, err := c.usageMessages(context.Background(), "sesP", since, opencodeUsageMaxMessages)
	if err != nil || truncated || len(recs) != 250 || recs[0].key != "msg_n249" {
		t.Errorf("records = %d %v %v", len(recs), truncated, err)
	}
	pages := 0
	for _, r := range oc.reqs() {
		if strings.Contains(r, "/message?") {
			pages++
		}
	}
	if pages != 3 {
		t.Errorf("%d pages read", pages)
	}
	if _, _, err := c.usageMessages(context.Background(), "../x", since, 1); err == nil {
		t.Error("read a bad id")
	}
}

// A session deleted between the list and the read of its messages is gone,
// not left out: the summary is not truncated.
func TestOpencodeUsageDeletedSession(t *testing.T) {
	oc := newFakeOpencode(t)
	now := time.Now()
	oc.set(func() { oc.list = []json.RawMessage{testOpencodeSession("sesGone", "", "t", "/w", now.UnixMilli())} })
	d := usageDedup{t: newUsageTotals(), seen: map[string]bool{}, since: now.Add(-usageDays * 24 * time.Hour)}
	if opencodeMachineUsage(&d) {
		t.Error("truncated by a deleted session")
	}
}
