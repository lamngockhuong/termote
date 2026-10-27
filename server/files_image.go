package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// A pasted image is named for when it came, then -2 ... -99 when that name is
// taken; past that the paste is refused.
const imageMaxSuffix = 99

// imageAssetsDir is where a pasted image goes when the Markdown file's
// directory has one (a real directory, not a link); else next to the file.
const imageAssetsDir = "assets"

// errImageNoDir: the directory an image was pasted for is gone (renamed or
// deleted since the Markdown file was opened); none is ever made
var errImageNoDir = &codedError{"not_found", "no such directory", http.StatusNotFound}

// imageNow is the time a pasted image is named for; only tests set it.
var imageNow = time.Now

// filesImagePathRe is the one path whose write takes a raw image body
// besides uploads (writeGuard): anchored, so ".../files/image/" or a longer
// path never takes it.
var filesImagePathRe = regexp.MustCompile(`^/api/mux/panes/[^/]+/files/image$`)

func isFilesImagePath(p string) bool { return filesImagePathRe.MatchString(p) }

// handleImage serves POST files/image?root=&dir=[&reveal=1]: an image pasted
// into a Markdown file being edited, as its raw bytes (PNG, JPEG, GIF or
// WebP; writeGuard has refused any other type), written as a new file in
// dir (the Markdown file's directory, under the root) or its assets/
// directory. The server picks the name, and never replaces a file.
func (f *filesAPI) handleImage(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	q := r.URL.Query()
	// As for a save: never written into a pane's new directory because the
	// request left the root out.
	if q.Get("root") == "" {
		f.error(w, "files image", errRootRequired)
		return
	}
	req, cancel, ok := f.start(w, r, requireFilesWrite)
	if !ok {
		return
	}
	defer cancel()
	dir, ok := imageDir(q.Get("dir"))
	if !ok {
		f.error(w, "files image", errCreateInvalidName)
		return
	}
	// Refused unread, before a slot is taken
	if r.ContentLength > uploadMaxFile {
		f.error(w, "files image", errUploadTooLarge)
		return
	}
	select {
	case f.writeSlots <- struct{}{}:
		defer func() { <-f.writeSlots }()
	default:
		f.error(w, "files image", errEditBusy)
		return
	}
	// 10 MB from a slow mobile link, as an upload. Fails only on a writer
	// without a connection (tests).
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadReadTimeout))
	r.Body = http.MaxBytesReader(w, r.Body, uploadMaxFile)
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	res, err := f.writeImage(req.root, dir, mt, r.Body, q.Get("reveal") == "1")
	if err != nil {
		f.error(w, "files image", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(res)
}

// imageDir checks the directory an image goes in: "." for the root, else a
// path with "/" separators that stays under it (cleanRelPath).
func imageDir(d string) (string, bool) {
	if d == "." {
		return ".", true
	}
	if _, ok := validPathShape(d); !ok || strings.ContainsRune(d, '\\') {
		return "", false
	}
	rel, err := cleanRelPath(d)
	return rel, err == nil
}

// firstError is a reader that keeps the first error other than EOF its
// reader gave: the image's checks turn any error into "not an image", which
// a body over its limit or cut short is not.
type firstError struct {
	r   io.Reader
	err error
}

func (e *firstError) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && err != io.EOF && e.err == nil {
		e.err = err
	}
	return n, err
}

// writeError is a writer that keeps the first error its writer gave: a
// write that fails under the image's checks reaches them as a read error,
// and a GIF's count takes a read error for the end of the file.
type writeError struct {
	w   io.Writer
	err error
}

func (e *writeError) Write(p []byte) (int, error) {
	n, err := e.w.Write(p)
	if err != nil && e.err == nil {
		e.err = err
	}
	return n, err
}

