//go:build !windows

package main

import (
	"bufio"
	"net/http"
	"strings"
	"testing"
	"time"
)

func runAgents(tc *testCLI, args ...string) (int, string) {
	tc.stdout.Reset()
	tc.stderr.Reset()
	err := tc.dispatch("agents", args)
	out := tc.stdout.String()
	if err != nil {
		out += "\nerror: " + err.Error()
	}
	return exitCode(err), out
}

// asksOf is the ask list route answering list.
func asksOf(s *scripted, list ...askView) {
	if list == nil {
		list = []askView{}
	}
	s.set("GET /api/mux/asks", jsonAnswer(map[string]any{"asks": list}))
}

func mineAsk(id, creator, state string) askView {
	return askView{ask: ask{ID: id, Text: "Question " + id, CreatedBy: creator, State: state}}
}

func TestAgentsAskAdd(t *testing.T) {
	tc, s, _, _ := mineCLI(t)
	s.set("POST /api/mux/asks", answer(http.StatusCreated, `{"ask":{"id":"Q3","text":"Which?","state":"open"}}`))
	code, out := runAgents(tc, "ask", "add", "--text", "Which?", "--choice", "A", "--choice", "B", "--job", "j1")
	if code != 0 || out != "Q3\n" {
		t.Errorf("add: %d %q", code, out)
	}
	if p := lastPost(s, "/api/mux/asks"); !strings.Contains(p, `"pane":"w1:pO"`) || !strings.Contains(p, `"choices":["A","B"]`) || !strings.Contains(p, `"job":"j1"`) {
		t.Errorf("posted %s", p)
	}
	code, out = runAgents(tc, "ask", "add", "--text", "Which?", "--json")
	if code != 0 || !strings.Contains(out, `"ask": {`) || !strings.Contains(out, `"id": "Q3"`) {
		t.Errorf("add --json: %d %s", code, out)
	}
	tc.in = bufio.NewReader(strings.NewReader("From\nstdin\n"))
	if code, _ := runAgents(tc, "ask", "add", "--text", "-"); code != 0 || !strings.Contains(lastPost(s, "/api/mux/asks"), `"text":"From\nstdin"`) {
		t.Errorf("stdin: %d %s", code, lastPost(s, "/api/mux/asks"))
	}
	for name, args := range map[string][]string{
		"no text": {"ask", "add"}, "blank": {"ask", "add", "--text", " "}, "argument": {"ask", "add", "x", "--text", "q"},
		"flag": {"ask", "add", "--nope"},
	} {
		if code, out := runAgents(tc, args...); code != 2 {
			t.Errorf("%s: %d %s", name, code, out)
		}
	}
	tc.in = bufio.NewReader(strings.NewReader(strings.Repeat("x", agentMessageBody+1)))
	if code, _ := runAgents(tc, "ask", "add", "--text", "-"); code != 1 {
		t.Errorf("long stdin: %d", code)
	}
	s.set("POST /api/mux/asks", answer(http.StatusConflict, `{"code":"too_many_asks","error":"up to 20"}`))
	if code, out := runAgents(tc, "ask", "add", "--text", "q"); code != 1 || !strings.Contains(out, "too_many_asks") {
		t.Errorf("refused: %d %s", code, out)
	}
	s.set("POST /api/mux/asks", answer(http.StatusCreated, `{}`))
	if code, out := runAgents(tc, "ask", "add", "--text", "q"); code != 1 || !strings.Contains(out, "unexpected answer") {
		t.Errorf("odd answer: %d %s", code, out)
	}
	s.set("POST /api/mux/asks", hangUp)
	if code, _ := runAgents(tc, "ask", "add", "--text", "q"); code != 1 {
		t.Errorf("hang up: %d", code)
	}
}

// Every ask command needs its own pane for sure: another pane's
// variables, a pane without an agent, no server, are refused.
func TestAgentsAskSelf(t *testing.T) {
	tc, s, _, _ := mineCLI(t)
	tc.env["HERDR_PANE_ID"] = "w1:pX"
	for _, args := range [][]string{{"ask", "add", "--text", "q"}, {"ask", "list"}, {"ask", "close", "Q1"}} {
		if code, out := runAgents(tc, args...); code != 1 || !strings.Contains(out, "ask needs to know this command's pane") {
			t.Errorf("%v: %d %s", args, code, out)
		}
	}
	s.set("GET /api/mux/snapshot", answer(http.StatusInternalServerError, `{"error":"x"}`))
	if code, _ := runAgents(tc, "ask", "list"); code != 1 {
		t.Errorf("no snapshot: %d", code)
	}
	bare := newTestCLI(t, "linux")
	if err := bare.dispatch("agents", []string{"ask", "list"}); err == nil {
		t.Error("no server")
	}
	for _, args := range [][]string{{"ask"}, {"ask", "nope"}} {
		if code, _ := runAgents(tc, args...); code != 2 {
			t.Errorf("%v: %d", args, code)
		}
	}
}

