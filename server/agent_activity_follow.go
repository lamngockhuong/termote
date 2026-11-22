package main

import (
	"context"
	"sync"
	"time"
)

// The activity tracker records only the snapshots something reads. After a
// message or a start reaches a pane, that pane is followed: the snapshot is
// read (peeked, making nothing) every activityFollowEvery while its agent
// works, so the turn it runs is in the activity ring even with no page open
// and no push subscription (termote agents wait reads the ring later, from
// a mark taken before the message). A pane stops being followed once a read
// shows it no longer working after it did, when it shows no work within
// activityFollowGrace, or after activityFollowMost.

var (
	activityFollowEvery = 2 * time.Second
	activityFollowGrace = time.Minute
	activityFollowMost  = 2 * time.Hour
)

type followedPane struct {
	since   time.Time
	working bool
}

// activityFollower reads the snapshot for the followed panes, one loop at
// a time, only while there are some.
type activityFollower struct {
	t    *activityTracker
	read func(context.Context) (Snapshot, error)
	// every, grace, most: activityFollow*, as the follower was made
	every, grace, most time.Duration

	mu      sync.Mutex
	panes   map[string]followedPane
	running bool
}

func newActivityFollower(t *activityTracker, m Mux) *activityFollower {
	return &activityFollower{t: t, read: func(ctx context.Context) (Snapshot, error) { return peekSnapshot(ctx, m) },
		every: activityFollowEvery, grace: activityFollowGrace, most: activityFollowMost, panes: map[string]followedPane{}}
}

// follow starts following paneID (again, from now).
func (f *activityFollower) follow(paneID string) {
	if f == nil || f.t == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.panes[paneID] = followedPane{since: time.Now()}
	if !f.running {
		f.running = true
		go f.run()
	}
}

func (f *activityFollower) run() {
	tick := time.NewTicker(f.every)
	defer tick.Stop()
	for range tick.C {
		if !f.step() {
			return
		}
	}
}

// step reads the snapshot once and drops the panes done with; false when
// none is left (the loop ends).
func (f *activityFollower) step() bool {
	gen := f.t.begin()
	ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
	snap, err := f.read(ctx)
	cancel()
	if err == nil {
		snap = f.t.observe(gen, snap)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	for id, p := range f.panes {
		if now.Sub(p.since) >= f.most {
			delete(f.panes, id)
			continue
		}
		if err != nil {
			continue // a failed read keeps every pane
		}
		sp, ok := findAgentPane(snap, id)
		switch {
		case ok && sp.status() == "working":
			p.working = true
			f.panes[id] = p
		case p.working || !ok || now.Sub(p.since) >= f.grace:
			delete(f.panes, id)
		}
	}
	if len(f.panes) == 0 {
		f.running = false
		return false
	}
	return true
}
