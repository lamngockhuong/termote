package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// discardMax caps what a discard reads, keeps and writes: the limit of the
// edit helpers it writes through (readEditTarget, replaceFile).
const discardMax = maxPreviewSize

var (
	errInvalidAction    = &codedError{"invalid_action", "action must be stage, unstage or discard", http.StatusBadRequest}
	errApplyConflict    = &codedError{"conflict", "the file has a merge conflict; resolve it in a terminal", http.StatusConflict}
	errApplyUnsupported = &codedError{"unsupported", "this change cannot be applied here; use a terminal", http.StatusConflict}
	errFiltered         = &codedError{"filtered", "the file goes through a git filter (such as LFS); use a terminal", http.StatusConflict}
	errIndexLocked      = &codedError{"index_locked", "another git command holds the index lock", http.StatusConflict}
)

// The status letters each action takes, on the side it acts on.
var applyLetters = map[string]string{"stage": "MD?", "unstage": "MADRC", "discard": "MD?"}

// Test hooks: each runs right before the step it names, so a test can
// change the file in between: a discard reading the file it replaces, and a
// discard or a restore writing it.
var (
	applyBeforeRead  = func() {}
	applyBeforeWrite = func() {}
)

type applyRequest struct {
	Action string `json:"action"` // stage | unstage | discard
	Path   string `json:"path"`
	Orig   string `json:"orig"`
	// Hunk is the id of one hunk of the path's diff (diffHunk.ID); empty
	// for the whole file.
	Hunk string `json:"hunk"`
	// BaseHash is the sha256 of the file the client saw: required by a
	// discard of a whole changed or untracked file.
	BaseHash string `json:"baseHash"`
	Reveal   bool   `json:"reveal"`
	// Permanent: an untracked file on another file system than the trash is
	// deleted (the client asked again), as files/delete does.
	Permanent bool `json:"permanent"`
}

type applyResponse struct {
	Root      string `json:"root"`
	Path      string `json:"path"`
	TrashID   string `json:"trashId,omitempty"`
	Permanent bool   `json:"permanent,omitempty"`
}

// handleApplyChange serves POST files/changes/apply?root=: it stages,
// unstages or discards a file git status lists, or one hunk of its diff.
// writeGuard has refused a cross-site or non-JSON POST already.
func (f *filesAPI) handleApplyChange(w http.ResponseWriter, r *http.Request) {
	var in applyRequest
	req, cancel, ok := f.startJSONWrite(w, r, "files apply", &in)
	if !ok {
		return
	}
	defer cancel()
	res, err := f.applyChange(req.ctx, req.root, in)
	if err != nil {
		f.error(w, "files apply", err)
		return
	}
	jsonOK(w, res)
}

