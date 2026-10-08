package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The cases the PWA runs too (pwa/src/utils/agent-notify.test.ts).
func TestPushTransitionsFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/agent-transitions.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name   string
			Steps  []map[string]*string
			Events [][]struct{ PaneID, Kind string }
		}
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			prev := map[string]string{}
			for i, step := range c.Steps {
				next, events := transitions(prev, snapshotOf(step))
				got := []string{}
				for _, e := range events {
					if e.GroupID != "g" || e.TabID != "t-"+e.PaneID {
						t.Errorf("step %d: event ids %+v", i, e)
					}
					got = append(got, e.PaneID+":"+e.Kind)
				}
				sort.Strings(got)
				want := []string{}
				for _, e := range c.Events[i] {
					want = append(want, e.PaneID+":"+e.Kind)
				}
				if fmt.Sprint(got) != fmt.Sprint(want) {
					t.Errorf("step %d: events %v, want %v", i, got, want)
				}
				prev = next
			}
		})
	}
}

// snapshotOf lists each pane in a tab of its own; a nil status is an agent
// with no status, "none" a pane with no agent.
func snapshotOf(step map[string]*string) Snapshot {
	g := Group{ID: "g"}
	for id, status := range step {
		p := Pane{ID: id}
		switch {
		case status == nil:
			p.Agent = &AgentInfo{Name: "claude"}
		case *status != "none":
			p.Agent = &AgentInfo{Name: "claude", Status: *status}
		}
		g.Tabs = append(g.Tabs, Tab{ID: "t-" + id, Panes: []Pane{p}})
	}
	return Snapshot{Groups: []Group{g}}
}

func statusSnap(statuses map[string]string) Snapshot {
	step := map[string]*string{}
	for id, s := range statuses {
		step[id] = &s
	}
	return snapshotOf(step)
}

// fakePush records sends and answers with reply(sub).
type fakePush struct {
	mu    sync.Mutex
	sent  []string // endpoint + payload
	reply func(sub pushSub) (int, time.Duration, error)
}

func (f *fakePush) send(ctx context.Context, sub pushSub, payload []byte, topic string) (int, time.Duration, error) {
	f.mu.Lock()
	f.sent = append(f.sent, sub.Endpoint+" "+string(payload))
	f.mu.Unlock()
	if f.reply == nil {
		return 201, 0, nil
	}
	return f.reply(sub)
}

func (f *fakePush) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

func newTestWatcher(t *testing.T, snaps func() (Snapshot, error)) (*pushWatcher, *fakePush, *atomic.Int32) {
	t.Helper()
	var peeks atomic.Int32
	f := &fakePush{}
	w := newPushWatcher(func(context.Context) (Snapshot, error) {
		peeks.Add(1)
		return snaps()
	}, newTestPushStore(t), f.send)
	return w, f, &peeks
}

// captureLog collects log lines for the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	var mu sync.Mutex
	log.SetOutput(writerFunc(func(p []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return buf.Write(p)
	}))
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func TestPushWatcherNoPeekWithoutSubscriptions(t *testing.T) {
	w, _, peeks := newTestWatcher(t, func() (Snapshot, error) {
		return statusSnap(map[string]string{"p1": "working"}), nil
	})
	w.prev["p1"] = "working"
	w.tick(context.Background())
	if peeks.Load() != 0 || len(w.prev) != 0 {
		t.Fatalf("peeks %d, prev %v", peeks.Load(), w.prev)
	}
}

func TestPushWatcherQueuesTransitions(t *testing.T) {
	snap := statusSnap(map[string]string{"p1": "working", "p2": "idle"})
	var err error
	w, _, peeks := newTestWatcher(t, func() (Snapshot, error) { return snap, err })
	if e := w.store.add(fcmSub(t, 1)); e != nil {
		t.Fatal(e)
	}
	w.tick(context.Background())
	// A failed read keeps what was known.
	err = errors.New("tmux gone")
	w.tick(context.Background())
	err = nil
	snap = statusSnap(map[string]string{"p1": "done", "p2": "idle"})
	w.tick(context.Background())
	if peeks.Load() != 3 || len(w.queue) != 1 {
		t.Fatalf("peeks %d, queued %d", peeks.Load(), len(w.queue))
	}
	if e := <-w.queue; e != (pushEvent{GroupID: "g", TabID: "t-p1", PaneID: "p1", Kind: "done"}) {
		t.Fatalf("event = %+v", e)
	}
	// Panes that are gone are forgotten.
	snap = statusSnap(map[string]string{"p2": "idle"})
	w.tick(context.Background())
	if _, ok := w.prev["p1"]; ok || len(w.prev) != 1 {
		t.Fatalf("prev = %v", w.prev)
	}
}

func TestPushWatcherQueueDropsOldest(t *testing.T) {
	w, _, _ := newTestWatcher(t, nil)
	for i := range pushQueueLen + 3 {
		w.enqueue(pushEvent{PaneID: fmt.Sprint(i)})
	}
	if len(w.queue) != pushQueueLen {
		t.Fatalf("queued %d", len(w.queue))
	}
	if e := <-w.queue; e.PaneID != "3" {
		t.Fatalf("oldest kept = %s, want 3", e.PaneID)
	}
}

