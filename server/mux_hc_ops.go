package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// What termote changes in herdr-core goes through labels, the way herdr-app
// adopts a terminal (herdr-app defaults/AGENTS.md): a terminal started with
// herdr.space and herdr.tab shows up in that space and tab, an id herdr-app
// does not know becomes a new space or tab, a second terminal of a tab
// splits it. herdr-app's document is never written, so renaming, moving,
// zooming, swapping and resizing are not offered.

// errHcRestarting: the terminal was lost and waits for its new shell.
var errHcRestarting = &codedError{"unavailable", "the terminal is restarting", http.StatusServiceUnavailable}

// hcError maps a core error to what the client is told; the core's own text
// is only logged (muxError).
func hcError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errHcNotRunning), errors.Is(err, errHcLost):
		return errHcUnavailable
	}
	switch hcErrorKind(err) {
	case "not_found":
		return errUnknownPane
	case "unavailable":
		return errHcRestarting
	}
	return err
}

func (m *hcMux) Caps() Caps {
	return Caps{
		ClientSideSelect: true, PaneText: true, DriveSize: true, PaneStream: true, PaneLayout: true,
		Files: true, AgentChat: agentProcSupported, Groups: true,
	}
}

// requirePane checks id names a pane of the snapshot (a local terminal of
// herdr's: hcShown) and returns its record.
func (m *hcMux) requirePane(ctx context.Context, id string) (hcTerminal, error) {
	if !validHcAddress(id) {
		return hcTerminal{}, inputError("invalid pane id")
	}
	if err := m.view(ctx, false); err != nil {
		return hcTerminal{}, hcError(err)
	}
	t, ok := m.state.terminal(id)
	if !ok || !hcShown(&t) {
		return hcTerminal{}, errUnknownPane
	}
	return t, nil
}

// group finds a group of the current snapshot.
func (m *hcMux) group(ctx context.Context, id string) (Group, error) {
	snap, err := m.snapshot(ctx, false)
	if err != nil {
		return Group{}, hcError(err)
	}
	for _, g := range snap.Groups {
		if g.ID == id {
			return g, nil
		}
	}
	return Group{}, errUnknownGroup
}

