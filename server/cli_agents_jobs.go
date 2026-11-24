package main

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"text/tabwriter"
	"time"
)

// termote agents jobs / job: the job ledger (job_store.go) as the
// orchestrator reads and writes it. Every other agents command notes what
// it did on the job of the pane it reached (jobNote); a failure to note it
// (an older server, a write that failed) is a warning, never the command's
// failure.

// agentsJobsWait is the longest wait --job waits by default.
var agentsJobsWait = 20 * time.Minute

// A job given to an agent just started may name a pane whose agent the
// server does not see yet (job_no_agent): Herdr reports a new Claude Code
// session a few seconds after it runs, and Codex has none before its first
// message. The write is tried again every agentsJobAgentEvery for
// agentsJobAgentWait, then the job is written without the pane.
var (
	agentsJobAgentWait  = 10 * time.Second
	agentsJobAgentEvery = 500 * time.Millisecond
)

// The usage of each job command, as agentsUsage lists it (a test checks),
// printed with a refusal of that command instead of every agents command.
const (
	jobsUsage      = "usage: termote agents jobs [--workspace <id | name>] [--mine] [--ready] [--all] [--json]"
	jobAddUsage    = "usage: termote agents job add --title <title> [--pane <pane>] [--note <text | ->] [--priority high|normal|low] [--after <job>]... [--workspace <id | name>] [--json]"
	jobShowUsage   = "usage: termote agents job show <id> [--json]"
	jobSetUsage    = "usage: termote agents job set <id> [--state active|review|done|failed|abandoned] [--title <title>] [--note <text | ->] [--pane <pane>] [--pr <number>]... [--no-pr <number>]... [--priority high|normal|low] [--after <job>]... [--no-after <job>]... [--workspace <id | name> | --no-workspace]"
	jobCIUsage     = "usage: termote agents job ci <id> [--refresh] [--send] [--json]"
	jobRemoveUsage = "usage: termote agents job remove <id>"
	jobsPruneUsage = "usage: termote agents jobs prune [--older-than <duration>] [--dry-run] [--json]"
	waitJobUsage   = "usage: termote agents wait --job <id>... [--timeout <duration>]"
)

// jobSelfPane refuses --pane naming the orchestrator's own pane.
const jobSelfPane = "--pane %s is the pane this command runs in; a job goes to the agent that does the work"

type jobsListing struct {
	Jobs      []jobView `json:"jobs"`
	ReadOnly  bool      `json:"readOnly"`
	ServerNow string    `json:"serverNow"`
	// JobFields: the job fields the server reads beyond the first ones
	// (priority, after, workspace); none from an older server.
	JobFields []string `json:"jobFields"`
}

// jobsGet reads the ledger: every job with all, else the unfinished ones,
// newest first, as the lookups that take the newest job of a pane or a
// worktree expect. The snapshot is read first: what each job's agent does
// comes from the server's last one, which nothing else may have read lately
// (no page open).
func (c *cli) jobsGet(port int, all bool) ([]jobView, error) {
	l, err := c.jobsListingGet(port, all)
	slices.SortStableFunc(l.Jobs, func(a, b jobView) int { return b.Created.Compare(a.Created) })
	return l.Jobs, err
}

// jobsListingGet is the ledger in the server's order (by priority, the
// jobs to do oldest first) with the server's clock.
func (c *cli) jobsListingGet(port int, all bool) (jobsListing, error) {
	return c.jobsQuery(port, all, false)
}

// jobsQuery is jobsListingGet keeping, with ready, only the jobs to do that
// wait on nothing.
func (c *cli) jobsQuery(port int, all, ready bool) (jobsListing, error) {
	c.agentsSnapshot(port)
	var l jobsListing
	q := url.Values{}
	if all {
		q.Set("all", "1")
	}
	if ready {
		q.Set("ready", "1")
	}
	path := "/api/mux/jobs"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	err := c.agentsGet(port, path, &l)
	return l, err
}

// jobIDFlag collects the job ids of a repeated --after or --no-after.
func jobIDFlag(dst *[]string) func(string) error {
	return func(s string) error {
		if !validTemplateID(s) {
			return fmt.Errorf("%q is not a job id (job --after names jobs, 16 hex digits, unlike wait <pane>@<seq>; see: termote agents jobs)", plainText(s))
		}
		*dst = append(*dst, s)
		return nil
	}
}

// priorityFlag reads --priority.
func priorityFlag(dst *string) func(string) error {
	return func(s string) error {
		if !slices.Contains(jobPriorities, s) {
			return fmt.Errorf("--priority is high, normal or low")
		}
		*dst = s
		return nil
	}
}

// priorityText is a job's priority as printed.
func priorityText(p string) string { return cmp.Or(plainText(p), "normal") }

// waitsText names each job of ids with its state in list, those failed or
// abandoned with what to do about them.
func waitsText(list []jobView, ids []string, failed []string) string {
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		st := "gone"
		if j, ok := findJob(list, id); ok {
			st = j.State
		}
		part := plainText(id) + " (" + plainText(st)
		if slices.Contains(failed, id) {
			part += ": the user decides whether to drop it or abandon this job"
		}
		parts = append(parts, part+")")
	}
	return strings.Join(parts, ", ")
}

// workspaceText is the name of workspace id in s, with its id, or the id
// alone when s does not show it.
func workspaceText(s Snapshot, id string) string {
	if i := groupIndex(s.Groups, id); i >= 0 && s.Groups[i].Name != "" && s.Groups[i].Name != id {
		return plainText(s.Groups[i].Name) + " (" + plainText(id) + ")"
	}
	return plainText(id)
}

// findJob is the job with id in list.
func findJob(list []jobView, id string) (jobView, bool) {
	i := slices.IndexFunc(list, func(j jobView) bool { return j.ID == id })
	if i < 0 {
		return jobView{}, false
	}
	return list[i], true
}

// paneJob is the newest active job whose agent runs in paneID now (the
// ledger lists newest first).
func paneJob(list []jobView, paneID string) (jobView, bool) {
	for _, j := range list {
		if j.State == "active" && j.Live.PaneID == paneID && j.Live.Status != "gone" && j.Live.Status != "" {
			return j, true
		}
	}
	return jobView{}, false
}

// readJobs is every unfinished job whose agent runs in paneID, the active
// ones first: wait --mine waits on all of them, so a read moves the mark
// of each, one in review too.
func readJobs(list []jobView, paneID string) []jobView {
	var active, rest []jobView
	for _, j := range list {
		if jobFinished(j.State) || j.Live.PaneID != paneID || j.Live.Status == "gone" || j.Live.Status == "" {
			continue
		}
		if j.State == "active" {
			active = append(active, j)
		} else {
			rest = append(rest, j)
		}
	}
	return append(active, rest...)
}

