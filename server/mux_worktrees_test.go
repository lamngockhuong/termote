package main

import (
	"context"
	"errors"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestValidBranchName(t *testing.T) {
	for _, s := range []string{"feat/x", "a.b", "日本", "main", "a-b_c", "x/y/z", strings.Repeat("a", 255)} {
		if !validBranchName(s) {
			t.Errorf("validBranchName(%q) = false", s)
		}
	}
	for _, s := range []string{
		"", "-x", "HEAD", "@", "a..b", "a@{1}", ".x", "x/.y", "x.lock", "x/y.lock/z", "x/", "/x", "x.",
		"a//b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", `a\b`, "a‮b", "a​b", "a\u0085b",
		"x y", "a\tb", "a\x7fb", "a\xffb", strings.Repeat("a", 256),
	} {
		if validBranchName(s) {
			t.Errorf("validBranchName(%q) = true", s)
		}
	}
	for s, want := range map[string]bool{"": true, "HEAD": true, "main": true, "-x": false, "HEAD~1": false, "a b": false} {
		if validBase(s) != want {
			t.Errorf("validBase(%q) = %v", s, !want)
		}
	}
}

// Whatever validBranchName accepts, git accepts as a branch name too.
func TestValidBranchNameAgreesWithGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	alphabet := []rune("ab/.-_@{}~^:?*[\\ 日‮​HEADlock")
	rng := rand.New(rand.NewSource(1))
	checked := 0
	for i := 0; i < 3000 && checked < 150; i++ {
		n := 1 + rng.Intn(10)
		var b strings.Builder
		for range n {
			b.WriteRune(alphabet[rng.Intn(len(alphabet))])
		}
		s := b.String()
		if !validBranchName(s) {
			continue
		}
		checked++
		if out, err := exec.Command("git", "check-ref-format", "--branch", s).CombinedOutput(); err != nil {
			t.Errorf("validBranchName(%q) = true, git: %v %s", s, err, out)
		}
	}
	if checked < 20 {
		t.Fatalf("only %d accepted names checked", checked)
	}
}

// worktreeFake is a backend with worktrees over fakeMux.
type worktreeFake struct {
	*fakeMux
	caps bool

	mu    sync.Mutex
	list  WorktreeList
	err   error         // every worktree call fails with it
	block chan struct{} // create and remove wait on it (or their ctx) when set
	calls []string
	ctxOK []bool // whether each create/remove still had a live context when it returned
}

func (f *worktreeFake) Caps() Caps { return Caps{Groups: true, Worktrees: f.caps} }

func (f *worktreeFake) ValidGroupID(id string) bool { return herdrWorkspaceIDRe.MatchString(id) }

func (f *worktreeFake) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}

func (f *worktreeFake) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *worktreeFake) ListWorktrees(_ context.Context, id string) (WorktreeList, error) {
	f.record("list " + id)
	f.mu.Lock()
	defer f.mu.Unlock()
	l := f.list
	l.Worktrees = slices.Clone(l.Worktrees)
	return l, f.err
}

func (f *worktreeFake) wait(ctx context.Context) error {
	f.mu.Lock()
	block := f.block
	f.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
		}
	}
	f.mu.Lock()
	f.ctxOK = append(f.ctxOK, ctx.Err() == nil)
	f.mu.Unlock()
	return ctx.Err()
}

func (f *worktreeFake) CreateWorktree(ctx context.Context, id, branch, base, label string) (string, error) {
	f.record("create " + id + " " + branch + " base=" + base + " label=" + label)
	if err := f.wait(ctx); err != nil {
		return "", err
	}
	return "wNEW", f.err
}

func (f *worktreeFake) OpenWorktree(_ context.Context, id, branch string) (string, bool, error) {
	f.record("open " + id + " " + branch)
	return "w13", true, f.err
}

func (f *worktreeFake) RemoveWorktree(ctx context.Context, id string, force bool) error {
	if force {
		f.record("remove " + id + " force")
	} else {
		f.record("remove " + id)
	}
	if err := f.wait(ctx); err != nil {
		return err
	}
	return f.err
}

// worktreeRepo makes a git repo with branches main (checked out),
// e2e-base and an invalid-looking but git-valid "a​b".
func worktreeRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"},
		{"branch", "e2e-base"},
		{"branch", "a​b"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	return dir
}

func newWorktreeFake(repo string) *worktreeFake {
	return &worktreeFake{fakeMux: &fakeMux{}, caps: true, list: WorktreeList{
		RepoName: "repo", RepoRoot: repo,
		Worktrees: []Worktree{
			{Path: repo, Branch: "main", GroupID: "wR"},
			{Path: "/wt/feat-x", Branch: "feat/x", Linked: true, Openable: true, GroupID: "w13"},
		},
	}}
}

func codeOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	_, code := replyOf(t, rec.Body.Bytes())
	return code
}

func TestWorktreeRoutes(t *testing.T) {
	repo := worktreeRepo(t)
	f := newWorktreeFake(repo)
	h := newTestHandler(t, f)

	rec := serve(h, apiRequest(http.MethodGet, "/api/mux/worktrees?groupId=wR", ""))
	body := decodeBody(t, rec)
	if rec.Code != 200 || body["repoName"] != "repo" || len(body["worktrees"].([]any)) != 2 {
		t.Fatalf("list = %d %v", rec.Code, body)
	}
	branches := body["branches"].([]any)
	if len(branches) != 2 || !slices.Contains(branches, any("main")) || !slices.Contains(branches, any("e2e-base")) {
		t.Errorf("branches = %v (the zero-width name must be dropped)", branches)
	}
	if strings.Contains(rec.Body.String(), repo+`"`) && strings.Contains(rec.Body.String(), "repoRoot") {
		t.Errorf("repo root sent: %s", rec.Body)
	}

	for _, c := range []struct {
		body, call string
		status     int
		code       string
	}{
		{`{"groupId":"wR","branch":"feat/new"}`, "create wR feat/new base= label=", 200, ""},
		{`{"groupId":"wR","branch":"feat/new","base":"main","label":"New one"}`, "create wR feat/new base=main label=New one", 200, ""},
		{`{"groupId":"wR","branch":"feat/new","base":"HEAD"}`, "create wR feat/new base=HEAD label=", 200, ""},
		{`{"groupId":"wR","branch":"e2e-base"}`, "create wR e2e-base base= label=", 200, ""},
		{`{"groupId":"wR","branch":"e2e-base","base":"main"}`, "", 409, "branch_exists"},
	} {
		f.mu.Lock()
		f.calls = nil
		f.mu.Unlock()
		rec := serve(h, apiRequest(http.MethodPost, "/api/mux/worktrees", c.body))
		if rec.Code != c.status || c.code != "" && codeOf(t, rec) != c.code {
			t.Errorf("create %s = %d %s", c.body, rec.Code, rec.Body)
		}
		calls := f.recorded()
		created := slices.IndexFunc(calls, func(s string) bool { return strings.HasPrefix(s, "create ") })
		switch {
		case c.call == "" && created >= 0:
			t.Errorf("create %s: backend created: %q", c.body, calls)
		case c.call != "" && (created < 0 || calls[created] != c.call):
			t.Errorf("create %s: calls %q, want %q", c.body, calls, c.call)
		}
		if c.status == 200 && !strings.Contains(rec.Body.String(), `"id":"wNEW"`) {
			t.Errorf("create %s: %s", c.body, rec.Body)
		}
	}

	rec = serve(h, apiRequest(http.MethodPost, "/api/mux/worktrees/open", `{"groupId":"wR","branch":"feat/x"}`))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"alreadyOpen":true`) || !strings.Contains(rec.Body.String(), `"id":"w13"`) {
		t.Errorf("open = %d %s", rec.Code, rec.Body)
	}

	for force, call := range map[string]string{"false": "remove w13", "true": "remove w13 force"} {
		f.mu.Lock()
		f.calls = nil
		f.mu.Unlock()
		rec := serve(h, apiRequest(http.MethodDelete, "/api/mux/worktrees/w13", `{"force":`+force+`,"path":"/wt/feat-x","branch":"feat/x"}`))
		if calls := f.recorded(); rec.Code != 200 || len(calls) != 2 || calls[1] != call {
			t.Errorf("remove force=%s = %d %s, calls %q", force, rec.Code, rec.Body, calls)
		}
	}

	for path, allow := range map[string]string{"/api/mux/worktrees": "GET, POST", "/api/mux/worktrees/open": "POST", "/api/mux/worktrees/w13": "DELETE"} {
		rec := serve(h, apiRequest(http.MethodPut, path, "{}"))
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != allow || rec.Header().Get("Content-Type") != "application/json" {
			t.Errorf("PUT %s = %d, Allow %q", path, rec.Code, rec.Header().Get("Allow"))
		}
	}
}

// Refusals before the backend changes anything carry their code.
func TestWorktreeRoutesRefuseBadInput(t *testing.T) {
	f := newWorktreeFake("/repo")
	h := newTestHandler(t, f)
	cases := []struct {
		name, method, path, body string
		status                   int
		code                     string
	}{
		{"bad group id", "GET", "/api/mux/worktrees?groupId=-x", "", 400, "invalid_group_id"},
		{"no group id", "GET", "/api/mux/worktrees", "", 400, "invalid_group_id"},
		{"create bad id", "POST", "/api/mux/worktrees", `{"groupId":"x y","branch":"a"}`, 400, "invalid_group_id"},
		{"empty branch", "POST", "/api/mux/worktrees", `{"groupId":"wR","branch":""}`, 400, "invalid_name"},
		{"dash branch", "POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"-x"}`, 400, "invalid_name"},
		{"bidi branch", "POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a‮b"}`, 400, "invalid_name"},
		{"HEAD branch", "POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"HEAD"}`, 400, "invalid_name"},
		{"dash base", "POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a","base":"--orphan"}`, 400, "invalid_name"},
		{"bad label", "POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a","label":"a\nb"}`, 400, "invalid_name"},
		{"open bad branch", "POST", "/api/mux/worktrees/open", `{"groupId":"wR","branch":"a..b"}`, 400, "invalid_name"},
		{"open bad id", "POST", "/api/mux/worktrees/open", `{"groupId":"","branch":"a"}`, 400, "invalid_group_id"},
		{"remove bad id", "DELETE", "/api/mux/worktrees/x", `{"force":false,"path":"/p","branch":"b"}`, 400, "invalid_group_id"},
		{"remove no body", "DELETE", "/api/mux/worktrees/w13", "", 400, "invalid_request"},
		{"remove no force", "DELETE", "/api/mux/worktrees/w13", `{"path":"/wt/feat-x","branch":"feat/x"}`, 400, "invalid_request"},
		{"remove string force", "DELETE", "/api/mux/worktrees/w13", `{"force":"true","path":"/wt/feat-x","branch":"feat/x"}`, 400, "invalid_request"},
		{"remove no path", "DELETE", "/api/mux/worktrees/w13", `{"force":false,"branch":"feat/x"}`, 400, "invalid_request"},
		{"remove no branch", "DELETE", "/api/mux/worktrees/w13", `{"force":false,"path":"/wt/feat-x"}`, 400, "invalid_request"},
	}
	for _, c := range cases {
		rec := serve(h, apiRequest(c.method, c.path, c.body))
		if code := codeOf(t, rec); rec.Code != c.status || code != c.code {
			t.Errorf("%s: %d %q, want %d %q", c.name, rec.Code, code, c.status, c.code)
		}
	}
	if calls := f.recorded(); len(calls) != 0 {
		t.Errorf("backend called: %q", calls)
	}

	// An empty label is left out, not refused.
	if rec := serve(h, apiRequest("POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a","label":""}`)); rec.Code != 200 {
		t.Errorf("empty label = %d %s", rec.Code, rec.Body)
	}

	// The confirmed checkout no longer matches: nothing is removed.
	for name, c := range map[string]struct{ id, body, code string }{
		"other path":   {"w13", `{"force":true,"path":"/wt/other","branch":"feat/x"}`, "changed"},
		"other branch": {"w13", `{"force":true,"path":"/wt/feat-x","branch":"feat/y"}`, "changed"},
		"not open":     {"w99", `{"force":false,"path":"/wt/feat-x","branch":"feat/x"}`, "changed"},
		"repo's own":   {"wR", `{"force":false,"path":"/repo","branch":"main"}`, "not_linked"},
	} {
		f.mu.Lock()
		f.calls = nil
		f.mu.Unlock()
		rec := serve(h, apiRequest("DELETE", "/api/mux/worktrees/"+c.id, c.body))
		if code := codeOf(t, rec); rec.Code != 409 || code != c.code {
			t.Errorf("%s: %d %q", name, rec.Code, code)
		}
		if calls := f.recorded(); len(calls) != 1 || !strings.HasPrefix(calls[0], "list ") {
			t.Errorf("%s: calls %q", name, calls)
		}
	}
}

// The guards in front of every route answer before it, without a code.
func TestWorktreeRoutesGuards(t *testing.T) {
	f := newWorktreeFake("/repo")
	h := newTestHandler(t, f)
	writes := []struct{ method, path, body string }{
		{"POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a"}`},
		{"POST", "/api/mux/worktrees/open", `{"groupId":"wR","branch":"feat/x"}`},
		{"DELETE", "/api/mux/worktrees/w13", `{"force":false,"path":"/wt/feat-x","branch":"feat/x"}`},
	}
	guards := []struct {
		name   string
		mod    func(*http.Request)
		status int
	}{
		{"cross-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		{"foreign origin", func(r *http.Request) { r.Header.Del("Sec-Fetch-Site"); r.Header.Set("Origin", "https://evil.example") }, 403},
		{"not JSON", func(r *http.Request) { r.Header.Del("Content-Type") }, 415},
		{"unknown host", func(r *http.Request) { r.Host = "evil.example" }, 403},
		{"no auth", func(r *http.Request) { r.Header.Del("Authorization") }, 401},
	}
	for _, rt := range writes {
		for _, g := range guards {
			req := apiRequest(rt.method, rt.path, rt.body)
			g.mod(req)
			rec := serve(h, req)
			if rec.Code != g.status || strings.Contains(rec.Body.String(), `"code"`) {
				t.Errorf("%s %s %s: %d %s, want %d", g.name, rt.method, rt.path, rec.Code, rec.Body, g.status)
			}
		}
		big := `{"groupId":"` + strings.Repeat("a", maxJSONBody) + `"}`
		if rec := serve(h, apiRequest(rt.method, rt.path, big)); rec.Code != http.StatusBadRequest {
			t.Errorf("large body %s: %d", rt.path, rec.Code)
		}
	}
	for name, mod := range map[string]func(*http.Request){
		"cross-site":     func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		"none":           func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "none") },
		"foreign origin": func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") },
	} {
		req := apiRequest("GET", "/api/mux/worktrees?groupId=wR", "")
		mod(req)
		if rec := serve(h, req); rec.Code != 403 {
			t.Errorf("GET %s: %d", name, rec.Code)
		}
	}
	if calls := f.recorded(); len(calls) != 0 {
		t.Errorf("backend called: %q", calls)
	}
}

