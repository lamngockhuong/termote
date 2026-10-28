package main

import (
	"context"
	"errors"
	"math"
	"net/http"
)

// Pane layout: split, zoom, swap and resize one pane of a tab. Each takes
// its argument as one of a few words, read here, so a backend only ever
// gets a value it knows.

// SplitDir is where a split puts the new pane: beside the pane or under it.
type SplitDir string

// ZoomMode zooms a pane (fills its tab), unzooms it, or flips it.
type ZoomMode string

// SwapDir swaps a pane with the one before or after it in its tab's pane
// order (the pane strip's).
type SwapDir string

// ResizeDir is the way a pane's edge moves.
type ResizeDir string

const (
	SplitRight SplitDir = "right"
	SplitDown  SplitDir = "down"

	ZoomToggle ZoomMode = "toggle"
	ZoomOn     ZoomMode = "on"
	ZoomOff    ZoomMode = "off"

	SwapPrev SwapDir = "prev"
	SwapNext SwapDir = "next"

	ResizeLeft  ResizeDir = "left"
	ResizeRight ResizeDir = "right"
	ResizeUp    ResizeDir = "up"
	ResizeDown  ResizeDir = "down"
)

// maxResizeAmount bounds one resize, in terminal cells.
const maxResizeAmount = 50

// Errors of the pane routes and the layout actions. Each carries a code the
// PWA words its message from.
var (
	// errUnknownPane: no pane has the id (any more), on every pane route.
	errUnknownPane = &codedError{"unknown_pane", "unknown pane", http.StatusNotFound}
	// errPaneLayoutUnsupported: the backend, or this version of it, has no
	// such action.
	errPaneLayoutUnsupported = &codedError{"unsupported", "pane layout is not supported on this backend", http.StatusNotImplemented}
	errInvalidDirection      = &codedError{"invalid_direction", "invalid direction", http.StatusBadRequest}
	errInvalidMode           = &codedError{"invalid_mode", "invalid mode", http.StatusBadRequest}
	errInvalidAmount         = &codedError{"invalid_amount", "amount must be 1 to 50", http.StatusBadRequest}
	// errNoNeighbor: a swap of the first pane with the one before it, or of
	// the last with the one after it.
	errNoNeighbor = &codedError{"no_neighbor", "no pane on that side", http.StatusConflict}
	// errNoRoom: the window is too small for another pane (tmux).
	errNoRoom = &codedError{"no_room", "no room for another pane", http.StatusConflict}
)

// paneMissing reports whether err says a pane id names no pane: a bad id
// (inputError), or one that is not (or no longer) a pane.
func paneMissing(err error) bool {
	var ie inputError
	return errors.As(err, &ie) || errors.Is(err, errUnknownPane)
}

func parseSplitDir(s string) (SplitDir, error) {
	switch d := SplitDir(s); d {
	case SplitRight, SplitDown:
		return d, nil
	}
	return "", errInvalidDirection
}

func parseZoomMode(s string) (ZoomMode, error) {
	switch m := ZoomMode(s); m {
	case ZoomToggle, ZoomOn, ZoomOff:
		return m, nil
	}
	return "", errInvalidMode
}

func parseSwapDir(s string) (SwapDir, error) {
	switch d := SwapDir(s); d {
	case SwapPrev, SwapNext:
		return d, nil
	}
	return "", errInvalidDirection
}

func parseResizeDir(s string) (ResizeDir, error) {
	switch d := ResizeDir(s); d {
	case ResizeLeft, ResizeRight, ResizeUp, ResizeDown:
		return d, nil
	}
	return "", errInvalidDirection
}

// checkResizeAmount accepts a whole number of cells, 1 to maxResizeAmount:
// 1.5 is refused, not rounded.
func checkResizeAmount(n float64) error {
	if n != math.Trunc(n) || n < 1 || n > maxResizeAmount {
		return errInvalidAmount
	}
	return nil
}

// swapNeighbor is the id of the pane before or after pane in panes (a tab's
// pane order): errUnknownPane when pane is not there, errNoNeighbor past
// either end.
func swapNeighbor(panes []string, pane string, dir SwapDir) (string, error) {
	for i, p := range panes {
		if p != pane {
			continue
		}
		j := i + 1
		if dir == SwapPrev {
			j = i - 1
		}
		if j < 0 || j >= len(panes) {
			return "", errNoNeighbor
		}
		return panes[j], nil
	}
	return "", errUnknownPane
}

