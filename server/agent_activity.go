package main

import (
	"maps"
	"slices"
	"strings"
	"sync"
	"time"
)

// The activity tracker records, for each pane with an agent, its status and
// when that status began, and keeps the last status changes in a ring. It is
// fed by the snapshot reads that already run (the snapshot route, a stream
// attaching, the push watcher's tick), never by a read of its own: with no
// page open and no push subscription, nothing is recorded.

// activityRingLen status changes are kept; past it the oldest goes.
const activityRingLen = 500

// activityTimeFormat is RFC 3339 in UTC with milliseconds.
const activityTimeFormat = "2006-01-02T15:04:05.000Z07:00"

// activityEvent is one status change of a pane's agent: from "" when it
// appeared, to "" when it went. The ids are the ones the pane had then; key
// names the pane as pwa/src/utils/pane-remap.ts paneKeys does (a tmux tab's
// key, any other pane's id), so the PWA follows a moved tmux window.
type activityEvent struct {
	Seq     uint64 `json:"seq"`
	TS      string `json:"ts"`
	Key     string `json:"key"`
	GroupID string `json:"groupId"`
	TabID   string `json:"tabId"`
	PaneID  string `json:"paneId"`
	Agent   string `json:"agent"`
	From    string `json:"from"`
	To      string `json:"to"`
}

// activityPage answers /api/mux/activity. Reset: the events start at the
// oldest kept one, not after the client's cursor (some were dropped, or the
// server restarted).
type activityPage struct {
	Events    []activityEvent `json:"events"`
	Latest    uint64          `json:"latest"`
	Oldest    uint64          `json:"oldest"`
	Reset     bool            `json:"reset,omitempty"`
	ServerNow string          `json:"serverNow"`
}

// activityState is what the tracker knows of one pane, by paneKey.
type activityState struct {
	status    string
	agent     string
	since     time.Time
	firstSeen bool // since is when the server first saw it, not a change
	groupID   string
	tabID     string
	paneID    string
	key       string
}

type activityTracker struct {
	now func() time.Time

	mu sync.Mutex
	// gen numbers reads in the order they started; applied is the newest
	// one observed. A read started earlier and finished later is stale.
	gen, applied uint64
	states       map[string]activityState
	// indexTabs: the tab ids of each group whose panes are known by their
	// tab's index (psmux, a tmux without window ids), joined.
	indexTabs map[string]string
	ring      []activityEvent
	seq       uint64
	last      Snapshot
	hasLast   bool
}

func newActivityTracker(now func() time.Time) *activityTracker {
	return &activityTracker{now: now, states: map[string]activityState{}, indexTabs: map[string]string{}}
}

