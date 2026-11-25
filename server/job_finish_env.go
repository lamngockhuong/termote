package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// The ignored .env* files of a job's worktree, which a remove deletes and
// nothing makes again (job finish, job_finish.go). One that is the same,
// byte for byte, as the file at the same path in the repository's main
// checkout loses nothing and does not hold the remove back. The others are
// named, never read out: a finish from the CLI is refused with their names
// (finish_worktree_env), and the user may confirm their removal in the PWA
// (POST /api/mux/jobs/{id}/finish/env), which runs the finish the CLI asked
// for with those names allowed. Only a browser that may give a grant
// confirms (canGrant): never the local socket an agent uses. A file's
// contents never leave this file: no log, answer, error or ledger line.

const (
	// maxEnvCompare: a file larger than this is never compared and counts
	// as one a remove may lose.
	maxEnvCompare = 8 << 20
	// maxEnvNames: more files than this are not named one by one, and
	// cannot be confirmed in the PWA.
	maxEnvNames = 200
	// envNamesShown: the names a refusal's message spells out.
	envNamesShown = 10
	// finishEnvBody bounds a confirm.
	finishEnvBody = 64 << 10
)

var (
	errFinishEnvPWAOnly = &codedError{"finish_env_pwa_only",
		"the removal of a worktree's .env files is confirmed in the PWA, signed in with the password or a paired device", http.StatusForbidden}
	errFinishEnvNone = &codedError{"finish_env_none",
		"no finish waits for a confirm of its .env files: the orchestrator runs it again", http.StatusConflict}
	errFinishEnvChanged = &codedError{"finish_env_changed",
		"the .env files to confirm changed: read the job again", http.StatusConflict}
)

// envList reads the NUL-separated names git listed: a list cut short drops
// its last, partial name and reports cut.
func envList(out []byte, truncated bool) (names []string, cut bool) {
	parts := strings.Split(string(out), "\x00")
	if truncated {
		parts, cut = parts[:len(parts)-1], true
	}
	for _, p := range parts {
		if p != "" {
			names = append(names, p)
		}
	}
	return names, cut
}

// envLost is the names among names a remove of the worktree at top may
// lose: all of them when the repository has no main checkout here.
func envLost(top, main string, names []string) []string {
	if len(names) == 0 {
		return nil
	}
	if main == "" || sameAllowPath(main, top) {
		return names
	}
	wt, err := os.OpenRoot(top)
	if err != nil {
		return names
	}
	defer wt.Close()
	mr, err := os.OpenRoot(main)
	if err != nil {
		return names
	}
	defer mr.Close()
	var lost []string
	for _, n := range names {
		if !envSameAsMain(wt, mr, n) {
			lost = append(lost, n)
		}
	}
	return lost
}

// envSameAsMain: name, a path git listed relative to the worktree's top,
// is a regular file there and at the same path in the main checkout, no
// symlink on the way on either side, of the same size and bytes.
func envSameAsMain(wt, main *os.Root, name string) bool {
	rel := filepath.FromSlash(name)
	a, ok := envRegular(wt, rel)
	if !ok {
		return false
	}
	b, ok := envRegular(main, rel)
	if !ok || a.Size() != b.Size() || a.Size() > maxEnvCompare {
		return false
	}
	fa, err := envOpen(wt, rel, a)
	if err != nil {
		return false
	}
	defer fa.Close()
	fb, err := envOpen(main, rel, b)
	if err != nil {
		return false
	}
	defer fb.Close()
	return sameReaders(fa, fb, a.Size())
}

// envRegular is rel's info when every folder on its way is a folder and rel
// a regular file, none of them a symlink.
func envRegular(r *os.Root, rel string) (fs.FileInfo, bool) {
	parts := strings.Split(rel, string(filepath.Separator))
	for i := range parts {
		p := filepath.Join(parts[:i+1]...)
		fi, err := r.Lstat(p)
		switch {
		case err != nil:
			return nil, false
		case i < len(parts)-1 && !fi.IsDir():
			return nil, false
		case i == len(parts)-1:
			return fi, fi.Mode().IsRegular()
		}
	}
	return nil, false
}

// envOpen opens rel, refused when it is no longer the file Lstat read.
func envOpen(r *os.Root, rel string, want fs.FileInfo) (*os.File, error) {
	f, err := r.Open(rel)
	if err != nil {
		return nil, err
	}
	if fi, err := f.Stat(); err != nil || !os.SameFile(fi, want) {
		f.Close()
		return nil, errors.New("file changed")
	}
	return f, nil
}

// sameReaders reads size bytes from each and reports whether they match.
func sameReaders(a, b io.Reader, size int64) bool {
	const chunk = 64 << 10
	ba, bb := make([]byte, chunk), make([]byte, chunk)
	for size > 0 {
		n := int(min(size, chunk))
		if _, err := io.ReadFull(a, ba[:n]); err != nil {
			return false
		}
		if _, err := io.ReadFull(b, bb[:n]); err != nil {
			return false
		}
		if !bytes.Equal(ba[:n], bb[:n]) {
			return false
		}
		size -= int64(n)
	}
	return true
}

