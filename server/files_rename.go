package main

import (
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// renameTempPrefix names where a rename puts a file between its two moves
// when the new name differs only in case (renameViaTemp). Never swept: if
// the server stops in between, the file left there is the user's.
const renameTempPrefix = ".termote-rename-"

// renameTempRe matches exactly the names a rename gives its temporary file.
var renameTempRe = regexp.MustCompile(`^` + regexp.QuoteMeta(renameTempPrefix) + `[0-9a-f]{16}$`)

var (
	errRenameInUse       = &codedError{"in_use", "the file is open in another program", http.StatusConflict}
	errRenameCrossDevice = &codedError{"cross_device", "the new path is on another file system", http.StatusConflict}
)

// Test hooks: renameMove makes every move of a rename toward its new name,
// never replacing anything; renameBeforeMove runs right before it, so a
// test can swap the file in between; renameOwnedByServer is the owner check.
var (
	renameMove          = renameNoReplaceChecked
	renameBeforeMove    = func(dir *os.Root, base string) {}
	renameOwnedByServer = fileOwnedByServer
)

// renameChangedError: the file was swapped while it was renamed, and what
// was moved could not go back. path is where it is now.
type renameChangedError struct{ path string }

func (e *renameChangedError) Error() string { return errEditChanged.msg }

type renameRequest struct {
	Path    string `json:"path"`
	NewPath string `json:"newPath"`
	Reveal  bool   `json:"reveal"`
}

// handleRenameFile serves POST files/rename?root=: a file moves to a new
// path under the same root, never replacing anything there. writeGuard has
// refused a cross-site or non-JSON POST already.
func (f *filesAPI) handleRenameFile(w http.ResponseWriter, r *http.Request) {
	var in renameRequest
	req, cancel, ok := f.startJSONWrite(w, r, "files rename", &in)
	if !ok {
		return
	}
	defer cancel()
	res, err := f.renameFile(req.root, in)
	if err != nil {
		f.error(w, "files rename", err)
		return
	}
	jsonOK(w, res)
}

// renameFile moves in.Path to in.NewPath under root. The source is checked
// as a delete checks it, the new path as a create checks a new name; the
// directories missing above the new path are made, and stay if a later step
// fails, as with mkdir -p.
func (f *filesAPI) renameFile(root filesRoot, in renameRequest) (createResponse, error) {
	src, err := cleanRelPath(in.Path)
	if err != nil || src == "." {
		return createResponse{}, errDeleteInvalidPath
	}
	// cleanRelPath also refuses a Windows device name (NUL, CON, ...).
	dst, err := cleanRelPath(in.NewPath)
	if err != nil || dst == "." || !validRenameTarget(in.NewPath) {
		return createResponse{}, errCreateInvalidName
	}
	if f.createDenied(root, src) || f.createDenied(root, dst) {
		return createResponse{}, errCreateNotAllowed
	}
	if (sensitivePath(root.Root, src) || sensitivePath(root.Root, dst)) && !in.Reveal {
		return createResponse{}, errEditSensitive
	}
	unlock, err := f.lockRename(root.Root, src, dst)
	if err != nil {
		return createResponse{}, err
	}
	defer unlock()
	srcDir, err := f.openParent(root, src, nil)
	if err != nil {
		return createResponse{}, deleteError(err)
	}
	defer srcDir.Close()
	base := filepath.Base(src)
	fi, err := renameSourceInfo(srcDir, base)
	if err != nil {
		return createResponse{}, err
	}
	res := createResponse{Root: root.Root, Path: filepath.ToSlash(src)}
	if dst == src {
		return res, nil
	}
	dstDir, err := f.openParent(root, dst, validNamePart)
	if err != nil {
		return createResponse{}, createError(err)
	}
	defer dstDir.Close()
	newBase := filepath.Base(dst)
	if newBase == base && sameDir(srcDir, dstDir) {
		// Only the directories' case differs, on a file system that ignores
		// it: renaming a directory is not done here.
		return res, nil
	}
	if err := moveFile(srcDir, base, dstDir, newBase, fi, src, dst); err != nil {
		var rc *renameChangedError
		if errors.As(err, &rc) {
			// A file moved and stayed elsewhere: the lists must see it
			f.forgetRoot(root.Root)
		}
		return createResponse{}, err
	}
	// The tree, Changes and find all see the file at its new path.
	f.forgetRoot(root.Root)
	res.Path = filepath.ToSlash(dst)
	return res, nil
}

// lockRename takes the root's lock, then both files' locks (shared with
// saves) in the order of their keys, so two renames crossing each other
// never wait on each other, then a write slot without waiting.
func (f *filesAPI) lockRename(root, src, dst string) (func(), error) {
	first, second := fileLockKey(root, src), fileLockKey(root, dst)
	if second < first {
		first, second = second, first
	}
	unlockRoot := f.writeLocks.lock(rootLockKey(root))
	unlockFirst := f.writeLocks.lock(first)
	unlockSecond := func() {}
	if second != first {
		unlockSecond = f.writeLocks.lock(second)
	}
	unlock := func() { unlockSecond(); unlockFirst(); unlockRoot() }
	select {
	case f.writeSlots <- struct{}{}:
		return func() { <-f.writeSlots; unlock() }, nil
	default:
		unlock()
		return nil, errEditBusy
	}
}

// openParent opens the directory above rel, one level at a time (walkParentsNew;
// validNew set: missing ones are made).
func (f *filesAPI) openParent(root filesRoot, rel string, validNew func(string) bool) (*os.Root, error) {
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return nil, err
	}
	return f.walkParentsNew(rt, root, filepath.Dir(rel), validNew)
}

