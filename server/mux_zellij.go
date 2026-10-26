package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// zellijMux drives every Zellij session of the server's user: a session is
// a group, a Zellij tab a tab, and each terminal pane (plugin panes left
// out) a pane. Tabs are per client in Zellij, so the PWA selects them on its
// own (ClientSideSelect) and each full stream is a Termote client placed on
// its pane (zellij_client.go).
type zellijMux struct {
	mu      sync.Mutex
	slots   map[string]chan struct{}   // session → positioning slot
	clients map[string][]*zellijClient // session → Termote's clients
	// departed: clients Termote closed, by session and id, until the
	// session no longer lists them.
	departed map[string]map[string]time.Time
	reads    map[string]zellijRead   // session → last good read
	tabKeys  map[zellijTabRef]string // a tab's Key while its id lives
	skipped  map[string]bool         // names left out, logged once

	// groupMu runs session creates, renames and closes one at a time.
	groupMu sync.Mutex
	// onRename is told a group's old and new id after a rename (set before
	// serving; may be nil).
	onRename func(from, to string)
}

// zellijReadKeep is how long a session's last good read stands in for a
// failed one.
const zellijReadKeep = 10 * time.Second

// zellijReadConcurrency bounds the sessions read at once.
const zellijReadConcurrency = 4

type zellijTabRef struct {
	session string
	tab     int
}

// zellijTabInfo is one tab of `list-tabs -a -j` (unknown fields ignored).
type zellijTabInfo struct {
	TabID       int    `json:"tab_id"`
	Position    int    `json:"position"`
	Name        string `json:"name"`
	Active      bool   `json:"active"`
	DisplayRows int    `json:"display_area_rows"`
	DisplayCols int    `json:"display_area_columns"`
}

// zellijPaneInfo is one pane of `list-panes -a -j`.
type zellijPaneInfo struct {
	ID          int    `json:"id"`
	IsPlugin    bool   `json:"is_plugin"`
	IsFocused   bool   `json:"is_focused"`
	IsFloating  bool   `json:"is_floating"`
	Title       string `json:"title"`
	Exited      bool   `json:"exited"`
	TabID       int    `json:"tab_id"`
	Command     string `json:"pane_command"`
	Cwd         string `json:"pane_cwd"`
	ContentRows int    `json:"pane_content_rows"`
	ContentCols int    `json:"pane_content_columns"`
}

type zellijRead struct {
	tabs  []zellijTabInfo
	panes []zellijPaneInfo
	at    time.Time
}

// newZellijMux checks that a supported Zellij is installed.
func newZellijMux(ctx context.Context) (*zellijMux, error) {
	vctx, cancel := context.WithTimeout(ctx, muxTimeout)
	defer cancel()
	v, err := zellijCheckVersion(vctx)
	if err != nil {
		return nil, err
	}
	log.Printf("zellij %d.%d.%d, sockets in %s", v[0], v[1], v[2], zellijSocketDir())
	return &zellijMux{
		slots:    map[string]chan struct{}{},
		clients:  map[string][]*zellijClient{},
		departed: map[string]map[string]time.Time{},
		reads:    map[string]zellijRead{},
		tabKeys:  map[zellijTabRef]string{},
		skipped:  map[string]bool{},
	}, nil
}

func (*zellijMux) Name() string { return "zellij" }

func (*zellijMux) Caps() Caps {
	return Caps{
		ClientSideSelect: true,
		PaneText:         true,
		Groups:           true,
		ReorderTabs:      true,
		Files:            true,
		AgentChat:        agentProcSupported,
	}
}

// Health: a supported Zellij answers `ls`.
func (*zellijMux) Health(ctx context.Context) error {
	if _, err := zellijCheckVersion(ctx); err != nil {
		return err
	}
	_, err := zellijListSessions(ctx)
	return err
}

func (m *zellijMux) Snapshot(ctx context.Context) (Snapshot, error) { return m.snapshot(ctx, true) }

// peekSnapshot never creates the default session (push watcher, view-only
// clients, the service worker).
func (m *zellijMux) peekSnapshot(ctx context.Context) (Snapshot, error) {
	return m.snapshot(ctx, false)
}