func TestAgentsAskList(t *testing.T) {
	tc, s, _, self := mineCLI(t)
	q1 := mineAsk("Q1", self, askOpen)
	q1.Choices, q1.Job, q1.JobTitle = []string{"Left", "Right"}, "j1", "Parser"
	q2 := mineAsk("Q2", self, askAnswered)
	q2.AnsweredBy, q2.Answer = "pwa", "yes\nplease"
	q4 := mineAsk("Q4", self, askOpen)
	q4.Job, q4.Text = "j9", "two\nlines‮"
	q5 := mineAsk("Q5", self, askDismissed)
	q5.AnsweredBy = "pwa"
	asksOf(s, q1, q2, mineAsk("Q3", "cli", askOpen), q4, q5)
	code, out := runAgents(tc, "ask", "list")
	if code != 0 || !strings.Contains(out, "Q1  Parser  Question Q1\n") || !strings.Contains(out, "1) Left  2) Right") ||
		!strings.Contains(out, "Q4  j9      two lines\n") || strings.Contains(out, "Q2") || strings.Contains(out, "Q3") || strings.Contains(out, "Q5") {
		t.Errorf("list: %d\n%s", code, out)
	}
	code, out = runAgents(tc, "ask", "ls", "--all")
	if code != 0 || !strings.Contains(out, "answered (pwa): yes please") || !strings.Contains(out, "Q5") || !strings.Contains(out, "dismissed in the PWA\n") ||
		strings.Contains(out, "Q3") {
		t.Errorf("list --all: %d\n%s", code, out)
	}
	code, out = runAgents(tc, "ask", "list", "--json")
	if code != 0 || !strings.Contains(out, `"id": "Q1"`) || !strings.Contains(out, `"id": "Q4"`) || strings.Contains(out, `"id": "Q2"`) {
		t.Errorf("list --json: %d\n%s", code, out)
	}
	asksOf(s, q2)
	if code, out := runAgents(tc, "ask", "list"); code != 0 || out != "No open questions.\n" {
		t.Errorf("none open: %q", out)
	}
	asksOf(s)
	if code, out := runAgents(tc, "ask", "list", "--all"); code != 0 || out != "No questions.\n" {
		t.Errorf("none: %q", out)
	}
	s.set("GET /api/mux/asks", answer(http.StatusOK, `{"asks":null}`))
	if code, out := runAgents(tc, "ask", "list", "--json"); code != 0 || !strings.Contains(out, `"asks": []`) {
		t.Errorf("none --json: %q", out)
	}
	for _, args := range [][]string{{"ask", "list", "x"}, {"ask", "list", "--nope"}} {
		if code, _ := runAgents(tc, args...); code != 2 {
			t.Errorf("%v: %d", args, code)
		}
	}
	s.set("GET /api/mux/asks", answer(http.StatusNotFound, `{"error":"not found"}`))
	if code, out := runAgents(tc, "ask", "list"); code != 1 || !strings.Contains(out, "termote update") {
		t.Errorf("older server: %d %s", code, out)
	}
}

