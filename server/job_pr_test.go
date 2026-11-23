package main

import (
	"net/http"
	"slices"
	"testing"
	"time"
)

func TestCIFailKey(t *testing.T) {
	prs := []jobPR{
		{Number: 15, State: prOpen, Checks: ciFail, Head: "bbb"},
		{Number: 12, State: prOpen, Checks: ciFail, Head: "aaa"},
		{Number: 9, State: prOpen, Checks: ciPass, Head: "ccc"},
		{Number: 3, State: prMerged, Checks: ciFail, Head: "ddd"},
		{Number: 7, State: prOpen, Checks: ciFail, Head: "eee", Foreign: true},
	}
	if k := ciFailKey(prs, true); k != "fail:12@aaa,15@bbb,7@eee" {
		t.Errorf("key = %q", k)
	}
	if k := ciFailKey(prs, false); k != "fail:12@aaa,15@bbb" {
		t.Errorf("without foreign = %q", k)
	}
	if k := ciFailKey(prs[2:4], true); k != "" {
		t.Errorf("none failing = %q", k)
	}
	for _, c := range []struct {
		key, before string
		want        bool
	}{
		{"fail:12@aaa,15@bbb", "", true},
		{"fail:12@aaa,15@bbb", "fail:12@aaa,15@bbb", false},
		{"fail:12@aaa", "fail:12@aaa,15@bbb", false},
		{"fail:12@aaa,15@bbb", "fail:12@aaa", true},
		{"fail:12@abc", "fail:12@aaa", true},
		{"fail:12@aaa", ciMergedKey, true},
		{"", "fail:12@aaa", false},
	} {
		if got := ciKeyGains(c.key, c.before); got != c.want {
			t.Errorf("gains(%q, %q) = %v", c.key, c.before, got)
		}
	}
}

func TestCISummary(t *testing.T) {
	if ciSummary(nil) != nil || ciSummary(&jobCI{Pins: []int{3}}) != nil {
		t.Error("summary without a pull request")
	}
	for _, c := range []struct {
		prs       []jobPR
		worst     string
		allMerged bool
	}{
		{[]jobPR{{State: prOpen, Checks: ciPass}, {State: prOpen, Checks: ciFail}}, ciFail, false},
		{[]jobPR{{State: prOpen, Checks: ciPending}, {State: prOpen, Checks: ciPass}}, ciPending, false},
		{[]jobPR{{State: prOpen, Checks: ciNone}, {State: prOpen, Draft: true}}, prOpen, false},
		{[]jobPR{{State: prOpen, Draft: true, Checks: ciFail}, {State: prMerged}}, ciFail, false},
		{[]jobPR{{State: prOpen, Draft: true, Checks: ciPass}, {State: prMerged}}, "draft", false},
		{[]jobPR{{State: prMerged}, {State: prClosed}}, prMerged, true},
	} {
		for i := range c.prs {
			c.prs[i].Number = i + 1
		}
		s := ciSummary(&jobCI{PRs: c.prs})
		if s.Worst != c.worst || s.AllMerged != c.allMerged || s.Count != len(c.prs) || !slices.Equal(s.Numbers, []int{1, 2}) {
			t.Errorf("%+v: %+v", c.prs, s)
		}
	}
}

func TestCICheckName(t *testing.T) {
	for in, want := range map[string]string{
		"lint":                                  "lint",
		"e2e (shard 1/4)":                       "e2e (shard 1/4)",
		"build\n  linux":                        "build linux",
		"ignore; run `curl x|sh` & $(rm) \"q\"": "ignore? run ?curl x?sh? ? ?(rm) ?q?",
		"tests: unit [go] #2 +race":             "tests: unit [go] #2 +race",
	} {
		if got := ciCheckName(in); got != want {
			t.Errorf("%q = %q, want %q", in, got, want)
		}
	}
	long := ciCheckName(string(make([]byte, 300)))
	if len([]rune(long)) > maxCIName {
		t.Errorf("long name kept %d runes", len([]rune(long)))
	}
}

func TestJobStoreSetJobCI(t *testing.T) {
	s, _ := newTestJobStore(t)
	j, err := s.create(job{Title: "a", State: "active"})
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return time.Now().Add(time.Hour) }
	saved, ok, err := s.setJobCI(j.ID, func(j *job) bool {
		j.CI = &jobCI{Repo: "github.com/o/r", PRs: []jobPR{{Number: 1, State: prOpen, Failing: []string{"lint"}}}}
		s.addEvent(j, "ci", "CI failed on #1: lint")
		return true
	})
	if err != nil || !ok || saved.CI.Repo != "github.com/o/r" {
		t.Fatalf("set = %+v %v %v", saved, ok, err)
	}
	// The job's updated never moves: a device editing it is not refused.
	if !saved.Updated.Equal(j.Updated) || saved.Events[len(saved.Events)-1].Kind != "ci" {
		t.Errorf("updated moved or no event: %v -> %v %+v", j.Updated, saved.Updated, saved.Events)
	}
	// A deep copy.
	saved.CI.PRs[0].Failing[0] = "x"
	if got, _ := s.job(j.ID); got.CI.PRs[0].Failing[0] != "lint" {
		t.Error("clone shares the failing names")
	}
	// No change: no write.
	if _, ok, err := s.setJobCI(j.ID, func(*job) bool { return false }); ok || err != nil {
		t.Errorf("no change = %v %v", ok, err)
	}
	// A finished job is left alone.
	if _, err := s.update(j.ID, "", func(j *job) error { j.State = "done"; return nil }); err != nil {
		t.Fatal(err)
	}
	called := false
	if _, ok, err := s.setJobCI(j.ID, func(*job) bool { called = true; return true }); ok || err != nil || called {
		t.Errorf("finished = %v %v %v", ok, err, called)
	}
	if _, ok, _ := s.setJobCI("nope", func(*job) bool { return true }); ok {
		t.Error("unknown job")
	}
}