// begin numbers a snapshot read; call it before reading, and give the number
// to observe.
func (t *activityTracker) begin() uint64 {
	if t == nil {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.gen++
	return t.gen
}

// observe folds snap, read under gen, into the statuses and returns a copy of
// it with each tracked agent's since and the server time. A snapshot read
// before the one last observed changes nothing: it only gets the known
// since. snap itself is never written (Herdr's is shared with its cache).
func (t *activityTracker) observe(gen uint64, snap Snapshot) Snapshot {
	if t == nil {
		return snap
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now().UTC()
	if gen > t.applied {
		t.applied = gen
		t.fold(snap, now)
	}
	out := t.annotate(snap)
	out.ServerNow = now.Format(activityTimeFormat)
	if gen == t.applied {
		t.last, t.hasLast = out, true
	}
	return out
}

// fold applies snap's statuses, with the rule of the push watcher
// (foldPaneStatus), and records the changes: the agents that went first, in
// key order, then the others in snapshot order.
func (t *activityTracker) fold(snap Snapshot, now time.Time) {
	reset := t.resetRenumbered(snap)
	seen := map[string]bool{}
	for _, g := range snap.Groups {
		for _, tab := range g.Tabs {
			for _, p := range tab.Panes {
				if k := paneKey(p); foldPaneStatus(t.states[k].status, p.Agent) != "" {
					seen[k] = true
				}
			}
		}
	}
	gone := slices.Sorted(maps.Keys(t.states))
	for _, k := range gone {
		if s := t.states[k]; !seen[k] {
			delete(t.states, k)
			t.record(now, s, s.status, "")
		}
	}
	for _, g := range snap.Groups {
		for _, tab := range g.Tabs {
			for _, p := range tab.Panes {
				k := paneKey(p)
				prev, known := t.states[k]
				status := foldPaneStatus(prev.status, p.Agent)
				if status == "" {
					continue
				}
				s := activityState{status: status, agent: p.Agent.Name, since: prev.since, firstSeen: prev.firstSeen,
					groupID: g.ID, tabID: tab.ID, paneID: p.ID, key: activityKey(tab, p)}
				switch {
				case !known:
					s.since, s.firstSeen = now, true
					// A pane forgotten for a renumbering did not appear.
					if !reset[g.ID] {
						t.record(now, s, "", status)
					}
				case status != prev.status:
					s.since, s.firstSeen = now, false
					t.record(now, s, prev.status, status)
				}
				t.states[k] = s
			}
		}
	}
}

// resetRenumbered forgets, without events, the panes of a group known by tab
// index once its tabs changed: a closed or renumbered tab gives its index to
// another, whose history would otherwise be the old one's. It returns the
// groups reset.
func (t *activityTracker) resetRenumbered(snap Snapshot) map[string]bool {
	groups := map[string]bool{}
	reset := map[string]bool{}
	for _, g := range snap.Groups {
		if !indexKeyed(g) {
			continue
		}
		groups[g.ID] = true
		ids := make([]string, len(g.Tabs))
		for i, tab := range g.Tabs {
			ids[i] = tab.ID
		}
		joined := strings.Join(ids, "\n")
		if prev, ok := t.indexTabs[g.ID]; ok && prev != joined {
			reset[g.ID] = true
			for k, s := range t.states {
				if s.groupID == g.ID {
					delete(t.states, k)
				}
			}
		}
		t.indexTabs[g.ID] = joined
	}
	for id := range t.indexTabs {
		if !groups[id] {
			delete(t.indexTabs, id)
		}
	}
	return reset
}

// indexKeyed reports whether g's panes are known by their tab's id, which is
// a window index.
func indexKeyed(g Group) bool {
	for _, tab := range g.Tabs {
		for _, p := range tab.Panes {
			if paneKey(p) == tab.ID {
				return true
			}
		}
	}
	return false
}

// activityKey names p as paneKeys does in the PWA: a pane with its tab's id
// has the tab's key.
func activityKey(tab Tab, p Pane) string {
	if p.ID == tab.ID && tab.Key != "" {
		return tab.Key
	}
	return p.ID
}

func (t *activityTracker) record(now time.Time, s activityState, from, to string) {
	t.seq++
	if len(t.ring) == activityRingLen {
		t.ring = append(t.ring[:0], t.ring[1:]...)
	}
	t.ring = append(t.ring, activityEvent{Seq: t.seq, TS: now.Format(activityTimeFormat), Key: s.key,
		GroupID: s.groupID, TabID: s.tabID, PaneID: s.paneID, Agent: s.agent, From: from, To: to})
}

// annotate copies snap, giving every tracked pane a new AgentInfo with its
// since.
func (t *activityTracker) annotate(snap Snapshot) Snapshot {
	out := copySnapshot(snap)
	for gi := range out.Groups {
		for ti := range out.Groups[gi].Tabs {
			tab := &out.Groups[gi].Tabs[ti]
			for pi := range tab.Panes {
				p := &tab.Panes[pi]
				if p.Agent == nil {
					continue
				}
				a := *p.Agent
				if s, ok := t.states[paneKey(*p)]; ok {
					a.Since = s.since.Format(activityTimeFormat)
					a.SinceFirstSeen = s.firstSeen
				}
				p.Agent = &a
			}
		}
	}
	return out
}

// eventsAfter is the page of events after seq after (every kept one when
// hasAfter is false).
func (t *activityTracker) eventsAfter(after uint64, hasAfter bool) activityPage {
	t.mu.Lock()
	defer t.mu.Unlock()
	page := activityPage{Latest: t.seq, ServerNow: t.now().UTC().Format(activityTimeFormat), Events: []activityEvent{}}
	if len(t.ring) > 0 {
		page.Oldest = t.ring[0].Seq
	}
	// A cursor past the latest is from before a restart; one before the
	// oldest kept event missed the ones dropped in between.
	page.Reset = !hasAfter || after > t.seq || (len(t.ring) > 0 && after+1 < page.Oldest)
	for _, e := range t.ring {
		if page.Reset || e.Seq > after {
			page.Events = append(page.Events, e)
		}
	}
	return page
}

// lastSnapshot is the newest snapshot observed, with its since and server
// time.
func (t *activityTracker) lastSnapshot() (Snapshot, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.last, t.hasLast
}

// renameGroup moves what is known of group from's panes to group to, whose
// ids start with its own (a Zellij group's id is its session's name, and
// every tab id, pane id and key in it starts with `<gid>:` or `<gid>/`).
// Reads started before the rename are stale: they have the old ids.
func (t *activityTracker) renameGroup(from, to string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.gen++
	t.applied = t.gen
	states := make(map[string]activityState, len(t.states))
	for k, s := range t.states {
		s.groupID = renamedGroupID(s.groupID, from, to)
		s.tabID = renamedGroupID(s.tabID, from, to)
		s.paneID = renamedGroupID(s.paneID, from, to)
		s.key = renamedGroupID(s.key, from, to)
		states[renamedGroupID(k, from, to)] = s
	}
	t.states = states
	for i := range t.ring {
		e := &t.ring[i]
		e.GroupID = renamedGroupID(e.GroupID, from, to)
		e.TabID = renamedGroupID(e.TabID, from, to)
		e.PaneID = renamedGroupID(e.PaneID, from, to)
		e.Key = renamedGroupID(e.Key, from, to)
	}
	t.hasLast = false
}

// renamedGroupID is id with group from's prefix changed to to's, the rule of
// pwa/src/utils/pane-remap.ts renameGroupKeys.
func renamedGroupID(id, from, to string) string {
	if id == from {
		return to
	}
	rest, ok := strings.CutPrefix(id, from)
	if ok && (rest[0] == ':' || rest[0] == '/') {
		return to + rest
	}
	return id
}
