package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Git worktree workspaces (/api/mux/worktrees*, Herdr only): list a
// workspace's worktrees and its local branches, create a worktree (a new
// branch, or an existing one checked out as it is), open an existing
// worktree as a workspace, and remove a worktree workspace with its checkout.

// worktreeMux is a backend that manages git worktree workspaces (Herdr).
type worktreeMux interface {
	// ValidGroupID reports whether id has the form of a group id.
	ValidGroupID(id string) bool
	// ListWorktrees lists the worktrees of sourceID's repository.
	ListWorktrees(ctx context.Context, sourceID string) (WorktreeList, error)
	// CreateWorktree checks out branch (made from base when it is new) in a
	// new worktree of sourceID's repository and opens it as a workspace.
	CreateWorktree(ctx context.Context, sourceID, branch, base, label string) (newID string, err error)
	// OpenWorktree opens the existing worktree of branch as a workspace.
	OpenWorktree(ctx context.Context, sourceID, branch string) (newID string, alreadyOpen bool, err error)
	// RemoveWorktree deletes groupID's checkout and closes the workspace,
	// ending its processes.
	RemoveWorktree(ctx context.Context, groupID string, force bool) error
}

// WorktreeList is a repository's worktrees, as the GET answers them.
type WorktreeList struct {
	RepoName  string     `json:"repoName"`
	RepoRoot  string     `json:"-"` // for the branch list only, never sent
	Worktrees []Worktree `json:"worktrees"`
	Branches  []string   `json:"branches"` // filled by the route
}

// Worktree is one checkout of the repository, its main one included.
type Worktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
	Linked bool   `json:"linked"`
	// Openable: a linked worktree on a valid branch, not bare, prunable or
	// detached, which Open worktree can open by its branch.
	Openable bool   `json:"openable"`
	GroupID  string `json:"groupId,omitempty"` // the workspace showing it
}

const (
	// maxBranchName caps a branch name, in bytes.
	maxBranchName = 255
	// maxBranchList is how many local branches the GET lists, newest first.
	maxBranchList = 500
	// branchListLimit caps git's output for the branch list.
	branchListLimit = 160 << 10
)

// worktreeTimeout bounds a create or a remove once it holds the slot: git
// (a checkout, hooks, LFS) answers only when done. worktreeLockWait bounds
// the wait for the slot, worktreeCallTimeout the other Herdr calls. Tests
// shorten them.
var (
	worktreeTimeout     = 60 * time.Second
	worktreeLockWait    = muxTimeout
	worktreeCallTimeout = muxTimeout
)

// Errors of the worktree routes; Herdr's own message is logged, never sent.
var (
	errWorktreeUnsupported  = &codedError{"unsupported", "this backend cannot manage worktrees", http.StatusNotImplemented}
	errWorktreeName         = &codedError{"invalid_name", "invalid branch name", http.StatusBadRequest}
	errWorktreeRequest      = &codedError{"invalid_request", "force, path and branch are required", http.StatusBadRequest}
	errWorktreeNotFound     = &codedError{"not_found", "no such worktree", http.StatusNotFound}
	errWorktreeNotGit       = &codedError{"not_git", "this workspace is not in a git repository", http.StatusConflict}
	errWorktreeLinkedSource = &codedError{"linked_source", "the source workspace is a linked worktree", http.StatusConflict}
	errWorktreeNotLinked    = &codedError{"not_linked", "this workspace is not a worktree Herdr manages", http.StatusConflict}
	errWorktreeChanged      = &codedError{"changed", "the worktree changed", http.StatusConflict}
	errWorktreeBranchExists = &codedError{"branch_exists", "the branch exists, so it is checked out without a base", http.StatusConflict}
	errWorktreeAmbiguous    = &codedError{"ambiguous", "more than one worktree uses this branch", http.StatusConflict}
	errWorktreeCreateFailed = &codedError{"create_failed", "git could not create the worktree", http.StatusConflict}
	errWorktreeOpenFailed   = &codedError{"open_failed", "the worktree exists but its workspace did not open", http.StatusConflict}
	errWorktreeDirty        = &codedError{"dirty", "the worktree has uncommitted or untracked changes", http.StatusConflict}
	errWorktreeBusy         = &codedError{"busy", "another worktree change is still running; try again", http.StatusServiceUnavailable}
	errWorktreeUnknown      = &codedError{"unknown", "Herdr did not answer in time; check the list", http.StatusGatewayTimeout}
	errWorktreeFailed       = &codedError{"worktree_failed", "could not change the worktree", http.StatusInternalServerError}
)