// Without worktrees (a tmux backend, or Herdr's caps off) every route is 501.
func TestWorktreeRoutesUnsupported(t *testing.T) {
	off := newWorktreeFake("/repo")
	off.caps = false
	for name, m := range map[string]Mux{"caps off": off, "tmux": &fakeMux{}} {
		h := newTestHandler(t, m)
		for _, rt := range []struct{ method, path, body string }{
			{"GET", "/api/mux/worktrees?groupId=wR", ""},
			{"POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a"}`},
			{"POST", "/api/mux/worktrees/open", `{"groupId":"wR","branch":"a"}`},
			{"DELETE", "/api/mux/worktrees/w13", `{"force":false,"path":"/p","branch":"b"}`},
		} {
			rec := serve(h, apiRequest(rt.method, rt.path, rt.body))
			if code := codeOf(t, rec); rec.Code != 501 || code != "unsupported" {
				t.Errorf("%s %s %s: %d %q", name, rt.method, rt.path, rec.Code, code)
			}
		}
	}
	if calls := off.recorded(); len(calls) != 0 {
		t.Errorf("backend called: %q", calls)
	}
}

func shortWorktreeTimeouts(t *testing.T, lock, change time.Duration) {
	t.Helper()
	l, c := worktreeLockWait, worktreeTimeout
	worktreeLockWait, worktreeTimeout = lock, change
	t.Cleanup(func() { worktreeLockWait, worktreeTimeout = l, c })
}

// One change at a time: another one waits at most worktreeLockWait, then
// gets busy without reaching the backend.
func TestWorktreeRoutesBusy(t *testing.T) {
	shortWorktreeTimeouts(t, 100*time.Millisecond, 5*time.Second)
	f := newWorktreeFake("/repo")
	f.block = make(chan struct{})
	h := newTestHandler(t, f)
	first := make(chan *httptest.ResponseRecorder)
	go func() {
		first <- serve(h, apiRequest("POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a"}`))
	}()
	waitUntil(t, "first create", func() bool { return len(f.recorded()) == 1 })
	start := time.Now()
	for _, rt := range []struct{ method, path, body string }{
		{"POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"b"}`},
		{"POST", "/api/mux/worktrees/open", `{"groupId":"wR","branch":"feat/x"}`},
		{"DELETE", "/api/mux/worktrees/w13", `{"force":false,"path":"/wt/feat-x","branch":"feat/x"}`},
	} {
		rec := serve(h, apiRequest(rt.method, rt.path, rt.body))
		if code := codeOf(t, rec); rec.Code != 503 || code != "busy" {
			t.Errorf("%s %s while a create ran: %d %q", rt.method, rt.path, rec.Code, code)
		}
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("busy answers took %s", d)
	}
	// A read does not wait for the slot.
	if rec := serve(h, apiRequest("GET", "/api/mux/worktrees?groupId=wR", "")); rec.Code != 200 {
		t.Errorf("list while a create ran: %d", rec.Code)
	}
	close(f.block)
	if rec := <-first; rec.Code != 200 {
		t.Errorf("first create = %d %s", rec.Code, rec.Body)
	}
	if calls := f.recorded(); len(calls) != 2 {
		t.Errorf("calls %q", calls)
	}
}

