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

	"github.com/coder/websocket"
)

// statusOf is pane's annotated agent status in s.
func statusOf(s Snapshot, pane string) string {
	if a := agentOf(s, pane); a != nil {
		return a.Status
	}
	return ""
}

// setStatus is snap with every agent of pane at status.
func setStatus(snap Snapshot, pane, status string) Snapshot {
	for gi := range snap.Groups {
		for ti := range snap.Groups[gi].Tabs {
			for pi := range snap.Groups[gi].Tabs[ti].Panes {
				if p := &snap.Groups[gi].Tabs[ti].Panes[pi]; p.ID == pane {
					p.Agent = &AgentInfo{Name: "claude", Status: status}
				}
			}
		}
	}
	return snap
}

// tmuxTabs is a tmux group $1 with one pane per tab, every agent working;
// active is the current window's index.
func tmuxTabs(active int, panes ...[]string) Snapshot {
	g := Group{ID: "$1", Name: "s"}
	for i, ids := range panes {
		tab := Tab{ID: "$1:" + string(rune('0'+i)), Key: "@" + string(rune('0'+i)), Active: i == active}
		for _, id := range ids {
			tab.Panes = append(tab.Panes, Pane{ID: id, Agent: &AgentInfo{Name: "claude", Status: "working"}})
		}
		g.Tabs = append(g.Tabs, tab)
	}
	return Snapshot{Groups: []Group{g}}
}

func TestUnseenFinishedTurn(t *testing.T) {
	tr, c := newOverlayTracker(true, false)
	observeNow(tr, herdrLike("working"))
	c.advance(time.Second)
	if got := statusOf(observeNow(tr, herdrLike("idle")), "w1:p1"); got != "done" {
		t.Fatalf("turn no one saw = %q, want done", got)
	}
	// Still unseen while no one looks.
	c.advance(time.Second)
	if got := statusOf(observeNow(tr, herdrLike("idle")), "w1:p1"); got != "done" {
		t.Errorf("next read = %q", got)
	}
	// A full client opens it: the next read is idle, and stays so.
	w := tr.watcher("w1", "w1:p1")
	w.set(true)
	c.advance(time.Second)
	if got := statusOf(observeNow(tr, herdrLike("idle")), "w1:p1"); got != "idle" {
		t.Errorf("seen = %q, want idle", got)
	}
	w.end()
	c.advance(time.Second)
	observeNow(tr, herdrLike("idle"))
	c.advance(time.Second)
	if got := statusOf(observeNow(tr, herdrLike("idle")), "w1:p1"); got != "idle" {
		t.Errorf("after the viewer left = %q", got)
	}
	// Seen only through the overlay: the log has the raw change alone, and
	// since is when the turn ended.
	if got := strings.Join(eventsOf(tr), " "); got != "w1:p1:>working w1:p1:working>idle" {
		t.Errorf("events = %s", got)
	}
	if a := agentOf(observeNow(tr, herdrLike("idle")), "w1:p1"); a.Since != c.at(-4*time.Second) {
		t.Errorf("since moved: %+v", a)
	}
}

func TestUnseenViewerBetweenReads(t *testing.T) {
	tr, c := newOverlayTracker(true, false)
	observeNow(tr, herdrLike("working"))
	// Someone looked after the last read, and left before this one.
	c.advance(time.Second)
	w := tr.watcher("w1", "w1:p1")
	w.set(true)
	c.advance(time.Second)
	w.set(false)
	c.advance(time.Second)
	if got := statusOf(observeNow(tr, herdrLike("idle")), "w1:p1"); got != "idle" {
		t.Errorf("turn seen between reads = %q, want idle", got)
	}
	// Looked before the last read only: the next turn is unseen.
	c.advance(time.Second)
	observeNow(tr, herdrLike("working"))
	c.advance(time.Second)
	if got := statusOf(observeNow(tr, herdrLike("idle")), "w1:p1"); got != "done" {
		t.Errorf("viewer before the last read = %q, want done", got)
	}
	if len(tr.viewers) != 0 {
		t.Errorf("viewers kept: %v", tr.viewers)
	}
	w.end()
}

