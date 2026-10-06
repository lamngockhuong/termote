package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// deleteHashMax caps the file a delete (and content?hash=1) hashes; a larger
// one is deleted from a terminal.
var deleteHashMax int64 = 512 << 20

var (
	errDeleteInvalidPath = &rawError{"invalid_path", "invalid path", http.StatusBadRequest}
	errDeleteNotFile     = &rawError{"not_file", "not a regular file", http.StatusConflict}
	errDeleteNotDir      = &rawError{"not_directory", "not a directory", http.StatusConflict}
	errDeleteNotEmpty    = &rawError{"not_empty", "the directory is not empty", http.StatusConflict}
	errDeleteHardlink    = &rawError{"hardlink", "the file has several hard links", http.StatusConflict}
	errDeleteTooLarge    = &rawError{"too_large", "file is larger than 512 MiB", http.StatusRequestEntityTooLarge}
	errDeleteKind        = inputError("kind must be file or dir")
)

// Test hooks: each runs right before the step it names, so a test can swap
// what is on the disk in between.
var (
	// trashRename moves a file into the trash (under a new random name),
	// trashRestore moves it back, never replacing what is there; tests
	// replace them to act as another file system.
	trashRename        = renameIntoTrash
	trashRestore       = renameNoReplace
	deleteBeforeRename = func(dir *os.Root, base string) {}
	deleteBeforeUnlink = func(dir *os.Root, base string) {}
	deleteBeforeRmdir  = func(dir *os.Root, base string) {}
	deleteBeforeOpen   = func(dir *os.Root, base string) {}
	restoreBeforeLock  = func() {}
)

// deleteChangedError: the file was swapped between its checks and its move
// into the trash, and what was moved could not go back (the name was taken
// again). It stays in the trash under trashID.
type deleteChangedError struct{ trashID string }

func (e *deleteChangedError) Error() string { return errEditChanged.msg }

type deleteRequest struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"` // file | dir
	BaseHash string `json:"baseHash"`
	Reveal   bool   `json:"reveal"`
	// Permanent: delete the file when the trash is on another file system
	// (the client asked again). The trash is still tried first.
	Permanent bool `json:"permanent"`
}

type deleteResponse struct {
	Root      string `json:"root"`
	Path      string `json:"path"`
	TrashID   string `json:"trashId,omitempty"`
	Size      int64  `json:"size,omitempty"`
	Permanent bool   `json:"permanent,omitempty"`
}

type restoreRequest struct {
	TrashID string `json:"trashId"`
	Reveal  bool   `json:"reveal"`
}

type restoreResponse struct {
	Root string `json:"root"`
	Path string `json:"path"`
}

// startWrite runs the checks every write of the trash routes starts with:
// POST, the root query, the files guards, the JSON body (read before any
// slot is taken) and a usable trash.
func (f *filesAPI) startWrite(w http.ResponseWriter, r *http.Request, op string, in any) (*filesRequest, func(), bool) {
	if !requireMethod(w, r, http.MethodPost) {
		return nil, nil, false
	}
	// As for a save: never in a pane's new directory because the request
	// left the root out.
	if r.URL.Query().Get("root") == "" {
		f.error(w, op, errRootRequired)
		return nil, nil, false
	}
	req, cancel, ok := f.start(w, r, requireFilesWrite)
	if !ok {
		return nil, nil, false
	}
	if !decodeJSON(w, r, in) {
		cancel()
		return nil, nil, false
	}
	if f.trash == nil {
		cancel()
		f.error(w, op, errTrashUnavailable)
		return nil, nil, false
	}
	return req, cancel, true
}

// handleDeleteFile serves POST files/delete?root=: a file goes to the trash
// (unless it is on another file system and the client asked for a
// permanent delete), an empty directory is removed. writeGuard has refused
// a cross-site or non-JSON POST already.
func (f *filesAPI) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	var in deleteRequest
	req, cancel, ok := f.startWrite(w, r, "files delete", &in)
	if !ok {
		return
	}
	defer cancel()
	res, err := f.deleteFile(req.root, in)
	if err != nil {
		f.error(w, "files delete", err)
		return
	}
	jsonOK(w, res)
}

