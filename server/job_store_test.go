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

// A bash grant made under older rules, whose prefix the table refuses, is
// revoked once as the ledger opens: an event on its job and an audit line.
func TestJobStoreRevokesRefusedGrants(t *testing.T) {
	s, dir := newTestJobStore(t)
	j, err := s.create(job{Title: "a", State: "working"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	expires := now.Add(time.Hour).UTC().Format(time.RFC3339Nano)
	at := now.UTC().Format(activityTimeFormat)
	if _, err := s.update(j.ID, "", func(j *job) error {
		j.Grants = []grant{
			{ID: "old", Kind: "bash", Prefix: "npm", Created: at, Expires: expires},
			{ID: "ok", Kind: "bash", Prefix: "pnpm test", Created: at, Expires: expires},
			{ID: "edit", Kind: "edit", Dir: dir, Created: at, Expires: expires},
			{ID: "ended", Kind: "bash", Prefix: "gem", Created: at, Expires: now.Add(-time.Minute).UTC().Format(time.RFC3339Nano)},
			{ID: "gone", Kind: "bash", Prefix: "tar", Created: at, Expires: expires, Revoked: at},
			// A tool's grant made before grants held a folder, and one after.
			{ID: "nodir", Kind: "bash", Prefix: "rg", Created: at, Expires: expires},
			{ID: "withdir", Kind: "bash", Prefix: "rg", Dir: dir, Created: at, Expires: expires},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	events := func(s *jobStore) int {
		got, _ := s.job(j.ID)
		return len(got.Events)
	}
	before := events(s)
	logs := captureLog(t)
	opened, err := newJobStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := opened.job(j.ID)
	revoked := map[string]string{}
	for _, g := range got.Grants {
		revoked[g.ID] = g.Revoked
	}
	if revoked["old"] == "" || revoked["nodir"] == "" || revoked["ok"] != "" || revoked["edit"] != "" || revoked["ended"] != "" ||
		revoked["gone"] != at || revoked["withdir"] != "" {
		t.Errorf("revoked %v", revoked)
	}
	if n := len(got.Events); n != before+2 || got.Events[n-2].Text != "run npm" || got.Events[n-1].Text != "run rg" {
		t.Errorf("events %+v", got.Events)
	}
	line := logs.String()
	if !strings.Contains(line, `grant_revoked grant="old"`) || !strings.Contains(line, `reason="rules_changed"`) ||
		!strings.Contains(line, `by="server"`) || !strings.Contains(line, `grant_revoked grant="nodir"`) ||
		strings.Count(line, "grant_revoked") != 2 {
		t.Errorf("audit %q", line)
	}
	// Opened again, nothing more is written.
	if _, err := newJobStore(dir); err != nil {
		t.Fatal(err)
	}
	if n := events(opened); n != before+2 {
		t.Errorf("events after a second open: %d", n)
	}
	if strings.Count(logs.String(), "grant_revoked") != 2 {
		t.Errorf("audit after a second open %q", logs.String())
	}
}

// A ledger a newer version wrote is never written, and a write that fails
// leaves the store open: grantInForce still holds the grant.
func TestJobStoreRevokeRefusedGrantsNoWrite(t *testing.T) {
	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	file := `{"v":%d,"jobs":[{"id":"x","title":"a","state":"working","grants":[{"id":"g","kind":"bash","prefix":"npm","expires":"` + expires + `"}]}]}`
	dir := t.TempDir()
	path := filepath.Join(dir, jobsFile)
	os.WriteFile(path, []byte(strings.Replace(file, "%d", "99", 1)), 0o600)
	before, _ := os.ReadFile(path)
	if _, err := newJobStore(dir); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Errorf("a newer version's file written: %s", after)
	}
	// The lock cannot be opened: a directory stands in its place.
	os.WriteFile(path, []byte(strings.Replace(file, "%d", "1", 1)), 0o600)
	os.Remove(filepath.Join(dir, jobsLock))
	os.Mkdir(filepath.Join(dir, jobsLock), 0o700)
	logs := captureLog(t)
	s, err := newJobStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if j, _ := s.job("x"); j.Grants[0].Revoked != "" {
		t.Errorf("revoked without a write: %+v", j.Grants)
	}
	if !strings.Contains(logs.String(), "revoke grants the rules refuse") {
		t.Errorf("log %q", logs.String())
	}
}
