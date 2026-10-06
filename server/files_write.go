package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// fileWriteBody caps a PUT files/content body: JSON escapes a control
	// character as \u00XX, six bytes for one, plus room for the other fields.
	// The 1 MiB limit is checked on the decoded text.
	fileWriteBody = 6*maxPreviewSize + 64<<10
	// writeMaxRunning saves run at once, server-wide; the next gets 429.
	writeMaxRunning = 2
	// editTempPrefix names the temporary file a save writes before renaming
	// it over the file. isSensitive treats every such name as sensitive.
	editTempPrefix = ".termote-edit-"
	// editTempMaxAge: a temporary file older than this was left by a save
	// that died, and the next save in that directory removes it.
	editTempMaxAge = 10 * time.Minute
)

var (
	errEditChanged    = &rawError{"changed", "the file changed on the host since it was read", http.StatusConflict}
	errEditSensitive  = &rawError{"sensitive", "sensitive file; reveal it to edit it", http.StatusForbidden}
	errEditPermission = &rawError{"permission", "the server cannot write this file", http.StatusForbidden}
	errEditNotText    = &rawError{"not_text", "text must be UTF-8 without NUL", http.StatusUnprocessableEntity}
	errEditTooLarge   = &rawError{"too_large", "file is larger than 1 MiB", http.StatusRequestEntityTooLarge}
	errEditBusy       = &rawError{"busy", "too many saves at once; try again", http.StatusTooManyRequests}
	// errStorageFull uses the code uploads answer when their store is full.
	errStorageFull    = &rawError{"storage_full", "the disk or the quota is full", http.StatusInsufficientStorage}
	errReadOnlyFiles  = &rawError{"read_only", "the file system is read-only", http.StatusForbidden}
	errRootRequired   = inputError("root is required")
	errBaseHashNeeded = inputError("baseHash is required")
)

// notEditableError: the file cannot be edited from the PWA, for reason.
type notEditableError struct{ reason string }

func (e *notEditableError) Error() string { return "file is not editable: " + e.reason }

// editReasonError turns an edit check's reason into the error a save answers.
func editReasonError(reason string) error {
	switch reason {
	case "not-writable", "other-owner":
		return errEditPermission
	case "denied-write":
		return errPathNotAllowed
	}
	return &notEditableError{reason}
}

// requireFilesWrite is where roles (#236, a view-only role) will refuse a
// save, a create, a delete or a restore. requireWriteRole allows everything today, so a view-only client is
// only kept from editing by the PWA.
func requireFilesWrite(w http.ResponseWriter, r *http.Request) bool {
	return requireWriteRole(w, r)
}

// writeLocks serialises the saves of one file (root + path) in this process.
type writeLocks struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func (l *writeLocks) lock(key string) func() {
	l.mu.Lock()
	m := l.locks[key]
	if m == nil {
		m = &sync.Mutex{}
		l.locks[key] = m
	}
	l.mu.Unlock()
	m.Lock()
	return m.Unlock
}

type writeRequest struct {
	Path     string `json:"path"`
	BaseHash string `json:"baseHash"`
	Text     string `json:"text"`
	Reveal   bool   `json:"reveal"`
}

type writeResponse struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	Hash string `json:"hash"`
}

// handleWriteContent serves PUT files/content?root=: it replaces the whole
// text of a file the client read, unless the file changed since (baseHash).
// writeGuard has refused a cross-site or non-JSON request already.
func (f *filesAPI) handleWriteContent(w http.ResponseWriter, r *http.Request) {
	// The root the client saw is required: a save never lands in a pane's
	// new directory because the request left it out.
	if r.URL.Query().Get("root") == "" {
		f.error(w, "files write", errRootRequired)
		return
	}
	req, cancel, ok := f.start(w, r, requireFilesWrite)
	if !ok {
		return
	}
	defer cancel()
	select {
	case f.writeSlots <- struct{}{}:
		defer func() { <-f.writeSlots }()
	default:
		f.error(w, "files write", errEditBusy)
		return
	}
	// Up to 6 MiB from a slow mobile link. Fails only on a writer without a
	// connection (tests).
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadReadTimeout))
	r.Body = http.MaxBytesReader(w, r.Body, fileWriteBody)
	var in writeRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			f.error(w, "files write", errEditTooLarge)
			return
		}
		jsonError(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	res, err := f.writeContent(req.root, in)
	if err != nil {
		f.error(w, "files write", err)
		return
	}
	jsonOK(w, res)
}

