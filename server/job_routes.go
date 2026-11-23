package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// /api/mux/jobs: the job ledger (job_store.go). Every client reads it; a
// view-only one gets each job's title, state, pane and branch only, never
// its prompt, note, directory or history. A full client (and the CLI over
// the local socket) adds, edits and removes jobs; only the CLI writes their
// history (/event) or the worktree a start made, whose directory the server
// reads from its own worktree list, never from the request.
//
// What the ledger does not store is read for each request: whether the
// pane still runs the job's agent (job_identity.go), what it does, and
// whether a turn ended that the orchestrator has not read, from the
// transcript's last entry, so a turn that ended while nobody waited, or
// while the server was down, still counts.

// jobLive is what a job's agent does now.
type jobLive struct {
	// Status: working, blocked, background (only waits for background
	// work), idle, gone (the pane no longer runs the job's agent), unknown
	// (it could not be read), or empty for a job without an agent.
	Status string `json:"status,omitempty"`
	PaneID string `json:"paneId,omitempty"`
	Ref    string `json:"ref,omitempty"`
	// Unread: a turn ended that the orchestrator has not read.
	Unread     bool   `json:"unread,omitempty"`
	Background string `json:"background,omitempty"`
	// LastTS: the agent's newest entry (never a message of the user's),
	// which a read sends back (full clients only).
	LastTS string `json:"lastTs,omitempty"`
	// EntryTS: the agent's newest transcript entry, a subagent's writes
	// left out: what tells one dialog from the next for wait --job.
	EntryTS string `json:"entryTs,omitempty"`
	// Dir: the pane's folder now (full clients only); Branch: its git
	// branch as the overview last read it in the background (never a git
	// run in the request), empty until read.
	Dir    string `json:"dir,omitempty"`
	Branch string `json:"branch,omitempty"`
	// branchHidden: a view-only client may not read the folder's branch
	// (a home dir, as the overview's changes)
	branchHidden bool
}

type jobView struct {
	job
	Live jobLive `json:"live"`
}

// jobBrief is a job as a view-only client sees it: never the prompt, the
// note, a directory or the history.
type jobBrief struct {
	ID      string    `json:"id"`
	Title   string    `json:"title"`
	State   string    `json:"state"`
	Branch  string    `json:"branch,omitempty"`
	Live    jobLive   `json:"live"`
	Updated time.Time `json:"updated"`
}

// jobWorktreeInput names the worktree a start made: the workspace it was
// made from and its branch. The server finds its directory.
type jobWorktreeInput struct {
	Source string `json:"source"`
	Branch string `json:"branch"`
	Base   string `json:"base"`
}

type jobInput struct {
	Title     *string           `json:"title"`
	Prompt    *string           `json:"prompt"`
	Note      *string           `json:"note"`
	State     *string           `json:"state"`
	Pane      *string           `json:"pane"`
	CreatedBy string            `json:"createdBy"`
	Workspace string            `json:"workspace"`
	Worktree  *jobWorktreeInput `json:"worktree"`
	Updated   string            `json:"updated"`
}

// jobEventInput is one history line the CLI adds. read carries the
// cursor and the last entry time of what it read; reported, the dialog
// wait --job reported; diff, what diff --stat counted.
type jobEventInput struct {
	Kind   string   `json:"kind"`
	Text   string   `json:"text"`
	LastTS string   `json:"lastTs"`
	Cursor string   `json:"cursor"`
	Sig    string   `json:"sig"`
	Diff   *jobDiff `json:"diff"`
}

// jobEventKinds the CLI may add; the others the server writes itself.
var jobEventKinds = map[string]bool{"sent": true, "read": true, "answered": true, "stopped": true, "diff": true,
	"reported": true, "started": true, "continued": true}

func (a *agentAPI) registerJobRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/mux/jobs", a.handleJobs)
	mux.HandleFunc("/api/mux/jobs/{id}", a.handleJob)
	mux.HandleFunc("/api/mux/jobs/{id}/event", a.handleJobEvent)
	mux.HandleFunc("/api/mux/jobs/{id}/grants", a.handleGrants)
	mux.HandleFunc("/api/mux/jobs/{id}/grants/{gid}", a.handleGrants)
}

