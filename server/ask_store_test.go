package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const askKey = "%P"

func testAsk(text string) ask {
	return ask{Text: text, CreatedBy: askKey, Agent: jobAgent{Key: askKey, PaneID: "%P", Kind: "claude", PID: 7, Start: "s"}}
}

func mustAddAsk(t *testing.T, s *jobStore, q ask) ask {
	t.Helper()
	got, err := s.addAsk(q)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func askIDs(list []ask) string {
	var ids []string
	for _, q := range list {
		ids = append(ids, q.ID+":"+q.State)
	}
	return strings.Join(ids, " ")
}

func TestAskStoreIDs(t *testing.T) {
	s, dir := newTestJobStore(t)
	for i := 1; i <= 3; i++ {
		if q := mustAddAsk(t, s, testAsk("q")); q.ID != "Q"+string(rune('0'+i)) || q.State != askOpen || !q.Created.Equal(q.Updated) {
			t.Fatalf("add %d: %+v", i, q)
		}
	}
	// A store made again from the same dir (a restart) goes on counting
	s2, err := newJobStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if q := mustAddAsk(t, s2, testAsk("q")); q.ID != "Q4" {
		t.Errorf("after a restart: %s", q.ID)
	}
	// A file without a counter (written by hand, or by a version that
	// dropped it) still never gives an id twice
	os.WriteFile(filepath.Join(dir, jobsFile), []byte(`{"v":1,"jobs":[],"asks":[{"id":"Q7","text":"x","createdBy":"%P","state":"open","updated":"2099-01-01T00:00:00Z","agent":{"key":"%P","paneId":"%P","kind":"claude"}}]}`), 0o600)
	if q := mustAddAsk(t, s, testAsk("q")); q.ID != "Q8" {
		t.Errorf("past Q7: %s", q.ID)
	}
	if list, ro := s.asksList(); ro || askIDs(list) != "Q7:open Q8:open" {
		t.Errorf("list %s %v", askIDs(list), ro)
	}
	if _, ok := s.askByID("Q9"); ok {
		t.Error("Q9")
	}
	if q, ok := s.askByID("Q7"); !ok || q.Text != "x" {
		t.Errorf("Q7 %+v", q)
	}
	if askNum("Q0") != 0 || askNum("q1") != 0 || askNum("Q12") != 12 || validAskID("Q1234567890") || !validAskID("Q123456789") {
		t.Error("ids")
	}
}

func TestAskStoreCloseAnswer(t *testing.T) {
	s, _ := newTestJobStore(t)
	q1 := mustAddAsk(t, s, testAsk("one"))
	q2 := mustAddAsk(t, s, testAsk("two"))
	stamp := q1.Updated.Format(time.RFC3339Nano)

	// Only the pane that asked closes its asks
	if _, err := s.closeAsk(q1.ID, "%other", ""); !errors.Is(err, errAskNotFound) {
		t.Errorf("another pane: %v", err)
	}
	got, err := s.closeAsk(q1.ID, askKey, "in the tab")
	if err != nil || got.State != askAnswered || got.AnsweredBy != "agent" || got.Answer != "in the tab" || !got.Updated.After(q1.Updated) {
		t.Fatalf("close %+v %v", got, err)
	}
	var ae *askError
	if _, err := s.closeAsk(q1.ID, askKey, "again"); !errors.As(err, &ae) || ae.code != "ask_closed" || ae.ask.Answer != "in the tab" {
		t.Errorf("close twice: %v", err)
	}
	if _, err := s.answerAsk(q1.ID, stamp, "x", 0); !errors.As(err, &ae) || ae.code != "ask_closed" {
		t.Errorf("answer a closed one: %v", err)
	}
	if _, err := s.answerAsk("Q99", stamp, "x", 0); !errors.Is(err, errAskNotFound) {
		t.Errorf("answer a missing one: %v", err)
	}
	if _, err := s.answerAsk(q2.ID, stamp, "x", 0); !errors.As(err, &ae) || ae.code != "ask_conflict" || ae.ask.ID != q2.ID {
		t.Errorf("stale: %v", err)
	}
	got, err = s.answerAsk(q2.ID, q2.Updated.Format(time.RFC3339Nano), "B", 2)
	if err != nil || got.AnsweredBy != "pwa" || got.Choice != 2 || got.Answer != "B" || got.Reported {
		t.Fatalf("answer %+v %v", got, err)
	}

	// Closing the PWA's answer: ask_closed, and it needs no report now
	q3 := mustAddAsk(t, s, testAsk("three"))
	s.answerAsk(q3.ID, q3.Updated.Format(time.RFC3339Nano), "C", 0)
	if got, err := s.closeAsk(q3.ID, askKey, ""); !errors.As(err, &ae) || ae.code != "ask_closed" || !got.Reported || !ae.ask.Reported || ae.ask.Answer != "C" {
		t.Errorf("close a PWA answer: %+v %v", got, err)
	}
	if _, err := s.closeAsk(q3.ID, askKey, ""); !errors.As(err, &ae) || ae.code != "ask_closed" {
		t.Errorf("close it again: %v", err)
	}

	// Reported: only an answer from the PWA, once
	if err := s.markAskReported(q1.ID, askKey); err == nil || !strings.Contains(err.Error(), "PWA") {
		t.Errorf("report an agent's close: %v", err)
	}
	if err := s.markAskReported(q2.ID, "%other"); !errors.Is(err, errAskNotFound) {
		t.Errorf("report another pane's: %v", err)
	}
	if err := s.markAskReported(q2.ID, askKey); err != nil {
		t.Fatal(err)
	}
	before, _ := s.askByID(q2.ID)
	if err := s.markAskReported(q2.ID, askKey); err != nil {
		t.Fatal(err)
	}
	if after, _ := s.askByID(q2.ID); !after.Reported || !after.Updated.Equal(before.Updated) {
		t.Errorf("reported twice wrote: %+v", after)
	}
}

func TestAskStoreLimits(t *testing.T) {
	s, _ := newTestJobStore(t)
	for range maxOpenAsksPerPane {
		mustAddAsk(t, s, testAsk("q"))
	}
	if _, err := s.addAsk(testAsk("q")); !errors.Is(err, errTooManyAsks) {
		t.Errorf("21st open ask: %v", err)
	}
	other := testAsk("q")
	other.CreatedBy = "%O"
	mustAddAsk(t, s, other)
	// The file is full: answered asks make room, oldest first; none left
	// to drop is too_many_asks
	if _, err := s.closeAsk("Q1", askKey, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.closeAsk("Q2", askKey, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.changeFile(func(f *jobFile) error {
		for len(f.Asks) < maxAsks {
			q := testAsk("filler")
			q.ID, q.CreatedBy, q.State = "Q"+string(rune('a'+len(f.Asks)%26)), "%F"+strings.Repeat("x", len(f.Asks)), askOpen
			q.Updated = time.Now()
			f.Asks = append(f.Asks, q)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if q := mustAddAsk(t, s, testAsk("q")); q.ID != "Q22" {
		t.Errorf("full file: %s", q.ID)
	}
	list, _ := s.asksList()
	if _, ok := s.askByID("Q1"); ok || len(list) != maxAsks {
		t.Errorf("the oldest answered stayed: %d", len(list))
	}
	if _, ok := s.askByID("Q2"); !ok {
		t.Error("the newer answered went")
	}
	if _, err := s.closeAsk("Q2", askKey, ""); err == nil {
		t.Error("closed twice")
	}
	if _, err := s.addAsk(testAsk("q")); err != nil {
		t.Errorf("Q2 makes room: %v", err)
	}
	// An answer from the PWA not reported yet goes after any other
	q, _ := s.askByID("Q22")
	s.answerAsk("Q22", q.Updated.Format(time.RFC3339Nano), "x", 0)
	s.closeAsk("Q3", askKey, "")
	mustAddAsk(t, s, testAsk("q"))
	if _, ok := s.askByID("Q22"); !ok {
		t.Error("the unreported answer went first")
	}
	if _, ok := s.askByID("Q3"); ok {
		t.Error("the agent's close stayed")
	}
	mustAddAsk(t, s, testAsk("q"))
	if _, ok := s.askByID("Q22"); ok {
		t.Error("the unreported answer stayed with nothing else to drop")
	}
	if _, err := s.addAsk(other); !errors.Is(err, errTooManyAsks) {
		t.Errorf("nothing to drop: %v", err)
	}
}

func TestAskStoreJob(t *testing.T) {
	s, _ := newTestJobStore(t)
	mine, _ := s.create(job{Title: "mine", State: "active", CreatedBy: askKey})
	theirs, _ := s.create(job{Title: "theirs", State: "active", CreatedBy: "%O"})
	done, _ := s.create(job{Title: "done", State: "done", CreatedBy: askKey})
	for _, id := range []string{theirs.ID, done.ID, "nope"} {
		q := testAsk("q")
		q.Job = id
		if _, err := s.addAsk(q); err == nil || !strings.Contains(err.Error(), "unfinished job") {
			t.Errorf("job %s: %v", id, err)
		}
	}
	q := testAsk("q")
	q.Job = mine.ID
	if got := mustAddAsk(t, s, q); got.Job != mine.ID {
		t.Errorf("job %+v", got)
	}
}

// Once every job of an orchestrator is finished, its answered asks and its
// open asks of a job go at the next write; an open ask of no job stays, as
// does an answer from the PWA not reported yet, and every other pane's.
func TestAskStorePrune(t *testing.T) {
	s, _ := newTestJobStore(t)
	// A pane without a job keeps its answered asks
	lone := testAsk("lone")
	lone.CreatedBy = "%L"
	lq := mustAddAsk(t, s, lone)
	if _, err := s.closeAsk(lq.ID, "%L", ""); err != nil {
		t.Fatal(err)
	}
	j, _ := s.create(job{Title: "j", State: "active", CreatedBy: askKey})
	other, _ := s.create(job{Title: "o", State: "active", CreatedBy: "%O"})
	bound := testAsk("bound")
	bound.Job = j.ID
	qb := mustAddAsk(t, s, bound)                     // Q2: open, of the job
	qa := mustAddAsk(t, s, testAsk("answered here"))  // Q3
	qp := mustAddAsk(t, s, testAsk("answered (pwa)")) // Q4
	qr := mustAddAsk(t, s, testAsk("reported (pwa)")) // Q5
	mustAddAsk(t, s, testAsk("open"))                 // Q6
	o := testAsk("other")
	o.CreatedBy = "%O"
	qo := mustAddAsk(t, s, o) // Q7
	s.closeAsk(qa.ID, askKey, "")
	s.closeAsk(qo.ID, "%O", "")
	s.answerAsk(qp.ID, qp.Updated.Format(time.RFC3339Nano), "x", 0)
	s.answerAsk(qr.ID, qr.Updated.Format(time.RFC3339Nano), "x", 0)
	s.markAskReported(qr.ID, askKey)
	if list, _ := s.asksList(); len(list) != 7 {
		t.Fatalf("pruned while a job runs: %s", askIDs(list))
	}
	if _, err := s.update(j.ID, "", func(j *job) error { j.State = "done"; return nil }); err != nil {
		t.Fatal(err)
	}
	list, _ := s.asksList()
	if askIDs(list) != "Q1:answered Q4:answered Q6:open Q7:answered" {
		t.Errorf("pruned %s (bound %s)", askIDs(list), qb.ID)
	}
	// An ask of no job added after the last job is done stays
	if q := mustAddAsk(t, s, testAsk("what next?")); q.ID != "Q8" {
		t.Errorf("next %s", q.ID)
	}
	if _, ok := s.askByID("Q8"); !ok {
		t.Error("pruned at its own write")
	}
	// Reporting the PWA's answer lets it go
	s.markAskReported(qp.ID, askKey)
	if _, ok := s.askByID(qp.ID); ok {
		t.Error("a reported answer stayed")
	}
	// Any ask not changed past jobsDoneKeep goes
	s.now = func() time.Time { return time.Now().Add(jobsDoneKeep + time.Hour) }
	s.update(other.ID, "", func(*job) error { return nil })
	if list, _ := s.asksList(); len(list) != 0 {
		t.Errorf("old asks stayed: %s", askIDs(list))
	}
}

func TestAskStoreRepin(t *testing.T) {
	s, dir := newTestJobStore(t)
	q := mustAddAsk(t, s, testAsk("q"))
	closed := mustAddAsk(t, s, testAsk("closed"))
	s.closeAsk(closed.ID, askKey, "")
	fi, _ := os.Stat(filepath.Join(dir, jobsFile))
	if err := s.repinAsks(askKey, q.Agent); err != nil {
		t.Fatal(err)
	}
	if now, _ := os.Stat(filepath.Join(dir, jobsFile)); !now.ModTime().Equal(fi.ModTime()) || now.Size() != fi.Size() {
		t.Error("an unchanged repin wrote")
	}
	ag := q.Agent
	ag.PID, ag.Session = 8, "new"
	if err := s.repinAsks(askKey, ag); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.askByID(q.ID); got.Agent != ag {
		t.Errorf("open ask %+v", got.Agent)
	}
	if got, _ := s.askByID(closed.ID); got.Agent == ag {
		t.Error("an answered ask was repinned")
	}
	// Another kind of agent at the pane does not take them over
	codex := ag
	codex.Kind, codex.PID = "codex", 9
	if err := s.repinAsks(askKey, codex); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.askByID(q.ID); got.Agent != ag {
		t.Errorf("repinned to another kind %+v", got.Agent)
	}
	// A file of a newer version is read, never written
	os.WriteFile(filepath.Join(dir, jobsFile), []byte(`{"v":2,"jobs":[]}`), 0o600)
	if err := s.repinAsks(askKey, q.Agent); !errors.Is(err, errJobsNewer) {
		t.Errorf("newer: %v", err)
	}
	if _, err := s.addAsk(testAsk("q")); !errors.Is(err, errJobsNewer) {
		t.Errorf("add to newer: %v", err)
	}
	if err := s.markAskReported("Q1", askKey); !errors.Is(err, errJobsNewer) {
		t.Errorf("report in newer: %v", err)
	}
}

// A file without asks (an older version's) reads and writes as before;
// a Zellij rename moves the asks and the jobs' creator with the group.
func TestAskStoreOldFileAndRename(t *testing.T) {
	s, dir := newTestJobStore(t)
	os.WriteFile(filepath.Join(dir, jobsFile), []byte(`{"v":1,"jobs":[{"id":"a","title":"t","state":"todo","createdBy":"x"}]}`), 0o600)
	q := mustAddAsk(t, s, testAsk("q"))
	if list, _ := s.jobs(); len(list) != 1 || q.ID != "Q1" {
		t.Errorf("old file %+v %s", list, q.ID)
	}
	b, _ := os.ReadFile(filepath.Join(dir, jobsFile))
	if !strings.Contains(string(b), `"askSeq":1`) {
		t.Errorf("saved %s", b)
	}

	from, to := zellijGroupID("a"), zellijGroupID("b")
	key := from + ":t1"
	j, _ := s.create(job{Title: "x", State: "active", CreatedBy: key})
	zq := testAsk("z")
	zq.CreatedBy, zq.Agent = key, jobAgent{Key: key, PaneID: from + "/p1", GroupID: from, Kind: "claude"}
	zq = mustAddAsk(t, s, zq)
	s.renameGroup(from, to)
	got, _ := s.askByID(zq.ID)
	if got.CreatedBy != to+":t1" || got.Agent.Key != to+":t1" || got.Agent.PaneID != to+"/p1" || got.Agent.GroupID != to {
		t.Errorf("renamed ask %+v", got)
	}
	if jj, _ := s.job(j.ID); jj.CreatedBy != to+":t1" {
		t.Errorf("renamed job creator %q", jj.CreatedBy)
	}
}

func TestAskTextChecks(t *testing.T) {
	if got, err := validAskText(" line one\n\tline two\x1b[31m‮ "); err != nil || got != "line one\n\tline two[31m" {
		t.Errorf("text %q %v", got, err)
	}
	if _, err := validAskText(" \x07 "); err == nil {
		t.Error("empty text")
	}
	if _, err := validAskText(strings.Repeat("é", maxAskText)); err != nil {
		t.Errorf("%d runes: %v", maxAskText, err)
	}
	if _, err := validAskText(strings.Repeat("é", maxAskText+1)); err == nil {
		t.Error("long text")
	}
	if got, err := validAskChoices([]string{" a\n b ", "c​"}); err != nil || len(got) != 2 || got[0] != "a b" || got[1] != "c" {
		t.Errorf("choices %q %v", got, err)
	}
	six := []string{"1", "2", "3", "4", "5", "6"}
	if _, err := validAskChoices(six); err != nil {
		t.Errorf("six: %v", err)
	}
	for name, in := range map[string][]string{
		"seven": append(six, "7"), "empty": {"a", " "}, "same": {"a", " a"},
		"long": {strings.Repeat("é", maxAskChoice+1)},
	} {
		if _, err := validAskChoices(in); err == nil {
			t.Errorf("%s choices", name)
		}
	}
	if _, err := validAskChoices([]string{strings.Repeat("é", maxAskChoice)}); err != nil {
		t.Errorf("%d runes: %v", maxAskChoice, err)
	}
	if got, err := validAskAnswer(" a\n\tb\x00 "); err != nil || got != "a\n\tb" {
		t.Errorf("answer %q %v", got, err)
	}
	if _, err := validAskAnswer(strings.Repeat("x", maxAskAnswer)); err != nil {
		t.Errorf("answer at the limit: %v", err)
	}
	if _, err := validAskAnswer(strings.Repeat("x", maxAskAnswer+1)); err == nil {
		t.Error("long answer")
	}
	if askConflict(ask{}).status != 409 || askClosed(ask{}).code != "ask_closed" {
		t.Error("errors")
	}
}
