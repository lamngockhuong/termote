package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// hcMuxFake is an hcMux whose connections go to fake cores.
type hcMuxFake struct {
	m       *hcMux
	running atomic.Bool
	mu      sync.Mutex
	cores   []*fakeHcCore
	events  chan uint32 // each subscription's channel
	// doc is the document doc.get answers, with its version.
	docMu  sync.Mutex
	doc    json.RawMessage
	docVer uint64
	terms  []any // the subscription snapshot's terminals
}

func newHcMuxFake(t *testing.T) *hcMuxFake {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "hc-herdr-app-doc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var res struct {
		Value json.RawMessage `json:"value"`
	}
	json.Unmarshal(b, &res)
	sp, tb1, tb2 := "sp4edb720aa4b17f5a613793b7a96b7965", "tb4958b85f9429906ea3b85a34be43d4c3", "tbd34e4c4c59605762a3a691af2454b914"
	term := func(addr, tab string) any {
		return map[string]any{"address": addr, "labels": map[string]string{hcLabelSpace: sp, hcLabelTab: tab},
			"state": "live", "cols": 94, "rows": 40, "cwd": "/w", "argv": []string{"zsh"}}
	}
	f := &hcMuxFake{events: make(chan uint32, 16), doc: res.Value, docVer: 17,
		terms: []any{term("t1", tb1), term("t7", tb1), term("t4", tb2)}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	f.m = newHcMux(ctx, "/usr/bin/hc", nil)
	f.m.client.running = func(context.Context, []string) bool { return f.running.Load() }
	f.m.docRetry = 30 * time.Millisecond
	f.m.client.connect = func(context.Context, string, []string) (*hcConn, error) {
		core, c := startFakeHc(t, func(core *fakeHcCore) {
			core.handle("events.subscribe", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
				ch := core.openChannel()
				core.reply(id, map[string]any{"seq": 1, "terminals": f.terms, "channel": ch})
				f.events <- ch
			})
			core.handle("doc.get", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
				f.docMu.Lock()
				defer f.docMu.Unlock()
				core.reply(id, map[string]any{"value": f.doc, "version": f.docVer})
			})
			core.result("server.status", map[string]any{"version": "0.1.16"})
		})
		f.mu.Lock()
		f.cores = append(f.cores, core)
		f.mu.Unlock()
		return c, nil
	}
	return f
}

func (f *hcMuxFake) core() *fakeHcCore {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cores[len(f.cores)-1]
}

func ctx5s(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestHcMuxReadsNeverStartTheCore(t *testing.T) {
	f := newHcMuxFake(t)
	m := f.m
	if _, err := m.Snapshot(ctx5s(t)); !errors.Is(err, errHcNotRunning) {
		t.Fatalf("snapshot: %v", err)
	}
	if _, err := m.peekSnapshot(ctx5s(t)); !errors.Is(err, errHcNotRunning) {
		t.Fatalf("peek: %v", err)
	}
	if err := m.Health(ctx5s(t)); !errors.Is(err, errHcNotRunning) {
		t.Fatalf("health: %v", err)
	}
	if _, err := m.conn(ctx5s(t)); !errors.Is(err, errHcUnavailable) {
		t.Fatalf("conn: %v", err)
	}
	// A full client's page asks for a start (within the grace period, none
	// runs yet).
	if _, err := m.startingSnapshot(ctx5s(t)); !errors.Is(err, errHcStarting) {
		t.Fatalf("starting: %v", err)
	}
	f.mu.Lock()
	n := len(f.cores)
	f.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d connections", n)
	}
}

func TestHcMuxFollowsTheCore(t *testing.T) {
	f := newHcMuxFake(t)
	m := f.m
	f.running.Store(true)
	snap, err := m.Snapshot(ctx5s(t))
	if err != nil {
		t.Fatal(err)
	}
	// The document was read before the first snapshot: its layout is there.
	if len(snap.Groups) != 1 || len(snap.Groups[0].Tabs) != 2 || snap.Groups[0].Tabs[0].Layout == nil {
		t.Fatalf("%+v", snap.Groups)
	}
	if err := m.Health(ctx5s(t)); err != nil {
		t.Fatal(err)
	}
	ch := <-f.events
	core := f.core()
	core.event(ch, "event", map[string]any{"seq": 2, "type": "title", "terminal": "t4", "data": map[string]any{"title": "vim"}})
	waitFor(t, func() bool {
		s, _ := m.Snapshot(ctx5s(t))
		return s.Groups[0].Tabs[1].Panes[0].Title == "vim"
	})

	// A burst of document changes is read once or twice, not each time.
	before := len(core.callsOf("doc.get"))
	f.docMu.Lock()
	f.docVer = 30
	f.doc = json.RawMessage(`{"spaces":[]}`)
	f.docMu.Unlock()
	for i := 0; i < 10; i++ {
		core.event(ch, "event", map[string]any{"seq": 3 + i, "type": "doc", "data": map[string]any{"name": "herdr-app", "version": 20 + i}})
	}
	waitFor(t, func() bool { return m.state.docVersion() == 30 })
	time.Sleep(100 * time.Millisecond)
	if n := len(core.callsOf("doc.get")) - before; n < 1 || n > 3 {
		t.Fatalf("%d document reads for a burst", n)
	}
	// An empty document: terminals by label, still all there.
	snap, _ = m.Snapshot(ctx5s(t))
	if len(snap.Groups) != 1 || snap.Groups[0].Tabs[0].Layout != nil || len(snap.Groups[0].Tabs) != 2 {
		t.Fatalf("%+v", snap.Groups)
	}
	// A document herdr-app could not have written is dropped, logged once.
	f.docMu.Lock()
	f.docVer, f.doc = 31, json.RawMessage(`{"spaces":[{"tabs":[]}]}`)
	f.docMu.Unlock()
	core.event(ch, "event", map[string]any{"seq": 20, "type": "doc", "data": map[string]any{"name": "herdr-app", "version": 31}})
	waitFor(t, func() bool { return m.state.docVersion() == 31 })

	// missed: a fresh snapshot replaces the terminals.
	core.event(ch, "missed", map[string]any{"seq": 40, "terminals": []any{}})
	waitFor(t, func() bool {
		s, _ := m.Snapshot(ctx5s(t))
		return len(s.Groups) == 0
	})
}

func TestHcMuxSubscribesAgain(t *testing.T) {
	f := newHcMuxFake(t)
	m := f.m
	f.running.Store(true)
	if _, err := m.Snapshot(ctx5s(t)); err != nil {
		t.Fatal(err)
	}
	ch := <-f.events
	first := f.core()
	// The core closes the events channel: the same connection subscribes again.
	first.closeChannel(ch, "server_stop")
	select {
	case <-f.events:
	case <-time.After(5 * time.Second):
		t.Fatal("no new subscription")
	}
	// The connection ends: the next read connects again and follows it.
	conn, _ := m.client.current()
	conn.close()
	waitFor(t, func() bool { live, _ := m.liveConn(); return live == nil })
	if _, err := m.Snapshot(ctx5s(t)); err != nil {
		t.Fatal(err)
	}
	<-f.events
	if f.core() == first {
		t.Fatal("no new connection")
	}
}