func (a *agentAPI) handleJobs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if msg := crossSiteRejection(a.allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		if a.jobs == nil {
			writeJobError(w, errJobsUnavailable)
			return
		}
		a.listJobs(w, r)
	case http.MethodPost:
		if !requireWriteRole(w, r) {
			return
		}
		var in jobInput
		if !decodeJobBody(w, r, &in) {
			return
		}
		if a.jobs == nil {
			writeJobError(w, errJobsUnavailable)
			return
		}
		j, err := a.newJob(r, in)
		if err != nil {
			writeJobError(w, err)
			return
		}
		if j, err = a.jobs.create(j); err != nil {
			writeJobError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{"job": a.viewJob(j)})
	default:
		w.Header().Set("Allow", "GET, POST")
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *agentAPI) handleJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "PATCH, DELETE")
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !requireWriteRole(w, r) {
		return
	}
	var in jobInput
	if r.Method == http.MethodPatch && !decodeJobBody(w, r, &in) {
		return
	}
	if a.jobs == nil {
		writeJobError(w, errJobsUnavailable)
		return
	}
	id := r.PathValue("id")
	if !validTemplateID(id) {
		writeJobError(w, errJobNotFound)
		return
	}
	socket := isLocalSocket(r.Context())
	if r.Method == http.MethodDelete {
		updated := r.URL.Query().Get("updated")
		if updated == "" && !socket {
			writeJobError(w, invalidJob("updated is required"))
			return
		}
		if err := a.jobs.remove(id, updated); err != nil {
			writeJobError(w, err)
			return
		}
		jsonOK(w, map[string]bool{"ok": true})
		return
	}
	if in.Updated == "" && !socket {
		writeJobError(w, invalidJob("updated is required"))
		return
	}
	// Resolved before the store's lock: the pane's agent and the worktree.
	var agent *jobAgent
	if in.Pane != nil {
		ag, err := a.jobAgentFor(*in.Pane)
		if err != nil {
			writeJobError(w, err)
			return
		}
		agent = &ag
	}
	tree, err := a.jobTreeFor(r, in.Worktree)
	if err != nil {
		writeJobError(w, err)
		return
	}
	base := a.readMark(agent)
	j, err := a.jobs.update(id, in.Updated, func(j *job) error {
		if err := applyJobInput(j, in); err != nil {
			return err
		}
		if in.Note != nil {
			a.jobs.addEvent(j, "note", "")
		}
		if in.State != nil {
			a.jobs.addEvent(j, "state", *in.State)
		}
		if agent != nil {
			a.giveJob(j, *agent, base)
		}
		if tree != nil {
			j.Worktree = tree
		}
		if jobFinished(j.State) {
			revokeGrants(j, a.jobs.now())
		}
		return nil
	})
	if err != nil {
		writeJobError(w, err)
		return
	}
	jsonOK(w, map[string]any{"job": a.viewJob(j)})
}

// giveJob makes ag the agent of j: every grant of j ends with the agent it
// was pinned to, and what the agent wrote before counts as read.
func (a *agentAPI) giveJob(j *job, ag jobAgent, base readMark) {
	if j.Agent != nil && j.Agent.Key == ag.Key && j.Agent.PID == ag.PID && j.Agent.Start == ag.Start && j.Agent.Session == ag.Session {
		return
	}
	if j.Agent != nil {
		revokeGrants(j, a.jobs.now())
	}
	j.Agent = &ag
	j.ReadTS, j.ReadConv, j.Reported = base.ts, base.conv, ""
	a.jobs.addEvent(j, "agent", ag.Ref)
}

// revokeGrants ends every grant of j still in force.
func revokeGrants(j *job, now time.Time) {
	for i := range j.Grants {
		if j.Grants[i].Revoked == "" {
			j.Grants[i].Revoked = now.UTC().Format(activityTimeFormat)
		}
	}
}

