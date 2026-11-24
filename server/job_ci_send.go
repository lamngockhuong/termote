package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Sending a job's failed checks to its agent: the pull requests' numbers
// and the failed checks' names, in a fixed English message, never a log
// (the agent reads those with gh itself). The user sends from the PWA, the
// orchestrator with termote agents job ci --send (after asking the user),
// and the server on its own only under a ci grant the user gave in the PWA,
// at most maxCIRounds times, each for a set of failures not sent before,
// to an agent at rest. A send is recorded before it is made (the round
// spent, the set marked sent) and undone when it fails, so no two sends of
// one set ever race.

const (
	maxCIRounds = 3
	// ciSendTries: an automatic send of one set refused this many times
	// (a draft in the box, the screen busy) is not tried again.
	ciSendTries   = 5
	ciSendBackoff = time.Minute
	// ciMessagePRs, ciMessageNames: what a message names at most.
	ciMessagePRs   = 3
	ciMessageNames = 5
	// ciBody bounds the ci route's body.
	ciBody = 1 << 10
)

var (
	errCINothingFailed = &codedError{"ci_nothing_failed", "no check of the job's pull requests failed", http.StatusConflict}
	errJobNoAgent      = &codedError{"job_no_agent", "the job's agent does not run", http.StatusConflict}
	// errCISkip: an automatic send has nothing to do (nothing new, no
	// grant, no round left).
	errCISkip = errors.New("nothing to send")
)

// ciMessage is the message for the failing pull requests of prs (foreign
// ones too when foreign), or "". withNames names the failed checks: a send
// from the PWA, whose user saw the names first, or from the CLI (job ci
// --send), whose orchestrator was printed them by job ci. A send under a
// ci grant names none, since a check's name is written by whoever wrote
// the workflow or the app that posts it, a third party for an upstream
// repo or an installed app, and would reach the agent with nobody reading
// it. Neither adds text the agent cannot reach: it reads them with gh pr
// checks.
func ciMessage(prs []jobPR, foreign, withNames bool, workRepo string) string {
	var failing []jobPR
	for _, p := range prs {
		if p.State == prOpen && p.Checks == ciFail && (foreign || !p.Foreign) {
			failing = append(failing, p)
		}
	}
	if len(failing) == 0 {
		return ""
	}
	var heads, reads []string
	for i, p := range failing {
		if i == ciMessagePRs {
			heads = append(heads, fmt.Sprintf("%d more pull requests", len(failing)-i))
			break
		}
		var names []string
		for k, n := range p.Failing {
			if !withNames {
				break
			}
			if k == ciMessageNames {
				names = append(names, fmt.Sprintf("(%d more)", len(p.Failing)-k))
				break
			}
			names = append(names, strconv.Quote(ciCheckName(n)))
		}
		head := "PR #" + strconv.Itoa(p.Number)
		if len(names) > 0 {
			head += ": " + strings.Join(names, ", ")
		}
		heads = append(heads, head)
		repo := ""
		if p.Repo != "" && p.Repo != workRepo {
			repo = " --repo " + p.Repo
		}
		read := "gh pr checks " + strconv.Itoa(p.Number) + repo
		if p.FailRun > 0 {
			read += " and gh run view " + strconv.FormatInt(p.FailRun, 10) + repo + " --log-failed"
		}
		reads = append(reads, read)
	}
	return "CI failed on " + strings.Join(heads, "; ") + ". Read the failures with " + strings.Join(reads, "; ") +
		", fix them and push."
}

// ciGrant is the job's ci grant in force, or nil.
func ciGrant(j *job, now time.Time) *grant {
	for i := range j.Grants {
		if j.Grants[i].Kind == "ci" && grantInForce(*j, j.Grants[i], now) {
			return &j.Grants[i]
		}
	}
	return nil
}