// validBranchName accepts what `git check-ref-format --branch` accepts,
// and refuses more: every Unicode control, format (bidi, zero-width) and
// space character, so a name cannot show as another one in a confirmation.
func validBranchName(s string) bool {
	if s == "" || len(s) > maxBranchName || !utf8.ValidString(s) || s == "@" || s == "HEAD" ||
		strings.HasPrefix(s, "-") || strings.HasPrefix(s, "/") || strings.HasSuffix(s, "/") ||
		strings.HasSuffix(s, ".") || strings.Contains(s, "..") || strings.Contains(s, "@{") ||
		strings.Contains(s, "//") || strings.ContainsAny(s, "~^:?*[\\") {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.IsSpace(r) {
			return false
		}
	}
	for _, c := range strings.Split(s, "/") {
		if strings.HasPrefix(c, ".") || strings.HasSuffix(c, ".lock") {
			return false
		}
	}
	return true
}

// validBase accepts the base of a new branch: empty (Herdr uses HEAD),
// HEAD, or a branch name. Herdr passes it to git without "--" before it.
func validBase(s string) bool {
	return s == "" || s == "HEAD" || validBranchName(s)
}

// worktreeAPI serves /api/mux/worktrees*. Creates, opens and removes run one
// at a time (sem has one slot), apart from the group routes' mutex.
type worktreeAPI struct {
	m       Mux
	wm      worktreeMux // nil when the backend has none
	git     *gitRunner
	allowed hostAllowlist
	sem     chan struct{}
}

// registerWorktreeRoutes mounts the worktree routes. git is the files
// routes' runner (the branch list and the existing-branch check). Patterns
// carry no method so a wrong one gets a JSON 405.
func registerWorktreeRoutes(mux *http.ServeMux, m Mux, git *gitRunner, allowed hostAllowlist) {
	wm, _ := m.(worktreeMux)
	a := &worktreeAPI{m: m, wm: wm, git: git, allowed: allowed, sem: make(chan struct{}, 1)}
	mux.HandleFunc("/api/mux/worktrees", a.handleWorktrees)
	mux.HandleFunc("/api/mux/worktrees/open", a.handleOpen)
	mux.HandleFunc("/api/mux/worktrees/{id}", a.handleRemove)
}

// supported: the backend manages worktrees and says so now (its version).
func (a *worktreeAPI) supported() bool {
	return a.wm != nil && a.m.Caps().Worktrees
}

func (a *worktreeAPI) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.handleList(w, r)
	case http.MethodPost:
		a.handleCreate(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleList answers a workspace's worktrees and its repository's local
// branches (the bases a new branch can start from). A read, but it names
// paths on the host: another site's page gets nothing.
func (a *worktreeAPI) handleList(w http.ResponseWriter, r *http.Request) {
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !a.supported() {
		worktreeFailure(w, "list worktrees", errWorktreeUnsupported)
		return
	}
	id := r.URL.Query().Get("groupId")
	if !a.wm.ValidGroupID(id) {
		worktreeFailure(w, "list worktrees", errInvalidGroupID)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), worktreeCallTimeout)
	defer cancel()
	list, err := a.wm.ListWorktrees(ctx, id)
	if err != nil {
		worktreeFailure(w, "list worktrees", listFailure(err))
		return
	}
	list.Branches = a.branches(r.Context(), list.RepoRoot)
	if list.Worktrees == nil {
		list.Worktrees = []Worktree{}
	}
	jsonOK(w, list)
}

