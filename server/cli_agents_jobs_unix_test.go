//go:build !windows

package main

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// tsLine is an assistant line of the transcript written at ts.
func tsLine(i int, ts, text string) string {
	b, _ := json.Marshal(map[string]any{"type": "assistant", "uuid": fmt.Sprintf("t%d", i), "timestamp": ts,
		"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}}})
	return string(b) + "\n"
}

// jobsCLI runs the real server with its ledger over an agentsFake whose
// panes %1 (web/api, idle) and %2 (web/ui, working) run one Claude Code.
func jobsCLI(t *testing.T) (*testCLI, *agentsFake, string) {
	t.Helper()
	tc, f := agentsTest(t, tsLine(0, "2026-11-23T09:00:00.000Z", "hello"))
	path := filepath.Join(f.session.ClaudeDir, "projects", "-home-u-proj", testSessionID+".jsonl")
	every := agentsWaitEvery
	agentsWaitEvery = 20 * time.Millisecond
	t.Cleanup(func() { agentsWaitEvery = every })
	return tc, f, path
}

// settle waits out the server's agent and transcript caches.
func settle() { time.Sleep(agentCacheTTL + 50*time.Millisecond) }

func jobsOf(t *testing.T, tc *testCLI, args ...string) []jobView {
	t.Helper()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", append([]string{"jobs", "--json"}, args...)); err != nil {
		t.Fatalf("jobs: %v (%s)", err, tc.stderr)
	}
	var out struct {
		Jobs []jobView `json:"jobs"`
	}
	if err := json.Unmarshal(tc.stdout.Bytes(), &out); err != nil {
		t.Fatalf("%v: %s", err, tc.stdout)
	}
	return out.Jobs
}

func addJob(t *testing.T, tc *testCLI, args ...string) jobView {
	t.Helper()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", append([]string{"job", "add", "--json"}, args...)); err != nil {
		t.Fatalf("job add: %v (%s)", err, tc.stderr)
	}
	var j jobView
	if err := json.Unmarshal(tc.stdout.Bytes(), &j); err != nil {
		t.Fatalf("%v: %s", err, tc.stdout)
	}
	return j
}

