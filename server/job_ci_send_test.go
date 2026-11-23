package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCIMessage(t *testing.T) {
	prs := []jobPR{
		{Number: 12, Repo: "github.com/o/r", State: prOpen, Checks: ciFail, Failing: []string{"lint", `e2e "x"`}, FailRun: 456},
		{Number: 13, Repo: "github.com/o/r", State: prOpen, Checks: ciPass},
		{Number: 14, Repo: "github.com/o/r", State: prOpen, Checks: ciFail, Foreign: true, Failing: []string{"evil"}},
		{Number: 15, Repo: "github.com/up/r", State: prOpen, Checks: ciFail, Failing: []string{"a", "b", "c", "d", "e", "f", "g"}},
	}
	want := `CI failed on PR #12: "lint", "e2e ?x?"; PR #15: "a", "b", "c", "d", "e", (2 more). ` +
		`Read the failures with gh pr checks 12 and gh run view 456 --log-failed; gh pr checks 15 --repo github.com/up/r, fix them and push.`
	if got := ciMessage(prs, false, "github.com/o/r"); got != want {
		t.Errorf("message\n got %s\nwant %s", got, want)
	}
	if got := ciMessage(prs, true, "github.com/o/r"); !strings.Contains(got, "PR #14") {
		t.Errorf("with foreign: %s", got)
	}
	if ciMessage(prs[1:2], true, "") != "" {
		t.Error("message without a failure")
	}
	if ciKeyPRs("fail:12@aaa,15@bbb") != "#12, #15" {
		t.Error("ciKeyPRs")
	}
}

// ciSendTest is a job given to the fake's agent, its pull requests set by
// hand, and a poller to answer the ci route.
func newCISendTest(t *testing.T) (*jobsTest, string) {
	t.Helper()
	shortConfirm(t)
	jt := newJobsTest(t)
	jt.agent.ci = &ciPoller{a: jt.agent, now: time.Now, state: map[string]*ciJobState{}, defaults: map[string]ciDefault{}}
	id := jt.create(map[string]any{"title": "Parser", "pane": "w1:pa"})["id"].(string)
	setFailing(t, jt, id, "aaa")
	return jt, id
}