// branches lists the repository's local branches, most recently committed
// first, without the names validBranchName refuses. A failure (git refused
// the repository) gives none.
func (a *worktreeAPI) branches(ctx context.Context, root string) []string {
	out := []string{}
	if root == "" {
		return out
	}
	raw, truncated, err := a.git.output(ctx, gitCall{root: root, heavy: true, noBackoff: true, limit: branchListLimit},
		"for-each-ref", "--count=500", "--sort=-committerdate", "--format=%(refname:lstrip=2)", "refs/heads")
	if err != nil {
		log.Printf("worktrees: branch list in %s: %v", root, err)
		return out
	}
	lines := strings.Split(string(raw), "\n")
	if truncated && len(lines) > 0 {
		lines = lines[:len(lines)-1] // cut short
	}
	for _, l := range lines {
		if validBranchName(l) && len(out) < maxBranchList {
			out = append(out, l)
		}
	}
	return out
}

func (a *worktreeAPI) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !requireWriteRole(w, r) {
		return
	}
	if !a.supported() {
		worktreeFailure(w, "create worktree", errWorktreeUnsupported)
		return
	}
	var body struct {
		GroupID string `json:"groupId"`
		Branch  string `json:"branch"`
		Base    string `json:"base"`
		Label   string `json:"label"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	switch {
	case !a.wm.ValidGroupID(body.GroupID):
		worktreeFailure(w, "create worktree", errInvalidGroupID)
		return
	case !validBranchName(body.Branch) || !validBase(body.Base) || body.Label != "" && !validateTmuxTarget(body.Label):
		worktreeFailure(w, "create worktree", errWorktreeName)
		return
	}
	ctx, release, ok := a.acquire(w, r, worktreeTimeout)
	if !ok {
		return
	}
	defer release()
	if body.Base != "" {
		// Herdr ignores the base of a branch that exists: say so rather
		// than check out something other than what was asked.
		exists, err := a.branchExists(ctx, body.GroupID, body.Branch)
		if err != nil {
			worktreeFailure(w, "create worktree", err)
			return
		}
		if exists {
			worktreeFailure(w, "create worktree", errWorktreeBranchExists)
			return
		}
	}
	id, err := a.wm.CreateWorktree(ctx, body.GroupID, body.Branch, body.Base, body.Label)
	if err != nil {
		worktreeFailure(w, "create worktree", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true, "id": id})
}

// branchExists reports whether branch is a local branch of the source's
// repository (git show-ref --verify, exit 1: it is not).
func (a *worktreeAPI) branchExists(ctx context.Context, sourceID, branch string) (bool, error) {
	lctx, cancel := context.WithTimeout(ctx, worktreeCallTimeout)
	defer cancel()
	list, err := a.wm.ListWorktrees(lctx, sourceID)
	if err != nil {
		return false, listFailure(err)
	}
	if list.RepoRoot == "" {
		return false, errors.New("worktree.list named no repository root")
	}
	_, _, err = a.git.output(ctx, gitCall{root: list.RepoRoot}, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() == 1 {
		return false, nil
	}
	return err == nil, err
}

func (a *worktreeAPI) handleOpen(w http.ResponseWriter, r *http.Request) {
	if !requireWriteRole(w, r) || !requireMethod(w, r, http.MethodPost) {
		return
	}
	if !a.supported() {
		worktreeFailure(w, "open worktree", errWorktreeUnsupported)
		return
	}
	var body struct {
		GroupID string `json:"groupId"`
		Branch  string `json:"branch"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	switch {
	case !a.wm.ValidGroupID(body.GroupID):
		worktreeFailure(w, "open worktree", errInvalidGroupID)
		return
	case !validBranchName(body.Branch):
		worktreeFailure(w, "open worktree", errWorktreeName)
		return
	}
	ctx, release, ok := a.acquire(w, r, worktreeCallTimeout)
	if !ok {
		return
	}
	defer release()
	id, already, err := a.wm.OpenWorktree(ctx, body.GroupID, body.Branch)
	if err != nil {
		worktreeFailure(w, "open worktree", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true, "id": id, "alreadyOpen": already})
}

