package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"time"
)

// POST /api/mux/jobs/{id}/finish (termote agents job finish): the
// orchestrator that started a job closes its tab and removes its worktree
// once the user said yes, through the same backend calls as the PWA's close
// tab and remove worktree. Over the local socket only. Every check runs
// before anything closes, and again under the pane's lock and the worktree
// slot right before it: the agent at rest with its last turn read, nothing
// else in its tab or the worktree, the worktree made by the job, clean, its
// work pushed or merged. A job in review becomes done. Directories come from
// the ledger and the server's own worktree list and snapshot, never from the
// request; git runs only through gitRunner.

// jobFinishBody bounds the request.
const jobFinishBody = 1 << 10

// jobFinishCIWait bounds the wait for a read of the job's pull requests
// before a remove, jobFinishLockWait the wait for the agent's pane lock
// (not what agentRequestMost leaves a message: a finish never queues behind
// one). Variables so tests can shorten them.
var (
	jobFinishCIWait   = 20 * time.Second
	jobFinishLockWait = muxTimeout
)

// jobFinishRefresh reads a job's pull requests now; tests replace it.
var jobFinishRefresh = (*ciPoller).refresh

var (
	errFinishSelfUnknown     = &codedError{"finish_self_unknown", "termote cannot tell which pane the command runs in: finish the job in the PWA", http.StatusConflict}
	errFinishNotMine         = &codedError{"finish_not_mine", "only a job started from this pane is finished here", http.StatusForbidden}
	errFinishJobActive       = &codedError{"finish_job_active", "only a job in review, or finished, is finished", http.StatusConflict}
	errFinishAgentChanged    = &codedError{"finish_agent_changed", "the job's pane runs another agent now", http.StatusConflict}
	errFinishSelf            = &codedError{"finish_self", "the job's tab or worktree holds the pane this command runs in", http.StatusConflict}
	errFinishTabBusy         = &codedError{"finish_tab_busy", "another pane of the job's tab runs a program", http.StatusConflict}
	errFinishNoWorktree      = &codedError{"finish_no_worktree", "the job has no worktree", http.StatusConflict}
	errFinishWorktreeNotMade = &codedError{"finish_worktree_not_made", "the worktree was not made by this job: the user removes it in the PWA", http.StatusConflict}
	errFinishWorktreeEnv     = &codedError{"finish_worktree_env", "the worktree holds .env files git ignores, which a remove deletes", http.StatusConflict}
	errFinishWorktreeShared  = &codedError{"finish_worktree_shared", "another workspace or tab works in the worktree", http.StatusConflict}
	errFinishNeedsClose      = &codedError{"finish_needs_close", "the job's tab is in the worktree: remove it with --close", http.StatusBadRequest}
	errFinishNeedsRemove     = &codedError{"finish_needs_remove", "the tab is the last of the worktree's workspace: close it with --remove-worktree", http.StatusBadRequest}
	errWorktreeNotPushed     = &codedError{"worktree_not_pushed", "the worktree's commits are neither pushed nor merged", http.StatusConflict}
	errFinishAgentWorking    = &codedError{"finish_agent_working", "the agent is working", http.StatusConflict}
	errFinishAgentBackground = &codedError{"finish_agent_background", "the agent still runs work in the background", http.StatusConflict}
	errFinishUnread          = &codedError{"finish_unread", "the agent's last turn is not read yet", http.StatusConflict}
	errFinishOpenAsk         = &codedError{"finish_open_ask", "a question about this job waits for the user", http.StatusConflict}
	errFinishFailed          = &codedError{"finish_failed", "could not finish the job", http.StatusInternalServerError}
)

// jobFinishInput is the request: the job as read (updated), the activity key
// of the pane the command runs in (by), and what to do.
type jobFinishInput struct {
	Updated        string `json:"updated"`
	By             string `json:"by"`
	Close          bool   `json:"close"`
	RemoveWorktree bool   `json:"removeWorktree"`
}