func TestAgentsJobCommands(t *testing.T) {
	tc, _, _ := jobsCLI(t)
	j := addJob(t, tc, "--title", "Fix the parser\x1b[31m", "--pane", "web/api", "--note", "look at lexer.go")
	if j.Title != "Fix the parser[31m" || j.State != "active" || j.Agent == nil || j.Agent.PaneID != "%1" || j.Workspace != "$1" ||
		j.Note != "look at lexer.go" || j.CreatedBy != "cli" {
		t.Fatalf("job %+v", j)
	}
	todo := addJob(t, tc, "--title", "Write docs")
	if todo.State != "todo" || todo.Agent != nil {
		t.Errorf("todo %+v", todo)
	}
	// The table: filter named, each job's pane and what its agent does.
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"jobs"}); err != nil {
		t.Fatal(err)
	}
	out := tc.stdout.String()
	for _, want := range []string{"Jobs (unfinished jobs, of every creator): 2", "Fix the parser[31m", "web/api (%1)", "idle", "/src/web", "Write docs", "todo"} {
		if !strings.Contains(out, want) {
			t.Errorf("jobs lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "\x1b") {
		t.Errorf("control characters printed: %q", out)
	}
	// show: prompt, note, history.
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"job", "show", j.ID}); err != nil {
		t.Fatal(err)
	}
	if out := tc.stdout.String(); !strings.Contains(out, "Folder: /src/web, branch -") || !strings.Contains(out, "Agent: claude in web/api (%1): idle") || !strings.Contains(out, "look at lexer.go") ||
		!strings.Contains(out, "History:") {
		t.Errorf("show:\n%s", out)
	}
	if err := tc.dispatch("agents", []string{"job", "show", "nope"}); err == nil || !strings.Contains(err.Error(), "no job nope") {
		t.Errorf("unknown: %v", err)
	}
	// set: a finished job leaves the default list.
	tc.in = nil
	if err := tc.dispatch("agents", []string{"job", "set", todo.ID, "--state", "abandoned", "--title", "Docs later"}); err != nil {
		t.Fatal(err)
	}
	if got := jobsOf(t, tc); len(got) != 1 || got[0].ID != j.ID {
		t.Errorf("unfinished: %+v", got)
	}
	if got := jobsOf(t, tc, "--all"); len(got) != 2 || got[0].Title != "Docs later" {
		t.Errorf("all: %+v", got)
	}
	if got := jobsOf(t, tc, "--workspace", "orchestrator"); len(got) != 0 {
		t.Errorf("another workspace: %+v", got)
	}
	// --mine needs to know this pane: never an empty list in its place.
	if err := tc.dispatch("agents", []string{"jobs", "--mine"}); err == nil || !strings.Contains(err.Error(), "--mine needs to know this command's pane") {
		t.Errorf("mine: %v", err)
	}
	for _, args := range [][]string{{"job"}, {"job", "nope"}, {"job", "add"}, {"job", "set", j.ID}, {"job", "set", j.ID, "--state", "todo"},
		{"jobs", "x"}, {"job", "show"}} {
		if err := tc.dispatch("agents", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
	// Moving a job to another pane ends its grants, and says so.
	if err := tc.dispatch("agents", []string{"job", "set", j.ID, "--pane", "ui"}); err != nil {
		t.Fatal(err)
	}
	if got := jobsOf(t, tc); got[0].Agent.PaneID != "%2" {
		t.Errorf("moved: %+v", got[0].Agent)
	}
}

// Every agents command notes what it did on the job of its pane; the
// orchestrator's read marks the turn read, a turn that ended unread is
// reported by wait --job however long ago it ended.
func TestAgentsJobHooksAndWait(t *testing.T) {
	tc, f, path := jobsCLI(t)
	j := addJob(t, tc, "--title", "Parser", "--pane", "web/api")
	if err := tc.dispatch("agents", []string{"send", "%1", "fix the lexer please"}); err != nil {
		t.Fatalf("send: %v (%s)", err, tc.stderr)
	}
	// The turn ends before anyone waits for it.
	appendFile(t, path, tsLine(1, "2026-11-23T09:05:00.000Z", "Fixed."))
	settle()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "2s"}); err != nil {
		t.Fatalf("wait: %v (%s)", err, tc.stdout)
	}
	if out := tc.stdout.String(); !strings.Contains(out, "Job "+j.ID+" (Parser): web/api (%1) ended a turn; read it: termote agents read %1") {
		t.Errorf("wait out: %s", out)
	}
	// Read: then nothing is left to report.
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"read", "%1"}); err != nil {
		t.Fatal(err)
	}
	// Read and idle: nothing to wait for, said as such at the timeout (here
	// shorter than the grace), never "still working".
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "200ms"}); exitCode(err) != agentsExitIdle ||
		!strings.Contains(tc.stdout.String(), "Nothing to wait for") ||
		!strings.Contains(tc.stdout.String(), "Job "+j.ID+" (Parser): web/api (%1) is idle and its last turn was read") ||
		strings.Contains(tc.stdout.String(), "Still working") {
		t.Errorf("after read: exit %d %s", exitCode(err), tc.stdout)
	}
	// Within a longer timeout, it ends after the grace rather than at it.
	grace := agentsWaitGrace
	agentsWaitGrace = 100 * time.Millisecond
	start := time.Now()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "30s"}); exitCode(err) != agentsExitIdle || time.Since(start) > 10*time.Second {
		t.Errorf("after the grace: exit %d after %v", exitCode(err), time.Since(start))
	}
	agentsWaitGrace = grace
	// A job whose agent works is still waited for: the timeout says so.
	busy := addJob(t, tc, "--title", "Busy", "--pane", "ui")
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", busy.ID, j.ID, "--timeout", "200ms"}); exitCode(err) != agentsExitTimeout ||
		!strings.Contains(tc.stdout.String(), "Still waiting after 200ms:") ||
		!strings.Contains(tc.stdout.String(), "Job "+busy.ID+" (Busy): web/ui (%2) is working") ||
		!strings.Contains(tc.stdout.String(), "Job "+j.ID+" (Parser): web/api (%1) is idle and its last turn was read") ||
		!strings.Contains(tc.stdout.String(), "wait again: termote agents wait --job "+busy.ID+" "+j.ID) {
		t.Errorf("working: exit %d %s", exitCode(err), tc.stdout)
	}
	tc.dispatch("agents", []string{"job", "set", busy.ID, "--state", "abandoned"})
	// A turn that ends between two polls is reported too.
	go func() {
		time.Sleep(100 * time.Millisecond)
		appendFile(t, path, tsLine(2, "2026-11-23T09:06:00.000Z", "More."))
	}()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "5s"}); err != nil || !strings.Contains(tc.stdout.String(), "ended a turn") {
		t.Errorf("between polls: %v %s", err, tc.stdout)
	}
	tc.dispatch("agents", []string{"read", "%1"})
	// A turn that ends on a question for the user says so, in wait --job
	// and in read; the exit status stays 0.
	appendFile(t, path, tsLine(3, "2026-11-23T09:07:00.000Z", "Fixed. Should I also update the docs?"))
	settle()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "2s"}); err != nil ||
		!strings.Contains(tc.stdout.String(), "Job "+j.ID+" (Parser): web/api (%1) ended a turn with a question for the user; read it: termote agents read %1") {
		t.Errorf("question: %v %s", err, tc.stdout)
	}
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"read", "%1"}); err != nil || !strings.Contains(tc.stdout.String(), "[it ends with a question for the user") {
		t.Errorf("read question: %v %s", err, tc.stdout)
	}

	// A dialog the user keeps open is reported once; the other jobs are
	// still waited for.
	other := addJob(t, tc, "--title", "UI", "--pane", "ui")
	f.setStatus("%1", "blocked")
	f.setScreen(fixtureScreen(t, "2.1.286-permission-bash"))
	settle()
	tc.stdout.Reset()
	err := tc.dispatch("agents", []string{"wait", "--job", j.ID, other.ID, "--timeout", "2s"})
	if exitCode(err) != agentsExitDialog || !strings.Contains(tc.stdout.String(), "waits on a dialog; see it: termote agents answer %1") ||
		!strings.Contains(tc.stdout.String(), "next: termote agents wait --job "+other.ID) {
		t.Errorf("dialog: exit %d %s", exitCode(err), tc.stdout)
	}
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "300ms"}); exitCode(err) != agentsExitTimeout ||
		!strings.Contains(tc.stdout.String(), "still waits on the dialog reported before; see it: termote agents answer %1") {
		t.Errorf("same dialog again: exit %d %s", exitCode(err), tc.stdout)
	}
	// Blocked with no dialog the server can read (Claude Code after a
	// refused tool): reported once too.
	f.setScreen(boxScreen(""))
	settle()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "2s"}); exitCode(err) != agentsExitDialog {
		t.Errorf("blocked, no dialog: exit %d %s", exitCode(err), tc.stdout)
	}
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "300ms"}); exitCode(err) != agentsExitTimeout {
		t.Errorf("blocked, no dialog, again: exit %d", exitCode(err))
	}
	// Its agent gone (tmux restarted, %1 reused by another process).
	f.setStatus("%1", "idle")
	f.mu.Lock()
	f.session.PID = 4242
	f.mu.Unlock()
	settle()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "2s"}); exitCode(err) != agentsExitGone ||
		!strings.Contains(tc.stdout.String(), "its agent no longer runs in") {
		t.Errorf("gone: exit %d %s", exitCode(err), tc.stdout)
	}
	// A finished job: nothing to wait for, said at once.
	tc.dispatch("agents", []string{"job", "set", j.ID, "--state", "done"})
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "2s"}); err != nil || !strings.Contains(tc.stdout.String(), "is done: nothing to wait for") {
		t.Errorf("finished: %v %s", err, tc.stdout)
	}
	if err := tc.dispatch("agents", []string{"wait", "--job", "nope"}); err == nil || !strings.Contains(err.Error(), "no job nope") {
		t.Errorf("unknown job: %v", err)
	}
	todo := addJob(t, tc, "--title", "later")
	if err := tc.dispatch("agents", []string{"wait", "--job", todo.ID}); err == nil || !strings.Contains(err.Error(), "has no agent") {
		t.Errorf("no agent: %v", err)
	}
	// The history has what each command did.
	tc.stdout.Reset()
	tc.dispatch("agents", []string{"job", "show", j.ID})
	for _, want := range []string{"sent fix the lexer please", "read"} {
		if !strings.Contains(tc.stdout.String(), want) {
			t.Errorf("history lacks %q:\n%s", want, tc.stdout)
		}
	}
}