func (a *agentAPI) handleJobEvent(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if !requireWriteRole(w, r) {
		return
	}
	// The history is the orchestrator's: a browser never writes it.
	if !isLocalSocket(r.Context()) {
		jsonErrorCode(w, "socket_only", "only termote agents adds to a job's history", http.StatusForbidden)
		return
	}
	var in jobEventInput
	if !decodeJobBody(w, r, &in) {
		return
	}
	if a.jobs == nil {
		writeJobError(w, errJobsUnavailable)
		return
	}
	if !jobEventKinds[in.Kind] {
		writeJobError(w, invalidJob("unknown event"))
		return
	}
	id := r.PathValue("id")
	if !validTemplateID(id) {
		writeJobError(w, errJobNotFound)
		return
	}
	conv := ""
	if in.Kind == "read" {
		c, ok := decodeCursor(in.Cursor)
		if !ok {
			writeJobError(w, invalidJob("read needs the cursor of what was read"))
			return
		}
		conv = c.Session
	}
	j, err := a.jobs.update(id, "", func(j *job) error {
		switch in.Kind {
		case "read":
			// Only ever forward: a read that saw less than one recorded
			// later changes nothing.
			if conv == j.ReadConv && !tsAfter(in.LastTS, j.ReadTS) {
				return nil
			}
			j.ReadConv, j.ReadTS = conv, in.LastTS
		case "reported":
			j.Reported = clipJobText(in.Sig, 128)
			return nil
		case "diff":
			if in.Diff != nil {
				d := *in.Diff
				d.Head = clipJobText(d.Head, 64)
				d.At = a.jobs.now().UTC().Format(activityTimeFormat)
				j.Diff = &d
			}
		}
		a.jobs.addEvent(j, in.Kind, in.Text)
		return nil
	})
	if err != nil {
		writeJobError(w, err)
		return
	}
	jsonOK(w, map[string]any{"job": a.viewJob(j)})
}

// tsAfter: a is a later time than b (RFC 3339; an empty b is before all).
func tsAfter(a, b string) bool {
	ta, err := time.Parse(time.RFC3339Nano, a)
	if err != nil {
		return false
	}
	tb, err := time.Parse(time.RFC3339Nano, b)
	return err != nil || ta.After(tb)
}

// newJob is a job as in asks for it. A browser's is the user's ("pwa");
// only the CLI names who made it, or a worktree.
func (a *agentAPI) newJob(r *http.Request, in jobInput) (job, error) {
	socket := isLocalSocket(r.Context())
	j := job{State: "todo", CreatedBy: "pwa"}
	if socket {
		j.CreatedBy = "cli"
		if by := clipJobText(in.CreatedBy, 128); by != "" {
			j.CreatedBy = by
		}
	}
	if in.Title == nil {
		return job{}, invalidJob("the title is empty")
	}
	if err := applyJobInput(&j, in); err != nil {
		return job{}, err
	}
	j.Workspace = clipJobText(in.Workspace, 256)
	if in.Pane != nil {
		ag, err := a.jobAgentFor(*in.Pane)
		if err != nil {
			return job{}, err
		}
		base := a.readMark(&ag)
		j.Agent = &ag
		j.ReadTS, j.ReadConv = base.ts, base.conv
		if in.State == nil {
			j.State = "active"
		}
		if j.Workspace == "" {
			j.Workspace = ag.GroupID
		}
	}
	tree, err := a.jobTreeFor(r, in.Worktree)
	if err != nil {
		return job{}, err
	}
	j.Worktree = tree
	return j, nil
}

// applyJobInput sets the fields in names on j.
func applyJobInput(j *job, in jobInput) error {
	if in.Title != nil {
		t, err := validJobTitle(*in.Title)
		if err != nil {
			return err
		}
		j.Title = t
	}
	if in.Prompt != nil {
		p, err := validJobPrompt(*in.Prompt)
		if err != nil {
			return err
		}
		j.Prompt = p
	}
	if in.Note != nil {
		n, err := validJobNote(*in.Note)
		if err != nil {
			return err
		}
		j.Note = n
	}
	if in.State != nil {
		if err := validJobState(*in.State); err != nil {
			return err
		}
		j.State = *in.State
	}
	return nil
}