// worktreeJob is the newest job made for the worktree at dir.
func worktreeJob(list []jobView, dir string) (jobView, bool) {
	for _, j := range list {
		if j.Worktree != nil && filepath.Clean(j.Worktree.Dir) == filepath.Clean(dir) {
			return j, true
		}
	}
	return jobView{}, false
}

// jobNote adds ev to the history of the active job of paneID, if it has
// one, and returns its id. Any failure is a warning.
func (c *cli) jobNote(port int, paneID string, ev jobEventInput) string {
	list, err := c.jobsGet(port, false)
	if err != nil {
		c.jobWarn(err)
		return ""
	}
	j, ok := paneJob(list, paneID)
	if !ok {
		return ""
	}
	if err := c.jobEvent(port, j.ID, ev); err != nil {
		c.jobWarn(err)
	}
	return j.ID
}

// jobWarn says on stderr that the ledger was not updated: the command
// itself went through, and its output (--json) stays clean.
func (c *cli) jobWarn(err error) {
	fmt.Fprintf(c.errOut, "%s the job ledger was not updated: %v\n", c.paint(ansiYellow, "[WARN]"), err)
}

// jobEvent posts ev to job id's history.
func (c *cli) jobEvent(port int, id string, ev jobEventInput) error {
	r, err := c.agentsCall(port, http.MethodPost, "/api/mux/jobs/"+url.PathEscape(id)+"/event", ev, agentsReadTimeout)
	if err != nil {
		return err
	}
	if r.status != http.StatusOK {
		return agentsRefusal(r)
	}
	return nil
}

// jobWrite sends method path with body and reads the job of the answer.
func (c *cli) jobWrite(port int, method, path string, body any, want int) (jobView, error) {
	r, err := c.agentsCall(port, method, path, body, agentsReadTimeout)
	if err != nil {
		return jobView{}, err
	}
	if r.status != want {
		return jobView{}, agentsRefusal(r)
	}
	return jobReply(r)
}

// jobWriteAgent is jobWrite for a body that gives the job a pane's agent:
// while the server does not see that agent yet, the write is tried again;
// past agentsJobAgentWait, without the pane and the state that goes with
// it. bound reports whether the job got the agent.
func (c *cli) jobWriteAgent(port int, method, path string, body map[string]any, want int) (j jobView, bound bool, err error) {
	deadline := time.Now().Add(agentsJobAgentWait)
	for {
		r, err := c.agentsCall(port, method, path, body, agentsReadTimeout)
		switch {
		case err != nil:
			return jobView{}, false, err
		case r.status == want:
			j, err := jobReply(r)
			return j, err == nil, err
		case r.failure().Code != "job_no_agent":
			return jobView{}, false, agentsRefusal(r)
		}
		if !time.Now().Before(deadline) {
			break
		}
		time.Sleep(agentsJobAgentEvery)
	}
	without := maps.Clone(body)
	delete(without, "pane")
	delete(without, "state")
	j, err = c.jobWrite(port, method, path, without, want)
	return j, false, err
}

// noAgentYet says that job j was written without the agent of paneID, and
// how to give it that agent once the server sees it.
func (c *cli) noAgentYet(j jobView, paneID string) {
	c.infof("Job %s: %s, without its agent: the server does not see the agent in pane %s yet; give it the job once it does: termote agents job set %s --pane %s --state active",
		plainText(j.ID), plainText(j.Title), plainText(paneID), plainText(j.ID), plainText(paneID))
}

// jobReply reads the job of a write's answer.
func jobReply(r agentsReply) (jobView, error) {
	var out struct {
		Job jobView `json:"job"`
	}
	if err := json.Unmarshal(r.body, &out); err != nil || out.Job.ID == "" {
		return jobView{}, fmt.Errorf("unexpected answer from the server to the job")
	}
	return out.Job, nil
}

// selfKey is the activity key of the pane this command runs in, "" when
// its environment does not say for sure.
func (c *cli) selfKey(s Snapshot) string {
	id := c.selfPaneID(s)
	if id == "" {
		return ""
	}
	p, ok := findAgentPane(s, id)
	if !ok {
		return ""
	}
	return p.key()
}

func (c *cli) agentsJobs(args []string) error {
	if len(args) > 0 && args[0] == "prune" {
		return c.agentsJobsPrune(args[1:])
	}
	var ws string
	mine, all, ready, asJSON := false, false, false, false
	fs := c.newFlagSet("agents jobs")
	fs.StringVar(&ws, "workspace", "", "")
	fs.BoolVar(&mine, "mine", false, "")
	fs.BoolVar(&ready, "ready", false, "")
	fs.BoolVar(&all, "all", false, "")
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if slices.Contains(pos, "prune") {
		return usageError("prune goes first, before its flags\n%s", jobsPruneUsage)
	}
	if len(pos) != 0 {
		return usageError("jobs takes no arguments\n%s", jobsUsage)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	s, err := c.agentsSnapshot(port)
	if err != nil {
		return err
	}
	self := ""
	if mine {
		if self = c.selfKey(s); self == "" {
			return fmt.Errorf("--mine needs to know this command's pane, and its environment does not say for sure (herdr-core, psmux, Windows, or another pane's variables); list every job instead: termote agents jobs")
		}
	}
	var group Group
	if ws != "" {
		if group, err = resolveGroup(s, ws); err != nil {
			return err
		}
	}
	l, err := c.jobsQuery(port, all, ready)
	if err != nil {
		return err
	}
	list := slices.DeleteFunc(l.Jobs, func(j jobView) bool {
		return (mine && j.CreatedBy != self) || (ws != "" && j.Workspace != group.ID && j.WorkspaceNow != group.ID)
	})
	if asJSON {
		if list == nil {
			list = []jobView{}
		}
		return writeJSON(c.out, map[string]any{"jobs": list})
	}
	filter := "unfinished jobs"
	if all {
		filter = "every job"
	}
	if ready {
		filter = "jobs ready to start"
	}
	if mine {
		filter += ", made from this pane"
	} else {
		filter += ", of every creator"
	}
	if ws != "" {
		filter += ", of workspace " + plainText(group.Name)
	}
	fmt.Fprintf(c.out, "Jobs (%s): %d\n", filter, len(list))
	if len(list) == 0 {
		return nil
	}
	tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "JOB\tTITLE\tSTATE\tPRI\tAFTER\tWS\tPANE\tAGENT\tUNREAD\tBRANCH\tPR\tDIR\tUPDATED")
	for _, j := range list {
		pane, branch, dir := "-", "-", "-"
		if j.Live.PaneID != "" {
			pane = plainText(j.Live.Ref) + " (" + plainText(j.Live.PaneID) + ")"
		}
		if j.Worktree != nil && !j.Live.OutsideWorktree {
			branch, dir = plainText(j.Worktree.Branch), plainText(c.tildeDir(j.Worktree.Dir))
		} else {
			// The pane's folder and branch now: the job has no worktree,
			// or it was given a pane in another folder.
			branch, dir = dash(plainText(j.Live.Branch)), dash(plainText(c.tildeDir(j.Live.Dir)))
		}
		unread := ""
		if j.Live.Unread {
			unread = "yes"
		}
		pri := "-"
		if j.Priority != "" {
			pri = plainText(j.Priority)
		}
		wsName, wsID := "-", cmp.Or(j.WorkspaceNow, j.Workspace)
		if wsID != "" {
			wsName = plainText(wsID)
			if i := groupIndex(s.Groups, wsID); i >= 0 && s.Groups[i].Name != "" {
				wsName = clipLine(plainText(s.Groups[i].Name), 20)
			}
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", plainText(j.ID), clipLine(plainText(j.Title), 40), plainText(j.State),
			pri, afterShort(j), wsName, pane, dash(c.liveText(j.Live)), dash(unread), branch, dash(ciShort(j.CISummary)), dir, sinceText(j.Updated.Format(time.RFC3339)))
	}
	return tw.Flush()
}

