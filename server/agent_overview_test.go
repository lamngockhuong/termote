package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func parseUsageFixture(t *testing.T) []TranscriptEntry {
	t.Helper()
	b, err := os.ReadFile("testdata/claude/transcript-usage.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	entries, _ := claudeJournal{}.Parse(bytes.NewReader(b), 0)
	return foldToolResults(entries)
}

func TestSummarizeClaudeTranscript(t *testing.T) {
	claude := AgentSession{Agent: "claude"}
	sum := summarizeTranscript(parseUsageFixture(t), claude)
	// The last message's rows repeat one usage: it is taken once; neither
	// the sidechain's nor the <synthetic> error row's is read.
	if sum.usage == nil || sum.usage.ContextTokens != 250 || sum.usage.Model != "claude-model-b" {
		t.Errorf("usage = %+v", sum.usage)
	}
	// No --model seen: 200k assumed, not exact.
	if u := sum.usage; u.ContextWindow != claudeWindowDefault || u.ContextPercent == nil || *u.ContextPercent != 0.1 || u.Exact {
		t.Errorf("share = %+v", u)
	}
	claude.ClaudeWindow = claudeWindowLarge
	if u := summarizeTranscript(parseUsageFixture(t), claude).usage; u.ContextWindow != claudeWindowLarge || !u.Exact {
		t.Errorf("share with --model [1m] = %+v", u)
	}
	if sum.limits != nil {
		t.Errorf("claude limits = %+v", sum.limits)
	}
	// The error is what the agent last showed.
	if sum.lastText != "API Error: overloaded" {
		t.Errorf("lastText = %q", sum.lastText)
	}
	// The last row has no timestamp: the one before it counts.
	if sum.lastTS != "2026-10-13T09:00:07.500Z" {
		t.Errorf("lastTs = %q", sum.lastTS)
	}
	if empty := summarizeTranscript(nil, claude); empty != (transcriptSummary{}) {
		t.Errorf("empty = %+v", empty)
	}
}

func TestSummarizeCodexTranscript(t *testing.T) {
	b, err := os.ReadFile("testdata/codex/rollout-0.159.3.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	entries, _ := codexJournal{}.Parse(bytes.NewReader(b), 0)
	sum := summarizeTranscript(entries, AgentSession{Agent: "codex"})
	if sum.usage != nil || sum.limits != nil || sum.lastTS == "" || sum.lastText == "" {
		t.Errorf("codex = %+v", sum)
	}
}

func TestSummarizeCodexUsage(t *testing.T) {
	sum := summarizeTranscript(parseCodexUsageFixture(t), AgentSession{Agent: "codex"})
	u := sum.usage
	if u == nil || u.ContextTokens != 50_307 || u.ContextWindow != 258_400 || u.ContextPercent == nil ||
		*u.ContextPercent != 15.5 || !u.Exact || u.Model != "" {
		t.Errorf("usage = %+v", u)
	}
	if sum.limits == nil || sum.limits.windows[0].UsedPercent != 3.5 {
		t.Errorf("limits = %+v", sum.limits)
	}
	// A limits-only row on the last entry: the context comes from the one
	// before it.
	entries := []TranscriptEntry{
		{Role: "assistant", usage: &entryUsage{contextTokens: 40_000, window: 100_000}},
		{Role: "assistant", usage: &entryUsage{noContext: true, limits: &codexLimits{ts: "t"}}},
	}
	sum = summarizeTranscript(entries, AgentSession{Agent: "codex"})
	if sum.usage == nil || sum.usage.ContextTokens != 40_000 || sum.limits == nil || sum.limits.ts != "t" {
		t.Errorf("limits only last = %+v, %+v", sum.usage, sum.limits)
	}
}

func TestGatherAccounts(t *testing.T) {
	older := &codexLimits{plan: "plus", ts: "2026-10-14T01:00:00.000Z", windows: []usageWindow{{UsedPercent: 1, WindowMinutes: 300}}}
	newer := &codexLimits{plan: "plus", ts: "2026-10-14T02:00:00.000Z", windows: []usageWindow{{UsedPercent: 9, WindowMinutes: 300}}}
	other := &codexLimits{plan: "pro", ts: "2026-10-14T00:00:00.000Z", windows: []usageWindow{{UsedPercent: 5, WindowMinutes: 10080}}}
	if got := gatherAccounts(nil); got != nil {
		t.Errorf("none = %+v", got)
	}
	got := gatherAccounts([]paneLimits{{"a", older}, {"b", other}, {"a", newer}, {"a", older}})
	if len(got) != 2 || got[0].Key != "a" || got[0].UpdatedAt != newer.ts || got[0].Windows[0].UsedPercent != 9 ||
		got[0].Agent != "codex" || got[1].Key != "b" || got[1].Plan != "pro" {
		t.Errorf("accounts = %+v", got)
	}
}

func TestOverviewCodexAccounts(t *testing.T) {
	home := t.TempDir()
	b, _ := os.ReadFile("testdata/codex/rollout-usage-0.162.1.jsonl")
	rollout := writeRollout(t, home, testCodexID, string(b))
	m := &overviewFakeMux{filesFakeMux: filesFakeMux{fakeMux: fakeMux{snap: agentPanes(2)}},
		s: AgentSession{Agent: "codex", ID: testCodexID, CodexHome: home, Rollout: rollout}, found: true}
	mux, _ := newOverviewServer(t, m)
	serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/snapshot", nil))

	rec := serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/overview", nil))
	var res overviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	// Two panes on one CODEX_HOME: one account, named by both.
	key := accountKey(home)
	if len(res.Accounts) != 1 || res.Accounts[0].Key != key || res.Accounts[0].Plan != "team" ||
		res.Accounts[0].UpdatedAt != "2026-10-14T01:06:10.000Z" || len(res.Accounts[0].Windows) != 2 {
		t.Fatalf("accounts = %+v", res.Accounts)
	}
	for _, p := range res.Panes {
		if p.AccountKey != key || p.Usage == nil || p.Usage.ContextPercent == nil || *p.Usage.ContextPercent != 15.5 {
			t.Errorf("pane = %+v", p)
		}
	}
	// Neither the CODEX_HOME, the rollout nor the fields left out are sent.
	for _, s := range []string{home, filepath.Base(rollout), "limit_id", "credits", "plan_type"} {
		if strings.Contains(rec.Body.String(), s) {
			t.Errorf("overview names %s: %s", s, rec.Body)
		}
	}

	// A Claude pane has no account, and with no Codex pane the field is
	// left out.
	dir := t.TempDir()
	cb, _ := os.ReadFile("testdata/claude/transcript-usage.jsonl")
	writeTranscript(t, dir, testSessionID, string(cb))
	m.s = AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}
	rec = serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/overview", nil))
	if strings.Contains(rec.Body.String(), "accounts") || strings.Contains(rec.Body.String(), "accountKey") {
		t.Errorf("claude only = %s", rec.Body)
	}
}

func TestCutRunes(t *testing.T) {
	long := strings.Repeat("é", overviewTextMax+5)
	if got := cutRunes(long, overviewTextMax); got != strings.Repeat("é", overviewTextMax) {
		t.Errorf("cut to %d runes", len([]rune(got)))
	}
	if cutRunes("abc", 5) != "abc" {
		t.Error("a short string was cut")
	}
}

// overviewFakeMux has panes with agents, a directory per pane and an agent
// locator.
type overviewFakeMux struct {
	filesFakeMux
	s        AgentSession
	found    bool
	err      error
	block    chan struct{}
	sessions atomic.Int32
}

func (m *overviewFakeMux) AgentSession(_ context.Context, pane string) (AgentSession, bool, error) {
	m.sessions.Add(1)
	if m.block != nil {
		<-m.block
	}
	return m.s, m.found, m.err
}

func agentPanes(n int) Snapshot {
	tab := Tab{ID: "w1:t1", Key: "w1:t1"}
	for i := range n {
		tab.Panes = append(tab.Panes, Pane{ID: "w1:p" + string(rune('a'+i%26)) + strings.Repeat("x", i/26),
			Agent: &AgentInfo{Name: "claude", Status: "working"}})
	}
	tab.Panes = append(tab.Panes, Pane{ID: "w1:shell"})
	return Snapshot{Groups: []Group{{ID: "w1", Tabs: []Tab{tab}}}}
}

// newOverviewServer serves the mux routes with files, the overview read
// again on every request.
func newOverviewServer(t *testing.T, m *overviewFakeMux) (*http.ServeMux, *agentAPI) {
	t.Helper()
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, m, newStreamTokenStore(), nil, nil)
	agent.files = registerFilesRoutes(mux, m, parseAllowedHosts("", false), nil)
	agent.overview = newTTLCache[overviewRead](0)
	agent.sessions = newTTLCache[agentLookup](0)
	return mux, agent
}

