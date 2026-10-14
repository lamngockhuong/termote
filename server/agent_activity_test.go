package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClock is a settable clock for the tracker.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time            { return c.t }
func (c *fakeClock) advance(d time.Duration)   { c.t = c.t.Add(d) }
func (c *fakeClock) at(d time.Duration) string { return c.t.Add(d).UTC().Format(activityTimeFormat) }

func newTestTracker() (*activityTracker, *fakeClock) {
	c := &fakeClock{t: time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)}
	return newActivityTracker(c.now), c
}

// herdrLike is one group of Herdr-like panes (ids that never shift), with
// the agent status of each ("" = no agent).
func herdrLike(statuses ...string) Snapshot {
	tab := Tab{ID: "w1:t1", Key: "w1:t1", Name: "t"}
	for i, s := range statuses {
		p := Pane{ID: "w1:p" + string(rune('1'+i))}
		if s != "" {
			p.Agent = &AgentInfo{Name: "claude", Status: s}
		}
		tab.Panes = append(tab.Panes, p)
	}
	return Snapshot{Groups: []Group{{ID: "w1", Name: "w", Tabs: []Tab{tab}}}}
}

func observeNow(t *activityTracker, snap Snapshot) Snapshot {
	return t.observe(t.begin(), snap)
}

func agentOf(s Snapshot, pane string) *AgentInfo {
	for _, g := range s.Groups {
		for _, t := range g.Tabs {
			for _, p := range t.Panes {
				if p.ID == pane {
					return p.Agent
				}
			}
		}
	}
	return nil
}

func eventsOf(t *activityTracker) []string {
	var out []string
	for _, e := range t.eventsAfter(0, false).Events {
		out = append(out, e.PaneID+":"+e.From+">"+e.To)
	}
	return out
}

func TestActivityFirstSightingAndChange(t *testing.T) {
	tr, c := newTestTracker()
	out := observeNow(tr, herdrLike("working", ""))
	a := agentOf(out, "w1:p1")
	if a.Since != c.at(0) || !a.SinceFirstSeen {
		t.Errorf("first sighting = %+v", a)
	}
	if out.ServerNow != c.at(0) {
		t.Errorf("serverNow = %q", out.ServerNow)
	}
	if agentOf(out, "w1:p2") != nil {
		t.Error("a pane without an agent got one")
	}

	c.advance(time.Minute)
	a = agentOf(observeNow(tr, herdrLike("working", "")), "w1:p1")
	if a.Since != c.at(-time.Minute) || !a.SinceFirstSeen {
		t.Errorf("same status moved since: %+v", a)
	}

	c.advance(time.Minute)
	a = agentOf(observeNow(tr, herdrLike("blocked", "")), "w1:p1")
	if a.Since != c.at(0) || a.SinceFirstSeen {
		t.Errorf("after a change = %+v", a)
	}
	got := strings.Join(eventsOf(tr), " ")
	if got != "w1:p1:>working w1:p1:working>blocked" {
		t.Errorf("events = %s", got)
	}
}

func TestActivityUnknownKeepsStatus(t *testing.T) {
	tr, c := newTestTracker()
	observeNow(tr, herdrLike("working"))
	c.advance(time.Minute)
	a := agentOf(observeNow(tr, herdrLike("unknown")), "w1:p1")
	if a.Status != "unknown" || a.Since != c.at(-time.Minute) {
		t.Errorf("unknown = %+v", a)
	}
	if n := len(eventsOf(tr)); n != 1 {
		t.Errorf("events = %v", eventsOf(tr))
	}
	// An agent first seen with no status is not tracked.
	tr2, _ := newTestTracker()
	if a := agentOf(observeNow(tr2, herdrLike("unknown")), "w1:p1"); a.Since != "" {
		t.Errorf("untracked = %+v", a)
	}
}

