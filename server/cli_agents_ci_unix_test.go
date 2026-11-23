//go:build !windows

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func ciCLIJob() jobView {
	j := job{ID: "j1", Title: "Parser", State: "review", CI: &jobCI{Repo: "github.com/o/r", Branch: "feat", PRs: []jobPR{
		{Number: 12, Repo: "github.com/o/r", State: prOpen, Checks: ciFail, Failing: []string{"lint", "e2e"}, URL: "https://github.com/o/r/pull/12"},
		{Number: 15, Repo: "github.com/o/r", State: prOpen, Checks: ciPass, Pinned: true},
		{Number: 20, Repo: "github.com/x/r", State: prOpen, Checks: ciFail, Foreign: true, Failing: []string{"x"}},
	}}}
	v := jobView{job: j, Live: jobLive{Status: "idle", PaneID: "%1", Ref: "w/api"}, CISummary: ciSummary(j.CI)}
	v.CIChecked = time.Now().Add(-40 * time.Second).UTC().Format(time.RFC3339)
	return v
}

func TestAgentsJobCI(t *testing.T) {
	tc, s := scriptedCLI(t)
	v := ciCLIJob()
	s.set("GET /api/mux/snapshot", jsonAnswer(Snapshot{}))
	s.set("GET /api/mux/jobs", jsonAnswer(map[string]any{"jobs": []jobView{v}}))
	if err := tc.dispatch("agents", []string{"job", "ci", "j1"}); err != nil {
		t.Fatal(err)
	}
	out := tc.stdout.String()
	for _, want := range []string{"Repository: github.com/o/r, branch feat", `#12  fail: "lint", "e2e"  https://github.com/o/r/pull/12`,
		"#15  pass  (attached)", "(from another repository: never sent on its own)", "Checked 4"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if len(s.posts) != 0 {
		t.Errorf("a plain read posted %v", s.posts)
	}
	// --json
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"job", "ci", "j1", "--json"}); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if json.Unmarshal(tc.stdout.Bytes(), &got) != nil || got["ciSummary"].(map[string]any)["worst"] != "fail" {
		t.Errorf("json %s", tc.stdout)
	}
	// --refresh: the read the server made, its error included, at once.
	failed := v
	failed.CI = &jobCI{Error: "ci_gh_auth"}
	s.set("POST /api/mux/jobs/j1/ci", jsonAnswer(map[string]any{"job": failed}))
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"job", "ci", "j1", "--refresh"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tc.stdout.String(), "Last read failed: ci_gh_auth (the user runs gh auth login") ||
		!strings.Contains(s.posts[0], `"action":"refresh"`) {
		t.Errorf("refresh %s %v", tc.stdout, s.posts)
	}
	// --send: sent, queued, and the refusals' exit codes.
	s.set("POST /api/mux/jobs/j1/ci", jsonAnswer(map[string]any{"job": v, "queued": true}))
	tc.stdout.Reset()
	tc.stderr.Reset()
	if err := tc.dispatch("agents", []string{"job", "ci", "j1", "--send"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tc.stderr.String()+tc.stdout.String(), "Queued the failed checks for w/api (%1)") {
		t.Errorf("send %s %s", tc.stdout, tc.stderr)
	}
	for code, exit := range map[string]int{"ci_nothing_failed": agentsExitNothingFailed, "job_no_agent": agentsExitNoAgent} {
		s.set("POST /api/mux/jobs/j1/ci", answer(http.StatusConflict, `{"code":"`+code+`","error":"refused"}`))
		if err := tc.dispatch("agents", []string{"job", "ci", "j1", "--send"}); exitCode(err) != exit {
			t.Errorf("%s: exit %d %v", code, exitCode(err), err)
		}
	}
	s.set("POST /api/mux/jobs/j1/ci", answer(http.StatusConflict, `{"code":"input_has_draft","error":"the input box already holds a draft"}`))
	if err := tc.dispatch("agents", []string{"job", "ci", "j1", "--send"}); err == nil || !strings.Contains(err.Error(), "ask them to send or clear it") {
		t.Errorf("draft: %v", err)
	}
	if err := tc.dispatch("agents", []string{"job", "ci"}); exitCode(err) != 2 {
		t.Errorf("no id: %v", err)
	}
	if err := tc.dispatch("agents", []string{"job", "ci", "nope"}); err == nil || !strings.Contains(err.Error(), "no job nope") {
		t.Errorf("unknown job: %v", err)
	}
}

func TestAgentsJobSetPRs(t *testing.T) {
	tc, s := scriptedCLI(t)
	v := ciCLIJob()
	var mu sync.Mutex
	var bodies []string
	s.set("GET /api/mux/snapshot", jsonAnswer(Snapshot{}))
	s.set("GET /api/mux/jobs", jsonAnswer(map[string]any{"jobs": []jobView{v}}))
	s.set("PATCH /api/mux/jobs/j1", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		mu.Unlock()
		jsonAnswer(map[string]any{"job": v})(w, r)
	})
	if err := tc.dispatch("agents", []string{"job", "set", "j1", "--pr", "12", "--pr", "#15", "--no-pr", "3"}); err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if len(bodies) != 1 || json.Unmarshal([]byte(bodies[0]), &body) != nil ||
		len(body["addPrs"].([]any)) != 2 || body["removePrs"].([]any)[0] != float64(3) {
		t.Errorf("bodies %v", bodies)
	}
	for _, bad := range []string{"0", "x", "-4"} {
		if err := tc.dispatch("agents", []string{"job", "set", "j1", "--pr", bad}); exitCode(err) != 2 {
			t.Errorf("--pr %s: %v", bad, err)
		}
	}
	if len(bodies) != 1 {
		t.Errorf("a bad number reached the server: %v", bodies)
	}
	// job show and jobs name the pull requests.
	tc.stdout.Reset()
	tc.dispatch("agents", []string{"job", "show", "j1"})
	if !strings.Contains(tc.stdout.String(), "PRs: #12 fail, #15 pass, #20 fail (termote agents job ci j1)") {
		t.Errorf("show %s", tc.stdout)
	}
	tc.stdout.Reset()
	tc.dispatch("agents", []string{"jobs"})
	if !strings.Contains(tc.stdout.String(), "fail (3)") {
		t.Errorf("jobs %s", tc.stdout)
	}
}