func TestPushWatcherDeliver(t *testing.T) {
	w, f, _ := newTestWatcher(t, nil)
	logs := captureLog(t)
	ok, gone, forbidden := fcmSub(t, 1), fcmSub(t, 2), fcmSub(t, 3)
	for _, s := range []pushSub{ok, gone, forbidden} {
		if err := w.store.add(s); err != nil {
			t.Fatal(err)
		}
	}
	f.reply = func(sub pushSub) (int, time.Duration, error) {
		switch sub.Endpoint {
		case gone.Endpoint:
			return 410, 0, nil
		case forbidden.Endpoint:
			return 403, 0, nil
		}
		return 201, 0, nil
	}
	e := pushEvent{GroupID: "g", TabID: "t", PaneID: "%1", Kind: "blocked"}
	w.deliverEvent(context.Background(), e)
	if f.count() != 3 {
		t.Fatalf("sent %d", f.count())
	}
	for _, s := range f.sent {
		if !strings.HasSuffix(s, ` {"groupId":"g","tabId":"t","paneId":"%1","kind":"blocked"}`) {
			t.Errorf("payload: %s", s)
		}
	}
	var left []string
	for _, s := range w.store.list() {
		left = append(left, s.Endpoint)
	}
	if fmt.Sprint(left) != fmt.Sprint([]string{ok.Endpoint, forbidden.Endpoint}) {
		t.Fatalf("left %v: 410 drops, 403 keeps", left)
	}
	out := logs.String()
	if !strings.Contains(out, "push to fcm.googleapis.com rejected: 403") || strings.Contains(out, "every service") {
		t.Errorf("log: %s", out)
	}
	if strings.Contains(out, "/fcm/send/") {
		t.Errorf("log names an endpoint path: %s", out)
	}
}

func TestPushWatcherAllRejectedLogsOnce(t *testing.T) {
	w, f, _ := newTestWatcher(t, nil)
	logs := captureLog(t)
	w.store.add(fcmSub(t, 1))
	w.store.add(fcmSub(t, 2))
	f.reply = func(pushSub) (int, time.Duration, error) { return 401, 0, nil }
	w.deliverEvent(context.Background(), pushEvent{PaneID: "p"})
	w.deliverEvent(context.Background(), pushEvent{PaneID: "p"})
	if n := strings.Count(logs.String(), "push rejected by every service: check the server clock"); n != 1 {
		t.Fatalf("logged %d times: %s", n, logs)
	}
	if len(w.store.list()) != 2 {
		t.Fatal("401 dropped a subscription")
	}
}

func TestPushWatcherBacksOff(t *testing.T) {
	captureLog(t)
	for _, tc := range []struct {
		name  string
		reply func(pushSub) (int, time.Duration, error)
		want  time.Duration
	}{
		{"429 with Retry-After", func(pushSub) (int, time.Duration, error) { return 429, 10 * time.Minute, nil }, 10 * time.Minute},
		{"429 without", func(pushSub) (int, time.Duration, error) { return 429, 0, nil }, pushDefaultBackoff},
		{"timeout", func(pushSub) (int, time.Duration, error) { return 0, 0, context.DeadlineExceeded }, pushDefaultBackoff},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, f, _ := newTestWatcher(t, nil)
			at := time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)
			w.now = func() time.Time { return at }
			w.store.add(fcmSub(t, 1))
			f.reply = tc.reply
			w.deliverEvent(context.Background(), pushEvent{PaneID: "p"})
			w.deliverEvent(context.Background(), pushEvent{PaneID: "p"})
			if f.count() != 1 {
				t.Fatalf("sent %d while backed off", f.count())
			}
			at = at.Add(tc.want)
			w.deliverEvent(context.Background(), pushEvent{PaneID: "p"})
			if f.count() != 2 || len(w.backoff) != 1 {
				t.Fatalf("after the back-off: sent %d, backoff %v", f.count(), w.backoff)
			}
			if len(w.store.list()) != 1 {
				t.Fatal("a back-off dropped the subscription")
			}
		})
	}
}

// A slow push service delays only the sender: ticks keep reading and
// queueing.
func TestPushWatcherSlowSenderNeverBlocksTicks(t *testing.T) {
	status := "working"
	var mu sync.Mutex
	w, f, _ := newTestWatcher(t, func() (Snapshot, error) {
		mu.Lock()
		defer mu.Unlock()
		return statusSnap(map[string]string{"p1": status}), nil
	})
	w.store.add(fcmSub(t, 1))
	release := make(chan struct{})
	f.reply = func(pushSub) (int, time.Duration, error) {
		<-release
		return 201, 0, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.deliver(ctx)
	w.tick(ctx)
	for i := range 2 * pushQueueLen {
		mu.Lock()
		status = map[int]string{0: "blocked", 1: "working"}[i%2]
		mu.Unlock()
		done := make(chan struct{})
		go func() { w.tick(ctx); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("a tick waited on the sender")
		}
	}
	// The sender holds at most one event, the rest wait in a full queue.
	if n := len(w.queue); n < pushQueueLen-1 {
		t.Fatalf("queued %d, want a full queue", n)
	}
	close(release)
}

func TestPushWatcherPrunesHostState(t *testing.T) {
	w, _, _ := newTestWatcher(t, nil)
	at := time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)
	w.now = func() time.Time { return at }
	w.backoff["old.push.apple.com"] = at.Add(-time.Second)
	w.logged["old.push.apple.com"] = at.Add(-pushLogEvery)
	w.deliverEvent(context.Background(), pushEvent{PaneID: "p"})
	if len(w.backoff) != 0 || len(w.logged) != 0 {
		t.Fatalf("backoff %v, logged %v", w.backoff, w.logged)
	}
}

func TestPushWatcherStopsWithContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	startPushWatcher(ctx, &fakeMux{}, nil) // no store: nothing runs
	w, _, _ := newTestWatcher(t, nil)
	done := make(chan struct{})
	go func() { w.run(ctx); w.deliver(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("watcher kept running after cancel")
	}
}