// handleRemove removes the worktree the client confirmed: the request names
// its path and branch, and nothing is removed unless the workspace still
// shows that checkout.
func (a *worktreeAPI) handleRemove(w http.ResponseWriter, r *http.Request) {
	if !requireWriteRole(w, r) || !requireMethod(w, r, http.MethodDelete) {
		return
	}
	if !a.supported() {
		worktreeFailure(w, "remove worktree", errWorktreeUnsupported)
		return
	}
	id := r.PathValue("id")
	if !a.wm.ValidGroupID(id) {
		worktreeFailure(w, "remove worktree", errInvalidGroupID)
		return
	}
	var body struct {
		Force  *bool   `json:"force"`
		Path   *string `json:"path"`
		Branch *string `json:"branch"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Force == nil || body.Path == nil ||
		*body.Path == "" || body.Branch == nil {
		worktreeFailure(w, "remove worktree", errWorktreeRequest)
		return
	}
	ctx, release, ok := a.acquire(w, r, worktreeTimeout)
	if !ok {
		return
	}
	defer release()
	lctx, cancel := context.WithTimeout(ctx, worktreeCallTimeout)
	list, err := a.wm.ListWorktrees(lctx, id)
	cancel()
	err = listFailure(err)
	if err == nil {
		err = errWorktreeChanged
		for _, wt := range list.Worktrees {
			if wt.GroupID == id {
				err = confirmedWorktree(wt, *body.Path, *body.Branch)
				break
			}
		}
	}
	if err == nil {
		err = a.wm.RemoveWorktree(ctx, id, *body.Force)
	}
	if err != nil {
		worktreeFailure(w, "remove worktree", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

// confirmedWorktree checks that the worktree a workspace shows is still the
// linked checkout the client confirmed removing.
func confirmedWorktree(wt Worktree, path, branch string) error {
	switch {
	case !wt.Linked:
		return errWorktreeNotLinked
	case wt.Path != path || wt.Branch != branch:
		return errWorktreeChanged
	}
	return nil
}

// acquire takes the one slot, waiting at most worktreeLockWait, then
// extends the request's read deadline and returns the context the change
// runs under: it outlives the client (the change finishes, and the client
// reads the list again) and is bounded by limit.
func (a *worktreeAPI) acquire(w http.ResponseWriter, r *http.Request, limit time.Duration) (context.Context, func(), bool) {
	timer := time.NewTimer(worktreeLockWait)
	defer timer.Stop()
	select {
	case a.sem <- struct{}{}:
	case <-timer.C:
		worktreeFailure(w, "worktree", errWorktreeBusy)
		return nil, nil, false
	case <-r.Context().Done():
		worktreeFailure(w, "worktree", errWorktreeBusy)
		return nil, nil, false
	}
	// Fails only on a writer without a connection (tests).
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(limit + muxTimeout))
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), limit)
	return ctx, func() { cancel(); <-a.sem }, true
}

// listFailure is a worktree.list error: one that ran out of time changed
// nothing, so it is busy (try again), not unknown.
func listFailure(err error) error {
	if isContextError(err) {
		log.Printf("herdr worktree.list: %v", err)
		return errWorktreeBusy
	}
	return err
}

func isContextError(err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)
}

// worktreeFailure answers err: a change that ran out of time may still
// complete in Herdr (unknown); a coded error with its code; anything else is
// logged and answered generically.
func worktreeFailure(w http.ResponseWriter, op string, err error) {
	var ce *codedError
	switch {
	case isContextError(err):
		log.Printf("herdr %s: %v", op, err)
		err = errWorktreeUnknown
	case errors.Is(err, errUnsupported):
		err = errWorktreeUnsupported
	case !errors.As(err, &ce):
		log.Printf("herdr %s: %v", op, err)
		err = errWorktreeFailed
	}
	errors.As(err, &ce)
	jsonErrorCode(w, ce.code, ce.msg, ce.status)
}