// afterShort is what j still waits on, as the table prints it: a failed or
// abandoned one marked !, past three a count.
func afterShort(j jobView) string {
	var parts []string
	for i, id := range j.WaitsOn {
		if i == 3 {
			parts = append(parts, fmt.Sprintf("+%d", len(j.WaitsOn)-3))
			break
		}
		if slices.Contains(j.WaitsOnFailed, id) {
			id += "!"
		}
		parts = append(parts, plainText(id))
	}
	return dash(strings.Join(parts, " "))
}

// liveText is what the job's agent does, as printed.
func (c *cli) liveText(l jobLive) string {
	if l.Status == "background" && l.Background != "" {
		return "background (" + plainText(clipLine(l.Background, 40)) + ")"
	}
	return plainText(l.Status)
}

// tildeDir is dir with the home dir written ~.
func (c *cli) tildeDir(dir string) string {
	if c.home != "" {
		if rel, err := filepath.Rel(c.home, dir); err == nil && !strings.HasPrefix(rel, "..") {
			if rel == "." {
				return "~"
			}
			return filepath.Join("~", rel)
		}
	}
	return dir
}

func (c *cli) agentsJob(args []string) error {
	if len(args) == 0 {
		return usageError("agents job needs add, show, set, ci, remove or finish\n%s\n%s\n%s\n%s\n%s\n%s", jobAddUsage, jobShowUsage, jobSetUsage, jobCIUsage, jobRemoveUsage, jobFinishUsage)
	}
	switch args[0] {
	case "add":
		return c.agentsJobAdd(args[1:])
	case "show":
		return c.agentsJobShow(args[1:])
	case "set":
		return c.agentsJobSet(args[1:])
	case "ci":
		return c.agentsJobCI(args[1:])
	case "remove":
		return c.agentsJobRemove(args[1:])
	case "finish":
		return c.agentsJobFinish(args[1:])
	}
	return usageError("unknown agents job command: %s\n%s\n%s\n%s\n%s\n%s\n%s", args[0], jobAddUsage, jobShowUsage, jobSetUsage, jobCIUsage, jobRemoveUsage, jobFinishUsage)
}

