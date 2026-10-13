package main

import "sync"

// tableSnapshots shares the reads of a socket table between the lookups
// waiting on it. Reading the whole table for each connection makes a flood
// of n connections cost n reads of a table that grows with it; here a
// lookup waits for the first read that starts after it asked (so the
// connection it looks up is in it), and every lookup waiting then shares
// that read: n lookups at once cost about two reads.
type tableSnapshots[T any] struct {
	read func() T

	mu sync.Mutex
	// next is the read the lookups asking now wait for, not started yet.
	next    *tableSnapshot[T]
	running bool
}

type tableSnapshot[T any] struct {
	done chan struct{}
	v    T
}

func newTableSnapshots[T any](read func() T) *tableSnapshots[T] {
	return &tableSnapshots[T]{read: read}
}

// get returns a read of the table that started after get was called.
func (s *tableSnapshots[T]) get() T {
	s.mu.Lock()
	if s.next == nil {
		s.next = &tableSnapshot[T]{done: make(chan struct{})}
	}
	w := s.next
	if !s.running {
		s.running = true
		go s.run()
	}
	s.mu.Unlock()
	<-w.done
	return w.v
}

// run reads the table while lookups wait for a read, one at a time.
func (s *tableSnapshots[T]) run() {
	for {
		s.mu.Lock()
		w := s.next
		s.next = nil
		if w == nil {
			s.running = false
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
		w.v = s.read()
		close(w.done)
	}
}
