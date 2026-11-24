package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

// The job ledger (<stateDir>/jobs/jobs.json): the work an orchestrator agent
// handed to the agents in other panes, kept by the server so it outlives a
// compacted conversation, a new tab or a restart. termote agents writes it
// over the local socket; the PWA shows it in the overview's Plan section and
// lets a full client add, edit and remove jobs. "Job", not "task": tasks are
// the user's own commands (task_store.go).
//
// Lock order: a write holds jobs.lock, then the store's mu, and calls
// nothing outside the store; the routes read the activity tracker and the
// agent sessions before or after a store call, never inside one.

const (
	jobsFile = "jobs.json"
	jobsLock = "jobs.lock"
	// jobsFormat is the file's v. A file with a higher one was written by a
	// newer Termote: it is read, never written.
	jobsFormat = 1
	maxJobs    = 200
	// maxJobTitle is in runes, the others in bytes.
	maxJobTitle  = 200
	maxJobPrompt = 16 << 10
	maxJobNote   = 4 << 10
	maxJobEvents = 50
	// maxJobEventText bounds an event's text (a message's start, an answer's
	// label), in runes.
	maxJobEventText = 200
	// jobsDoneKeep: a finished job not changed in this long is dropped at
	// the next write.
	jobsDoneKeep = 30 * 24 * time.Hour
	// jobBody fits a job whose prompt and note JSON escape to six bytes each
	// at worst would not: 32 KB is the route's limit, the fields' own are
	// checked after.
	jobBody = 32 << 10
)

// maxJobsRead bounds the file as read, and so as written: a write that
// would make it larger is refused (errJobsFull), so the file is never one
// every later write fails to read. A variable so tests can shorten it.
var maxJobsRead int64 = 32 << 20

// jobsLockWait bounds the wait for another process's write; a variable so
// tests can shorten it.
var jobsLockWait = 2 * time.Second

var jobPartRe = regexp.MustCompile(`^\.jobs-[0-9a-f]{16}\.part$`)

// The states a job can be in. active: an agent works on it; review: done
// by the agent, for the user to look at; the last three are finished.
var jobStates = []string{"todo", "active", "review", "done", "failed", "abandoned"}

func jobFinished(state string) bool {
	return state == "done" || state == "failed" || state == "abandoned"
}

var (
	errJobsUnavailable = &codedError{"jobs_unavailable", "the job ledger is not available on this server", http.StatusServiceUnavailable}
	errJobsNewer       = &codedError{"newer_format", "the jobs were saved by a newer Termote: update it to change them", http.StatusConflict}
	errJobsBusy        = &codedError{"busy", "another process is changing the jobs: try again", http.StatusServiceUnavailable}
	errJobNotFound     = &codedError{"job_not_found", "no such job", http.StatusNotFound}
	errTooManyJobs     = &codedError{"too_many_jobs", fmt.Sprintf("up to %d jobs", maxJobs), http.StatusConflict}
	errJobsTooLarge    = &codedError{"too_large", "request body too large", http.StatusRequestEntityTooLarge}
	errJobUnfinished   = &codedError{"job_unfinished", "only a done, failed or abandoned job can be removed here", http.StatusConflict}
	errJobsFull        = &codedError{"jobs_full", "the jobs file is full: remove finished jobs first", http.StatusConflict}
)

func invalidJob(msg string) *codedError {
	return &codedError{"job_invalid", msg, http.StatusBadRequest}
}

// jobConflict is a write whose updated is not the job's any more: another
// device or the orchestrator changed it. It carries the job as it is.
type jobConflict struct {
	codedError
	job job
}

// job is one piece of work. Title is never taken from the prompt: a
// view-only client sees it. Agent names the agent working on it; Worktree,
// the git worktree made for it, is only ever written by the server.
type job struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Prompt    string    `json:"prompt,omitempty"`
	Note      string    `json:"note,omitempty"`
	State     string    `json:"state"`
	CreatedBy string    `json:"createdBy"`
	Workspace string    `json:"workspace,omitempty"`
	Agent     *jobAgent `json:"agent,omitempty"`
	Worktree  *jobTree  `json:"worktree,omitempty"`
	// ReadTS, ReadConv: the last entry time and conversation of the turn
	// the orchestrator read last (termote agents read); a later entry, or
	// another conversation, is a turn it has not read.
	ReadTS   string `json:"readTs,omitempty"`
	ReadConv string `json:"readConv,omitempty"`
	// Reported: the dialog wait --job reported last, so a dialog the user
	// keeps open is reported once.
	Reported string   `json:"reported,omitempty"`
	Diff     *jobDiff `json:"diff,omitempty"`
	// CI: the job's pull requests and their checks (job_pr.go).
	CI      *jobCI     `json:"ci,omitempty"`
	Grants  []grant    `json:"grants,omitempty"`
	Events  []jobEvent `json:"events,omitempty"`
	Created time.Time  `json:"created"`
	Updated time.Time  `json:"updated"`
}