func TestAgentsAskClose(t *testing.T) {
	tc, s, _, _ := mineCLI(t)
	s.set("POST /api/mux/asks/Q2/close", answer(http.StatusOK, `{"ask":{"id":"Q2"}}`))
	if code, out := runAgents(tc, "ask", "close", "Q2", "--answer", "left, in the tab"); code != 0 || !strings.Contains(out, "Closed Q2") {
		t.Errorf("close: %d %s", code, out)
	}
	if p := lastPost(s, "/api/mux/asks/Q2/close"); !strings.Contains(p, `"answer":"left, in the tab"`) || !strings.Contains(p, `"pane":"w1:pO"`) {
		t.Errorf("posted %s", p)
	}
	s.set("POST /api/mux/asks/Q2/close", answer(http.StatusConflict, `{"code":"ask_closed","error":"x","ask":{"id":"Q2","answeredBy":"pwa","answer":"Right"}}`))
	if code, out := runAgents(tc, "ask", "close", "Q2"); code != 0 || out != "Q2 was already answered (pwa): Right\n" {
		t.Errorf("closed already: %d %q", code, out)
	}
	s.set("POST /api/mux/asks/Q2/close", answer(http.StatusConflict, `{"code":"ask_closed","error":"x","ask":{"id":"Q2","state":"dismissed","answeredBy":"pwa"}}`))
	if code, out := runAgents(tc, "ask", "close", "Q2"); code != 0 || out != "Q2 was dismissed in the PWA: the user chose not to answer it\n" {
		t.Errorf("dismissed: %d %q", code, out)
	}
	s.set("POST /api/mux/asks/Q2/close", answer(http.StatusConflict, `{"code":"ask_closed","error":"x"}`))
	if code, _ := runAgents(tc, "ask", "close", "Q2"); code != 1 {
		t.Errorf("closed without the ask: %d", code)
	}
	tries, every := askBusyTries, askBusyEvery
	askBusyTries, askBusyEvery = 2, time.Millisecond
	t.Cleanup(func() { askBusyTries, askBusyEvery = tries, every })
	s.set("POST /api/mux/asks/Q2/close", answer(http.StatusConflict, `{"code":"ask_busy","error":"being sent"}`))
	if code, out := runAgents(tc, "ask", "close", "Q2"); code != 1 || !strings.Contains(out, "ask_busy") || countPosts(s, "/api/mux/asks/Q2/close") < 3 {
		t.Errorf("busy: %d %s", code, out)
	}
	// Busy a moment, then through
	busy := true
	s.set("POST /api/mux/asks/Q2/close", func(w http.ResponseWriter, r *http.Request) {
		if busy {
			busy = false
			answer(http.StatusConflict, `{"code":"ask_busy","error":"being sent"}`)(w, r)
			return
		}
		answer(http.StatusOK, `{"ask":{"id":"Q2"}}`)(w, r)
	})
	if code, out := runAgents(tc, "ask", "close", "Q2"); code != 0 || !strings.Contains(out, "Closed Q2") {
		t.Errorf("busy then closed: %d %s", code, out)
	}
	s.set("POST /api/mux/asks/Q2/close", hangUp)
	if code, _ := runAgents(tc, "ask", "close", "Q2"); code != 1 {
		t.Errorf("hang up: %d", code)
	}
	for _, args := range [][]string{{"ask", "close"}, {"ask", "close", "3"}, {"ask", "close", "Q1", "Q2"}, {"ask", "close", "--nope"}} {
		if code, _ := runAgents(tc, args...); code != 2 {
			t.Errorf("%v: %d", args, code)
		}
	}
}