func TestUnseenClearedByNewTurn(t *testing.T) {
	tr, c := newOverlayTracker(true, false)
	for _, st := range []string{"working", "idle"} {
		observeNow(tr, herdrLike(st))
		c.advance(time.Second)
	}
	for _, st := range []string{"working", "blocked"} {
		if got := statusOf(observeNow(tr, herdrLike(st)), "w1:p1"); got != st {
			t.Errorf("%s = %q", st, got)
		}
		c.advance(time.Second)
	}
	// blocked to idle (answered, nothing ran) is no finished turn.
	if got := statusOf(observeNow(tr, herdrLike("idle")), "w1:p1"); got != "idle" {
		t.Errorf("blocked to idle = %q", got)
	}
	// An agent's status unknown keeps the overlay.
	observeNow(tr, herdrLike("working"))
	observeNow(tr, herdrLike("idle"))
	if got := statusOf(observeNow(tr, herdrLike("unknown")), "w1:p1"); got != "unknown" {
		t.Errorf("unknown = %q", got)
	}
	if !tr.states["w1:p1"].unseen {
		t.Error("an unknown status cleared unseen")
	}
}

func TestUnseenFirstSighting(t *testing.T) {
	tr, _ := newOverlayTracker(true, false)
	if got := statusOf(observeNow(tr, herdrLike("idle")), "w1:p1"); got != "idle" {
		t.Errorf("first sighting idle = %q", got)
	}
	// A first sighting at Herdr's done is no turn seen here to end: idle.
	tr, _ = newOverlayTracker(true, false)
	if got := statusOf(observeNow(tr, herdrLike("done")), "w1:p1"); got != "idle" {
		t.Errorf("first sighting done = %q", got)
	}
}

func TestUnseenTmuxFollowsCurrentWindow(t *testing.T) {
	tr, c := newOverlayTracker(true, true)
	w := tr.watcher("$1", "%1")
	w.set(true)
	defer w.end()
	// The stream shows window 0 (split in two); window 1's agent is unseen.
	snap := tmuxTabs(0, []string{"%1", "%2"}, []string{"%3"})
	observeNow(tr, snap)
	c.advance(time.Second)
	for _, p := range []string{"%1", "%2", "%3"} {
		snap = setStatus(snap, p, "idle")
	}
	out := observeNow(tr, snap)
	if statusOf(out, "%1") != "idle" || statusOf(out, "%2") != "idle" {
		t.Errorf("split window = %q %q, want idle", statusOf(out, "%1"), statusOf(out, "%2"))
	}
	if got := statusOf(out, "%3"); got != "done" {
		t.Errorf("other window = %q, want done", got)
	}
	// Switched to window 1 on the same stream: seen at the next read.
	c.advance(time.Second)
	snap.Groups[0].Tabs[0].Active, snap.Groups[0].Tabs[1].Active = false, true
	if got := statusOf(observeNow(tr, snap), "%3"); got != "idle" {
		t.Errorf("after switching = %q, want idle", got)
	}
	// Another group's stream sees nothing of this one.
	other := tr.watcher("$9", "%1")
	if other.key != "$9" {
		t.Errorf("tmux watch key = %q", other.key)
	}
}

func TestUnseenPerPaneBackends(t *testing.T) {
	tr, c := newOverlayTracker(true, false)
	w := tr.watcher("w1", "w1:p1")
	w.set(true)
	defer w.end()
	observeNow(tr, herdrLike("working", "working"))
	c.advance(time.Second)
	out := observeNow(tr, herdrLike("done", "done"))
	if got := statusOf(out, "w1:p1"); got != "idle" {
		t.Errorf("Herdr done seen here = %q, want idle", got)
	}
	if got := statusOf(out, "w1:p2"); got != "done" {
		t.Errorf("other pane = %q, want done", got)
	}
	// Seen in Herdr: its own done to idle clears unseen.
	c.advance(time.Second)
	if got := statusOf(observeNow(tr, herdrLike("done", "idle")), "w1:p2"); got != "idle" {
		t.Errorf("Herdr's own idle = %q", got)
	}
	if tr.states["w1:p2"].unseen {
		t.Error("unseen kept after Herdr's idle")
	}
}

func TestUnseenNotOverlaid(t *testing.T) {
	// hc keeps herdr.seen: nothing changes.
	tr, c := newOverlayTracker(false, false)
	observeNow(tr, herdrLike("working", "working"))
	c.advance(time.Second)
	out := observeNow(tr, herdrLike("idle", "done"))
	if statusOf(out, "w1:p1") != "idle" || statusOf(out, "w1:p2") != "done" {
		t.Errorf("hc = %q %q", statusOf(out, "w1:p1"), statusOf(out, "w1:p2"))
	}
	if tr.watcher("w1", "w1:p1") != nil {
		t.Error("a watcher where nothing is overlaid")
	}
	var nilTracker *activityTracker
	if nilTracker.watcher("g", "p") != nil {
		t.Error("a nil tracker's watcher")
	}
	// A nil watch does nothing.
	var w *activityWatch
	w.set(true)
	w.end()
}