// freshSnapshotter is a backend that keeps its snapshot a while (Herdr):
// invalidate makes the next read a new one.
type freshSnapshotter interface{ invalidate() }

// finishPlan is what a finish would close, as the checks found it.
type finishPlan struct {
	// pane is the job's pane: its agent's, or the shell its agent left;
	// nil when its tab is gone.
	pane *snapPane
	// agent: pane runs the job's agent still.
	agent bool
	// session is the agent's, when agent.
	session AgentSession
	// removeGroup is the group a remove runs on (the job's tab's, the only
	// one working in the worktree); "" when no group shows the worktree.
	removeGroup string
	// tree is the worktree as git reads it, for a remove.
	tree finishTree
}

// closesTab: the finish closes the job's tab itself, not with the
// worktree's group.
func (p finishPlan) closesTab(in jobFinishInput) bool {
	return in.Close && p.pane != nil && (!in.RemoveWorktree || p.removeGroup != p.pane.group.ID)
}

func (a *agentAPI) handleJobFinish(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
		return
	}
	if !isLocalSocket(r.Context()) {
		jsonErrorCode(w, "socket_only", "only termote agents on this machine finishes a job", http.StatusForbidden)
		return
	}
	var in jobFinishInput
	r.Body = http.MaxBytesReader(w, r.Body, jobFinishBody)
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			writeJobError(w, errJobsTooLarge)
		} else {
			jsonErrorCode(w, "invalid_request", "invalid JSON body", http.StatusBadRequest)
		}
		return
	}
	if (!in.Close && !in.RemoveWorktree) || in.Updated == "" {
		jsonErrorCode(w, "invalid_request", "close or removeWorktree, and updated, are required", http.StatusBadRequest)
		return
	}
	if a.jobs == nil {
		writeJobError(w, errJobsUnavailable)
		return
	}
	id := r.PathValue("id")
	res, closed, err := a.finishJob(r.Context(), w, id, in)
	if err != nil {
		finishError(w, err, closed)
		return
	}
	jsonOK(w, res)
}

// finishJob runs a finish: the checks, the CI read, the locks, the checks
// again, the close and remove, then the ledger. closed reports, with an
// error, that the job's tab is closed already.
func (a *agentAPI) finishJob(ctx context.Context, w http.ResponseWriter, id string, in jobFinishInput) (res map[string]any, closed bool, err error) {
	if !validTemplateID(id) {
		return nil, false, errJobNotFound
	}
	if in.By == "" {
		return nil, false, errFinishSelfUnknown
	}
	j, ok := a.jobs.job(id)
	switch {
	case !ok:
		return nil, false, errJobNotFound
	case j.Updated.Format(time.RFC3339Nano) != in.Updated:
		return nil, false, &jobConflict{codedError{"job_conflict", "the job was changed elsewhere", http.StatusConflict}, j}
	case j.CreatedBy != in.By:
		return nil, false, errFinishNotMine
	case j.State != "review" && !jobFinished(j.State):
		return nil, false, errFinishJobActive
	}
	plan, err := a.finishCheck(ctx, j, in)
	if err != nil {
		return nil, false, err
	}
	// The job's pull requests, read before any lock and while the
	// checkout is still there: a merged one at HEAD lets the branch go.
	reason, checked := "", j
	if in.RemoveWorktree {
		j, reason = a.finishCI(ctx, j, plan.tree.head)
	}
	if err := finishTreeRefusal(plan.tree, j.CI, in); err != nil {
		return nil, false, err
	}

	holdForLock(w)
	if plan.agent {
		unlock, err := a.input.lockWithin(ctx, plan.session.Target, jobFinishLockWait)
		if err != nil {
			return nil, false, err
		}
		defer unlock()
	}
	if in.RemoveWorktree {
		release, ok := a.worktreeSlot.take(ctx)
		if !ok {
			return nil, false, errWorktreeBusy
		}
		defer release()
	}
	// Bounded from here, the waits for the locks left out, and run to its
	// end once something closes.
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), worktreeTimeout+muxTimeout)
	defer cancel()
	// The job again: the user may have changed it during the wait (its
	// pull requests aside, which the read just wrote).
	now, ok := a.jobs.job(id)
	if !ok {
		return nil, false, errJobNotFound
	}
	if !sameFinishJob(now, checked) {
		return nil, false, &jobConflict{codedError{"job_conflict", "the job was changed elsewhere", http.StatusConflict}, now}
	}
	j = now
	if plan, err = a.finishCheck(actx, j, in); err != nil {
		return nil, false, err
	}
	if err := finishTreeRefusal(plan.tree, j.CI, in); err != nil {
		return nil, false, err
	}
	if plan.agent {
		if err := a.finishAgentAtRest(actx, j, plan); err != nil {
			return nil, false, err
		}
	}
	return a.finishAct(actx, j, in, plan, reason)
}

