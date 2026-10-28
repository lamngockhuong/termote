package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// herdrPaneLayoutMin is the first Herdr checked to have pane.split,
// pane.zoom, pane.swap and pane.resize as used here (0.9.3, the version CI
// pins).
const herdrPaneLayoutMin = "0.9.3"

// herdrCanPaneLayout: panes can be split, zoomed, swapped and resized on
// Herdr version v. Not on Windows until someone checks it there.
func herdrCanPaneLayout(v, goos string) bool {
	return goos != "windows" && versionRe.MatchString(v) && compareVersions(v, herdrPaneLayoutMin) >= 0
}

// paneLayoutOK reports whether this Herdr has the layout methods.
func (m *herdrMux) paneLayoutOK() bool {
	v, _ := m.version.Load().(string)
	return herdrCanPaneLayout(v, herdrStartGOOS)
}

// herdrLayoutError maps Herdr's refusals of a layout method: a pane or tab
// gone is errUnknownPane, a method this Herdr lacks errPaneLayoutUnsupported.
// Any other error goes on as it is: muxError logs it (Herdr's message with
// it) and answers 500, never returning that text.
func herdrLayoutError(err error) error {
	var he *herdrError
	if !errors.As(err, &he) {
		return err
	}
	switch {
	case he.Code == "pane_not_found" || he.Code == "tab_not_found":
		return errUnknownPane
	case he.Code == "unknown_method" || he.Code == "invalid_request" && strings.Contains(he.Message, "`pane."):
		return errPaneLayoutUnsupported
	}
	return err
}

// layoutPane checks that this Herdr has the layout methods and that paneID
// is a pane, and returns the tab it is in.
func (m *herdrMux) layoutPane(ctx context.Context, paneID string) (Tab, error) {
	if !m.paneLayoutOK() {
		return Tab{}, errPaneLayoutUnsupported
	}
	if !herdrPaneIDRe.MatchString(paneID) {
		return Tab{}, inputError("invalid pane id")
	}
	v, err := m.view(ctx)
	if err != nil {
		return Tab{}, err
	}
	_, tab, _, ok := findSnapshotPane(v.snap, paneID, false)
	if !ok {
		return Tab{}, errUnknownPane
	}
	return tab, nil
}

// SplitPane opens a pane with pane.split, focus left where it is. Without
// cwd Herdr starts it in paneID's directory.
func (m *herdrMux) SplitPane(ctx context.Context, paneID string, dir SplitDir, cwd string) (string, error) {
	if _, err := m.layoutPane(ctx, paneID); err != nil {
		return "", err
	}
	params := map[string]any{"target_pane_id": paneID, "direction": string(dir), "focus": false}
	if cwd != "" {
		params["cwd"] = cwd
	}
	var out struct {
		Pane struct {
			PaneID string `json:"pane_id"`
		} `json:"pane"`
	}
	err := m.rpc.call(ctx, "pane.split", params, &out)
	m.invalidate()
	if err != nil {
		return "", herdrLayoutError(err)
	}
	if !herdrPaneIDRe.MatchString(out.Pane.PaneID) {
		return "", fmt.Errorf("pane.split answered pane id %q", out.Pane.PaneID)
	}
	return out.Pane.PaneID, nil
}

// ZoomPane runs pane.zoom. Zooming focuses the pane in Herdr, for every
// client; zooming one already zoomed changes nothing and is no error.
func (m *herdrMux) ZoomPane(ctx context.Context, paneID string, mode ZoomMode) error {
	if _, err := m.layoutPane(ctx, paneID); err != nil {
		return err
	}
	err := m.rpc.call(ctx, "pane.zoom", map[string]string{"pane_id": paneID, "mode": string(mode)}, nil)
	m.invalidate()
	return herdrLayoutError(err)
}

// SwapPane swaps paneID with its neighbour in the tab's pane order through
// pane.swap. Herdr answers a swap it did not do in a successful reply, with
// a reason.
func (m *herdrMux) SwapPane(ctx context.Context, paneID string, dir SwapDir) error {
	tab, err := m.layoutPane(ctx, paneID)
	if err != nil {
		return err
	}
	ids := make([]string, len(tab.Panes))
	for i, p := range tab.Panes {
		ids[i] = p.ID
	}
	target, err := swapNeighbor(ids, paneID, dir)
	if err != nil {
		return err
	}
	var out struct {
		Swap struct {
			Changed bool   `json:"changed"`
			Reason  string `json:"reason"`
		} `json:"swap"`
	}
	err = m.rpc.call(ctx, "pane.swap", map[string]string{"source_pane_id": paneID, "target_pane_id": target}, &out)
	m.invalidate()
	if err != nil {
		return herdrLayoutError(err)
	}
	switch out.Swap.Reason {
	case "not_found", "cross_tab":
		return errUnknownPane
	case "no_neighbor":
		return errNoNeighbor
	}
	return nil
}

// ResizePane moves paneID's edge with pane.resize, whose amount is a share
// of the split it moves (0..1), not cells: amount cells of the tab's width
// (left, right) or height (up, down). In a nested split that moves the edge
// at most amount cells. An edge that cannot move further changes nothing
// and is no error.
func (m *herdrMux) ResizePane(ctx context.Context, paneID string, dir ResizeDir, amount int) error {
	tab, err := m.layoutPane(ctx, paneID)
	if err != nil {
		return err
	}
	var layout struct {
		Layout struct {
			Area struct {
				Width  int `json:"width"`
				Height int `json:"height"`
			} `json:"area"`
		} `json:"layout"`
	}
	if err := m.rpc.call(ctx, "pane.layout", map[string]string{"tab_id": tab.ID}, &layout); err != nil {
		return herdrLayoutError(err)
	}
	cells := layout.Layout.Area.Width
	if dir == ResizeUp || dir == ResizeDown {
		cells = layout.Layout.Area.Height
	}
	if cells <= 0 {
		return fmt.Errorf("pane.layout of %s answered a %d cell area", tab.ID, cells)
	}
	share := min(float64(amount)/float64(cells), 1)
	err = m.rpc.call(ctx, "pane.resize", map[string]any{"pane_id": paneID, "direction": string(dir), "amount": share}, nil)
	m.invalidate()
	return herdrLayoutError(err)
}