// liveSessions lists the running sessions whose names can be passed to
// zellij; any other is left out (logged once).
func (m *zellijMux) liveSessions(ctx context.Context) ([]string, error) {
	list, err := zellijListSessions(ctx)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, s := range list {
		if s.exited {
			continue
		}
		if !zellijPassableName(s.name) {
			m.mu.Lock()
			if !m.skipped[s.name] {
				m.skipped[s.name] = true
				log.Printf("zellij: session %q left out: its name cannot be passed to zellij safely", s.name)
			}
			m.mu.Unlock()
			continue
		}
		names = append(names, s.name)
	}
	sort.Strings(names)
	return names, nil
}

func (m *zellijMux) snapshot(ctx context.Context, create bool) (Snapshot, error) {
	if _, err := zellijCheckVersion(ctx); err != nil {
		return Snapshot{}, err
	}
	names, err := m.liveSessions(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	if create && len(names) == 0 {
		if err := m.createDefault(ctx); err != nil {
			return Snapshot{}, err
		}
		if names, err = m.liveSessions(ctx); err != nil {
			return Snapshot{}, err
		}
	}
	reads := make([]zellijRead, len(names))
	errs := make([]error, len(names))
	sem := make(chan struct{}, zellijReadConcurrency)
	var wg sync.WaitGroup
	for i, name := range names {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			reads[i], errs[i] = m.readSession(ctx, name)
		}()
	}
	wg.Wait()
	// A session that ended between the listing and its read is left out;
	// any other failed read fails the snapshot (a group without tabs would
	// make the PWA create one).
	var live []string
	var liveReads []zellijRead
	for i, err := range errs {
		switch {
		case err == nil:
			live, liveReads = append(live, names[i]), append(liveReads, reads[i])
		case errors.Is(err, errZellijNoSession):
		default:
			return Snapshot{}, fmt.Errorf("session %q: %w", names[i], err)
		}
	}
	names, reads = live, liveReads
	snap := Snapshot{Groups: make([]Group, 0, len(names))}
	var agentPanes []zellijAgentPane
	for i, name := range names {
		g := m.buildGroup(name, reads[i])
		for ti, t := range g.Tabs {
			for pi, p := range t.Panes {
				_, n, _ := parseZellijPaneID(p.ID)
				agentPanes = append(agentPanes, zellijAgentPane{group: i, tab: ti, pane: pi, session: name, n: n})
			}
		}
		snap.Groups = append(snap.Groups, g)
	}
	m.pruneTabKeys(names, reads)
	m.checkDriftAll(ctx, names)
	if agentProcSupported && len(agentPanes) > 0 {
		m.fillAgents(ctx, snap.Groups, agentPanes)
	}
	return snap, nil
}

// readSession lists a session's tabs and panes. A failed read stands on the
// last good one for zellijReadKeep, never on nothing: a group without tabs
// would make the PWA create one.
func (m *zellijMux) readSession(ctx context.Context, session string) (zellijRead, error) {
	r, err := zellijReadNow(ctx, session)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err == nil {
		m.reads[session] = r
		return r, nil
	}
	if last, ok := m.reads[session]; ok && time.Since(last.at) < zellijReadKeep {
		return last, nil
	}
	return zellijRead{}, err
}

func zellijReadNow(ctx context.Context, session string) (zellijRead, error) {
	var r zellijRead
	var err error
	if r.tabs, err = zellijTabs(ctx, session); err != nil {
		return zellijRead{}, err
	}
	if r.panes, err = zellijPanes(ctx, session); err != nil {
		return zellijRead{}, err
	}
	if len(r.tabs) == 0 {
		return zellijRead{}, errors.New("list-tabs: no tab")
	}
	r.at = time.Now()
	return r, nil
}

// zellijPanes lists a session's panes, plugins included.
func zellijPanes(ctx context.Context, session string) ([]zellijPaneInfo, error) {
	out, err := zellijQuery(ctx, session, zellijPanesList, "list-panes", "-a", "-j")
	if err != nil {
		return nil, err
	}
	var panes []zellijPaneInfo
	if err := json.Unmarshal(out, &panes); err != nil {
		return nil, fmt.Errorf("list-panes: %w", err)
	}
	return panes, nil
}

