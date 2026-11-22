//go:build !windows

package main

import (
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func shortWorktreeWaits(t *testing.T) {
	t.Helper()
	busy, settle, pane, every, startEvery := agentsWorktreeBusyMost, agentsWorktreeSettle, agentsWorktreePaneWait, agentsWorktreeEvery, agentsStartEvery
	agentsWorktreeBusyMost, agentsWorktreeSettle, agentsWorktreePaneWait, agentsWorktreeEvery, agentsStartEvery =
		200*time.Millisecond, 60*time.Millisecond, 60*time.Millisecond, 5*time.Millisecond, time.Millisecond
	t.Cleanup(func() {
		agentsWorktreeBusyMost, agentsWorktreeSettle, agentsWorktreePaneWait, agentsWorktreeEvery, agentsStartEvery = busy, settle, pane, every, startEvery
	})
}

// worktreeScript serves a repo workspace w and, once the worktree of feat is
// made, its workspace w2 with pane %7 in /wt/feat. The returned func makes
// it (as a create the server finished would).
type worktreeScript struct {
	mu      sync.Mutex
	made    bool
	cwd     string // the new pane's directory
	deletes int
}

func (ws *worktreeScript) make() {
	ws.mu.Lock()
	ws.made = true
	ws.mu.Unlock()
}

func newWorktreeScript(t *testing.T, s *scripted, caps Caps) *worktreeScript {
	t.Helper()
	ws := &worktreeScript{cwd: "/wt/feat"}
	s.set("GET /api/mux/snapshot", func(w http.ResponseWriter, r *http.Request) {
		snap := Snapshot{Backend: "tmux", Caps: caps, Groups: []Group{{ID: "w", Name: "repo", Tabs: []Tab{
			{ID: "w:0", Name: "sh", Panes: []Pane{{ID: "%1", Process: &ProcessInfo{Cwd: "/src/repo"}}}}}}}}
		ws.mu.Lock()
		if ws.made {
			snap.Groups = append(snap.Groups, Group{ID: "w2", Name: "repo-feat", Tabs: []Tab{
				{ID: "w2:0", Name: "sh", Panes: []Pane{{ID: "%7", Process: &ProcessInfo{Cwd: ws.cwd}}}}}})
		}
		ws.mu.Unlock()
		jsonAnswer(snap)(w, r)
	})
	s.set("GET /api/mux/worktrees", func(w http.ResponseWriter, r *http.Request) {
		l := worktreeListing{RepoName: "repo", Worktrees: []Worktree{{Path: "/src/repo", Branch: "main"}}, Branches: []string{"main", "old"}}
		ws.mu.Lock()
		if ws.made {
			l.Worktrees = append(l.Worktrees, Worktree{Path: "/wt/feat", Branch: "feat", Linked: true, Openable: true, GroupID: "w2"})
			l.Branches = append(l.Branches, "feat")
		}
		ws.mu.Unlock()
		jsonAnswer(l)(w, r)
	})
	s.set("DELETE /api/mux/tabs/w2:0", func(w http.ResponseWriter, r *http.Request) {
		ws.mu.Lock()
		ws.deletes++
		ws.mu.Unlock()
	})
	s.set("POST /api/mux/panes/%7/agent/start", answer(http.StatusOK, `{"ok":true,"state":"starting","prompt":true}`))
	s.set("GET /api/mux/panes/%7/agent/start", jsonAnswer(map[string]string{"state": startReady}))
	return ws
}

var worktreeCaps = Caps{AgentStart: true, AgentStartCodex: true, Worktrees: true}

func countPosts(s *scripted, prefix string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, p := range s.posts {
		if strings.HasPrefix(p, prefix) {
			n++
		}
	}
	return n
}

func TestAgentsStartWorktree(t *testing.T) {
	shortWorktreeWaits(t)
	tc, s := scriptedCLI(t)
	ws := newWorktreeScript(t, s, worktreeCaps)
	start := func(args ...string) error {
		tc.stdout.Reset()
		return tc.dispatch("agents", append([]string{"start", "--workspace", "repo", "--kind", "claude"}, args...))
	}
	if err := start("--base", "main", "go"); exitCode(err) != 2 {
		t.Errorf("--base alone: %v", err)
	}
	// Busy once, then made.
	creates := 0
	s.set("POST /api/mux/worktrees", func(w http.ResponseWriter, r *http.Request) {
		if creates++; creates == 1 {
			answer(http.StatusServiceUnavailable, `{"error":"busy","code":"busy"}`)(w, r)
			return
		}
		ws.make()
		answer(http.StatusOK, `{"ok":true,"id":"w2"}`)(w, r)
	})
	if err := start("--worktree", "feat", "--base", "main", "--name", "feat-agent", "fix it"); err != nil {
		t.Fatalf("%v (%s)", err, tc.stdout)
	}
	if out := tc.stdout.String(); !strings.Contains(out, "Started claude in pane %7 (workspace repo-feat, branch feat, in /wt/feat) with the prompt") {
		t.Errorf("out: %s", out)
	}
	s.mu.Lock()
	posts := strings.Join(s.posts, "\n")
	s.mu.Unlock()
	if !strings.Contains(posts, `/api/mux/worktrees {"base":"main","branch":"feat","groupId":"w","label":"feat-agent"}`) ||
		!strings.Contains(posts, `/api/mux/panes/%7/agent/start {"kind":"claude","newTab":true,"prompt":"fix it"}`) || strings.Contains(posts, "/api/mux/tabs") {
		t.Errorf("posts:\n%s", posts)
	}
	// Run again: the worktree is there, so it is opened, not made again.
	s.set("POST /api/mux/worktrees/open", answer(http.StatusOK, `{"ok":true,"id":"w2","alreadyOpen":true}`))
	if err := start("--worktree", "feat", "again"); err != nil || countPosts(s, "/api/mux/worktrees ") != 2 || countPosts(s, "/api/mux/worktrees/open") != 1 {
		t.Errorf("again: %v %s", err, tc.stdout)
	}
	// A refused start keeps the worktree and names it.
	s.set("POST /api/mux/panes/%7/agent/start", answer(http.StatusConflict, `{"error":"the pane runs something else","code":"pane_busy"}`))
	if err := start("--worktree", "feat"); err == nil || !strings.Contains(err.Error(), "(pane_busy)") ||
		!strings.Contains(err.Error(), "workspace w2, branch feat, in /wt/feat stays") || ws.deletes != 0 {
		t.Errorf("refused: %v, deletes %d", err, ws.deletes)
	}
	// The pane opened elsewhere: nothing started.
	ws.mu.Lock()
	ws.cwd = "/home/u"
	ws.mu.Unlock()
	if err := start("--worktree", "feat"); err == nil || !strings.Contains(err.Error(), "opened in /home/u, not in /wt/feat") || !strings.Contains(err.Error(), "stays") {
		t.Errorf("elsewhere: %v", err)
	}
	// No directory in time.
	ws.mu.Lock()
	ws.cwd = ""
	ws.mu.Unlock()
	if err := start("--worktree", "feat"); err == nil || !strings.Contains(err.Error(), "did not show its pane and directory in time") {
		t.Errorf("no dir: %v", err)
	}
}

func TestAgentsStartWorktreeRefusals(t *testing.T) {
	shortWorktreeWaits(t)
	tc, s := scriptedCLI(t)
	start := func(kind, branch string) error {
		tc.stdout.Reset()
		return tc.dispatch("agents", []string{"start", "--workspace", "w", "--kind", kind, "--worktree", branch, "go"})
	}
	// Checked before anything is made.
	newWorktreeScript(t, s, Caps{AgentStart: true, Worktrees: true})
	if err := start("codex", "feat"); err == nil || !strings.Contains(err.Error(), "cannot start Codex") {
		t.Errorf("codex: %v", err)
	}
	newWorktreeScript(t, s, Caps{AgentStart: true, AgentStartCodex: true})
	if err := start("claude", "feat"); err == nil || !strings.Contains(err.Error(), "cannot make worktrees") {
		t.Errorf("no worktrees: %v", err)
	}
	newWorktreeScript(t, s, worktreeCaps)
	for branch, want := range map[string]string{"old": "already exists; pick a new name", "main": "is the main worktree's"} {
		if err := start("claude", branch); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", branch, err)
		}
	}
	if n := countPosts(s, "/api/mux/"); n != 0 {
		t.Errorf("made something: %v", s.posts)
	}
	// The server's refusals, worded.
	for code, want := range map[string]string{"linked_source": "from the main checkout's workspace", "invalid_name": "not a valid branch name",
		"open_failed": "open it from the PWA", "branch_exists": "pick a new branch name"} {
		s.set("POST /api/mux/worktrees", answer(http.StatusConflict, `{"error":"no","code":"`+code+`"}`))
		if err := start("claude", "feat"); err == nil || !strings.Contains(err.Error(), "("+code+")") || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", code, err)
		}
	}
	// Busy past the wait.
	s.set("POST /api/mux/worktrees", answer(http.StatusServiceUnavailable, `{"error":"busy","code":"busy"}`))
	if err := start("claude", "feat"); err == nil || !strings.Contains(err.Error(), "(busy)") {
		t.Errorf("busy: %v", err)
	}
	// Did not answer in time, and never shows up: nothing made again.
	s.set("POST /api/mux/worktrees", answer(http.StatusGatewayTimeout, `{"error":"later","code":"unknown"}`))
	before := countPosts(s, "/api/mux/worktrees ")
	if err := start("claude", "feat"); err == nil || !strings.Contains(err.Error(), "did not show up") || countPosts(s, "/api/mux/worktrees ") != before+1 {
		t.Errorf("unknown: %v", err)
	}
}