// sendCI sends job id's failed checks to its agent. by and via name the
// sender and how it signed in for the audit line; auto is a send under the
// job's ci grant. queued: the agent was working and took the message into
// its queue.
func (a *agentAPI) sendCI(ctx context.Context, id, by, via string, auto bool) (queued bool, saved job, err error) {
	j, ok := a.jobs.job(id)
	if !ok || jobFinished(j.State) {
		return false, job{}, errJobNotFound
	}
	if j.Agent == nil {
		return false, j, errJobNoAgent
	}
	wr, ok := a.m.(agentWriter)
	if !ok || a.loc == nil {
		return false, j, errAgentUnsupported
	}
	workRepo := ""
	if j.CI != nil {
		workRepo = j.CI.Repo
	}
	text := ""
	if j.CI != nil {
		text = ciMessage(j.CI.PRs, !auto, !auto, workRepo)
	}
	if text == "" {
		return false, j, errCINothingFailed
	}
	snap, err := peekSnapshot(ctx, a.m)
	if err != nil {
		return false, j, err
	}
	p, ok := findJobPane(snap, j.Agent.Key)
	if !ok {
		return false, j, errJobNoAgent
	}
	paneID := p.pane.ID
	// The message is made again under the lock, from the pull requests as
	// they are then; this one only sizes the wait, with room for a longer.
	budget := messageBudget(0, pasteGrowMost(text+text))
	unlock, err := a.lockPane(ctx, paneID, budget)
	if err != nil {
		return false, j, err
	}
	defer unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), budget)
	defer cancel()
	// Under the pane's lock: the pane still runs the job's agent (a pane
	// reused since would get another agent's message), at rest for an
	// automatic send.
	s, err := sessionNow(ctx, wr, paneID)
	if err != nil {
		return false, j, err
	}
	if snap, err = peekSnapshot(ctx, a.m); err != nil {
		return false, j, err
	}
	if p, ok = findJobPane(snap, j.Agent.Key); !ok || p.pane.ID != paneID || !j.Agent.matches(p, s) {
		return false, j, errJobNoAgent
	}
	if auto {
		if live := a.jobLiveIn(snap, j); live.Status != "idle" || live.Background != "" {
			return false, j, errCISkip
		}
	}
	// Recorded before the send: the set marked sent, a round of the grant
	// spent. Another send of the same set finds it marked.
	now := a.jobs.now()
	use := grantUse{At: now.UTC().Format(activityTimeFormat)}
	var prevSent, key, gid, prs, msg string
	var reserveErr error
	_, wrote, err := a.jobs.setJobCI(id, func(j *job) bool {
		if j.CI == nil || j.Agent == nil || !j.Agent.matches(p, s) {
			reserveErr = errJobNoAgent
			return false
		}
		key = ciFailKey(j.CI.PRs, !auto)
		if key == "" {
			reserveErr = errCINothingFailed
			return false
		}
		if auto {
			g := ciGrant(j, now)
			if g == nil || len(g.Uses) >= maxCIRounds || !g.Agent.matches(p, s) || !ciKeyGains(key, j.CI.Sent) {
				reserveErr = errCISkip
				return false
			}
			use.Command = strings.TrimPrefix(key, "fail:")
			g.Uses = append(g.Uses, use)
			gid = g.ID
		}
		// The message names the set that is marked sent
		msg = ciMessage(j.CI.PRs, !auto, !auto, j.CI.Repo)
		prs = ciKeyPRs(key)
		prevSent, j.CI.Sent = j.CI.Sent, key
		text := "sent CI failure of " + prs
		if auto {
			text += " (auto)"
		}
		a.jobs.addEvent(j, "ci_sent", text)
		return true
	})
	switch {
	case err != nil:
		return false, j, err
	case reserveErr != nil:
		return false, j, reserveErr
	case !wrote:
		return false, j, errJobNotFound
	}
	parts, _ := messageParts(msg, nil, 0)
	err = a.sendMessage(ctx, wr, paneID, s.ID, parts, nil, false)
	if err != nil && !errors.Is(err, errQueued) {
		a.undoCISend(id, key, prevSent, gid, use.At)
		j, _ = a.jobs.job(id)
		return false, j, err
	}
	a.follower.follow(paneID)
	if auto {
		auditf("ci_sent", "job", id, "prs", prs, "by", "grant", "grant", gid)
	} else {
		auditf("ci_sent", "job", id, "prs", prs, "by", by, "via", via)
	}
	saved, _ = a.jobs.job(id)
	return errors.Is(err, errQueued), saved, nil
}

