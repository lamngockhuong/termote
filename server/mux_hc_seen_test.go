package main

import (
	"encoding/json"
	"testing"
	"time"
)

// seenState is a state holding agent terminals: t1 at turn 3 seen 1, t2 at
// turn 2 without the label, t3 a shell (no status), and a remote agent.
func seenState() *hcState {
	s := newHcState()
	agent := &hcStatus{App: "claude", State: "done"}
	s.reset(1, []hcTerminal{
		{Address: "t1", State: "live", Turn: 3, Status: agent, Labels: map[string]string{hcLabelSeen: "1"}},
		{Address: "t2", State: "live", Turn: 2, Status: agent},
		{Address: "t3", State: "live", Turn: 4},
		{Address: "mac/t7", State: "live", Turn: 5, Status: agent},
	})
	return s
}

func setSeenLabel(s *hcState, addr string, seen string) {
	s.mu.Lock()
	c := *s.terminals[addr]
	c.Labels = map[string]string{hcLabelSeen: seen}
	s.terminals[addr] = &c
	s.mu.Unlock()
}

func TestHcSeenWatchWritesForTheFirstViewer(t *testing.T) {
	s := seenState()
	now := time.Unix(1000, 0)
	if turn, ok := s.watch("t1", now); !ok || turn != 3 {
		t.Fatalf("first viewer of t1: %d %v, want 3", turn, ok)
	}
	// A second device looking at the same terminal writes nothing more.
	if _, ok := s.watch("t1", now); ok {
		t.Error("second viewer wrote")
	}
	// One of them leaving keeps the other counted.
	s.unwatch("t1", now)
	if s.viewers["t1"] != 1 || len(s.left) != 0 {
		t.Errorf("after one of two left: viewers %d, left %v", s.viewers["t1"], s.left)
	}
	// A missing label is written, so a terminal started elsewhere joins.
	if turn, ok := s.watch("t2", now); !ok || turn != 2 {
		t.Errorf("t2 without herdr.seen: %d %v", turn, ok)
	}
	// No agent, or a terminal on another machine: never written.
	if _, ok := s.watch("t3", now); ok {
		t.Error("a shell got herdr.seen")
	}
	if _, ok := s.watch("mac/t7", now); ok {
		t.Error("a remote terminal got herdr.seen")
	}
	if _, ok := s.watch("t99", now); ok {
		t.Error("an unknown terminal got herdr.seen")
	}
}

func TestHcSeenNeverLowers(t *testing.T) {
	s := seenState()
	setSeenLabel(s, "t1", "3")
	if _, ok := s.watch("t1", time.Unix(1000, 0)); ok {
		t.Error("wrote although herdr.seen equals the turn")
	}
	s.unwatch("t1", time.Unix(1000, 0))
	setSeenLabel(s, "t1", "9")
	if _, ok := s.watch("t1", time.Unix(2000, 0)); ok {
		t.Error("wrote a lower value")
	}
}

func TestHcSeenRejoin(t *testing.T) {
	s := seenState()
	t0 := time.Unix(1000, 0)
	s.watch("t1", t0)
	s.unwatch("t1", t0)
	// Another client marks it unread meanwhile.
	setSeenLabel(s, "t1", "2")
	// The same page back within 10 s (a reconnect): the mark stands.
	if _, ok := s.watch("t1", t0.Add(hcSeenRejoin-time.Millisecond)); ok {
		t.Error("a reconnect within the rejoin window wrote")
	}
	s.unwatch("t1", t0.Add(time.Second*11))
	// Looking again later raises it again.
	if turn, ok := s.watch("t1", t0.Add(time.Second*30)); !ok || turn != 3 {
		t.Errorf("a later look: %d %v", turn, ok)
	}
	// Old departures are dropped as others come and go.
	s.unwatch("t2", t0.Add(time.Second*30)) // not watched: nothing
	s.watch("t2", t0.Add(time.Second*30))
	s.unwatch("t2", t0.Add(time.Minute))
	s.unwatch("t1", t0.Add(time.Minute*2))
	s.mu.Lock()
	_, kept := s.left["t2"]
	s.mu.Unlock()
	if kept {
		t.Error("a departure older than the rejoin window was kept")
	}
}