// paneLayoutAPI serves the layout routes. deny is the files routes' deny
// list, which a split's cwd is checked against as a new group's is.
type paneLayoutAPI struct {
	m    Mux
	deny []string
}

// registerPaneLayoutRoutes mounts POST /api/mux/panes/{id}/split {direction,
// cwd?}, zoom {mode}, swap {direction} and resize {direction, amount}.
// Patterns carry no method so a wrong one gets a JSON 405.
func registerPaneLayoutRoutes(mux *http.ServeMux, m Mux, deny []string) {
	a := &paneLayoutAPI{m: m, deny: deny}
	mux.HandleFunc("/api/mux/panes/{id}/split", a.handleSplit)
	mux.HandleFunc("/api/mux/panes/{id}/zoom", a.handleZoom)
	mux.HandleFunc("/api/mux/panes/{id}/swap", a.handleSwap)
	mux.HandleFunc("/api/mux/panes/{id}/resize", a.handleResize)
}

// begin checks the role, the method and the body, decoded into body.
// layoutContext bounds a layout action by muxTimeout but not by the request:
// a client that leaves mid-action must not stop it between two steps (a
// split's new pane left behind, a swap's focus not put back, a zoom half
// undone), as with reordering.
func layoutContext(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(r.Context()), muxTimeout)
}

func (a *paneLayoutAPI) begin(w http.ResponseWriter, r *http.Request, body any) bool {
	return requireWriteRole(w, r) && requireMethod(w, r, http.MethodPost) && decodeJSON(w, r, body)
}

// handleSplit opens a pane beside or under the pane. An empty cwd is the
// pane's own directory, which the backend keeps (never the home a new group
// gets); another is checked like a new group's. The directory is no
// boundary: the shell can cd anywhere.
func (a *paneLayoutAPI) handleSplit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Direction string `json:"direction"`
		Cwd       string `json:"cwd"`
	}
	if !a.begin(w, r, &body) {
		return
	}
	dir, err := parseSplitDir(body.Direction)
	if err != nil {
		muxError(w, a.m, "split pane", err)
		return
	}
	ctx, cancel := layoutContext(r)
	defer cancel()
	cwd := ""
	if body.Cwd != "" {
		if cwd, err = resolveGroupCwd(ctx, body.Cwd, a.deny); err != nil {
			muxError(w, a.m, "split pane", err)
			return
		}
	}
	id, err := a.m.SplitPane(ctx, r.PathValue("id"), dir, cwd)
	if err != nil {
		muxError(w, a.m, "split pane", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true, "id": id})
}

func (a *paneLayoutAPI) handleZoom(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if !a.begin(w, r, &body) {
		return
	}
	mode, err := parseZoomMode(body.Mode)
	if err == nil {
		ctx, cancel := layoutContext(r)
		defer cancel()
		err = a.m.ZoomPane(ctx, r.PathValue("id"), mode)
	}
	a.answer(w, "zoom pane", err)
}

func (a *paneLayoutAPI) handleSwap(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Direction string `json:"direction"`
	}
	if !a.begin(w, r, &body) {
		return
	}
	dir, err := parseSwapDir(body.Direction)
	if err == nil {
		ctx, cancel := layoutContext(r)
		defer cancel()
		err = a.m.SwapPane(ctx, r.PathValue("id"), dir)
	}
	a.answer(w, "swap pane", err)
}

func (a *paneLayoutAPI) handleResize(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Direction string  `json:"direction"`
		Amount    float64 `json:"amount"`
	}
	if !a.begin(w, r, &body) {
		return
	}
	dir, err := parseResizeDir(body.Direction)
	if err == nil {
		err = checkResizeAmount(body.Amount)
	}
	if err == nil {
		ctx, cancel := layoutContext(r)
		defer cancel()
		err = a.m.ResizePane(ctx, r.PathValue("id"), dir, int(body.Amount))
	}
	a.answer(w, "resize pane", err)
}

// answer replies {ok} or the error.
func (a *paneLayoutAPI) answer(w http.ResponseWriter, op string, err error) {
	if err != nil {
		muxError(w, a.m, op, err)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}