// applyChange checks in against a fresh git status, then runs it. Every
// read (status, attributes, diff, the index version) comes before the
// first write.
func (f *filesAPI) applyChange(ctx context.Context, root filesRoot, in applyRequest) (applyResponse, error) {
	letters, ok := applyLetters[in.Action]
	if !ok {
		return applyResponse{}, errInvalidAction
	}
	if in.Action == "discard" && f.trash == nil {
		return applyResponse{}, errTrashUnavailable
	}
	rel, err := cleanRelPath(in.Path)
	if err != nil || rel == "." {
		return applyResponse{}, errDeleteInvalidPath
	}
	if f.createDenied(root, rel) {
		return applyResponse{}, errCreateNotAllowed
	}
	if in.Orig != "" {
		orel, err := cleanRelPath(in.Orig)
		if err != nil || orel == "." || f.createDenied(root, orel) {
			return applyResponse{}, errCreateNotAllowed
		}
	}
	if !root.IsRepo {
		return applyResponse{}, errNotChanged
	}
	unlock, err := f.lockWrite(root.Root, rel)
	if err != nil {
		return applyResponse{}, err
	}
	defer unlock()
	f.forgetRoot(root.Root)
	st, err := f.status(ctx, root)
	if err != nil {
		return applyResponse{}, err
	}
	// Before findChange: a conflict has nothing on its staged side.
	for _, e := range st.Entries {
		if e.Conflict && (e.Path == in.Path || in.Orig != "" && e.Path == in.Orig) {
			return applyResponse{}, errApplyConflict
		}
	}
	staged := in.Action == "unstage"
	entry := findChange(st, in.Path, in.Orig, staged)
	if entry == nil {
		return applyResponse{}, errNotChanged
	}
	letter := entry.Unstaged
	if staged {
		letter = entry.Staged
	}
	if !strings.Contains(letters, letter) || in.Action == "discard" && !discardable(entry) {
		return applyResponse{}, errApplyUnsupported
	}
	if (entry.Sensitive || sensitivePath(root.Root, rel)) && !in.Reveal {
		return applyResponse{}, errEditSensitive
	}
	if err := f.checkFilters(ctx, root, in.Path, in.Orig); err != nil {
		return applyResponse{}, err
	}
	res := applyResponse{Root: root.Root, Path: filepath.ToSlash(rel)}
	switch {
	case in.Action == "discard":
		res, err = f.discardChange(ctx, root, rel, entry, in, res)
	case in.Hunk != "":
		err = f.applyHunk(ctx, root, in, staged)
	case staged:
		err = f.unstageFile(ctx, root, in)
	default:
		err = f.gitWrite(ctx, root, nil, "add", "--", ":(literal)"+in.Path)
	}
	if err != nil {
		return applyResponse{}, err
	}
	f.forgetRoot(root.Root)
	return res, nil
}

// discardable reports whether a discard can write entry back: never a
// symlink or a submodule on either side.
func discardable(e *changeEntry) bool {
	for _, m := range []string{e.modeIndex, e.modeWorktree} {
		if m == "120000" || m == "160000" {
			return false
		}
	}
	return true
}

// checkFilters refuses a path with any filter attribute: the filter
// drivers are off (gitRunner), so git add would stage what the clean filter
// should have turned into something else, and one set at the system level
// cannot even be seen. check-attr takes names, not pathspecs.
func (f *filesAPI) checkFilters(ctx context.Context, root filesRoot, paths ...string) error {
	var in bytes.Buffer
	for _, p := range paths {
		if p != "" {
			in.WriteString(p + "\x00")
		}
	}
	out, _, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, noFilters: true, stdin: in.Bytes()},
		"check-attr", "--stdin", "-z", "filter")
	if err != nil {
		return err
	}
	// <path> NUL filter NUL <value> NUL, for each path.
	recs := strings.Split(string(out), "\x00")
	for i := 2; i < len(recs); i += 3 {
		if v := recs[i]; v != "unspecified" && v != "unset" {
			return errFiltered
		}
	}
	return nil
}

// gitWrite runs a git command that writes the index (gitCall.write). git's
// own message is logged, never returned.
func (f *filesAPI) gitWrite(ctx context.Context, root filesRoot, stdin []byte, args ...string) error {
	_, _, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, noFilters: true,
		heavy: true, noBackoff: true, write: true, stdin: stdin}, args...)
	var ge *gitError
	if errors.As(err, &ge) && strings.Contains(ge.stderr, "index.lock") {
		return errIndexLocked
	}
	return err
}

// unstageFile puts the file's HEAD version back in the index, or drops it
// from the index when there is no commit yet (restore --staged cannot
// resolve HEAD then, and rm --cached refuses a file changed since).
func (f *filesAPI) unstageFile(ctx context.Context, root filesRoot, in applyRequest) error {
	_, _, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, limit: 4096},
		"rev-parse", "--verify", "-q", "HEAD")
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() == 1 {
		return f.gitWrite(ctx, root, nil, "reset", "-q", "--", ":(literal)"+in.Path)
	}
	if err != nil {
		return err
	}
	args := []string{"restore", "--staged", "--", ":(literal)" + in.Path}
	if in.Orig != "" {
		args = append(args, ":(literal)"+in.Orig)
	}
	return f.gitWrite(ctx, root, nil, args...)
}

