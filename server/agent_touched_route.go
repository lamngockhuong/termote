package main

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// The files a session changed through its tool calls:
//
//	GET /api/mux/panes/{id}/agent/touched[?agent=&session=]
//
// the pane's running session, or one of its root's history. Only paths
// relative to the pane's root are returned, never a file's contents (a
// client reads those through the files routes): a path outside the root,
// under a deny dir or in the repo's git dir is left out and only counted.
// A path the journal names is compared as a string first: only one inside
// the root is ever looked up on disk (a path on a network share or another
// mount is never touched). A view-only client gets, of the files the
// session touched, the root's tracked files it may read, by name, without
// what the tool calls say (when, how often, by whom); a root it may not
// read is refused.

// touchedTTL: every client polling one session shares a read.
const touchedTTL = 4 * time.Second

// touchedJSON is one file as the client sees it. Path is relative to the
// root, slash separated.
type touchedJSON struct {
	Path      string   `json:"path"`
	Ops       []string `json:"ops,omitempty"`
	Count     int      `json:"count,omitempty"`
	LastAt    string   `json:"lastAt,omitempty"`
	Sub       bool     `json:"sub,omitempty"`
	Running   bool     `json:"running,omitempty"`
	Deleted   bool     `json:"deleted,omitempty"`
	Sensitive bool     `json:"sensitive"`
}

// touchedResponse: Skipped files were outside the root or never served;
// Truncated: only the touchedMax latest of the root are listed.
type touchedResponse struct {
	Files     []touchedJSON `json:"files"`
	Skipped   int           `json:"skipped"`
	Truncated bool          `json:"truncated"`
}

// touchedAPI holds the touched files' scanners and the shared reads.
type touchedAPI struct {
	reader *touchedReader
	reads  *ttlCache[touchedResponse]
}

// registerTouchedRoutes adds the touched files route, after
// registerHistoryRoutes.
func (a *agentAPI) registerTouchedRoutes(mux *http.ServeMux) {
	a.touched = &touchedAPI{reader: newTouchedReader(), reads: newTTLCache[touchedResponse](touchedTTL)}
	mux.HandleFunc("/api/mux/panes/{id}/agent/touched", a.handleTouched)
}

func (a *agentAPI) handleTouched(w http.ResponseWriter, r *http.Request) {
	if !a.usageRead(w, r) {
		return
	}
	root, ok := a.historyRoot(w, r)
	if !ok {
		return
	}
	s, ok := a.sessionTarget(w, r)
	if !ok {
		return
	}
	view := isViewOnly(r)
	// The pane's own session: a call waiting for its result is running.
	// Another's never got its result.
	live := r.URL.Query().Get("session") == ""
	key := strings.Join([]string{root.Root, s.Agent, s.ID, s.ClaudeDir, s.CodexHome, s.Rollout, s.RolloutID,
		map[bool]string{true: "view"}[view], map[bool]string{true: "live"}[live]}, "\x00")
	res, err := a.touched.reads.do(key, func() (touchedResponse, error) {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), filesTimeout)
		defer cancel()
		files, err := a.sessionTouched(s)
		if err != nil {
			return touchedResponse{}, err
		}
		res := a.placeTouched(root, files, live)
		if view {
			return a.viewTouched(ctx, root, res)
		}
		return res, nil
	})
	if err != nil {
		var ve touchedViewListError
		if errors.As(err, &ve) {
			a.files.error(w, "files view list", ve.err)
			return
		}
		a.agentError(w, "agent touched", err)
		return
	}
	jsonOK(w, res)
}

// sessionTouched reads every file of s. A session whose transcript is not
// written yet changed nothing.
func (a *agentAPI) sessionTouched(s AgentSession) ([]touchedFile, error) {
	files, err := a.history.sessionFiles(s)
	if errors.Is(err, errTranscriptNotWritten) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer closeSessionFiles(files)
	lists := make([][]touchedFile, 0, len(files))
	for _, f := range files {
		lists = append(lists, a.touched.reader.files(s.Agent, f))
	}
	return touchedOf(lists), nil
}

// placeTouched keeps the files inside root that the files routes would
// serve, relative to it, the touchedMax latest. A path outside root as
// written is dropped without a look at the disk; one inside is placed where
// its symlinks lead (a gone file: where its directory's lead), resolved
// once. Without live, a call that never got its result is left out.
func (a *agentAPI) placeTouched(root filesRoot, files []touchedFile, live bool) touchedResponse {
	res := touchedResponse{Files: []touchedJSON{}}
	for _, f := range files {
		if !live && f.running {
			if f.count == 0 {
				continue
			}
			f.running = false
		}
		if len(res.Files) == touchedMax {
			res.Truncated = true
			break
		}
		if _, ok := relUnder(root.Root, f.abs); !ok {
			res.Skipped++
			continue
		}
		real := touchedResolved(f.abs)
		rel, ok := relUnder(root.Root, real)
		if !ok || rel == "" {
			res.Skipped++
			continue
		}
		abs := filepath.Join(root.Root, filepath.FromSlash(rel))
		if a.files.deniedPaths(root.Root, abs, real, root.GitDir) {
			res.Skipped++
			continue
		}
		j := touchedJSON{Path: rel, Ops: f.ops.names(), Count: f.count, Sub: f.sub, Running: f.running,
			Deleted: f.deleted, Sensitive: isSensitive(abs) || isSensitive(real)}
		if !f.last.IsZero() {
			j.LastAt = f.last.UTC().Format(time.RFC3339)
		}
		res.Files = append(res.Files, j)
	}
	return res
}

// touchedResolved is where abs leads: through its symlinks when it exists,
// else through its directory's.
func touchedResolved(abs string) string {
	if real, err := evalSymlinks(abs); err == nil {
		return real
	}
	if dir, err := evalSymlinks(filepath.Dir(abs)); err == nil {
		return filepath.Join(dir, filepath.Base(abs))
	}
	return abs
}

// touchedViewListError: the root's tracked list could not be read, answered
// as the files routes answer it.
type touchedViewListError struct{ err error }

func (e touchedViewListError) Error() string { return e.err.Error() }

// viewTouched is res for a view-only client: the files of the root's
// tracked list it may read, by name only, in name order (the order of the
// changes would tell when each was made).
func (a *agentAPI) viewTouched(ctx context.Context, root filesRoot, res touchedResponse) (touchedResponse, error) {
	lists, err := a.files.findLists(ctx, root, findQuery{committed: true})
	if err != nil {
		return touchedResponse{}, touchedViewListError{err}
	}
	req := &filesRequest{ctx: ctx, root: root, view: &lists[0]}
	out := touchedResponse{Files: []touchedJSON{}}
	for _, f := range res.Files {
		if !a.files.viewHides(req, f.Path, false, false) {
			out.Files = append(out.Files, touchedJSON{Path: f.Path, Sensitive: f.Sensitive})
		}
	}
	slices.SortFunc(out.Files, func(x, y touchedJSON) int { return strings.Compare(x.Path, y.Path) })
	return out, nil
}