// jobAgentFor records the agent pane id runs now, refusing a pane without
// one. The agent lookup decides: an agent just started may not show in the
// snapshot yet. The pane comes from the tracker's last snapshot, else a new
// one.
func (a *agentAPI) jobAgentFor(paneID string) (jobAgent, error) {
	noAgent := &codedError{"job_no_agent", "the pane runs no agent", http.StatusConflict}
	s, err := a.session(paneID)
	if err != nil || s.Agent == "" {
		return jobAgent{}, noAgent
	}
	find := func(snap Snapshot) (snapPane, bool) {
		for _, sp := range snapshotPanes(snap) {
			if sp.pane.ID == paneID {
				return sp, true
			}
		}
		return snapPane{}, false
	}
	snap, _ := a.activity.lastSnapshot()
	p, ok := find(snap)
	if !ok {
		ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
		defer cancel()
		if snap, err = a.m.Snapshot(ctx); err == nil {
			p, ok = find(snap)
		}
	}
	if !ok {
		return jobAgent{}, noAgent
	}
	return jobAgentOf(p, s), nil
}

// readMark is where a job's reads start: what the agent wrote before it
// was given the job counts as read.
type readMark struct{ ts, conv string }

func (a *agentAPI) readMark(ag *jobAgent) readMark {
	if ag == nil {
		return readMark{}
	}
	sum, err := a.summarizePane(ag.PaneID)
	if err != nil {
		return readMark{conv: ag.Session}
	}
	conv := ag.Session
	if c, ok := decodeCursor(sum.cursor); ok {
		conv = c.Session
	}
	return readMark{ts: sum.agentTS, conv: conv}
}

// jobTreeFor finds the worktree in names in the server's own list of its
// workspace's worktrees: the CLI names it, the directory is the server's.
// A browser's is ignored. A worktree at or above the home dir is refused.
func (a *agentAPI) jobTreeFor(r *http.Request, in *jobWorktreeInput) (*jobTree, error) {
	if in == nil || !isLocalSocket(r.Context()) {
		return nil, nil
	}
	if a.wm == nil || !a.wm.ValidGroupID(in.Source) || !validBranchName(in.Branch) {
		return nil, invalidJob("no such worktree")
	}
	ctx, cancel := context.WithTimeout(r.Context(), worktreeCallTimeout)
	defer cancel()
	list, err := a.wm.ListWorktrees(ctx, in.Source)
	if err != nil {
		log.Printf("jobs: worktrees of %s: %v", in.Source, err)
		return nil, invalidJob("no such worktree")
	}
	for _, wt := range list.Worktrees {
		if wt.Branch != in.Branch || !wt.Linked {
			continue
		}
		if jobDirTooWide(wt.Path, a.home) {
			return nil, invalidJob("the worktree is at or above the home directory")
		}
		base := ""
		if validBranchName(in.Base) {
			base = in.Base
		}
		return &jobTree{Branch: in.Branch, Base: base, Dir: wt.Path, GroupID: wt.GroupID}, nil
	}
	return nil, invalidJob("no such worktree")
}

// jobDirTooWide: dir is the home dir or holds it (or is not absolute).
func jobDirTooWide(dir, home string) bool {
	dir = filepath.Clean(dir)
	if !filepath.IsAbs(dir) || filepath.Dir(dir) == dir { // a root: / or C:\
		return true
	}
	if home == "" {
		if h, err := os.UserHomeDir(); err == nil {
			home = h
		}
	}
	if home == "" {
		return false
	}
	home = filepath.Clean(home)
	rel, err := filepath.Rel(dir, home)
	return err == nil && (rel == "." || !strings.HasPrefix(rel, ".."))
}

// listJobs answers the ledger: unfinished jobs, or every one with all=1,
// of one workspace with workspace=<id>.
func (a *agentAPI) listJobs(w http.ResponseWriter, r *http.Request) {
	list, readOnly := a.jobs.jobs()
	q := r.URL.Query()
	all, ws := q.Get("all") == "1", q.Get("workspace")
	snap, _ := a.activity.lastSnapshot()
	viewOnly := isViewOnly(r)
	var full []jobView
	var brief []jobBrief
	for _, j := range list {
		if (!all && jobFinished(j.State)) || (ws != "" && j.Workspace != ws) {
			continue
		}
		live := a.jobLiveIn(snap, j)
		if viewOnly {
			b := jobBrief{ID: j.ID, Title: j.Title, State: j.State, Live: live, Updated: j.Updated}
			b.Live.LastTS, b.Live.EntryTS, b.Live.Dir = "", "", ""
			if live.branchHidden {
				b.Live.Branch = ""
			}
			switch {
			case j.Worktree != nil:
				b.Branch = j.Worktree.Branch
			default:
				b.Branch = b.Live.Branch
			}
			brief = append(brief, b)
			continue
		}
		full = append(full, jobView{j, live})
	}
	now := time.Now().UTC().Format(activityTimeFormat)
	if viewOnly {
		if brief == nil {
			brief = []jobBrief{}
		}
		jsonOK(w, map[string]any{"jobs": brief, "readOnly": true, "serverNow": now})
		return
	}
	if full == nil {
		full = []jobView{}
	}
	jsonOK(w, map[string]any{"jobs": full, "readOnly": readOnly, "serverNow": now, "canGrant": canGrant(r)})
}