// writeContent replaces the file in.Path under root with in.Text. Every step
// after the path checks runs on the file's parent directory, opened once: a
// directory swapped for a symlink in between cannot redirect the write. The
// new text goes to a temporary file in that directory, then is renamed over
// the file. A file system has no compare-and-swap, so an agent writing the
// file between the last check and the rename still loses its change; the
// lock and the second read only narrow that window.
func (f *filesAPI) writeContent(root filesRoot, in writeRequest) (writeResponse, error) {
	if in.BaseHash == "" {
		return writeResponse{}, errBaseHashNeeded
	}
	rel, err := cleanRelPath(in.Path)
	if err != nil {
		return writeResponse{}, err
	}
	if rel == "." {
		return writeResponse{}, errInvalidPath
	}
	if f.denied(root.Root, rel, root.GitDir) || f.denied(root.Root, rel, f.writeDeny...) {
		return writeResponse{}, errPathNotAllowed
	}
	if sensitivePath(root.Root, rel) && !in.Reveal {
		return writeResponse{}, errEditSensitive
	}
	// The textarea sends "\n" line breaks; a lone "\r" would leave a file
	// with mixed line breaks, which could not be edited again.
	text := strings.ReplaceAll(in.Text, "\r\n", "\n")
	if !utf8.ValidString(text) || strings.ContainsAny(text, "\x00\r") {
		return writeResponse{}, errEditNotText
	}
	unlock := f.writeLocks.lock(root.Root + "\x00" + rel)
	defer unlock()

	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return writeResponse{}, err
	}
	defer rt.Close()
	dir, base, reason, err := openEditDir(rt, rel)
	if err != nil {
		return writeResponse{}, err
	}
	if reason != "" {
		return writeResponse{}, editReasonError(reason)
	}
	defer dir.Close()
	cur, fi, reason, err := readEditTarget(dir, base)
	if err != nil {
		return writeResponse{}, err
	}
	crlf, textReason := textEditReason(cur)
	if reason == "" {
		reason = textReason
	}
	if reason != "" {
		return writeResponse{}, editReasonError(reason)
	}
	out := []byte(text)
	if crlf {
		out = []byte(strings.ReplaceAll(text, "\n", "\r\n"))
	}
	if len(out) > maxPreviewSize {
		return writeResponse{}, errEditTooLarge
	}
	res := writeResponse{Root: root.Root, Path: filepath.ToSlash(rel), Size: int64(len(out)), Hash: hashHex(out)}
	// Already what the client asks for: a second save after a reply that
	// never arrived is not a conflict.
	if bytes.Equal(cur, out) {
		return res, nil
	}
	if hashHex(cur) != in.BaseHash {
		return writeResponse{}, errEditChanged
	}
	sweepEditTemps(dir, time.Now())
	if err := replaceFile(dir, base, out, fi.Mode().Perm(), cur); err != nil {
		return writeResponse{}, saveError(err)
	}
	// The Changes view reads the status right after a save: not the one
	// cached from before it, and find lists what it saved.
	f.forgetRoot(root.Root)
	return res, nil
}

// saveError turns an OS error of writing the new text into the one the
// client is told.
func saveError(err error) error {
	switch {
	case isStorageFull(err):
		return errStorageFull
	// A read-only mount, not the permissions, refused the write
	case isReadOnlyFS(err):
		return errReadOnlyFiles
	case errors.Is(err, fs.ErrPermission):
		return errEditPermission
	}
	return err
}

// replaceFile writes out to a new temporary file in dir with perm, checks
// base still holds cur, and renames the temporary file over base. The
// temporary file is removed on any failure.
func replaceFile(dir *os.Root, base string, out []byte, perm fs.FileMode, cur []byte) (err error) {
	tmp := editTempPrefix + randomHex(8)
	tf, err := dir.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			dir.Remove(tmp)
		}
	}()
	// Set on the handle, not by name: os.Root's Chmod can follow a symlink
	// swapped in on Unix.
	_, err = tf.Write(out)
	if err == nil {
		err = tf.Chmod(perm)
	}
	if err == nil {
		err = tf.Sync()
	}
	if cerr := tf.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	now, err := readBounded(dir, base)
	if err != nil {
		return err
	}
	if !bytes.Equal(now, cur) {
		return errEditChanged
	}
	return dir.Rename(tmp, base)
}

// openEditDir opens the parent directory of rel, refusing a path whose
// directories include a symlink (reason "symlink"): a save never writes
// through one. The caller closes dir unless reason or err is set.
func openEditDir(rt *os.Root, rel string) (dir *os.Root, base, reason string, err error) {
	parent := filepath.Dir(rel)
	if parent != "." {
		walked := ""
		for _, part := range strings.Split(parent, string(filepath.Separator)) {
			walked = filepath.Join(walked, part)
			fi, err := rt.Lstat(walked)
			if err != nil {
				return nil, "", "", err
			}
			if fi.Mode()&fs.ModeSymlink != 0 {
				return nil, "", "symlink", nil
			}
		}
	}
	dir, err = rt.OpenRoot(parent)
	if err != nil {
		return nil, "", "", err
	}
	// The directory opened is the one checked: one swapped for a symlink
	// after the walk is refused.
	if parent != "." {
		opened, err1 := dir.Stat(".")
		named, err2 := rt.Lstat(parent)
		if err1 != nil || err2 != nil || !os.SameFile(opened, named) {
			dir.Close()
			return nil, "", "symlink", nil
		}
	}
	return dir, filepath.Base(rel), "", nil
}