// writeImage writes body, an image of type mt, as a new file in dir under
// root (or dir/assets), and returns its path. Its first bytes must be that
// type before anything touches the disk; its pixels are counted as it is
// written, and a file that fails is removed. Only the choice of its name and
// its open hold the root's lock: a slow body never holds it.
func (f *filesAPI) writeImage(root filesRoot, dir, mt string, body io.Reader, reveal bool) (createResponse, error) {
	ext := uploadExts[mt]
	head := make([]byte, 512)
	n, err := io.ReadFull(body, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return createResponse{}, readUploadError(err)
	}
	head = head[:n]
	if got, _ := imageTypeOf(head); n == 0 || got != mt {
		return createResponse{}, errUploadUnsupported
	}

	unlock := f.writeLocks.lock(rootLockKey(root.Root))
	fh, target, name, err := f.openImage(root, dir, ext, reveal)
	unlock()
	if err != nil {
		return createResponse{}, err
	}
	// Removed through the directory it was made in, never by a path
	dirRoot := target.root
	defer dirRoot.Close()
	fail := func(err error) (createResponse, error) {
		fh.Close()
		dirRoot.Remove(name)
		return createResponse{}, err
	}
	if _, err := fh.Write(head); err != nil {
		return fail(createError(err))
	}
	rest := &firstError{r: body}
	out := &writeError{w: fh}
	all := io.MultiReader(bytes.NewReader(head), io.TeeReader(rest, out))
	_, err = imageType(name, head, all)
	switch {
	// The disk first, then the body: either may be why the image read wrong
	case out.err != nil:
		return fail(createError(out.err))
	case rest.err != nil:
		return fail(readUploadError(rest.err))
	case errors.Is(err, errTooManyPixels):
		return fail(err)
	case err != nil:
		return fail(errUploadUnsupported)
	}
	if _, err := io.Copy(out, rest); err != nil {
		if out.err != nil {
			return fail(createError(out.err))
		}
		return fail(readUploadError(err))
	}
	if err := fh.Sync(); err != nil {
		return fail(createError(err))
	}
	if err := fh.Close(); err != nil {
		dirRoot.Remove(name)
		return createResponse{}, createError(err)
	}
	// The Changes view lists the new file right away, and find finds it.
	f.forgetRoot(root.Root)
	return createResponse{Root: root.Root, Path: filepath.ToSlash(filepath.Join(target.rel, name))}, nil
}

// imageTarget is the directory an image is written in: opened, and its path
// under the root.
type imageTarget struct {
	root *os.Root
	rel  string
}

// openImage opens a new file for an image in dir (or its assets/ directory)
// under root, named for the time: the first of the names not taken, opened
// O_EXCL so nothing there is ever replaced. The caller closes the file and
// the directory.
func (f *filesAPI) openImage(root filesRoot, dir, ext string, reveal bool) (*os.File, imageTarget, string, error) {
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return nil, imageTarget{}, "", err
	}
	cur, err := f.walkParents(rt, root, dir, false)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, imageTarget{}, "", errImageNoDir
	}
	if err != nil {
		return nil, imageTarget{}, "", createError(err)
	}
	target := imageTarget{root: cur, rel: dir}
	// Only a real directory: a link, a file or nothing there is next to the
	// Markdown file instead
	assets := filepath.Join(dir, imageAssetsDir)
	if sub, err := openChildDir(cur, imageAssetsDir, nil); err == nil {
		if f.createDenied(root, assets) {
			sub.Close()
			cur.Close()
			return nil, imageTarget{}, "", errCreateNotAllowed
		}
		cur.Close()
		target = imageTarget{root: sub, rel: assets}
	}
	base := "pasted-" + imageNow().Format("20060102-150405")
	for i := 1; i <= imageMaxSuffix; i++ {
		name := base + "." + ext
		if i > 1 {
			name = fmt.Sprintf("%s-%d.%s", base, i, ext)
		}
		if sensitivePath(root.Root, filepath.Join(target.rel, name)) && !reveal {
			target.root.Close()
			return nil, imageTarget{}, "", errEditSensitive
		}
		fh, err := target.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
		if err == nil {
			return fh, target, name, nil
		}
		if err = createError(err); err != errCreateExists {
			target.root.Close()
			return nil, imageTarget{}, "", err
		}
	}
	target.root.Close()
	return nil, imageTarget{}, "", errCreateExists
}