func getOverview(t *testing.T, mux http.Handler, viewOnly bool) overviewResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/mux/overview", nil)
	if viewOnly {
		req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("overview = %d %s", rec.Code, rec.Body)
	}
	var res overviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func waitForChanges(t *testing.T, mux http.Handler, viewOnly bool) overviewPane {
	t.Helper()
	var p overviewPane
	waitUntil(t, "overview changes", func() bool {
		p = getOverview(t, mux, viewOnly).Panes[0]
		return p.Changed != nil
	})
	return p
}

func TestOverviewRoute(t *testing.T) {
	requireGit(t)
	repo := newTestRepo(t)
	writeFile(t, filepath.Join(repo, "new.txt"), "x\n")
	writeFile(t, filepath.Join(repo, "a.txt"), "two\n")
	dir := t.TempDir()
	b, _ := os.ReadFile("testdata/claude/transcript-usage.jsonl")
	writeTranscript(t, dir, testSessionID, string(b))
	m := &overviewFakeMux{filesFakeMux: filesFakeMux{fakeMux: fakeMux{snap: agentPanes(1)}, dir: repo, files: true},
		s: AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: dir}, found: true}
	mux, agent := newOverviewServer(t, m)

	// Nothing observed yet: no panes.
	if res := getOverview(t, mux, false); len(res.Panes) != 0 || res.ServerNow == "" {
		t.Fatalf("before a snapshot = %+v", res)
	}
	serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/snapshot", nil))
	snapCalls := len(m.calls)

	// One pane (the header's chip): its summary, no changes asked for.
	var one overviewResponse
	rec := serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/overview?pane=w1:pa", nil))
	if err := json.Unmarshal(rec.Body.Bytes(), &one); err != nil {
		t.Fatal(err)
	}
	if len(one.Panes) != 1 || one.Panes[0].Usage == nil || len(one.Panes[0].Unavailable) != 0 {
		t.Errorf("one pane = %+v", one.Panes)
	}
	agent.changes.mu.Lock()
	queued := len(agent.changes.queued) + len(agent.changes.byKey)
	agent.changes.mu.Unlock()
	if queued != 0 {
		t.Errorf("a one-pane read queued changes: %d", queued)
	}
	// A pane with no agent, or none at all: nothing, and nothing cached.
	for _, id := range []string{"w1:shell", "nope"} {
		rec := serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/overview?pane="+id, nil))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"panes":[]`) {
			t.Errorf("pane %s = %d %s", id, rec.Code, rec.Body)
		}
	}
	// A tab id names its active pane (here its first) where tabs are
	// selected on the server, as on tmux.
	if err := json.Unmarshal(serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/overview?pane=w1:t1", nil)).Body.Bytes(), &one); err != nil ||
		len(one.Panes) != 1 || one.Panes[0].PaneID != "w1:pa" {
		t.Errorf("tab id = %+v %v", one.Panes, err)
	}
	agent.overview.mu.Lock()
	_, cached := agent.overview.entries["pane\x00nope"]
	agent.overview.mu.Unlock()
	if cached {
		t.Error("an unknown pane was cached")
	}

	first := getOverview(t, mux, false).Panes
	if len(first) != 1 || first[0].PaneID != "w1:pa" || first[0].Key != "w1:pa" {
		t.Fatalf("panes = %+v", first)
	}
	p := first[0]
	if p.LastText != "API Error: overloaded" || p.Usage == nil || p.Usage.ContextTokens != 250 || p.LastTS == "" {
		t.Errorf("summary = %+v", p)
	}
	p = waitForChanges(t, mux, false)
	if *p.Changed != 2 || p.Branch == "" || len(p.Unavailable) != 0 {
		t.Errorf("changes = %+v", p)
	}
	// The request reads no panes (snapshot), only the agent lookups; the
	// background worker's PaneDir is not counted here.
	if len(m.calls) != snapCalls {
		t.Errorf("overview read the mux: %v", m.calls[snapCalls:])
	}

	// Neither the repo, the transcript nor its dir is ever named.
	rec = serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/overview", nil))
	for _, path := range []string{repo, dir} {
		if strings.Contains(rec.Body.String(), path) {
			t.Errorf("overview names %s: %s", path, rec.Body)
		}
	}

	// A view-only client sees a repo's changes, never a home dir's.
	if p := getOverview(t, mux, true).Panes[0]; p.Changed == nil {
		t.Errorf("view-only in a repo = %+v", p)
	}
	agent.files.homeDirs = []string{repo}
	agent.changes.mu.Lock()
	for k := range agent.changes.byKey {
		delete(agent.changes.byKey, k)
	}
	agent.changes.mu.Unlock()
	waitForChanges(t, mux, false)
	if p := getOverview(t, mux, true).Panes[0]; p.Changed != nil || p.Branch != "" {
		t.Errorf("view-only in a home dir = %+v", p)
	}
	if p := getOverview(t, mux, false).Panes[0]; p.Changed == nil {
		t.Errorf("full client in a home dir = %+v", p)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/mux/overview", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(mux, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
	if rec := serve(mux, httptest.NewRequest(http.MethodPost, "/api/mux/overview", nil)); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
}

func TestOverviewWithoutFilesOrSession(t *testing.T) {
	m := &overviewFakeMux{filesFakeMux: filesFakeMux{fakeMux: fakeMux{snap: agentPanes(2)}}}
	mux, _ := newOverviewServer(t, m)
	serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/snapshot", nil))
	// psmux: no files, no git; no session: nothing to say, nothing pending.
	for _, p := range getOverview(t, mux, false).Panes {
		if strings.Join(p.Unavailable, ",") != "changes" || p.LastText != "" || p.Usage != nil {
			t.Errorf("pane = %+v", p)
		}
	}
	// A session whose transcript cannot be found: nothing either.
	m.s, m.found = AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: "relative"}, true
	for _, p := range getOverview(t, mux, false).Panes {
		if strings.Join(p.Unavailable, ",") != "changes" {
			t.Errorf("no transcript = %+v", p)
		}
	}
	m.err = errFakeLookup
	for _, p := range getOverview(t, mux, false).Panes {
		if strings.Join(p.Unavailable, ",") != "changes,transcript" {
			t.Errorf("failed lookup = %+v", p)
		}
	}
}

