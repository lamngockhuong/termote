package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"
)

const (
	// createMaxParts and createMaxPath bound the path a create takes: every
	// component is a directory the walk opens.
	createMaxParts = 32
	createMaxPath  = 1024
	// createMaxName is the longest component most file systems take.
	createMaxName = 255
)

var (
	errCreateExists      = &rawError{"exists", "a file or directory of that name already exists", http.StatusConflict}
	errCreateNotDir      = &rawError{"not_directory", "a parent on that path is not a directory", http.StatusConflict}
	errCreateSymlink     = &rawError{"symlink", "a directory on that path is a symbolic link", http.StatusForbidden}
	errCreateNotAllowed  = &rawError{"not_allowed", "path not allowed", http.StatusForbidden}
	errCreateInvalidName = &rawError{"invalid_name", "invalid file name", http.StatusBadRequest}
)

// createExistsError: the name asked for is taken. path is that name cleaned,
// as a create would have reported it, so the client opens what is there
// without parsing its own input ('\' separates directories on Windows).
type createExistsError struct{ path string }

func (e *createExistsError) Error() string { return errCreateExists.msg }
func (e *createExistsError) Unwrap() error { return errCreateExists }

// createBeforeLock runs right before a create waits on its root's lock; only
// tests set it, to hold creates there.
var createBeforeLock = func() {}

// createBeforeOpenDir runs between a directory's checks and its open; only
// tests set it, to swap the directory in between.
var createBeforeOpenDir = func(dir *os.Root, name string) {}

type createRequest struct {
	Path   string `json:"path"`
	Reveal bool   `json:"reveal"`
}

type createResponse struct {
	Root string `json:"root"`
	Path string `json:"path"`
}

// handleCreateFile serves POST files/create?root=: it creates an empty file,
// and the directories missing above it, under the pane's root. The contents
// go through PUT files/content. writeGuard has refused a cross-site or
// non-JSON POST already.
func (f *filesAPI) handleCreateFile(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	// As for a save: a create never lands in a pane's new directory because
	// the request left the root out.
	if r.URL.Query().Get("root") == "" {
		f.error(w, "files create", errRootRequired)
		return
	}
	req, cancel, ok := f.start(w, r, requireFilesWrite)
	if !ok {
		return
	}
	defer cancel()
	// Read before taking a slot: a slow body never holds one.
	var in createRequest
	if !decodeJSON(w, r, &in) {
		return
	}
	res, err := f.createFile(req.root, in)
	var ee *createExistsError
	if errors.As(err, &ee) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(errCreateExists.status)
		json.NewEncoder(w).Encode(map[string]string{"error": ee.Error(), "code": errCreateExists.code, "path": ee.path})
		return
	}
	if err != nil {
		f.error(w, "files create", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(res)
}

// createFile creates in.Path under root as an empty file, never replacing
// anything. The directories above it are walked one level at a time, each
// opened from the one before: none may be a symlink, each opened is the one
// checked, and each is checked against the denied dirs once it exists,
// before anything is created inside it (a path that does not exist yet can
// only be compared by name, which misses an 8.3 name or a junction).
// Directories made before a later step fails stay, as with mkdir -p.
func (f *filesAPI) createFile(root filesRoot, in createRequest) (createResponse, error) {
	// cleanRelPath also refuses a Windows device name (NUL, CON, ...).
	rel, err := cleanRelPath(in.Path)
	if err != nil || !validCreateName(in.Path) {
		return createResponse{}, errCreateInvalidName
	}
	if f.createDenied(root, rel) {
		return createResponse{}, errCreateNotAllowed
	}
	if sensitivePath(root.Root, rel) && !in.Reveal {
		return createResponse{}, errEditSensitive
	}
	// One lock per root: two creates never race on each other's
	// directories, and the lock map grows with roots, not paths tried.
	// Taken before a write slot, so a create waiting on another one in the
	// same root holds no slot a save could have used; once it has the lock,
	// a create only waits on the disk.
	createBeforeLock()
	unlock := f.writeLocks.lock(root.Root + "\x00create")
	defer unlock()
	select {
	case f.writeSlots <- struct{}{}:
		defer func() { <-f.writeSlots }()
	default:
		return createResponse{}, errEditBusy
	}

	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return createResponse{}, err
	}
	dir, err := f.walkParents(rt, root, filepath.Dir(rel))
	if err != nil {
		return createResponse{}, createError(err)
	}
	defer dir.Close()
	fh, err := dir.OpenFile(filepath.Base(rel), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		if err = createError(err); err == errCreateExists {
			err = &createExistsError{filepath.ToSlash(rel)}
		}
		return createResponse{}, err
	}
	fh.Close()
	// The Changes view lists the new file right away.
	f.statuses.forgetPrefix(root.Root + "\x00")
	return createResponse{Root: root.Root, Path: filepath.ToSlash(rel)}, nil
}

