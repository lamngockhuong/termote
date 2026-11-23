package main

import (
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// A job's pull requests and their CI, as the poller (job_ci.go) read them
// with the user's own gh. The ledger keeps where the poller asks (the repo
// and the branch, pinned the first time it finds them, so a job whose agent
// left is still followed), the pull requests the user or the orchestrator
// attached by number, and the last summary. Termote never writes to GitHub.

const (
	// maxJobPins pull requests can be attached to a job by number.
	maxJobPins = 10
	// maxJobPRs are kept on a job, the newest first.
	maxJobPRs = 20
	// maxCIFailing check names are kept for a pull request.
	maxCIFailing = 10
	// maxCIName bounds a check name, in runes.
	maxCIName = 100
	// maxPRNumber bounds the number a client may attach.
	maxPRNumber = 1_000_000_000
)

// jobPR is one pull request of a job, as gh read it last.
type jobPR struct {
	Number int `json:"number"`
	// Repo: host/owner/repo the pull request lives in.
	Repo   string `json:"repo"`
	State  string `json:"state"`
	Draft  bool   `json:"draft,omitempty"`
	Checks string `json:"checks,omitempty"`
	// Failing: the names of the failed checks, in the narrow charset
	// ciCheckName keeps, since they reach the agent.
	Failing []string `json:"failing,omitempty"`
	// FailRun: the Actions run of the first failed check, when it is a run
	// of Repo.
	FailRun int64 `json:"failRun,omitempty"`
	// Head: the head commit, 12 hex digits.
	Head string `json:"head,omitempty"`
	// URL: https://<host>/<owner>/<repo>/pull/<n>, checked against Repo.
	URL string `json:"url,omitempty"`
	// Pinned: attached by number, not found by the branch.
	Pinned bool `json:"pinned,omitempty"`
	// Foreign: its head is not the job's pushed repo: shown, never sent to
	// the agent without the user (its check names are someone else's).
	Foreign bool `json:"foreign,omitempty"`
}

// The PR states and check results.
const (
	prOpen    = "open"
	prMerged  = "merged"
	prClosed  = "closed"
	ciPending = "pending"
	ciPass    = "pass"
	ciFail    = "fail"
	ciNone    = "none"
)

// jobCI is what the poller knows of a job's pull requests.
type jobCI struct {
	// Repo: where pull requests are asked (host/owner/repo), the upstream
	// remote when the job's branch is pushed to a fork.
	Repo string `json:"repo,omitempty"`
	// Push: the repo the branch is pushed to; a pull request's head has to
	// be there to be the job's.
	Push string `json:"push,omitempty"`
	// Branch: the branch, pinned for a job without a worktree the first
	// time the poller resolved it.
	Branch string `json:"branch,omitempty"`
	// Pins: the pull requests attached by number.
	Pins []int   `json:"pins,omitempty"`
	PRs  []jobPR `json:"prs,omitempty"`
	// Error: why the last read failed, a ci_* code (never gh's text).
	Error string `json:"error,omitempty"`
	// Notified: the state last pushed (ciFailKey or ciMergedKey), so a
	// restart never pushes it again.
	Notified string `json:"notified,omitempty"`
	// Sent: the failing set last sent to the agent (ciFailKey).
	Sent string `json:"sent,omitempty"`
}

const ciMergedKey = "merged"

func (c *jobCI) clone() *jobCI {
	if c == nil {
		return nil
	}
	n := *c
	n.Pins = slices.Clone(c.Pins)
	n.PRs = slices.Clone(c.PRs)
	for i := range n.PRs {
		n.PRs[i].Failing = slices.Clone(c.PRs[i].Failing)
	}
	return &n
}

// ciFailKey names the set of failing pull requests at their heads,
// "fail:12@abc,15@def", or "" when none fails. foreign leaves out the pull
// requests whose head is someone else's.
func ciFailKey(prs []jobPR, foreign bool) string {
	var parts []string
	for _, p := range prs {
		if p.State == prOpen && p.Checks == ciFail && (foreign || !p.Foreign) {
			parts = append(parts, strconv.Itoa(p.Number)+"@"+p.Head)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	slices.Sort(parts)
	return "fail:" + strings.Join(parts, ",")
}

// ciKeyGains: key names a failing pull request that before does not: the
// failure is new (a subset, or the same set, is not).
func ciKeyGains(key, before string) bool {
	if key == "" {
		return false
	}
	had := map[string]bool{}
	if rest, ok := strings.CutPrefix(before, "fail:"); ok {
		for _, p := range strings.Split(rest, ",") {
			had[p] = true
		}
	}
	for _, p := range strings.Split(strings.TrimPrefix(key, "fail:"), ",") {
		if !had[p] {
			return true
		}
	}
	return false
}

// jobCISummary is what a card shows, worked out by the server for every
// client so a full and a view-only device colour a job alike.
type jobCISummary struct {
	// Worst: fail, pending, open, draft or merged (every one merged or
	// closed); empty without a pull request.
	Worst     string `json:"worst,omitempty"`
	Count     int    `json:"count"`
	AllMerged bool   `json:"allMerged,omitempty"`
	Numbers   []int  `json:"numbers,omitempty"`
}

// ciRank orders a pull request's look from worst (highest) to best.
func ciRank(p jobPR) (int, string) {
	switch {
	case p.State != prOpen:
		return 0, prMerged
	case p.Checks == ciFail:
		// A draft's failed checks too: they are pushed and sent
		return 4, ciFail
	case p.Checks == ciPending:
		return 3, ciPending
	case p.Draft:
		return 1, "draft"
	}
	return 2, prOpen
}

func ciSummary(c *jobCI) *jobCISummary {
	if c == nil || len(c.PRs) == 0 {
		return nil
	}
	s := &jobCISummary{Count: len(c.PRs), AllMerged: true}
	best := -1
	for _, p := range c.PRs {
		s.Numbers = append(s.Numbers, p.Number)
		if p.State == prOpen {
			s.AllMerged = false
		}
		if r, w := ciRank(p); r > best {
			best, s.Worst = r, w
		}
	}
	return s
}

// errNoChange ends a setJobCI op that changed nothing: no write.
var errNoChange = errors.New("no change")

// setJobCI runs op on the job with id under jobs.lock and writes only when
// op says it changed something. op may change j.CI, add events and grant
// uses; the job's updated never moves, so a device editing the job is not
// refused with job_conflict for what the poller did. A finished or removed
// job is left alone (ok false).
func (s *jobStore) setJobCI(id string, op func(j *job) bool) (saved job, ok bool, err error) {
	err = s.change(func(list []job) ([]job, error) {
		i := slices.IndexFunc(list, func(j job) bool { return j.ID == id })
		if i < 0 || jobFinished(list[i].State) {
			return nil, errNoChange
		}
		if !op(&list[i]) {
			return nil, errNoChange
		}
		saved, ok = list[i].clone(), true
		return list, nil
	})
	if errors.Is(err, errNoChange) {
		return job{}, false, nil
	}
	return saved, ok, err
}

// applyPRPins attaches and detaches pull requests by number in one change.
func applyPRPins(s *jobStore, j *job, add, remove []int) error {
	if len(add) == 0 && len(remove) == 0 {
		return nil
	}
	for _, n := range slices.Concat(add, remove) {
		if n < 1 || n > maxPRNumber {
			return invalidJob("a pull request number is 1 or more")
		}
	}
	if j.CI == nil {
		j.CI = &jobCI{}
	}
	pins := slices.Clone(j.CI.Pins)
	var added, removed []string
	for _, n := range remove {
		if i := slices.Index(pins, n); i >= 0 {
			pins = slices.Delete(pins, i, i+1)
			removed = append(removed, "#"+strconv.Itoa(n))
		}
	}
	for _, n := range add {
		if !slices.Contains(pins, n) {
			pins = append(pins, n)
			added = append(added, "#"+strconv.Itoa(n))
		}
	}
	if len(pins) > maxJobPins {
		return invalidJob(fmt.Sprintf("up to %d pull requests can be attached", maxJobPins))
	}
	j.CI.Pins = pins
	j.CI.PRs = slices.DeleteFunc(j.CI.PRs, func(p jobPR) bool { return p.Pinned && !slices.Contains(pins, p.Number) })
	if len(added) > 0 {
		s.addEvent(j, "pr", "pinned "+strings.Join(added, ", "))
	}
	if len(removed) > 0 {
		s.addEvent(j, "pr", "unpinned "+strings.Join(removed, ", "))
	}
	return nil
}

// ciCheckName keeps a check name in a narrow charset, since it reaches the
// agent as part of a message: anything else becomes '?'.
func ciCheckName(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case strings.ContainsRune(" ._:/()[]#+-", r):
			return r
		}
		return '?'
	}, strings.Join(strings.Fields(s), " "))
	return cutRunes(strings.TrimSpace(s), maxCIName)
}
