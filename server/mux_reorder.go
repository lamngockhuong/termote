package main

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Errors of the move routes and of a tab close or rename whose key no longer
// names the tab. Each carries a code the PWA words its message from.
var (
	errInvalidIndex       = &codedError{"invalid_index", "invalid index; the list may have changed", http.StatusBadRequest}
	errInvalidTabID       = &codedError{"invalid_tab_id", "invalid tab id", http.StatusBadRequest}
	errUnknownTab         = &codedError{"unknown_tab", "unknown tab", http.StatusNotFound}
	errLinkedWorktree     = &codedError{"linked_worktree", "a linked worktree moves with its repository's workspace", http.StatusConflict}
	errReorderUnsupported = &codedError{"unsupported", "reordering is not supported on this backend", http.StatusNotImplemented}
	errReorderBusy        = &codedError{"busy", "another move is still running; try again", http.StatusServiceUnavailable}
	errTabChanged         = &codedError{"changed", "the tab changed; try again", http.StatusConflict}
)

// reorderLockWait bounds the wait for another move to finish; a var so tests
// can shorten it.
var reorderLockWait = muxTimeout

// reorderAPI serves the move routes. Moves run one at a time: each reads the
// order, then changes it, and a second one in between would land off by one.
type reorderAPI struct {
	m   Mux
	sem chan struct{}
}

// registerReorderRoutes mounts POST /api/mux/tabs/{id}/move and
// /api/mux/groups/{id}/move, both {index}. Patterns carry no method so a
// wrong one gets a JSON 405.
func registerReorderRoutes(mux *http.ServeMux, m Mux) {
	a := &reorderAPI{m: m, sem: make(chan struct{}, 1)}
	mux.HandleFunc("/api/mux/tabs/{id}/move", a.handleMoveTab)
	mux.HandleFunc("/api/mux/groups/{id}/move", a.handleMoveGroup)
}

func (a *reorderAPI) handleMoveTab(w http.ResponseWriter, r *http.Request) {
	a.handle(w, r, "move tab", a.m.Caps().ReorderTabs, func(ctx context.Context, id string, index int) (string, error) {
		return a.m.MoveTab(ctx, id, index)
	})
}

func (a *reorderAPI) handleMoveGroup(w http.ResponseWriter, r *http.Request) {
	a.handle(w, r, "move group", a.m.Caps().ReorderGroups, func(ctx context.Context, id string, index int) (string, error) {
		return id, a.m.MoveGroup(ctx, id, index)
	})
}

// handle runs one move: checks, the slot, then the backend call under a
// context the client leaving does not cancel, so a move is never cut between
// its command and its read-back.
func (a *reorderAPI) handle(w http.ResponseWriter, r *http.Request, op string, supported bool,
	move func(ctx context.Context, id string, index int) (string, error)) {
	if !requireWriteRole(w, r) || !requireMethod(w, r, http.MethodPost) {
		return
	}
	if !supported {
		muxError(w, a.m, op, errReorderUnsupported)
		return
	}
	var body struct {
		Index *int `json:"index"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Index == nil || *body.Index < 0 {
		muxError(w, a.m, op, errInvalidIndex)
		return
	}
	timer := time.NewTimer(reorderLockWait)
	defer timer.Stop()
	select {
	case a.sem <- struct{}{}:
		defer func() { <-a.sem }()
	case <-timer.C:
		muxError(w, a.m, op, errReorderBusy)
		return
	case <-r.Context().Done():
		muxError(w, a.m, op, errReorderBusy)
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), muxTimeout)
	defer cancel()
	id, err := move(ctx, r.PathValue("id"), *body.Index)
	if err != nil {
		muxError(w, a.m, op, reorderError(err))
		return
	}
	jsonOK(w, map[string]any{"ok": true, "id": id})
}

// reorderError is muxError with an operation the backend lacks answered with
// a code too, as every other failure of these routes is.
func reorderError(err error) error {
	if errors.Is(err, errUnsupported) {
		return errReorderUnsupported
	}
	return err
}