// jobAgent is the agent a job was given to, and what tells it from another
// agent that later runs at the same pane address: tmux reuses %N once its
// server restarts, so the address alone proves nothing. PID and Start are
// the agent process's (Start its start time, so a reused pid differs);
// where the backend finds no process (PID 0), the session id stands in.
type jobAgent struct {
	Key     string `json:"key"`
	PaneID  string `json:"paneId"`
	Kind    string `json:"kind"`
	GroupID string `json:"groupId,omitempty"`
	Ref     string `json:"ref,omitempty"`
	PID     int    `json:"pid,omitempty"`
	Start   string `json:"start,omitempty"`
	Session string `json:"session,omitempty"`
}

// jobTree is the worktree made for a job, as the server's own list named it.
type jobTree struct {
	Branch  string `json:"branch"`
	Base    string `json:"base,omitempty"`
	Dir     string `json:"dir"`
	GroupID string `json:"groupId,omitempty"`
}

// jobDiff is what the last termote agents diff --stat of the job's pane
// counted.
type jobDiff struct {
	Commits int    `json:"commits"`
	Files   int    `json:"files"`
	Head    string `json:"head,omitempty"`
	At      string `json:"at"`
}

// jobEvent is one line of a job's history: kind is created, started,
// continued, sent, read, answered, stopped, diff, state, agent, note,
// grant, revoked, delegated, pr (attached or detached), ci (a check failed,
// every pull request merged), ci_sent or ci_failed_send.
type jobEvent struct {
	At   string `json:"at"`
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
}

type jobFile struct {
	V    int   `json:"v"`
	Jobs []job `json:"jobs"`
}

// jobStore keeps the ledger as taskStore keeps the tasks: a file that
// cannot be read is an error, never overwritten, and every write holds
// jobs.lock and reads the file again first.
type jobStore struct {
	dir string
	now func() time.Time

	// onReview, when set, is told the id of a job that moved to review,
	// after the write (the push watcher).
	onReview atomic.Pointer[func(id string)]

	writeMu sync.Mutex
	mu      sync.Mutex
	list    []job
	// readOnly: the file is a newer version's
	readOnly bool
	modTime  time.Time
	size     int64
	badTime  time.Time
	badSize  int64
}

