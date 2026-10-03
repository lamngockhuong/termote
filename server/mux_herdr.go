package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"
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
}

// herdrView is a mapped snapshot plus the pane sizes streams need.
type herdrView struct {
	snap  Snapshot
	sizes map[string]Size
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
	}
	go m.subscribeLoop(ctx)
	return m, nil
}

func (*herdrMux) Name() string { return "herdr" }

// herdrCodexSession is findCodexSession; tests replace it.
var herdrCodexSession = findCodexSession

func (*herdrMux) Caps() Caps {
	return Caps{ClientSideSelect: true, Scroll: true, DriveSize: true, AgentChat: true, Files: true}
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

func (m *herdrMux) Snapshot(ctx context.Context) (Snapshot, error) {
	v, err := m.view(ctx)
	return v.snap, err
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
	} `json:"workspaces"`
	Tabs []struct {
		ID          string `json:"tab_id"`
		WorkspaceID string `json:"workspace_id"`
		Number      int    `json:"number"`
		Label       string `json:"label"`
	} `json:"tabs"`
	Panes []struct {
		ID          string  `json:"pane_id"`
		TabID       string  `json:"tab_id"`
		Title       string  `json:"terminal_title_stripped"`
		Agent       *string `json:"agent"`
		AgentStatus string  `json:"agent_status"`
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

// mapHerdrSnapshot orders workspaces and tabs by their herdr number and panes
// top-left first, the way they appear on the desktop.
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
	for _, p := range s.Panes {
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

	tabs := s.Tabs
	sort.SliceStable(tabs, func(i, j int) bool { return tabs[i].Number < tabs[j].Number })
	tabsByWS := map[string][]Tab{}
	for _, t := range tabs {
		panes := panesByTab[t.ID]
		if panes == nil {
			panes = []Pane{}
		}
		tabsByWS[t.WorkspaceID] = append(tabsByWS[t.WorkspaceID], Tab{ID: t.ID, Name: t.Label, Panes: panes})
	}

	wss := s.Workspaces
	sort.SliceStable(wss, func(i, j int) bool { return wss[i].Number < wss[j].Number })
	groups := make([]Group, 0, len(wss))
	for _, w := range wss {
		tabs := tabsByWS[w.ID]
		if tabs == nil {
			tabs = []Tab{}
		}
		for i := range tabs {
			tabs[i].Active = tabs[i].ID == w.ActiveTabID
		}
		groups = append(groups, Group{ID: w.ID, Name: w.Label, Tabs: tabs})
	}
	return herdrView{snap: Snapshot{Groups: groups}, sizes: sizes}
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

	// The pane set to watch. The cache is bypassed here (not connected), so
	// this is a fresh snapshot.
	vctx, cancel := context.WithTimeout(ctx, muxTimeout)
	v, err := m.view(vctx)
	cancel()
	if err != nil {
		return false, err
	}
	subs := make([]herdrSubscription, 0, len(herdrEventTypes)+len(v.sizes))
	for _, t := range herdrEventTypes {
		subs = append(subs, herdrSubscription{Type: t})
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
			if json.Unmarshal(line, &ev) == nil && ev.Data.Layout != nil {
				m.notifySizes(*ev.Data.Layout)
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

func (m *herdrMux) CloseTab(ctx context.Context, tabID string) error {
	if err := m.requireTab(ctx, tabID); err != nil {
		return err
	}
	err := m.rpc.call(ctx, "tab.close", map[string]string{"tab_id": tabID}, nil)
	m.invalidate()
	return herdrInputError(err)
}

func (m *herdrMux) RenameTab(ctx context.Context, tabID, name string) error {
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