// wait --mine reports the PWA's answers to this pane's questions once,
// and names the open ones when it ends with nothing to report.
func TestAgentsWaitMineAsks(t *testing.T) {
	tc, s, jobs, self := mineCLI(t)
	answered := mineAsk("Q1", self, askAnswered)
	answered.AnsweredBy, answered.Answer = "pwa", "Left\nfor now"
	closed := mineAsk("Q5", self, askAnswered)
	closed.AnsweredBy = "agent"
	reported := mineAsk("Q6", self, askAnswered)
	reported.AnsweredBy, reported.Reported = "pwa", true
	theirs := mineAsk("Q7", "cli", askAnswered)
	theirs.AnsweredBy = "pwa"
	asksOf(s, answered, mineAsk("Q2", self, askOpen), closed, reported, theirs)
	s.set("POST /api/mux/asks/Q1/reported", answer(http.StatusOK, `{"ok":true}`))
	jobs()
	code, out := waitMine(t, tc, "--timeout", "2s")
	if code != 0 || !strings.Contains(out, "Q1 answered in the PWA: Left for now") || strings.Contains(out, "Q5") || strings.Contains(out, "Q6") ||
		strings.Contains(out, "Q7") || strings.Contains(out, "Nothing to wait for") {
		t.Errorf("answer: %d\n%s", code, out)
	}
	if p := lastPost(s, "/api/mux/asks/Q1/reported"); !strings.Contains(p, `"pane":"w1:pO"`) {
		t.Errorf("not marked reported: %v", s.posts)
	}
	// With a job that ended a turn: both in one report
	jobs(mineJob("j1", "Parser", "active", self, "w1:pA", jobLive{Status: "idle", Unread: true}))
	code, out = waitMine(t, tc, "--timeout", "2s")
	if code != 0 || !strings.Contains(out, "Q1 answered in the PWA") || !strings.Contains(out, "Job j1 (Parser)") {
		t.Errorf("answer and job: %d\n%s", code, out)
	}
	// A failure to mark it is a warning
	s.set("POST /api/mux/asks/Q1/reported", answer(http.StatusBadRequest, `{"code":"ask_invalid","error":"x"}`))
	if code, out := waitMine(t, tc, "--timeout", "2s"); code != 0 || !strings.Contains(tc.stderr.String(), "Q1 may be reported again") {
		t.Errorf("mark refused: %d %s %s", code, out, tc.stderr.String())
	}
	tc.stderr.Reset()
	s.set("POST /api/mux/asks/Q1/reported", hangUp)
	if code, _ := waitMine(t, tc, "--timeout", "2s"); code != 0 || !strings.Contains(tc.stderr.String(), "Q1 may be reported again") {
		t.Errorf("mark failed: %d %s", code, tc.stderr.String())
	}

	// A question dismissed in the PWA ends the wait too, reported once;
	// with an answer, both are printed
	dismissed := mineAsk("Q9", self, askDismissed)
	dismissed.AnsweredBy = "pwa"
	asksOf(s, answered, dismissed)
	s.set("POST /api/mux/asks/Q1/reported", answer(http.StatusOK, `{"ok":true}`))
	s.set("POST /api/mux/asks/Q9/reported", answer(http.StatusOK, `{"ok":true}`))
	jobs()
	code, out = waitMine(t, tc, "--timeout", "2s")
	if code != 0 || !strings.Contains(out, "Q9 dismissed in the PWA: the user chose not to answer it; do not ask it again\n") ||
		!strings.Contains(out, "Q1 answered in the PWA") || strings.Contains(out, "Q9 answered") {
		t.Errorf("dismissed: %d\n%s", code, out)
	}
	if p := lastPost(s, "/api/mux/asks/Q9/reported"); !strings.Contains(p, `"pane":"w1:pO"`) {
		t.Errorf("dismissal not marked reported: %v", s.posts)
	}
	// Reported, it is not printed again
	dismissed.Reported = true
	asksOf(s, dismissed, mineAsk("Q2", self, askOpen))
	if code, out := waitMine(t, tc, "--timeout", "2s"); code != agentsExitIdle || strings.Contains(out, "Q9") || !strings.Contains(out, "open: Q2\n") {
		t.Errorf("dismissal reported: %d\n%s", code, out)
	}

	// Only open questions: the wait ends as before, naming them
	asksOf(s, mineAsk("Q2", self, askOpen), mineAsk("Q3", self, askOpen), mineAsk("Q8", "cli", askOpen))
	jobs()
	if code, out := waitMine(t, tc, "--timeout", "2s"); code != agentsExitIdle || !strings.Contains(out, "open: Q2 Q3\n") {
		t.Errorf("open, no job: %d\n%s", code, out)
	}
	jobs(mineJob("j1", "Parser", "active", self, "w1:pA", jobLive{Status: "idle"}))
	if code, out := waitMine(t, tc, "--timeout", "2s"); code != agentsExitIdle || !strings.Contains(out, "open: Q2 Q3\n") {
		t.Errorf("open, idle job: %d\n%s", code, out)
	}
	jobs(mineJob("j1", "Parser", "active", self, "w1:pA", jobLive{Status: "working"}))
	if code, out := waitMine(t, tc, "--timeout", "100ms"); code != agentsExitTimeout || !strings.Contains(out, "open: Q2 Q3\n") {
		t.Errorf("open, timeout: %d\n%s", code, out)
	}
	// An older server without questions: as before
	s.set("GET /api/mux/asks", answer(http.StatusNotFound, `{"error":"not found"}`))
	jobs()
	if code, out := waitMine(t, tc, "--timeout", "2s"); code != agentsExitIdle || strings.Contains(out, "open:") {
		t.Errorf("older server: %d\n%s", code, out)
	}
}