func TestUnseenWatchCountsOnce(t *testing.T) {
	tr, c := newOverlayTracker(true, false)
	w := tr.watcher("w1", "w1:p1")
	w.set(true)
	w.set(true) // repeated frame
	if v := tr.viewers["w1:p1"]; v.count != 1 {
		t.Fatalf("count = %d after a repeated on", v.count)
	}
	w.set(false)
	w.set(false)
	if v := tr.viewers["w1:p1"]; v.count != 0 {
		t.Fatalf("count = %d after a repeated off", v.count)
	}
	w.set(true)
	w.end()
	w.end()
	w.set(true) // after the end
	if v := tr.viewers["w1:p1"]; v.count != 0 || len(tr.watches) != 0 {
		t.Fatalf("count = %d, watches %d after the end", v.count, len(tr.watches))
	}
	// An ended watch that was off changes nothing.
	off := tr.watcher("w1", "w1:p1")
	off.end()
	if v := tr.viewers["w1:p1"]; v.count != 0 {
		t.Errorf("count = %d", v.count)
	}
	// Two reads later the key is gone.
	c.advance(time.Second)
	observeNow(tr, herdrLike("working"))
	c.advance(time.Second)
	observeNow(tr, herdrLike("working"))
	if len(tr.viewers) != 0 {
		t.Errorf("viewers = %v", tr.viewers)
	}
}

func TestUnseenWatchRacesRead(t *testing.T) {
	tr, _ := newOverlayTracker(true, false)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := tr.watcher("w1", "w1:p1")
			for range 50 {
				w.set(true)
				observeNow(tr, herdrLike("idle"))
				w.set(false)
			}
			w.end()
		}()
	}
	wg.Wait()
	if v := tr.viewers["w1:p1"]; v != nil && v.count != 0 {
		t.Errorf("count = %d", v.count)
	}
}

func TestUnseenZellijRenameMovesViewers(t *testing.T) {
	tr, c := newOverlayTracker(true, false)
	a, b := zellijGroupID("a"), zellijGroupID("b")
	snap := setStatus(zellijLike("a"), a+":p1", "working")
	observeNow(tr, snap)
	w := tr.watcher(a, zellijPaneKey("a", 1))
	w.set(true)
	tr.renameGroup(a, b)
	if w.key != zellijPaneKey("b", 1) || tr.viewers[zellijPaneKey("b", 1)] == nil {
		t.Fatalf("watch key = %q, viewers %v", w.key, tr.viewers)
	}
	c.advance(time.Second)
	if got := statusOf(observeNow(tr, setStatus(zellijLike("b"), b+":p1", "idle")), b+":p1"); got != "idle" {
		t.Errorf("renamed, watched = %q", got)
	}
	w.end()
	if v := tr.viewers[zellijPaneKey("b", 1)]; v.count != 0 {
		t.Errorf("count after the end = %d", v.count)
	}
}

// A stream off screen during a rename is counted under the new key once
// shown again.
func TestUnseenRenameWhileOff(t *testing.T) {
	tr, _ := newOverlayTracker(true, false)
	a, b := zellijGroupID("a"), zellijGroupID("b")
	w := tr.watcher(a, zellijPaneKey("a", 1))
	w.set(true)
	w.set(false)
	tr.renameGroup(a, b)
	w.set(true)
	if v := tr.viewers[zellijPaneKey("b", 1)]; v == nil || v.count != 1 {
		t.Fatalf("viewers = %v", tr.viewers)
	}
	if v := tr.viewers[zellijPaneKey("a", 1)]; v != nil && v.count != 0 {
		t.Errorf("old key counted: %d", v.count)
	}
	w.end()
	if len(tr.watches) != 0 {
		t.Errorf("watches kept: %d", len(tr.watches))
	}
}

// A psmux tab renumbering forgets its panes, unseen turns too: a known
// limit.
func TestUnseenPsmuxRenumberForgets(t *testing.T) {
	tr, c := newOverlayTracker(true, true)
	observeNow(tr, psmuxLike("s:0", "s:1"))
	c.advance(time.Second)
	observeNow(tr, setStatus(psmuxLike("s:0", "s:1"), "s:1", "idle"))
	if !tr.states["s:1"].unseen {
		t.Fatal("not unseen")
	}
	c.advance(time.Second)
	out := observeNow(tr, setStatus(psmuxLike("s:1"), "s:1", "idle"))
	if got := statusOf(out, "s:1"); got != "idle" {
		t.Errorf("after a renumbering = %q", got)
	}
}