// A client that leaves does not cut the change short; one that runs past
// worktreeTimeout is answered unknown.
func TestWorktreeRoutesOutliveTheClient(t *testing.T) {
	shortWorktreeTimeouts(t, time.Second, 300*time.Millisecond)
	f := newWorktreeFake("/repo")
	f.block = make(chan struct{})
	h := newTestHandler(t, f)

	ctx, cancel := context.WithCancel(context.Background())
	req := apiRequest("POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a"}`).WithContext(ctx)
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- serve(h, req) }()
	waitUntil(t, "create", func() bool { return len(f.recorded()) == 1 })
	cancel()
	time.Sleep(50 * time.Millisecond)
	close(f.block)
	if rec := <-done; rec.Code != 200 {
		t.Errorf("create after the client left = %d %s", rec.Code, rec.Body)
	}
	f.mu.Lock()
	ok := slices.Clone(f.ctxOK)
	f.mu.Unlock()
	if len(ok) != 1 || !ok[0] {
		t.Errorf("the create's context ended with the client: %v", ok)
	}

	f.block = make(chan struct{}) // never closed: the deadline ends it
	t.Cleanup(func() { close(f.block) })
	for _, rt := range []struct{ method, path, body string }{
		{"POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a"}`},
		{"DELETE", "/api/mux/worktrees/w13", `{"force":false,"path":"/wt/feat-x","branch":"feat/x"}`},
	} {
		rec := serve(h, apiRequest(rt.method, rt.path, rt.body))
		if code := codeOf(t, rec); rec.Code != 504 || code != "unknown" {
			t.Errorf("%s past the deadline = %d %q", rt.method, rec.Code, code)
		}
	}
}

