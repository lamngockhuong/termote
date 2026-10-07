package main

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
)

// Errors of the group routes. Each carries a code the PWA words its message
// from; the same codes as the files routes where they mean the same.
var (
	errInvalidGroupName  = &codedError{"invalid_name", "invalid name", http.StatusBadRequest}
	errInvalidGroupID    = &codedError{"invalid_group_id", "invalid group id", http.StatusBadRequest}
	errUnknownGroup      = &codedError{"unknown_group", "unknown group", http.StatusNotFound}
	errGroupExists       = &codedError{"exists", "a group with this name already exists", http.StatusConflict}
	errDefaultSession    = &codedError{"default_session", "the default session cannot be renamed", http.StatusConflict}
	errHasWorktrees      = &codedError{"has_worktrees", "this workspace has linked worktrees; close it in Herdr", http.StatusConflict}
	errGroupsUnsupported = &codedError{"unsupported", "groups cannot be changed on this backend", http.StatusNotImplemented}
	errInvalidCwd        = &codedError{"invalid_cwd", "the directory must be an absolute path on this host", http.StatusBadRequest}
	errCwdNotFound       = &codedError{"not_found", "no such directory", http.StatusBadRequest}
	errCwdNotDirectory   = &codedError{"not_directory", "not a directory", http.StatusConflict}
	errCwdNotAllowed     = &codedError{"not_allowed", "this directory is not allowed", http.StatusForbidden}
	errCwdBusy           = &codedError{"busy", "the directory did not answer in time; try again", http.StatusServiceUnavailable}
	errGroupsBusy        = &codedError{"busy", "another group change is still running; try again", http.StatusServiceUnavailable}
)

// groupAPI serves /api/mux/groups*. Creating, renaming and closing run one
// at a time, so a client that repeats a request does not open shells in
// parallel.
type groupAPI struct {
	m    Mux
	deny []string
	mu   sync.Mutex
}

// registerGroupRoutes mounts the group routes. deny is the files routes'
// deny list (system dirs, termote's own dirs, both as given and resolved): a
// new group never starts in one of them. Patterns carry no method so a wrong
// one gets a JSON 405.
func registerGroupRoutes(mux *http.ServeMux, m Mux, deny []string) {
	g := &groupAPI{m: m, deny: deny}
	mux.HandleFunc("/api/mux/groups", g.handleCreate)
	mux.HandleFunc("/api/mux/groups/{id}", g.handleGroup)
}

func (g *groupAPI) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !requireWriteRole(w, r) || !requireMethod(w, r, http.MethodPost) {
		return
	}
	var body struct {
		Name string `json:"name"`
		Cwd  string `json:"cwd"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
	defer cancel()
	if !validateTmuxTarget(body.Name) {
		groupError(w, g.m, "new group", errInvalidGroupName)
		return
	}
	cwd, err := resolveGroupCwd(ctx, body.Cwd, g.deny)
	if err != nil {
		groupError(w, g.m, "new group", err)
		return
	}
	if !g.lock(ctx) {
		groupError(w, g.m, "new group", errGroupsBusy)
		return
	}
	defer g.mu.Unlock()
	id, err := g.m.NewGroup(ctx, body.Name, cwd)
	if err != nil {
		groupError(w, g.m, "new group", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true, "id": id})
}

func (g *groupAPI) handleGroup(w http.ResponseWriter, r *http.Request) {
	if !requireWriteRole(w, r) {
		return
	}
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
	defer cancel()
	switch r.Method {
	case http.MethodPatch:
		var body struct {
			Name string `json:"name"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		if !validateTmuxTarget(body.Name) {
			groupError(w, g.m, "rename group", errInvalidGroupName)
			return
		}
		if !g.lock(ctx) {
			groupError(w, g.m, "rename group", errGroupsBusy)
			return
		}
		defer g.mu.Unlock()
		if err := g.m.RenameGroup(ctx, id, body.Name); err != nil {
			groupError(w, g.m, "rename group", err)
			return
		}
	case http.MethodDelete:
		if !g.lock(ctx) {
			groupError(w, g.m, "close group", errGroupsBusy)
			return
		}
		defer g.mu.Unlock()
		if err := g.m.CloseGroup(ctx, id); err != nil {
			groupError(w, g.m, "close group", err)
			return
		}
	default:
		w.Header().Set("Allow", "PATCH, DELETE")
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

// lock takes the group mutex; false (not held) when ctx ended while waiting,
// since a backend call would then fail on the dead context.
func (g *groupAPI) lock(ctx context.Context) bool {
	g.mu.Lock()
	if ctx.Err() != nil {
		g.mu.Unlock()
		return false
	}
	return true
}

// groupError is muxError with an operation the backend lacks answered with
// a code too, as every other failure of these routes is.
func groupError(w http.ResponseWriter, m Mux, op string, err error) {
	if errors.Is(err, errUnsupported) {
		err = errGroupsUnsupported
	}
	muxError(w, m, op, err)
}

// resolveGroupCwd checks the directory a new group starts in and returns it
// with its symlinks resolved; empty is the server user's home directory.
// This keeps a mistyped or unwanted directory out, it is no security
// boundary: the shell that opens can cd anywhere, and signing in (plus
// requireWriteRole) is what guards it. The checks run in a goroutine bounded
// by ctx, since a hung network mount would otherwise hold the request.
func resolveGroupCwd(ctx context.Context, cwd string, deny []string) (string, error) {
	if cwd == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		cwd = home
	}
	if !validCwdForm(cwd, runtime.GOOS == "windows") {
		return "", errInvalidCwd
	}
	type result struct {
		dir string
		err error
	}
	done := make(chan result, 1)
	go func() {
		dir, err := groupCwdCheck(filepath.Clean(cwd), deny)
		done <- result{dir, err}
	}()
	select {
	case r := <-done:
		return r.dir, r.err
	case <-ctx.Done():
		return "", errCwdBusy
	}
}

// validCwdForm accepts an absolute path, on Windows only one on a drive
// letter: a UNC path (\\host\share, \\?\, \\.\) would make the first stat
// open an SMB connection to that host and send it the user's NTLM hash.
func validCwdForm(p string, windows bool) bool {
	if strings.ContainsRune(p, 0) || invalidTmuxChars.MatchString(p) {
		return false
	}
	if !windows {
		return strings.HasPrefix(p, "/")
	}
	if len(p) < 3 || p[1] != ':' || (p[2] != '\\' && p[2] != '/') {
		return false
	}
	c := p[0] | 0x20
	return c >= 'a' && c <= 'z'
}

// groupCwdCheck is checkGroupCwd; tests replace it with one that hangs.
var groupCwdCheck = checkGroupCwd

// checkGroupCwd resolves dir and refuses one that is missing, not a
// directory, or under a denied dir, as given or resolved.
func checkGroupCwd(dir string, deny []string) (string, error) {
	real, err := filepath.EvalSymlinks(dir)
	if err == nil {
		var info os.FileInfo
		if info, err = os.Stat(real); err == nil && !info.IsDir() {
			return "", errCwdNotDirectory
		}
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", errCwdNotFound
	case errors.Is(err, syscall.ENOTDIR):
		return "", errCwdNotDirectory
	case err != nil:
		return "", errCwdNotAllowed
	}
	for _, p := range []string{dir, real} {
		for _, d := range deny {
			if underDir(d, p) {
				return "", errCwdNotAllowed
			}
		}
	}
	return real, nil
}