func (c *cli) agentsJobAdd(args []string) error {
	var title, pane, note, priority, ws string
	var after []string
	asJSON, hasNote := false, false
	fs := c.newFlagSet("agents job add")
	fs.StringVar(&title, "title", "", "")
	fs.StringVar(&pane, "pane", "", "")
	fs.Func("note", "", func(s string) error { note, hasNote = s, true; return nil })
	fs.Func("priority", "", priorityFlag(&priority))
	fs.Func("after", "", jobIDFlag(&after))
	fs.StringVar(&ws, "workspace", "", "")
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	switch {
	case len(pos) != 0:
		return usageError("job add takes no arguments; the title goes in --title\n%s", jobAddUsage)
	case strings.TrimSpace(title) == "":
		return usageError("job add needs --title <title>")
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	s, err := c.agentsSnapshot(port)
	if err != nil {
		return err
	}
	body := map[string]any{"title": title}
	if by := c.selfKey(s); by != "" {
		body["createdBy"] = by
	}
	if priority != "" {
		body["priority"] = priority
	}
	if len(after) > 0 {
		body["after"] = after
	}
	var group Group
	if ws != "" {
		if group, err = resolveGroup(s, ws); err != nil {
			return err
		}
		body["workspace"] = group.ID
	}
	if hasNote {
		if note, err = c.readText(note); err != nil {
			return err
		}
		body["note"] = note
	}
	if pane != "" {
		p, err := c.agentsOtherPane(port, pane, jobSelfPane)
		if err != nil {
			return err
		}
		if ws != "" && group.ID != p.group.ID {
			return usageError("--workspace %s is not the workspace of pane %s; leave --workspace out\n%s", plainText(ws), plainText(p.pane.ID), jobAddUsage)
		}
		body["pane"] = p.pane.ID
		body["workspace"] = p.group.ID
	}
	j, err := c.jobWrite(port, http.MethodPost, "/api/mux/jobs", body, http.StatusCreated)
	if err != nil {
		return err
	}
	if asJSON {
		return writeJSON(c.out, j)
	}
	c.infof("Added job %s: %s (%s)", plainText(j.ID), plainText(j.Title), jobOrderText(j))
	return nil
}

// jobOrderText is a job's state, with its priority when not normal and the
// jobs it waits on.
func jobOrderText(j jobView) string {
	parts := []string{plainText(j.State)}
	if j.Priority != "" {
		parts = append(parts, plainText(j.Priority))
	}
	if len(j.After) > 0 {
		ids := make([]string, len(j.After))
		for i, id := range j.After {
			ids[i] = plainText(id)
		}
		parts = append(parts, "after "+strings.Join(ids, " "))
	}
	return strings.Join(parts, ", ")
}

func (c *cli) agentsJobShow(args []string) error {
	asJSON := false
	fs := c.newFlagSet("agents job show")
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 {
		return usageError("job show takes one job id\n%s", jobShowUsage)
	}
	port, err := c.agentsPort()
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
	if asJSON {
		return writeJSON(c.out, j)
	}
	fmt.Fprintf(c.out, "Job %s: %s\n", plainText(j.ID), plainText(j.Title))
	fmt.Fprintf(c.out, "State: %s; made by %s %s\n", plainText(j.State), plainText(j.CreatedBy), sinceText(j.Created.Format(time.RFC3339)))
	fmt.Fprintf(c.out, "Priority: %s\n", priorityText(j.Priority))
	if len(j.WaitsOn) > 0 {
		fmt.Fprintf(c.out, "Waits on: %s\n", waitsText(list, j.WaitsOn, j.WaitsOnFailed))
	}
	if done := len(j.After) - len(j.WaitsOn); done > 0 {
		fmt.Fprintf(c.out, "After: %d job(s) done\n", done)
	}
	if j.Workspace != "" {
		s, _ := c.agentsSnapshot(port)
		if j.WorkspaceNow != "" {
			fmt.Fprintf(c.out, "Workspace: %s (%s was closed; the same repository)\n", workspaceText(s, j.WorkspaceNow), plainText(j.Workspace))
		} else {
			fmt.Fprintf(c.out, "Workspace: %s\n", workspaceText(s, j.Workspace))
		}
	}
	if j.Repo != "" {
		fmt.Fprintf(c.out, "Repository: %s\n", plainText(c.tildeDir(j.Repo)))
	}
	if j.Agent != nil {
		unread := ""
		if j.Live.Unread {
			unread = "; a turn ended that was not read: termote agents read " + plainText(j.Live.PaneID)
		}
		fmt.Fprintf(c.out, "Agent: %s in %s (%s): %s%s\n", plainText(j.Agent.Kind), plainText(j.Live.Ref), plainText(j.Live.PaneID), c.liveText(j.Live), unread)
	}
	if j.Live.Dir != "" && (j.Worktree == nil || j.Live.OutsideWorktree) {
		fmt.Fprintf(c.out, "Folder: %s, branch %s\n", plainText(c.tildeDir(j.Live.Dir)), dash(plainText(j.Live.Branch)))
	}
	if w := j.Worktree; w != nil {
		elsewhere := ""
		if j.Live.OutsideWorktree {
			elsewhere = "; its agent now works in another folder"
		}
		fmt.Fprintf(c.out, "Worktree: branch %s (base %s) in %s%s\n", plainText(w.Branch), dash(plainText(w.Base)), plainText(c.tildeDir(w.Dir)), elsewhere)
	}
	if d := j.Diff; d != nil {
		fmt.Fprintf(c.out, "Last diff: %d commits, %d files (%s)\n", d.Commits, d.Files, sinceText(d.At))
	}
	if line := ciLine(j.CI); line != "" {
		fmt.Fprintf(c.out, "PRs: %s (termote agents job ci %s)\n", line, plainText(j.ID))
	}
	for _, g := range j.Grants {
		state := "in force until " + plainText(g.Expires)
		if g.Revoked != "" {
			state = "ended"
		}
		fmt.Fprintf(c.out, "Grant %s: %s %s, %s, used %d times\n", plainText(g.ID), plainText(g.Kind), plainText(g.Prefix), state, len(g.Uses))
	}
	if j.Prompt != "" {
		fmt.Fprintf(c.out, "\nPrompt:\n%s\n", cleanOut(j.Prompt))
	}
	if j.Note != "" {
		fmt.Fprintf(c.out, "\nNote:\n%s\n", cleanOut(j.Note))
	}
	if len(j.Events) > 0 {
		fmt.Fprintln(c.out, "\nHistory:")
		for _, e := range j.Events {
			fmt.Fprintf(c.out, "  %s  %s %s\n", plainText(e.At), plainText(e.Kind), plainText(e.Text))
		}
	}
	return nil
}

func (c *cli) agentsJobSet(args []string) error {
	var state, pane, title, note, priority, ws string
	var addPRs, removePRs []int
	var addAfter, removeAfter []string
	hasNote, noWS := false, false
	fs := c.newFlagSet("agents job set")
	fs.StringVar(&state, "state", "", "")
	fs.StringVar(&pane, "pane", "", "")
	fs.StringVar(&title, "title", "", "")
	fs.Func("note", "", func(s string) error { note, hasNote = s, true; return nil })
	fs.Func("pr", "", prNumberFlag(&addPRs))
	fs.Func("no-pr", "", prNumberFlag(&removePRs))
	fs.Func("priority", "", priorityFlag(&priority))
	fs.Func("after", "", jobIDFlag(&addAfter))
	fs.Func("no-after", "", jobIDFlag(&removeAfter))
	fs.StringVar(&ws, "workspace", "", "")
	fs.BoolVar(&noWS, "no-workspace", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	switch {
	case len(pos) != 1:
		return usageError("job set takes one job id\n%s", jobSetUsage)
	case state == "" && pane == "" && title == "" && !hasNote && len(addPRs) == 0 && len(removePRs) == 0 &&
		priority == "" && len(addAfter) == 0 && len(removeAfter) == 0 && ws == "" && !noWS:
		return usageError("job set needs --state, --title, --note, --pane, --pr, --no-pr, --priority, --after, --no-after, --workspace or --no-workspace\n%s", jobSetUsage)
	case ws != "" && noWS:
		return usageError("--workspace and --no-workspace go one at a time\n%s", jobSetUsage)
	case noWS && pane != "":
		return usageError("--pane gives the job the pane's workspace; leave --no-workspace out\n%s", jobSetUsage)
	}
	if state != "" && (!slices.Contains(jobStates, state) || state == "todo") {
		return usageError("--state is active, review, done, failed or abandoned")
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	list, err := c.jobsGet(port, true)
	if err != nil {
		return err
	}
	before, ok := findJob(list, pos[0])
	if !ok {
		return fmt.Errorf("no job %s; see: termote agents jobs --all", plainText(pos[0]))
	}
	body := map[string]any{}
	if state != "" {
		body["state"] = state
	}
	if title != "" {
		body["title"] = title
	}
	if hasNote {
		if note, err = c.readText(note); err != nil {
			return err
		}
		body["note"] = note
	}
	if len(addPRs) > 0 {
		body["addPrs"] = addPRs
	}
	if len(removePRs) > 0 {
		body["removePrs"] = removePRs
	}
	if priority != "" {
		body["priority"] = priority
	}
	if len(addAfter) > 0 || len(removeAfter) > 0 {
		next, err := nextAfter(before.After, addAfter, removeAfter)
		if err != nil {
			return err
		}
		// The list as read: a change made meanwhile is a job_conflict, never
		// overwritten.
		body["after"] = next
		body["updated"] = before.Updated.Format(time.RFC3339Nano)
	}
	var group Group
	if ws != "" {
		s, err := c.agentsSnapshot(port)
		if err != nil {
			return err
		}
		if group, err = resolveGroup(s, ws); err != nil {
			return err
		}
		body["workspace"] = group.ID
	}
	if noWS {
		body["workspace"] = ""
	}
	if pane != "" {
		p, err := c.agentsOtherPane(port, pane, jobSelfPane)
		if err != nil {
			return err
		}
		if ws != "" && group.ID != p.group.ID {
			return usageError("--workspace %s is not the workspace of pane %s; leave --workspace out\n%s", plainText(ws), plainText(p.pane.ID), jobSetUsage)
		}
		body["pane"] = p.pane.ID
	}
	j, err := c.jobWrite(port, http.MethodPatch, "/api/mux/jobs/"+url.PathEscape(before.ID), body, http.StatusOK)
	if err != nil {
		return err
	}
	c.infof("Job %s: %s (%s)", plainText(j.ID), plainText(j.Title), jobOrderText(j))
	if ended := grantsEnded(before.job, j.job); ended > 0 {
		c.infof("%d grant(s) of the job ended with this change; only the user can give new ones, from the PWA", ended)
	}
	return nil
}

// nextAfter is after with add appended and remove taken out, refusing a
// remove that after does not hold.
func nextAfter(after, add, remove []string) ([]string, error) {
	for _, id := range remove {
		if !slices.Contains(after, id) {
			return nil, usageError("the job does not wait on %s; see: termote agents job show <id>", plainText(id))
		}
	}
	next := []string{}
	for _, id := range slices.Concat(after, add) {
		if !slices.Contains(remove, id) && !slices.Contains(next, id) {
			next = append(next, id)
		}
	}
	return next, nil
}

// agentsJobRemove removes a finished job from the ledger, as read: one the
// user or an agent changed since is refused by the server (job_conflict).
// An unfinished one is refused here before anything is sent, and by the
// server for any request over the local socket (job_unfinished).
func (c *cli) agentsJobRemove(args []string) error {
	fs := c.newFlagSet("agents job remove")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 {
		return usageError("job remove takes one job id\n%s", jobRemoveUsage)
	}
	port, err := c.agentsPort()
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
	if !jobFinished(j.State) {
		return fmt.Errorf("job %s is %s; only a done, failed or abandoned job is removed. Finish it first: termote agents job set %s --state abandoned",
			plainText(j.ID), plainText(j.State), plainText(j.ID))
	}
	if _, err := c.jobDelete(port, j); err != nil {
		return err
	}
	c.infof("Removed job %s: %s", plainText(j.ID), plainText(j.Title))
	return nil
}

// jobDelete deletes job j as read (its updated time); a refusal comes with
// the server's code.
func (c *cli) jobDelete(port int, j jobView) (string, error) {
	path := "/api/mux/jobs/" + url.PathEscape(j.ID) + "?updated=" + url.QueryEscape(j.Updated.Format(time.RFC3339Nano))
	r, err := c.agentsCall(port, http.MethodDelete, path, nil, agentsReadTimeout)
	if err != nil {
		return "", err
	}
	if r.status != http.StatusOK {
		return r.failure().Code, agentsRefusal(r)
	}
	return "", nil
}

// parseOlderThan reads --older-than: a count of hours, days or weeks.
func parseOlderThan(s string) (time.Duration, error) {
	n, unit, ok := parseCountUnit(s)
	switch {
	case !ok || n == 0:
		return 0, usageError("--older-than takes a count above 0 and h, d or w (12h, 7d, 2w)\n%s", jobsPruneUsage)
	case n > int(time.Duration(math.MaxInt64)/unit):
		return 0, usageError("--older-than is too long\n%s", jobsPruneUsage)
	}
	return time.Duration(n) * unit, nil
}

// agentsJobsPrune removes every finished job, or those not changed for
// --older-than by the server's clock, each as read: a job changed or
// removed meanwhile is skipped.
func (c *cli) agentsJobsPrune(args []string) error {
	var olderThan string
	dryRun, asJSON := false, false
	fs := c.newFlagSet("agents jobs prune")
	fs.StringVar(&olderThan, "older-than", "", "")
	fs.BoolVar(&dryRun, "dry-run", false, "")
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 0 {
		return usageError("jobs prune takes no arguments\n%s", jobsPruneUsage)
	}
	var age time.Duration
	if olderThan != "" {
		if age, err = parseOlderThan(olderThan); err != nil {
			return err
		}
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	l, err := c.jobsListingGet(port, true)
	if err != nil {
		return err
	}
	now, err := time.Parse(time.RFC3339Nano, l.ServerNow)
	if err != nil {
		now = time.Now()
	}
	var picked []jobView
	for _, j := range l.Jobs {
		// Without --older-than every finished job goes, however recent:
		// serverNow is in milliseconds, a job's updated time is not.
		if jobFinished(j.State) && (age == 0 || !j.Updated.After(now.Add(-age))) {
			picked = append(picked, j)
		}
	}
	ids := func(list []jobView) []string {
		out := []string{}
		for _, j := range list {
			out = append(out, j.ID)
		}
		return out
	}
	if dryRun {
		if asJSON {
			return writeJSON(c.out, map[string]any{"wouldRemove": ids(picked)})
		}
		if len(picked) > 0 {
			tw := tabwriter.NewWriter(c.out, 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "JOB\tTITLE\tSTATE\tUPDATED")
			for _, j := range picked {
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", plainText(j.ID), clipLine(plainText(j.Title), 48), plainText(j.State), sinceText(j.Updated.Format(time.RFC3339)))
			}
			if err := tw.Flush(); err != nil {
				return err
			}
		}
		fmt.Fprintf(c.out, "Would remove %d job(s)\n", len(picked))
		return nil
	}
	var removed, skipped []jobView
	for _, j := range picked {
		code, err := c.jobDelete(port, j)
		if err == nil {
			removed = append(removed, j)
			continue
		}
		// Changed, reopened or removed elsewhere since it was read.
		if code == "job_conflict" || code == "job_unfinished" || code == "job_not_found" {
			skipped = append(skipped, j)
			continue
		}
		return fmt.Errorf("removed %d job(s) %v, then: %w", len(removed), ids(removed), err)
	}
	if asJSON {
		return writeJSON(c.out, map[string]any{"removed": ids(removed), "skipped": ids(skipped)})
	}
	if len(picked) == 0 {
		c.infof("No finished job to remove")
		return nil
	}
	c.infof("Removed %d job(s); skipped %d (changed meanwhile)", len(removed), len(skipped))
	return nil
}

// grantsEnded counts the grants in force before that are not after.
func grantsEnded(before, after job) int {
	n := 0
	for _, g := range before.Grants {
		if g.Revoked != "" {
			continue
		}
		i := slices.IndexFunc(after.Grants, func(a grant) bool { return a.ID == g.ID })
		if i < 0 || after.Grants[i].Revoked != "" {
			n++
		}
	}
	return n
}

// jobEnd is what wait --job reports of one job.
type jobEnd int

const (
	jobEndNone jobEnd = iota
	jobEndDone
	jobEndBackground
	jobEndDialog
	jobEndGone
	jobEndFinished
)

func (e jobEnd) exit() int {
	switch e {
	case jobEndDialog:
		return agentsExitDialog
	case jobEndGone:
		return agentsExitGone
	}
	return 0
}

// reportedSig names a dialog for wait --job's "reported once": what it shows.
func reportedSig(p AgentPrompt) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00%s", p.Kind, p.Title, p.Body)
	for _, o := range p.Options {
		fmt.Fprintf(h, "\x00%s", o.Label)
	}
	return hex.EncodeToString(h.Sum(nil))[:24]
}

// agentsWaitJobs waits on the jobs named by --job; agentsWaitMine (wait
// --mine) on every unfinished job made from this command's pane.
func (c *cli) agentsWaitJobs(args []string) error {
	timeout := agentsJobsWait
	fs := c.newFlagSet("agents wait")
	fs.DurationVar(&timeout, "timeout", agentsJobsWait, "")
	fs.Bool("job", true, "")
	ids, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	switch {
	case len(ids) == 0:
		return usageError("wait --job needs at least one job id\n%s", waitJobUsage)
	case timeout <= 0:
		return usageError("--timeout must be more than 0\n%s", waitJobUsage)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	return c.waitJobs(port, jobWait{ids: ids}, timeout)
}

// jobWait is what a wait on jobs waits for: the jobs named by --job, or
// with self (wait --mine) every unfinished job whose creator is the pane
// with that activity key, read from each poll's ledger, so a job started
// while it waits is waited for too.
type jobWait struct {
	ids  []string
	self string
	// pane: the id of the pane of self, which marks the PWA's answers to
	// its questions reported.
	pane string
}

func (w jobWait) mine() bool { return w.self != "" }

// jobs is the ids of the jobs waited for in list.
func (w jobWait) jobs(list []jobView) []string {
	if !w.mine() {
		return w.ids
	}
	var ids []string
	for _, j := range list {
		if j.CreatedBy == w.self && !jobFinished(j.State) {
			ids = append(ids, j.ID)
		}
	}
	return ids
}

// again is the command that waits on ids, what is left of this wait.
func (w jobWait) again(ids []string) string {
	if w.mine() {
		return "termote agents wait --mine"
	}
	return "termote agents wait --job " + strings.Join(ids, " ")
}

// waitJobs waits until one of the jobs needs the orchestrator: its agent
// ended a turn not read yet, shows a dialog not reported yet, only waits
// on background work, or is gone. Each poll reads the ledger again, so a
// turn that ended before the wait, or between two polls, is reported.
func (c *cli) waitJobs(port int, w jobWait, timeout time.Duration) error {
	start := time.Now()
	deadline := start.Add(timeout)
	failures := 0
	// last, lastIDs: the ledger as the last poll that could read it saw
	// it, and the jobs that could still end a turn then; busyAt: when a
	// job's agent was last seen busy (from the start), as wait does for
	// panes: the next turn starts a moment after background work ends.
	var last []jobView
	var lastOpen []string
	lastIDs := w.ids
	busyAt := start
	for {
		list, err := c.jobsGet(port, true)
		if err != nil {
			if failures++; failures >= agentsWaitFailures {
				return err
			}
		} else {
			failures = 0
			// wait --mine: the user's answers in the PWA to this pane's
			// questions, and the ones dismissed there, end the wait too,
			// reported once.
			var answers []askView
			var open []string
			if w.mine() {
				answers, open = c.mineAsks(port, w.self)
			}
			ids := w.jobs(list)
			ends, rest, skipped, err := c.jobEnds(port, list, ids, w.mine())
			if err != nil {
				return err
			}
			if len(ends) > 0 || len(answers) > 0 {
				c.reportAskReplies(port, w.pane, answers)
				return c.jobsEnded(port, list, ids, ends, rest, w)
			}
			if len(rest) == 0 {
				// wait --mine only: no job, or none whose agent can end a
				// turn.
				err := c.jobsNone(list, skipped)
				c.openAsksLine(open)
				return err
			}
			last, lastIDs, lastOpen = list, rest, open
			// An agent given work a moment ago may not have started yet:
			// as wait does for panes, idle ends the wait only after the
			// grace, or at the timeout.
			if !jobsAllIdle(list, rest) {
				busyAt = time.Now()
			} else if time.Since(busyAt) >= agentsWaitGrace || !time.Now().Before(deadline) {
				err := c.jobsNothing(list, rest, skipped)
				c.openAsksLine(open)
				return err
			}
		}
		if !time.Now().Before(deadline) {
			c.jobsStill(last, lastIDs, timeout, w)
			c.openAsksLine(lastOpen)
			return &exitError{code: agentsExitTimeout}
		}
		time.Sleep(agentsWaitEvery)
	}
}

// jobsAllIdle: the agent of every one of ids is idle with its last turn
// read and nothing its ended turn left running in the background ("1
// shell", whose end starts its next turn), so nothing would ever end a wait
// on them.
func jobsAllIdle(list []jobView, ids []string) bool {
	for _, id := range ids {
		j, ok := findJob(list, id)
		if !ok || j.Live.Status != "idle" || j.Live.Unread || j.Live.Background != "" {
			return false
		}
	}
	return true
}

// jobsNothing: every job's agent is idle and its last turn was read.
func (c *cli) jobsNothing(list []jobView, ids, skipped []string) error {
	fmt.Fprintln(c.out, "Nothing to wait for: no job's agent is working and none ended a turn you have not read.")
	for _, id := range ids {
		j, _ := findJob(list, id)
		pid := plainText(j.Live.PaneID)
		fmt.Fprintf(c.out, "Job %s (%s): %s (%s) is idle and its last turn was read; give it work (termote agents send %s -) or record what it did (termote agents job set %s --state review)\n",
			plainText(j.ID), plainText(j.Title), plainText(j.Live.Ref), pid, pid, plainText(j.ID))
	}
	c.jobsSkipped(list, skipped)
	return &exitError{code: agentsExitIdle}
}

// jobsNone: wait --mine found no job made from this pane whose agent can
// end a turn, as wait exits when nothing works.
func (c *cli) jobsNone(list []jobView, skipped []string) error {
	if len(skipped) == 0 {
		fmt.Fprintln(c.out, "Nothing to wait for: no unfinished job was made from this pane; start one: termote agents start --workspace <id | name> --kind <kind> ...")
	} else {
		fmt.Fprintln(c.out, "Nothing to wait for: no job made from this pane has an agent that can end a turn.")
		c.jobsSkipped(list, skipped)
	}
	return &exitError{code: agentsExitIdle}
}

// jobsSkipped names the jobs wait --mine does not wait for: no agent, or
// one whose loss was reported before.
func (c *cli) jobsSkipped(list []jobView, skipped []string) {
	for _, id := range skipped {
		j, _ := findJob(list, id)
		jid := plainText(j.ID)
		if j.Agent == nil {
			fmt.Fprintf(c.out, "Job %s (%s) has no agent; give it one (termote agents start --job %s ...) or end it (termote agents job set %s --state abandoned)\n",
				jid, plainText(j.Title), jid, jid)
			continue
		}
		fmt.Fprintf(c.out, "Job %s (%s): its agent no longer runs in %s (%s), reported before; give the job another pane (termote agents job set %s --pane <pane>) or end it (--state done, failed or abandoned)\n",
			jid, plainText(j.Title), plainText(j.Live.Ref), plainText(j.Live.PaneID), jid)
	}
}

// jobsStill says, at the timeout, what each job's agent does: none of them
// needs the orchestrator yet.
func (c *cli) jobsStill(list []jobView, ids []string, timeout time.Duration, w jobWait) {
	fmt.Fprintf(c.out, "Still waiting after %s:\n", timeout)
	for _, id := range ids {
		j, ok := findJob(list, id)
		if !ok {
			// No poll could read the ledger.
			fmt.Fprintf(c.out, "Job %s: the ledger could not be read\n", plainText(id))
			continue
		}
		l := j.Live
		what := "is " + c.liveText(l)
		switch l.Status {
		case "blocked":
			what = "still waits on the dialog reported before; see it: termote agents answer " + plainText(l.PaneID)
		case "background":
			what = "still waits on the background work reported before (" + plainText(clipLine(l.Background, 80)) + ")"
		case "idle":
			what = "is idle and its last turn was read"
			if l.Background != "" {
				what = "ended its turn and still runs in the background (" + plainText(clipLine(l.Background, 80)) + "); its next turn starts when that ends"
			}
		case "unknown":
			what = "could not be read"
		}
		fmt.Fprintf(c.out, "Job %s (%s): %s (%s) %s\n", plainText(j.ID), plainText(j.Title), plainText(l.Ref), plainText(l.PaneID), what)
	}
	if w.mine() && len(ids) == 0 {
		// No poll could read the ledger.
		fmt.Fprintln(c.out, "The ledger could not be read")
	}
	fmt.Fprintf(c.out, "wait again: %s\n", w.again(ids))
}

// goneSig is what a job's Reported holds once wait --mine reported that its
// agent no longer runs in paneID; a new agent given to the job clears it.
func goneSig(paneID string) string { return "gone:" + paneID }

// jobEnds is what each of ids reports now, and the ids left to wait for.
// With mine (wait --mine), a job without an agent, or whose agent's loss
// was reported before, is skipped: nothing it does can end the wait.
func (c *cli) jobEnds(port int, list []jobView, ids []string, mine bool) (ends map[string]jobEnd, rest, skipped []string, err error) {
	ends = map[string]jobEnd{}
	for _, id := range ids {
		j, ok := findJob(list, id)
		if !ok {
			return nil, nil, nil, fmt.Errorf("no job %s; see: termote agents jobs --all", plainText(id))
		}
		end := jobEndNone
		switch l := j.Live; {
		case jobFinished(j.State):
			end = jobEndFinished
		case j.Agent == nil && mine:
			skipped = append(skipped, id)
			continue
		case j.Agent == nil:
			return nil, nil, nil, fmt.Errorf("job %s has no agent to wait for; give it one: termote agents start --job %s ...", plainText(id), plainText(id))
		case l.Status == "gone" && mine && j.Reported == goneSig(l.PaneID):
			skipped = append(skipped, id)
			continue
		case l.Status == "gone":
			end = jobEndGone
			if mine {
				if err := c.jobEvent(port, j.ID, jobEventInput{Kind: "reported", Sig: goneSig(l.PaneID)}); err != nil {
					c.jobWarn(err)
				}
			}
		case l.Unread:
			end = jobEndDone
		case l.Status == "blocked":
			// A dialog is told from the next by what it shows and the
			// transcript's last entry then (the same command asked twice);
			// one the server cannot read is reported too, as wait does.
			sig := "no-dialog-read"
			var pr promptResponse
			if err := c.agentsGet(port, panePath(l.PaneID, "/agent/prompt"), &pr); err == nil && pr.Prompt != nil {
				sig = reportedSig(*pr.Prompt)
			}
			if sig += "@" + l.EntryTS; sig != j.Reported {
				end = jobEndDialog
				if err := c.jobEvent(port, j.ID, jobEventInput{Kind: "reported", Sig: sig}); err != nil {
					c.jobWarn(err)
				}
			}
		case l.Status == "background" && j.Reported != "background:"+l.Background:
			end = jobEndBackground
			if err := c.jobEvent(port, j.ID, jobEventInput{Kind: "reported", Sig: "background:" + l.Background}); err != nil {
				c.jobWarn(err)
			}
		}
		if end == jobEndNone {
			rest = append(rest, id)
		} else {
			ends[id] = end
		}
	}
	return ends, rest, skipped, nil
}

// jobsEnded prints every job that needs the orchestrator and how to go on.
func (c *cli) jobsEnded(port int, list []jobView, ids []string, ends map[string]jobEnd, rest []string, w jobWait) error {
	code := 0
	// again: wait --mine goes on with every job still unfinished whose
	// agent runs, the ones reported now included once read.
	again := len(rest) > 0
	for _, id := range ids {
		end, ok := ends[id]
		if !ok {
			continue
		}
		j, _ := findJob(list, id)
		ref, pid, jid := plainText(j.Live.Ref), plainText(j.Live.PaneID), plainText(j.ID)
		switch end {
		case jobEndDone:
			if c.paneEndsWithQuestion(port, j.Live.PaneID) {
				fmt.Fprintf(c.out, "Job %s (%s): %s (%s) ended a turn with a question for the user; read it: termote agents read %s\n", jid, plainText(j.Title), ref, pid, pid)
			} else {
				fmt.Fprintf(c.out, "Job %s (%s): %s (%s) ended a turn; read it: termote agents read %s\n", jid, plainText(j.Title), ref, pid, pid)
			}
		case jobEndBackground:
			fmt.Fprintf(c.out, "Job %s (%s): %s (%s) wrote its answer and only waits on background work (%s); read it: termote agents read %s\n",
				jid, plainText(j.Title), ref, pid, plainText(clipLine(j.Live.Background, 80)), pid)
		case jobEndDialog:
			fmt.Fprintf(c.out, "Job %s (%s): %s (%s) waits on a dialog; see it: termote agents answer %s\n", jid, plainText(j.Title), ref, pid, pid)
		case jobEndFinished:
			fmt.Fprintf(c.out, "Job %s (%s) is %s: nothing to wait for\n", jid, plainText(j.Title), plainText(j.State))
		case jobEndGone:
			fmt.Fprintf(c.out, "Job %s (%s): its agent no longer runs in %s (%s); give the job another pane (termote agents job set %s --pane <pane>) or end it (--state abandoned)\n",
				jid, plainText(j.Title), ref, pid, jid)
		}
		if end == jobEndDone || end == jobEndBackground || end == jobEndDialog {
			again = again || w.mine()
		}
		code = max(code, end.exit())
	}
	if again {
		fmt.Fprintf(c.out, "next: %s\n", w.again(rest))
	}
	if code != 0 {
		return &exitError{code: code}
	}
	return nil
}

// startRecord is what a start knows of the job it starts or goes on with.
type startRecord struct {
	snap   Snapshot
	group  Group
	kind   string
	title  string
	prompt string
	// todo: the job the user made, named by --job
	todo         *jobView
	branch, base string
	// made: the start made the worktree (not one it opened again)
	made bool
}

// defaultTitle never comes from the prompt: a view-only client sees titles.
func (r startRecord) defaultTitle() string {
	if r.branch != "" {
		return r.kind + " in " + r.branch
	}
	return r.kind + " in " + r.group.Name
}

func (r startRecord) worktree() map[string]any {
	if r.branch == "" {
		return nil
	}
	wt := map[string]any{"source": r.group.ID, "branch": r.branch, "base": r.base}
	if r.made {
		wt["made"] = true
	}
	return wt
}

// recordStart writes the job of an agent started in t's pane: the job --job
// named, the unfinished job of the worktree when a start goes on there, or
// a new one. A failure is a warning: the agent runs.
func (c *cli) recordStart(port int, t startTarget, r startRecord) {
	var (
		j     jobView
		bound bool
		err   error
	)
	body := map[string]any{"pane": t.paneID, "state": "active"}
	if wt := r.worktree(); wt != nil {
		body["worktree"] = wt
	}
	prior := r.todo
	if prior == nil && t.worktree {
		if list, err := c.jobsGet(port, true); err == nil {
			if old, ok := worktreeJob(list, t.dir); ok && !jobFinished(old.State) {
				prior = &old
			}
		}
	}
	if prior != nil {
		if r.prompt != "" && prior.Prompt == "" {
			body["prompt"] = r.prompt
		}
		j, bound, err = c.jobWriteAgent(port, http.MethodPatch, "/api/mux/jobs/"+url.PathEscape(prior.ID), body, http.StatusOK)
		if err == nil && r.todo == nil {
			c.jobEvent(port, j.ID, jobEventInput{Kind: "continued", Text: "agent started again"})
		}
	} else {
		body["title"] = r.title
		if r.title == "" {
			body["title"] = r.defaultTitle()
		}
		body["prompt"] = r.prompt
		body["workspace"] = r.group.ID
		if by := c.selfKey(r.snap); by != "" {
			body["createdBy"] = by
		}
		j, bound, err = c.jobWriteAgent(port, http.MethodPost, "/api/mux/jobs", body, http.StatusCreated)
	}
	switch {
	case err != nil:
		c.jobWarn(err)
	case !bound:
		c.noAgentYet(j, t.paneID)
	default:
		c.infof("Job %s: %s; wait for it: termote agents wait --job %s", plainText(j.ID), plainText(j.Title), plainText(j.ID))
	}
}

// continueInWorktree gives the prompt of a start run again to the agent
// that already runs in the worktree's first pane, when it is idle; anything
// else is refused with the job named.
func (c *cli) continueInWorktree(port int, t startTarget, r startRecord) error {
	p := *t.running
	id := plainText(p.pane.ID)
	list, _ := c.jobsGet(port, true)
	j, found := worktreeJob(list, t.dir)
	if r.todo != nil {
		// --job: the user's job is the one that goes on here.
		j, found = *r.todo, true
	}
	jobHint := ""
	if found {
		jobHint = fmt.Sprintf(" (job %s)", plainText(j.ID))
	}
	switch {
	case p.pane.Agent.Name != r.kind:
		return t.note(fmt.Errorf("%w%s", agentStillRuns(p), jobHint))
	case p.status() == "blocked":
		return t.note(fmt.Errorf("the agent of this worktree waits on a dialog in pane %s%s; nothing was sent: termote agents answer %s", id, jobHint, id))
	case p.status() == "working":
		return t.note(fmt.Errorf("%w%s", agentStillRuns(p), jobHint))
	case r.prompt == "":
		return t.note(fmt.Errorf("the agent of this worktree runs idle in pane %s%s; give the prompt to send it, or send one: termote agents send %s -", id, jobHint, id))
	}
	hint := c.afterHint(port, p.pane.ID)
	queued, err := c.sendToAgent(port, p.pane.ID, r.prompt)
	if err != nil {
		return t.note(err)
	}
	how := "sent the prompt"
	if queued {
		how = "queued the prompt"
	}
	if found && !jobFinished(j.State) {
		nj, bound, err := c.jobWriteAgent(port, http.MethodPatch, "/api/mux/jobs/"+url.PathEscape(j.ID), map[string]any{"pane": p.pane.ID, "state": "active"}, http.StatusOK)
		if err == nil {
			c.jobEvent(port, nj.ID, jobEventInput{Kind: "continued", Text: r.prompt})
			if !bound {
				c.infof("Continued in pane %s (%s): %s%s", id, t.where, how, hint)
				c.noAgentYet(nj, p.pane.ID)
				return nil
			}
			c.infof("Continued job %s in pane %s (%s): %s%s; wait for it: termote agents wait --job %s", plainText(nj.ID), id, t.where, how, hint, plainText(nj.ID))
			return nil
		}
		c.jobWarn(err)
	} else {
		r.todo = nil
		t.worktree = false // a finished job is never taken up again: a new one
		c.infof("Continued in pane %s (%s): %s%s", id, t.where, how, hint)
		c.recordStart(port, t, r)
		return nil
	}
	c.infof("Continued in pane %s (%s): %s%s", id, t.where, how, hint)
	return nil
}