func TestActivityPaneGoneIsForgotten(t *testing.T) {
	tr, c := newTestTracker()
	observeNow(tr, herdrLike("working"))
	observeNow(tr, herdrLike(""))
	c.advance(time.Minute)
	a := agentOf(observeNow(tr, herdrLike("idle")), "w1:p1")
	if !a.SinceFirstSeen || a.Since != c.at(0) {
		t.Errorf("after the agent went = %+v", a)
	}
	got := strings.Join(eventsOf(tr), " ")
	if got != "w1:p1:>working w1:p1:working> w1:p1:>idle" {
		t.Errorf("events = %s", got)
	}
}

// tmuxLike is a tmux group: tab ids are window indexes, keys window ids,
// pane keys %N.
func tmuxLike(tabs ...[3]string) Snapshot {
	g := Group{ID: "$1", Name: "s"}
	for _, t := range tabs {
		id, wid, pid := t[0], t[1], t[2]
		g.Tabs = append(g.Tabs, Tab{ID: id, Key: wid, Panes: []Pane{{ID: id, key: pid,
			Agent: &AgentInfo{Name: "claude", Status: "working"}}}})
	}
	return Snapshot{Groups: []Group{g}}
}

func TestActivityWindowMoveKeepsHistory(t *testing.T) {
	tr, c := newTestTracker()
	observeNow(tr, tmuxLike([3]string{"$1:1", "@1", "%1"}, [3]string{"$1:2", "@2", "%2"}))
	c.advance(time.Minute)
	// Windows swapped: the ids now name the other window.
	out := observeNow(tr, tmuxLike([3]string{"$1:1", "@2", "%2"}, [3]string{"$1:2", "@1", "%1"}))
	if a := agentOf(out, "$1:1"); a.Since != c.at(-time.Minute) {
		t.Errorf("moved window lost its since: %+v", a)
	}
	if n := len(eventsOf(tr)); n != 2 {
		t.Errorf("a move made events: %v", eventsOf(tr))
	}
	if e := tr.eventsAfter(0, false).Events[0]; e.Key != "@1" {
		t.Errorf("event key = %q, want the tab's key", e.Key)
	}
}

func TestActivityActivePaneChange(t *testing.T) {
	tr, _ := newTestTracker()
	observeNow(tr, tmuxLike([3]string{"$1:1", "@1", "%1"}))
	// Another pane of the window became active: the old agent went.
	observeNow(tr, tmuxLike([3]string{"$1:1", "@1", "%7"}))
	got := strings.Join(eventsOf(tr), " ")
	if got != "$1:1:>working $1:1:working> $1:1:>working" {
		t.Errorf("events = %s", got)
	}
}

// psmuxLike: tabs keyed by their index.
func psmuxLike(ids ...string) Snapshot {
	g := Group{ID: "s", Name: "s"}
	for _, id := range ids {
		g.Tabs = append(g.Tabs, Tab{ID: id, Key: id, Panes: []Pane{{ID: id,
			Agent: &AgentInfo{Name: "claude", Status: "working"}}}})
	}
	return Snapshot{Groups: []Group{g}}
}

func TestActivityPsmuxRenumberForgets(t *testing.T) {
	tr, c := newTestTracker()
	observeNow(tr, psmuxLike("s:0", "s:1"))
	c.advance(time.Minute)
	observeNow(tr, psmuxLike("s:0", "s:1"))
	if a := agentOf(observeNow(tr, psmuxLike("s:0", "s:1")), "s:1"); a.Since != c.at(-time.Minute) {
		t.Errorf("unchanged tabs lost since: %+v", a)
	}
	c.advance(time.Minute)
	out := observeNow(tr, psmuxLike("s:0"))
	if a := agentOf(out, "s:0"); !a.SinceFirstSeen || a.Since != c.at(0) {
		t.Errorf("after a tab closed = %+v", a)
	}
	if n := len(eventsOf(tr)); n != 2 {
		t.Errorf("a renumbering made events: %v", eventsOf(tr))
	}
	// A group gone forgets its tabs.
	observeNow(tr, Snapshot{})
	if len(tr.indexTabs) != 0 {
		t.Errorf("indexTabs = %v", tr.indexTabs)
	}
}

