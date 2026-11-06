package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"runtime"
	"sync"
	"time"
)

// GET /api/mux/machines lists the machines with their status and the
// agents their last snapshot showed; POST /api/mux/machines/reload (the CLI
// over the local socket only) reads machines.json again. Neither ever
// names an alias, a user or a path.

// MachineInfo is a machine in the snapshot and in the machines list.
type MachineInfo struct {
	ID     string         `json:"id"`
	Label  string         `json:"label"`
	Status string         `json:"status"`
	Groups []MachineGroup `json:"groups,omitempty"`
}

// MachineGroup, MachineTab and MachinePane are a machine's snapshot cut
// down to what the machines list shows: names and agents.
type MachineGroup struct {
	ID   string       `json:"id"`
	Name string       `json:"name"`
	Tabs []MachineTab `json:"tabs"`
}

type MachineTab struct {
	ID    string        `json:"id"`
	Name  string        `json:"name"`
	Panes []MachinePane `json:"panes"`
}

type MachinePane struct {
	ID    string     `json:"id"`
	Name  string     `json:"name,omitempty"`
	Agent *AgentInfo `json:"agent,omitempty"`
}

// machinePollEvery is how often each machine's snapshot is read while a
// client lists machines (or Web Push is on); on Windows every read is an
// SSH handshake, so less often.
var machinePollEvery = func() time.Duration {
	if runtime.GOOS == "windows" {
		return 15 * time.Second
	}
	return 5 * time.Second
}()

// machineListActive is how long after a client listed machines they keep
// being polled.
const machineListActive = 60 * time.Second

// machineSnapshotMax bounds a machine's snapshot read by the poll.
const machineSnapshotMax = 4 << 20

// machinePoller keeps each machine's last snapshot.
type machinePoller struct {
	mm *machineManager

	mu     sync.Mutex
	last   map[string]Snapshot
	listed time.Time
	// onSnapshot gets every machine snapshot read (the push watcher).
	onSnapshot func(id string, s Snapshot)
}

func newMachinePoller(mm *machineManager) *machinePoller {
	return &machinePoller{mm: mm, last: map[string]Snapshot{}}
}

// setOnSnapshot gives every machine snapshot read to f.
func (p *machinePoller) setOnSnapshot(f func(id string, s Snapshot)) {
	p.mu.Lock()
	p.onSnapshot = f
	p.mu.Unlock()
}

// touch records that a client listed the machines.
func (p *machinePoller) touch() {
	p.mu.Lock()
	p.listed = time.Now()
	p.mu.Unlock()
}

func (p *machinePoller) active() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.mm.keepUp || time.Since(p.listed) < machineListActive
}

// run polls until ctx ends.
func (p *machinePoller) run(ctx context.Context) {
	t := time.NewTicker(machinePollEvery)
	defer t.Stop()
	for {
		if p.active() {
			p.pollAll(ctx)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (p *machinePoller) pollAll(ctx context.Context) {
	var wg sync.WaitGroup
	for _, l := range p.mm.all() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.poll(ctx, l)
		}()
	}
	wg.Wait()
}

// poll reads one machine's snapshot as a view client: a failure only
// changes its status, never this server's own snapshot.
func (p *machinePoller) poll(ctx context.Context, l *machineLink) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+localSocketHost+"/api/mux/snapshot?peek=1", nil)
	req.Header.Set(bridgeRoleHeader, string(roleView))
	resp, err := l.transport.RoundTrip(req)
	if err != nil {
		p.drop(l.rec.ID)
		return
	}
	defer resp.Body.Close()
	var s Snapshot
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, machineSnapshotMax)).Decode(&s) != nil {
		p.drop(l.rec.ID)
		return
	}
	p.mu.Lock()
	p.last[l.rec.ID] = s
	on := p.onSnapshot
	p.mu.Unlock()
	if on != nil {
		on(l.rec.ID, s)
	}
}

func (p *machinePoller) drop(id string) {
	p.mu.Lock()
	delete(p.last, id)
	p.mu.Unlock()
}

// infos is every machine with its status, and with groups its last
// snapshot cut down.
func (p *machinePoller) infos(groups bool) []MachineInfo {
	out := []MachineInfo{}
	for _, l := range p.mm.all() {
		status, _ := l.state()
		mi := MachineInfo{ID: l.rec.ID, Label: l.rec.Label, Status: status}
		if groups && status == "online" {
			p.mu.Lock()
			s, ok := p.last[l.rec.ID]
			p.mu.Unlock()
			if ok {
				mi.Groups = cutMachineSnapshot(s)
			}
		}
		out = append(out, mi)
	}
	return out
}

// cutMachineSnapshot keeps names and agents, never a title, a process, a
// metadata token or a path.
func cutMachineSnapshot(s Snapshot) []MachineGroup {
	gs := make([]MachineGroup, 0, len(s.Groups))
	for _, g := range s.Groups {
		mg := MachineGroup{ID: g.ID, Name: g.Name, Tabs: []MachineTab{}}
		for _, t := range g.Tabs {
			mt := MachineTab{ID: t.ID, Name: t.Name, Panes: []MachinePane{}}
			for _, pn := range t.Panes {
				mt.Panes = append(mt.Panes, MachinePane{ID: pn.ID, Name: pn.Name, Agent: pn.Agent})
			}
			mg.Tabs = append(mg.Tabs, mt)
		}
		gs = append(gs, mg)
	}
	return gs
}

// registerMachineRoutes mounts the machines list, its reload, and the
// proxy to each machine.
func registerMachineRoutes(mux *http.ServeMux, agent *agentAPI, poller *machinePoller, fwd *streamHub, allowed hostAllowlist, proxyHeader string) {
	mux.HandleFunc("/api/mux/machines", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		if msg := crossSiteRejection(allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		if poller == nil {
			jsonOK(w, map[string]any{"machines": []MachineInfo{}})
			return
		}
		poller.touch()
		jsonOK(w, map[string]any{"machines": poller.infos(true)})
	})
	mux.HandleFunc("/api/mux/machines/reload", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		// The CLI over the local socket only: with or without sign-in,
		// nobody else changes which machines this server reaches.
		if !isLocalSocket(r.Context()) {
			jsonErrorCode(w, "cli_only", "only the termote CLI on this machine can reload machines", http.StatusForbidden)
			return
		}
		if agent.machines == nil {
			jsonOK(w, map[string]any{"machines": 0})
			return
		}
		if err := agent.machines.reload(); err != nil {
			log.Printf("machines reload: %v", err)
			jsonErrorCode(w, "machines_unreadable", "the machines file cannot be read", http.StatusInternalServerError)
			return
		}
		jsonOK(w, map[string]any{"machines": len(agent.machines.all())})
	})
	registerMachineProxy(mux, agent, fwd, allowed, proxyHeader)
}