// The ledger outlives the server: a new one over the same state dir lists
// the same jobs, and reads what their agents do from the panes again.
func TestAgentsJobsSurviveRestart(t *testing.T) {
	tc, dir := socketCLI(t)
	f := newAgentsFake(t, tsLine(0, "2026-11-23T09:00:00.000Z", "hello"))
	startAgentsServer(t, tc, dir, f)
	j := addJob(t, tc, "--title", "Parser", "--pane", "web/api")
	if _, err := os.Stat(filepath.Join(dir, "jobs", jobsFile)); err != nil {
		t.Fatal(err)
	}
	startAgentsServer(t, tc, dir, f)
	got := jobsOf(t, tc)
	if len(got) != 1 || got[0].ID != j.ID || got[0].Live.Status != "idle" {
		t.Fatalf("after restart: %+v", got)
	}
}

// start records a job: its title is never the prompt; --job takes up the
// user's todo job with its prompt.
func TestAgentsStartRecordsJob(t *testing.T) {
	tc, f := agentsTest(t, "")
	f.promptDir = useStartPromptDir(t, "start-prompts")
	every := agentsStartEvery
	agentsStartEvery = 10 * time.Millisecond
	t.Cleanup(func() { agentsStartEvery = every })
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "claude", "secret plan"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	started := tc.stdout.String()
	got := jobsOf(t, tc)
	if len(got) != 1 || got[0].Title != "claude in web" || got[0].Prompt != "secret plan" || got[0].Agent == nil || got[0].Agent.PaneID != "%t2" {
		t.Fatalf("job %+v (%s)", got, tc.stderr)
	}
	if !strings.Contains(started, "wait for it: termote agents wait --job "+got[0].ID) {
		t.Errorf("out %s", started)
	}
	todo := addJob(t, tc, "--title", "From the phone")
	// Its prompt, set in the PWA, is the start's.
	setJobPrompt(t, tc, todo.ID, "prompt from the phone")
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "claude", "--job", todo.ID}); err != nil {
		t.Fatalf("--job: %v (%s)", err, tc.stderr)
	}
	if f.promptText[len(f.promptText)-1] != "prompt from the phone" {
		t.Errorf("prompt %q", f.promptText)
	}
	for _, j := range jobsOf(t, tc) {
		if j.ID == todo.ID && (j.State != "active" || j.Agent == nil) {
			t.Errorf("taken up: %+v", j)
		}
	}
	// Only a todo job is taken up.
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "claude", "--job", todo.ID}); err == nil || !strings.Contains(err.Error(), "not a job waiting for an agent") {
		t.Errorf("again: %v", err)
	}
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "claude", "--title", "x", "--job", todo.ID}); exitCode(err) != 2 {
		t.Errorf("--title with --job: %v", err)
	}
	if err := tc.dispatch("agents", []string{"start", "--workspace", "web", "--kind", "claude", "--title", " "}); exitCode(err) != 2 {
		t.Errorf("blank title: %v", err)
	}
}