// zellijLike is a Zellij session's group: ids and keys start with its gid.
func zellijLike(session string) Snapshot {
	gid := zellijGroupID(session)
	return Snapshot{Groups: []Group{{ID: gid, Name: session, Tabs: []Tab{{ID: gid + ":t0", Key: zellijPaneKey(session, 1),
		Panes: []Pane{{ID: gid + ":p1", key: zellijPaneKey(session, 1), Agent: &AgentInfo{Name: "claude", Status: "blocked"}}}}}}}}
}

func TestActivityZellijRename(t *testing.T) {
	tr, c := newTestTracker()
	observeNow(tr, zellijLike("a"))
	stale := tr.begin() // a read started before the rename
	c.advance(time.Minute)
	tr.renameGroup(zellijGroupID("a"), zellijGroupID("b"))
	if tr.observe(stale, zellijLike("a")); len(eventsOf(tr)) != 1 {
		t.Errorf("a read from before the rename made events: %v", eventsOf(tr))
	}
	if _, ok := tr.lastSnapshot(); ok {
		t.Error("a read from before the rename became the last snapshot")
	}
	out := observeNow(tr, zellijLike("b"))
	if a := agentOf(out, zellijGroupID("b")+":p1"); a.Since != c.at(-time.Minute) {
		t.Errorf("renamed from Termote lost since: %+v", a)
	}
	e := tr.eventsAfter(0, false).Events[0]
	if e.Key != zellijGroupID("b")+":p1" || e.GroupID != zellijGroupID("b") || e.TabID != zellijGroupID("b")+":t0" {
		t.Errorf("event after rename = %+v", e)
	}
	// Renamed outside Termote: the history starts again.
	c.advance(time.Minute)
	out = observeNow(tr, zellijLike("c"))
	if a := agentOf(out, zellijGroupID("c")+":p1"); !a.SinceFirstSeen || a.Since != c.at(0) {
		t.Errorf("renamed outside = %+v", a)
	}
	if got := renamedGroupID("zab", "za", "zb"); got != "zab" {
		t.Errorf("renamedGroupID matched a longer id: %s", got)
	}
}

func TestActivityOutOfOrderSnapshots(t *testing.T) {
	tr, c := newTestTracker()
	observeNow(tr, herdrLike("working"))
	older, newer := tr.begin(), tr.begin()
	c.advance(time.Minute)
	tr.observe(newer, herdrLike("blocked"))
	out := tr.observe(older, herdrLike("working")) // finished late
	if got := strings.Join(eventsOf(tr), " "); got != "w1:p1:>working w1:p1:working>blocked" {
		t.Errorf("events = %s", got)
	}
	if a := agentOf(out, "w1:p1"); a.Since != c.at(0) {
		t.Errorf("stale read since = %+v, want the known one", a)
	}
	if last, _ := tr.lastSnapshot(); agentOf(last, "w1:p1").Status != "blocked" {
		t.Error("lastSnapshot took the stale read")
	}
}

func TestActivityRingAndCursor(t *testing.T) {
	tr, _ := newTestTracker()
	statuses := []string{"working", "blocked"}
	for i := 0; i < activityRingLen+10; i++ {
		observeNow(tr, herdrLike(statuses[i%2]))
	}
	p := tr.eventsAfter(0, false)
	if len(p.Events) != activityRingLen || p.Oldest != 11 || p.Latest != activityRingLen+10 || !p.Reset {
		t.Errorf("full = %d events, oldest %d, latest %d, reset %v", len(p.Events), p.Oldest, p.Latest, p.Reset)
	}
	if p := tr.eventsAfter(p.Latest-2, true); len(p.Events) != 2 || p.Reset {
		t.Errorf("after = %+v", p)
	}
	if p := tr.eventsAfter(10, true); p.Reset || len(p.Events) != activityRingLen {
		t.Errorf("cursor right before the oldest = reset %v, %d", p.Reset, len(p.Events))
	}
	if p := tr.eventsAfter(3, true); !p.Reset || len(p.Events) != activityRingLen {
		t.Errorf("cursor older than the ring = reset %v", p.Reset)
	}
	if p := tr.eventsAfter(p.Latest+5, true); !p.Reset {
		t.Error("cursor from before a restart not reset")
	}
	empty, _ := newTestTracker()
	if p := empty.eventsAfter(0, true); p.Reset || p.Events == nil || p.Oldest != 0 {
		t.Errorf("empty = %+v", p)
	}
}

