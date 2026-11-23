package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// termote agents job ci: a job's pull requests and their checks, as the
// server's gh read them (job_ci.go), and sending the failed checks to the
// job's agent. The skill has the orchestrator ask the user before --send.

// prNumberFlag adds each --pr/--no-pr value to list.
func prNumberFlag(list *[]int) func(string) error {
	return func(s string) error {
		n, err := strconv.Atoi(strings.TrimPrefix(s, "#"))
		if err != nil || n < 1 || n > maxPRNumber {
			return fmt.Errorf("%q is not a pull request number", s)
		}
		*list = append(*list, n)
		return nil
	}
}

// ciShort is a summary for the jobs table: "fail (2)".
func ciShort(s *jobCISummary) string {
	if s == nil {
		return ""
	}
	return fmt.Sprintf("%s (%d)", s.Worst, s.Count)
}

// ciLine is "#12 fail, #15 pass" for job show.
func ciLine(c *jobCI) string {
	if c == nil {
		return ""
	}
	var parts []string
	for _, p := range c.PRs {
		parts = append(parts, "#"+strconv.Itoa(p.Number)+" "+ciState(p))
	}
	if len(parts) == 0 && c.Error != "" {
		return plainText(c.Error)
	}
	return strings.Join(parts, ", ")
}

// ciState is what a pull request shows: merged, closed, draft, or its
// checks.
func ciState(p jobPR) string {
	switch {
	case p.State != prOpen:
		return p.State
	case p.Draft:
		return "draft"
	case p.Checks == "":
		return ciNone
	}
	return p.Checks
}

func (c *cli) agentsJobCI(args []string) error {
	refresh, send, asJSON := false, false, false
	fs := c.newFlagSet("agents job ci")
	fs.BoolVar(&refresh, "refresh", false, "")
	fs.BoolVar(&send, "send", false, "")
	fs.BoolVar(&asJSON, "json", false, "")
	pos, err := parseArgs(fs, args)
	if err != nil {
		return flagErr(err)
	}
	if len(pos) != 1 {
		return usageError("job ci takes one job id\n%s", jobCIUsage)
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
	path := "/api/mux/jobs/" + url.PathEscape(j.ID) + "/ci"
	if refresh {
		if j, err = c.jobCICall(port, path, "refresh"); err != nil {
			return err
		}
	}
	if send {
		r, err := c.agentsCall(port, http.MethodPost, path, map[string]string{"action": "send"}, agentsWriteTimeout)
		if err != nil {
			return err
		}
		if r.status != http.StatusOK {
			err := agentsRefusal(r)
			switch r.failure().Code {
			case "ci_nothing_failed":
				fmt.Fprintln(c.out, err)
				return &exitError{code: agentsExitNothingFailed}
			case "job_no_agent":
				fmt.Fprintln(c.out, err)
				return &exitError{code: agentsExitNoAgent}
			}
			return err
		}
		var out struct {
			Queued bool `json:"queued"`
		}
		json.Unmarshal(r.body, &out)
		if j, err = jobReply(r); err != nil {
			return err
		}
		verb := "Sent the failed checks to"
		if out.Queued {
			verb = "Queued the failed checks for"
		}
		c.infof("%s %s (%s)", verb, plainText(j.Live.Ref), plainText(j.Live.PaneID))
	}
	if asJSON {
		return writeJSON(c.out, map[string]any{"id": j.ID, "ci": j.CI, "ciSummary": j.CISummary, "ciChecked": j.CIChecked})
	}
	c.printCI(j)
	return nil
}

// jobCICall runs action on the job's ci route and returns the job.
func (c *cli) jobCICall(port int, path, action string) (jobView, error) {
	r, err := c.agentsCall(port, http.MethodPost, path, map[string]string{"action": action}, agentsWriteTimeout)
	if err != nil {
		return jobView{}, err
	}
	if r.status != http.StatusOK {
		return jobView{}, agentsRefusal(r)
	}
	return jobReply(r)
}

func (c *cli) printCI(j jobView) {
	fmt.Fprintf(c.out, "Job %s: %s\n", plainText(j.ID), plainText(j.Title))
	ci := j.CI
	if ci == nil || (len(ci.PRs) == 0 && ci.Error == "") {
		fmt.Fprintln(c.out, "No pull request found yet for the job's branch.")
	}
	if ci != nil {
		if ci.Repo != "" {
			fmt.Fprintf(c.out, "Repository: %s", plainText(ci.Repo))
			if ci.Branch != "" {
				fmt.Fprintf(c.out, ", branch %s", plainText(ci.Branch))
			}
			fmt.Fprintln(c.out)
		}
		for _, p := range ci.PRs {
			line := fmt.Sprintf("  #%d  %s", p.Number, ciState(p))
			if len(p.Failing) > 0 {
				var names []string
				for _, n := range p.Failing {
					names = append(names, strconv.Quote(plainText(n)))
				}
				line += ": " + strings.Join(names, ", ")
			}
			if p.Pinned {
				line += "  (attached)"
			}
			if p.Foreign {
				line += "  (from another repository: never sent on its own)"
			}
			if p.URL != "" {
				line += "  " + plainText(p.URL)
			}
			fmt.Fprintln(c.out, line)
		}
		if ci.Error != "" {
			fmt.Fprintf(c.out, "Last read failed: %s%s\n", plainText(ci.Error), ciErrorHint(ci.Error))
		}
		if ciSummary(ci) != nil && ciSummary(ci).AllMerged {
			fmt.Fprintln(c.out, "Every pull request is merged or closed: the user may set the job done.")
		}
	}
	if j.CIChecked != "" {
		if t, err := time.Parse(time.RFC3339, j.CIChecked); err == nil {
			fmt.Fprintf(c.out, "Checked %s ago\n", time.Since(t).Round(time.Second))
		}
	}
}

func ciErrorHint(code string) string {
	switch code {
	case "ci_gh_auth":
		return " (the user runs gh auth login on the server's machine)"
	case "ci_gh_missing":
		return " (the user installs the GitHub CLI there)"
	case "ci_no_repo":
		return " (the branch is not on a GitHub repository gh is signed in to)"
	}
	return ""
}