// setJobPrompt sets a job's prompt, as the PWA's edit does.
func setJobPrompt(t *testing.T, tc *testCLI, id, prompt string) {
	t.Helper()
	port, err := tc.agentsPort()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tc.jobWrite(port, "PATCH", "/api/mux/jobs/"+id, map[string]any{"prompt": prompt}, 200); err != nil {
		t.Fatal(err)
	}
}

func TestAgentsAnswerDelegated(t *testing.T) {
	tc, s := scriptedCLI(t)
	s.set("GET /api/mux/snapshot", jsonAnswer(oneAgent("blocked")))
	s.set("GET /api/mux/panes/%1/agent/prompt", jsonAnswer(promptResponse{Prompt: &AgentPrompt{PromptID: "p1", Kind: "permission", Title: "Bash command",
		Body: "pnpm test --run", Options: []PromptOption{{Index: 1, Label: "Yes"}, {Index: 2, Label: "No"}}}}))
	for _, args := range [][]string{{"answer", "%1", "1", "--delegated"}, {"answer", "%1", "--text", "x", "--delegated"}} {
		if err := tc.dispatch("agents", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
	s.set("POST /api/mux/panes/%1/agent/answer", answer(http.StatusNoContent, ""))
	if err := tc.dispatch("agents", []string{"answer", "%1", "--delegated"}); err != nil ||
		!strings.Contains(tc.stdout.String(), "under the user's grant: Yes, this once") {
		t.Errorf("delegated: %v %s", err, tc.stdout)
	}
	if last := lastPost(s, "/api/mux/panes/%1/agent/answer"); !strings.Contains(last, `{"delegated":true,"promptId":"p1"}`) {
		t.Errorf("post %s", last)
	}
	s.set("POST /api/mux/panes/%1/agent/answer", answer(http.StatusConflict, `{"error":"no","code":"delegation_out_of_scope","reason":"chars"}`))
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"answer", "%1", "--delegated"}); exitCode(err) != agentsExitNotDelegated ||
		!strings.Contains(tc.stdout.String(), "No grant of the user covers this dialog (chars); nothing was answered: ask the user") {
		t.Errorf("refused: exit %d %s", exitCode(err), tc.stdout)
	}
	// An option that stops the dialog asking: refused by the server, named.
	s.set("POST /api/mux/panes/%1/agent/answer", answer(http.StatusForbidden, `{"error":"no","code":"answer_always_refused"}`))
	if err := tc.dispatch("agents", []string{"answer", "%1", "2"}); err == nil || !strings.Contains(err.Error(), "only the user picks an option that stops it asking") {
		t.Errorf("always: %v", err)
	}
}