// sameFinishJob: b is a as far as a finish goes: its state, who made it,
// its agent and its worktree.
func sameFinishJob(a, b job) bool {
	return a.State == b.State && a.CreatedBy == b.CreatedBy && reflect.DeepEqual(a.Agent, b.Agent) &&
		reflect.DeepEqual(a.Worktree, b.Worktree)
}

// finishCheck reads a new snapshot and checks everything a finish needs
// before it closes anything: which pane is the job's, that its tab and
// the worktree hold nothing else, and the worktree's git state.
func (a *agentAPI) finishCheck(ctx context.Context, j job, in jobFinishInput) (finishPlan, error) {
	snap, err := a.finishSnapshot(ctx)
	if err != nil {
		return finishPlan{}, err
	}
	var plan finishPlan
	if j.Agent != nil {
		if sp, ok := findPaneByKey(snap, j.Agent.Key); ok {
			plan.pane = &sp
		}
	}
	if p := plan.pane; p != nil && p.pane.Agent != nil {
		s, err := a.session(p.pane.ID)
		if err != nil || !j.Agent.matches(*p, s) {
			return finishPlan{}, errFinishAgentChanged
		}
		if p.status() == "working" {
			return finishPlan{}, errFinishAgentWorking
		}
		plan.agent, plan.session = true, s
	} else if p != nil && (p.group.ID != j.Agent.GroupID || p.ref() != j.Agent.Ref) {
		// A shell at the address in another workspace or tab is not the one
		// the agent left (tmux reuses %N and $N once its server restarts).
		plan.pane = nil
	}
	self, selfFound := findPaneByKey(snap, in.By)
	if p := plan.pane; p != nil && selfFound && self.group.ID == p.group.ID && self.tab.ID == p.tab.ID {
		return finishPlan{}, errFinishSelf
	}
	var groups, named []string
	if j.Worktree != nil && in.RemoveWorktree {
		if !j.Worktree.Made {
			return finishPlan{}, errFinishWorktreeNotMade
		}
		if a.wm == nil || a.files == nil || !a.m.Caps().Worktrees {
			return finishPlan{}, errWorktreeUnsupported
		}
		if groups, named, err = a.worktreeGroups(ctx, snap, j); err != nil {
			return finishPlan{}, err
		}
		if selfFound && (slices.Contains(groups, self.group.ID) || dirInTree(j.Worktree.Dir, self.cwd())) {
			return finishPlan{}, errFinishSelf
		}
	} else if in.RemoveWorktree {
		return finishPlan{}, errFinishNoWorktree
	}
	if p := plan.pane; p != nil && in.RemoveWorktree {
		inTree := slices.Contains(groups, p.group.ID) || dirInTree(j.Worktree.Dir, p.cwd())
		if inTree && !in.Close {
			return finishPlan{}, errFinishNeedsClose
		}
		if slices.Contains(groups, p.group.ID) {
			// A remove acts on the worktree the backend says the group
			// shows: Herdr's own list, else the folder of the group's first
			// pane (gitWorktreeMux). Another one than the job's is refused.
			_, own := a.m.(worktreeMux)
			shows := slices.Contains(named, p.group.ID)
			if !own {
				// The repository of that folder, as RemoveWorktree reads it:
				// a folder inside the job's worktree may belong to another
				// worktree nested in it, which the checks below never read.
				shows = false
				if dir := groupFolder(p.group); dir != "" && dirInTree(j.Worktree.Dir, dir) {
					repo, ok, err := repoInfo(ctx, a.files.roots, dir)
					if err != nil {
						return finishPlan{}, err
					}
					shows = ok && sameAllowPath(repo.Top, j.Worktree.Dir)
				}
			}
			if len(p.group.Tabs) > 1 || !shows {
				return finishPlan{}, errFinishWorktreeShared
			}
			plan.removeGroup = p.group.ID
		}
	}
	for _, g := range groups {
		if g != plan.removeGroup {
			return finishPlan{}, errFinishWorktreeShared
		}
	}
	if p := plan.pane; p != nil && in.Close && !in.RemoveWorktree && j.Worktree != nil && len(p.group.Tabs) == 1 &&
		(dirInTree(j.Worktree.Dir, p.cwd()) || dirInTree(j.Worktree.Dir, groupFolder(p.group))) {
		return finishPlan{}, errFinishNeedsRemove
	}
	if p := plan.pane; p != nil && (plan.closesTab(in) || plan.removeGroup != "") {
		if err := a.finishTabIdle(ctx, *p, plan.agent); err != nil {
			return finishPlan{}, err
		}
	}
	if in.RemoveWorktree {
		if plan.tree, err = readFinishTree(ctx, a.files.git, a.files.roots, a.home, *j.Worktree); err != nil {
			return finishPlan{}, err
		}
	}
	if asks, _ := a.jobs.asksList(); slices.ContainsFunc(asks, func(q ask) bool { return q.Job == j.ID && q.State == askOpen }) {
		return finishPlan{}, errFinishOpenAsk
	}
	return plan, nil
}

