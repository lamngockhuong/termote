package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Lookups waiting at once share reads: n of them cost at most two.
func TestTableSnapshotsShareReads(t *testing.T) {
	var reads atomic.Int32
	release := make(chan struct{})
	s := newTableSnapshots(func() int32 {
		n := reads.Add(1)
		<-release
		return n
	})
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() { defer wg.Done(); s.get() }()
	}
	time.Sleep(50 * time.Millisecond) // every lookup is waiting
	close(release)
	wg.Wait()
	if n := reads.Load(); n < 1 || n > 2 {
		t.Errorf("50 lookups at once made %d reads, want 1 or 2", n)
	}
}

// A lookup never gets a read that started before it asked: the connection
// it looks up may be missing from it.
func TestTableSnapshotsReadStartsAfterAsk(t *testing.T) {
	first := make(chan struct{})
	release := make(chan struct{})
	s := newTableSnapshots(func() int64 {
		at := time.Now().UnixNano()
		select {
		case <-first:
		default:
			close(first)
			<-release // the first read is still running when the second asks
		}
		return at
	})
	go s.get()
	<-first
	asked := time.Now().UnixNano()
	got := make(chan int64)
	go func() { got <- s.get() }()
	time.Sleep(20 * time.Millisecond)
	close(release)
	if at := <-got; at < asked {
		t.Errorf("lookup got a read started %d ns before it asked", asked-at)
	}
}