// readEditTarget reads base in dir for a save: its bytes (at most one more
// than maxPreviewSize, errEditTooLarge past it), what it is, and reason when
// it cannot be edited for what it is. Every check but the symlink one runs
// on the open handle.
func readEditTarget(dir *os.Root, base string) ([]byte, fs.FileInfo, string, error) {
	lfi, err := dir.Lstat(base)
	if err != nil {
		return nil, nil, "", err
	}
	if lfi.Mode()&fs.ModeSymlink != 0 {
		return nil, lfi, "symlink", nil
	}
	if !lfi.Mode().IsRegular() {
		return nil, lfi, "not-regular", nil
	}
	fh, err := dir.OpenFile(base, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, nil, "", err
	}
	defer fh.Close()
	fi, err := fh.Stat()
	if err != nil {
		return nil, nil, "", err
	}
	if !os.SameFile(lfi, fi) {
		return nil, nil, "", errEditChanged
	}
	reason, err := editFileReason(fh, fi)
	if err != nil {
		return nil, nil, "", err
	}
	if fi.Size() > maxPreviewSize {
		return nil, nil, "", errEditTooLarge
	}
	b, err := io.ReadAll(io.LimitReader(fh, maxPreviewSize+1))
	if err != nil {
		return nil, nil, "", err
	}
	if len(b) > maxPreviewSize {
		return nil, nil, "", errEditTooLarge
	}
	return b, fi, reason, nil
}

// editFileReason is why the open regular file fh cannot be edited, from
// what it is: several hard links (a rename would split them), another
// owner (the new file would be the server user's), no write permission.
func editFileReason(fh *os.File, fi fs.FileInfo) (string, error) {
	links, err := fileLinks(fh, fi)
	if err != nil {
		return "", err
	}
	switch {
	case links > 1:
		return "hardlink", nil
	case !fileOwnedByServer(fi):
		return "other-owner", nil
	case fi.Mode().Perm()&0o200 == 0:
		return "not-writable", nil
	}
	return "", nil
}

// textEditReason tells whether b uses "\r\n" line breaks throughout, and
// why it cannot be edited as text: a NUL, or line breaks a textarea would
// change (a lone "\r", or "\r\n" mixed with "\n").
func textEditReason(b []byte) (crlf bool, reason string) {
	if bytes.IndexByte(b, 0) >= 0 {
		return false, "nul"
	}
	crlfs := bytes.Count(b, []byte("\r\n"))
	if bytes.Count(b, []byte("\r")) != crlfs {
		return false, "mixed-eol"
	}
	lfs := bytes.Count(b, []byte("\n")) - crlfs
	if crlfs > 0 && lfs > 0 {
		return false, "mixed-eol"
	}
	return crlfs > 0, ""
}

// editCheck is what the content route tells the PWA about editing rel: the
// same checks a save runs on the file, given its bytes. reason is empty
// when it can be edited.
func (f *filesAPI) editCheck(rt *os.Root, root filesRoot, rel string, b []byte) string {
	if f.denied(root.Root, rel, f.writeDeny...) {
		return "denied-write"
	}
	dir, base, reason, err := openEditDir(rt, rel)
	if err != nil {
		return "unavailable"
	}
	if reason != "" {
		return reason
	}
	defer dir.Close()
	_, _, reason, err = readEditTarget(dir, base)
	if err != nil {
		return "unavailable"
	}
	if reason != "" {
		return reason
	}
	_, reason = textEditReason(b)
	return reason
}

// readBounded reads base in dir as a save checks it again: never waiting
// on a FIFO swapped in, and no more than one byte past maxPreviewSize.
func readBounded(dir *os.Root, base string) ([]byte, error) {
	fh, err := dir.OpenFile(base, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	return io.ReadAll(io.LimitReader(fh, maxPreviewSize+1))
}

// editTempRe matches exactly the names a save creates.
var editTempRe = regexp.MustCompile(`^` + regexp.QuoteMeta(editTempPrefix) + `[0-9a-f]{16}$`)

// sweepEditTemps removes the temporary files of saves that died in dir.
// Only names a save creates are ever removed (a user's .termote-edit-notes
// stays).
func sweepEditTemps(dir *os.Root, now time.Time) {
	d, err := dir.Open(".")
	if err != nil {
		return
	}
	names, _ := d.Readdirnames(-1)
	d.Close()
	for _, name := range names {
		if !editTempRe.MatchString(name) {
			continue
		}
		if fi, err := dir.Lstat(name); err == nil && fi.Mode().IsRegular() && now.Sub(fi.ModTime()) > editTempMaxAge {
			dir.Remove(name)
		}
	}
}

func hashHex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