var errFakeLookup = os.ErrPermission

func TestOverviewBudgetAndCap(t *testing.T) {
	defer func(d time.Duration) { overviewBudget = d }(overviewBudget)
	overviewBudget = 50 * time.Millisecond
	m := &overviewFakeMux{filesFakeMux: filesFakeMux{fakeMux: fakeMux{snap: agentPanes(overviewMaxPanes + 3)}},
		block: make(chan struct{})}
	defer close(m.block)
	mux, _ := newOverviewServer(t, m)
	serve(mux, httptest.NewRequest(http.MethodGet, "/api/mux/snapshot", nil))
	panes := getOverview(t, mux, false).Panes
	if len(panes) != overviewMaxPanes {
		t.Fatalf("panes = %d, want %d", len(panes), overviewMaxPanes)
	}
	for _, p := range panes {
		if !strings.Contains(strings.Join(p.Unavailable, ","), "transcript") {
			t.Fatalf("slow pane = %+v", p)
		}
	}
}

func TestOverviewChangesNeverWait(t *testing.T) {
	requireGit(t)
	repo := newTestRepo(t)
	filesFor := func(dir string) *filesAPI {
		return registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: dir, files: true}, parseAllowedHosts("", false), nil)
	}
	f := filesFor(repo)
	c := newOverviewChanges()
	job := overviewJob{"k", "p"}

	// One slot taken (a client's diff): the other stays the client's, so
	// nothing runs, nothing is stored, and the root is not backed off.
	f.git.sem <- struct{}{}
	if _, ok := c.refresh(f, job); ok {
		t.Fatal("refresh took the last free git slot")
	}
	if f.git.backingOff(repo) {
		t.Error("a busy overview backed the root off")
	}
	<-f.git.sem

	// A status the Changes view just read is used as is.
	root, _ := f.paneRootForRead(context.Background(), "p")
	writeFile(t, filepath.Join(repo, "b.txt"), "b\n")
	if _, err := f.status(context.Background(), root); err != nil {
		t.Fatal(err)
	}
	for range gitMaxRunning {
		f.git.sem <- struct{}{}
	}
	v, ok := c.refresh(f, job)
	if !ok || !v.status || v.changed != 1 {
		t.Errorf("from the Changes cache = %+v, %v", v, ok)
	}
	for range gitMaxRunning {
		<-f.git.sem
	}

	// A directory that is no repo: a root, no status.
	plain := t.TempDir()
	if v, ok := c.refresh(filesFor(plain), job); !ok || v.status || v.failed {
		t.Errorf("no repo = %+v", v)
	}
	// A pane whose directory cannot be read.
	if v, ok := c.refresh(filesFor(filepath.Join(plain, "gone")), job); !ok || !v.failed {
		t.Errorf("gone dir = %+v", v)
	}
	// A status git fails on (the repo became unreadable). Windows has no
	// mode bits to take the reading away, and root reads anyway.
	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		broken := newTestRepo(t)
		fb := filesFor(broken)
		fb.paneRootForRead(context.Background(), "p")
		os.Chmod(broken, 0)
		defer os.Chmod(broken, 0o755)
		if v, ok := c.refresh(fb, job); !ok || !v.failed {
			t.Errorf("failed status = %+v", v)
		}
	}
}