// Every Herdr error code a worktree call can give, as the client sees it.
func TestHerdrWorktreeErrors(t *testing.T) {
	for _, c := range []struct {
		herdr, message string
		status         int
		code           string
	}{
		{"workspace_not_found", "", 404, "unknown_group"},
		{"worktree_not_found", "", 404, "not_found"},
		{"not_git_worktree", "", 409, "not_git"},
		{"linked_worktree_source", "", 409, "linked_source"},
		{"not_linked_worktree", "", 409, "not_linked"},
		{"ambiguous_worktree_branch", "", 409, "ambiguous"},
		{"worktree_create_failed", "fatal: '/home/u/x' already exists", 409, "create_failed"},
		{"worktree_open_failed", "", 409, "open_failed"},
		{"dirty_worktree_requires_force", "fatal: '/home/u/x' contains modified or untracked files", 409, "dirty"},
		{"worktree_operation_in_progress", "", 503, "busy"},
		{"stale_worktree_operation", "", 503, "busy"},
		{"worktree_busy", "", 503, "busy"},
		{"invalid_request", "invalid request: unknown variant `worktree.create`, expected one of", 501, "unsupported"},
		{"unknown_method", "", 501, "unsupported"},
		{"invalid_request", "branch is required", 500, "worktree_failed"},
		{"worktree_list_failed", "fatal: detected dubious ownership in repository at '/home/u/x'", 500, "worktree_failed"},
		{"worktree_remove_failed", "fatal: '/home/u/x' is locked", 500, "worktree_failed"},
	} {
		rec := httptest.NewRecorder()
		worktreeFailure(rec, "test", herdrWorktreeError(&herdrError{Code: c.herdr, Message: c.message}))
		if code := codeOf(t, rec); rec.Code != c.status || code != c.code {
			t.Errorf("%s %q: %d %q, want %d %q", c.herdr, c.message, rec.Code, code, c.status, c.code)
		}
		if strings.Contains(rec.Body.String(), "/home/u") {
			t.Errorf("%s: Herdr's message sent: %s", c.herdr, rec.Body)
		}
	}
	for _, err := range []error{context.DeadlineExceeded, context.Canceled, errors.Join(errors.New("herdr worktree.remove"), context.DeadlineExceeded)} {
		rec := httptest.NewRecorder()
		worktreeFailure(rec, "test", err)
		if code := codeOf(t, rec); rec.Code != 504 || code != "unknown" {
			t.Errorf("%v: %d %q", err, rec.Code, code)
		}
	}
}