// lockWrite takes, in this order, the root's lock, the file's lock (shared
// with saves) and a write slot without waiting. A save takes its slot
// before the file's lock, but this never waits on a slot, so the two never
// wait on each other.
func (f *filesAPI) lockWrite(root, rel string) (func(), error) {
	unlockRoot := f.writeLocks.lock(rootLockKey(root))
	unlockFile := f.writeLocks.lock(root + "\x00" + rel)
	select {
	case f.writeSlots <- struct{}{}:
		return func() { <-f.writeSlots; unlockFile(); unlockRoot() }, nil
	default:
		unlockFile()
		unlockRoot()
		return nil, errEditBusy
	}
}

// deleteFile deletes in.Path under root. The directories above it are
// opened one at a time without making any (walkParents): none may be a
// symlink or a junction, and each is checked against the deny lists.
func (f *filesAPI) deleteFile(root filesRoot, in deleteRequest) (deleteResponse, error) {
	rel, err := cleanRelPath(in.Path)
	if err != nil || rel == "." {
		return deleteResponse{}, errDeleteInvalidPath
	}
	if in.Kind != "file" && in.Kind != "dir" {
		return deleteResponse{}, errDeleteKind
	}
	if in.Kind == "file" && in.BaseHash == "" {
		return deleteResponse{}, errBaseHashNeeded
	}
	if f.createDenied(root, rel) {
		return deleteResponse{}, errCreateNotAllowed
	}
	if sensitivePath(root.Root, rel) && !in.Reveal {
		return deleteResponse{}, errEditSensitive
	}
	unlock, err := f.lockWrite(root.Root, rel)
	if err != nil {
		return deleteResponse{}, err
	}
	defer unlock()
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return deleteResponse{}, err
	}
	parent, err := f.walkParents(rt, root, filepath.Dir(rel), false)
	if err != nil {
		return deleteResponse{}, deleteError(err)
	}
	defer parent.Close()
	res := deleteResponse{Root: root.Root, Path: filepath.ToSlash(rel)}
	if in.Kind == "dir" {
		res.TrashID, err = f.deleteDir(parent, filepath.Base(rel), res)
	} else {
		res, err = f.deleteRegular(parent, filepath.Base(rel), in, res)
	}
	if err != nil {
		return deleteResponse{}, err
	}
	// The tree, Changes and find all see the file gone.
	f.forgetRoot(root.Root)
	return res, nil
}

// deleteRegular moves the regular file base of parent into the trash, after
// checking it is the one the client read (baseHash).
func (f *filesAPI) deleteRegular(parent *os.Root, base string, in deleteRequest, res deleteResponse) (deleteResponse, error) {
	fi, sum, err := hashDeleteTarget(parent, base)
	if err != nil {
		return deleteResponse{}, err
	}
	if sum != in.BaseHash {
		return deleteResponse{}, errEditChanged
	}
	s := f.trash
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	trash, err := s.open()
	if err != nil {
		return deleteResponse{}, trashError(err)
	}
	defer trash.Close()
	id := randomHex(16)
	rec := trashRecord{Root: res.Root, Path: res.Path, Kind: "file", DeletedAt: s.now(), Size: fi.Size()}
	if err := s.writeRecordLocked(id, rec); err != nil {
		return deleteResponse{}, trashError(err)
	}
	deleteBeforeRename(parent, base)
	if err := trashRename(parent, base, trash, id); err != nil {
		s.removeRecordLocked(id)
		if !isCrossDevice(err) {
			return deleteResponse{}, deleteError(err)
		}
		if !in.Permanent {
			return deleteResponse{}, errCrossDevice
		}
		return unlinkChecked(parent, base, fi, res)
	}
	// What landed in the trash must be what was checked: a file swapped
	// in between goes back where it was, never replacing anything.
	if moved, err := trash.Lstat(id); err != nil || !os.SameFile(moved, fi) {
		if trashRestore(trash, id, parent, base) != nil {
			return deleteResponse{}, &deleteChangedError{id}
		}
		s.removeRecordLocked(id)
		return deleteResponse{}, errEditChanged
	}
	res.TrashID, res.Size = id, fi.Size()
	return res, nil
}