func TestUnseenNativeViewers(t *testing.T) {
	tr, c := newOverlayTracker(true, true)
	snap := tmuxTabs(1, []string{"%1"}, []string{"%2"})
	observeNow(tr, snap)
	c.advance(time.Second)
	snap = setStatus(setStatus(snap, "%1", "idle"), "%2", "idle")
	snap.viewers = map[string]bool{"%1": true}
	out := observeNow(tr, snap)
	if statusOf(out, "%1") != "idle" || statusOf(out, "%2") != "done" {
		t.Errorf("native viewer = %q %q", statusOf(out, "%1"), statusOf(out, "%2"))
	}
}

func TestOverlayBackend(t *testing.T) {
	for name, want := range map[string]bool{"tmux": true, "zellij": true, "herdr": true, "hc": false, "fake": false} {
		if overlayBackend(name) != want {
			t.Errorf("%s = %v", name, !want)
		}
		a := newAgentAPI(&fakeMux{name: name})
		if a.activity.overlay != want || a.activity.byGroup != (name == "tmux") {
			t.Errorf("%s tracker = %v %v", name, a.activity.overlay, a.activity.byGroup)
		}
	}
	if a := newAgentAPI(nil); a.activity.overlay {
		t.Error("no mux overlays")
	}
}

// Each read path feeds the tracker a snapshot whose Backend is not set yet;
// the tracker's own flags decide.
func TestUnseenReadPaths(t *testing.T) {
	m := &fakeMux{name: "tmux", snap: tmuxTabs(0, []string{"%1"})}
	mux := http.NewServeMux()
	agent := registerMuxRoutes(mux, m, newStreamTokenStore(), nil, nil)
	read := func() Snapshot {
		var out Snapshot
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/mux/snapshot?peek=1", nil))
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	read()
	m.snap = setStatus(m.snap, "%1", "idle")
	if got := statusOf(read(), "%1"); got != "done" {
		t.Errorf("snapshot route = %q", got)
	}
	// The push watcher's tick.
	w, _, _ := newTestWatcher(t, func() (Snapshot, error) { return tmuxTabs(0, []string{"%1"}), nil })
	w.store.add(fcmSub(t, 1))
	w.activity = agent.activity
	w.tick(context.Background())
	if agent.activity.states["%1"].status != "working" {
		t.Error("the tick fed nothing")
	}
}

// A full stream counts while its client shows the pane, once however often
// it says so, and not after it ends.
func TestUnseenStreamVisible(t *testing.T) {
	s := &streamServer{}
	m := &fakeMux{name: "tmux", snap: oneTabSnapshot()}
	m.attach = func(string, Size) (TermStream, error) {
		ft := newFakeTerm()
		s.mu.Lock()
		s.terms = append(s.terms, ft)
		s.mu.Unlock()
		return ft, nil
	}
	h, hub, _, agent, err := buildServerWith(testConfig(t), m)
	if err != nil {
		t.Fatal(err)
	}
	s.hub, s.Server = hub, httptest.NewServer(h)
	t.Cleanup(func() {
		hub.shutdown(context.Background())
		s.Close()
	})
	count := func() int {
		agent.activity.mu.Lock()
		defer agent.activity.mu.Unlock()
		if v := agent.activity.viewers["main"]; v != nil {
			return v.count
		}
		return 0
	}
	waitCount := func(want int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for count() != want {
			if time.Now().After(deadline) {
				t.Fatalf("viewers = %d, want %d", count(), want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	c := mustDial(t, s, "pane=0")
	ft := s.term(t, 0)
	ctx := context.Background()
	for range 2 {
		c.Write(ctx, websocket.MessageText, []byte(`{"type":"visible","on":true}`))
	}
	c.Write(ctx, websocket.MessageBinary, []byte("x"))
	<-ft.inCh
	waitCount(1)
	c.Close(websocket.StatusNormalClosure, "")
	waitCount(0)
}

// A view-only stream's visible frames never reach the tracker.
func TestRunStreamReadOnlyNotVisible(t *testing.T) {
	ft := newFakeTerm()
	var mu sync.Mutex
	var got []bool
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx, cancel := context.WithCancelCause(context.Background())
		runStream(ctx, cancel, conn, ft, true, time.Hour, func() error { return nil }, func(on bool) {
			mu.Lock()
			got = append(got, on)
			mu.Unlock()
		})
		close(done)
	}))
	defer srv.Close()
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"visible","on":true}`))
	c.Close(websocket.StatusNormalClosure, "")
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 0 {
		t.Errorf("view-only visible = %v", got)
	}
}
