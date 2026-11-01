package main

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"
)

const (
	// systemInterval is how often the sampler reads the host.
	systemInterval = 5 * time.Second
	// systemHistory points of CPU and memory: 15 minutes at 5 s.
	systemHistory = 180
)

// sysPoint is one point of the CPU and memory history, null where the
// sample had none.
type sysPoint struct {
	T   time.Time `json:"t"`
	CPU *float64  `json:"cpu"`
	Mem *float64  `json:"mem"`
}

// systemReport is GET /api/mux/system: the latest sample and its history,
// oldest first.
type systemReport struct {
	systemStats
	History []sysPoint `json:"history"`
}

// collectFunc reads one sample (collectSystem; a fake in tests).
type collectFunc func(scope string, prev cpuTimes) (systemStats, cpuTimes, sysErrors)

// systemSampler is the only reader of the host stats: one goroutine reads
// them every systemInterval and every request answers from what it stored,
// however many devices watch. A failed reading is logged once until it
// works again, never sent.
type systemSampler struct {
	scope   string
	collect collectFunc
	now     func() time.Time

	// tickMu runs one collection at a time; mu guards what it stored.
	tickMu sync.Mutex
	prev   cpuTimes
	failed map[string]bool

	mu     sync.Mutex
	latest systemStats
	have   bool
	ring   [systemHistory]sysPoint
	head   int // next slot to write
	n      int // points kept
}

func newSystemSampler(scope string, collect collectFunc) *systemSampler {
	return &systemSampler{scope: scope, collect: collect, now: time.Now, failed: map[string]bool{}}
}

// run samples until ctx ends.
func (s *systemSampler) run(ctx context.Context) {
	t := time.NewTicker(systemInterval)
	defer t.Stop()
	for {
		s.tick()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// startSystemSampler runs s until ctx ends or the returned stop is called;
// stop (safe to call twice) returns once no sample is being read. A sample
// on macOS starts `ps` and `pmset`, and between fork and exec the child holds
// every open descriptor, the CLI's socket included: the socket's cleanup,
// which leaves a socket something answers on, runs only after stop.
func startSystemSampler(ctx context.Context, s *systemSampler) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.run(ctx)
	}()
	return func() {
		cancel()
		<-done
	}
}

// tick reads one sample and stores it.
func (s *systemSampler) tick() {
	s.tickMu.Lock()
	defer s.tickMu.Unlock()
	s.tickLocked()
}

// tickLocked is tick with tickMu held.
func (s *systemSampler) tickLocked() {
	st, cur, errs := s.collect(s.scope, s.prev)
	s.prev = cur
	for _, kind := range []string{sysCPU, sysLoad, sysMemory, sysDisk, sysBattery} {
		err, bad := errs[kind]
		switch {
		case bad && !s.failed[kind]:
			log.Printf("host stats: %s unavailable: %v", kind, err)
			s.failed[kind] = true
		case !bad:
			delete(s.failed, kind)
		}
	}
	st.Scope = s.scope
	st.SampledAt = s.now().UTC().Truncate(time.Second)
	p := sysPoint{T: st.SampledAt}
	if st.CPU != nil {
		v := st.CPU.Percent
		p.CPU = &v
	}
	if st.Memory != nil {
		v := st.Memory.Percent
		p.Mem = &v
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.latest, s.have = st, true
	s.ring[s.head] = p
	s.head = (s.head + 1) % systemHistory
	s.n = min(s.n+1, systemHistory)
}

// report is the latest sample and the history in time order. Before the
// sampler's first tick it reads one sample itself (without a CPU share
// where that needs two).
func (s *systemSampler) report() systemReport {
	s.mu.Lock()
	have := s.have
	s.mu.Unlock()
	if !have {
		// Requests waiting here while another reads get its sample: one
		// read, and no CPU share over a few milliseconds.
		s.tickMu.Lock()
		s.mu.Lock()
		have = s.have
		s.mu.Unlock()
		if !have {
			s.tickLocked()
		}
		s.tickMu.Unlock()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return systemReport{systemStats: s.latest, History: s.history()}
}

// history copies the ring oldest first; s.mu is held.
func (s *systemSampler) history() []sysPoint {
	out := make([]sysPoint, 0, s.n)
	start := (s.head - s.n + systemHistory) % systemHistory
	for i := range s.n {
		out = append(out, s.ring[(start+i)%systemHistory])
	}
	return out
}

// registerSystemRoute mounts GET /api/mux/system. It reads nothing itself
// and has no parameters; a view-only device may read it (load and capacity
// name no pane, path or person).
func registerSystemRoute(mux *http.ServeMux, s *systemSampler, allowed hostAllowlist) {
	mux.HandleFunc("/api/mux/system", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		if msg := crossSiteRejection(allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		jsonOK(w, s.report())
	})
}