func TestHcSeenRejoinAfterATurnEndedMeanwhile(t *testing.T) {
	s := seenState()
	t0 := time.Unix(1000, 0)
	s.watch("t1", t0) // writes 3
	s.unwatch("t1", t0)
	// The agent finishes turn 4 with nobody looking.
	s.apply(hcEvent{Seq: s.seq + 1, Type: "turn", Terminal: "t1", Data: json.RawMessage(`{"turn":4}`)})
	if _, ok := s.turnSeen("t1"); ok {
		t.Fatal("wrote with nobody looking")
	}
	// Back within the rejoin window: turn 4 was never looked at, so it is.
	if turn, ok := s.watch("t1", t0.Add(5*time.Second)); !ok || turn != 4 {
		t.Errorf("rejoin after a new turn: %d %v", turn, ok)
	}
}

func TestHcSeenViewerFindingItSeenTakesTheTurn(t *testing.T) {
	s := seenState()
	setSeenLabel(s, "t1", "3")
	if _, ok := s.watch("t1", time.Unix(1000, 0)); ok {
		t.Fatal("wrote although seen")
	}
	// Another client marks it unread; a turn event repeating turn 3 (the
	// core resends nothing, but a stale one must not count) writes nothing.
	setSeenLabel(s, "t1", "2")
	if _, ok := s.turnSeen("t1"); ok {
		t.Error("a repeated turn overruled a mark unread")
	}
}

func TestHcSeenResetForgetsGoneTerminals(t *testing.T) {
	s := seenState()
	s.watch("t1", time.Unix(1000, 0))
	s.watch("t2", time.Unix(1000, 0))
	s.reset(9, []hcTerminal{{Address: "t2", State: "live", Turn: 2}})
	s.mu.Lock()
	_, t1 := s.wrote["t1"]
	_, t2 := s.wrote["t2"]
	s.mu.Unlock()
	if t1 || !t2 {
		t.Errorf("after reset: t1 kept %v, t2 kept %v", t1, t2)
	}
}

func TestHcSeenTurnOncePerTurnWhileWatched(t *testing.T) {
	s := seenState()
	turnTo := func(addr string, turn uint64) {
		s.apply(hcEvent{Seq: s.seq + 1, Type: "turn", Terminal: addr, Data: json.RawMessage(`{"turn":` + jsonNum(turn) + `}`)})
	}
	// Nobody looks: nothing.
	turnTo("t1", 4)
	if _, ok := s.turnSeen("t1"); ok {
		t.Fatal("wrote with nobody looking")
	}
	if turn, ok := s.watch("t1", time.Unix(1000, 0)); !ok || turn != 4 {
		t.Fatalf("viewer: %d %v", turn, ok)
	}
	// The same turn again (before the labels event): once.
	if _, ok := s.turnSeen("t1"); ok {
		t.Error("the same turn written twice")
	}
	turnTo("t1", 5)
	if turn, ok := s.turnSeen("t1"); !ok || turn != 5 {
		t.Errorf("next turn: %d %v", turn, ok)
	}
	// A failed write is tried again at the next chance.
	s.unwrote("t1", 5)
	if turn, ok := s.turnSeen("t1"); !ok || turn != 5 {
		t.Errorf("after a failed write: %d %v", turn, ok)
	}
	s.unwrote("t1", 4) // not the last write: kept
	if _, ok := s.turnSeen("t1"); ok {
		t.Error("unwrote of an older turn dropped the last write")
	}
	// Removed: forgotten.
	s.apply(hcEvent{Seq: s.seq + 1, Type: "removed", Terminal: "t1"})
	s.mu.Lock()
	_, kept := s.wrote["t1"]
	s.mu.Unlock()
	if kept {
		t.Error("a removed terminal's write was kept")
	}
	// Counting below zero is ignored.
	s.unwatch("t2", time.Unix(1000, 0))
	if s.viewers["t2"] != 0 {
		t.Error("viewers went below zero")
	}
}

func jsonNum(n uint64) string { b, _ := json.Marshal(n); return string(b) }

// seenCalls is the herdr.seen values written on addr.
func (s *hcSim) seenCalls(addr string) []string {
	var out []string
	for _, c := range s.core.callsOf("terminal.label") {
		var p struct {
			Terminal string
			Labels   map[string]string
		}
		json.Unmarshal(c.Params, &p)
		if p.Terminal == addr {
			out = append(out, p.Labels[hcLabelSeen])
		}
	}
	return out
}