func TestHerdrCanWorktrees(t *testing.T) {
	for _, c := range []struct {
		v, goos string
		want    bool
	}{
		{"", "linux", false},
		{"unknown", "linux", false},
		{"0.9.1", "linux", false},
		{"0.9.2", "linux", true},
		{"0.9.3", "darwin", true},
		{"0.10.0", "linux", true},
		{"0.9.3", "windows", false},
	} {
		if got := herdrCanWorktrees(c.v, c.goos); got != c.want {
			t.Errorf("herdrCanWorktrees(%q, %q) = %v", c.v, c.goos, got)
		}
	}
}

// withWorktrees marks wR as a repository's own checkout and w13 as its
// linked worktree, and adds a plain workspace w14.
func withWorktrees(f *fakeHerdr) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.version = "0.9.3"
	wss := f.snapshot["workspaces"].([]any)
	for _, w := range wss {
		ws := w.(map[string]any)
		linked := ws["workspace_id"] == "w13"
		ws["worktree"] = map[string]any{"repo_key": "/repo/gitdir", "repo_name": "repo", "repo_root": "/repo",
			"checkout_path": map[bool]string{true: "/wt/feat-x", false: "/repo"}[linked], "is_linked_worktree": linked}
	}
	f.snapshot["workspaces"] = append(wss, map[string]any{"workspace_id": "w14", "number": 9, "label": "plain",
		"focused": false, "pane_count": 0, "tab_count": 0, "active_tab_id": ""})
}

func newWorktreeHerdr(t *testing.T) (*fakeHerdr, *herdrMux) {
	t.Helper()
	orig := herdrStartGOOS
	herdrStartGOOS = "linux"
	t.Cleanup(func() { herdrStartGOOS = orig })
	f := newFakeHerdr(t)
	withWorktrees(f)
	m := newTestHerdrMux(t, f)
	m.branches.mu.Lock()
	m.branches.done = make(chan struct{}, 16)
	m.branches.mu.Unlock()
	return f, m
}

func groupWorktree(t *testing.T, s Snapshot, id string) *GroupWorktree {
	t.Helper()
	for _, g := range s.Groups {
		if g.ID == id {
			return g.Worktree
		}
	}
	t.Fatalf("no group %s", id)
	return nil
}

func waitBranchRefresh(t *testing.T, m *herdrMux) {
	t.Helper()
	select {
	case <-m.branches.done:
	case <-time.After(5 * time.Second):
		t.Fatal("no branch refresh")
	}
}