// A create the server could not wait for, or whose answer was lost, is
// followed in the list and goes on once the worktree shows.
func TestAgentsStartWorktreeSettles(t *testing.T) {
	shortWorktreeWaits(t)
	tc, s := scriptedCLI(t)
	ws := newWorktreeScript(t, s, worktreeCaps)
	s.set("POST /api/mux/worktrees", func(w http.ResponseWriter, r *http.Request) {
		go func() { time.Sleep(15 * time.Millisecond); ws.make() }()
		answer(http.StatusGatewayTimeout, `{"error":"later","code":"unknown"}`)(w, r)
	})
	if err := tc.dispatch("agents", []string{"start", "--workspace", "w", "--kind", "claude", "--worktree", "feat", "go"}); err != nil {
		t.Fatalf("unknown: %v", err)
	}
	ws.mu.Lock()
	ws.made = false
	ws.mu.Unlock()
	s.set("POST /api/mux/worktrees", func(w http.ResponseWriter, r *http.Request) {
		ws.make()
		hangUp(w, r)
	})
	if err := tc.dispatch("agents", []string{"start", "--workspace", "w", "--kind", "claude", "--worktree", "feat", "go"}); err != nil {
		t.Fatalf("hang up: %v", err)
	}
	if n := countPosts(s, "/api/mux/worktrees "); n != 2 {
		t.Errorf("creates %d", n)
	}
}