// createDenied reports whether a create may not touch rel: the repo's git
// dir, a deny dir, or a dir a save never writes to.
func (f *filesAPI) createDenied(root filesRoot, rel string) bool {
	return f.denied(root.Root, rel, root.GitDir) || f.denied(root.Root, rel, f.writeDeny...)
}

// walkParents opens parent under rt, making each directory missing on the
// way. It takes rt: every directory but the one returned (which may be rt)
// is closed, and the caller closes that one.
func (f *filesAPI) walkParents(rt *os.Root, root filesRoot, parent string) (*os.Root, error) {
	cur, walked := rt, "."
	var parts []string
	if parent != "." {
		parts = strings.Split(parent, string(filepath.Separator))
	}
	for _, part := range parts {
		if f.createDenied(root, walked) {
			cur.Close()
			return nil, errCreateNotAllowed
		}
		next, err := openChildDir(cur, part)
		cur.Close()
		if err != nil {
			return nil, err
		}
		cur, walked = next, filepath.Join(walked, part)
	}
	if f.createDenied(root, walked) {
		cur.Close()
		return nil, errCreateNotAllowed
	}
	return cur, nil
}

// openChildDir opens the directory name in cur, making it when missing. A
// symlink is refused, and so is a directory swapped after its checks: the
// one opened must be the one checked.
func openChildDir(cur *os.Root, name string) (*os.Root, error) {
	fi, err := cur.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		// Made in between by another process: use it like one found.
		if err = cur.Mkdir(name, 0o777); err == nil || errors.Is(err, fs.ErrExist) {
			fi, err = cur.Lstat(name)
		}
	}
	if err != nil {
		return nil, err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return nil, errCreateSymlink
	}
	if !fi.IsDir() {
		return nil, errCreateNotDir
	}
	createBeforeOpenDir(cur, name)
	next, err := cur.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	opened, err := next.Stat(".")
	if err == nil && !os.SameFile(opened, fi) {
		err = errCreateSymlink
	}
	if err != nil {
		next.Close()
		return nil, err
	}
	return next, nil
}

// createError turns an OS error of a create into the one the client is told.
func createError(err error) error {
	var re *rawError
	switch {
	case errors.As(err, &re):
		return err
	case isStorageFull(err):
		return errStorageFull
	// A read-only mount, not the permissions, refused the write
	case isReadOnlyFS(err):
		return errReadOnlyFiles
	// Windows answers an O_EXCL open of a directory with EISDIR
	case errors.Is(err, fs.ErrExist), errors.Is(err, syscall.EISDIR):
		return errCreateExists
	case errors.Is(err, syscall.ENOTDIR):
		return errCreateNotDir
	case errors.Is(err, fs.ErrPermission):
		return errEditPermission
	case isPathEscape(err):
		// Only a symlink swapped in leads out of the root.
		return errCreateSymlink
	}
	return err
}

// validCreateName checks the path a create takes before anything touches the
// disk: no empty component (a leading, doubled or trailing separator), at
// most createMaxParts components and createMaxPath bytes, no component longer
// than createMaxName or ending in a dot or a space (Windows drops those, so
// "a." would open "a"), no control character (files/raw refuses a name with
// a line break), none of the characters the OS refuses, and never a name a
// save uses for its temporary file.
func validCreateName(p string) bool {
	if p == "" || len(p) > createMaxPath || strings.ContainsRune(p, 0) || strings.HasSuffix(p, `\`) {
		return false
	}
	parts := strings.Split(filepath.ToSlash(p), "/")
	if len(parts) > createMaxParts {
		return false
	}
	for _, part := range parts {
		if part == "" || len(part) > createMaxName || strings.HasSuffix(part, ".") ||
			strings.HasSuffix(part, " ") || strings.ContainsFunc(part, unicode.IsControl) ||
			strings.ContainsAny(part, createBadChars) {
			return false
		}
	}
	return !editTempRe.MatchString(parts[len(parts)-1])
}