func TestHerdrWorktreeCalls(t *testing.T) {
	f, m := newWorktreeHerdr(t)
	ctx := context.Background()
	if !m.Caps().Worktrees {
		t.Fatal("Caps().Worktrees = false on 0.9.3")
	}

	list := fakeWorktreeList()
	list["worktrees"] = append(list["worktrees"].([]any),
		map[string]any{"path": "/wt/spoof", "branch": "a‮b", "is_bare": false, "is_detached": false,
			"is_prunable": false, "is_linked_worktree": true, "label": "repo"},
		map[string]any{"path": "/wt/gone", "branch": "old", "is_bare": false, "is_detached": false,
			"is_prunable": true, "is_linked_worktree": true, "label": "repo"})
	f.mu.Lock()
	f.wtList = list
	f.mu.Unlock()
	l, err := m.ListWorktrees(ctx, "wR")
	if err != nil || l.RepoRoot != "/repo" || l.RepoName != "repo" || len(l.Worktrees) != 4 {
		t.Fatalf("ListWorktrees = %+v, %v", l, err)
	}
	want := []Worktree{
		{Path: "/repo", Branch: "main", GroupID: "wR"},
		{Path: "/wt/feat-x", Branch: "feat/x", Linked: true, Openable: true, GroupID: "w13"},
		{Path: "/wt/spoof", Linked: true},
		{Path: "/wt/gone", Branch: "old", Linked: true},
	}
	if !slices.Equal(l.Worktrees, want) {
		t.Errorf("worktrees = %+v", l.Worktrees)
	}

	if id, err := m.CreateWorktree(ctx, "wR", "feat/new", "", ""); err != nil || id != "wWT" {
		t.Fatalf("CreateWorktree = %q, %v", id, err)
	}
	p := f.lastParams(t, "worktree.create")
	if len(p) != 3 || p["workspace_id"] != "wR" || p["branch"] != "feat/new" || p["focus"] != false {
		t.Errorf("create params = %v", p)
	}
	m.CreateWorktree(ctx, "wR", "feat/new", "main", "New")
	if p := f.lastParams(t, "worktree.create"); p["base"] != "main" || p["label"] != "New" || len(p) != 5 {
		t.Errorf("create params with base and label = %v", p)
	}
	if id, already, err := m.OpenWorktree(ctx, "wR", "feat/x"); err != nil || id != "wWT" || !already {
		t.Errorf("OpenWorktree = %q %v %v", id, already, err)
	}
	if p := f.lastParams(t, "worktree.open"); len(p) != 3 || p["branch"] != "feat/x" || p["focus"] != false {
		t.Errorf("open params = %v", p)
	}
	m.RemoveWorktree(ctx, "w13", false)
	if p := f.lastParams(t, "worktree.remove"); len(p) != 1 || p["workspace_id"] != "w13" {
		t.Errorf("remove params = %v", p)
	}
	m.RemoveWorktree(ctx, "w13", true)
	if p := f.lastParams(t, "worktree.remove"); len(p) != 2 || p["force"] != true {
		t.Errorf("forced remove params = %v", p)
	}
	for _, method := range []string{"worktree.create", "worktree.open", "worktree.remove"} {
		f.mu.Lock()
		raw := f.params[method]
		f.mu.Unlock()
		for _, r := range raw {
			for _, k := range []string{"trust_repository", "path", "cwd", "close_group"} {
				if strings.Contains(string(r), `"`+k+`"`) {
					t.Errorf("%s sent %s: %s", method, k, r)
				}
			}
		}
	}

	// An unknown workspace never reaches Herdr.
	before := f.count("worktree.create")
	if _, err := m.CreateWorktree(ctx, "w99", "a", "", ""); !errors.Is(err, errUnknownGroup) {
		t.Errorf("unknown workspace = %v", err)
	}
	if f.count("worktree.create") != before {
		t.Error("worktree.create sent for an unknown workspace")
	}

	// End to end: Herdr refuses a dirty worktree, the client gets 409 dirty.
	h := newTestHandler(t, m)
	f.mu.Lock()
	f.wtList = nil
	f.wtFail = map[string]string{"worktree.remove": "dirty_worktree_requires_force"}
	f.wtMessage = "fatal: '/wt/feat-x' contains modified or untracked files, use --force to delete it"
	f.mu.Unlock()
	rec := serve(h, apiRequest("DELETE", "/api/mux/worktrees/w13", `{"force":false,"path":"/wt/feat-x","branch":"feat/x"}`))
	if code := codeOf(t, rec); rec.Code != 409 || code != "dirty" || strings.Contains(rec.Body.String(), "/wt/") {
		t.Errorf("dirty remove = %d %s", rec.Code, rec.Body)
	}
}

// The branch is read in the background: a snapshot never waits for it, and
// the next one carries it.
func TestHerdrSnapshotWorktreeBranch(t *testing.T) {
	f, m := newWorktreeHerdr(t)
	ctx := context.Background()
	s, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if w := groupWorktree(t, s, "w13"); w == nil || !w.Linked {
		t.Errorf("w13 worktree = %+v", w)
	}
	if w := groupWorktree(t, s, "wR"); w == nil || w.Linked {
		t.Errorf("wR worktree = %+v", w)
	}
	if w := groupWorktree(t, s, "w14"); w != nil {
		t.Errorf("plain workspace worktree = %+v", w)
	}
	waitBranchRefresh(t, m)
	s, _ = m.Snapshot(ctx)
	if w := groupWorktree(t, s, "w13"); w == nil || w.Branch != "feat/x" {
		t.Errorf("w13 after refresh = %+v", w)
	}
	if w := groupWorktree(t, s, "wR"); w == nil || w.Branch != "main" {
		t.Errorf("wR after refresh = %+v", w)
	}
	// The copy is the snapshot's own: changing it changes no later one.
	groupWorktree(t, s, "w13").Branch = "mutated"
	if s2, _ := m.Snapshot(ctx); groupWorktree(t, s2, "w13").Branch != "feat/x" {
		t.Error("a snapshot's worktree is shared with the cache")
	}
	lists := f.count("worktree.list")
	if lists != 1 {
		t.Errorf("worktree.list calls = %d, want 1 (fresh for %s)", lists, herdrBranchFresh)
	}

	// peekSnapshot keeps Linked, carries no branch and lists nothing.
	m.branches.drop()
	p, err := m.peekSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if w := groupWorktree(t, p, "w13"); w == nil || !w.Linked || w.Branch != "" {
		t.Errorf("peek w13 = %+v", w)
	}
	time.Sleep(50 * time.Millisecond)
	if f.count("worktree.list") != lists {
		t.Error("peekSnapshot called worktree.list")
	}

	// A worktree event makes the branches stale; the next snapshot reads
	// them again (and still serves the old ones meanwhile).
	m.branches.mu.Lock()
	for _, r := range m.branches.repos {
		r.fetched = time.Now()
	}
	m.branches.mu.Unlock()
	f.emit("worktree_removed", map[string]any{"workspace_id": "w15", "worktree": map[string]any{"path": "/wt/y"}, "forced": false})
	waitUntil(t, "stale branches", func() bool {
		m.branches.mu.Lock()
		defer m.branches.mu.Unlock()
		return m.branches.repos["/repo/gitdir"].fetched.IsZero()
	})
	s, _ = m.Snapshot(ctx)
	if groupWorktree(t, s, "w13").Branch != "feat/x" {
		t.Error("stale branch not served while refreshing")
	}
	waitBranchRefresh(t, m)
	if f.count("worktree.list") != lists+1 {
		t.Errorf("worktree.list calls after the event = %d", f.count("worktree.list"))
	}
}