func newJobStore(dir string) (*jobStore, error) {
	if dir == "" {
		return nil, errors.New("no jobs state dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	if err := checkPrivateDir(dir); err != nil {
		return nil, err
	}
	s := &jobStore{dir: dir, now: time.Now}
	removeStateParts(dir, jobPartRe)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *jobStore) path() string { return filepath.Join(s.dir, jobsFile) }

func (s *jobStore) readLocked() (jobFile, os.FileInfo, error) {
	fi, err := os.Lstat(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return jobFile{V: jobsFormat}, nil, nil
	}
	if err != nil {
		return jobFile{}, nil, fmt.Errorf("read %s: %w", jobsFile, err)
	}
	if fi.Size() > maxJobsRead {
		return jobFile{}, nil, fmt.Errorf("%s is larger than %d bytes", jobsFile, maxJobsRead)
	}
	data, err := readStateFile(s.path())
	if err != nil {
		return jobFile{}, nil, fmt.Errorf("read %s: %w", jobsFile, err)
	}
	var f jobFile
	if err := json.Unmarshal(data, &f); err != nil {
		return jobFile{}, nil, fmt.Errorf("%s is corrupt: %w", jobsFile, err)
	}
	if f.V < 1 {
		return jobFile{}, nil, fmt.Errorf("%s is corrupt: no format version", jobsFile)
	}
	return f, fi, nil
}

func (s *jobStore) reloadLocked() error {
	f, fi, err := s.readLocked()
	if err != nil {
		return err
	}
	s.list = f.Jobs
	s.readOnly = f.V > jobsFormat
	s.modTime, s.size = time.Time{}, 0
	if fi != nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	return nil
}

func (s *jobStore) maybeReloadLocked() {
	fi, err := os.Lstat(s.path())
	switch {
	case errors.Is(err, os.ErrNotExist):
		if s.size == 0 && s.modTime.IsZero() {
			return
		}
	case err != nil:
		return
	case fi.ModTime().Equal(s.modTime) && fi.Size() == s.size,
		fi.ModTime().Equal(s.badTime) && fi.Size() == s.badSize:
		return
	}
	if err := s.reloadLocked(); err != nil {
		log.Printf("jobs: %v", err)
		if fi != nil {
			s.badTime, s.badSize = fi.ModTime(), fi.Size()
		}
	}
}

// jobs returns a copy of every job, newest first, and whether a newer
// version's file makes them read-only.
func (s *jobStore) jobs() ([]job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maybeReloadLocked()
	out := make([]job, len(s.list))
	for i, j := range s.list {
		out[i] = j.clone()
	}
	slices.SortStableFunc(out, func(a, b job) int { return b.Created.Compare(a.Created) })
	return out, s.readOnly
}

// job returns the job with id, as the file holds it now.
func (s *jobStore) job(id string) (job, bool) {
	list, _ := s.jobs()
	i := slices.IndexFunc(list, func(j job) bool { return j.ID == id })
	if i < 0 {
		return job{}, false
	}
	return list[i], true
}

// clone copies j deep enough that a change to the copy never reaches j.
func (j job) clone() job {
	if j.Agent != nil {
		a := *j.Agent
		j.Agent = &a
	}
	if j.Worktree != nil {
		w := *j.Worktree
		j.Worktree = &w
	}
	if j.Diff != nil {
		d := *j.Diff
		j.Diff = &d
	}
	j.CI = j.CI.clone()
	j.Events = slices.Clone(j.Events)
	j.Grants = slices.Clone(j.Grants)
	for i := range j.Grants {
		j.Grants[i].Uses = slices.Clone(j.Grants[i].Uses)
	}
	return j
}

// change runs op on the jobs as the file holds them now, under jobs.lock,
// drops the finished jobs past jobsDoneKeep and writes the result. On any
// failure nothing changes.
func (s *jobStore) change(op func([]job) ([]job, error)) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	unlock, err := lockStateFile(filepath.Join(s.dir, jobsLock), jobsLockWait)
	if errors.Is(err, errStateLockTimeout) {
		log.Printf("jobs: %s still locked after %s", jobsLock, jobsLockWait)
		return errJobsBusy
	}
	if err != nil {
		return fmt.Errorf("lock %s: %w", jobsFile, err)
	}
	defer unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reloadLocked(); err != nil {
		return err
	}
	if s.readOnly {
		return errJobsNewer
	}
	list := make([]job, len(s.list))
	for i, j := range s.list {
		list[i] = j.clone()
	}
	next, err := op(list)
	if err != nil {
		return err
	}
	cutoff := s.now().Add(-jobsDoneKeep)
	next = slices.DeleteFunc(next, func(j job) bool { return jobFinished(j.State) && j.Updated.Before(cutoff) })
	data, err := json.Marshal(jobFile{V: jobsFormat, Jobs: next})
	if err != nil {
		return err
	}
	if int64(len(data)) > maxJobsRead {
		log.Printf("jobs: a write of %d bytes refused, over %d", len(data), maxJobsRead)
		return errJobsFull
	}
	if err := writeStateFile("jobs", s.dir, "jobs", s.path(), data, false); err != nil {
		return fmt.Errorf("write %s: %w", jobsFile, err)
	}
	s.list = next
	s.modTime, s.size = time.Time{}, 0
	if fi, err := os.Lstat(s.path()); err == nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	return nil
}

// stamp is a write's time, after prev, so updated changes with every write.
func (s *jobStore) stamp(prev time.Time) time.Time {
	t := s.now().UTC().Round(0)
	if !t.After(prev) {
		t = prev.Add(time.Nanosecond)
	}
	return t
}

// addEvent appends an event to j, keeping the newest maxJobEvents.
func (s *jobStore) addEvent(j *job, kind, text string) {
	j.Events = append(j.Events, jobEvent{At: s.now().UTC().Format(activityTimeFormat), Kind: kind, Text: clipJobText(text, maxJobEventText)})
	if n := len(j.Events) - maxJobEvents; n > 0 {
		j.Events = slices.Delete(j.Events, 0, n)
	}
}

// create adds j (its ID, times and first event set here).
func (s *jobStore) create(j job) (job, error) {
	err := s.change(func(list []job) ([]job, error) {
		if len(list) >= maxJobs {
			// Finished jobs make room, oldest first.
			if i := oldestFinished(list); i >= 0 {
				list = slices.Delete(list, i, i+1)
			} else {
				return nil, errTooManyJobs
			}
		}
		j.ID = newTemplateID()
		j.Created = s.stamp(time.Time{})
		j.Updated = j.Created
		s.addEvent(&j, "created", "")
		return append(list, j), nil
	})
	if err == nil && j.State == "review" {
		if f := s.onReview.Load(); f != nil {
			(*f)(j.ID)
		}
	}
	return j, err
}

func oldestFinished(list []job) int {
	at := -1
	for i, j := range list {
		if jobFinished(j.State) && (at < 0 || j.Updated.Before(list[at].Updated)) {
			at = i
		}
	}
	return at
}

