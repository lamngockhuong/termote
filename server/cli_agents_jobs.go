package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

type jobsListing struct {
	Jobs      []jobView `json:"jobs"`
	ReadOnly  bool      `json:"readOnly"`
	ServerNow string    `json:"serverNow"`
}

// jobsGet reads the ledger: every job with all, else the unfinished ones.
func (c *cli) jobsGet(port int, all bool) ([]jobView, error) {
	var l jobsListing
	path := "/api/mux/jobs"
	if all {
		path += "?all=1"
	}
	err := c.agentsGet(port, path, &l)
	return l.Jobs, err
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
	var ws string
	mine, all, asJSON := false, false, false
	fs := c.newFlagSet("agents jobs")
	fs.StringVar(&ws, "workspace", "", "")
	fs.BoolVar(&mine, "mine", false, "")
	fs.BoolVar(&all, "all", false, "")
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 0 {
		return usageError(agentsUsage)
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
	list, err := c.jobsGet(port, all)
	if err != nil {
		return err
	}
	list = slices.DeleteFunc(list, func(j jobView) bool {
		return (mine && j.CreatedBy != self) || (ws != "" && j.Workspace != group.ID)
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
	fmt.Fprintln(tw, "JOB\tTITLE\tSTATE\tPANE\tAGENT\tUNREAD\tBRANCH\tDIR\tUPDATED")
	for _, j := range list {
		pane, branch, dir := "-", "-", "-"
		if j.Live.PaneID != "" {
			pane = plainText(j.Live.Ref) + " (" + plainText(j.Live.PaneID) + ")"
		}
		if j.Worktree != nil {
			branch, dir = plainText(j.Worktree.Branch), plainText(c.tildeDir(j.Worktree.Dir))
		}
		unread := ""
		if j.Live.Unread {
			unread = "yes"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", plainText(j.ID), clipLine(plainText(j.Title), 48), plainText(j.State), pane,
			dash(c.liveText(j.Live)), dash(unread), branch, dir, sinceText(j.Updated.Format(time.RFC3339)))
	}
	return tw.Flush()
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
		return usageError(agentsUsage)
	}
	switch args[0] {
	case "add":
		return c.agentsJobAdd(args[1:])
	case "show":
		return c.agentsJobShow(args[1:])
	case "set":
		return c.agentsJobSet(args[1:])
	}
	return usageError("unknown agents job command: %s\n%s", args[0], agentsUsage)
}

func (c *cli) agentsJobAdd(args []string) error {
	var title, pane, note string
	asJSON, hasNote := false, false
	fs := c.newFlagSet("agents job add")
	fs.StringVar(&title, "title", "", "")
	fs.StringVar(&pane, "pane", "", "")
	fs.Func("note", "", func(s string) error { note, hasNote = s, true; return nil })
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 0 || strings.TrimSpace(title) == "" {
		return usageError(agentsUsage)
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
	if hasNote {
		if note, err = c.readText(note); err != nil {
			return err
		}
		body["note"] = note
	}
	if pane != "" {
		p, err := c.agentsPane(port, pane)
		if err != nil {
			return err
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
	c.infof("Added job %s: %s (%s)", plainText(j.ID), plainText(j.Title), plainText(j.State))
	return nil
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
		return usageError(agentsUsage)
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
	if j.Agent != nil {
		unread := ""
		if j.Live.Unread {
			unread = "; a turn ended that was not read: termote agents read " + plainText(j.Live.PaneID)
		}
		fmt.Fprintf(c.out, "Agent: %s in %s (%s): %s%s\n", plainText(j.Agent.Kind), plainText(j.Live.Ref), plainText(j.Live.PaneID), c.liveText(j.Live), unread)
	}
	if w := j.Worktree; w != nil {
		fmt.Fprintf(c.out, "Worktree: branch %s (base %s) in %s\n", plainText(w.Branch), dash(plainText(w.Base)), plainText(c.tildeDir(w.Dir)))
	}
	if d := j.Diff; d != nil {
		fmt.Fprintf(c.out, "Last diff: %d commits, %d files (%s)\n", d.Commits, d.Files, sinceText(d.At))
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
	var state, pane, title, note string
	hasNote := false
	fs := c.newFlagSet("agents job set")
	fs.StringVar(&state, "state", "", "")
	fs.StringVar(&pane, "pane", "", "")
	fs.StringVar(&title, "title", "", "")
	fs.Func("note", "", func(s string) error { note, hasNote = s, true; return nil })
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 || (state == "" && pane == "" && title == "" && !hasNote) {
		return usageError(agentsUsage)
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
	if pane != "" {
		p, err := c.agentsPane(port, pane)
		if err != nil {
			return err
		}
		body["pane"] = p.pane.ID
	}
	j, err := c.jobWrite(port, http.MethodPatch, "/api/mux/jobs/"+url.PathEscape(before.ID), body, http.StatusOK)
	if err != nil {
		return err
	}
	c.infof("Job %s: %s (%s)", plainText(j.ID), plainText(j.Title), plainText(j.State))
	if ended := grantsEnded(before.job, j.job); ended > 0 {
		c.infof("%d grant(s) of the job ended with this change; only the user can give new ones, from the PWA", ended)
	}
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

// agentsWaitJobs waits until one of the jobs needs the orchestrator: its
// agent ended a turn not read yet, shows a dialog not reported yet, only
// waits on background work, or is gone. Each poll reads the ledger again,
// so a turn that ended before the wait, or between two polls, is reported.
func (c *cli) agentsWaitJobs(args []string) error {
	timeout := agentsJobsWait
	fs := c.newFlagSet("agents wait")
	fs.DurationVar(&timeout, "timeout", agentsJobsWait, "")
	fs.Bool("job", true, "")
	ids, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(ids) == 0 || timeout <= 0 {
		return usageError(agentsUsage)
	}
	port, err := c.agentsPort()
	if err != nil {
		return err
	}
	deadline := time.Now().Add(timeout)
	failures := 0
	for {
		list, err := c.jobsGet(port, true)
		if err != nil {
			if failures++; failures >= agentsWaitFailures {
				return err
			}
		} else {
			failures = 0
			ends, rest, err := c.jobEnds(port, list, ids)
			if err != nil {
				return err
			}
			if len(ends) > 0 {
				return c.jobsEnded(list, ids, ends, rest)
			}
		}
		if !time.Now().Before(deadline) {
			fmt.Fprintf(c.out, "Still working after %s; wait again: termote agents wait --job %s\n", timeout, strings.Join(ids, " "))
			return &exitError{code: agentsExitTimeout}
		}
		time.Sleep(agentsWaitEvery)
	}
}

// jobEnds is what each of ids reports now, and the ids left to wait for.
func (c *cli) jobEnds(port int, list []jobView, ids []string) (map[string]jobEnd, []string, error) {
	ends := map[string]jobEnd{}
	var rest []string
	for _, id := range ids {
		j, ok := findJob(list, id)
		if !ok {
			return nil, nil, fmt.Errorf("no job %s; see: termote agents jobs --all", plainText(id))
		}
		end := jobEndNone
		switch l := j.Live; {
		case j.Agent == nil:
			return nil, nil, fmt.Errorf("job %s has no agent to wait for; give it one: termote agents start --job %s ...", plainText(id), plainText(id))
		case l.Status == "gone":
			end = jobEndGone
		case l.Unread:
			end = jobEndDone
		case l.Status == "blocked":
			var pr promptResponse
			if err := c.agentsGet(port, panePath(l.PaneID, "/agent/prompt"), &pr); err == nil && pr.Prompt != nil {
				if sig := reportedSig(*pr.Prompt); sig != j.Reported {
					end = jobEndDialog
					if err := c.jobEvent(port, j.ID, jobEventInput{Kind: "reported", Sig: sig}); err != nil {
						c.jobWarn(err)
					}
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
	return ends, rest, nil
}

// jobsEnded prints every job that needs the orchestrator and how to go on.
func (c *cli) jobsEnded(list []jobView, ids []string, ends map[string]jobEnd, rest []string) error {
	code := 0
	for _, id := range ids {
		end, ok := ends[id]
		if !ok {
			continue
		}
		j, _ := findJob(list, id)
		ref, pid, jid := plainText(j.Live.Ref), plainText(j.Live.PaneID), plainText(j.ID)
		switch end {
		case jobEndDone:
			fmt.Fprintf(c.out, "Job %s (%s): %s (%s) ended a turn; read it: termote agents read %s\n", jid, plainText(j.Title), ref, pid, pid)
		case jobEndBackground:
			fmt.Fprintf(c.out, "Job %s (%s): %s (%s) wrote its answer and only waits on background work (%s); read it: termote agents read %s\n",
				jid, plainText(j.Title), ref, pid, plainText(clipLine(j.Live.Background, 80)), pid)
		case jobEndDialog:
			fmt.Fprintf(c.out, "Job %s (%s): %s (%s) waits on a dialog; see it: termote agents answer %s\n", jid, plainText(j.Title), ref, pid, pid)
		case jobEndGone:
			fmt.Fprintf(c.out, "Job %s (%s): its agent no longer runs in %s (%s); give the job another pane (termote agents job set %s --pane <pane>) or end it (--state abandoned)\n",
				jid, plainText(j.Title), ref, pid, jid)
		}
		code = max(code, end.exit())
	}
	if len(rest) > 0 {
		fmt.Fprintf(c.out, "next: termote agents wait --job %s\n", strings.Join(rest, " "))
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
}

// defaultTitle never comes from the prompt: a view-only client sees titles.
func (r startRecord) defaultTitle() string {
	if r.branch != "" {
		return r.kind + " in " + r.branch
	}
	return r.kind + " in " + r.group.Name
}

func (r startRecord) worktree() map[string]string {
	if r.branch == "" {
		return nil
	}
	return map[string]string{"source": r.group.ID, "branch": r.branch, "base": r.base}
}

// recordStart writes the job of an agent started in t's pane: the job --job
// named, the unfinished job of the worktree when a start goes on there, or
// a new one. A failure is a warning: the agent runs.
func (c *cli) recordStart(port int, t startTarget, r startRecord) {
	var (
		j   jobView
		err error
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
		j, err = c.jobWrite(port, http.MethodPatch, "/api/mux/jobs/"+url.PathEscape(prior.ID), body, http.StatusOK)
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
		j, err = c.jobWrite(port, http.MethodPost, "/api/mux/jobs", body, http.StatusCreated)
	}
	if err != nil {
		c.jobWarn(err)
		return
	}
	c.infof("Job %s: %s; wait for it: termote agents wait --job %s", plainText(j.ID), plainText(j.Title), plainText(j.ID))
}

// continueInWorktree gives the prompt of a start run again to the agent
// that already runs in the worktree's first pane, when it is idle; anything
// else is refused with the job named.
func (c *cli) continueInWorktree(port int, t startTarget, r startRecord) error {
	p := *t.running
	id := plainText(p.pane.ID)
	list, _ := c.jobsGet(port, true)
	j, found := worktreeJob(list, t.dir)
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
		nj, err := c.jobWrite(port, http.MethodPatch, "/api/mux/jobs/"+url.PathEscape(j.ID), map[string]any{"pane": p.pane.ID, "state": "active"}, http.StatusOK)
		if err == nil {
			c.jobEvent(port, nj.ID, jobEventInput{Kind: "continued", Text: r.prompt})
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