func (a *agentAPI) viewJob(j job) jobView {
	snap, _ := a.activity.lastSnapshot()
	return jobView{j, a.jobLiveIn(snap, j)}
}

// jobLiveIn is what j's agent does in snap, the tracker's last snapshot
// (no backend read but the agent lookup, which is cached).
func (a *agentAPI) jobLiveIn(snap Snapshot, j job) jobLive {
	if j.Agent == nil {
		return jobLive{}
	}
	live := jobLive{Status: "gone", PaneID: j.Agent.PaneID, Ref: j.Agent.Ref}
	p, ok := findJobPane(snap, j.Agent.Key)
	if !ok {
		return live
	}
	s, err := a.session(p.pane.ID)
	switch {
	case errors.Is(err, errNoAgentSession) || (err == nil && !j.Agent.matches(p, s)):
		return live
	case err != nil:
		live.Status = "unknown"
		return live
	}
	live.PaneID, live.Ref, live.Dir = p.pane.ID, p.ref(), p.cwd()
	if f := a.files; f != nil && f.dirs != nil && a.m.Caps().Files {
		// Queues a read in the background when there is none yet, one git
		// status at a time, as the overview does.
		if c, ok := a.changes.lookup(f, p.key(), p.pane.ID); ok && c.status && !c.failed {
			live.Branch, live.branchHidden = c.branch, c.viewHidden
		}
	}
	switch st := p.status(); st {
	case "working", "blocked":
		live.Status = st
	default:
		live.Status = "idle"
	}
	if live.Status == "working" && s.Agent == "claude" {
		if bg := a.paneBackground(p.pane.ID); bg != "" {
			live.Status, live.Background = "background", bg
		}
	}
	if live.Status == "working" {
		return live
	}
	// Blocked: the last entry tells one dialog from the next for wait --job.
	sum, err := a.summarizePane(p.pane.ID)
	if err != nil {
		return live
	}
	conv := s.ID
	if c, ok := decodeCursor(sum.cursor); ok {
		conv = c.Session
	}
	live.LastTS, live.EntryTS = sum.agentTS, sum.entryTS
	// Only an agent at rest has a turn to read: one that only waits on
	// background work is reported once as such, its subagents' writes
	// moving agentTS meanwhile.
	live.Unread = live.Status == "idle" && sum.agentTS != "" && (conv != j.ReadConv || tsAfter(sum.agentTS, j.ReadTS))
	return live
}

// decodeJobBody reads a JSON body of at most jobBody bytes into v.
func decodeJobBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, jobBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			writeJobError(w, errJobsTooLarge)
		} else {
			jsonError(w, "invalid JSON body", http.StatusBadRequest)
		}
		return false
	}
	return true
}

// writeJobError answers a codedError with its code, a conflict with the
// job as it is now, and anything else with a generic 500, logged.
func writeJobError(w http.ResponseWriter, err error) {
	var (
		conflict *jobConflict
		ce       *codedError
	)
	body := map[string]any{}
	var status int
	switch {
	case errors.As(err, &conflict):
		body["code"], body["error"], status = conflict.code, conflict.msg, conflict.status
		body["job"] = conflict.job
	case errors.As(err, &ce):
		body["code"], body["error"], status = ce.code, ce.msg, ce.status
	default:
		log.Printf("jobs: %v", err)
		jsonError(w, "could not save the jobs", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}
