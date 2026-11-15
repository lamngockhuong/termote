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
// A view-only client gets the files the Changes view would show it, the
// root's tracked files it may read, by name, without what the tool calls
// say (when, how often, by whom); a root it may not read is refused.

// touchedTTL: every client polling one session shares a read.
const touchedTTL = 2 * time.Second

// touchedJSON is one file as the client sees it. Path is relative to the
// root, slash separated.
type touchedJSON struct {
	Path      string   `json:"path"`
	Ops       []string `json:"ops,omitempty"`
	Count     int      `json:"count,omitempty"`
	LastAt    string   `json:"lastAt,omitempty"`
	Sub       bool     `json:"sub,omitempty"`
	Running   bool     `json:"running,omitempty"`
	Sensitive bool     `json:"sensitive"`
}

// touchedResponse: Skipped files were outside the root or never served;
// Truncated: only the touchedMax latest were read.
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
	key := strings.Join([]string{root.Root, s.Agent, s.ID, s.ClaudeDir, s.CodexHome, s.Rollout, s.RolloutID,
		map[bool]string{true: "view"}[view]}, "\x00")
	res, err := a.touched.reads.do(key, func() (touchedResponse, error) {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), filesTimeout)
		defer cancel()
		files, truncated, err := a.sessionTouched(s)
		if err != nil {
			return touchedResponse{}, err
		}
		res := a.placeTouched(root, files)
		res.Truncated = truncated
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
func (a *agentAPI) sessionTouched(s AgentSession) ([]touchedFile, bool, error) {
	files, err := a.history.sessionFiles(s)
	if errors.Is(err, errTranscriptNotWritten) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	defer closeSessionFiles(files)
	lists := make([][]touchedFile, 0, len(files))
	for _, f := range files {
		lists = append(lists, a.touched.reader.files(s.Agent, f))
	}
	out, truncated := touchedOf(lists)
	return out, truncated, nil
}

// placeTouched keeps the files inside root that the files routes would
// serve, relative to it. A file that still exists is placed where its
// symlinks lead; one that is gone, where its directory's lead.
func (a *agentAPI) placeTouched(root filesRoot, files []touchedFile) touchedResponse {
	res := touchedResponse{Files: []touchedJSON{}}
	for _, f := range files {
		rel, ok := inHistoryRoot(root.Root, touchedResolved(f.abs))
		if !ok || rel == "" {
			res.Skipped++
			continue
		}
		local := filepath.FromSlash(rel)
		if a.files.denied(root.Root, local, root.GitDir) {
			res.Skipped++
			continue
		}
		j := touchedJSON{Path: rel, Ops: f.ops.names(), Count: f.count, Sub: f.sub, Running: f.running,
			Sensitive: sensitivePath(root.Root, local)}
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