// The server may see a new agent seconds after start does (Herdr reports a
// new Claude Code session late): start tries the job again until it does,
// and past the wait still writes the job, without the agent, saying how to
// give it the pane.
func TestAgentsStartJobAgentLate(t *testing.T) {
	tc, f := agentsTest(t, "")
	f.promptDir = useStartPromptDir(t, "start-prompts")
	every, wait, startEvery := agentsJobAgentEvery, agentsJobAgentWait, agentsStartEvery
	agentsJobAgentEvery, agentsJobAgentWait, agentsStartEvery = 50*time.Millisecond, 5*time.Second, 10*time.Millisecond
	t.Cleanup(func() { agentsJobAgentEvery, agentsJobAgentWait, agentsStartEvery = every, wait, startEvery })
	setShellStartProc(t, "claude")
	hide := func() {
		f.mu.Lock()
		f.found = false
		f.mu.Unlock()
	}
	showLater := func() {
		go func() {
			time.Sleep(agentCacheTTL + 200*time.Millisecond)
			f.mu.Lock()
			f.found = true
			f.mu.Unlock()
		}()
	}
	start := func(args ...string) string {
		t.Helper()
		tc.stdout.Reset()
		tc.stderr.Reset()
		if err := tc.dispatch("agents", append([]string{"start", "--workspace", "web", "--kind", "claude"}, args...)); err != nil {
			t.Fatalf("%v (%s)", err, tc.stderr)
		}
		return tc.stdout.String() + tc.stderr.String()
	}
	byTitle := func(title string) jobView {
		t.Helper()
		for _, j := range jobsOf(t, tc, "--all") {
			if j.Title == title {
				return j
			}
		}
		t.Fatalf("no job %q", title)
		return jobView{}
	}

	// --title: the agent shows late, the job gets it.
	hide()
	showLater()
	out := start("--title", "Late title", "go")
	if j := byTitle("Late title"); j.Agent == nil || j.State != "active" || !strings.Contains(out, "wait for it: termote agents wait --job "+j.ID) {
		t.Errorf("late, --title: %+v\n%s", j, out)
	}
	// --job: the same.
	todo := addJob(t, tc, "--title", "Late todo")
	hide()
	showLater()
	start("--job", todo.ID, "go")
	if j := byTitle("Late todo"); j.Agent == nil || j.State != "active" {
		t.Errorf("late, --job: %+v", j)
	}

	// Never seen in time: the job is written all the same, without the
	// agent, and the way to give it the pane is printed.
	agentsJobAgentWait = 200 * time.Millisecond
	hide()
	out = start("--title", "Never seen", "go")
	if j := byTitle("Never seen"); j.Agent != nil || j.State != "todo" || j.Prompt != "go" ||
		!strings.Contains(out, "termote agents job set "+j.ID+" --pane %t") || strings.Contains(out, "was not updated") {
		t.Errorf("never, --title: %+v\n%s", j, out)
	}
	todo = addJob(t, tc, "--title", "Never todo")
	out = start("--job", todo.ID, "go")
	if j := byTitle("Never todo"); j.Agent != nil || j.State != "todo" || !strings.Contains(out, "termote agents job set "+j.ID+" --pane") {
		t.Errorf("never, --job: %+v\n%s", j, out)
	}
}