// ciKeyPRs is "#12, #15" for the key "fail:12@abc,15@def".
func ciKeyPRs(key string) string {
	var out []string
	for _, p := range strings.Split(strings.TrimPrefix(key, "fail:"), ",") {
		n, _, _ := strings.Cut(p, "@")
		out = append(out, "#"+n)
	}
	return strings.Join(out, ", ")
}

// undoCISend gives back what a send that failed recorded: the round, and
// the mark (unless another send moved it since). A failure to write it
// leaves the round spent: the safe way round.
func (a *agentAPI) undoCISend(id, key, prevSent, gid, at string) {
	a.jobs.setJobCI(id, func(j *job) bool {
		if j.CI == nil {
			return false
		}
		if j.CI.Sent == key {
			j.CI.Sent = prevSent
		}
		for i := range j.Grants {
			if j.Grants[i].ID == gid {
				j.Grants[i].Uses = slices.DeleteFunc(j.Grants[i].Uses, func(u grantUse) bool { return u.At == at })
			}
		}
		// The send did not happen: its line goes too
		if n := len(j.Events); n > 0 && j.Events[n-1].Kind == "ci_sent" &&
			strings.HasPrefix(j.Events[n-1].Text, "sent CI failure of "+ciKeyPRs(key)) {
			j.Events = j.Events[:n-1]
		}
		// Once for a set, however often it is tried
		text := "could not send the CI failure of " + ciKeyPRs(key)
		if n := len(j.Events); n == 0 || j.Events[n-1].Kind != "ci_failed_send" || j.Events[n-1].Text != text {
			a.jobs.addEvent(j, "ci_failed_send", text)
		}
		return true
	})
}

// autoSend sends a job's new failures to its agent when the user gave the
// job a ci grant, backing off while the agent refuses the message.
func (p *ciPoller) autoSend(ctx context.Context, j job) {
	if j.CI == nil || ciGrant(&j, p.a.jobs.now()) == nil {
		return
	}
	key := ciFailKey(j.CI.PRs, false)
	if !ciKeyGains(key, j.CI.Sent) {
		return
	}
	p.mu.Lock()
	s := p.state[j.ID]
	if s == nil {
		s = &ciJobState{}
		p.state[j.ID] = s
	}
	if s.sendKey != key {
		s.sendKey, s.sendTries, s.sendNext = key, 0, time.Time{}
	}
	blocked := s.sendTries >= ciSendTries || p.now().Before(s.sendNext)
	p.mu.Unlock()
	if blocked {
		return
	}
	_, _, err := p.a.sendCI(ctx, j.ID, "grant", "", true)
	if err == nil || errors.Is(err, errCISkip) {
		return
	}
	p.mu.Lock()
	s.sendTries++
	s.sendNext = p.now().Add(min(ciSendBackoff<<min(s.sendTries-1, 4), ciMostBackoff))
	p.mu.Unlock()
}

// handleJobCI: POST /api/mux/jobs/{id}/ci {"action": "refresh" | "send"}.
func (a *agentAPI) handleJobCI(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
		return
	}
	var in struct {
		Action string `json:"action"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, ciBody)
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJobError(w, errJobsTooLarge)
			return
		}
		writeJobError(w, invalidJob("invalid JSON body"))
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
	if !a.ci.available() {
		writeJobError(w, errCIUnavailable)
		return
	}
	switch in.Action {
	case "refresh":
		j, err := a.ci.refresh(r.Context(), id)
		if err != nil {
			writeJobError(w, err)
			return
		}
		jsonOK(w, map[string]any{"job": a.viewJob(j)})
	case "send":
		by, via := "cli", "none"
		if _, ok := authFrom(r.Context()); ok {
			by, via = auditWho(r)
		}
		queued, j, err := a.sendCI(r.Context(), id, by, via, false)
		if err != nil {
			a.writeCIError(w, err)
			return
		}
		jsonOK(w, map[string]any{"job": a.viewJob(j), "queued": queued})
	default:
		writeJobError(w, invalidJob("action is refresh or send"))
	}
}

// writeCIError answers a failed send: the job and ci codes as the job
// routes do, the agent's (input_has_draft...) as the agent routes do.
func (a *agentAPI) writeCIError(w http.ResponseWriter, err error) {
	var ce *codedError
	if errors.As(err, &ce) {
		writeJobError(w, err)
		return
	}
	a.writeFailure(w, err)
}