// findHunk takes the path's diff afresh and returns the hunk in.Hunk names.
func (f *filesAPI) findHunk(ctx context.Context, root filesRoot, in applyRequest, staged bool) (*diffHunk, error) {
	d, err := f.diff(ctx, root, in.Path, in.Orig, staged, true)
	if err != nil {
		return nil, err
	}
	if len(d.Hunks) == 0 || d.Hunks[0].ID == "" {
		return nil, errHunkUnsupported
	}
	for i := range d.Hunks {
		if d.Hunks[i].ID == in.Hunk {
			return &d.Hunks[i], nil
		}
	}
	return nil, errStaleHunk
}

// applyHunk stages or unstages one hunk: the patch is built here from git's
// own diff, and only the index is written.
func (f *filesAPI) applyHunk(ctx context.Context, root filesRoot, in applyRequest, staged bool) error {
	h, err := f.findHunk(ctx, root, in, staged)
	if err != nil {
		return err
	}
	args := []string{"-c", "apply.ignoreWhitespace=no", "apply", "--cached", "-p1", "--whitespace=nowarn"}
	if staged {
		args = append(args, "-R")
	}
	err = f.gitWrite(ctx, root, hunkPatch(h.raw, in.Path), append(args, "-")...)
	var ge *gitError
	if errors.As(err, &ge) {
		return errStaleHunk
	}
	return err
}

// indexPerm is the permissions a file of the index mode gets.
func indexPerm(mode string) fs.FileMode {
	if mode == "100755" {
		return 0o755
	}
	return 0o644
}

// discardChange makes the worktree file what the index holds, the whole
// file or one hunk. Git never writes the worktree: an untracked file goes
// through the delete route's code, a deleted one is created again, and a
// changed one is kept in the trash, then replaced by replaceFile (which
// narrows, without closing, the race with another writer, as a save does).
func (f *filesAPI) discardChange(ctx context.Context, root filesRoot, rel string, e *changeEntry, in applyRequest, res applyResponse) (applyResponse, error) {
	if in.Hunk != "" && e.Unstaged != "M" {
		return applyResponse{}, errHunkUnsupported
	}
	switch e.Unstaged {
	case "?":
		if in.BaseHash == "" {
			return applyResponse{}, errBaseHashNeeded
		}
		del, err := f.deleteFileLocked(root, rel, deleteRequest{Path: in.Path, Kind: "file", BaseHash: in.BaseHash, Reveal: in.Reveal, Permanent: in.Permanent})
		if err != nil {
			return applyResponse{}, err
		}
		res.TrashID, res.Permanent = del.TrashID, del.Permanent
		return res, nil
	case "D":
		b, err := f.indexVersion(ctx, root, in.Path)
		if err != nil {
			return applyResponse{}, err
		}
		return res, f.recreate(root, rel, b, indexPerm(e.modeIndex))
	}
	var (
		h    *diffHunk
		want []byte
	)
	if in.Hunk != "" {
		var err error
		if h, err = f.findHunk(ctx, root, in, false); err != nil {
			return applyResponse{}, err
		}
	} else {
		if in.BaseHash == "" {
			return applyResponse{}, errBaseHashNeeded
		}
		var err error
		if want, err = f.indexVersion(ctx, root, in.Path); err != nil {
			return applyResponse{}, err
		}
	}
	applyBeforeRead()
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return applyResponse{}, err
	}
	defer rt.Close()
	dir, base, reason, err := openEditDir(rt, rel)
	if err != nil {
		return applyResponse{}, err
	}
	if reason != "" {
		return applyResponse{}, editReasonError(reason)
	}
	defer dir.Close()
	cur, fi, reason, err := readEditTarget(dir, base)
	if err != nil {
		return applyResponse{}, err
	}
	if reason != "" {
		return applyResponse{}, editReasonError(reason)
	}
	perm := fi.Mode().Perm()
	if h != nil {
		if want, err = reverseHunk(cur, *h); err != nil {
			return applyResponse{}, err
		}
		// Only line breaks differ (a CRLF file against an LF index without
		// autocrlf): undone line by line, the file would not change.
		if bytes.Equal(want, cur) {
			return applyResponse{}, errApplyUnsupported
		}
	} else {
		if hashHex(cur) != in.BaseHash {
			return applyResponse{}, errEditChanged
		}
		if e.modeIndex != e.modeWorktree {
			perm = indexPerm(e.modeIndex)
		}
	}
	id, err := f.trash.keepCopy(trashRecord{
		Root: root.Root, Path: res.Path, Kind: "discard", DeletedAt: f.trash.now(),
		Size: int64(len(cur)), Mode: fi.Mode().Perm(), After: hashHex(want),
	}, cur)
	if err != nil {
		return applyResponse{}, trashError(err)
	}
	sweepEditTemps(dir, time.Now())
	applyBeforeWrite()
	if err := replaceFile(dir, base, want, perm, cur); err != nil {
		f.trash.removeEntry(id)
		return applyResponse{}, saveError(err)
	}
	res.TrashID = id
	return res, nil
}

