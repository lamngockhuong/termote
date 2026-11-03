package main

import (
	"context"
	"log"
	"time"
)

// herdr.seen, shared by every Herdr client (herdr-app docs/labels.md): the
// last turn a person looked at. termote writes it while a full client has a
// terminal on screen, so an agent read on the phone stops being "done" on
// the desktop.

// hcSeenRejoin is how long after a terminal's last viewer left a new one is
// still the same person coming back (a reconnect, a page reload): it does
// not write, so a "mark unread" made meanwhile on another client stands.
const hcSeenRejoin = 10 * time.Second

// visibleSetter is a stream told whether its client has the pane on screen
// (the "visible" stream message, full clients only).
type visibleSetter interface {
	SetVisible(on bool)
}

// hcSeenNeed reports whether a terminal looked at should get herdr.seen=turn:
// it runs an agent, and the label is missing or lower. Missing is not 0:
// writing it makes a terminal started elsewhere join.
func hcSeenNeed(t *hcTerminal) bool {
	if t == nil || t.Status == nil || checkHcTerminal(t.Address) != nil {
		return false
	}
	seen, ok := hcSeen(t)
	return !ok || t.Turn > seen
}

// watch counts one more viewer of addr. The first one writes herdr.seen when
// it is behind; it returns the turn to write. Back less than rejoin after the
// last viewer left, it writes only a turn that ended meanwhile: the label
// lower than a turn already looked at is another client's "mark unread".
func (s *hcState) watch(addr string, now time.Time) (uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.viewers[addr]++
	if s.viewers[addr] > 1 {
		return 0, false
	}
	left, ok := s.left[addr]
	delete(s.left, addr)
	rejoin := ok && now.Sub(left) < s.rejoin
	t := s.terminals[addr]
	if t == nil {
		return 0, false
	}
	looked := s.wrote[addr]
	// This turn is looked at now, written or not: a turn event repeating it
	// writes nothing.
	s.wrote[addr] = max(looked, t.Turn)
	if !hcSeenNeed(t) || (rejoin && t.Turn <= looked) {
		return 0, false
	}
	return t.Turn, true
}

// unwatch counts one viewer of addr less, recording when the last one left.
func (s *hcState) unwatch(addr string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.viewers[addr] <= 0 {
		return
	}
	s.viewers[addr]--
	if s.viewers[addr] > 0 {
		return
	}
	delete(s.viewers, addr)
	// Drop the departures too old to matter, so the map stays small.
	for a, at := range s.left {
		if now.Sub(at) >= s.rejoin {
			delete(s.left, a)
		}
	}
	s.left[addr] = now
}

// turnSeen is the turn to write after addr's turn event: one write per turn
// (wrote also holds the turn a viewer found), while someone looks at it.
func (s *hcState) turnSeen(addr string) (uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.terminals[addr]
	if s.viewers[addr] <= 0 || !hcSeenNeed(t) || t.Turn <= s.wrote[addr] {
		return 0, false
	}
	s.wrote[addr] = t.Turn
	return t.Turn, true
}

// unwrote forgets a write that failed, so the next turn event or viewer
// tries again.
func (s *hcState) unwrote(addr string, turn uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wrote[addr] == turn {
		delete(s.wrote, addr)
	}
}

// writeSeen sets herdr.seen=turn on addr in the background. A failure is
// only logged: it never holds up a stream.
func (m *hcMux) writeSeen(addr string, turn uint64) {
	go func() {
		ctx, cancel := context.WithTimeout(m.ctx, muxTimeout)
		defer cancel()
		conn, err := m.conn(ctx)
		if err == nil {
			err = conn.call(ctx, hcLabelParams{Terminal: addr, Seen: turn}, nil)
		}
		if err != nil {
			m.state.unwrote(addr, turn)
			if m.ctx.Err() == nil {
				log.Printf("hc herdr.seen %s: %v", addr, err)
			}
		}
	}()
}

// SetVisible counts this stream as a viewer of its pane while on: a full
// client in the foreground with the pane drawn (the terminal or its Chat
// view). A view-only stream never counts. The stream's end counts it out.
func (s *hcStream) SetVisible(on bool) {
	if s.view {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended || s.visible == on {
		return
	}
	s.visible = on
	now := time.Now()
	if !on {
		s.m.state.unwatch(s.pane, now)
		return
	}
	if turn, ok := s.m.state.watch(s.pane, now); ok {
		s.m.writeSeen(s.pane, turn)
	}
}

// endVisible counts the stream out at its end; later messages change nothing.
func (s *hcStream) endVisible() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ended = true
	if s.visible {
		s.visible = false
		s.m.state.unwatch(s.pane, time.Now())
	}
}
