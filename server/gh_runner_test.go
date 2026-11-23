package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeGh is a gh the test binary plays (TestGhFake): it logs every call
// and answers from the replies the test set, by the call's arguments.
type fakeGh struct {
	t   *testing.T
	dir string
	mu  sync.Mutex
}

type fakeGhReply struct {
	Out     string `json:"out"`
	Err     string `json:"err"`
	Code    int    `json:"code"`
	SleepMS int    `json:"sleepMs"`
}

type fakeGhCall struct {
	Args []string `json:"args"`
	Dir  string   `json:"dir"`
	Env  []string `json:"env"`
}

// TestGhFake is the fake gh, run as a child process by ghRunner.
func TestGhFake(t *testing.T) {
	dir := os.Getenv("GH_FAKE_DIR")
	if dir == "" {
		t.Skip("the fake gh, run by the gh tests")
	}
	args := os.Args[slices.Index(os.Args, "--")+1:]
	wd, _ := os.Getwd()
	line, _ := json.Marshal(fakeGhCall{Args: args, Dir: wd, Env: os.Environ()})
	f, _ := os.OpenFile(filepath.Join(dir, "calls"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	f.Write(append(line, '\n'))
	f.Close()
	replies := map[string]fakeGhReply{}
	b, _ := os.ReadFile(filepath.Join(dir, "replies.json"))
	json.Unmarshal(b, &replies)
	r, ok := replies[strings.Join(args, " ")]
	if !ok {
		r = fakeGhReply{Err: "unknown call", Code: 1}
	}
	time.Sleep(time.Duration(r.SleepMS) * time.Millisecond)
	os.Stdout.WriteString(r.Out)
	os.Stderr.WriteString(r.Err)
	os.Exit(r.Code)
}

func newFakeGh(t *testing.T) (*fakeGh, *ghRunner) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("GH_FAKE_DIR", dir)
	f := &fakeGh{t: t, dir: dir}
	f.save(map[string]fakeGhReply{})
	g := newGhRunner(t.TempDir())
	g.look = func() string { return os.Args[0] }
	g.prefix = []string{"-test.run=^TestGhFake$", "--"}
	g.same = newTTLCache[[]byte](0)
	return f, g
}

func (f *fakeGh) save(r map[string]fakeGhReply) {
	b, _ := json.Marshal(r)
	if err := os.WriteFile(filepath.Join(f.dir, "replies.json"), b, 0o600); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fakeGh) reply(args string, r fakeGhReply) {
	f.mu.Lock()
	defer f.mu.Unlock()
	all := map[string]fakeGhReply{}
	b, _ := os.ReadFile(filepath.Join(f.dir, "replies.json"))
	json.Unmarshal(b, &all)
	all[args] = r
	f.save(all)
}

func (f *fakeGh) calls() []fakeGhCall {
	b, _ := os.ReadFile(filepath.Join(f.dir, "calls"))
	var out []fakeGhCall
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var c fakeGhCall
		if json.Unmarshal([]byte(l), &c) == nil {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeGh) callsOf(prefix string) int {
	n := 0
	for _, c := range f.calls() {
		if strings.HasPrefix(strings.Join(c.Args, " "), prefix) {
			n++
		}
	}
	return n
}

var testRepo = ghRepo{"github.com", "o", "r"}

func prListArgs(repo, branch string) string {
	return "pr list --repo=" + repo + " --head=" + branch + " --state=all --limit=20 --json=" + ghPRFields
}

func TestGhRunnerCall(t *testing.T) {
	f, g := newFakeGh(t)
	t.Setenv("GH_HOST", "ghe.example.com")
	t.Setenv("GH_ENTERPRISE_TOKEN", "x")
	t.Setenv("GITHUB_ENTERPRISE_TOKEN", "x")
	t.Setenv("GH_REPO", "a/b")
	t.Setenv("GIT_DIR", "/tmp/x")
	t.Setenv("TERMOTE_PASS", "x")
	f.reply(prListArgs("github.com/o/r", "feat/a"), fakeGhReply{Out: `[{"number":3,"state":"OPEN"}]`})
	prs, err := g.listPRs(context.Background(), testRepo, "feat/a")
	if err != nil || len(prs) != 1 || prs[0].Number != 3 {
		t.Fatalf("list = %+v %v", prs, err)
	}
	c := f.calls()[0]
	if want := strings.Fields(prListArgs("github.com/o/r", "feat/a")); !slices.Equal(c.Args, want) {
		t.Errorf("argv %q", c.Args)
	}
	if real, _ := filepath.EvalSymlinks(g.dir); c.Dir != g.dir && c.Dir != real {
		t.Errorf("gh ran in %s, not the state dir", c.Dir)
	}
	for _, kv := range c.Env {
		k, _, _ := strings.Cut(kv, "=")
		if slices.Contains([]string{"GH_HOST", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_REPO", "GIT_DIR", "TERMOTE_PASS"}, k) {
			t.Errorf("gh got %s", k)
		}
	}
	for _, want := range []string{"GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1", "GH_PAGER=cat"} {
		if !slices.Contains(c.Env, want) {
			t.Errorf("gh without %s", want)
		}
	}
}

func TestGhRunnerErrors(t *testing.T) {
	f, g := newFakeGh(t)
	ctx := context.Background()
	f.reply("pr view 1 --repo=github.com/o/r --json="+ghPRFields, fakeGhReply{Err: "To get started with GitHub CLI, please run:  gh auth login", Code: 4})
	if _, err := g.viewPR(ctx, testRepo, 1); !errors.Is(err, errGhAuth) {
		t.Errorf("auth = %v", err)
	}
	f.reply("pr view 2 --repo=github.com/o/r --json="+ghPRFields, fakeGhReply{Err: "GraphQL: Could not resolve to a PullRequest (secret text)", Code: 1})
	_, err := g.viewPR(ctx, testRepo, 2)
	if !errors.Is(err, errGhFailed) || strings.Contains(err.Error(), "secret") {
		t.Errorf("failed = %v", err)
	}
	f.reply("pr view 3 --repo=github.com/o/r --json="+ghPRFields, fakeGhReply{Out: "not json"})
	if _, err := g.viewPR(ctx, testRepo, 3); !errors.Is(err, errGhFailed) {
		t.Errorf("bad json = %v", err)
	}
	// A rate limit stops every call until the pause ends.
	f.reply("pr view 4 --repo=github.com/o/r --json="+ghPRFields, fakeGhReply{Err: "API rate limit exceeded for user", Code: 1})
	if _, err := g.viewPR(ctx, testRepo, 4); !errors.Is(err, errCIBusy) {
		t.Errorf("rate limit = %v", err)
	}
	n := len(f.calls())
	if _, err := g.viewPR(ctx, testRepo, 2); !errors.Is(err, errCIBusy) || len(f.calls()) != n {
		t.Errorf("call during the pause = %v, %d calls", err, len(f.calls())-n)
	}
	// The hour's budget.
	g.paused = time.Time{}
	g.calls = make([]time.Time, ghHourBudget)
	for i := range g.calls {
		g.calls[i] = time.Now()
	}
	if _, err := g.viewPR(ctx, testRepo, 2); !errors.Is(err, errCIBusy) {
		t.Errorf("over budget = %v", err)
	}
	// No gh: looked for again later only.
	g2 := newGhRunner(t.TempDir())
	looks := 0
	g2.look = func() string { looks++; return "" }
	if _, err := g2.viewPR(ctx, testRepo, 1); !errors.Is(err, errGhMissing) {
		t.Errorf("missing = %v", err)
	}
	g2.viewPR(ctx, testRepo, 1)
	if looks != 1 {
		t.Errorf("looked %d times", looks)
	}
	if ciErrorCode(errGhMissing) != "ci_gh_missing" || ciErrorCode(errCIBusy) != "" || ciErrorCode(errors.New("x")) != "ci_failed" {
		t.Error("ciErrorCode")
	}
}

func TestGhSignedIn(t *testing.T) {
	f, g := newFakeGh(t)
	ctx := context.Background()
	f.reply("auth status --hostname=github.com", fakeGhReply{Out: "Logged in"})
	f.reply("auth status --hostname=ghe.example.com", fakeGhReply{Err: "You are not logged into any GitHub hosts. To log in, run: gh auth login", Code: 1})
	if ok, err := g.signedIn(ctx, "github.com"); !ok || err != nil {
		t.Errorf("github.com = %v %v", ok, err)
	}
	if ok, err := g.signedIn(ctx, "ghe.example.com"); ok || err != nil {
		t.Errorf("ghe = %v %v", ok, err)
	}
	g.signedIn(ctx, "github.com")
	if n := f.callsOf("auth status --hostname=github.com"); n != 1 {
		t.Errorf("asked %d times", n)
	}
}

func TestParseRemoteURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/o/r.git":           "github.com/o/r",
		"https://github.com/o/r":               "github.com/o/r",
		"https://user@GitHub.com/o/r.git/":     "github.com/o/r",
		"git@github.com:o/r.git":               "github.com/o/r",
		"ssh://git@ssh.github.com:443/o/r.git": "github.com/o/r",
		"ssh://git@github.com/o/r":             "github.com/o/r",
		"git@github-work:o/r.git":              "github-work/o/r",
		"https://ghe.example.com/team/app.git": "ghe.example.com/team/app",
		"file:///srv/o/r.git":                  "",
		"/srv/o/r.git":                         "",
		"https://github.com/o":                 "",
		"https://github.com/o/r/extra":         "",
		"https://github.com/o;x/r":             "",
		"https://github.com/o/..":              "",
		"git@bad_host!:o/r":                    "",
	} {
		r, ok := parseRemoteURL(in)
		got := ""
		if ok {
			got = r.String()
		}
		if got != want {
			t.Errorf("%q = %q, want %q", in, got, want)
		}
	}
}

func TestToJobPR(t *testing.T) {
	push := ghRepo{"github.com", "me", "r"}
	head := strings.Repeat("a", 40)
	in := fmt.Sprintf(`{"number":12,"state":"OPEN","isDraft":false,"url":"https://github.com/o/r/pull/12","headRefOid":%q,
	"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"me"},"statusCheckRollup":[
	{"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/o/r/actions/runs/456/job/7"},
	{"__typename":"CheckRun","name":"run; curl x|sh","status":"COMPLETED","conclusion":"TIMED_OUT","detailsUrl":"https://evil.example/o/r/actions/runs/9"},
	{"__typename":"CheckRun","name":"e2e","status":"IN_PROGRESS","conclusion":""},
	{"__typename":"StatusContext","context":"ci/other","state":"ERROR","targetUrl":"https://github.com/x/y/actions/runs/1"},
	{"__typename":"CheckRun","name":"ok","status":"COMPLETED","conclusion":"SUCCESS"}]}`, head)
	var g ghPR
	if err := json.Unmarshal([]byte(in), &g); err != nil {
		t.Fatal(err)
	}
	pr, ok := toJobPR(g, testRepo, push)
	if !ok || pr.Checks != ciFail || pr.FailRun != 456 || pr.Head != head[:12] || pr.Foreign || pr.URL == "" {
		t.Fatalf("pr %+v", pr)
	}
	if !slices.Equal(pr.Failing, []string{"lint", "run? curl x?sh", "ci/other"}) {
		t.Errorf("failing %q", pr.Failing)
	}
	// Someone else's head, a link to another repo, pending only.
	g.HeadRepositoryOwner.Login = "other"
	g.URL = "https://evil.example/o/r/pull/12"
	g.StatusCheckRollup = g.StatusCheckRollup[2:3]
	pr, _ = toJobPR(g, testRepo, push)
	if !pr.Foreign || pr.URL != "" || pr.Checks != ciPending {
		t.Errorf("foreign %+v", pr)
	}
	g.StatusCheckRollup = nil
	g.State = "MERGED"
	if pr, _ = toJobPR(g, testRepo, push); pr.Checks != ciNone || pr.State != prMerged {
		t.Errorf("merged %+v", pr)
	}
	g.State = "WEIRD"
	if _, ok := toJobPR(g, testRepo, push); ok {
		t.Error("unknown state kept")
	}
}