// update runs op on the job with id, refusing a stale updated (when one is
// given) with the job as it is, and stamps it.
func (s *jobStore) update(id, updated string, op func(*job) error) (job, error) {
	var saved job
	var before string
	err := s.change(func(list []job) ([]job, error) {
		i := slices.IndexFunc(list, func(j job) bool { return j.ID == id })
		if i < 0 {
			return nil, errJobNotFound
		}
		if updated != "" && list[i].Updated.Format(time.RFC3339Nano) != updated {
			return nil, &jobConflict{codedError{"job_conflict", "the job was changed elsewhere", http.StatusConflict}, list[i]}
		}
		before = list[i].State
		if err := op(&list[i]); err != nil {
			return nil, err
		}
		list[i].Updated = s.stamp(list[i].Updated)
		saved = list[i].clone()
		return list, nil
	})
	if err == nil && before != "review" && saved.State == "review" {
		if f := s.onReview.Load(); f != nil {
			(*f)(saved.ID)
		}
	}
	return saved, err
}

// setOnReview has f told of every job that moves to review.
func (s *jobStore) setOnReview(f func(id string)) { s.onReview.Store(&f) }

// remove deletes job id; finishedOnly refuses one that is not finished,
// checked under the lock that deletes it.
func (s *jobStore) remove(id, updated string, finishedOnly bool) error {
	return s.change(func(list []job) ([]job, error) {
		i := slices.IndexFunc(list, func(j job) bool { return j.ID == id })
		if i < 0 {
			return nil, errJobNotFound
		}
		if updated != "" && list[i].Updated.Format(time.RFC3339Nano) != updated {
			return nil, &jobConflict{codedError{"job_conflict", "the job was changed elsewhere", http.StatusConflict}, list[i]}
		}
		if finishedOnly && !jobFinished(list[i].State) {
			return nil, errJobUnfinished
		}
		return slices.Delete(list, i, i+1), nil
	})
}

// renameGroup follows a Zellij group renamed from from to to, as the
// activity tracker does: every id the jobs keep that starts with the group's
// moves with it.
func (s *jobStore) renameGroup(from, to string) {
	err := s.change(func(list []job) ([]job, error) {
		for i := range list {
			j := &list[i]
			j.Workspace = renamedGroupID(j.Workspace, from, to)
			if j.Agent != nil {
				j.Agent.Key = renamedGroupID(j.Agent.Key, from, to)
				j.Agent.PaneID = renamedGroupID(j.Agent.PaneID, from, to)
				j.Agent.GroupID = renamedGroupID(j.Agent.GroupID, from, to)
			}
			if j.Worktree != nil {
				j.Worktree.GroupID = renamedGroupID(j.Worktree.GroupID, from, to)
			}
			for g := range j.Grants {
				a := &j.Grants[g].Agent
				a.Key = renamedGroupID(a.Key, from, to)
				a.PaneID = renamedGroupID(a.PaneID, from, to)
				a.GroupID = renamedGroupID(a.GroupID, from, to)
			}
		}
		return list, nil
	})
	if err != nil {
		log.Printf("jobs: rename %s: %v", from, err)
	}
}

// cleanJobText is s with control and hidden characters removed (a tab or
// a line break is kept where multi says so), trimmed.
func cleanJobText(s string, multi bool) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if multi && (r == '\n' || r == '\t') {
			return r
		}
		if unicode.IsControl(r) || hiddenRune(r) {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

// clipJobText is s on one line, at most n runes.
func clipJobText(s string, n int) string {
	return cutRunes(strings.Join(strings.Fields(cleanJobText(s, true)), " "), n)
}

// validJobTitle cleans a title: one line, 1 to maxJobTitle runes.
func validJobTitle(t string) (string, error) {
	t = cleanJobText(strings.Join(strings.Fields(t), " "), false)
	switch n := utf8.RuneCountInString(t); {
	case n == 0:
		return "", invalidJob("the title is empty")
	case n > maxJobTitle:
		return "", invalidJob(fmt.Sprintf("the title is longer than %d characters", maxJobTitle))
	}
	return t, nil
}

func validJobNote(n string) (string, error) {
	n = cleanJobText(n, true)
	if len(n) > maxJobNote {
		return "", invalidJob(fmt.Sprintf("the note is larger than %d bytes", maxJobNote))
	}
	return n, nil
}

func validJobPrompt(p string) (string, error) {
	p = cleanJobText(p, true)
	if len(p) > maxJobPrompt {
		return "", invalidJob(fmt.Sprintf("the prompt is larger than %d bytes", maxJobPrompt))
	}
	return p, nil
}

func validJobState(st string) error {
	if !slices.Contains(jobStates, st) {
		return invalidJob("unknown state")
	}
	return nil
}