// jobs and job show give a job's worktree as its branch and folder only
// while its agent's pane is in it; given a pane elsewhere, the pane's.
func TestAgentsJobsWorktreeElsewhere(t *testing.T) {
	tc, s := scriptedCLI(t)
	s.set("GET /api/mux/snapshot", jsonAnswer(oneAgent("idle")))
	tree := &jobTree{Branch: "job-ledger-case", Base: "main", Dir: "/home/u/.herdr/worktrees/termote/job-ledger-case"}
	listing := func(outside bool, dir, branch string) {
		j := job{ID: "j1", Title: "Case worktree", State: "active", Worktree: tree, Agent: &jobAgent{PaneID: "%1", Kind: "claude"}}
		s.set("GET /api/mux/jobs", jsonAnswer(map[string]any{"jobs": []jobView{{j, jobLive{Status: "idle", PaneID: "%1", Ref: "w/api",
			Dir: dir, Branch: branch, OutsideWorktree: outside}}}}))
	}
	run := func(args ...string) string {
		t.Helper()
		tc.stdout.Reset()
		if err := tc.dispatch("agents", args); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		return tc.stdout.String()
	}
	listing(false, tree.Dir, "job-ledger-case")
	if out := run("jobs"); !strings.Contains(out, "job-ledger-case") || !strings.Contains(out, tree.Dir) {
		t.Errorf("in the worktree:\n%s", out)
	}
	listing(true, "/src/termote", "main")
	if out := run("jobs"); strings.Contains(out, "job-ledger-case") || !strings.Contains(out, "main") || !strings.Contains(out, "/src/termote") {
		t.Errorf("elsewhere:\n%s", out)
	}
	if out := run("job", "show", "j1"); !strings.Contains(out, "Folder: /src/termote, branch main") ||
		!strings.Contains(out, "Worktree: branch job-ledger-case (base main) in "+tree.Dir+"; its agent now works in another folder") {
		t.Errorf("show elsewhere:\n%s", out)
	}
}

// A wrong job command says what is wrong and prints its own usage, never
// every agents command's; each usage is the line agentsUsage has.
func TestAgentsJobUsage(t *testing.T) {
	for _, u := range []string{jobsUsage, jobAddUsage, jobShowUsage, jobSetUsage, waitJobUsage} {
		if !strings.Contains(agentsUsage, strings.TrimPrefix(u, "usage: ")) {
			t.Errorf("agentsUsage lacks %q", u)
		}
	}
	tc, _, _ := jobsCLI(t)
	for _, c := range []struct {
		args       []string
		want, line string
	}{
		{[]string{"job", "add", "Fix X"}, "job add takes no arguments; the title goes in --title", jobAddUsage},
		{[]string{"job", "add", "--title", "x", "extra"}, "job add takes no arguments", jobAddUsage},
		{[]string{"job", "add"}, "job add needs --title <title>", ""},
		{[]string{"job", "add", "--title", "  "}, "job add needs --title <title>", ""},
		{[]string{"job"}, "agents job needs add, show or set", jobShowUsage},
		{[]string{"job", "nope"}, "unknown agents job command: nope", jobSetUsage},
		{[]string{"job", "show"}, "job show takes one job id", jobShowUsage},
		{[]string{"job", "show", "a", "b"}, "job show takes one job id", jobShowUsage},
		{[]string{"job", "set"}, "job set takes one job id", jobSetUsage},
		{[]string{"job", "set", "a"}, "job set needs --state, --title, --note or --pane", jobSetUsage},
		{[]string{"jobs", "x"}, "jobs takes no arguments", jobsUsage},
		{[]string{"wait", "--job"}, "wait --job needs at least one job id", waitJobUsage},
		{[]string{"wait", "--job", "a", "--timeout", "0s"}, "--timeout must be more than 0", waitJobUsage},
	} {
		err := tc.dispatch("agents", c.args)
		if exitCode(err) != 2 || !strings.Contains(err.Error(), c.want) || (c.line != "" && !strings.Contains(err.Error(), c.line)) ||
			strings.Contains(err.Error(), "agents list") {
			t.Errorf("%q: %v", c.args, err)
		}
	}
}

