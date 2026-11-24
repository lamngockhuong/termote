package main

import (
	"fmt"
	"net/http"
	"slices"
)

// A job's priority and the jobs it waits on (after). after only ever feeds
// what is shown, which jobs are ready and the refusal of start --job: no
// state change, and no job finish, reads it. Only a done job satisfies a
// dependency; a failed or abandoned one keeps the job waiting, flagged, for
// the user to decide. The dependency state is never called blocked: that
// is an agent waiting on a dialog.

// maxJobAfter bounds the jobs one job waits on.
const maxJobAfter = 20

// jobPriorities: normal is stored as "" so old files and the common case
// stay as they were.
var jobPriorities = []string{"high", "normal", "low"}

var (
	errJobCycle            = &codedError{"job_cycle", "the jobs would wait on each other", http.StatusConflict}
	errJobAfterMissing     = &codedError{"job_after_missing", "a job it waits on does not exist", http.StatusConflict}
	errJobWorkspaceUnknown = &codedError{"job_workspace_unknown", "no such workspace is open", http.StatusConflict}
	errJobWorkspaceBound   = &codedError{"job_workspace_bound", "the job has an agent or a worktree: its workspace stays", http.StatusConflict}
)

// validJobPriority is p as stored: "high", "low", or "" for normal.
func validJobPriority(p string) (string, error) {
	if !slices.Contains(jobPriorities, p) {
		return "", invalidJob("unknown priority")
	}
	if p == "normal" {
		return "", nil
	}
	return p, nil
}

func priorityRank(p string) int {
	switch p {
	case "high":
		return 0
	case "low":
		return 2
	}
	return 1
}

// validJobAfter is after without duplicates, in the order given, refusing a
// malformed id, the job itself (id, when it has one) and more than
// maxJobAfter ids. Whether they exist is checkAfter's, under the lock.
func validJobAfter(id string, after []string) ([]string, error) {
	var out []string
	for _, a := range after {
		if !validTemplateID(a) {
			return nil, invalidJob("a job it waits on is not a job id")
		}
		if a == id {
			return nil, invalidJob("a job cannot wait on itself")
		}
		if !slices.Contains(out, a) {
			out = append(out, a)
		}
	}
	if len(out) > maxJobAfter {
		return nil, invalidJob(fmt.Sprintf("a job waits on up to %d jobs", maxJobAfter))
	}
	return out, nil
}

// checkAfter: every id in after names a job of list other than id, and the
// job id waiting on them leaves no job waiting on itself, however far round.
func checkAfter(list []job, id string, after []string) error {
	byID := make(map[string]*job, len(list))
	for i := range list {
		byID[list[i].ID] = &list[i]
	}
	for _, a := range after {
		if a == id {
			return invalidJob("a job cannot wait on itself")
		}
		if byID[a] == nil {
			return errJobAfterMissing
		}
	}
	// A cycle: id is reached from one of after through the jobs' own after.
	seen := map[string]bool{}
	stack := slices.Clone(after)
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if cur == id {
			return errJobCycle
		}
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if j := byID[cur]; j != nil {
			stack = append(stack, j.After...)
		}
	}
	return nil
}

// jobWaits is what j still waits on in list: the after ids whose job is not
// done, and of those, the failed or abandoned ones.
func jobWaits(list []job, j job) (waiting, failed []string) {
	for _, a := range j.After {
		i := slices.IndexFunc(list, func(o job) bool { return o.ID == a })
		if i < 0 || list[i].State == "done" {
			continue
		}
		waiting = append(waiting, a)
		if list[i].State == "failed" || list[i].State == "abandoned" {
			failed = append(failed, a)
		}
	}
	return waiting, failed
}

// jobReady: j is to do and waits on nothing.
func jobReady(list []job, j job) bool {
	w, _ := jobWaits(list, j)
	return j.State == "todo" && len(w) == 0
}

// sortJobs orders list by priority; within one, the jobs to do come first,
// oldest first (first added, first started), then the others newest first.
func sortJobs(list []job) {
	slices.SortStableFunc(list, func(a, b job) int {
		if d := priorityRank(a.Priority) - priorityRank(b.Priority); d != 0 {
			return d
		}
		at, bt := a.State == "todo", b.State == "todo"
		switch {
		case at && bt:
			return a.Created.Compare(b.Created)
		case at:
			return -1
		case bt:
			return 1
		}
		return b.Created.Compare(a.Created)
	})
}

// pruneAfter removes from every job's after the ids no longer in f, with a
// deps event on that job: a job removed, pruned or dropped for its age
// never stays named. updated does not move: nothing a client chose
// changed, and a job read before (jobs prune going through finished jobs
// that wait on each other) is still removed as read.
func (s *jobStore) pruneAfter(f *jobFile) { s.pruneAfterJobs(f.Jobs) }

func (s *jobStore) pruneAfterJobs(list []job) {
	ids := make(map[string]bool, len(list))
	for _, j := range list {
		ids[j.ID] = true
	}
	for i := range list {
		j := &list[i]
		var gone []string
		j.After = slices.DeleteFunc(j.After, func(a string) bool {
			if ids[a] {
				return false
			}
			gone = append(gone, a)
			return true
		})
		if len(j.After) == 0 {
			j.After = nil
		}
		for _, a := range gone {
			s.addEvent(j, "deps", a+" removed")
		}
	}
}
