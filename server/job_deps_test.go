package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestJobPriority(t *testing.T) {
	for in, want := range map[string]string{"high": "high", "normal": "", "low": "low"} {
		if got, err := validJobPriority(in); err != nil || got != want {
			t.Errorf("%s = %q %v", in, got, err)
		}
	}
	for _, in := range []string{"", "urgent", "High"} {
		if _, err := validJobPriority(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
	if priorityRank("high") >= priorityRank("") || priorityRank("") >= priorityRank("low") {
		t.Error("rank order")
	}
}

func jid(n int) string { return fmt.Sprintf("%016x", 0xa0+n) }

func TestValidJobAfter(t *testing.T) {
	got, err := validJobAfter(jid(0), []string{jid(1), jid(2), jid(1)})
	if err != nil || !slices.Equal(got, []string{jid(1), jid(2)}) {
		t.Errorf("duplicates = %v %v", got, err)
	}
	if got, err := validJobAfter("", nil); err != nil || got != nil {
		t.Errorf("empty = %v %v", got, err)
	}
	var many []string
	for i := range maxJobAfter + 1 {
		many = append(many, fmt.Sprintf("%016x", 0x100+i))
	}
	for name, after := range map[string][]string{
		"self":      {jid(0)},
		"malformed": {"J2"},
		"upper":     {strings.ToUpper(jid(1))},
		"too many":  many,
	} {
		if _, err := validJobAfter(jid(0), after); err == nil || err.(*codedError).code != "job_invalid" {
			t.Errorf("%s = %v", name, err)
		}
	}
	if got, err := validJobAfter(jid(0), many[:maxJobAfter]); err != nil || len(got) != maxJobAfter {
		t.Errorf("20 ids = %v", err)
	}
}

// graph is a list of jobs a..: each waiting on the ones named.
func graph(edges map[int][]int, n int) []job {
	var list []job
	for i := range n {
		j := job{ID: jid(i), State: "todo"}
		for _, e := range edges[i] {
			j.After = append(j.After, jid(e))
		}
		list = append(list, j)
	}
	return list
}

func TestCheckAfter(t *testing.T) {
	// d waits on b and c, both waiting on a: a diamond.
	list := graph(map[int][]int{1: {0}, 2: {0}, 3: {1, 2}}, 5)
	if err := checkAfter(list, jid(3), []string{jid(1), jid(2)}); err != nil {
		t.Errorf("diamond = %v", err)
	}
	if err := checkAfter(list, jid(4), []string{jid(3), jid(0)}); err != nil {
		t.Errorf("below the diamond = %v", err)
	}
	if err := checkAfter(list, "", []string{jid(3)}); err != nil {
		t.Errorf("a new job = %v", err)
	}
	for name, c := range map[string]struct {
		id    int
		after []int
		err   error
	}{
		"2-cycle": {0, []int{1}, errJobCycle},
		"3-cycle": {0, []int{3}, errJobCycle},
		"missing": {4, []int{9}, errJobAfterMissing},
	} {
		var after []string
		for _, a := range c.after {
			after = append(after, jid(a))
		}
		if err := checkAfter(list, jid(c.id), after); !errors.Is(err, c.err) {
			t.Errorf("%s = %v", name, err)
		}
	}
	if err := checkAfter(list, jid(0), []string{jid(0)}); err == nil || err.(*codedError).code != "job_invalid" {
		t.Errorf("self = %v", err)
	}
}

func TestJobWaits(t *testing.T) {
	list := graph(map[int][]int{6: {0, 1, 2, 3, 4, 5}}, 7)
	for i, st := range []string{"done", "todo", "active", "review", "failed", "abandoned"} {
		list[i].State = st
	}
	waiting, failed := jobWaits(list, list[6])
	if !slices.Equal(waiting, []string{jid(1), jid(2), jid(3), jid(4), jid(5)}) || !slices.Equal(failed, []string{jid(4), jid(5)}) {
		t.Errorf("waits %v failed %v", waiting, failed)
	}
	if jobReady(list, list[6]) || !jobReady(list, list[1]) || jobReady(list, list[2]) {
		t.Error("ready")
	}
	// Only done satisfies: once every one is, the job is ready.
	for i := range 6 {
		list[i].State = "done"
	}
	if !jobReady(list, list[6]) {
		t.Error("ready once all are done")
	}
}

func TestSortJobs(t *testing.T) {
	at := func(n int) time.Time { return time.Date(2026, 11, 24, 0, n, 0, 0, time.UTC) }
	list := []job{
		{ID: "lowtodo", Priority: "low", State: "todo", Created: at(1)},
		{ID: "active1", State: "active", Created: at(2)},
		{ID: "todo1", State: "todo", Created: at(3)},
		{ID: "high", Priority: "high", State: "review", Created: at(4)},
		{ID: "todo0", State: "todo", Created: at(0)},
		{ID: "active3", State: "active", Created: at(5)},
		{ID: "todo1b", State: "todo", Created: at(3)},
	}
	sortJobs(list)
	var ids []string
	for _, j := range list {
		ids = append(ids, j.ID)
	}
	want := []string{"high", "todo0", "todo1", "todo1b", "active3", "active1", "lowtodo"}
	if !slices.Equal(ids, want) {
		t.Errorf("order %v, want %v", ids, want)
	}
}

func TestJobStoreAfter(t *testing.T) {
	s, dir := newTestJobStore(t)
	a, _ := s.create(job{Title: "a", State: "todo"})
	b, err := s.create(job{Title: "b", State: "todo", After: []string{a.ID}, Priority: "high"})
	if err != nil || !slices.Equal(b.After, []string{a.ID}) {
		t.Fatalf("create after = %+v %v", b, err)
	}
	if _, err := s.create(job{Title: "c", After: []string{jid(9)}}); !errors.Is(err, errJobAfterMissing) {
		t.Errorf("create after a missing job = %v", err)
	}
	// A cycle refused under the lock leaves the file as it was.
	path := filepath.Join(dir, jobsFile)
	before, _ := os.ReadFile(path)
	_, err = s.updateWith(a.ID, "", func(list []job, j *job) error {
		if err := checkAfter(list, j.ID, []string{b.ID}); err != nil {
			return err
		}
		j.After = []string{b.ID}
		return nil
	})
	if !errors.Is(err, errJobCycle) {
		t.Errorf("cycle = %v", err)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
		t.Error("a refused write changed the file")
	}
	// A stale updated is a conflict, whatever the op.
	if _, err := s.updateWith(a.ID, "2000-01-01T00:00:00Z", func([]job, *job) error { return nil }); err == nil || !strings.Contains(err.Error(), "changed elsewhere") {
		t.Errorf("stale = %v", err)
	}
	// The list the op sees holds every job.
	var seen int
	if _, err := s.updateWith(b.ID, "", func(list []job, _ *job) error { seen = len(list); return nil }); err != nil || seen != 2 {
		t.Errorf("list seen %d %v", seen, err)
	}
	// Reloaded from the file, the fields are kept.
	other, _ := newJobStore(dir)
	if j, _ := other.job(b.ID); j.Priority != "high" || !slices.Equal(j.After, []string{a.ID}) {
		t.Errorf("reloaded %+v", j)
	}
	// A copy never shares after with the store.
	j, _ := s.job(b.ID)
	j.After[0] = "x"
	if j2, _ := s.job(b.ID); j2.After[0] != a.ID {
		t.Error("clone shares after")
	}
}

// Any state takes an after; a job that waits still changes state, and a
// waiting job in review is finished.
func TestJobAfterBlocksNoStateChange(t *testing.T) {
	s, _ := newTestJobStore(t)
	a, _ := s.create(job{Title: "a", State: "todo"})
	for _, st := range []string{"active", "review", "done"} {
		j, _ := s.create(job{Title: st, State: st})
		j, err := s.updateWith(j.ID, "", func(list []job, j *job) error {
			if err := checkAfter(list, j.ID, []string{a.ID}); err != nil {
				return err
			}
			j.After = []string{a.ID}
			return nil
		})
		if err != nil || len(j.After) != 1 {
			t.Errorf("%s after = %v", st, err)
		}
	}
	w, _ := s.create(job{Title: "w", State: "active", After: []string{a.ID}})
	if j, err := s.update(w.ID, "", func(j *job) error { j.State = "review"; return nil }); err != nil || j.State != "review" {
		t.Errorf("a waiting job to review = %v", err)
	}
}

func TestJobStorePruneAfter(t *testing.T) {
	s, dir := newTestJobStore(t)
	now := time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	mk := func(title, state string, after ...string) job {
		j, err := s.create(job{Title: title, State: state, After: after})
		if err != nil {
			t.Fatal(err)
		}
		return j
	}
	deps := func(id string) []string {
		j, _ := s.job(id)
		var out []string
		for _, e := range j.Events {
			if e.Kind == "deps" {
				out = append(out, e.Text)
			}
		}
		return out
	}

	// Removed.
	a := mk("a", "done")
	b := mk("b", "todo", a.ID)
	bUpdated := b.Updated
	if _, err := s.remove(a.ID, "", true); err != nil {
		t.Fatal(err)
	}
	if j, _ := s.job(b.ID); j.After != nil || !j.Updated.After(bUpdated) || !slices.Equal(deps(b.ID), []string{a.ID + " removed"}) {
		t.Errorf("after a remove: %+v", j)
	}

	// Dropped after 30 days.
	old := mk("old", "failed")
	c := mk("c", "todo", old.ID)
	now = now.Add(jobsDoneKeep + time.Hour)
	mk("trigger", "todo")
	if _, ok := s.job(old.ID); ok {
		t.Fatal("old job kept")
	}
	if j, _ := s.job(c.ID); j.After != nil || !slices.Equal(deps(c.ID), []string{old.ID + " removed"}) {
		t.Errorf("after the 30-day drop: %+v", j)
	}

	// Dropped for room: the oldest finished job makes way for a new one.
	for range maxJobs - 4 {
		mk("filler", "todo")
	}
	list, _ := s.jobs()
	if len(list) != maxJobs-1 {
		t.Fatalf("%d jobs", len(list))
	}
	// d names f1, then makes room by dropping it, in one write.
	f1 := mk("f1", "done")
	d := mk("d", "todo", f1.ID)
	if _, ok := s.job(f1.ID); ok {
		t.Fatal("f1 kept")
	}
	if j, _ := s.job(d.ID); j.After != nil || !slices.Equal(deps(d.ID), []string{f1.ID + " removed"}) {
		t.Errorf("after the drop for room: %+v", j)
	}

	// A file without the new fields reads and writes back without them.
	os.WriteFile(filepath.Join(dir, jobsFile), []byte(`{"v":1,"jobs":[{"id":"`+jid(1)+`","title":"x","state":"todo","createdBy":"cli","created":"2026-11-24T00:00:00Z","updated":"2026-11-24T00:00:00Z"}]}`), 0o600)
	if _, err := s.update(jid(1), "", func(*job) error { return nil }); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, jobsFile))
	for _, k := range []string{`"priority"`, `"after"`, `"deps"`} {
		if bytes.Contains(data, []byte(k)) {
			t.Errorf("old file gained %s: %s", k, data)
		}
	}
}