// buildGroup turns a session's read into a group: tabs in position order,
// each with its terminal panes in id order.
func (m *zellijMux) buildGroup(session string, r zellijRead) Group {
	g := Group{ID: zellijGroupID(session), Name: session, Tabs: []Tab{}}
	tabs := slices.Clone(r.tabs)
	sort.SliceStable(tabs, func(i, j int) bool { return tabs[i].Position < tabs[j].Position })
	byTab := map[int][]zellijPaneInfo{}
	for _, p := range r.panes {
		if !p.IsPlugin {
			byTab[p.TabID] = append(byTab[p.TabID], p)
		}
	}
	for _, t := range tabs {
		panes := byTab[t.TabID]
		sort.Slice(panes, func(i, j int) bool { return panes[i].ID < panes[j].ID })
		tab := Tab{ID: zellijTabID(session, t.TabID), Key: m.tabKey(session, t.TabID, panes),
			Name: t.Name, Active: t.Active, Panes: []Pane{}}
		for _, p := range panes {
			pane := Pane{ID: zellijPaneID(session, p.ID), Active: p.IsFocused,
				Title: stripUnsafeRunes(p.Title), key: zellijPaneKey(session, p.ID)}
			if name := processName(p.Command); name != "" {
				pane.Process = &ProcessInfo{Name: name, Cwd: processCwd(p.Cwd)}
			}
			tab.Panes = append(tab.Panes, pane)
		}
		g.Tabs = append(g.Tabs, tab)
	}
	return g
}

// tabKey names a tab for as long as it lives: its group id and the first
// terminal pane seen in it, remembered so it neither changes when that pane
// closes nor repeats when Zellij hands the tab id to a new tab.
func (m *zellijMux) tabKey(session string, tab int, panes []zellijPaneInfo) string {
	ref := zellijTabRef{session, tab}
	m.mu.Lock()
	defer m.mu.Unlock()
	if k, ok := m.tabKeys[ref]; ok {
		return k
	}
	if len(panes) == 0 {
		return zellijTabID(session, tab)
	}
	k := zellijPaneKey(session, panes[0].ID)
	m.tabKeys[ref] = k
	return k
}

