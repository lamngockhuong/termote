package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// uploadMaxRunning: uploads running at once, server-wide. A slot of
	// their own, so an upload never holds one a save needs.
	uploadMaxRunning = 1
	// uploadMaxSuffix: a taken name becomes "name (2).ext" ... "name
	// (99).ext"; past that the upload is refused.
	uploadMaxSuffix = 99
	// uploadTempPrefix names the hidden file an upload streams into before
	// it takes its name: a visible name only ever holds a whole file.
	uploadTempPrefix = ".termote-upload-"
	// uploadTempMaxAge: an upload's temporary file older than this is from a
	// server stopped mid-upload (an upload takes at most uploadMaxDuration,
	// and its writes keep the file's time current).
	uploadTempMaxAge = time.Hour
)

var (
	// maxUploadFileSize caps a file sent to files/upload: what goes up can
	// come back down through files/download. A variable so tests can
	// lower it.
	maxUploadFileSize int64 = maxDownloadSize
	// uploadIdleTimeout drops a client that stopped sending: each read
	// with progress gets this long. uploadMaxDuration bounds the whole
	// upload (100 MiB at about 0.5 Mbit/s), so the one slot is never held
	// for ever. Variables so tests can shorten them.
	uploadIdleTimeout = 2 * time.Minute
	uploadMaxDuration = 30 * time.Minute
	// uploadLink gives the temporary file its name; tests replace it to
	// play a file system without hard links.
	uploadLink = func(dir *os.Root, oldname, newname string) error { return dir.Link(oldname, newname) }
	// uploadBeforeFinish runs between the body's end and the choice of the
	// name (tests).
	uploadBeforeFinish = func() {}
)

var (
	errFileUploadTooLarge    = &codedError{"too_large", "file is larger than 100 MiB", http.StatusRequestEntityTooLarge}
	errFileUploadTimeout     = &codedError{"timeout", "the upload stalled; try again", http.StatusRequestTimeout}
	errFileUploadUnsupported = &codedError{"unsupported_type", "the file must be sent as application/octet-stream", http.StatusUnsupportedMediaType}
	errFileUploadBusy        = &codedError{"upload_busy", "another upload is running", http.StatusTooManyRequests}
)

// uploadTempRe matches exactly the names an upload gives its temporary file.
var uploadTempRe = regexp.MustCompile(`^` + regexp.QuoteMeta(uploadTempPrefix) + `[0-9a-f]{16}$`)

// filesUploadPathRe is the one path whose write takes a raw
// application/octet-stream body (writeGuard): anchored, as files/image.
var filesUploadPathRe = regexp.MustCompile(`^/api/mux/panes/[^/]+/files/upload$`)

func isFilesUploadPath(p string) bool { return filesUploadPathRe.MatchString(p) }