// envRefusal refuses a remove over ignored .env files it may lose, named
// (never read). cut: too many, or a list cut short, to name them all.
type envRefusal struct {
	files []string
	cut   bool
}

func (e *envRefusal) Error() string {
	n := fmt.Sprint(len(e.files))
	if e.cut {
		n = "more than " + n
	}
	shown := e.files[:min(len(e.files), envNamesShown)]
	names := strings.Join(shown, ", ")
	if len(shown) < len(e.files) || e.cut {
		names += ", ..."
	}
	msg := "the worktree holds " + n + " .env files git ignores that are not the same in the main checkout, which a remove deletes"
	if names != "" {
		msg += " (" + names + ")"
	}
	if e.cut {
		return msg + "; too many to confirm in the PWA"
	}
	return msg + "; the user can confirm their removal in the PWA"
}

// confirmable: the PWA may confirm these files.
func (e *envRefusal) confirmable() bool { return !e.cut && len(e.files) > 0 }

// envAllowed: every file a remove may lose is one the user confirmed.
func envAllowed(tree finishTree, ok []string) bool {
	if tree.envCut || len(ok) == 0 {
		return false
	}
	for _, f := range tree.envLost {
		if !slices.Contains(ok, f) {
			return false
		}
	}
	return true
}

// finishEnvAsk is a finish refused over .env files, waiting for the user's
// confirm in the PWA: what the CLI asked, and the files' names.
type finishEnvAsk struct {
	by    string
	close bool
	files []string
	at    time.Time
}

// finishEnvAsks are the finishes waiting for a confirm, by job id: in
// memory only, so a server that restarts forgets them (the orchestrator
// runs the finish again).
type finishEnvAsks struct {
	mu   sync.Mutex
	asks map[string]finishEnvAsk
}

func (s *finishEnvAsks) set(id string, a finishEnvAsk) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.asks == nil {
		s.asks = map[string]finishEnvAsk{}
	}
	s.asks[id] = a
}

func (s *finishEnvAsks) get(id string) (finishEnvAsk, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.asks[id]
	return a, ok
}

func (s *finishEnvAsks) drop(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.asks, id)
}

// jobEnvConfirm is what a full client is shown of a finish waiting for its
// confirm: the files' names and when it was refused.
type jobEnvConfirm struct {
	Files []string `json:"files"`
	At    string   `json:"at"`
}

func (s *finishEnvAsks) view(id string) *jobEnvConfirm {
	a, ok := s.get(id)
	if !ok {
		return nil
	}
	return &jobEnvConfirm{Files: slices.Clone(a.files), At: a.at.UTC().Format(activityTimeFormat)}
}

// finishEnvInput is a confirm: the job as the user read it, and the names
// shown to them.
type finishEnvInput struct {
	Updated string   `json:"updated"`
	Files   []string `json:"files"`
}

// handleFinishEnv runs, on the user's confirm (POST), the finish the
// orchestrator asked for, the ignored .env files it was refused over
// allowed; DELETE drops the ask.
func (a *agentAPI) handleFinishEnv(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "POST, DELETE")
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !requireWriteRole(w, r) {
		return
	}
	if !canGrant(r) {
		writeJobError(w, errFinishEnvPWAOnly)
		return
	}
	if a.jobs == nil {
		writeJobError(w, errJobsUnavailable)
		return
	}
	id := r.PathValue("id")
	j, ok := a.jobs.job(id)
	if !validTemplateID(id) || !ok {
		writeJobError(w, errJobNotFound)
		return
	}
	_, via := auditWho(r)
	if r.Method == http.MethodDelete {
		if _, ok := a.finishEnv.get(id); ok {
			a.finishEnv.drop(id)
			auditf("job_env_dismissed", "job", id, "via", via)
		}
		jsonOK(w, map[string]any{"job": a.viewJob(j)})
		return
	}
	var in finishEnvInput
	r.Body = http.MaxBytesReader(w, r.Body, finishEnvBody)
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			writeJobError(w, errJobsTooLarge)
		} else {
			jsonErrorCode(w, "invalid_request", "invalid JSON body", http.StatusBadRequest)
		}
		return
	}
	if in.Updated == "" || len(in.Files) == 0 {
		jsonErrorCode(w, "invalid_request", "updated and files are required", http.StatusBadRequest)
		return
	}
	ask, ok := a.finishEnv.get(id)
	if !ok {
		writeJobError(w, errFinishEnvNone)
		return
	}
	if !sameEnvNames(ask.files, in.Files) {
		writeJobError(w, errFinishEnvChanged)
		return
	}
	auditf("job_env_confirmed", "job", id, "files", len(ask.files), "via", via)
	res, closed, err := a.finishJob(r.Context(), w, id, jobFinishInput{Updated: in.Updated, By: ask.by, Close: ask.close,
		RemoveWorktree: true, envOK: ask.files})
	if err != nil {
		finishError(w, err, closed)
		return
	}
	jsonOK(w, res)
}

// sameEnvNames: a and b hold the same names, exactly, in any order.
func sameEnvNames(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x, y := slices.Clone(a), slices.Clone(b)
	slices.Sort(x)
	slices.Sort(y)
	return slices.Equal(x, y)
}