func setFailing(t *testing.T, jt *jobsTest, id, head string, more ...jobPR) {
	t.Helper()
	_, _, err := jt.agent.jobs.setJobCI(id, func(j *job) bool {
		if j.CI == nil {
			j.CI = &jobCI{Repo: "github.com/o/r", Notified: ciNoneKey}
		}
		j.CI.PRs = append([]jobPR{{Number: 12, Repo: "github.com/o/r", State: prOpen, Checks: ciFail, Head: head, Failing: []string{"lint"}}}, more...)
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestJobCIRoute(t *testing.T) {
	jt, id := newCISendTest(t)
	path := "/api/mux/jobs/" + id + "/ci"
	if code, _ := jt.do("view", http.MethodPost, path, map[string]any{"action": "send"}); code != http.StatusForbidden {
		t.Errorf("view-only send = %d", code)
	}
	if code, _ := jt.do("full", http.MethodPost, path, `{"action":"`+strings.Repeat("x", 2000)+`"}`); code != http.StatusRequestEntityTooLarge {
		t.Errorf("large body = %d", code)
	}
	if code, out := jt.do("full", http.MethodPost, path, map[string]any{"action": "merge"}); code != http.StatusBadRequest || out["code"] != "job_invalid" {
		t.Errorf("unknown action = %d %v", code, out)
	}
	if code, _ := jt.do("full", http.MethodGet, path, nil); code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", code)
	}
	code, out := jt.do("full", http.MethodPost, path, map[string]any{"action": "send"})
	if code != http.StatusOK || out["queued"] != false {
		t.Fatalf("send = %d %v", code, out)
	}
	want := `CI failed on PR #12: "lint". Read the failures with gh pr checks 12, fix them and push.`
	if len(jt.f.pasted) != 1 || jt.f.pasted[0] != want {
		t.Errorf("pasted %q", jt.f.pasted)
	}
	j, _ := jt.agent.jobs.job(id)
	if j.CI.Sent != "fail:12@aaa" || j.Events[len(j.Events)-1].Text != "sent CI failure of #12" {
		t.Errorf("recorded %+v %+v", j.CI, j.Events[len(j.Events)-1])
	}
	// Nothing failing.
	jt.agent.jobs.setJobCI(id, func(j *job) bool { j.CI.PRs[0].Checks = ciPass; return true })
	if code, out := jt.do("socket", http.MethodPost, path, map[string]any{"action": "send"}); code != http.StatusConflict || out["code"] != "ci_nothing_failed" {
		t.Errorf("nothing failed = %d %v", code, out)
	}
	// Not followed on this server (a container).
	jt.agent.ci = nil
	if code, out := jt.do("full", http.MethodPost, path, map[string]any{"action": "refresh"}); code != http.StatusServiceUnavailable || out["code"] != "ci_unavailable" {
		t.Errorf("no poller = %d %v", code, out)
	}
}

func TestJobCISendRefusals(t *testing.T) {
	jt, id := newCISendTest(t)
	ctx := context.Background()
	// A draft in the box: refused, and what was recorded is given back.
	jt.f.mu.Lock()
	jt.f.screen = boxScreen("half typed")
	jt.f.mu.Unlock()
	if _, _, err := jt.agent.sendCI(ctx, id, "u", false); err == nil || !strings.Contains(err.Error(), "draft") {
		t.Fatalf("draft = %v", err)
	}
	j, _ := jt.agent.jobs.job(id)
	if j.CI.Sent != "" || j.Events[len(j.Events)-1].Kind != "ci_failed_send" || len(jt.f.pasted) != 0 {
		t.Errorf("after a refused send %+v %+v %q", j.CI, j.Events[len(j.Events)-1], jt.f.pasted)
	}
	// The pane runs another agent now.
	jt.f.mu.Lock()
	jt.f.screen = boxScreen("")
	jt.f.session.PID = 4242
	jt.f.mu.Unlock()
	if _, _, err := jt.agent.sendCI(ctx, id, "u", false); !errors.Is(err, errJobNoAgent) {
		t.Errorf("another agent = %v", err)
	}
	// A job without an agent.
	other, _ := jt.agent.jobs.create(job{Title: "b", State: "active"})
	setFailing(t, jt, other.ID, "bbb")
	if _, _, err := jt.agent.sendCI(ctx, other.ID, "u", false); !errors.Is(err, errJobNoAgent) {
		t.Errorf("no agent = %v", err)
	}
}

func TestJobCIGrantAutoSend(t *testing.T) {
	jt, id := newCISendTest(t)
	ctx := context.Background()
	p := jt.agent.ci
	auto := func() {
		j, _ := jt.agent.jobs.job(id)
		p.autoSend(ctx, j)
	}
	// No grant: nothing is sent on its own.
	auto()
	if len(jt.f.pasted) != 0 {
		t.Fatal("sent without a grant")
	}
	gpath := "/api/mux/jobs/" + id + "/grants"
	if code, out := jt.do("socket", http.MethodPost, gpath, map[string]any{"kind": "ci"}); code != http.StatusForbidden || out["code"] != "grant_pwa_only" {
		t.Errorf("grant from the CLI = %d %v", code, out)
	}
	if code, out := jt.do("full", http.MethodPost, gpath, map[string]any{"kind": "ci", "prefix": "x"}); code != http.StatusBadRequest {
		t.Errorf("ci grant with a prefix = %d %v", code, out)
	}
	code, out := jt.do("full", http.MethodPost, gpath, map[string]any{"kind": "ci"})
	if code != http.StatusCreated {
		t.Fatalf("grant = %d %v", code, out)
	}
	if j, _ := jt.agent.jobs.job(id); j.Events[len(j.Events)-1].Text != "send failed checks to the agent (up to 3 times)" {
		t.Errorf("grant event %+v", j.Events[len(j.Events)-1])
	}
	auto()
	auto() // the same set: once
	if len(jt.f.pasted) != 1 {
		t.Fatalf("sent %d", len(jt.f.pasted))
	}
	// A working agent waits; a foreign pull request is never sent alone.
	setFailing(t, jt, id, "bbb")
	setPaneStatus(jt.f, "working")
	jt.snapshot()
	auto()
	setPaneStatus(jt.f, "idle")
	jt.snapshot()
	if len(jt.f.pasted) != 1 {
		t.Fatalf("sent to a working agent: %d", len(jt.f.pasted))
	}
	auto()
	setFailing(t, jt, id, "bbb", jobPR{Number: 30, State: prOpen, Checks: ciFail, Head: "zzz", Foreign: true})
	auto()
	setFailing(t, jt, id, "ccc")
	auto()
	setFailing(t, jt, id, "ddd")
	auto()
	j, _ := jt.agent.jobs.job(id)
	g := ciGrant(&j, time.Now())
	if len(jt.f.pasted) != 3 || g == nil || len(g.Uses) != maxCIRounds {
		t.Errorf("rounds: sent %d, grant %+v", len(jt.f.pasted), g)
	}
	for _, s := range jt.f.pasted {
		if strings.Contains(s, "#30") {
			t.Errorf("foreign pull request sent: %s", s)
		}
	}
	// A new grant replaces the old one; revoking it stops the sends.
	jt.do("full", http.MethodPost, gpath, map[string]any{"kind": "ci"})
	j, _ = jt.agent.jobs.job(id)
	g = ciGrant(&j, time.Now())
	if g == nil || len(g.Uses) != 0 {
		t.Fatalf("new grant %+v", g)
	}
	jt.do("full", http.MethodDelete, gpath+"/"+g.ID, nil)
	setFailing(t, jt, id, "eee")
	auto()
	if len(jt.f.pasted) != 3 {
		t.Errorf("sent after the grant ended: %d", len(jt.f.pasted))
	}
	// The ci grant answers no dialog.
	if got := jt.agent.grantsFor(snapPane{}, AgentSession{}, "bash"); len(got) != 0 {
		t.Errorf("ci grant used for a dialog: %+v", got)
	}
}

func TestJobCIAutoSendBacksOff(t *testing.T) {
	jt, id := newCISendTest(t)
	ctx := context.Background()
	if code, out := jt.do("full", http.MethodPost, "/api/mux/jobs/"+id+"/grants", map[string]any{"kind": "ci"}); code != http.StatusCreated {
		t.Fatalf("grant = %d %v", code, out)
	}
	jt.f.mu.Lock()
	jt.f.screen = boxScreen("half typed")
	jt.f.mu.Unlock()
	p := jt.agent.ci
	j, _ := jt.agent.jobs.job(id)
	p.autoSend(ctx, j)
	p.autoSend(ctx, j)
	j, _ = jt.agent.jobs.job(id)
	g := ciGrant(&j, time.Now())
	if len(g.Uses) != 0 || j.CI.Sent != "" || countEvents(j, "ci_failed_send") != 1 {
		t.Errorf("a refused send spent a round or was retried at once: %+v %+v", g, j.CI)
	}
	if s := p.state[id]; s.sendTries != 1 || !s.sendNext.After(time.Now()) {
		t.Errorf("backoff %+v", s)
	}
}