// sameDir reports whether a and b are one directory.
func sameDir(a, b *os.Root) bool {
	ai, err := a.Stat(".")
	if err != nil {
		return false
	}
	bi, err := b.Stat(".")
	return err == nil && os.SameFile(ai, bi)
}

// renameSourceInfo checks base in dir can be renamed: not a symlink, a
// regular file, the server user's (Unix). It is never opened: renaming
// writes only its directory, and what lands is checked afterwards.
func renameSourceInfo(dir *os.Root, base string) (fs.FileInfo, error) {
	fi, err := dir.Lstat(base)
	if err != nil {
		return nil, deleteError(err)
	}
	if fi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
		return nil, errCreateSymlink
	}
	if !fi.Mode().IsRegular() {
		return nil, errDeleteNotFile
	}
	if !renameOwnedByServer(fi) {
		return nil, errEditPermission
	}
	return fi, nil
}

// moveFile moves base of srcDir (the file fi describes) to newBase of
// dstDir, never replacing anything, then checks what landed is that file.
func moveFile(srcDir *os.Root, base string, dstDir *os.Root, newBase string, fi fs.FileInfo, src, dst string) error {
	there, err := dstDir.Lstat(newBase)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		renameBeforeMove(srcDir, base)
		if err := renameMove(srcDir, base, dstDir, newBase, fi); err != nil {
			return renameError(err, dst)
		}
	case err != nil:
		return renameError(err, dst)
	case os.SameFile(there, fi) && strings.EqualFold(src, dst):
		// The new name is the file itself, differing only in case on a file
		// system that ignores it: no move toward it can avoid "exists".
		if err := renameViaTemp(srcDir, base, dstDir, newBase, fi, src, dst); err != nil {
			return err
		}
	default:
		// Anything else, another hard link of the file included
		return &createExistsError{filepath.ToSlash(dst)}
	}
	// What landed must be what was checked: a file swapped in between goes
	// back where it was, never replacing anything.
	if moved, err := dstDir.Lstat(newBase); err != nil || !os.SameFile(moved, fi) {
		if err := renameNoReplace(dstDir, newBase, srcDir, base); err != nil {
			log.Printf("files rename: moving back %s: %v", dst, err)
			return &renameChangedError{filepath.ToSlash(dst)}
		}
		return errEditChanged
	}
	return nil
}

// renameViaTemp moves base to newBase in two moves through a temporary name
// in srcDir, each never replacing anything: no plain rename, which would
// replace a file swapped in between the check and the move.
func renameViaTemp(srcDir *os.Root, base string, dstDir *os.Root, newBase string, fi fs.FileInfo, src, dst string) error {
	tmp := renameTempPrefix + randomHex(8)
	renameBeforeMove(srcDir, base)
	if err := renameMove(srcDir, base, srcDir, tmp, fi); err != nil {
		return renameError(err, dst)
	}
	if err := renameMove(srcDir, tmp, dstDir, newBase, fi); err != nil {
		if back := renameNoReplace(srcDir, tmp, srcDir, base); back != nil {
			at := filepath.ToSlash(filepath.Join(filepath.Dir(src), tmp))
			log.Printf("files rename: moving back %s: %v", at, back)
			return &renameChangedError{at}
		}
		return renameError(err, dst)
	}
	return nil
}

// renameError turns an OS error of a move into the one the client is told.
func renameError(err error, dst string) error {
	switch {
	case isInUse(err):
		return errRenameInUse
	case isCrossDevice(err):
		return errRenameCrossDevice
	}
	if err = createError(err); err == errCreateExists {
		return &createExistsError{filepath.ToSlash(dst)}
	}
	return err
}