func TestOverviewChangesQueue(t *testing.T) {
	c := newOverviewChanges()
	clock := &fakeClock{t: time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)}
	c.now = clock.now
	var runs atomic.Int32
	release := make(chan struct{})
	c.runJob = func(_ *filesAPI, j overviewJob) (overviewChange, bool) {
		<-release
		runs.Add(1)
		return overviewChange{at: clock.now(), status: true, changed: 3}, j.key != "busy"
	}
	// Asked twice while queued: read once.
	if _, ok := c.lookup(nil, "a", "p1"); ok {
		t.Fatal("cached before any read")
	}
	c.lookup(nil, "a", "p1")
	c.lookup(nil, "busy", "p2")
	release <- struct{}{}
	release <- struct{}{}
	waitUntil(t, "worker done", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return !c.running
	})
	if runs.Load() != 2 {
		t.Errorf("runs = %d", runs.Load())
	}
	if v, ok := c.lookup(nil, "a", "p1"); !ok || v.changed != 3 {
		t.Errorf("cached = %+v %v", v, ok)
	}
	if _, ok := c.byKey["busy"]; ok {
		t.Error("a busy read was stored")
	}
	// Long unasked: dropped.
	close(release)
	clock.advance(overviewChangesKeep)
	c.lookup(nil, "other", "p3")
	waitUntil(t, "worker done", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return !c.running
	})
	if _, ok := c.byKey["a"]; ok {
		t.Error("changes of a pane nobody asked for were kept")
	}
}

func TestPaneLimitsOfKeepsPaneOrder(t *testing.T) {
	a, b := &codexLimits{ts: "a"}, &codexLimits{ts: "b"}
	panes := []overviewPane{{AccountKey: "k2"}, {}, {AccountKey: "k1"}}
	got := paneLimitsOf(panes, []*codexLimits{b, nil, a})
	if len(got) != 2 || got[0].key != "k2" || got[0].limits != b || got[1].key != "k1" || got[1].limits != a {
		t.Errorf("paneLimitsOf = %+v", got)
	}
}
