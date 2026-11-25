package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// termote agents job finish <id> [--close] [--remove-worktree]: after the
// user's yes, the orchestrator closes the tab of a job it started and
// removes the worktree the job made (its branch too once a merged pull
// request has its head), through POST /api/mux/jobs/{id}/finish
// (job_finish.go), which checks everything again under its locks. What the
// CLI can tell itself is refused before anything is sent; the request goes
// once and is never sent again.

const jobFinishUsage = "usage: termote agents job finish <id> [--close] [--remove-worktree] [--json]"

// agentsFinishTimeout is above the server's worst case (a pull request
// read, the pane's lock, the worktree slot, the remove: about 100 s).
var agentsFinishTimeout = 120 * time.Second

// jobFinishReply is the server's answer to a finish.
type jobFinishReply struct {
	Job             jobView `json:"job"`
	Closed          bool    `json:"closed"`
	AlreadyClosed   bool    `json:"alreadyClosed"`
	WorktreeRemoved bool    `json:"worktreeRemoved"`
	Branch          string  `json:"branch"`
	BranchReason    string  `json:"branchReason"`
	JobUpdated      bool    `json:"jobUpdated"`
}

// branchKeptWhy says why a finish kept the job's branch.
var branchKeptWhy = map[string]string{
	"no_merged_pr":     "no merged pull request at its head is known",
	"ci_busy":          "termote could not read its pull requests now",
	"ci_timeout":       "termote could not read its pull requests in time",
	"ci_failed":        "termote could not read its pull requests",
	"ci_unavailable":   "this server does not follow pull requests",
	"job_finished":     "the job was finished already, so its pull requests were not read",
	branchMoved:        "it moved since it was checked",
	branchCheckedOut:   "another worktree has it checked out",
	branchDeleteFailed: "git could not delete it",
}

func (c *cli) agentsJobFinish(args []string) error {
	var closeTab, removeTree, asJSON bool
	fs := c.newFlagSet("agents job finish")
	fs.BoolVar(&closeTab, "close", false, "")
	fs.BoolVar(&removeTree, "remove-worktree", false, "")
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	switch {
	case len(pos) != 1:
		return usageError("job finish takes one job id\n%s", jobFinishUsage)
	case !closeTab && !removeTree:
		return usageError("job finish needs --close, --remove-worktree or both\n%s", jobFinishUsage)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	snap, err := c.agentsSnapshot(port)
	if err != nil {
		return err
	}
	list, err := c.jobsGet(port, true)
	if err != nil {
		return err
	}
	j, ok := findJob(list, pos[0])
	if !ok {
		return fmt.Errorf("no job %s; see: termote agents jobs --all", plainText(pos[0]))
	}
	id := plainText(j.ID)
	self := c.selfKey(snap)
	switch {
	case self == "":
		return fmt.Errorf("termote cannot tell which pane this command runs in (herdr-core, psmux); finish the job in the PWA: close its tab, then remove its worktree under Worktrees")
	case j.CreatedBy != self:
		return fmt.Errorf("job %s was not made from this pane; only a job you started is finished here", id)
	case j.State != "review" && !jobFinished(j.State):
		return fmt.Errorf("job %s is %s; after the user's yes: termote agents job set %s --state review", id, plainText(j.State), id)
	case removeTree && j.Worktree == nil:
		return fmt.Errorf("job %s has no worktree; finish it with --close alone", id)
	case removeTree && !j.Worktree.Made:
		return fmt.Errorf("the worktree of job %s was not made by it (or was made before termote kept track); the user decides about it in the PWA", id)
	}
	body := map[string]any{"updated": j.Updated.Format(time.RFC3339Nano), "by": self, "close": closeTab, "removeWorktree": removeTree}
	r, err := c.agentsCall(port, http.MethodPost, "/api/mux/jobs/"+url.PathEscape(j.ID)+"/finish", body, agentsFinishTimeout)
	if errors.Is(err, errAgentsMaybeSent) {
		err = fmt.Errorf("%w; see: termote agents jobs --all and termote agents list", err)
	}
	if err != nil {
		return err
	}
	if r.status != http.StatusOK {
		return finishRefusal(r, j)
	}
	var out jobFinishReply
	if err := json.Unmarshal(r.body, &out); err != nil {
		return fmt.Errorf("unexpected answer from the server to the finish")
	}
	if !out.JobUpdated && j.State == "review" {
		fmt.Fprintf(c.errOut, "%s the job ledger was not updated: termote agents job set %s --state done\n", c.paint(ansiYellow, "[WARN]"), id)
	}
	if asJSON {
		return writeJSON(c.out, out)
	}
	c.infof("Finished job %s: %s", id, finishedLine(out, j))
	return nil
}

// finishedLine says what a finish did to job j.
func finishedLine(out jobFinishReply, j jobView) string {
	var parts []string
	switch {
	case out.Closed:
		parts = append(parts, "tab closed")
	case out.AlreadyClosed:
		parts = append(parts, "its tab was closed already")
	}
	if out.WorktreeRemoved && j.Worktree != nil {
		b := plainText(j.Worktree.Branch)
		parts = append(parts, fmt.Sprintf("worktree %s removed (ignored files too)", plainText(j.Worktree.Dir)))
		switch out.Branch {
		case "deleted":
			parts = append(parts, "branch "+b+" deleted")
		case "kept":
			why := branchKeptWhy[out.BranchReason]
			if why == "" {
				why = "termote did not delete it"
			}
			parts = append(parts, fmt.Sprintf("branch %s kept (%s: %s)", b, plainText(out.BranchReason), why))
		}
	}
	state := plainText(j.State)
	if out.JobUpdated {
		state = plainText(out.Job.State)
	}
	parts = append(parts, "the job is "+state)
	return strings.Join(parts, "; ")
}

// finishRefusal words a refused finish with what to do about it.
func finishRefusal(r agentsReply, j jobView) error {
	id := plainText(j.ID)
	var extra struct {
		Closed      bool `json:"closed"`
		Confirmable bool `json:"confirmable"`
	}
	json.Unmarshal(r.body, &extra)
	hint := ""
	switch r.failure().Code {
	case "finish_unread":
		hint = "; read its last turn first: termote agents read " + plainText(j.Live.PaneID)
	case "finish_agent_working", "agent_blocked", "finish_agent_background":
		hint = "; wait for the agent (termote agents wait --job " + id + ") or ask the user"
	case "worktree_not_pushed":
		hint = "; ask the agent to push its branch, or, when its pull request merged with another head, check: termote agents job ci " + id +
			" --refresh (never push a merged branch again: that makes it again on the remote)"
	case "dirty":
		hint = "; ask the agent to commit its changes; never discard them"
	case "finish_worktree_env":
		if extra.Confirmable {
			hint = "; tell the user: they confirm the removal of those files in the PWA (the job's details), which then " +
				"finishes the job there, or they save or delete them and you run this again"
		} else {
			hint = "; the user saves or deletes those files, then run this again"
		}
		hint += "; never read, copy or delete them yourself"
	case "finish_tab_busy", "finish_worktree_shared":
		hint = "; ask the user to close the other tab or workspace first"
	case "finish_needs_close", "finish_needs_remove":
		hint = "; run it with both: termote agents job finish " + id + " --close --remove-worktree"
	case "finish_worktree_not_made", "finish_not_mine", "finish_self_unknown", "tab_confirm_required":
		hint = "; the user finishes it in the PWA"
	}
	if extra.Closed {
		hint += "; the tab is closed: run the same command again to remove the worktree"
	}
	return fmt.Errorf("%w%s", agentsRefusal(r), hint)
}
