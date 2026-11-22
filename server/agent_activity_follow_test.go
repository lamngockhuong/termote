package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// A followed pane's turn is in the activity ring with no page open: each
// read records it, and the pane is let go once its turn ended.
func TestActivityFollower(t *testing.T) {
	tr := newActivityTracker(time.Now, false, true)
	var mu sync.Mutex
	status := "idle"
	var failNext bool
	reads := 0
	f := newActivityFollower(tr, nil)
	f.every = 5 * time.Millisecond
	f.read = func(context.Context) (Snapshot, error) {
		mu.Lock()
		defer mu.Unlock()
		reads++
		if failNext {
			failNext = false
			return Snapshot{}, errors.New("backend busy")
		}
		return Snapshot{Groups: []Group{{ID: "w", Tabs: []Tab{{ID: "w:0", Panes: []Pane{
			{ID: "%1", Agent: &AgentInfo{Name: "claude", Status: status}}}}}}}}, nil
	}
	set := func(s string) { mu.Lock(); status = s; mu.Unlock() }
	running := func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.running }
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(2 * time.Second); !ok(); time.Sleep(time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("never %s", what)
			}
		}
	}
	f.follow("%1")
	f.follow("%1") // one loop only
	set("working")
	waitFor("working recorded", func() bool { p := tr.eventsAfter(0, true); return len(p.Events) >= 1 })
	mu.Lock()
	failNext = true
	mu.Unlock()
	set("idle")
	waitFor("let go", func() bool { return !running() })
	p := tr.eventsAfter(0, true)
	if last := p.Events[len(p.Events)-1]; last.From != "working" || last.To != "idle" {
		t.Errorf("events %+v", p.Events)
	}
	// Never working within the grace, or past the longest follow: let go.
	f.mu.Lock()
	f.grace = 20 * time.Millisecond
	f.mu.Unlock()
	f.follow("%1")
	waitFor("grace", func() bool { return !running() })
	f.mu.Lock()
	f.grace, f.most = time.Hour, 20*time.Millisecond
	f.mu.Unlock()
	set("working")
	f.follow("%9")
	waitFor("most", func() bool { return !running() })
	// A nil follower follows nothing.
	var none *activityFollower
	none.follow("%1")
}