// finishTreeRefusal refuses a remove of a worktree that holds anything a
// remove would lose.
func finishTreeRefusal(tree finishTree, ci *jobCI, in jobFinishInput) error {
	switch {
	case !in.RemoveWorktree:
		return nil
	case tree.dirty:
		return errWorktreeDirty
	case !tree.safe(ci):
		return errWorktreeNotPushed
	case tree.envFiles:
		return errFinishWorktreeEnv
	}
	return nil
}

// finishSnapshot reads the panes now, past the backend's cache.
func (a *agentAPI) finishSnapshot(ctx context.Context) (Snapshot, error) {
	if f, ok := a.m.(freshSnapshotter); ok {
		f.invalidate()
	}
	sctx, cancel := context.WithTimeout(ctx, muxTimeout)
	defer cancel()
	return peekSnapshot(sctx, a.m)
}

// worktreeGroups lists the groups working in j's worktree: those the
// backend's worktree list names for it, and every group with a pane whose
// folder is in it; named, those the list names. A backend with worktrees of
// its own (Herdr) is the only one to know which workspace shows it, so a
// list it cannot answer, or one without the job's worktree, is an error
// there; termote's git list (tmux, Zellij, herdr-core) is the panes'
// folders already.
func (a *agentAPI) worktreeGroups(ctx context.Context, snap Snapshot, j job) (groups, named []string, err error) {
	exists := func(id string) bool { return groupIndex(snap.Groups, id) >= 0 }
	add := func(id string) {
		if id != "" && exists(id) && !slices.Contains(groups, id) {
			groups = append(groups, id)
		}
	}
	listed, found := false, false
	var sources []string
	// A workspace closed and opened again: the group of the job's
	// repository now; the worktree's folder must still be in its list.
	for _, id := range []string{j.Worktree.GroupID, j.Workspace, workspaceNow(snap, a.groupRepos(snap, false), j)} {
		if id != "" && exists(id) && a.wm.ValidGroupID(id) && !slices.Contains(sources, id) {
			sources = append(sources, id)
		}
	}
	for _, id := range sources {
		lctx, cancel := context.WithTimeout(ctx, worktreeCallTimeout)
		list, err := a.wm.ListWorktrees(lctx, id)
		cancel()
		if err != nil {
			log.Printf("job finish: worktrees of %s: %v", id, err)
			continue
		}
		listed = true
		for _, wt := range list.Worktrees {
			if sameAllowPath(wt.Path, j.Worktree.Dir) {
				found = true
				for _, g := range append([]string{wt.GroupID}, wt.groupIDs()...) {
					add(g)
					if g != "" && !slices.Contains(named, g) {
						named = append(named, g)
					}
				}
			}
		}
		break
	}
	if _, own := a.m.(worktreeMux); own && !listed {
		return nil, nil, errWorktreeBusy
	} else if own && !found {
		return nil, nil, errWorktreeChanged
	}
	for _, g := range snap.Groups {
		for _, t := range g.Tabs {
			for _, p := range t.Panes {
				if p.Process != nil && p.Process.Cwd != "" && dirInTree(j.Worktree.Dir, p.Process.Cwd) {
					add(g.ID)
				}
			}
			for _, p := range t.Processes {
				if p.Cwd != "" && dirInTree(j.Worktree.Dir, p.Cwd) {
					add(g.ID)
				}
			}
		}
	}
	return groups, named, nil
}