func TestActivityNilTracker(t *testing.T) {
	var tr *activityTracker
	snap := herdrLike("working")
	if tr.begin() != 0 || agentOf(tr.observe(0, snap), "w1:p1") != agentOf(snap, "w1:p1") {
		t.Error("a nil tracker changed the snapshot")
	}
}

// observe never writes into the snapshot it is given: Herdr's cache shares
// its AgentInfo with every reader.
func TestActivityObserveSharedSnapshot(t *testing.T) {
	tr, _ := newTestTracker()
	shared := herdrLike("working", "blocked")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			observeNow(tr, copySnapshot(shared))
		}()
		go func() {
			defer wg.Done()
			b, _ := json.Marshal(shared)
			_ = b
		}()
	}
	wg.Wait()
	if a := agentOf(shared, "w1:p1"); a.Since != "" {
		t.Errorf("observe wrote into the shared snapshot: %+v", a)
	}
}

func TestActivityHerdrCacheRace(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	tr, _ := newTestTracker()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			gen := tr.begin()
			snap, err := m.Snapshot(context.Background())
			if err == nil {
				json.Marshal(tr.observe(gen, snap))
			}
		}()
	}
	wg.Wait()
}

func TestActivityPushTickFeedsTracker(t *testing.T) {
	tr, _ := newTestTracker()
	w, _, _ := newTestWatcher(t, func() (Snapshot, error) { return herdrLike("working"), nil })
	w.store.add(fcmSub(t, 1))
	w.activity = tr
	w.tick(context.Background())
	if n := len(eventsOf(tr)); n != 1 {
		t.Errorf("tick events = %d", n)
	}
}

func TestActivityRoute(t *testing.T) {
	m := &fakeMux{snap: herdrLike("working")}
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, m, newStreamTokenStore(), nil, nil)

	get := func(path string, cross bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if cross {
			req.Header.Set("Sec-Fetch-Site", "cross-site")
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	// The snapshot route feeds the tracker and returns since.
	var snap Snapshot
	json.Unmarshal(get("/api/mux/snapshot", false).Body.Bytes(), &snap)
	if a := agentOf(snap, "w1:p1"); a == nil || a.Since == "" || snap.ServerNow == "" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if agent.activity == nil {
		t.Fatal("no tracker")
	}

	rec := get("/api/mux/activity", false)
	var page activityPage
	json.Unmarshal(rec.Body.Bytes(), &page)
	if rec.Code != 200 || len(page.Events) != 1 || !page.Reset || page.ServerNow == "" {
		t.Errorf("activity = %d %s", rec.Code, rec.Body)
	}
	rec = get("/api/mux/activity?after=1", false)
	page = activityPage{}
	json.Unmarshal(rec.Body.Bytes(), &page)
	if len(page.Events) != 0 || page.Reset {
		t.Errorf("after=1 = %s", rec.Body)
	}
	for _, q := range []string{"abc", "-1", "1.5"} {
		rec = get("/api/mux/activity?after="+q, false)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), `"code":"invalid_after"`) {
			t.Errorf("after=%s = %d %s", q, rec.Code, rec.Body)
		}
	}
	if rec := get("/api/mux/activity", true); rec.Code != 403 {
		t.Errorf("cross-site = %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/mux/activity", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 405 {
		t.Errorf("POST = %d", rec.Code)
	}
	// Reading the log reads no panes.
	n := len(m.calls)
	get("/api/mux/activity", false)
	if len(m.calls) != n {
		t.Errorf("activity read the mux: %v", m.calls[n:])
	}
}

func TestBuildServerWiresZellijRename(t *testing.T) {
	m := newTestZellijMux()
	_, _, _, activity, err := buildServerWith(testConfig(t), m)
	if err != nil {
		t.Fatal(err)
	}
	if m.onRename == nil || activity == nil {
		t.Fatal("the Zellij rename is not told to the tracker")
	}
}
