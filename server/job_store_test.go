package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestJobStore(t *testing.T) (*jobStore, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := newJobStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s, dir
}

func TestJobStoreFiles(t *testing.T) {
	s, dir := newTestJobStore(t)
	j, err := s.create(job{Title: "a", State: "todo"})
	if err != nil || j.ID == "" || len(j.Events) != 1 || j.Events[0].Kind != "created" {
		t.Fatalf("create %+v %v", j, err)
	}
	// Another process's write is read on the next call.
	other, err := newJobStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.create(job{Title: "b", State: "todo"}); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.jobs(); len(list) != 2 || list[0].Title != "b" {
		t.Errorf("newest first: %+v", list)
	}
	// A corrupt file is never overwritten, nor read at start.
	path := filepath.Join(dir, jobsFile)
	os.WriteFile(path, []byte("{"), 0o600)
	if _, err := s.create(job{Title: "c"}); err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Errorf("write over a corrupt file: %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != "{" {
		t.Errorf("corrupt file rewritten: %s", b)
	}
	if _, err := newJobStore(dir); err == nil {
		t.Error("a corrupt file at start")
	}
	// A newer version's file is read, never written.
	os.WriteFile(path, []byte(`{"v":2,"jobs":[{"id":"x","title":"new","state":"todo"}]}`), 0o600)
	if list, ro := s.jobs(); !ro || len(list) != 1 {
		t.Errorf("newer: %+v %v", list, ro)
	}
	if _, err := s.create(job{Title: "c"}); !errors.Is(err, errJobsNewer) {
		t.Errorf("write over a newer file: %v", err)
	}
	os.WriteFile(path, []byte(`{"jobs":[]}`), 0o600)
	if _, err := newJobStore(dir); err == nil {
		t.Error("no format version")
	}
}

func TestJobStoreUpdateConflict(t *testing.T) {
	s, _ := newTestJobStore(t)
	j, _ := s.create(job{Title: "a", State: "todo"})
	stamp := j.Updated.Format(time.RFC3339Nano)
	got, err := s.update(j.ID, stamp, func(j *job) error { j.Note = "n"; return nil })
	if err != nil || !got.Updated.After(j.Updated) {
		t.Fatalf("update %+v %v", got, err)
	}
	var conflict *jobConflict
	if _, err := s.update(j.ID, stamp, func(*job) error { return nil }); !errors.As(err, &conflict) || conflict.job.Note != "n" {
		t.Errorf("stale: %v", err)
	}
	if _, err := s.remove(j.ID, stamp, false); !errors.As(err, &conflict) {
		t.Errorf("stale remove: %v", err)
	}
	if _, err := s.update("nope", "", func(*job) error { return nil }); !errors.Is(err, errJobNotFound) {
		t.Errorf("unknown: %v", err)
	}
	if _, err := s.remove("nope", "", false); !errors.Is(err, errJobNotFound) {
		t.Errorf("unknown remove: %v", err)
	}
	// A failed op changes nothing.
	if _, err := s.update(j.ID, "", func(j *job) error { j.Note = "lost"; return errTooManyJobs }); err == nil {
		t.Fatal("op error lost")
	}
	if now, _ := s.job(j.ID); now.Note != "n" {
		t.Errorf("a failed op wrote %q", now.Note)
	}
	if _, ok := s.job("nope"); ok {
		t.Error("found nothing")
	}
}

// finishedOnly refuses a job that is not finished and keeps it; without it
// any job goes.
func TestJobStoreRemoveFinishedOnly(t *testing.T) {
	s, _ := newTestJobStore(t)
	active, _ := s.create(job{Title: "a", State: "active"})
	if _, err := s.remove(active.ID, "", true); !errors.Is(err, errJobUnfinished) {
		t.Errorf("active: %v", err)
	}
	if _, ok := s.job(active.ID); !ok {
		t.Error("an unfinished job was removed")
	}
	for _, state := range []string{"done", "failed", "abandoned"} {
		j, _ := s.create(job{Title: state, State: state})
		if _, err := s.remove(j.ID, j.Updated.Format(time.RFC3339Nano), true); err != nil {
			t.Errorf("%s: %v", state, err)
		}
	}
	if _, err := s.remove(active.ID, "", false); err != nil {
		t.Errorf("active without the limit: %v", err)
	}
	if _, ok := s.job(active.ID); ok {
		t.Error("still there")
	}
}

func TestJobStoreLimits(t *testing.T) {
	s, _ := newTestJobStore(t)
	now := time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	// Events: the newest maxJobEvents.
	j, _ := s.create(job{Title: "a", State: "active"})
	s.update(j.ID, "", func(j *job) error {
		for i := range maxJobEvents + 5 {
			s.addEvent(j, "sent", strings.Repeat("x", i))
		}
		return nil
	})
	if got, _ := s.job(j.ID); len(got.Events) != maxJobEvents || len(got.Events[maxJobEvents-1].Text) != maxJobEvents+4 {
		t.Errorf("events %d", len(got.Events))
	}
	// A finished job not changed in 30 days goes at the next write; an
	// unfinished one stays.
	old, _ := s.create(job{Title: "old", State: "done"})
	idle, _ := s.create(job{Title: "idle", State: "todo"})
	now = now.Add(jobsDoneKeep + time.Hour)
	s.create(job{Title: "new", State: "todo"})
	if _, ok := s.job(old.ID); ok {
		t.Error("an old finished job stayed")
	}
	if _, ok := s.job(idle.ID); !ok {
		t.Error("an old unfinished job went")
	}
	// Full: a finished job makes room, else it is refused.
	s2, _ := newTestJobStore(t)
	var first job
	for i := range maxJobs {
		st := "todo"
		if i == 3 {
			st = "abandoned"
		}
		made, err := s2.create(job{Title: "j", State: st})
		if err != nil {
			t.Fatal(err)
		}
		if i == 3 {
			first = made
		}
	}
	if _, err := s2.create(job{Title: "one more", State: "todo"}); err != nil {
		t.Fatalf("room from a finished job: %v", err)
	}
	if _, ok := s2.job(first.ID); ok {
		t.Error("the finished job stayed")
	}
	if _, err := s2.create(job{Title: "too many", State: "todo"}); !errors.Is(err, errTooManyJobs) {
		t.Errorf("full: %v", err)
	}
}

func TestJobStoreRenameGroup(t *testing.T) {
	s, _ := newTestJobStore(t)
	from, to := zellijGroupID("a"), zellijGroupID("b")
	ag := jobAgent{Key: from + ":t1", PaneID: from + "/p1", GroupID: from}
	j, _ := s.create(job{Title: "x", State: "active", Workspace: from, Agent: &ag, Worktree: &jobTree{GroupID: from},
		Grants: []grant{{ID: "g", Agent: ag}}})
	s.renameGroup(from, to)
	got, _ := s.job(j.ID)
	if got.Workspace != to || got.Agent.Key != to+":t1" || got.Agent.PaneID != to+"/p1" || got.Agent.GroupID != to ||
		got.Worktree.GroupID != to || got.Grants[0].Agent.Key != to+":t1" {
		t.Errorf("renamed %+v %+v", got, got.Agent)
	}
}

func TestJobTextChecks(t *testing.T) {
	if got, err := validJobTitle("  a\tb\n c​\x07 "); err != nil || got != "a b c" {
		t.Errorf("title %q %v", got, err)
	}
	if got, err := validJobNote("line one\n\tline two\x1b‮"); err != nil || got != "line one\n\tline two" {
		t.Errorf("note %q %v", got, err)
	}
	if _, err := validJobPrompt(strings.Repeat("x", maxJobPrompt+1)); err == nil {
		t.Error("long prompt")
	}
	if got := clipJobText("a\nb  c", 3); got != "a b" {
		t.Errorf("clip %q", got)
	}
	if !jobFinished("failed") || jobFinished("review") {
		t.Error("finished states")
	}
	if !tsAfter("2026-01-01T00:00:01Z", "") || tsAfter("bad", "") || tsAfter("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z") {
		t.Error("tsAfter")
	}
}

// A write that would make the file larger than a read accepts is refused,
// and the file stays readable: the jobs can still be changed and removed.
func TestJobStoreWriteBounded(t *testing.T) {
	orig := maxJobsRead
	maxJobsRead = 64 << 10
	t.Cleanup(func() { maxJobsRead = orig })
	s, dir := newTestJobStore(t)
	note := strings.Repeat("<", maxJobNote/6)
	var made []job
	var err error
	for range maxJobs {
		var j job
		if j, err = s.create(job{Title: "a", State: "todo", Note: note}); err != nil {
			break
		}
		made = append(made, j)
	}
	if !errors.Is(err, errJobsFull) || len(made) == 0 {
		t.Fatalf("after %d jobs: %v", len(made), err)
	}
	fi, err := os.Stat(filepath.Join(dir, jobsFile))
	if err != nil || fi.Size() > maxJobsRead {
		t.Fatalf("file %v %v", fi, err)
	}
	if _, err := newJobStore(dir); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if _, err := s.update(made[0].ID, "", func(j *job) error { j.Note += note; return nil }); !errors.Is(err, errJobsFull) {
		t.Errorf("a larger job: %v", err)
	}
	if _, err := s.remove(made[0].ID, "", false); err != nil {
		t.Errorf("remove: %v", err)
	}
	if _, err := s.create(job{Title: "b", State: "todo"}); err != nil {
		t.Errorf("create once there is room: %v", err)
	}
}