// finishTabIdle checks that closing p's tab ends nothing but the job's
// agent at rest: every other pane (with withAgent false, the job's pane
// too) is a shell waiting at its prompt.
func (a *agentAPI) finishTabIdle(ctx context.Context, p snapPane, withAgent bool) error {
	tm, ok := a.m.(taskMux)
	// A tab listing more processes than panes holds panes the snapshot
	// does not carry (tmux, when its pane list failed).
	if !ok || len(p.tab.Processes) > len(p.tab.Panes) {
		return errFinishTabBusy
	}
	for _, q := range p.tab.Panes {
		if withAgent && q.ID == p.pane.ID {
			continue
		}
		tctx, cancel := context.WithTimeout(ctx, muxTimeout)
		_, _, idle, err := tm.IdleShell(tctx, q.ID)
		cancel()
		if errors.Is(err, errTaskTargetGone) {
			continue
		}
		if err != nil || !idle {
			return errFinishTabBusy
		}
	}
	return nil
}

// finishCI reads the job's pull requests when a remove needs one merged at
// head and none is known yet, waiting at most jobFinishCIWait: the read
// goes on past it. It returns the job as the read left it, and why a
// branch without a merged pull request at head stays.
func (a *agentAPI) finishCI(ctx context.Context, j job, head string) (job, string) {
	switch {
	case jobFinished(j.State):
		return j, "job_finished"
	case !a.ci.available():
		return j, "ci_unavailable"
	}
	if _, ok := mergedPRAt(j.CI, head); ok {
		return j, ""
	}
	type read struct {
		j   job
		err error
	}
	done := make(chan read, 1)
	go func() {
		nj, err := jobFinishRefresh(a.ci, ctx, j.ID)
		done <- read{nj, err}
	}()
	timer := time.NewTimer(jobFinishCIWait)
	defer timer.Stop()
	select {
	case r := <-done:
		switch {
		case errors.Is(r.err, errCIBusy):
			return j, "ci_busy"
		case errors.Is(r.err, errCIUnavailable):
			return j, "ci_unavailable"
		case r.err != nil:
			return j, "ci_failed"
		case r.j.CI != nil && r.j.CI.Error != "":
			return r.j, "ci_failed"
		}
		return r.j, "no_merged_pr"
	case <-timer.C:
		return j, "ci_timeout"
	}
}