// agentAt makes addr an agent that finished turn, as status then turn events.
func (s *hcSim) agentAt(addr string, turn uint64) {
	s.mu.Lock()
	s.terms[addr]["status"] = map[string]any{"app": "claude", "state": "done"}
	s.terms[addr]["turn"] = turn
	s.mu.Unlock()
	s.emit(addr, "status", map[string]any{"status": map[string]any{"app": "claude", "state": "done"}})
	s.emit(addr, "turn", map[string]any{"turn": turn})
	waitFor(s.t, func() bool { t, _ := s.m.state.terminal(addr); return t.Turn == turn && t.Status != nil })
}

func TestHcSeenStream(t *testing.T) {
	s := newHcSim(t)
	s.agentAt("t2", 3)
	ts, err := s.m.Attach(ctx5s(t), "t2", Size{})
	if err != nil {
		t.Fatal(err)
	}
	vs := ts.(visibleSetter)
	vs.SetVisible(true)
	vs.SetVisible(true) // no change: nothing
	waitFor(t, func() bool { return len(s.seenCalls("t2")) == 1 })
	waitFor(t, func() bool { t2, _ := s.m.state.terminal("t2"); v, _ := hcSeen(&t2); return v == 3 })
	// The agent shows idle now: a person saw its last turn.
	if a := hcAgent(ptr(must(s.m.state.terminal("t2")))); a.Status != "idle" {
		t.Errorf("status after seen: %s", a.Status)
	}

	// The next turn while it is on screen: written once.
	s.agentAt("t2", 4)
	waitFor(t, func() bool { return len(s.seenCalls("t2")) == 2 })
	if got := s.seenCalls("t2"); got[1] != "4" {
		t.Errorf("seen writes %v", got)
	}

	// Off screen: the next turn stays done.
	vs.SetVisible(false)
	s.agentAt("t2", 5)
	time.Sleep(50 * time.Millisecond)
	if n := len(s.seenCalls("t2")); n != 2 {
		t.Errorf("wrote %d times with nobody looking", n)
	}

	// A view-only device never writes.
	vt, err := s.m.AttachView(ctx5s(t), "t2", Size{})
	if err != nil {
		t.Fatal(err)
	}
	vt.(visibleSetter).SetVisible(true)
	vt.Close()

	time.Sleep(50 * time.Millisecond)
	if n := len(s.seenCalls("t2")); n != 2 {
		t.Errorf("wrote %d times: a view-only device wrote", n)
	}
	// Back on screen within the rejoin window: turn 5 ended meanwhile and
	// nobody saw it, so it is written now.
	vs.SetVisible(true)
	waitFor(t, func() bool { return len(s.seenCalls("t2")) == 3 })
	if got := s.seenCalls("t2"); got[2] != "5" {
		t.Errorf("seen writes %v", got)
	}

	// The stream ending counts its viewer out; later messages change nothing.
	ts.Close()
	vs.SetVisible(true)
	s.m.state.mu.Lock()
	n := s.m.state.viewers["t2"]
	s.m.state.mu.Unlock()
	if n != 0 {
		t.Errorf("viewers after close: %d", n)
	}
}

func TestHcSeenWriteFailureRetries(t *testing.T) {
	s := newHcSim(t)
	s.agentAt("t2", 3)
	s.mu.Lock()
	s.labelErr = "unavailable"
	s.mu.Unlock()
	ts, err := s.m.Attach(ctx5s(t), "t2", Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	ts.(visibleSetter).SetVisible(true)
	waitFor(t, func() bool { return len(s.seenCalls("t2")) == 1 })
	// The failure is forgotten, so the next turn writes.
	waitFor(t, func() bool {
		s.m.state.mu.Lock()
		defer s.m.state.mu.Unlock()
		_, ok := s.m.state.wrote["t2"]
		return !ok
	})
	s.mu.Lock()
	s.labelErr = ""
	s.mu.Unlock()
	s.agentAt("t2", 4)
	waitFor(t, func() bool { return len(s.seenCalls("t2")) == 2 })
}

func must[T any](v T, _ bool) T { return v }