// A slow worktree.list never slows a snapshot, and a busy Herdr is left
// alone for a while.
func TestHerdrSnapshotSlowWorktreeList(t *testing.T) {
	f, m := newWorktreeHerdr(t)
	f.mu.Lock()
	f.wtDelay = 3 * time.Second
	f.mu.Unlock()
	for range 3 {
		start := time.Now()
		if _, err := m.Snapshot(context.Background()); err != nil {
			t.Fatal(err)
		}
		if d := time.Since(start); d > 200*time.Millisecond {
			t.Errorf("snapshot took %s with a slow worktree.list", d)
		}
	}
	waitBranchRefresh(t, m)
	if n := f.count("worktree.list"); n != 1 {
		t.Errorf("worktree.list calls = %d, want one refresh at a time", n)
	}

	f.mu.Lock()
	f.wtDelay = 0
	f.wtFail = map[string]string{"worktree.list": "worktree_busy"}
	f.mu.Unlock()
	m.branches.drop()
	m.Snapshot(context.Background())
	waitBranchRefresh(t, m)
	m.branches.drop()
	m.Snapshot(context.Background())
	time.Sleep(50 * time.Millisecond)
	if n := f.count("worktree.list"); n != 2 {
		t.Errorf("worktree.list calls after busy = %d, want 2 (then off)", n)
	}
}

// The worktree event types are subscribed only where worktrees are offered:
// an older Herdr would refuse the whole subscription.
func TestHerdrWorktreeSubscription(t *testing.T) {
	f := newFakeHerdr(t) // 0.9.1
	newTestHerdrMux(t, f)
	if types := f.subscribedTypes(); slices.Contains(types, "worktree.created") {
		t.Errorf("0.9.1 subscribed %v", types)
	}
	f, _ = newWorktreeHerdr(t)
	types := f.subscribedTypes()
	for _, want := range herdrWorktreeEventTypes {
		if !slices.Contains(types, want) {
			t.Errorf("0.9.3 subscription lacks %s: %v", want, types)
		}
	}
}

// Snapshots, pane checks and branch refreshes run together without a race.
func TestHerdrWorktreeConcurrent(t *testing.T) {
	_, m := newWorktreeHerdr(t)
	m.branches.mu.Lock()
	m.branches.done = nil
	m.branches.mu.Unlock()
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 20 {
				if i%2 == 0 {
					m.Snapshot(context.Background())
				} else {
					m.requirePane(context.Background(), "wR:p1V")
					m.branches.drop()
				}
			}
		}()
	}
	wg.Wait()
}

// A list that runs out of time comes before any change: busy, never
// unknown, and nothing is created or removed.
func TestWorktreeRoutesListTimeoutIsBusy(t *testing.T) {
	f := newWorktreeFake("/repo")
	f.err = context.DeadlineExceeded
	h := newTestHandler(t, f)
	for _, rt := range []struct{ method, path, body string }{
		{"GET", "/api/mux/worktrees?groupId=wR", ""},
		{"POST", "/api/mux/worktrees", `{"groupId":"wR","branch":"a","base":"main"}`},
		{"DELETE", "/api/mux/worktrees/w13", `{"force":false,"path":"/wt/feat-x","branch":"feat/x"}`},
	} {
		rec := serve(h, apiRequest(rt.method, rt.path, rt.body))
		if code := codeOf(t, rec); rec.Code != 503 || code != "busy" {
			t.Errorf("%s %s: %d %q", rt.method, rt.path, rec.Code, code)
		}
	}
	for _, c := range f.recorded() {
		if !strings.HasPrefix(c, "list ") {
			t.Errorf("change sent after a failed list: %q", c)
		}
	}
}
