package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeCollector counts its calls and returns CPU and memory rising by one
// per call; CPU is nil on the first (no previous sample).
type fakeCollector struct {
	calls atomic.Int64
	err   error
}

func (f *fakeCollector) collect(scope string, prev cpuTimes) (systemStats, cpuTimes, sysErrors) {
	n := f.calls.Add(1)
	s := systemStats{Scope: "ignored", Memory: &memStats{Total: 100, Used: uint64(n), Percent: float64(n)}}
	if prev.ok {
		s.CPU = &cpuStats{Percent: float64(n), Count: 4}
	}
	errs := sysErrors{}
	errs.add(sysBattery, f.err)
	return s, cpuTimes{busy: uint64(n), total: uint64(n) * 2, ok: true}, errs
}

func newFakeSampler(f *fakeCollector) *systemSampler {
	s := newSystemSampler(scopeWSL, f.collect)
	t0 := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	var n int64
	s.now = func() time.Time { n++; return t0.Add(time.Duration(n) * systemInterval) }
	return s
}

func TestSamplerRingWrapsInOrder(t *testing.T) {
	f := &fakeCollector{}
	s := newFakeSampler(f)
	for range systemHistory + 7 {
		s.tick()
	}
	r := s.report()
	if len(r.History) != systemHistory {
		t.Fatalf("history has %d points, want %d", len(r.History), systemHistory)
	}
	// The 7 oldest points were overwritten: memory 8 .. 187, in time order.
	for i, p := range r.History {
		if p.Mem == nil || *p.Mem != float64(i+8) {
			t.Fatalf("point %d mem = %v, want %d", i, p.Mem, i+8)
		}
		if i > 0 && !p.T.After(r.History[i-1].T) {
			t.Fatalf("point %d not after %d", i, i-1)
		}
	}
	if r.Scope != scopeWSL || r.Memory.Percent != systemHistory+7 || r.SampledAt != r.History[systemHistory-1].T {
		t.Errorf("latest = %+v", r.systemStats)
	}
}

func TestSamplerFirstSampleHasNoCPU(t *testing.T) {
	s := newFakeSampler(&fakeCollector{})
	r := s.report()
	if r.CPU != nil || len(r.History) != 1 || r.History[0].CPU != nil || r.History[0].Mem == nil {
		t.Errorf("first report = %+v", r)
	}
	s.tick()
	if r := s.report(); r.CPU == nil || r.History[1].CPU == nil {
		t.Errorf("second report has no CPU: %+v", r)
	}
}

// However many readers, only the sampler collects once it has a sample.
func TestSamplerReadersDoNotCollect(t *testing.T) {
	f := &fakeCollector{}
	s := newFakeSampler(f)
	s.tick()
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 100 {
				s.report()
			}
		}()
	}
	for range 50 {
		s.tick()
	}
	wg.Wait()
	if n := f.calls.Load(); n != 51 {
		t.Errorf("collect ran %d times, want 51", n)
	}
}

func TestSamplerRunStopsWithContext(t *testing.T) {
	f := &fakeCollector{}
	s := newFakeSampler(f)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.run(ctx); close(done) }()
	for f.calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("run did not stop")
	}
}

func TestSamplerLogsAFailureOnce(t *testing.T) {
	f := &fakeCollector{err: errors.New("boom")}
	s := newFakeSampler(f)
	s.tick()
	s.tick()
	if !s.failed[sysBattery] {
		t.Fatal("battery failure not recorded")
	}
	f.err = nil
	s.tick()
	if s.failed[sysBattery] {
		t.Error("battery still marked failed after it worked")
	}
}

// stop returns only once the sampler has stopped reading, and twice is fine.
func TestSamplerStopWaits(t *testing.T) {
	f := &fakeCollector{}
	s := newFakeSampler(f)
	stop := startSystemSampler(context.Background(), s)
	for f.calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	stop()
	n := f.calls.Load()
	time.Sleep(20 * time.Millisecond)
	if f.calls.Load() != n {
		t.Error("the sampler read after stop returned")
	}
	stop()
}

// Requests before the first sample share one read.
func TestSamplerFirstReportsShareOneRead(t *testing.T) {
	f := &fakeCollector{}
	s := newFakeSampler(f)
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() { defer wg.Done(); s.report() }()
	}
	wg.Wait()
	if n := f.calls.Load(); n != 1 {
		t.Errorf("collect ran %d times, want 1", n)
	}
}
