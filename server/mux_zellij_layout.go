package main

import (
	"context"
	"errors"
	"slices"
	"time"
)

// Pane layout on Zellij. None of these actions can be run twice safely (a
// toggle undone, a resize or a move doubled, a second shell), so each runs
// once and the listing says what it did; none goes through zellijRepeat.

// zellijPaneLayoutMin is the first Zellij checked to take --pane-id on
// toggle-fullscreen, move-pane, move-pane-backwards and resize, and to list
// is_fullscreen.
var zellijPaneLayoutMin = [3]int{0, 45, 1}

// zellijResizeStep is about how many cells one Zellij resize moves an edge
// (5% of a 100 column tab). zellijResizeRounds caps the rounds of one call.
const (
	zellijResizeStep   = 5
	zellijResizeRounds = 5
)

// zellijZoomSettle bounds the wait for the listing to report a toggled
// fullscreen: list-panes can still show the old state just after
// toggle-fullscreen, and a zoom that did happen must not answer busy (nor
// be toggled back by the next one, read from the old state).
const (
	zellijZoomSettle = time.Second
	zellijZoomPoll   = 100 * time.Millisecond
)

// zellijCanPaneLayout reports whether this Zellij has the layout actions.
func zellijCanPaneLayout(ctx context.Context) bool {
	v, err := zellijCheckVersion(ctx)
	return err == nil && versionAtLeast(v, zellijPaneLayoutMin)
}

// layoutPane checks that this Zellij has the layout actions and returns the
// session of paneID and the pane as listed now.
func (m *zellijMux) layoutPane(ctx context.Context, paneID string) (string, zellijPaneInfo, error) {
	if !zellijCanPaneLayout(ctx) {
		return "", zellijPaneInfo{}, errPaneLayoutUnsupported
	}
	session, n, ok := parseZellijPaneID(paneID)
	if !ok {
		return "", zellijPaneInfo{}, inputError("invalid pane id")
	}
	p, err := zellijFindPane(ctx, session, n)
	return session, p, err
}

// zellijLayoutAction runs one action on terminal_n; a failure while the pane
// is gone is errUnknownPane.
func zellijLayoutAction(ctx context.Context, session string, n int, args ...string) error {
	_, err := zellijAction(ctx, session, args...)
	if err == nil {
		return nil
	}
	if _, ferr := zellijFindPane(ctx, session, n); errors.Is(ferr, errUnknownPane) {
		return errUnknownPane
	}
	return err
}

// SplitPane opens a pane beside or under paneID. new-pane has no pane
// target, so it runs as the session's hidden client, moved onto paneID
// first: the no-op key makes that client the one CLI actions act on, and
// the action follows at once (see zellij_client.go). The new pane takes that
// client's focus only; a stream's client and the user's stay where they
// were, checked against the listing, any moved one put back. The listing
// before and after names the new pane: exactly one new terminal pane in
// paneID's tab, else the new ones there are closed (never another tab's)
// and the split is 503 busy.
// It starts in paneID's directory: Zellij 0.45.1 ignores new-pane --cwd,
// so another directory is refused.
func (m *zellijMux) SplitPane(ctx context.Context, paneID string, dir SplitDir, cwd string) (string, error) {
	session, src, err := m.layoutPane(ctx, paneID)
	if err != nil {
		return "", err
	}
	if cwd != "" && cwd != src.Cwd {
		return "", errPaneLayoutUnsupported
	}
	unlock, err := m.lockSession(ctx, session)
	if err != nil {
		return "", err
	}
	defer unlock()
	before, err := zellijPanes(ctx, session)
	if err != nil {
		return "", zellijTransient(err)
	}
	c, err := m.hiddenClientOn(ctx, session, src.ID)
	if err != nil {
		return "", zellijTransient(err)
	}
	clients, err := zellijClients(ctx, session)
	if err != nil {
		return "", zellijTransient(err)
	}
	if _, err := c.term.Write([]byte(zellijNoopKey)); err != nil {
		return "", err
	}
	_, runErr := zellijAction(ctx, session, "new-pane", "--direction", string(dir))
	after, err := zellijPanes(ctx, session)
	if err != nil {
		return "", zellijTransient(err)
	}
	now, err := zellijClients(ctx, session)
	if err != nil {
		return "", zellijTransient(err)
	}
	var moved []string
	for id, pane := range clients {
		if id != c.id && now[id] != "" && now[id] != pane {
			moved = append(moved, id)
		}
	}
	if len(moved) > 0 {
		if err := restoreZellijClients(ctx, session, moved, clients); err != nil {
			return "", err
		}
	}
	// Only paneID's tab counts: a pane opened meanwhile in another tab is
	// someone else's and never closed here
	var added []zellijPaneInfo
	for _, p := range after {
		if !p.IsPlugin && p.TabID == src.TabID && !slices.ContainsFunc(before, func(b zellijPaneInfo) bool { return !b.IsPlugin && b.ID == p.ID }) {
			added = append(added, p)
		}
	}
	if len(added) != 1 {
		// Closed even past the action's deadline, yet never waiting forever
		// on a Zellij that hangs while the session's slot is held
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), muxTimeout)
		defer cancel()
		for _, p := range added {
			zellijAction(cctx, session, "close-pane", "--pane-id", zellijTerminal(p.ID))
		}
		if len(added) == 0 && runErr != nil {
			if _, ferr := zellijFindPane(ctx, session, src.ID); errors.Is(ferr, errUnknownPane) {
				return "", errUnknownPane
			}
			return "", runErr
		}
		return "", errZellijBusy
	}
	c.setPane(added[0].ID)
	return zellijPaneID(session, added[0].ID), nil
}