// recreate writes b as the deleted file rel, making the directories above
// it, never over a file that came back in the meantime.
func (f *filesAPI) recreate(root filesRoot, rel string, b []byte, perm fs.FileMode) error {
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return err
	}
	parent, err := f.walkParents(rt, root, filepath.Dir(rel), true)
	if err != nil {
		return createError(err)
	}
	defer parent.Close()
	applyBeforeWrite()
	fh, err := parent.OpenFile(filepath.Base(rel), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return errEditChanged
	}
	if err != nil {
		return createError(err)
	}
	_, err = fh.Write(b)
	if err == nil {
		// On the handle: the name may lead elsewhere by now.
		err = fh.Chmod(perm)
	}
	if cerr := fh.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		parent.Remove(filepath.Base(rel))
		return saveError(err)
	}
	return nil
}

// indexVersion reads path's index version as checkout would write it
// (--filters: line breaks and ident; the filter drivers are off), at most
// discardMax bytes. The size is checked before anything is read.
func (f *filesAPI) indexVersion(ctx context.Context, root filesRoot, path string) ([]byte, error) {
	c := gitCall{root: root.Root, safeDir: root.SafeDir, noFilters: true, heavy: true, noBackoff: true, limit: 64}
	out, _, err := f.git.output(ctx, c, "cat-file", "-s", ":0:"+path)
	if err != nil {
		return nil, err
	}
	size, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return nil, err
	}
	if size > discardMax {
		return nil, errEditTooLarge
	}
	c.limit = discardMax
	out, cut, err := f.git.output(ctx, c, "cat-file", "--filters", ":0:"+path)
	if err != nil {
		return nil, err
	}
	if cut {
		// The line breaks made it grow past the limit.
		return nil, errEditTooLarge
	}
	return out, nil
}

// restoreDiscard puts back what a discard replaced, under the restore's
// locks: only while the file still holds exactly what the discard left
// (rec.After), read through the save's checks (no symlink on the way, a
// regular file with one link, the server user's), and written by
// replaceFile. Anything else is errEditChanged and the file stays.
func (f *filesAPI) restoreDiscard(root filesRoot, rel, id string, rec trashRecord) error {
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return err
	}
	defer rt.Close()
	// A directory on the way gone, turned into a file or a symlink: the
	// path no longer leads to the file the discard wrote.
	dir, base, reason, err := openEditDir(rt, rel)
	if err != nil || reason != "" {
		return errEditChanged
	}
	defer dir.Close()
	cur, _, reason, err := readEditTarget(dir, base)
	switch {
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, errEditTooLarge), errors.Is(err, errEditChanged):
		return errEditChanged
	case err != nil:
		return err
	case reason != "" || hashHex(cur) != rec.After:
		return errEditChanged
	}
	// As readRecordLocked reads the record: the store is private.
	fh, err := os.Open(filepath.Join(f.trash.dir, id))
	if err != nil {
		return restoreError(err)
	}
	kept, err := io.ReadAll(io.LimitReader(fh, discardMax+1))
	fh.Close()
	if err != nil {
		return err
	}
	if len(kept) > discardMax {
		return errEditTooLarge
	}
	applyBeforeWrite()
	if err := replaceFile(dir, base, kept, rec.Mode.Perm(), cur); err != nil {
		return saveError(err)
	}
	return nil
}