// unlinkChecked deletes base for good, once it is still the file checked:
// the trash is on another file system and the client confirmed. Accepted
// risk: nothing unlinks by inode, so a file swapped in between the check and
// the unlink is the one removed; a local writer of the root has a shell anyway.
func unlinkChecked(parent *os.Root, base string, fi fs.FileInfo, res deleteResponse) (deleteResponse, error) {
	if now, err := parent.Lstat(base); err != nil || !os.SameFile(now, fi) {
		return deleteResponse{}, errEditChanged
	}
	deleteBeforeUnlink(parent, base)
	if err := unlinkAt(parent, base); err != nil {
		return deleteResponse{}, deleteError(err)
	}
	res.Permanent = true
	return res, nil
}

// hashDeleteTarget checks base in dir can be deleted and hashes it: not a
// symlink, a regular file, the one opened, one link, the server user's.
// Writing the file is not needed (a delete writes its directory).
func hashDeleteTarget(dir *os.Root, base string) (fs.FileInfo, string, error) {
	lfi, err := dir.Lstat(base)
	if err != nil {
		return nil, "", deleteError(err)
	}
	if lfi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
		return nil, "", errCreateSymlink
	}
	if !lfi.Mode().IsRegular() {
		return nil, "", errDeleteNotFile
	}
	deleteBeforeOpen(dir, base)
	fh, err := dir.OpenFile(base, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, "", deleteError(err)
	}
	// Closed before the move: Windows does not rename a file held open.
	defer fh.Close()
	// What was opened must be what was checked.
	fi, err := fh.Stat()
	if err != nil || !os.SameFile(lfi, fi) {
		return nil, "", errEditChanged
	}
	switch reason, err := editFileReason(fh, fi); {
	case err != nil:
		return nil, "", err
	case reason == "hardlink":
		return nil, "", errDeleteHardlink
	case reason == "other-owner":
		return nil, "", errEditPermission
	}
	sum, ok, err := hashHandle(fh)
	if err != nil {
		return nil, "", err
	}
	if !ok {
		return nil, "", errDeleteTooLarge
	}
	return fi, sum, nil
}

// hashHandle hashes what fh holds, up to deleteHashMax; ok is false past it.
func hashHandle(fh *os.File) (sum string, ok bool, err error) {
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(fh, deleteHashMax+1))
	if err != nil {
		return "", false, err
	}
	if n > deleteHashMax {
		return "", false, nil
	}
	return hex.EncodeToString(h.Sum(nil)), true, nil
}

// deleteDir removes the empty directory base of parent, recording it so a
// restore makes it again. The record goes first: a directory is never gone
// without one.
func (f *filesAPI) deleteDir(parent *os.Root, base string, res deleteResponse) (string, error) {
	fi, err := parent.Lstat(base)
	if err != nil {
		return "", deleteError(err)
	}
	if fi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
		return "", errCreateSymlink
	}
	if !fi.IsDir() {
		return "", errDeleteNotDir
	}
	s := f.trash
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	id := randomHex(16)
	rec := trashRecord{Root: res.Root, Path: res.Path, Kind: "dir", DeletedAt: s.now(), Mode: fi.Mode().Perm()}
	if err := s.writeRecordLocked(id, rec); err != nil {
		return "", trashError(err)
	}
	deleteBeforeRmdir(parent, base)
	if err := rmdirAt(parent, base); err != nil {
		s.removeRecordLocked(id)
		switch {
		case isNotDir(err):
			return "", errEditChanged // a file swapped in stays
		case isDirNotEmpty(err):
			return "", errDeleteNotEmpty
		}
		return "", deleteError(err)
	}
	return id, nil
}

// trashError is what a delete answers when the trash itself fails: a full
// disk as a save says it, anything else (the dir removed, made read-only)
// as no trash, logged.
func trashError(err error) error {
	if isStorageFull(err) {
		return errStorageFull
	}
	log.Printf("trash: %v", err)
	return errTrashUnavailable
}

// deleteError turns an OS error of a delete or a restore into the one the
// client is told.
func deleteError(err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return createError(err)
}

// handleRestoreFile serves POST files/restore?root=: an entry of the trash
// goes back to its path, never replacing anything there.
func (f *filesAPI) handleRestoreFile(w http.ResponseWriter, r *http.Request) {
	var in restoreRequest
	req, cancel, ok := f.startWrite(w, r, "files restore", &in)
	if !ok {
		return
	}
	defer cancel()
	res, err := f.restoreFile(req.root, in)
	if err != nil {
		f.error(w, "files restore", err)
		return
	}
	jsonOK(w, res)
}