// newHcID is a fresh space or tab id, as herdr-app makes them (model.rs
// fresh_id): prefix and 32 hex digits.
func newHcID(prefix string) string {
	b := make([]byte, 16)
	rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// folderFor is where a new terminal of group g starts, as herdr-app picks it
// (window.rs folder_for): the folder its first pane works in now, else the
// space's folder, else home.
func (m *hcMux) folderFor(g Group) string {
	if len(g.Tabs) > 0 && len(g.Tabs[0].Panes) > 0 {
		if t, ok := m.state.terminal(g.Tabs[0].Panes[0].ID); ok {
			if d := processCwd(hcLiveFolder(&t)); d != "" {
				return d
			}
		}
	}
	if doc := m.state.input().doc; doc != nil {
		for _, s := range doc.Spaces {
			if s.ID == g.ID && isAbsAnyOS(s.Folder) {
				return s.Folder
			}
		}
	}
	return m.home
}

// run starts this machine's shell in space and tab, and keeps its record so
// the next snapshot shows it before the created event arrives.
func (m *hcMux) run(ctx context.Context, space, tab, cwd string) (string, error) {
	conn, err := m.conn(ctx)
	if err != nil {
		return "", err
	}
	if cwd != "" && !isAbsAnyOS(cwd) {
		cwd = ""
	}
	var t hcTerminal
	if err := conn.call(ctx, hcRunParams{Cwd: cwd, Space: space, Tab: tab}, &t); err != nil {
		return "", hcError(err)
	}
	if !validHcAddress(t.Address) {
		return "", errors.New("hc run: no local address in the reply")
	}
	m.state.upsert(t)
	m.bump()
	return t.Address, nil
}

// NewTab starts a terminal in a new tab of groupID. The name is herdr-app's
// to give (a tab is named after its place): it is not used.
func (m *hcMux) NewTab(ctx context.Context, groupID, _ string) (string, error) {
	g, err := m.group(ctx, groupID)
	if err != nil {
		return "", err
	}
	tab := newHcID("tb")
	if _, err := m.run(ctx, g.ID, tab, m.folderFor(g)); err != nil {
		return "", err
	}
	return tab, nil
}

// NewGroup starts a terminal in a new space, in cwd. herdr-app names it after
// its folder; name is not used.
func (m *hcMux) NewGroup(ctx context.Context, _, cwd string) (string, error) {
	if err := m.view(ctx, false); err != nil {
		return "", hcError(err)
	}
	space := newHcID("sp")
	if _, err := m.run(ctx, space, newHcID("tb"), cwd); err != nil {
		return "", err
	}
	return space, nil
}

// SplitPane starts a terminal in paneID's tab: herdr-app splits the tab
// after its last pane, along a row, whatever dir asks. A pane without a
// herdr.tab label sits in the tab herdr-app's document put it in; one the
// document does not hold yet has a tab of its own, which cannot be named in
// a label, so the new terminal gets a new tab.
func (m *hcMux) SplitPane(ctx context.Context, paneID string, _ SplitDir, cwd string) (string, error) {
	t, err := m.requirePane(ctx, paneID)
	if err != nil {
		return "", err
	}
	if cwd == "" {
		cwd = processCwd(hcLiveFolder(&t))
	}
	tab := t.Labels[hcLabelTab]
	if tab == "" {
		snap, err := m.snapshot(ctx, false)
		if err != nil {
			return "", hcError(err)
		}
		if _, st, _, ok := findSnapshotPane(snap, paneID, false); ok {
			tab = hcTabLabel(st.ID)
		}
		if tab == "" {
			tab = newHcID("tb")
		}
	}
	return m.run(ctx, t.Labels[hcLabelSpace], tab, cwd)
}

// kill ends addr and, as herdr-app does when it closes a pane (window.rs),
// every terminal it started that has no space of its own: sub-agents.
// Its labels are read again first: one moved to another space, or to
// another tab when tab is set (the herdr.tab label it must still carry,
// "" for none), since the snapshot is left alone (errTabChanged).
func (m *hcMux) kill(ctx context.Context, conn *hcConn, addr, space string, tab *string) error {
	var t hcTerminal
	if err := conn.call(ctx, hcGetParams{addr}, &t); err != nil {
		return hcError(err)
	}
	if t.Labels[hcLabelSpace] != space || (tab != nil && t.Labels[hcLabelTab] != *tab) {
		return errTabChanged
	}
	for _, child := range m.children(addr) {
		if err := conn.call(ctx, hcKillParams{child}, nil); err != nil && hcErrorKind(err) != "not_found" {
			return hcError(err)
		}
	}
	if err := conn.call(ctx, hcKillParams{addr}, nil); err != nil && hcErrorKind(err) != "not_found" {
		return hcError(err)
	}
	return nil
}

// children are the live terminals addr started, and theirs, without a
// space of their own, deepest first.
func (m *hcMux) children(addr string) []string {
	in := m.state.input()
	var out []string
	var walk func(parent string, depth int)
	walk = func(parent string, depth int) {
		if depth > 16 {
			return
		}
		for a, t := range in.terminals {
			if t.Parent != nil && *t.Parent == parent && t.State == "live" && validHcAddress(a) && t.Labels[hcLabelSpace] == "" {
				walk(a, depth+1)
				out = append(out, a)
			}
		}
	}
	walk(addr, 0)
	return out
}

// ClosePane ends one pane of a split tab and its sub-agents.
func (m *hcMux) ClosePane(ctx context.Context, paneID string) error {
	t, err := m.requirePane(ctx, paneID)
	if err != nil {
		return err
	}
	snap, err := m.snapshot(ctx, false)
	if err != nil {
		return hcError(err)
	}
	if _, tab, _, ok := findSnapshotPane(snap, paneID, false); ok && len(tab.Panes) < 2 {
		return errLastPane
	}
	conn, err := m.conn(ctx)
	if err != nil {
		return err
	}
	tab := t.Labels[hcLabelTab]
	return m.kill(ctx, conn, paneID, t.Labels[hcLabelSpace], &tab)
}

// CloseTab ends every pane of tabID (key, when given, must be the tab id:
// a tab id never changes).
func (m *hcMux) CloseTab(ctx context.Context, tabID, key string) error {
	if key != "" && key != tabID {
		return errTabChanged
	}
	snap, err := m.snapshot(ctx, false)
	if err != nil {
		return hcError(err)
	}
	for _, g := range snap.Groups {
		for _, t := range g.Tabs {
			if t.ID == tabID {
				// A tab of herdr-app's document holds its terminals by
				// position, whatever their label says; one placed by label
				// must still carry it.
				var label *string
				if !m.docHolds(tabID) {
					l := hcTabLabel(tabID)
					label = &l
				}
				return m.closePanes(ctx, g.ID, label, t.Panes)
			}
		}
	}
	return errTabChanged
}

// CloseGroup ends every pane of every tab of groupID.
func (m *hcMux) CloseGroup(ctx context.Context, groupID string) error {
	g, err := m.group(ctx, groupID)
	if err != nil {
		return err
	}
	for _, t := range g.Tabs {
		if err := m.closePanes(ctx, g.ID, nil, t.Panes); err != nil {
			return err
		}
	}
	return nil
}

func (m *hcMux) closePanes(ctx context.Context, space string, tab *string, panes []Pane) error {
	conn, err := m.conn(ctx)
	if err != nil {
		return err
	}
	for _, p := range panes {
		if err := m.kill(ctx, conn, p.ID, space, tab); err != nil {
			return err
		}
	}
	return nil
}

// docHolds reports whether herdr-app's document has a tab tabID.
func (m *hcMux) docHolds(tabID string) bool {
	doc := m.state.input().doc
	if doc == nil {
		return false
	}
	for _, s := range doc.Spaces {
		for _, t := range s.Tabs {
			if t.ID == tabID {
				return true
			}
		}
	}
	return false
}

// SelectTab: clients choose their tab themselves (ClientSideSelect).
func (m *hcMux) SelectTab(context.Context, string) error { return nil }

// Changes that would rewrite herdr-app's document are not offered.
func (m *hcMux) RenameTab(context.Context, string, string, string) error { return errUnsupported }
func (m *hcMux) RenameGroup(context.Context, string, string) error       { return errUnsupported }
func (m *hcMux) RenamePane(context.Context, string, string) error        { return errUnsupported }
func (m *hcMux) MoveTab(context.Context, string, int) (string, error)    { return "", errUnsupported }
func (m *hcMux) MoveGroup(context.Context, string, int) error            { return errUnsupported }
func (m *hcMux) ZoomPane(context.Context, string, ZoomMode) error        { return errPaneLayoutUnsupported }
func (m *hcMux) SwapPane(context.Context, string, SwapDir) error         { return errPaneLayoutUnsupported }
func (m *hcMux) ResizePane(context.Context, string, ResizeDir, int) error {
	return errPaneLayoutUnsupported
}

// Scroll: the stream carries the program's own bytes, which xterm.js
// scrolls itself (Caps.Scroll is off).
func (m *hcMux) Scroll(context.Context, string, int) error { return errUnsupported }

// ReadText writes up to lines rows of history and the screen. more: what was
// read filled the rows asked for, so the pane may hold more.
func (m *hcMux) ReadText(ctx context.Context, paneID string, lines int, w io.Writer) (bool, error) {
	t, err := m.requirePane(ctx, paneID)
	if err != nil {
		return false, err
	}
	conn, err := m.conn(ctx)
	if err != nil {
		return false, err
	}
	var res struct {
		Text string `json:"text"`
		How  string `json:"how"`
	}
	if err := conn.call(ctx, hcReadParams{Terminal: paneID, Lines: lines}, &res); err != nil {
		return false, hcError(err)
	}
	text := strings.TrimRight(res.Text, "\n")
	_, err = io.WriteString(w, text)
	return res.How != "screen" && strings.Count(text, "\n")+1 >= lines+t.Rows, err
}

// SendKeys types keys (raw bytes) through the pane's input writer.
func (m *hcMux) SendKeys(ctx context.Context, paneID, keys string) error {
	if _, err := m.requirePane(ctx, paneID); err != nil {
		return err
	}
	return m.typeInput(ctx, paneID, []byte(keys))
}

// hcInputIdle is how long a pane's input attach stays open without input.
var hcInputIdle = 30 * time.Second

// hcMaxQueuedInput bounds what waits to be typed in one pane.
const hcMaxQueuedInput = 1 << 20

// hcInputChunk is the most bytes of input one DATA frame carries.
const hcInputChunk = 64 * 1024

// hcInput types into one pane, strictly in order, through an attach of its
// own that is not an observer (an observer's keys are dropped by the core)
// and sits at the terminal's current size, so typing never resizes the
// desktop's pane. It closes after hcInputIdle without input.
type hcInput struct {
	m    *hcMux
	pane string

	mu      sync.Mutex
	pending []byte
	waiters []chan error
	running bool
	wake    chan struct{} // more input was queued
}

func (m *hcMux) input(pane string) *hcInput {
	m.inputsMu.Lock()
	defer m.inputsMu.Unlock()
	in := m.inputs[pane]
	if in == nil {
		in = &hcInput{m: m, pane: pane, wake: make(chan struct{}, 1)}
		m.inputs[pane] = in
	}
	return in
}

// dropInput forgets a writer that stopped, unless it took input again.
func (m *hcMux) dropInput(in *hcInput) {
	m.inputsMu.Lock()
	defer m.inputsMu.Unlock()
	in.mu.Lock()
	idle := !in.running
	in.mu.Unlock()
	if idle && m.inputs[in.pane] == in {
		delete(m.inputs, in.pane)
	}
}

// typeInput queues b and waits until it is written (or ctx ends).
func (m *hcMux) typeInput(ctx context.Context, pane string, b []byte) error {
	ch, err := m.input(pane).enqueue(b)
	if err != nil {
		return err
	}
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (in *hcInput) enqueue(b []byte) (<-chan error, error) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if len(in.pending)+len(b) > hcMaxQueuedInput {
		return nil, errors.New("hc input queue full")
	}
	in.pending = append(in.pending, b...)
	ch := make(chan error, 1)
	in.waiters = append(in.waiters, ch)
	if !in.running {
		in.running = true
		go in.run()
	}
	select {
	case in.wake <- struct{}{}:
	default:
	}
	return ch, nil
}

// run writes what is queued, attaching when needed, and detaches once idle.
func (in *hcInput) run() {
	var ch *hcChannel
	var size [2]int
	defer func() {
		if ch != nil {
			ch.close()
		}
	}()
	idle := time.NewTimer(in.m.inputIdle)
	defer idle.Stop()
	for {
		in.mu.Lock()
		b, waiters := in.pending, in.waiters
		in.pending, in.waiters = nil, nil
		if len(b) == 0 {
			in.mu.Unlock()
			// Wait for more input, or stop once idle.
			select {
			case <-idle.C:
				in.mu.Lock()
				if len(in.pending) == 0 {
					in.running = false
					in.mu.Unlock()
					in.m.dropInput(in)
					return
				}
				in.mu.Unlock()
			case <-in.wake:
			}
			continue
		}
		in.mu.Unlock()
		var err error
		ch, size, err = in.write(ch, size, b)
		for _, w := range waiters {
			w <- err
		}
		if !idle.Stop() {
			select {
			case <-idle.C:
			default:
			}
		}
		idle.Reset(in.m.inputIdle)
	}
}

// write sends b on ch, attaching first (or again, after the attach was
// lost) at the terminal's current size. Typing makes this viewer the one
// that sets the size, so a size the desktop changed since is sent first:
// the terminal keeps the desktop's size.
func (in *hcInput) write(ch *hcChannel, size [2]int, b []byte) (*hcChannel, [2]int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
	defer cancel()
	t, err := in.m.requirePane(ctx, in.pane)
	if err != nil {
		return ch, size, err
	}
	now := [2]int{max(t.Cols, 1), max(t.Rows, 1)}
	if ch != nil && ch.gone() {
		ch.close()
		ch = nil
	}
	if ch != nil && now != size {
		if err := ch.send(hcKindResize, hcSizePayload(now[0], now[1])); err != nil {
			ch.close()
			return nil, size, hcError(err)
		}
		size = now
	}
	if ch == nil {
		conn, err := in.m.conn(ctx)
		if err != nil {
			return nil, size, err
		}
		ch, err = attachHc(ctx, conn, hcAttachParams{Terminal: in.pane, Cols: now[0], Rows: now[1]})
		if err != nil {
			return nil, size, hcError(err)
		}
		size = now
	}
	for len(b) > 0 {
		n := min(len(b), hcInputChunk)
		if err := ch.send(hcKindData, b[:n]); err != nil {
			ch.close()
			return nil, size, hcError(err)
		}
		b = b[n:]
	}
	return ch, size, nil
}

// attachHc attaches and opens the reply's channel.
func attachHc(ctx context.Context, conn *hcConn, p hcAttachParams) (*hcChannel, error) {
	var res struct {
		Channel uint32 `json:"channel"`
	}
	if err := conn.call(ctx, p, &res); err != nil {
		return nil, err
	}
	if res.Channel == 0 {
		return nil, errors.New("hc attach: no channel")
	}
	return conn.openChannel(res.Channel)
}