// ZoomPane fills the tab with paneID through toggle-fullscreen, from the
// listing's is_fullscreen: only when it changes, another fullscreen pane of
// the tab first put back. Zellij moves every client of the tab onto the
// pane it makes fullscreen. The tab's only pane has nothing to fill: Zellij
// leaves it as it is, and so does the zoom, as tmux and Herdr do.
func (m *zellijMux) ZoomPane(ctx context.Context, paneID string, mode ZoomMode) error {
	session, p, err := m.layoutPane(ctx, paneID)
	if err != nil {
		return err
	}
	want := mode == ZoomOn || mode == ZoomToggle && !p.IsFullscreen
	if want == p.IsFullscreen {
		return nil
	}
	if want {
		panes, err := zellijPanes(ctx, session)
		if err != nil {
			return zellijTransient(err)
		}
		if !slices.ContainsFunc(panes, func(o zellijPaneInfo) bool { return !o.IsPlugin && o.TabID == p.TabID && o.ID != p.ID }) {
			return nil
		}
		for _, o := range panes {
			if !o.IsPlugin && o.TabID == p.TabID && o.ID != p.ID && o.IsFullscreen {
				if err := zellijLayoutAction(ctx, session, o.ID, "toggle-fullscreen", "--pane-id", zellijTerminal(o.ID)); err != nil {
					return err
				}
			}
		}
	}
	if err := zellijLayoutAction(ctx, session, p.ID, "toggle-fullscreen", "--pane-id", zellijTerminal(p.ID)); err != nil {
		return err
	}
	for deadline := time.Now().Add(zellijZoomSettle); ; {
		now, err := zellijFindPane(ctx, session, p.ID)
		if err != nil {
			return err
		}
		if now.IsFullscreen == want {
			return nil
		}
		if time.Now().After(deadline) {
			return errZellijBusy
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(zellijZoomPoll):
		}
	}
}

// SwapPane moves paneID one place on screen: next is move-pane, prev
// move-pane-backwards. Zellij turns the tab's panes around and keeps their
// ids, and the pane strip lists panes by id, so the strip keeps its order;
// the move wraps around, so there is never no neighbour.
func (m *zellijMux) SwapPane(ctx context.Context, paneID string, dir SwapDir) error {
	session, p, err := m.layoutPane(ctx, paneID)
	if err != nil {
		return err
	}
	action := "move-pane"
	if dir == SwapPrev {
		action = "move-pane-backwards"
	}
	return zellijLayoutAction(ctx, session, p.ID, action, "--pane-id", zellijTerminal(p.ID))
}

// ResizePane grows paneID toward dir with resize increase. Zellij moves an
// edge by its own step, about zellijResizeStep cells, so amount cells are
// that many steps, rounded up, at most zellijResizeRounds, all under the
// session's slot. An edge that cannot move is no error.
func (m *zellijMux) ResizePane(ctx context.Context, paneID string, dir ResizeDir, amount int) error {
	session, p, err := m.layoutPane(ctx, paneID)
	if err != nil {
		return err
	}
	unlock, err := m.lockSession(ctx, session)
	if err != nil {
		return err
	}
	defer unlock()
	rounds := min((amount+zellijResizeStep-1)/zellijResizeStep, zellijResizeRounds)
	for range rounds {
		if err := zellijLayoutAction(ctx, session, p.ID, "resize", "increase", string(dir), "--pane-id", zellijTerminal(p.ID)); err != nil {
			return err
		}
	}
	return nil
}
