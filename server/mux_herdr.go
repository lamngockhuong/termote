package main

import (
	"bufio"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// Herdr IDs as issued by herdr 0.9.1. The pattern also guarantees an ID never
// starts with '-', so it cannot be read as a flag by the herdr CLI.
var (
	herdrWorkspaceIDRe = regexp.MustCompile(`^w[0-9A-Za-z]+$`)
	herdrTabIDRe       = regexp.MustCompile(`^w[0-9A-Za-z]+:t[0-9A-Za-z]+$`)
	herdrPaneIDRe      = regexp.MustCompile(`^w[0-9A-Za-z]+:p[0-9A-Za-z]+$`)
)

const (
	// herdrCacheMaxAge bounds how long a snapshot is reused even when no
	// event marked it stale, in case an event was missed.
	herdrCacheMaxAge = 30 * time.Second
	// herdrResubscribeDelay collects a burst of pane changes (a layout being
	// restored, many agents detected at once) into one resubscription.
	herdrResubscribeDelay = 200 * time.Millisecond
	herdrBackoffMin       = 250 * time.Millisecond
	herdrBackoffMax       = 30 * time.Second
	// herdrMaxQueuedInput caps input waiting for one pane.
	herdrMaxQueuedInput = 1 << 20
)

// herdrEventTypes invalidate the snapshot cache. pane.agent_status_changed
// needs a pane_id, so it is subscribed per pane on top of these.
var herdrEventTypes = []string{
	"workspace.created", "workspace.updated", "workspace.renamed", "workspace.moved",
	"workspace.reordered", "workspace.closed", "workspace.focused",
	"tab.created", "tab.closed", "tab.focused", "tab.renamed", "tab.moved",
	"pane.created", "pane.closed", "pane.updated", "pane.focused", "pane.moved",
	"pane.exited", "pane.agent_detected",
	"layout.updated",
}

// herdrWorktreeEventTypes tell a worktree was created, opened or removed: the
// branches are read again. Subscribed only when worktrees are offered.
var herdrWorktreeEventTypes = []string{"worktree.created", "worktree.opened", "worktree.removed"}

// herdrAgentStatuses are the agent_status values herdr documents; anything
// else is reported as "unknown".
var herdrAgentStatuses = map[string]bool{"idle": true, "working": true, "blocked": true, "done": true, "unknown": true}

// herdrMux drives a herdr server over its socket. Groups are workspaces, tabs
// are tabs and panes are panes. Selecting a tab never touches the desktop:
// the PWA only switches which pane it streams.
type herdrMux struct {
	rpc *herdrRPC

	fetchMu sync.Mutex // one session.snapshot at a time
	mu      sync.Mutex
	cache   herdrView
	cached  bool
	fetched time.Time
	gen     uint64 // bumped by every invalidation
	// connected: the event subscription is live, so the cache can be trusted.
	connected  bool
	subscribed map[string]bool // panes with an agent_status_changed subscription
	resub      chan struct{}

	watchMu  sync.Mutex
	watchers map[string]map[chan Size]struct{} // pane → streams following its size

	writersMu sync.Mutex
	writers   map[string]*paneWriter

	scrollMu sync.Mutex // one read-then-set of a scroll offset at a time

	procs    *herdrProcCache   // each pane's foreground process name
	branches *herdrBranchCache // each worktree workspace's branch

	version atomic.Value // string: the Herdr version the last ping reported
}

// herdrView is a mapped snapshot plus the pane sizes streams need, each
// pane's foreground directory (for its process) and each worktree group
// member's repository (for its branch).
type herdrView struct {
	snap      Snapshot
	sizes     map[string]Size
	cwds      map[string]string
	worktrees map[string]herdrWorktreeRef
}

// herdrWorktreeRef is a workspace's membership of a Herdr worktree group:
// its repository and whether it is a linked worktree (else the repository's
// own checkout).
type herdrWorktreeRef struct {
	repoKey string
	linked  bool
}

// newHerdrMux returns a backend for the herdr server at socket. The event
// subscription runs until ctx ends, reconnecting with backoff, so herdr can be
// started after the server.
func newHerdrMux(ctx context.Context, socket string) (*herdrMux, error) {
	m := &herdrMux{
		rpc:      &herdrRPC{socket: socket},
		resub:    make(chan struct{}, 1),
		watchers: map[string]map[chan Size]struct{}{},
		writers:  map[string]*paneWriter{},
		procs:    newHerdrProcCache(),
	}
	m.branches = newHerdrBranchCache(m.worktreeBranches)
	go m.subscribeLoop(ctx)
	return m, nil
}

func (*herdrMux) Name() string { return "herdr" }

// herdrCodexSession is findCodexSession; tests replace it.
var herdrCodexSession = findCodexSession

func (m *herdrMux) Caps() Caps {
	v, _ := m.version.Load().(string)
	start := herdrCanStartAgents(v)
	reorder := herdrCanReorder(v, herdrStartGOOS)
	return Caps{ClientSideSelect: true, Scroll: true, PaneText: true, DriveSize: true, AgentChat: true, Files: true, Groups: true,
		AgentStart: start, AgentStartCodex: start && agentStartKind("codex"),
		Worktrees: herdrCanWorktrees(v, herdrStartGOOS), ReorderTabs: reorder, ReorderGroups: reorder}
}

// herdrStartGOOS is the OS the worktree gate and a start's idle check
// (paneIdleShell) use; tests of those routes set it so they run on Windows
// too.
var herdrStartGOOS = runtime.GOOS

// herdrProcChildren lists each process's children (paneIdleShell on
// Windows); tests replace it.
var herdrProcChildren = procChildrenFunc

// herdrWorktreesMin is the first Herdr whose worktree.open no longer takes
// over the repository's own workspace (a remove then closed that one).
const herdrWorktreesMin = "0.9.2"

// herdrCanWorktrees: worktrees are offered on Herdr version v. Not on
// Windows until someone checks them there.
func herdrCanWorktrees(v, goos string) bool {
	return goos != "windows" && versionRe.MatchString(v) && compareVersions(v, herdrWorktreesMin) >= 0
}

// herdrReorderMin is the first Herdr with workspace.move_block, which moves
// a worktree group's workspaces together (tab.move is older).
const herdrReorderMin = "0.8.0"

// herdrCanReorder: tabs and workspaces can be moved on Herdr version v. Not
// on Windows until someone checks it there.
func herdrCanReorder(v, goos string) bool {
	return goos != "windows" && versionRe.MatchString(v) && compareVersions(v, herdrReorderMin) >= 0
}

// herdrAgentStartMin is the first Herdr whose agent.start waits for a new
// pane's shell and for first-run prompts.
const herdrAgentStartMin = "0.8.2"

// herdrCanStartAgents: agent.start is offered on Herdr version v.
func herdrCanStartAgents(v string) bool {
	return versionRe.MatchString(v) && compareVersions(v, herdrAgentStartMin) >= 0
}

// AgentSession reads the session herdr's Claude integration reported for the
// pane, straight from pane.get rather than the snapshot cache, so /clear or a
// resume shows up on the next poll. herdr keeps the last session reported
// for a pane even after another agent replaced it, hence the agent check.
// herdr does not expose the pane's process, so a Claude Code transcript is
// looked up in the config dir of a Claude Code started by the server's user,
// and a Codex session counts only while a Codex process holds its rollout
// (findCodexSession).
func (m *herdrMux) AgentSession(ctx context.Context, paneID string) (AgentSession, bool, error) {
	if !herdrPaneIDRe.MatchString(paneID) {
		return AgentSession{}, false, inputError("invalid pane id")
	}
	var res struct {
		Pane struct {
			Agent        string `json:"agent"`
			AgentStatus  string `json:"agent_status"`
			AgentSession *struct {
				Agent string `json:"agent"`
				Kind  string `json:"kind"`
				Value string `json:"value"`
			} `json:"agent_session"`
		} `json:"pane"`
	}
	if err := m.rpc.call(ctx, "pane.get", map[string]string{"pane_id": paneID}, &res); err != nil {
		return AgentSession{}, false, herdrInputError(err)
	}
	p := res.Pane
	ref := p.AgentSession
	if (p.Agent != "claude" && p.Agent != "codex") || ref == nil || ref.Agent != p.Agent || ref.Kind != "id" || !isSessionID(ref.Value) {
		return AgentSession{}, false, nil
	}
	status := p.AgentStatus
	if !herdrAgentStatuses[status] {
		status = "unknown"
	}
	if p.Agent == "codex" {
		s, ok := herdrCodexSession(ref.Value)
		if !ok {
			return AgentSession{}, false, nil
		}
		s.Status, s.Target = status, paneID
		return s, true, nil
	}
	return AgentSession{
		Agent: "claude", ID: ref.Value, Status: status,
		ClaudeDir: defaultClaudeDir(), Target: paneID,
	}, true, nil
}

// Health pings the server now; a missing socket or an unknown protocol version
// reports degraded.
func (m *herdrMux) Health(ctx context.Context) error {
	p, err := m.rpc.ping(ctx)
	if err != nil {
		return err
	}
	if p.Protocol != herdrProtocol {
		return fmt.Errorf("herdr %s speaks protocol %d, termote supports %d", p.Version, p.Protocol, herdrProtocol)
	}
	return nil
}

// Snapshot is the cached view with each pane's foreground process and each
// worktree workspace's branch. The view is shared (streams, requirePane read
// it too), so these go into a copy of it, read outside fetchMu.
func (m *herdrMux) Snapshot(ctx context.Context) (Snapshot, error) {
	return m.snapshot(ctx, true)
}

// peekSnapshot is Snapshot without the branches: the push watcher and the
// service worker never start a worktree.list.
func (m *herdrMux) peekSnapshot(ctx context.Context) (Snapshot, error) {
	return m.snapshot(ctx, false)
}

func (m *herdrMux) snapshot(ctx context.Context, withBranches bool) (Snapshot, error) {
	v, err := m.view(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	snap := copySnapshot(v.snap)
	var panes []string
	for _, g := range snap.Groups {
		for _, t := range g.Tabs {
			for _, p := range t.Panes {
				panes = append(panes, p.ID)
			}
		}
	}
	names := m.procs.names(ctx, panes, m.paneProcessName)
	for gi := range snap.Groups {
		for ti := range snap.Groups[gi].Tabs {
			tab := &snap.Groups[gi].Tabs[ti]
			for pi := range tab.Panes {
				p := &tab.Panes[pi]
				if name := names[p.ID]; name != "" {
					p.Process = &ProcessInfo{Name: name, Cwd: v.cwds[p.ID]}
				}
			}
		}
	}
	var branches map[string]string
	if withBranches {
		branches = m.branches.branches(v)
	}
	for gi := range snap.Groups {
		g := &snap.Groups[gi]
		if ref, ok := v.worktrees[g.ID]; ok {
			g.Worktree = &GroupWorktree{Linked: ref.linked, Branch: branches[g.ID]}
		}
	}
	return snap, nil
}

// copySnapshot copies a snapshot's groups, tabs and panes, so filling the
// copy never writes into the one it came from.
func copySnapshot(s Snapshot) Snapshot {
	out := s
	out.Groups = make([]Group, len(s.Groups))
	for gi, g := range s.Groups {
		g.Tabs = slices.Clone(g.Tabs)
		for ti := range g.Tabs {
			g.Tabs[ti].Panes = slices.Clone(g.Tabs[ti].Panes)
		}
		out.Groups[gi] = g
	}
	return out
}

// paneProcess reads a pane's foreground processes (pane.process_info, from
// herdr 0.9.3 / protocol 22). Only pids and names are decoded.
func (m *herdrMux) paneProcess(ctx context.Context, paneID string) (herdrProcessInfo, error) {
	var res struct {
		ProcessInfo herdrProcessInfo `json:"process_info"`
	}
	err := m.rpc.call(ctx, "pane.process_info", map[string]string{"pane_id": paneID}, &res)
	return res.ProcessInfo, err
}

// paneProcessName is the name of the pane's foreground group leader, "" when
// the pane has no foreground process.
func (m *herdrMux) paneProcessName(ctx context.Context, paneID string) (string, error) {
	info, err := m.paneProcess(ctx, paneID)
	if err != nil {
		return "", err
	}
	_, name, _ := info.leader()
	return processName(name), nil
}

// paneIdleShell reports whether the pane shows only its shell, waiting for
// input: nothing started from it, not even through exec. Read now, never
// from the cache.
func (m *herdrMux) paneIdleShell(ctx context.Context, paneID string) (bool, error) {
	if !herdrPaneIDRe.MatchString(paneID) {
		return false, inputError("invalid pane id")
	}
	info, err := m.paneProcess(ctx, paneID)
	if err != nil {
		return false, herdrInputError(err)
	}
	if !info.idleShell() || herdrStartGOOS != "windows" {
		return info.idleShell(), nil
	}
	// Herdr on Windows reports as foreground only an agent it knows, else
	// the shell, never another program the shell runs (ping, nvim, a nested
	// cmd). A shell with a child is busy, as in Herdr's own agent.start
	// check. Herdr runs on this host (a named pipe), so the processes are
	// the same.
	children, err := herdrProcChildren()
	if err != nil {
		return false, err
	}
	return len(children(info.ShellPID)) == 0, nil
}

// view returns the cached snapshot when it is still fresh, else fetches one.
func (m *herdrMux) view(ctx context.Context) (herdrView, error) {
	if v, ok := m.fresh(); ok {
		return v, nil
	}
	m.fetchMu.Lock()
	defer m.fetchMu.Unlock()
	// Another request may have refreshed it while this one waited.
	if v, ok := m.fresh(); ok {
		return v, nil
	}
	m.mu.Lock()
	gen := m.gen
	m.mu.Unlock()

	var res struct {
		Snapshot herdrSnapshot `json:"snapshot"`
	}
	if err := m.rpc.call(ctx, "session.snapshot", nil, &res); err != nil {
		return herdrView{}, err
	}
	v := mapHerdrSnapshot(res.Snapshot)

	m.mu.Lock()
	// An event that arrived during the fetch may not be reflected: use the
	// result for this request but do not cache it as fresh.
	if gen == m.gen {
		m.cache, m.cached, m.fetched = v, true, time.Now()
		// A layout event can be missed (between subscriptions, or while a
		// stream was starting); a snapshot that no event overtook corrects
		// every stream's size. One that was overtaken may carry an old size.
		m.notifyPaneSizes(v.sizes)
	}
	stale := m.connected && !sameKeys(m.subscribed, v.sizes)
	m.mu.Unlock()
	m.pruneWriters(v.sizes)
	if stale {
		select {
		case m.resub <- struct{}{}:
		default:
		}
	}
	return v, nil
}

func (m *herdrMux) fresh() (herdrView, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cached && m.connected && time.Since(m.fetched) < herdrCacheMaxAge {
		return m.cache, true
	}
	return herdrView{}, false
}

func (m *herdrMux) invalidate() {
	m.mu.Lock()
	m.gen++
	m.cached = false
	m.mu.Unlock()
}

// herdrSnapshot is the subset of session.snapshot this backend reads.
type herdrSnapshot struct {
	Workspaces []struct {
		ID          string `json:"workspace_id"`
		Number      int    `json:"number"`
		Label       string `json:"label"`
		ActiveTabID string `json:"active_tab_id"`
		Worktree    *struct {
			RepoKey  string `json:"repo_key"`
			IsLinked bool   `json:"is_linked_worktree"`
		} `json:"worktree"`
	} `json:"workspaces"`
	Tabs []struct {
		ID          string `json:"tab_id"`
		WorkspaceID string `json:"workspace_id"`
		Number      int    `json:"number"`
		Label       string `json:"label"`
	} `json:"tabs"`
	Panes []struct {
		ID            string  `json:"pane_id"`
		TabID         string  `json:"tab_id"`
		Title         string  `json:"terminal_title_stripped"`
		Agent         *string `json:"agent"`
		AgentStatus   string  `json:"agent_status"`
		Cwd           string  `json:"cwd"`
		ForegroundCwd string  `json:"foreground_cwd"`
	} `json:"panes"`
	Layouts []herdrLayout `json:"layouts"`
}

type herdrLayout struct {
	TabID         string `json:"tab_id"`
	FocusedPaneID string `json:"focused_pane_id"`
	Panes         []struct {
		ID   string `json:"pane_id"`
		Rect struct {
			X      int `json:"x"`
			Y      int `json:"y"`
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"rect"`
	} `json:"panes"`
}

// mapHerdrSnapshot orders workspaces by their herdr number, tabs as herdr
// lists them and panes top-left first, the way they appear on the desktop.
func mapHerdrSnapshot(s herdrSnapshot) herdrView {
	type paneKey struct{ y, x int }
	layouts := map[string]herdrLayout{}
	pos := map[string]paneKey{}
	sizes := map[string]Size{}
	for _, l := range s.Layouts {
		layouts[l.TabID] = l
		for _, p := range l.Panes {
			pos[p.ID] = paneKey{p.Rect.Y, p.Rect.X}
			sizes[p.ID] = Size{Cols: clampDim(p.Rect.Width), Rows: clampDim(p.Rect.Height)}
		}
	}

	panesByTab := map[string][]Pane{}
	cwds := map[string]string{}
	for _, p := range s.Panes {
		dir := p.ForegroundCwd
		if dir == "" {
			dir = p.Cwd
		}
		if dir = processCwd(dir); dir != "" {
			cwds[p.ID] = dir
		}
		pane := Pane{ID: p.ID, Title: p.Title, Active: layouts[p.TabID].FocusedPaneID == p.ID}
		if p.Agent != nil && *p.Agent != "" {
			status := p.AgentStatus
			if !herdrAgentStatuses[status] {
				status = "unknown"
			}
			pane.Agent = &AgentInfo{Name: *p.Agent, Status: status}
		}
		panesByTab[p.TabID] = append(panesByTab[p.TabID], pane)
	}
	for _, panes := range panesByTab {
		sort.SliceStable(panes, func(i, j int) bool {
			a, b := pos[panes[i].ID], pos[panes[j].ID]
			if a.y != b.y {
				return a.y < b.y
			}
			return a.x < b.x
		})
	}

	// A tab's number is the one it got when created, not its position: a
	// moved tab keeps it. session.snapshot lists them in position order.
	tabsByWS := map[string][]Tab{}
	for _, t := range s.Tabs {
		panes := panesByTab[t.ID]
		if panes == nil {
			panes = []Pane{}
		}
		tabsByWS[t.WorkspaceID] = append(tabsByWS[t.WorkspaceID], Tab{ID: t.ID, Key: t.ID, Name: t.Label, Panes: panes})
	}

	wss := s.Workspaces
	sort.SliceStable(wss, func(i, j int) bool { return wss[i].Number < wss[j].Number })
	groups := make([]Group, 0, len(wss))
	worktrees := map[string]herdrWorktreeRef{}
	for _, w := range wss {
		if w.Worktree != nil && w.Worktree.RepoKey != "" {
			worktrees[w.ID] = herdrWorktreeRef{repoKey: w.Worktree.RepoKey, linked: w.Worktree.IsLinked}
		}
		tabs := tabsByWS[w.ID]
		if tabs == nil {
			tabs = []Tab{}
		}
		for i := range tabs {
			tabs[i].Active = tabs[i].ID == w.ActiveTabID
		}
		groups = append(groups, Group{ID: w.ID, Name: w.Label, Tabs: tabs})
	}
	return herdrView{snap: Snapshot{Groups: groups}, sizes: sizes, cwds: cwds, worktrees: worktrees}
}

func sameKeys(a map[string]bool, b map[string]Size) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range b {
		if !a[k] {
			return false
		}
	}
	return true
}

// subscribeLoop keeps an events.subscribe connection open. While it is down
// the cache is bypassed, so every request fetches a fresh snapshot.
func (m *herdrMux) subscribeLoop(ctx context.Context) {
	backoff := herdrBackoffMin
	var lastErr string
	for ctx.Err() == nil {
		live, err := m.subscribeOnce(ctx)
		m.mu.Lock()
		m.connected = false
		m.mu.Unlock()
		m.invalidate()
		if live {
			backoff = herdrBackoffMin
		}
		if err == nil {
			continue // resubscribing with a new pane set
		}
		if ctx.Err() != nil {
			return
		}
		if msg := err.Error(); msg != lastErr {
			log.Printf("herdr events: %v (retrying up to every %s)", err, herdrBackoffMax)
			lastErr = msg
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, herdrBackoffMax)
	}
}

type herdrSubscription struct {
	Type   string `json:"type"`
	PaneID string `json:"pane_id,omitempty"`
}

type herdrEvent struct {
	Event string `json:"event"`
	Data  struct {
		Layout *herdrLayout `json:"layout"`
	} `json:"data"`
}

// subscribeOnce runs one subscription. live reports whether it got as far as
// receiving events; a nil error means it ended to resubscribe.
func (m *herdrMux) subscribeOnce(ctx context.Context) (live bool, err error) {
	pctx, cancel := context.WithTimeout(ctx, muxTimeout)
	p, err := m.rpc.ping(pctx)
	cancel()
	if err != nil {
		return false, err
	}
	if p.Protocol != herdrProtocol {
		log.Printf("herdr %s speaks protocol %d, termote supports %d; continuing", p.Version, p.Protocol, herdrProtocol)
	}
	m.version.Store(p.Version)

	// The pane set to watch. The cache is bypassed here (not connected), so
	// this is a fresh snapshot.
	vctx, cancel := context.WithTimeout(ctx, muxTimeout)
	v, err := m.view(vctx)
	cancel()
	if err != nil {
		return false, err
	}
	subs := make([]herdrSubscription, 0, len(herdrEventTypes)+len(herdrWorktreeEventTypes)+len(v.sizes))
	for _, t := range herdrEventTypes {
		subs = append(subs, herdrSubscription{Type: t})
	}
	// An older Herdr refuses a type it does not know, and the whole
	// subscription with it.
	if herdrCanWorktrees(p.Version, herdrStartGOOS) {
		for _, t := range herdrWorktreeEventTypes {
			subs = append(subs, herdrSubscription{Type: t})
		}
	}
	panes := map[string]bool{}
	for id := range v.sizes {
		panes[id] = true
		subs = append(subs, herdrSubscription{Type: "pane.agent_status_changed", PaneID: id})
	}

	sctx, cancel := context.WithTimeout(ctx, muxTimeout)
	conn, err := m.rpc.dial(sctx, "events.subscribe", map[string]any{"subscriptions": subs})
	cancel()
	if err != nil {
		return false, err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	r := bufio.NewReaderSize(conn, 64*1024)
	conn.SetReadDeadline(time.Now().Add(muxTimeout))
	ack, err := readHerdrReply(r)
	if err != nil {
		return false, fmt.Errorf("events.subscribe: %w", err)
	}
	if ack.Error != nil {
		return false, ack.Error
	}
	conn.SetReadDeadline(time.Time{})

	m.mu.Lock()
	m.connected = true
	m.subscribed = panes
	m.mu.Unlock()
	// Anything that changed between the snapshot and the ack was missed.
	m.invalidate()

	// Sizes may have changed while no subscription was listening; the view
	// fetched now (the cache was just invalidated) resyncs every stream.
	if _, err := m.view(ctx); err != nil {
		return true, err
	}

	lines := make(chan []byte)
	readErr := make(chan error, 1)
	quit := make(chan struct{})
	defer close(quit)
	go func() {
		for {
			line, err := readHerdrLine(r, herdrMaxReply)
			if err != nil {
				readErr <- err
				return
			}
			select {
			case lines <- line:
			case <-quit:
				return
			}
		}
	}()

	// Set once a resubscription is requested; events keep being handled
	// while a burst of pane changes settles.
	var resubAfter <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return true, ctx.Err()
		case err := <-readErr:
			return true, fmt.Errorf("event stream closed: %w", err)
		case line := <-lines:
			m.invalidate()
			var ev herdrEvent
			if json.Unmarshal(line, &ev) != nil {
				break
			}
			if ev.Data.Layout != nil {
				m.notifySizes(*ev.Data.Layout)
			}
			if strings.HasPrefix(ev.Event, "worktree_") {
				m.branches.drop()
			}
		case <-m.resub:
			if resubAfter == nil {
				resubAfter = time.After(herdrResubscribeDelay)
			}
		case <-resubAfter:
			select {
			case <-m.resub:
			default:
			}
			return true, nil
		}
	}
}

// watchSize registers ch to receive pane's size whenever its layout changes.
func (m *herdrMux) watchSize(pane string, ch chan Size) {
	m.watchMu.Lock()
	defer m.watchMu.Unlock()
	if m.watchers[pane] == nil {
		m.watchers[pane] = map[chan Size]struct{}{}
	}
	m.watchers[pane][ch] = struct{}{}
}

func (m *herdrMux) unwatchSize(pane string, ch chan Size) {
	m.watchMu.Lock()
	defer m.watchMu.Unlock()
	delete(m.watchers[pane], ch)
	if len(m.watchers[pane]) == 0 {
		delete(m.watchers, pane)
	}
}

// notifySizes sends the sizes of a layout_updated event to watching streams.
func (m *herdrMux) notifySizes(l herdrLayout) {
	sizes := make(map[string]Size, len(l.Panes))
	for _, p := range l.Panes {
		sizes[p.ID] = Size{Cols: clampDim(p.Rect.Width), Rows: clampDim(p.Rect.Height)}
	}
	m.notifyPaneSizes(sizes)
}

// notifyPaneSizes sends each watched pane's size, replacing a value the
// stream has not taken yet. Senders hold watchMu and each channel has room
// for one value, so the send after the drain never blocks. A stream ignores a
// size equal to its current one.
func (m *herdrMux) notifyPaneSizes(sizes map[string]Size) {
	m.watchMu.Lock()
	defer m.watchMu.Unlock()
	for pane, chs := range m.watchers {
		size, ok := sizes[pane]
		if !ok {
			continue
		}
		for ch := range chs {
			select {
			case <-ch:
			default:
			}
			ch <- size
		}
	}
}

// SelectTab is not offered: switching tab on the PWA must not change what the
// desktop shows.
func (*herdrMux) SelectTab(context.Context, string) error { return errUnsupported }

func (m *herdrMux) NewTab(ctx context.Context, groupID, name string) (string, error) {
	params := map[string]any{"focus": false}
	if groupID != "" {
		if !herdrWorkspaceIDRe.MatchString(groupID) {
			return "", inputError("invalid group id")
		}
		if err := m.requireGroup(ctx, groupID); err != nil {
			return "", err
		}
		params["workspace_id"] = groupID
	}
	if name != "" {
		if !validateTmuxTarget(name) {
			return "", inputError("invalid tab name")
		}
		params["label"] = name
	}
	var res struct {
		Tab struct {
			ID string `json:"tab_id"`
		} `json:"tab"`
	}
	err := m.rpc.call(ctx, "tab.create", params, &res)
	m.invalidate()
	if err != nil {
		return "", herdrInputError(err)
	}
	return res.Tab.ID, nil
}

// CloseTab closes a tab. A Herdr tab id never changes, so it is its key: a
// key naming another tab is a client mistaking one for the other.
func (m *herdrMux) CloseTab(ctx context.Context, tabID, key string) error {
	if key != "" && key != tabID {
		return errTabChanged
	}
	if err := m.requireTab(ctx, tabID); err != nil {
		return err
	}
	err := m.rpc.call(ctx, "tab.close", map[string]string{"tab_id": tabID}, nil)
	m.invalidate()
	return herdrInputError(err)
}

func (m *herdrMux) RenameTab(ctx context.Context, tabID, name, key string) error {
	if key != "" && key != tabID {
		return errTabChanged
	}
	if name == "" {
		return inputError("name is required")
	}
	if !validateTmuxTarget(name) {
		return inputError("invalid tab name")
	}
	if err := m.requireTab(ctx, tabID); err != nil {
		return err
	}
	err := m.rpc.call(ctx, "tab.rename", map[string]string{"tab_id": tabID, "label": name}, nil)
	m.invalidate()
	return herdrInputError(err)
}

// MoveTab moves a tab within its workspace through tab.move, whose
// insert_index is a gap in the list before the tab is taken out. The order
// is read fresh: the cached view can be 30 s old. The id never changes.
func (m *herdrMux) MoveTab(ctx context.Context, tabID string, index int) (string, error) {
	if !m.Caps().ReorderTabs {
		return "", errUnsupported
	}
	if !herdrTabIDRe.MatchString(tabID) {
		return "", errInvalidTabID
	}
	m.invalidate()
	v, err := m.view(ctx)
	if err != nil {
		return "", err
	}
	src, n := -1, 0
	for _, g := range v.snap.Groups {
		for i, t := range g.Tabs {
			if t.ID == tabID {
				src, n = i, len(g.Tabs)
			}
		}
	}
	switch {
	case src < 0:
		return "", errUnknownTab
	case index >= n:
		return "", errInvalidIndex
	case index == src:
		return tabID, nil
	}
	insert := index
	if index > src {
		insert = index + 1
	}
	err = m.rpc.call(ctx, "tab.move", map[string]any{"tab_id": tabID, "insert_index": insert}, nil)
	m.invalidate()
	if err != nil {
		return "", herdrMoveError(err, "tab.move")
	}
	return tabID, nil
}

// MoveGroup moves a workspace through workspace.move_block, as Herdr's own
// sidebar drag does: a linked worktree cannot move, and any other workspace
// takes with it every workspace of its repository, packed after it. index
// is the position among the workspaces that can move (not linked).
func (m *herdrMux) MoveGroup(ctx context.Context, groupID string, index int) error {
	if !m.Caps().ReorderGroups {
		return errUnsupported
	}
	if !herdrWorkspaceIDRe.MatchString(groupID) {
		return errInvalidGroupID
	}
	m.invalidate()
	v, err := m.view(ctx)
	if err != nil {
		return err
	}
	ids, block, rest, pos, err := herdrMovePlan(v, groupID, index)
	if err != nil {
		return err
	}
	// Its own place: nothing to do, unless its block is scattered, which
	// the call packs.
	if pos == index && contiguous(ids, block) {
		return nil
	}
	params := map[string]any{"workspace_ids": block}
	if index < len(rest) {
		params["before_workspace_id"] = rest[index]
	}
	err = m.rpc.call(ctx, "workspace.move_block", params, nil)
	m.invalidate()
	if err != nil {
		return herdrMoveError(err, "workspace.move_block")
	}
	return nil
}

// herdrMovePlan reads what a workspace move needs from v: every workspace id
// in order, the block that moves (groupID, then the other workspaces of its
// repository in order), the workspaces that can move outside the block, and
// groupID's position among those that can move.
func herdrMovePlan(v herdrView, groupID string, index int) (ids, block, rest []string, pos int, err error) {
	ref := v.worktrees[groupID]
	pos, movable := -1, 0
	for _, g := range v.snap.Groups {
		ids = append(ids, g.ID)
		if g.ID == groupID {
			pos = movable
		}
		if !v.worktrees[g.ID].linked {
			movable++
		}
	}
	switch {
	case pos < 0:
		return nil, nil, nil, 0, errUnknownGroup
	case ref.linked:
		return nil, nil, nil, 0, errLinkedWorktree
	case index >= movable:
		return nil, nil, nil, 0, errInvalidIndex
	}
	block = []string{groupID}
	inBlock := map[string]bool{groupID: true}
	for _, id := range ids {
		if id != groupID && ref.repoKey != "" && v.worktrees[id].repoKey == ref.repoKey {
			block = append(block, id)
			inBlock[id] = true
		}
	}
	for _, id := range ids {
		if !inBlock[id] && !v.worktrees[id].linked {
			rest = append(rest, id)
		}
	}
	return ids, block, rest, pos, nil
}

// contiguous reports whether block sits in ids as one run, in its order.
func contiguous(ids, block []string) bool {
	i := slices.Index(ids, block[0])
	return i+len(block) <= len(ids) && slices.Equal(ids[i:i+len(block)], block)
}

// herdrMoveError maps Herdr's replies to tab.move and workspace.move_block.
// The item was found just before the call, so a not-found or out-of-range
// reply means the list changed meanwhile. Anything else is a plain error:
// the route logs Herdr's message and never returns it.
func herdrMoveError(err error, method string) error {
	var he *herdrError
	if !errors.As(err, &he) {
		return err
	}
	switch he.Code {
	case "tab_not_found":
		return errUnknownTab
	case "tab_move_failed", "workspace_not_found":
		return errInvalidIndex
	case "unknown_method":
		return errUnsupported
	case "invalid_request":
		if strings.Contains(he.Message, "`"+method+"`") {
			return errUnsupported
		}
	}
	return err
}

// NewGroup creates a workspace in the background (focus: false, so the
// desktop keeps showing what it showed), with the cwd already checked.
func (m *herdrMux) NewGroup(ctx context.Context, name, cwd string) (string, error) {
	if !validateTmuxTarget(name) {
		return "", errInvalidGroupName
	}
	params := map[string]any{"label": name, "focus": false}
	if cwd != "" {
		params["cwd"] = cwd
	}
	var res struct {
		Workspace struct {
			ID string `json:"workspace_id"`
		} `json:"workspace"`
	}
	err := m.rpc.call(ctx, "workspace.create", params, &res)
	m.invalidate()
	if err != nil {
		return "", herdrGroupError(err)
	}
	if !herdrWorkspaceIDRe.MatchString(res.Workspace.ID) {
		return "", fmt.Errorf("workspace.create returned workspace id %q", res.Workspace.ID)
	}
	return res.Workspace.ID, nil
}

// CloseGroup closes one workspace. A workspace with linked worktrees is left
// to Herdr (close_group is never sent): closing it would close them too.
// Herdr keeps running with no workspace left, so the last one may go.
func (m *herdrMux) CloseGroup(ctx context.Context, groupID string) error {
	if err := m.requireGroupCoded(ctx, groupID); err != nil {
		return err
	}
	err := m.rpc.call(ctx, "workspace.close", map[string]string{"workspace_id": groupID}, nil)
	m.invalidate()
	return herdrGroupError(err)
}

func (m *herdrMux) RenameGroup(ctx context.Context, groupID, name string) error {
	if !validateTmuxTarget(name) {
		return errInvalidGroupName
	}
	if err := m.requireGroupCoded(ctx, groupID); err != nil {
		return err
	}
	err := m.rpc.call(ctx, "workspace.rename", map[string]string{"workspace_id": groupID, "label": name}, nil)
	m.invalidate()
	return herdrGroupError(err)
}

// requireGroupCoded is requireGroup for the group routes, whose errors carry
// a code.
func (m *herdrMux) requireGroupCoded(ctx context.Context, id string) error {
	if !herdrWorkspaceIDRe.MatchString(id) {
		return errInvalidGroupID
	}
	err := m.requireGroup(ctx, id)
	var ie inputError
	if errors.As(err, &ie) {
		return errUnknownGroup
	}
	return err
}

// herdrGroupError maps Herdr's replies to a workspace call: the workspace
// gone between the check and the call, linked worktrees, a Herdr without
// the method.
func herdrGroupError(err error) error {
	var he *herdrError
	if !errors.As(err, &he) {
		return err
	}
	switch he.Code {
	case "workspace_not_found":
		return errUnknownGroup
	case "workspace_group_close_required":
		return errHasWorktrees
	case "unknown_method":
		return errUnsupported
	}
	return herdrInputError(err)
}

// ValidGroupID: a workspace id.
func (*herdrMux) ValidGroupID(id string) bool { return herdrWorkspaceIDRe.MatchString(id) }

// herdrWorktreeInfo is a worktree as worktree.list and its events report it.
type herdrWorktreeInfo struct {
	Path            string `json:"path"`
	Branch          string `json:"branch"`
	IsBare          bool   `json:"is_bare"`
	IsDetached      bool   `json:"is_detached"`
	IsPrunable      bool   `json:"is_prunable"`
	IsLinked        bool   `json:"is_linked_worktree"`
	OpenWorkspaceID string `json:"open_workspace_id"`
}

// herdrWorktreeList is worktree.list's result.
type herdrWorktreeList struct {
	Source struct {
		RepoKey  string `json:"repo_key"`
		RepoName string `json:"repo_name"`
		RepoRoot string `json:"repo_root"`
	} `json:"source"`
	Worktrees []herdrWorktreeInfo `json:"worktrees"`
}

// listWorktrees calls worktree.list with sourceID as the source. It changes
// nothing in Herdr.
func (m *herdrMux) listWorktrees(ctx context.Context, sourceID string) (herdrWorktreeList, error) {
	var res herdrWorktreeList
	err := m.rpc.call(ctx, "worktree.list", map[string]string{"workspace_id": sourceID}, &res)
	return res, err
}

// ListWorktrees lists the worktrees of the source's repository. A branch
// name validBranchName refuses is dropped, so the entry cannot be opened by
// it nor shown under it.
func (m *herdrMux) ListWorktrees(ctx context.Context, sourceID string) (WorktreeList, error) {
	if err := m.requireGroupCoded(ctx, sourceID); err != nil {
		return WorktreeList{}, err
	}
	res, err := m.listWorktrees(ctx, sourceID)
	if err != nil {
		return WorktreeList{}, herdrWorktreeError(err)
	}
	out := WorktreeList{RepoName: res.Source.RepoName, RepoRoot: res.Source.RepoRoot, Worktrees: []Worktree{}}
	for _, w := range res.Worktrees {
		branch := w.Branch
		if !validBranchName(branch) {
			branch = ""
		}
		group := w.OpenWorkspaceID
		if !herdrWorkspaceIDRe.MatchString(group) {
			group = ""
		}
		out.Worktrees = append(out.Worktrees, Worktree{
			Path: w.Path, Branch: branch, Linked: w.IsLinked, GroupID: group,
			Openable: w.IsLinked && branch != "" && !w.IsBare && !w.IsPrunable && !w.IsDetached,
		})
	}
	return out, nil
}

// worktreeBranches maps each workspace showing a worktree of the source's
// repository to its branch (the branch cache's fetch).
func (m *herdrMux) worktreeBranches(ctx context.Context, sourceID string) (map[string]string, error) {
	res, err := m.listWorktrees(ctx, sourceID)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, w := range res.Worktrees {
		if herdrWorkspaceIDRe.MatchString(w.OpenWorkspaceID) && validBranchName(w.Branch) {
			out[w.OpenWorkspaceID] = w.Branch
		}
	}
	return out, nil
}

// CreateWorktree asks Herdr for a worktree of branch in the background
// (focus: false). Herdr picks the path; trust_repository and path are never
// sent. An empty base or label is left out.
func (m *herdrMux) CreateWorktree(ctx context.Context, sourceID, branch, base, label string) (string, error) {
	if err := m.requireGroupCoded(ctx, sourceID); err != nil {
		return "", err
	}
	params := map[string]any{"workspace_id": sourceID, "branch": branch, "focus": false}
	if base != "" {
		params["base"] = base
	}
	if label != "" {
		params["label"] = label
	}
	var res struct {
		Workspace struct {
			ID string `json:"workspace_id"`
		} `json:"workspace"`
	}
	err := m.rpc.call(ctx, "worktree.create", params, &res)
	m.worktreesChanged()
	if err != nil {
		return "", herdrWorktreeError(err)
	}
	if !herdrWorkspaceIDRe.MatchString(res.Workspace.ID) {
		return "", fmt.Errorf("worktree.create returned workspace id %q", res.Workspace.ID)
	}
	return res.Workspace.ID, nil
}

// OpenWorktree opens the existing worktree of branch in the background.
func (m *herdrMux) OpenWorktree(ctx context.Context, sourceID, branch string) (string, bool, error) {
	if err := m.requireGroupCoded(ctx, sourceID); err != nil {
		return "", false, err
	}
	var res struct {
		Workspace struct {
			ID string `json:"workspace_id"`
		} `json:"workspace"`
		AlreadyOpen bool `json:"already_open"`
	}
	err := m.rpc.call(ctx, "worktree.open", map[string]any{"workspace_id": sourceID, "branch": branch, "focus": false}, &res)
	m.worktreesChanged()
	if err != nil {
		return "", false, herdrWorktreeError(err)
	}
	if !herdrWorkspaceIDRe.MatchString(res.Workspace.ID) {
		return "", false, fmt.Errorf("worktree.open returned workspace id %q", res.Workspace.ID)
	}
	return res.Workspace.ID, res.AlreadyOpen, nil
}

// RemoveWorktree removes a linked worktree workspace: Herdr deletes the
// checkout (with force, after ending its panes) and closes the workspace.
// close_group is never sent; force only when true.
func (m *herdrMux) RemoveWorktree(ctx context.Context, groupID string, force bool) error {
	if err := m.requireGroupCoded(ctx, groupID); err != nil {
		return err
	}
	params := map[string]any{"workspace_id": groupID}
	if force {
		params["force"] = true
	}
	err := m.rpc.call(ctx, "worktree.remove", params, nil)
	m.worktreesChanged()
	return herdrWorktreeError(err)
}

// worktreesChanged drops what a worktree change made stale.
func (m *herdrMux) worktreesChanged() {
	m.invalidate()
	m.branches.drop()
}

// herdrWorktreeError maps Herdr's replies to a worktree call to the routes'
// codes. Its message (often git's, with paths) is logged by the route.
func herdrWorktreeError(err error) error {
	var he *herdrError
	if !errors.As(err, &he) {
		return err
	}
	coded := map[string]error{
		"workspace_not_found":            errUnknownGroup,
		"worktree_not_found":             errWorktreeNotFound,
		"not_git_worktree":               errWorktreeNotGit,
		"linked_worktree_source":         errWorktreeLinkedSource,
		"not_linked_worktree":            errWorktreeNotLinked,
		"ambiguous_worktree_branch":      errWorktreeAmbiguous,
		"worktree_create_failed":         errWorktreeCreateFailed,
		"worktree_open_failed":           errWorktreeOpenFailed,
		"dirty_worktree_requires_force":  errWorktreeDirty,
		"worktree_operation_in_progress": errWorktreeBusy,
		"stale_worktree_operation":       errWorktreeBusy,
		"worktree_busy":                  errWorktreeBusy,
		"unknown_method":                 errWorktreeUnsupported,
	}
	if c, ok := coded[he.Code]; ok {
		if c != errUnknownGroup && c != errWorktreeUnsupported {
			log.Printf("herdr %s: %s", he.Code, he.Message)
		}
		return c
	}
	if he.Code == "invalid_request" && strings.Contains(he.Message, "`worktree.") {
		return errWorktreeUnsupported
	}
	return err
}

func (m *herdrMux) ClosePane(ctx context.Context, paneID string) error {
	if _, err := m.requirePane(ctx, paneID); err != nil {
		return err
	}
	err := m.rpc.call(ctx, "pane.close", map[string]string{"pane_id": paneID}, nil)
	m.invalidate()
	return herdrInputError(err)
}

// SendKeys types keys as raw bytes, the same way stream input is sent, and
// waits until herdr has accepted them.
func (m *herdrMux) SendKeys(ctx context.Context, paneID, keys string) error {
	if _, err := m.requirePane(ctx, paneID); err != nil {
		return err
	}
	if keys == "" {
		return nil
	}
	return m.typeInput(ctx, paneID, keys)
}

// PaneDir reads the pane's directory from pane.get: the foreground process's
// directory, else the shell's. A herdr that reports neither is too old.
func (m *herdrMux) PaneDir(ctx context.Context, paneID string) (string, string, error) {
	if !herdrPaneIDRe.MatchString(paneID) {
		return "", "", inputError("invalid pane id")
	}
	var res struct {
		Pane struct {
			Cwd           string `json:"cwd"`
			ForegroundCwd string `json:"foreground_cwd"`
		} `json:"pane"`
	}
	if err := m.rpc.call(ctx, "pane.get", map[string]string{"pane_id": paneID}, &res); err != nil {
		return "", "", herdrInputError(err)
	}
	dir := res.Pane.ForegroundCwd
	if dir == "" {
		dir = res.Pane.Cwd
	}
	if dir == "" {
		return "", "", errUnsupported
	}
	return dir, paneID, nil
}

// AgentSessionNow is AgentSession: pane.get is never cached.
func (m *herdrMux) AgentSessionNow(ctx context.Context, paneID string) (AgentSession, bool, error) {
	return m.AgentSession(ctx, paneID)
}

// Capture reads the pane's visible screen with SGR attributes.
func (m *herdrMux) Capture(ctx context.Context, target string) (string, error) {
	if !herdrPaneIDRe.MatchString(target) {
		return "", inputError("invalid pane id")
	}
	var res struct {
		Read struct {
			Text string `json:"text"`
		} `json:"read"`
	}
	err := m.rpc.call(ctx, "pane.read", map[string]string{"pane_id": target, "source": "visible", "format": "ansi"}, &res)
	return res.Read.Text, herdrInputError(err)
}

// Paste queues the whole bracketed paste as one input, so nothing typed by a
// stream can land inside it.
func (m *herdrMux) Paste(ctx context.Context, target, text string) error {
	if _, err := m.requirePane(ctx, target); err != nil {
		return err
	}
	return m.typeInput(ctx, target, "\x1b[200~"+text+"\x1b[201~")
}

// SendKeySequence types the keys' bytes in one input.
func (m *herdrMux) SendKeySequence(ctx context.Context, target string, keys []string) error {
	if !validAgentKeys(keys) {
		return inputError("invalid keys")
	}
	if _, err := m.requirePane(ctx, target); err != nil {
		return err
	}
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(agentKeys[k])
	}
	return m.typeInput(ctx, target, b.String())
}

// herdrScroll is a pane's scroll position in rows above the live screen.
type herdrScroll struct {
	Offset uint64 `json:"offset_from_bottom"`
	Max    uint64 `json:"max_offset_from_bottom"`
}

// maxWheelEvents caps the wheel reports one Scroll sends to a program.
const maxWheelEvents = 50

// herdrJumpToBottom is the key that returns an agent's own view to its live
// screen, where wheel reports would need an unknown number of rows (Claude
// Code accelerates the wheel).
var herdrJumpToBottom = map[string]string{
	"claude": "\x1b[1;5F", // Ctrl+End
}

// Scroll moves the pane's shared view, the one every herdr client and observer
// renders: observe only sends screen frames, so its history never reaches the
// client's own scrollback. herdr sets an absolute offset, so the current one
// is read first; scrollMu keeps two requests from reading the same offset.
//
// An agent with no history in herdr (Claude Code's fullscreen mode) draws on
// the alternate screen and keeps its history itself; it gets one wheel report
// per row instead, the way a terminal passes the wheel on, and scrolling down
// by the whole limit (back to the live screen) sends the agent's jump key when
// it has one. A plain shell never gets them, since it would echo them at its
// prompt.
func (m *herdrMux) Scroll(ctx context.Context, paneID string, lines int) error {
	size, err := m.requirePane(ctx, paneID)
	if err != nil {
		return err
	}
	if lines == 0 {
		return nil
	}
	m.scrollMu.Lock()
	defer m.scrollMu.Unlock()
	var res struct {
		Pane struct {
			Agent  string      `json:"agent"`
			Scroll herdrScroll `json:"scroll"`
		} `json:"pane"`
	}
	if err := m.rpc.call(ctx, "pane.get", map[string]string{"pane_id": paneID}, &res); err != nil {
		return herdrInputError(err)
	}
	cur := res.Pane.Scroll
	if cur.Max == 0 && res.Pane.Agent != "" {
		if key, ok := herdrJumpToBottom[res.Pane.Agent]; ok && lines <= -maxScrollLines {
			return m.typeInput(ctx, paneID, key)
		}
		return m.sendWheel(ctx, paneID, size, lines)
	}
	next := int64(cur.Offset) + int64(lines)
	next = max(0, min(next, int64(cur.Max)))
	if uint64(next) == cur.Offset {
		return nil
	}
	err = m.rpc.call(ctx, "pane.scroll", map[string]any{"pane_id": paneID, "offset_from_bottom": next}, nil)
	return herdrInputError(err)
}

// ReadText reads the pane's recent lines as herdr keeps them unwrapped
// (history and screen). An older herdr without that source answers
// invalid_request: the parameters are the server's own, so that can only
// mean it lacks the source. more: the pane's history rows (pane.get) pass
// lines.
func (m *herdrMux) ReadText(ctx context.Context, paneID string, lines int, w io.Writer) (bool, error) {
	if _, err := m.requirePane(ctx, paneID); err != nil {
		return false, err
	}
	var info struct {
		Pane struct {
			Scroll herdrScroll `json:"scroll"`
		} `json:"pane"`
	}
	if err := m.rpc.call(ctx, "pane.get", map[string]string{"pane_id": paneID}, &info); err != nil {
		return false, herdrInputError(err)
	}
	var res struct {
		Read struct {
			Text string `json:"text"`
		} `json:"read"`
	}
	err := m.rpc.call(ctx, "pane.read", map[string]any{"pane_id": paneID, "source": "recent_unwrapped", "lines": lines, "format": "text"}, &res)
	var he *herdrError
	if errors.As(err, &he) && he.Code == "invalid_request" {
		log.Printf("herdr pane.read recent_unwrapped: %s", he.Message)
		return false, errUnsupported
	}
	if err != nil {
		return false, herdrInputError(err)
	}
	if _, err := io.WriteString(w, res.Read.Text); err != nil {
		return false, err
	}
	return info.Pane.Scroll.Max > uint64(lines), nil
}

// sendWheel types SGR wheel reports (button 64 up, 65 down) at the middle of
// the pane, through the pane's input queue so they keep their place among
// keystrokes.
func (m *herdrMux) sendWheel(ctx context.Context, paneID string, size Size, lines int) error {
	button := 64
	if lines < 0 {
		button, lines = 65, -lines
	}
	report := fmt.Sprintf("\x1b[<%d;%d;%dM", button, max(1, size.Cols/2), max(1, size.Rows/2))
	return m.typeInput(ctx, paneID, strings.Repeat(report, min(lines, maxWheelEvents)))
}

// typeInput queues input for the pane and waits until herdr has accepted it.
func (m *herdrMux) typeInput(ctx context.Context, paneID, input string) error {
	done, err := m.writer(paneID).enqueue([]byte(input))
	if err != nil {
		return err
	}
	select {
	case err := <-done:
		return herdrInputError(err)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *herdrMux) requireGroup(ctx context.Context, id string) error {
	v, err := m.view(ctx)
	if err != nil {
		return err
	}
	for _, g := range v.snap.Groups {
		if g.ID == id {
			return nil
		}
	}
	return inputError("unknown group")
}

func (m *herdrMux) requireTab(ctx context.Context, id string) error {
	if !herdrTabIDRe.MatchString(id) {
		return inputError("invalid tab id")
	}
	v, err := m.view(ctx)
	if err != nil {
		return err
	}
	for _, g := range v.snap.Groups {
		for _, t := range g.Tabs {
			if t.ID == id {
				return nil
			}
		}
	}
	return inputError("unknown tab")
}

// requirePane validates a pane ID and returns the pane's current size.
func (m *herdrMux) requirePane(ctx context.Context, id string) (Size, error) {
	if !herdrPaneIDRe.MatchString(id) {
		return Size{}, inputError("invalid pane id")
	}
	v, err := m.view(ctx)
	if err != nil {
		return Size{}, err
	}
	size, ok := v.sizes[id]
	if !ok {
		return Size{}, inputError("unknown pane")
	}
	return size, nil
}

// herdrInputError turns herdr's "not found" replies (the target vanished
// between the check and the call) into client errors.
func herdrInputError(err error) error {
	var he *herdrError
	if errors.As(err, &he) && strings.HasSuffix(he.Code, "_not_found") {
		return inputError(strings.ReplaceAll(he.Code, "_", " "))
	}
	return err
}

// pruneWriters forgets idle writers of panes that no longer exist.
func (m *herdrMux) pruneWriters(panes map[string]Size) {
	m.writersMu.Lock()
	defer m.writersMu.Unlock()
	for id, w := range m.writers {
		if _, ok := panes[id]; ok {
			continue
		}
		w.mu.Lock()
		idle := !w.running
		w.mu.Unlock()
		if idle {
			delete(m.writers, id)
		}
	}
}

func (m *herdrMux) writer(pane string) *paneWriter {
	m.writersMu.Lock()
	defer m.writersMu.Unlock()
	w := m.writers[pane]
	if w == nil {
		w = &paneWriter{rpc: m.rpc, pane: pane}
		m.writers[pane] = w
	}
	return w
}

// paneWriter sends input to one pane strictly in order: concurrent
// pane.send_text calls can be applied out of order (measured 59 of 300).
// Input queued while a call is in flight is merged into the next one.
type paneWriter struct {
	rpc  *herdrRPC
	pane string

	mu      sync.Mutex
	pending []byte
	waiters []chan error
	running bool
}

// enqueue queues p and returns a channel that receives the result of the call
// that carries it.
func (w *paneWriter) enqueue(p []byte) (<-chan error, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.pending)+len(p) > herdrMaxQueuedInput {
		return nil, errors.New("herdr input queue full")
	}
	w.pending = append(w.pending, p...)
	ch := make(chan error, 1)
	w.waiters = append(w.waiters, ch)
	if !w.running {
		w.running = true
		go w.run()
	}
	return ch, nil
}

func (w *paneWriter) run() {
	for {
		w.mu.Lock()
		if len(w.pending) == 0 {
			w.running = false
			w.mu.Unlock()
			return
		}
		batch, waiters := w.pending, w.waiters
		w.pending, w.waiters = nil, nil
		w.mu.Unlock()

		var err error
		for _, chunk := range splitUTF8(batch, herdrTextChunk) {
			ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
			err = w.rpc.call(ctx, "pane.send_text", map[string]string{"pane_id": w.pane, "text": string(chunk)}, nil)
			cancel()
			if err != nil {
				log.Printf("herdr send_text %s: %v", w.pane, err)
				break
			}
		}
		for _, ch := range waiters {
			ch <- err
		}
	}
}

// splitUTF8 cuts b into chunks of at most max bytes without splitting a rune.
func splitUTF8(b []byte, max int) [][]byte {
	var out [][]byte
	for len(b) > max {
		i := max
		for i > 0 && !utf8.RuneStart(b[i]) {
			i--
		}
		if i == 0 {
			i = max // not UTF-8 at all; json.Marshal will replace it anyway
		}
		out = append(out, b[:i])
		b = b[i:]
	}
	if len(b) > 0 {
		out = append(out, b)
	}
	return out
}

// StartAgent starts kind in a pane that shows only its shell: it waits for
// a shell still starting, refuses while Herdr holds an earlier start there
// (launchPending), clears the input line with C-c (half-typed text,
// a continuation prompt, a heredoc or a read would otherwise take the
// command), checks the shell again, then asks Herdr (agent.start) to type
// the command line. A refusal from Herdr itself comes after the C-c.
func (m *herdrMux) StartAgent(ctx context.Context, paneID, kind string, args []string) (string, error) {
	idle, err := m.waitIdleShell(ctx, paneID, agentStartIdleWait)
	if err != nil || !idle {
		return "", cmp.Or(err, error(errStartPaneBusy))
	}
	var pending bool
	if err := m.callStep(ctx, func(ctx context.Context) (err error) {
		pending, err = m.launchPending(ctx, paneID)
		return err
	}); err != nil || pending {
		return "", cmp.Or(err, error(errStartPending))
	}
	if err := m.callStep(ctx, func(ctx context.Context) error { return m.typeInput(ctx, paneID, agentKeys["C-c"]) }); err != nil {
		return "", err
	}
	select {
	case <-time.After(agentStartClearWait):
	case <-ctx.Done():
		return "", ctx.Err()
	}
	// The shell redraws its prompt after the C-c, and a prompt can run a
	// program (git for the branch): on Windows that child reads as busy for
	// a moment, so the check waits as the first one does.
	if idle, err = m.waitIdleShell(ctx, paneID, agentStartIdleWait); err != nil || !idle {
		return "", cmp.Or(err, error(errStartPaneBusy))
	}
	if args == nil {
		args = []string{}
	}
	name := agentStartName(kind)
	for retried := false; ; retried = true {
		err = m.callStep(ctx, func(ctx context.Context) error {
			return m.rpc.call(ctx, "agent.start", map[string]any{
				"pane_id": paneID, "kind": kind, "name": name, "args": args,
				"timeout_ms": agentStartTimeout.Milliseconds(),
			}, nil)
		})
		var he *herdrError
		if !retried && errors.As(err, &he) && he.Code == "agent_name_taken" {
			name = agentStartName(kind)
			continue
		}
		break
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return name, errStartUnknown
	}
	return name, herdrStartError(err)
}

// callStep runs one backend call of a start with its own timeout.
func (m *herdrMux) callStep(ctx context.Context, call func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(ctx, agentStartCallTimeout)
	defer cancel()
	return call(ctx)
}

// waitIdleShell reads whether the pane shows only its shell, again every
// agentStartIdlePoll for up to wait while it does not.
func (m *herdrMux) waitIdleShell(ctx context.Context, paneID string, wait time.Duration) (bool, error) {
	deadline := time.Now().Add(wait)
	for {
		var idle bool
		err := m.callStep(ctx, func(ctx context.Context) (err error) {
			idle, err = m.paneIdleShell(ctx, paneID)
			return err
		})
		if err != nil || idle || !time.Now().Add(agentStartIdlePoll).Before(deadline) {
			return idle, herdrStartError(err)
		}
		select {
		case <-time.After(agentStartIdlePoll):
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}
}

// herdrStartError maps Herdr's replies to a start. A Herdr without
// agent.start answers invalid_request naming the method.
func herdrStartError(err error) error {
	var he *herdrError
	if !errors.As(err, &he) {
		return err
	}
	switch {
	case he.Code == "agent_pane_busy":
		return errStartPaneBusy
	case he.Code == "agent_pane_unavailable" || strings.HasSuffix(he.Code, "_not_found"):
		return errStartNotFound
	case he.Code == "unsupported_agent_kind" || he.Code == "unknown_method" ||
		he.Code == "invalid_request" && strings.Contains(he.Message, "`agent.start`"):
		return errStartUnsupported
	}
	return err
}

// launchPending reads whether Herdr holds a start in the pane (agent.get on
// the pane id). Herdr keeps a launch pending until its deadline even when
// the command ended at once, refusing another start meanwhile, and lets an
// expired one go only when it is read: this read does that too.
func (m *herdrMux) launchPending(ctx context.Context, paneID string) (bool, error) {
	var res struct {
		Agent *struct {
			LaunchPending    bool `json:"launch_pending"`
			InteractiveReady bool `json:"interactive_ready"`
		} `json:"agent"`
	}
	err := m.rpc.call(ctx, "agent.get", map[string]string{"target": paneID}, &res)
	var he *herdrError
	if errors.As(err, &he) && strings.HasSuffix(he.Code, "_not_found") {
		return false, nil // no agent and no start in the pane
	}
	if err != nil {
		return false, err
	}
	return res.Agent != nil && res.Agent.LaunchPending && !res.Agent.InteractiveReady, nil
}

// AgentStartState reads a started agent by its alias (agent.get). Herdr
// drops the alias when the agent exits, another agent takes the pane or the
// startup deadline passes; a command that ended before any agent was seen
// is told by the pane showing only its shell again.
func (m *herdrMux) AgentStartState(ctx context.Context, paneID, name, kind string, elapsed time.Duration) (string, error) {
	var res struct {
		Agent struct {
			Agent            *string `json:"agent"`
			Name             *string `json:"name"`
			AgentStatus      string  `json:"agent_status"`
			LaunchPending    bool    `json:"launch_pending"`
			InteractiveReady bool    `json:"interactive_ready"`
		} `json:"agent"`
	}
	err := m.rpc.call(ctx, "agent.get", map[string]string{"target": name}, &res)
	var he *herdrError
	if errors.As(err, &he) && strings.HasSuffix(he.Code, "_not_found") {
		return startExited, nil
	}
	if err != nil {
		return "", err
	}
	a := res.Agent
	switch {
	case a.Name != nil && *a.Name != name, a.Agent != nil && *a.Agent != "" && *a.Agent != kind:
		return startExited, nil
	case a.InteractiveReady:
		return startReady, nil
	case a.AgentStatus == "blocked":
		return startBlocked, nil
	case !a.LaunchPending:
		return startExited, nil
	case elapsed >= agentStartSettle && (a.Agent == nil || *a.Agent == ""):
		idle, err := m.paneIdleShell(ctx, paneID)
		var ie inputError
		if errors.As(err, &ie) {
			return startExited, nil // the pane is gone
		}
		if err != nil {
			return "", err
		}
		if idle {
			return startExited, nil
		}
	}
	return startStarting, nil
}