// The orchestrator's own pane is refused as a job's pane and as the pane a
// message goes to, when termote knows it for sure (here Herdr's
// variables); where it cannot tell, the pane is not refused.
func TestAgentsRefuseOwnPane(t *testing.T) {
	tc, s := scriptedCLI(t)
	claude := &AgentInfo{Name: "claude", Status: "idle"}
	s.set("GET /api/mux/snapshot", jsonAnswer(Snapshot{Backend: "herdr", Groups: []Group{{ID: "w1", Name: "w", Tabs: []Tab{
		{ID: "w1:t1", Name: "orch", Panes: []Pane{{ID: "w1:pB1", Agent: claude}}},
		{ID: "w1:t2", Name: "work", Panes: []Pane{{ID: "w1:pA", Agent: claude}}},
	}}}}))
	j := job{ID: "j1", Title: "x", State: "todo"}
	s.set("POST /api/mux/jobs", answer(http.StatusCreated, `{"job":{"id":"j1","title":"x","state":"active"}}`))
	s.set("GET /api/mux/jobs", jsonAnswer(map[string]any{"jobs": []jobView{{j, jobLive{}}}}))
	s.set("PATCH /api/mux/jobs/j1", jsonAnswer(map[string]any{"job": jobView{j, jobLive{}}}))
	maps.Copy(tc.env, map[string]string{"HERDR_WORKSPACE_ID": "w1", "HERDR_TAB_ID": "w1:t1", "HERDR_PANE_ID": "w1:pB1"})
	const self = "--pane w1:pB1 is the pane this command runs in; a job goes to the agent that does the work"
	for _, args := range [][]string{{"job", "add", "--title", "x", "--pane", "w1:pB1"}, {"job", "add", "--title", "x", "--pane", "orch"},
		{"job", "set", "j1", "--pane", "w1:pB1"}} {
		if err := tc.dispatch("agents", args); err == nil || err.Error() != self {
			t.Errorf("%q: %v", args, err)
		}
	}
	err := tc.dispatch("agents", []string{"send", "w1:pB1", "hi"})
	if err == nil || !strings.Contains(err.Error(), "pane w1:pB1 is the pane this command runs in") {
		t.Errorf("send: %v", err)
	}
	if n := countPosts(s, "/api/mux/"); n != 0 {
		t.Errorf("sent something: %v", s.posts)
	}
	// Another pane goes through.
	for _, args := range [][]string{{"job", "add", "--title", "x", "--pane", "w1:pA"}, {"job", "set", "j1", "--pane", "w1:pA"}} {
		if err := tc.dispatch("agents", args); err != nil {
			t.Errorf("%q: %v", args, err)
		}
	}
	// Its own pane, when the environment does not say so for sure: not
	// refused here (the server decides).
	delete(tc.env, "HERDR_TAB_ID")
	if err := tc.dispatch("agents", []string{"job", "add", "--title", "x", "--pane", "w1:pB1"}); err != nil {
		t.Errorf("unknown self: %v", err)
	}
}

// wait --job, as wait: an idle agent whose ended turn left a shell running
// is still waited on, never "nothing to wait for" while the shell runs.
func TestAgentsWaitJobBackgroundShell(t *testing.T) {
	tc, f, _ := jobsCLI(t)
	j := addJob(t, tc, "--title", "Tests", "--pane", "web/api")
	if err := tc.dispatch("agents", []string{"read", "%1"}); err != nil {
		t.Fatal(err)
	}
	f.setScreen(shellScreen())
	settle()
	tc.stdout.Reset()
	err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "300ms"})
	if exitCode(err) != agentsExitTimeout ||
		!strings.Contains(tc.stdout.String(), "web/api (%1) ended its turn and still runs in the background (1 shell); its next turn starts when that ends") {
		t.Errorf("shell running: exit %d %s", exitCode(err), tc.stdout)
	}
	// The shell ends with no new turn: nothing to wait for.
	f.setScreen(boxScreen(""))
	settle()
	tc.stdout.Reset()
	if err := tc.dispatch("agents", []string{"wait", "--job", j.ID, "--timeout", "300ms"}); exitCode(err) != agentsExitIdle {
		t.Errorf("shell ended: exit %d %s", exitCode(err), tc.stdout)
	}
}