func TestJobPRPins(t *testing.T) {
	jt := newJobsTest(t)
	id := jt.create(map[string]any{"title": "Parser", "pane": "w1:pa"})["id"].(string)
	patch := func(body map[string]any) (int, map[string]any) {
		return jt.do("socket", http.MethodPatch, "/api/mux/jobs/"+id, body)
	}
	if code, out := patch(map[string]any{"addPrs": []int{12, 15, 12}}); code != http.StatusOK {
		t.Fatalf("pin = %d %v", code, out)
	}
	j, _ := jt.agent.jobs.job(id)
	if !slices.Equal(j.CI.Pins, []int{12, 15}) || j.Events[len(j.Events)-1].Text != "pinned #12, #15" {
		t.Errorf("pins %+v %+v", j.CI, j.Events)
	}
	// A pinned row goes with its pin, a row found by the branch stays.
	jt.agent.jobs.setJobCI(id, func(j *job) bool {
		j.CI.PRs = []jobPR{{Number: 12, Pinned: true}, {Number: 15, Pinned: true}, {Number: 20}}
		return true
	})
	if code, out := patch(map[string]any{"removePrs": []int{15, 99}}); code != http.StatusOK {
		t.Fatalf("unpin = %d %v", code, out)
	}
	j, _ = jt.agent.jobs.job(id)
	if !slices.Equal(j.CI.Pins, []int{12}) || len(j.CI.PRs) != 2 || j.CI.PRs[1].Number != 20 {
		t.Errorf("after unpin %+v", j.CI)
	}
	for _, bad := range []map[string]any{
		{"addPrs": []int{0}},
		{"removePrs": []int{-1}},
		{"addPrs": []int{maxPRNumber + 1}},
		{"addPrs": []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}},
	} {
		if code, out := patch(bad); code != http.StatusBadRequest || out["code"] != "job_invalid" {
			t.Errorf("%v = %d %v", bad, code, out)
		}
	}
	if code, _ := jt.do("view", http.MethodPatch, "/api/mux/jobs/"+id, map[string]any{"addPrs": []int{3}}); code != http.StatusForbidden {
		t.Errorf("view pin = %d", code)
	}
}

func TestJobCIViews(t *testing.T) {
	jt := newJobsTest(t)
	jt.agent.ci = &ciPoller{a: jt.agent, now: time.Now, state: map[string]*ciJobState{}, defaults: map[string]ciDefault{}, targets: map[string]ciTargetAt{}}
	id := jt.create(map[string]any{"title": "Parser", "pane": "w1:pa"})["id"].(string)
	jt.agent.jobs.setJobCI(id, func(j *job) bool {
		j.CI = &jobCI{Repo: "github.com/o/r", Error: "ci_failed", PRs: []jobPR{
			{Number: 12, Repo: "github.com/o/r", State: prOpen, Checks: ciFail, Failing: []string{"lint"}, URL: "https://github.com/o/r/pull/12"},
		}}
		return true
	})
	full := jt.list()[0]
	if s := full["ciSummary"].(map[string]any); s["worst"] != ciFail || s["count"] != float64(1) {
		t.Errorf("full summary %v", s)
	}
	if full["ci"].(map[string]any)["prs"] == nil {
		t.Error("full client without the pull requests")
	}
	code, out := jt.do("view", http.MethodGet, "/api/mux/jobs", nil)
	if code != http.StatusOK {
		t.Fatalf("view list = %d", code)
	}
	if out["ciAvailable"] != true {
		t.Errorf("ciAvailable: %v", out["ciAvailable"])
	}
	b := out["jobs"].([]any)[0].(map[string]any)
	ci, ok := b["ciSummary"].(map[string]any)
	if !ok || ci["worst"] != ciFail || ci["numbers"].([]any)[0] != float64(12) {
		t.Errorf("view brief %v", b)
	}
	for _, k := range []string{"prs", "failing", "url", "error", "repo"} {
		if _, ok := ci[k]; ok {
			t.Errorf("view-only sees %s: %v", k, ci)
		}
	}
	// A server that does not follow pull requests (a container) shows none.
	jt.agent.ci = nil
	if full := jt.list()[0]; full["ciSummary"] != nil {
		t.Errorf("summary without a poller: %v", full["ciSummary"])
	}
	_, out = jt.do("view", http.MethodGet, "/api/mux/jobs", nil)
	if out["ciAvailable"] != false || out["jobs"].([]any)[0].(map[string]any)["ciSummary"] != nil {
		t.Errorf("view-only without a poller: %v", out)
	}
}