// restoreFile puts the trash entry in.TrashID back. Its path is checked
// again as a create's is (not its name: one that was on the disk, such as
// "a.", must come back), and the directories missing above it are made.
func (f *filesAPI) restoreFile(root filesRoot, in restoreRequest) (restoreResponse, error) {
	if !trashIDRe.MatchString(in.TrashID) {
		return restoreResponse{}, errInvalidTrashID
	}
	s := f.trash
	s.mu.Lock()
	rec, err := s.readRecordLocked(in.TrashID)
	s.mu.Unlock()
	if err != nil {
		return restoreResponse{}, err
	}
	if rec.Root != root.Root {
		return restoreResponse{}, &rootChangedError{root.Root}
	}
	rel, err := cleanRelPath(rec.Path)
	if err != nil || rel == "." {
		return restoreResponse{}, errDeleteInvalidPath
	}
	if f.createDenied(root, rel) {
		return restoreResponse{}, errCreateNotAllowed
	}
	if sensitivePath(root.Root, rel) && !in.Reveal {
		return restoreResponse{}, errEditSensitive
	}
	restoreBeforeLock()
	unlock, err := f.lockWrite(root.Root, rel)
	if err != nil {
		return restoreResponse{}, err
	}
	defer unlock()
	// Held from reading the record again to removing it: the sweep of a
	// delete in another root never removes an entry being restored.
	s.mu.Lock()
	defer s.mu.Unlock()
	if again, err := s.readRecordLocked(in.TrashID); err != nil || again != rec {
		return restoreResponse{}, errNotInTrash
	}
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return restoreResponse{}, err
	}
	parent, err := f.walkParents(rt, root, filepath.Dir(rel), true)
	if err != nil {
		return restoreResponse{}, createError(err)
	}
	defer parent.Close()
	base := filepath.Base(rel)
	if rec.Kind == "dir" {
		err = parent.Mkdir(base, rec.Mode.Perm())
	} else {
		err = s.moveBack(in.TrashID, parent, base)
	}
	if err != nil {
		if err = restoreError(err); err == errCreateExists {
			err = &createExistsError{filepath.ToSlash(rel)}
		}
		return restoreResponse{}, err
	}
	s.removeRecordLocked(in.TrashID)
	f.forgetRoot(root.Root)
	return restoreResponse{Root: root.Root, Path: filepath.ToSlash(rel)}, nil
}

// moveBack renames the payload id back to base in parent, never replacing.
func (s *trashStore) moveBack(id string, parent *os.Root, base string) error {
	trash, err := s.open()
	if err != nil {
		return err
	}
	defer trash.Close()
	return trashRestore(trash, id, parent, base)
}

func restoreError(err error) error {
	switch {
	case isCrossDevice(err):
		return errCrossDevice
	case errors.Is(err, fs.ErrNotExist):
		// The payload went (the sweep, a user): nothing to restore.
		return errNotInTrash
	}
	return createError(err)
}

type hashResponse struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	// Hash is the sha256 a delete takes as baseHash; empty for a file past
	// deleteHashMax or one that is not regular.
	Hash string `json:"hash,omitempty"`
}

// contentHash answers GET files/content?hash=1: the size and hash of a file,
// never its contents, so deleting a sensitive file never sends its secret
// to the browser. Accepted risk: a short secret's hash can be guessed, but
// a signed-in user has a shell anyway.
func (f *filesAPI) contentHash(root filesRoot, p string) (hashResponse, error) {
	rel, err := cleanRelPath(p)
	if err != nil {
		return hashResponse{}, err
	}
	if f.denied(root.Root, rel, root.GitDir) {
		return hashResponse{}, errPathNotAllowed
	}
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return hashResponse{}, err
	}
	defer rt.Close()
	fh, err := rt.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return hashResponse{}, err
	}
	defer fh.Close()
	fi, err := fh.Stat()
	if err != nil {
		return hashResponse{}, err
	}
	res := hashResponse{Root: root.Root, Path: filepath.ToSlash(rel), Size: fi.Size()}
	if !fi.Mode().IsRegular() || fi.Size() > deleteHashMax {
		return res, nil
	}
	sum, ok, err := hashHandle(fh)
	if err != nil {
		return hashResponse{}, err
	}
	if ok {
		res.Hash = sum
	}
	return res, nil
}