// pruneTabKeys forgets the keys of tabs that are gone.
func (m *zellijMux) pruneTabKeys(names []string, reads []zellijRead) {
	live := map[zellijTabRef]bool{}
	for i, name := range names {
		for _, t := range reads[i].tabs {
			live[zellijTabRef{name, t.TabID}] = true
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for ref := range m.tabKeys {
		if !live[ref] {
			delete(m.tabKeys, ref)
		}
	}
	for s := range m.reads {
		if !slices.Contains(names, s) {
			delete(m.reads, s)
		}
	}
}

// checkDriftAll checks the stream clients of every listed session that has
// any.
func (m *zellijMux) checkDriftAll(ctx context.Context, names []string) {
	for _, s := range names {
		if len(m.sessionClients(s)) == 0 {
			continue
		}
		if clients, err := zellijClients(ctx, s); err == nil {
			m.checkDrift(s, clients)
		}
	}
}

// createDefault starts the default session when no session runs, in the
// home directory, unless sessions of another Zellij still run.
func (m *zellijMux) createDefault(ctx context.Context) error {
	m.groupMu.Lock()
	defer m.groupMu.Unlock()
	if zellijOtherContracts() {
		return errZellijVersionMismatch
	}
	list, err := zellijListSessions(ctx)
	if err != nil {
		return err
	}
	for _, s := range list {
		if s.name == zellijDefaultSession && !s.exited {
			return nil
		}
	}
	home, _ := os.UserHomeDir()
	return m.startSession(ctx, zellijDefaultSession, home)
}

// startSession creates session in the background with its first pane in
// dir. The name is never after `--`, which would start a command. Zellij
// opens its setup wizard, release notes or a tip as a floating plugin pane
// in a new session: those are closed, nobody would see them.
func (m *zellijMux) startSession(ctx context.Context, session, dir string) error {
	// A session already there (a listing that missed it) keeps its panes.
	if out, err := zellijAction(ctx, session, "list-tabs"); err == nil && bytes.HasPrefix(bytes.TrimSpace(out), []byte("TAB_ID")) {
		return nil
	}
	cmd := zellijCmd(ctx, "attach", "--create-background", session)
	cmd.Dir = dir
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := runZellijGated(cmd); err != nil {
		log.Printf("zellij attach -b: %v: %s", err, capBytes(strings.TrimSpace(stderr.String()), 512))
		return fmt.Errorf("zellij attach -b: %w", err)
	}
	if err := zellijWaitListed(ctx, session); err != nil {
		return err
	}
	// The popup is loaded after the session starts: watch for it a moment.
	deadline := time.Now().Add(zellijPopupWait)
	for time.Now().Before(deadline) {
		panes, err := zellijPanes(ctx, session)
		if err != nil {
			return err
		}
		for _, p := range panes {
			if p.IsPlugin && p.IsFloating {
				zellijRepeat(ctx, session, "close-pane", "--pane-id", "plugin_"+strconv.Itoa(p.ID))
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return nil
}

// zellijPopupWait is how long a new session is watched for Zellij's popups.
const zellijPopupWait = 1200 * time.Millisecond

// requirePane checks that paneID names a terminal pane that exists: Zellij
// silently ignores an action on an unknown pane.
func (m *zellijMux) requirePane(ctx context.Context, paneID string) (string, int, error) {
	session, n, ok := parseZellijPaneID(paneID)
	if !ok {
		return "", 0, inputError("invalid pane id")
	}
	if _, err := zellijFindPane(ctx, session, n); err != nil {
		return "", 0, err
	}
	return session, n, nil
}

// zellijFindPane returns terminal_n of session as listed now.
func zellijFindPane(ctx context.Context, session string, n int) (zellijPaneInfo, error) {
	panes, err := zellijPanes(ctx, session)
	if errors.Is(err, errZellijNoSession) {
		return zellijPaneInfo{}, inputError("unknown pane")
	}
	if err != nil {
		return zellijPaneInfo{}, err
	}
	for _, p := range panes {
		if !p.IsPlugin && p.ID == n {
			return p, nil
		}
	}
	return zellijPaneInfo{}, inputError("unknown pane")
}

// zellijPaneSize is a pane's content size.
func zellijPaneSize(ctx context.Context, session string, n int) (Size, error) {
	p, err := zellijFindPane(ctx, session, n)
	if err != nil {
		return Size{}, err
	}
	return Size{Cols: clampDim(p.ContentCols), Rows: clampDim(p.ContentRows)}, nil
}

// zellijTabs lists a session's tabs in position order.
func zellijTabs(ctx context.Context, session string) ([]zellijTabInfo, error) {
	out, err := zellijQuery(ctx, session, zellijTabsList, "list-tabs", "-a", "-j")
	if err != nil {
		return nil, err
	}
	var tabs []zellijTabInfo
	if err := json.Unmarshal(out, &tabs); err != nil {
		return nil, fmt.Errorf("list-tabs: %w", err)
	}
	sort.SliceStable(tabs, func(i, j int) bool { return tabs[i].Position < tabs[j].Position })
	return tabs, nil
}

// requireTab checks that tabID names a tab that exists and, when key is
// given, that it is still the tab key named (Zellij reuses tab ids).
func (m *zellijMux) requireTab(ctx context.Context, tabID, key string) (string, int, []zellijTabInfo, error) {
	session, id, ok := parseZellijTabID(tabID)
	if !ok {
		return "", 0, nil, errInvalidTabID
	}
	tabs, err := zellijTabs(ctx, session)
	if errors.Is(err, errZellijNoSession) {
		return "", 0, nil, errUnknownTab
	}
	if err != nil {
		return "", 0, nil, err
	}
	if !slices.ContainsFunc(tabs, func(t zellijTabInfo) bool { return t.TabID == id }) {
		return "", 0, nil, errUnknownTab
	}
	if key != "" {
		panes, err := zellijPanes(ctx, session)
		if err != nil {
			return "", 0, nil, err
		}
		var mine []zellijPaneInfo
		for _, p := range panes {
			if !p.IsPlugin && p.TabID == id {
				mine = append(mine, p)
			}
		}
		sort.Slice(mine, func(i, j int) bool { return mine[i].ID < mine[j].ID })
		if m.tabKey(session, id, mine) != key {
			return "", 0, nil, errTabChanged
		}
	}
	return session, id, tabs, nil
}

// SelectTab is not offered: Zellij's tab is per client, and the CLI action
// would move whichever client typed last (the PWA selects tabs on its own).
func (*zellijMux) SelectTab(context.Context, string) error { return errUnsupported }

// errZellijNoClient: Zellij makes a broken tab when no client is attached
// (upstream #5594).
var errZellijNoClient = &codedError{code: "no_client",
	msg: "open this Zellij session in a terminal (or in Termote) before adding a tab", status: 409}

// NewTab opens a tab without focusing it, so no client moves. Zellij needs a
// client attached to lay a new tab out.
func (m *zellijMux) NewTab(ctx context.Context, groupID, name string) (string, error) {
	session, ok := parseZellijGroupID(groupID)
	if !ok {
		return "", inputError("invalid group id")
	}
	if name != "" && !validZellijTabName(name) {
		return "", inputError("invalid tab name")
	}
	id, _, err := m.newTab(ctx, session, name, "")
	if err != nil {
		return "", err
	}
	return zellijTabID(session, id), nil
}

// newTab opens a tab in session, its shell in dir when given, and returns
// its id and its terminal pane's.
func (m *zellijMux) newTab(ctx context.Context, session, name, dir string) (int, int, error) {
	if _, err := zellijTabs(ctx, session); errors.Is(err, errZellijNoSession) {
		return 0, 0, inputError("unknown group")
	}
	unlock, err := m.lockSession(ctx, session)
	if err != nil {
		return 0, 0, err
	}
	defer unlock()
	clients, err := zellijClients(ctx, session)
	if errors.Is(err, errZellijNoSession) {
		return 0, 0, inputError("unknown group")
	}
	if err != nil {
		return 0, 0, err
	}
	if len(clients) == 0 {
		return 0, 0, errZellijNoClient
	}
	before, err := zellijTabs(ctx, session)
	if err != nil {
		return 0, 0, err
	}
	args := []string{"new-tab", "--no-focus"}
	if name != "" {
		args = append(args, "--name="+name)
	}
	if dir != "" {
		args = append(args, "--cwd="+dir)
	}
	// The command can fail, or not print the id, after it made the tab
	// (zellijGate): the one new tab in the listing is it. Running it again
	// could make a second tab.
	out, runErr := zellijAction(ctx, session, args...)
	id, idErr := strconv.Atoi(strings.TrimSpace(string(out)))
	after, err := zellijTabs(ctx, session)
	if err != nil {
		return 0, 0, err
	}
	if runErr != nil || idErr != nil {
		var added []int
		for _, t := range after {
			if !slices.ContainsFunc(before, func(b zellijTabInfo) bool { return b.TabID == t.TabID }) {
				added = append(added, t.TabID)
			}
		}
		if len(added) != 1 {
			if runErr != nil {
				return 0, 0, runErr
			}
			return 0, 0, errors.New("new tab: id not found")
		}
		id = added[0]
	}
	panes, err := zellijPanes(ctx, session)
	if err != nil {
		return 0, 0, err
	}
	i := slices.IndexFunc(panes, func(p zellijPaneInfo) bool { return !p.IsPlugin && p.TabID == id && !p.Exited })
	if i < 0 {
		return 0, 0, errors.New("new tab: no terminal pane")
	}
	return id, panes[i].ID, nil
}

func (m *zellijMux) CloseTab(ctx context.Context, tabID, key string) error {
	session, id, _, err := m.requireTab(ctx, tabID, key)
	if err != nil {
		return err
	}
	// Not repeated: Zellij reuses tab ids, so a second try after a close
	// that worked but reported a failure could close a new tab. The
	// listing tells whether it is gone.
	_, closeErr := zellijAction(ctx, session, "close-tab-by-id", "--", strconv.Itoa(id))
	if closeErr == nil {
		return nil
	}
	tabs, err := zellijTabs(ctx, session)
	if errors.Is(err, errZellijNoSession) {
		return nil // it was the last tab
	}
	if err == nil && !slices.ContainsFunc(tabs, func(t zellijTabInfo) bool { return t.TabID == id }) {
		return nil
	}
	return closeErr
}

func (m *zellijMux) RenameTab(ctx context.Context, tabID, name, key string) error {
	if !validZellijTabName(name) {
		return inputError("invalid tab name")
	}
	session, id, _, err := m.requireTab(ctx, tabID, key)
	if err != nil {
		return err
	}
	return zellijRepeat(ctx, session, "rename-tab-by-id", "--", strconv.Itoa(id), name)
}

// MoveTab moves a tab one step at a time toward index. Zellij wraps a tab
// moved past an end, so no step crosses one. The tab keeps its id.
func (m *zellijMux) MoveTab(ctx context.Context, tabID string, index int) (string, error) {
	session, id, tabs, err := m.requireTab(ctx, tabID, "")
	if err != nil {
		return "", err
	}
	if index < 0 || index >= len(tabs) {
		return "", errInvalidIndex
	}
	// One step at a time, the place read again after each: a step that
	// failed may still have moved the tab (zellijGate).
	at := slices.IndexFunc(tabs, func(t zellijTabInfo) bool { return t.TabID == id })
	for steps := 0; at != index; steps++ {
		if steps > 2*len(tabs) {
			return "", errInvalidIndex
		}
		dir := "right"
		if index < at {
			dir = "left"
		}
		zellijAction(ctx, session, "move-tab", "--tab-id", strconv.Itoa(id), dir)
		after, err := zellijTabs(ctx, session)
		if err != nil {
			return "", err
		}
		if at = slices.IndexFunc(after, func(t zellijTabInfo) bool { return t.TabID == id }); at < 0 {
			return "", errUnknownTab
		}
	}
	return tabID, nil
}

// MoveGroup is not offered: Zellij sessions have no order.
func (*zellijMux) MoveGroup(context.Context, string, int) error { return errUnsupported }

// NewGroup starts a session named name in cwd. A name Zellij still keeps
// for resurrection is taken too.
func (m *zellijMux) NewGroup(ctx context.Context, name, cwd string) (string, error) {
	if !validZellijName(name) {
		return "", errInvalidGroupName
	}
	m.groupMu.Lock()
	defer m.groupMu.Unlock()
	if zellijOtherContracts() {
		return "", errZellijVersionMismatch
	}
	list, err := zellijListSessions(ctx)
	if err != nil {
		return "", err
	}
	if slices.ContainsFunc(list, func(s zellijSession) bool { return s.name == name }) {
		return "", errGroupExists
	}
	if err := m.startSession(ctx, name, cwd); err != nil {
		return "", err
	}
	// Another process could have made the same name between the check and
	// the start, and `attach -b` would then have done nothing: the session
	// must be the one started here, in cwd.
	panes, err := zellijPanes(ctx, name)
	if err != nil {
		return "", err
	}
	if !slices.ContainsFunc(panes, func(p zellijPaneInfo) bool { return !p.IsPlugin && p.ID == 0 && p.Cwd == cwd }) {
		return "", errGroupExists
	}
	return zellijGroupID(name), nil
}

// RenameGroup renames a session. Renaming onto a name in use would orphan
// the other session's server, so that is refused first.
func (m *zellijMux) RenameGroup(ctx context.Context, groupID, name string) error {
	session, ok := parseZellijGroupID(groupID)
	if !ok {
		return errInvalidGroupID
	}
	if session == zellijDefaultSession {
		return errDefaultSession
	}
	if !validZellijName(name) {
		return errInvalidGroupName
	}
	m.groupMu.Lock()
	defer m.groupMu.Unlock()
	list, err := zellijListSessions(ctx)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(list, func(s zellijSession) bool { return s.name == session && !s.exited }) {
		return errUnknownGroup
	}
	if name == session {
		return nil
	}
	if slices.ContainsFunc(list, func(s zellijSession) bool { return s.name == name }) {
		return errGroupExists
	}
	// A failed rename may still have renamed (zellijGate): the listing says.
	_, renameErr := zellijAction(ctx, session, "rename-session", "--", name)
	after, err := zellijListSessions(ctx)
	if err != nil {
		return err
	}
	if renameErr != nil && countZellijSessions(after, name) == 0 {
		return renameErr
	}
	if n := countZellijSessions(after, name); n != 1 {
		log.Printf("zellij: after renaming a session, %d sessions answer to the new name", n)
	}
	if m.onRename != nil {
		m.onRename(groupID, zellijGroupID(name))
	}
	return nil
}

func countZellijSessions(list []zellijSession, name string) int {
	n := 0
	for _, s := range list {
		if s.name == name {
			n++
		}
	}
	return n
}

// CloseGroup kills a session and deletes it: Termote leaves no resurrection
// entry behind.
func (m *zellijMux) CloseGroup(ctx context.Context, groupID string) error {
	session, ok := parseZellijGroupID(groupID)
	if !ok {
		return errInvalidGroupID
	}
	m.groupMu.Lock()
	defer m.groupMu.Unlock()
	list, err := zellijListSessions(ctx)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(list, func(s zellijSession) bool { return s.name == session }) {
		return errUnknownGroup
	}
	// A failed delete may still have deleted (zellijGate): the listing says.
	_, delErr := zellijRun(ctx, "delete-session", "--force", "--", session)
	if delErr == nil {
		return nil
	}
	after, err := zellijListSessions(ctx)
	if err != nil {
		return err
	}
	if countZellijSessions(after, session) > 0 {
		return delErr
	}
	return nil
}

func (m *zellijMux) ClosePane(ctx context.Context, paneID string) error {
	session, n, err := m.requirePane(ctx, paneID)
	if err != nil {
		return err
	}
	return zellijRepeat(ctx, session, "close-pane", "--pane-id", zellijTerminal(n))
}

// SendKeys types raw input into a pane through a Termote client (the
// stream's, else a hidden one), never through argv.
func (m *zellijMux) SendKeys(ctx context.Context, paneID, keys string) error {
	session, n, err := m.requirePane(ctx, paneID)
	if err != nil {
		return err
	}
	return m.writeToPane(ctx, session, n, []byte(keys))
}

// Scroll is not offered: a Zellij pane's viewport is shared by every client,
// so it would scroll the user's own terminal too. The full stream's mouse
// wheel scrolls through Zellij itself.
func (*zellijMux) Scroll(context.Context, string, int) error { return errUnsupported }

// ReadText dumps the pane's scrollback and screen (wrapped rows joined) and
// keeps its last lines rows.
func (m *zellijMux) ReadText(ctx context.Context, paneID string, lines int, w io.Writer) (bool, error) {
	session, n, err := m.requirePane(ctx, paneID)
	if err != nil {
		return false, err
	}
	cmd := zellijCmd(ctx, zellijActionArgs(session, "dump-screen", "--pane-id", zellijTerminal(n), "--full")...)
	tb := &tailBuffer{max: maxPaneText}
	cmd.Stdout = tb
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := runZellijGated(cmd); err != nil {
		log.Printf("zellij dump-screen: %v: %s", err, capBytes(strings.TrimSpace(stderr.String()), 512))
		return false, fmt.Errorf("dump-screen: %w", err)
	}
	text, truncated := tb.text()
	text = strings.TrimRight(text, "\n")
	rows := strings.Split(text, "\n")
	more := false
	if len(rows) > lines {
		rows, more = rows[len(rows)-lines:], !truncated
	}
	_, err = io.WriteString(w, strings.Join(rows, "\n")+"\n")
	return more, err
}

// Attach starts a Termote client on paneID's session and places it on the
// pane (zellij_client.go).
func (m *zellijMux) Attach(ctx context.Context, paneID string, size Size) (TermStream, error) {
	session, n, err := m.requirePane(ctx, paneID)
	if err != nil {
		return nil, err
	}
	unlock, err := m.lockSession(ctx, session)
	if err != nil {
		return nil, err
	}
	defer unlock()
	c, err := m.startClient(ctx, session, n, size, false)
	if err != nil {
		return nil, zellijTransient(err)
	}
	return zellijClientStream{c}, nil
}

// tabSize is the size of the client area of terminal_n's tab, for a hidden
// client that should not shrink it; 80x24 when unknown.
func (m *zellijMux) tabSize(ctx context.Context, session string, n int) (Size, error) {
	p, err := zellijFindPane(ctx, session, n)
	if err != nil {
		return Size{}, err
	}
	tabs, err := zellijTabs(ctx, session)
	if err != nil {
		return Size{}, err
	}
	for _, t := range tabs {
		if t.TabID == p.TabID && t.DisplayCols > 0 && t.DisplayRows > 0 {
			return Size{Cols: clampDim(t.DisplayCols), Rows: clampDim(t.DisplayRows)}, nil
		}
	}
	return Size{Cols: defaultTermCols, Rows: defaultTermRows}, nil
}