// read names the open questions of the pane's job, and those the user
// wrote in the pane about after they were asked and after the
// orchestrator's last send.
func TestAgentsReadAskHints(t *testing.T) {
	tc, s, jobs, self := mineCLI(t)
	created := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	j := mineJob("j1", "Parser", "active", self, "w1:pA", jobLive{Status: "idle"})
	j.Events = []jobEvent{{At: "2026-11-24T09:04:30.000Z", Kind: "sent"}, {At: "2026-11-24T09:05:00.000Z", Kind: "ci_sent"},
		{At: "bad", Kind: "sent"}, {At: "2026-11-24T09:09:00.000Z", Kind: "read"}}
	jobs(j)
	q := mineAsk("Q3", self, askOpen)
	q.Job, q.Created = "j1", created
	other := mineAsk("Q4", self, askOpen)
	other.Job, other.Created = "j1", created.Add(10*time.Minute)
	asksOf(s, q, other, mineAsk("Q5", self, askOpen))
	transcript := func(ts ...string) {
		var entries []string
		for _, t := range ts {
			entries = append(entries, `{"id":"e`+t+`","ts":"`+t+`","role":"user","parts":[{"kind":"text","text":"hi"}]}`)
		}
		s.set("GET /api/mux/panes/w1:pA/agent/transcript", answer(http.StatusOK, `{"agent":"claude","cursor":"c1","entries":[`+strings.Join(entries, ",")+`]}`))
	}
	hint := "[the user wrote in this pane after Q3 was asked; if that answers it: termote agents ask close Q3 --answer '…']"
	// Before the question, then after it but before the orchestrator's send
	transcript("2026-11-24T08:00:00.000Z", "2026-11-24T09:04:00.000Z", "2026-11-24T09:04:45.000Z", "")
	if code, out := runAgents(tc, "read", "w1:pA"); code != 0 || strings.Contains(out, "the user wrote") {
		t.Errorf("no hint: %d\n%s", code, out)
	}
	transcript("2026-11-24T09:06:00.000Z")
	code, out := runAgents(tc, "read", "w1:pA")
	if code != 0 || !strings.Contains(out, hint) || strings.Contains(out, "Q4") || strings.Contains(out, "Q5") {
		t.Errorf("hint: %d\n%s", code, out)
	}
	code, out = runAgents(tc, "read", "w1:pA", "--json")
	if code != 0 || !strings.Contains(out, `"openAsks": [`) || !strings.Contains(out, `"userWroteAfter": [`) {
		t.Errorf("--json: %d\n%s", code, out)
	}
	// No open question of the job: nothing more in the JSON
	asksOf(s, mineAsk("Q5", self, askOpen))
	if code, out := runAgents(tc, "read", "w1:pA", "--json"); code != 0 || strings.Contains(out, "openAsks") {
		t.Errorf("--json without: %d\n%s", code, out)
	}
	s.set("GET /api/mux/asks", answer(http.StatusNotFound, `{"error":"not found"}`))
	if code, out := runAgents(tc, "read", "w1:pA"); code != 0 || strings.Contains(out, "the user wrote") {
		t.Errorf("older server: %d\n%s", code, out)
	}
}

// read moves the mark of every unfinished job whose agent runs in the
// pane, one in review too: wait --mine waits on those, so a turn left
// unread there would be reported again at every wait. A finished job is
// left as it is.
func TestAgentsReadMarksUnfinishedJobs(t *testing.T) {
	tc, s, jobs, self := mineCLI(t)
	unread := jobLive{Status: "idle", Unread: true, LastTS: "2026-11-24T06:42:13.434Z"}
	jobs(mineJob("j1", "Plan", "review", self, "w1:pA", unread), mineJob("j2", "Fix", "active", self, "w1:pA", unread),
		mineJob("j3", "Old", "done", self, "w1:pA", unread), mineJob("j4", "Other", "review", self, "w1:pB", unread))
	s.set("GET /api/mux/panes/w1:pA/agent/transcript", answer(http.StatusOK,
		`{"agent":"claude","cursor":"c1","entries":[{"id":"e1","ts":"2026-11-24T06:42:13.434Z","role":"assistant","parts":[{"kind":"text","text":"Which one?"}]}]}`))
	if code, out := runAgents(tc, "read", "w1:pA"); code != 0 || !strings.Contains(out, "ends with a question") {
		t.Fatalf("read: %d\n%s", code, out)
	}
	for _, id := range []string{"j1", "j2"} {
		if p := lastPost(s, "/api/mux/jobs/"+id+"/event"); !strings.Contains(p, `"kind":"read"`) || !strings.Contains(p, `"lastTs":"2026-11-24T06:42:13.434Z"`) {
			t.Errorf("%s not marked read: %q", id, p)
		}
	}
	for _, id := range []string{"j3", "j4"} {
		if p := lastPost(s, "/api/mux/jobs/"+id+"/event"); p != "" {
			t.Errorf("%s marked: %q", id, p)
		}
	}
}