// finishAgentAtRest checks, under the pane's lock and past every cache,
// that the job's agent is still the job's and at rest: not working, no
// dialog, no background work, its last turn read.
func (a *agentAPI) finishAgentAtRest(ctx context.Context, j job, plan finishPlan) error {
	wr, ok := a.m.(agentWriter)
	if !ok || a.loc == nil {
		return errFinishTabBusy
	}
	s, err := sessionNow(ctx, wr, plan.pane.pane.ID)
	if err != nil || !j.Agent.matches(*plan.pane, s) {
		return errFinishAgentChanged
	}
	switch s.Status {
	case "working":
		return errFinishAgentWorking
	case "blocked":
		return errAgentBlocked
	}
	screen, err := wr.Capture(ctx, s.Target)
	if err != nil {
		return err
	}
	sc := readAgentScreen(s.Agent, screen)
	switch {
	case sc.prompt != nil:
		return errAgentBlocked
	case agentWorking(s, sc):
		return errFinishAgentWorking
	case s.Agent == "claude" && sc.activity != nil && sc.activity.Background != "":
		return errFinishAgentBackground
	}
	// Nothing written yet reads as an empty conversation: nothing unread.
	res, err := a.readCached(s, "", "")
	if err != nil {
		return err
	}
	sum := summarizeTranscript(res.Entries, s)
	conv := s.ID
	if c, ok := decodeCursor(res.Cursor); ok {
		conv = c.Session
	}
	if sum.agentTS != "" && (conv != j.ReadConv || tsAfter(sum.agentTS, j.ReadTS)) {
		return errFinishUnread
	}
	return nil
}

// finishAct closes and removes what plan names, then writes the ledger.
func (a *agentAPI) finishAct(ctx context.Context, j job, in jobFinishInput, plan finishPlan, reason string) (map[string]any, bool, error) {
	peer := localPeerPID(ctx)
	closed, removed, already := false, false, false
	branch, branchReason := "", ""
	tabClosed := func() {
		closed = true
		kind := "shell"
		if plan.agent {
			kind = plan.session.Agent
		}
		auditf("job_tab_closed", "job", j.ID, "tab", plan.pane.tab.ID, "pane", plan.pane.pane.ID, "agent", kind,
			"by", in.By, "peer_pid", peer)
	}
	if plan.closesTab(in) {
		if err := a.m.CloseTab(ctx, plan.pane.tab.ID, plan.pane.tab.Key); err != nil {
			return nil, false, err
		}
		tabClosed()
	}
	already = in.Close && plan.pane == nil
	if in.RemoveWorktree {
		var err error
		if plan.removeGroup != "" {
			err = a.wm.RemoveWorktree(ctx, plan.removeGroup, false)
		} else {
			err = removeUnopenedWorktree(ctx, a.files.git, plan.tree.repo, j.Worktree.Dir)
		}
		if err != nil {
			if plan.removeGroup != "" && plan.pane != nil && !closed && a.finishGroupGone(ctx, plan.removeGroup) {
				tabClosed()
			}
			if closed {
				a.finishPartial(j.ID)
			}
			return nil, closed, err
		}
		removed = true
		if plan.removeGroup != "" && plan.pane != nil && !closed {
			tabClosed()
		}
		auditf("job_worktree_removed", "job", j.ID, "group", plan.removeGroup, "branch", j.Worktree.Branch, "by", in.By, "peer_pid", peer)
		branch, branchReason = "kept", reason
		if _, ok := mergedPRAt(j.CI, plan.tree.head); ok {
			branchReason = deleteMergedBranch(ctx, a.files.git, plan.tree.repo, j.Worktree.Branch, plan.tree.head)
			if branchReason == "" {
				branch = "deleted"
				auditf("job_branch_deleted", "job", j.ID, "branch", j.Worktree.Branch, "sha", plan.tree.head[:12],
					"by", in.By, "peer_pid", peer)
			}
		}
	}
	saved, updated := a.finishLedger(j.ID, finishedText(closed, already, removed, branch, branchReason), in.By)
	if !updated {
		saved = j
	}
	return map[string]any{"job": a.viewJob(saved), "closed": closed, "alreadyClosed": already, "worktreeRemoved": removed,
		"branch": branch, "branchReason": branchReason, "jobUpdated": updated}, closed, nil
}