// handleUpload serves POST files/upload?root=&dir=&name=[&reveal=1][&check=1]:
// a file from the client's device, as its raw bytes, written in dir under
// the root as name, or "name (2)" and on when that is taken. Nothing is
// ever replaced.
//
// check=1 (a JSON body, never read) runs every check and answers {root,
// path} with the name the upload would get now, creating nothing and taking
// no slot: a refusal sent before a large body is read reaches the browser
// as a reset connection, not as its code. It answers upload_busy while
// another upload holds the slot, so the client waits before sending. The
// upload checks it all again.
func (f *filesAPI) handleUpload(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	q := r.URL.Query()
	// As for a save: never written into a pane's new directory because the
	// request left the root out.
	if q.Get("root") == "" {
		f.error(w, "files upload", errRootRequired)
		return
	}
	req, cancel, ok := f.start(w, r, requireFilesWrite)
	if !ok {
		return
	}
	defer cancel()
	dir, ok := imageDir(q.Get("dir"))
	name := q.Get("name")
	if !ok || !validUploadName(name) {
		f.error(w, "files upload", errCreateInvalidName)
		return
	}
	reveal := q.Get("reveal") == "1"
	if q.Get("check") == "1" {
		res, err := f.checkUpload(req.root, dir, name, reveal)
		// A refusal first: no wait for a file that would not go anyway.
		// The slot is only looked at: the upload takes it, or is refused it.
		if err == nil && len(f.uploadSlots) == cap(f.uploadSlots) {
			err = errFileUploadBusy
		}
		if err != nil {
			f.error(w, "files upload", err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		jsonOK(w, res)
		return
	}
	// Refused unread, before a slot is taken
	if r.ContentLength > maxUploadFileSize {
		f.error(w, "files upload", errFileUploadTooLarge)
		return
	}
	select {
	case f.uploadSlots <- struct{}{}:
		defer func() { <-f.uploadSlots }()
	default:
		f.error(w, "files upload", errFileUploadBusy)
		return
	}
	body := newIdleReader(http.MaxBytesReader(w, r.Body, maxUploadFileSize), http.NewResponseController(w))
	res, size, err := f.writeUpload(req.root, dir, name, body, reveal)
	if err != nil {
		f.error(w, "files upload", err)
		return
	}
	by, via := auditWho(r)
	auditf("upload", "path", res.Path, "size", size, "by", by, "via", via)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(res)
}

// idleReader moves the connection's read deadline on after each read that
// brought bytes: a client that stops sending is dropped after
// uploadIdleTimeout, and none reads past uploadMaxDuration.
type idleReader struct {
	r   io.Reader
	rc  *http.ResponseController
	end time.Time
}

func newIdleReader(r io.Reader, rc *http.ResponseController) *idleReader {
	d := &idleReader{r: r, rc: rc, end: time.Now().Add(uploadMaxDuration)}
	d.extend()
	return d
}

// extend fails only on a writer without a connection (tests).
func (d *idleReader) extend() {
	_ = d.rc.SetReadDeadline(minTime(time.Now().Add(uploadIdleTimeout), d.end))
}

func (d *idleReader) Read(p []byte) (int, error) {
	n, err := d.r.Read(p)
	if n > 0 {
		d.extend()
	}
	return n, err
}

// uploadBodyError turns a body over the cap, or one that stopped coming,
// into the error the client is told.
func uploadBodyError(err error) error {
	var mbe *http.MaxBytesError
	var ne net.Error
	switch {
	case errors.As(err, &mbe):
		return errFileUploadTooLarge
	case errors.As(err, &ne) && ne.Timeout():
		return errFileUploadTimeout
	}
	return err
}

// validUploadName checks the name a client gives its file: exactly one
// component on every OS (no '/', no '\', no "..", no Windows device name),
// a name a create may make (validNamePart), never a temporary file's, and
// no format character (a bidi override or a zero-width space makes one
// name pose as another) or invalid UTF-8.
func validUploadName(name string) bool {
	return validNamePart(name) && !tempName(name) && !strings.ContainsAny(name, `/\`) &&
		filepath.IsLocal(name) && filepath.Base(name) == name && !deviceName(name) &&
		!strings.ContainsFunc(name, func(r rune) bool { return r == utf8.RuneError || unicode.Is(unicode.Cf, r) })
}

// deviceName reports whether Windows would open name as a device (NUL,
// CON.txt, COM1, CONIN$): refused on every OS, as filepath.IsLocal refuses
// it on Windows.
func deviceName(name string) bool {
	stem, _, _ := strings.Cut(name, ".")
	stem = strings.ToUpper(strings.TrimRight(stem, " "))
	switch stem {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return true
	}
	if len(stem) < 4 || (stem[:3] != "COM" && stem[:3] != "LPT") {
		return false
	}
	switch stem[3:] {
	case "1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³":
		return true
	}
	return false
}

// uploadCandidate is the n-th name tried for name: name itself, then
// "stem (n)ext". A dotfile with no other dot has no extension (".env (2)"),
// and the stem is cut on a rune boundary so the name stays within
// createMaxName bytes.
func uploadCandidate(name string, n int) string {
	if n == 1 {
		return name
	}
	ext := filepath.Ext(name)
	if ext == name {
		ext = ""
	}
	stem := strings.TrimSuffix(name, ext)
	suffix := fmt.Sprintf(" (%d)", n)
	for stem != "" && len(stem)+len(suffix)+len(ext) > createMaxName {
		_, size := utf8.DecodeLastRuneInString(stem)
		stem = stem[:len(stem)-size]
	}
	return stem + suffix + ext
}

// placeUpload tries the names for name in turn with place, which reports
// fs.ErrExist for a taken one, and returns the one placed. Each is checked
// as a create checks its path: a deny dir's, and a sensitive one only with
// reveal.
func (f *filesAPI) placeUpload(root filesRoot, dir, name string, reveal bool, place func(string) error) (string, error) {
	for i := 1; i <= uploadMaxSuffix; i++ {
		cand := uploadCandidate(name, i)
		// A long extension leaves no room for the number
		if !validUploadName(cand) {
			continue
		}
		rel := filepath.Join(dir, cand)
		if f.createDenied(root, rel) {
			return "", errCreateNotAllowed
		}
		if sensitivePath(root.Root, rel) && !reveal {
			return "", errEditSensitive
		}
		err := place(cand)
		if err == nil {
			return cand, nil
		}
		if err = createError(err); err != errCreateExists {
			return "", err
		}
	}
	return "", errCreateExists
}

// freeName is placeUpload's place for a name only looked at: free when
// nothing is there, a link included.
func freeName(dir *os.Root) func(string) error {
	return func(name string) error {
		_, err := dir.Lstat(name)
		if err == nil {
			return fs.ErrExist
		}
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
}

// openUploadDir opens dir under root as a create walks it: no symlink or
// junction on the way, no deny dir; a missing one is never made.
func (f *filesAPI) openUploadDir(root filesRoot, dir string) (*os.Root, error) {
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return nil, err
	}
	cur, err := f.walkParents(rt, root, dir, false)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errImageNoDir
	}
	if err != nil {
		return nil, createError(err)
	}
	return cur, nil
}

// checkUpload answers check=1: the path an upload of name to dir would get
// now, or why it would be refused. Nothing is created.
func (f *filesAPI) checkUpload(root filesRoot, dir, name string, reveal bool) (createResponse, error) {
	cur, err := f.openUploadDir(root, dir)
	if err != nil {
		return createResponse{}, err
	}
	defer cur.Close()
	// Only looked at: the upload picks its name again under the lock
	got, err := f.placeUpload(root, dir, name, reveal, freeName(cur))
	if err != nil {
		return createResponse{}, err
	}
	return createResponse{Root: root.Root, Path: filepath.ToSlash(filepath.Join(dir, got))}, nil
}

// writeUpload streams body into a hidden temporary file in dir, then gives
// it the first free name for name: a hard link, which never replaces a file,
// under the root's lock. Where the file system has no hard links (FAT,
// exFAT), the name is looked at and the file renamed under that lock, which
// only another program can race. Any failure removes the temporary file and
// nothing else. A slow body never holds the lock.
func (f *filesAPI) writeUpload(root filesRoot, dir, name string, body io.Reader, reveal bool) (createResponse, int64, error) {
	cur, err := f.openUploadDir(root, dir)
	if err != nil {
		return createResponse{}, 0, err
	}
	defer cur.Close()
	// Refused before the body is read, as the check refused it
	if _, err := f.placeUpload(root, dir, name, reveal, freeName(cur)); err != nil {
		return createResponse{}, 0, err
	}
	sweepTemps(cur, uploadTempRe, uploadTempMaxAge, time.Now())
	tmp := uploadTempPrefix + randomHex(8)
	fh, err := cur.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return createResponse{}, 0, createError(err)
	}
	// Removed by its own random name, never by one a user could see
	placed := false
	defer func() {
		if !placed {
			cur.Remove(tmp)
		}
	}()
	size, err := streamNewFile(fh, body, uploadBodyError)
	// After a sync only a network file system still fails the close;
	// createError(nil) is nil.
	if cerr := fh.Close(); err == nil {
		err = createError(cerr)
	}
	if err != nil {
		return createResponse{}, 0, err
	}
	uploadBeforeFinish()
	renamed := false
	unlock := f.writeLocks.lock(rootLockKey(root.Root))
	got, err := f.placeUpload(root, dir, name, reveal, func(cand string) error {
		err := uploadLink(cur, tmp, cand)
		if err == nil || !isLinkUnsupported(err) {
			return err
		}
		if err := freeName(cur)(cand); err != nil {
			return err
		}
		renamed = true
		return cur.Rename(tmp, cand)
	})
	unlock()
	if err != nil {
		return createResponse{}, 0, err
	}
	placed = true
	if !renamed {
		// Left only when the remove fails: hidden, and swept in an hour
		cur.Remove(tmp)
	}
	// The Changes view lists the new file right away, and find finds it.
	f.forgetRoot(root.Root)
	return createResponse{Root: root.Root, Path: filepath.ToSlash(filepath.Join(dir, got))}, size, nil
}

// syncWriter is a file being written: an *os.File, or a fake in tests.
type syncWriter interface {
	io.Writer
	Sync() error
}

// streamNewFile copies body into fh, a file just made, and syncs it. A
// failure of the disk is told apart from one of the body, which bodyError
// turns into the error the client is told.
func streamNewFile(fh syncWriter, body io.Reader, bodyError func(error) error) (int64, error) {
	out := &writeError{w: fh}
	n, err := io.Copy(out, body)
	if err != nil {
		if out.err != nil {
			return n, createError(out.err)
		}
		return n, bodyError(err)
	}
	if err := fh.Sync(); err != nil {
		return n, createError(err)
	}
	return n, nil
}