// finishGroupGone reports whether group id is gone from a new snapshot.
func (a *agentAPI) finishGroupGone(ctx context.Context, id string) bool {
	snap, err := a.finishSnapshot(ctx)
	return err == nil && groupIndex(snap.Groups, id) < 0
}

// finishPartial records that a finish closed the job's tab and then failed
// to remove its worktree.
func (a *agentAPI) finishPartial(id string) {
	if _, err := a.jobs.update(id, "", func(j *job) error {
		a.jobs.addEvent(j, "finish_partial", "tab closed; worktree not removed")
		return nil
	}); err != nil {
		log.Printf("job finish: %s: %v", id, err)
	}
}

// finishedText is the finished event's text: what was done.
func finishedText(closed, already, removed bool, branch, reason string) string {
	var parts []string
	switch {
	case closed:
		parts = append(parts, "tab closed")
	case already:
		parts = append(parts, "tab already closed")
	}
	if removed {
		parts = append(parts, "worktree removed")
	}
	switch branch {
	case "deleted":
		parts = append(parts, "branch deleted")
	case "kept":
		parts = append(parts, "branch kept: "+reason)
	}
	return strings.Join(parts, "; ")
}

// finishLedger moves a job in review to done, its grants ending with it,
// and adds the finished event; a finished job keeps its state. The finish
// is done whatever the job became meanwhile, so no updated is compared.
func (a *agentAPI) finishLedger(id, text, by string) (job, bool) {
	var ended []string
	saved, err := a.jobs.update(id, "", func(j *job) error {
		ended = nil
		if j.State == "review" {
			j.State = "done"
			a.jobs.addEvent(j, "state", "done")
			ended = revokeGrants(j, a.jobs.now())
		}
		a.jobs.addEvent(j, "finished", text)
		return nil
	})
	if err != nil {
		log.Printf("job finish: %s: %v", id, err)
		return job{}, false
	}
	for _, gid := range ended {
		auditf("grant_revoked", "grant", gid, "job", id, "reason", "job_finished", "by", by)
	}
	return saved, true
}

// finishError answers a refused or failed finish with its code; closed adds
// that the job's tab is closed already (a run again removes the rest).
func finishError(w http.ResponseWriter, err error, closed bool) {
	var (
		conflict *jobConflict
		af       *agentFailure
		ce       *codedError
	)
	body := map[string]any{}
	status := http.StatusInternalServerError
	switch {
	case errors.As(err, &conflict):
		body["code"], body["error"], status = conflict.code, conflict.msg, conflict.status
		body["job"] = conflict.job
	case errors.As(err, &af):
		body["code"], body["error"], status = af.code, af.msg, af.status
	case isContextError(err):
		log.Printf("job finish: %v", err)
		body["code"], body["error"], status = errWorktreeUnknown.code, errWorktreeUnknown.msg, errWorktreeUnknown.status
	case errors.Is(err, errUnsupported):
		body["code"], body["error"], status = errWorktreeUnsupported.code, errWorktreeUnsupported.msg, errWorktreeUnsupported.status
	case errors.As(err, &ce):
		body["code"], body["error"], status = ce.code, ce.msg, ce.status
	default:
		log.Printf("job finish: %v", err)
		body["code"], body["error"] = errFinishFailed.code, errFinishFailed.msg
	}
	if closed {
		body["closed"] = true
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}
