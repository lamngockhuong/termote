package main

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// maxImageSize caps an image served by the raw route.
	maxImageSize = 10 << 20
	// maxImagePixels caps the decoded size of an image (a GIF's largest
	// frame): a small file can expand to gigabytes in the browser.
	maxImagePixels = 40_000_000
	// rawMaxRunning raw requests run at once, server-wide; the next gets 429.
	// A git read holds the whole image, so this bounds that memory too.
	rawMaxRunning = 4
	// rawWriteTimeout frees a handler whose client stopped reading.
	rawWriteTimeout = 2 * time.Minute
	// imageSniffSize is read to tell an image's type.
	imageSniffSize = 8 << 10
	// catFileHeaderMax is room for `git cat-file --batch`'s header line.
	catFileHeaderMax = 512

	svgType = "image/svg+xml"
	// svgPolicy is added to the page's own CSP for an SVG: opened directly,
	// it runs no script and loads nothing under termote's origin.
	svgPolicy        = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
	lfsPointerPrefix = "version https://git-lfs.github.com/spec/v1"
)

// rawError is a raw route failure the client is told about, by code.
type rawError struct {
	code   string
	msg    string
	status int
}

func (e *rawError) Error() string { return e.msg }

var (
	errImageTooLarge  = &rawError{"too_large", "image is larger than 10 MiB", http.StatusRequestEntityTooLarge}
	errTooManyPixels  = &rawError{"too_many_pixels", "image has more than 40 megapixels", http.StatusRequestEntityTooLarge}
	errNotImage       = &rawError{"not_image", "not a PNG, JPEG, GIF, WebP or SVG image", http.StatusUnsupportedMediaType}
	errLFSPointer     = &rawError{"lfs_pointer", "file is a Git LFS pointer", http.StatusUnsupportedMediaType}
	errRawBusy        = &rawError{"busy", "too many images at once; try again", http.StatusTooManyRequests}
	errNoVersion      = &rawError{"no_version", "no such version of this file", http.StatusNotFound}
	errSensitiveImage = &rawError{"sensitive", "sensitive file; reveal=1 to show it", http.StatusForbidden}
	errInvalidSide    = inputError("invalid side")
)

// imageTypeOf tells an image's type from its first bytes: one of the types
// uploads accept, never SVG (which sniffs as text).
func imageTypeOf(head []byte) (string, bool) {
	mt := http.DetectContentType(head)
	return mt, isUploadType(mt)
}

// checkImage tells the type of the image r holds, read from its bytes, and
// leaves r at its start. path names what was read: only a .svg is taken as
// SVG.
func checkImage(path string, r io.ReadSeeker) (string, error) {
	head := make([]byte, imageSniffSize)
	n, err := io.ReadFull(r, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return "", err
	}
	head = head[:n]
	if bytes.HasPrefix(head, []byte(lfsPointerPrefix)) {
		return "", errLFSPointer
	}
	mt, err := imageType(path, head, io.MultiReader(bytes.NewReader(head), r))
	if err != nil {
		return "", err
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return mt, nil
}

// imageType checks head, then for a PNG, JPEG, GIF or WebP its pixel
// count, read from its header through all (the whole file from its start):
// a GIF's frames, a WebP's first chunk.
func imageType(path string, head []byte, all io.Reader) (string, error) {
	if strings.EqualFold(filepath.Ext(path), ".svg") {
		if !isSVG(head) {
			return "", errNotImage
		}
		return svgType, nil
	}
	mt, ok := imageTypeOf(head)
	if !ok {
		return "", errNotImage
	}
	var pixels int64
	var cfg image.Config
	var err error
	switch mt {
	case "image/png":
		cfg, err = png.DecodeConfig(all)
		pixels = int64(cfg.Width) * int64(cfg.Height)
	case "image/jpeg":
		cfg, err = jpeg.DecodeConfig(all)
		pixels = int64(cfg.Width) * int64(cfg.Height)
	case "image/gif":
		pixels, err = gifPixels(all)
	case "image/webp":
		pixels, err = webpPixels(head)
	}
	if err != nil {
		return "", errNotImage
	}
	if pixels > maxImagePixels {
		return "", errTooManyPixels
	}
	return mt, nil
}

// isSVG: UTF-8 (the head may end inside a character) whose first element,
// after a BOM, the XML declaration, processing instructions, comments and a
// DOCTYPE, is <svg>.
func isSVG(head []byte) bool {
	if !validUTF8Head(head) {
		return false
	}
	s := strings.TrimPrefix(string(head), "\uFEFF")
	for {
		s = strings.TrimLeft(s, " \t\r\n")
		end := ">"
		switch {
		case strings.HasPrefix(s, "<?"):
			end = "?>"
		case strings.HasPrefix(s, "<!--"):
			end = "-->"
		case strings.HasPrefix(s, "<!DOCTYPE"):
			// An internal subset holds '>' of its own.
			if i := strings.IndexAny(s, "[>"); i >= 0 && s[i] == '[' {
				j := strings.IndexByte(s[i:], ']')
				if j < 0 {
					return false
				}
				s = s[i+j:]
			}
		default:
			rest, ok := strings.CutPrefix(s, "<svg")
			return ok && rest != "" && strings.ContainsRune(" \t\r\n>/", rune(rest[0]))
		}
		i := strings.Index(s, end)
		if i < 0 {
			return false
		}
		s = s[i+len(end):]
	}
}

// validUTF8Head is utf8.Valid, except that the last character may be cut.
func validUTF8Head(b []byte) bool {
	for cut := 0; cut < utf8.UTFMax && cut <= len(b); cut++ {
		if utf8.Valid(b[:len(b)-cut]) && (cut == 0 || !utf8.FullRune(b[len(b)-cut:])) {
			return true
		}
	}
	return false
}

// writeImage sends size bytes of r as an image of type ct. Headers are gone
// once it starts, so a short read only cuts the response (Content-Length no
// longer matches) and is logged.
func writeImage(w http.ResponseWriter, ct string, size int64, r io.Reader) {
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	h.Set("Cache-Control", "no-store")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	disposition := "inline"
	if ct == svgType {
		// Added, not set: the browser enforces both policies.
		h.Add("Content-Security-Policy", svgPolicy)
		disposition = "attachment"
	}
	h.Set("Content-Disposition", disposition)
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(rawWriteTimeout))
	w.WriteHeader(http.StatusOK)
	if _, err := io.CopyN(w, r, size); err != nil {
		log.Printf("files raw: sending %s image: %v", ct, err)
	}
}

func (f *filesAPI) handleRaw(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	select {
	case f.rawSlots <- struct{}{}:
		defer func() { <-f.rawSlots }()
	default:
		f.error(w, "files raw", errRawBusy)
		return
	}
	if err := f.raw(w, req, r.URL.Query()); err != nil {
		f.error(w, "files raw", err)
	}
}

// raw serves one image: the worktree file (Files), or with side one version
// of a git status entry (Changes). It returns an error only before writing.
func (f *filesAPI) raw(w http.ResponseWriter, req *filesRequest, q url.Values) error {
	reveal := q.Get("reveal") == "1"
	switch side := q.Get("side"); side {
	case "":
		return f.serveWorktreeImage(w, req.root, q.Get("path"), reveal)
	case "old", "new":
		return f.serveImageVersion(w, req.ctx, req.root, q.Get("path"), q.Get("orig"), q.Get("staged") == "1", side, reveal)
	default:
		return errInvalidSide
	}
}

// serveWorktreeImage streams a file under the root. Every check runs on the
// open handle, in content()'s order: a missing file is 404 even when its name
// is sensitive.
func (f *filesAPI) serveWorktreeImage(w http.ResponseWriter, root filesRoot, p string, reveal bool) error {
	rel, err := cleanRelPath(p)
	if err != nil {
		return err
	}
	if f.denied(root.Root, rel, root.GitDir) {
		return errPathNotAllowed
	}
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return err
	}
	defer rt.Close()
	fh, err := rt.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return err
	}
	defer fh.Close()
	if sensitivePath(root.Root, rel) && !reveal {
		return errSensitiveImage
	}
	fi, err := fh.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return errNotImage
	}
	if fi.Size() > maxImageSize {
		return errImageTooLarge
	}
	ct, err := checkImage(rel, fh)
	if err != nil {
		return err
	}
	writeImage(w, ct, fi.Size(), fh)
	return nil
}

// serveImageVersion serves the old or new version of an image git status
// lists, on the side (staged or not) it lists it. The client never names a
// revision: imageVersion picks it from the entry.
func (f *filesAPI) serveImageVersion(w http.ResponseWriter, ctx context.Context, root filesRoot, path, orig string, staged bool, side string, reveal bool) error {
	rel, err := cleanRelPath(path)
	if err != nil {
		return err
	}
	if !root.IsRepo {
		return errNotChanged
	}
	st, err := f.status(ctx, root)
	if err != nil {
		return err
	}
	entry := findChange(st, path, orig, staged)
	if entry == nil {
		return errNotChanged
	}
	if f.denied(root.Root, rel, root.GitDir) || orig != "" && f.deniedPath(root.Root, orig, root.GitDir) {
		return errPathNotAllowed
	}
	// Checked again now: the cached status may predate a symlink change.
	if (entry.Sensitive || sensitivePath(root.Root, rel) ||
		orig != "" && sensitivePath(root.Root, filepath.FromSlash(orig))) && !reveal {
		return errSensitiveImage
	}
	spec, name, worktree, ok := imageVersion(*entry, staged, side)
	if !ok {
		return errNoVersion
	}
	if worktree {
		return f.serveWorktreeImage(w, root, path, reveal)
	}
	// cat-file --batch reads one name per line, and drops a '\r' ending
	// it: "a.png\r" would be read as a.png.
	if strings.ContainsAny(name, "\r\n") {
		return errInvalidPath
	}
	blob, err := f.gitBlob(ctx, root, spec)
	if err != nil {
		return err
	}
	r := bytes.NewReader(blob)
	ct, err := checkImage(name, r)
	if err != nil {
		return err
	}
	writeImage(w, ct, int64(len(blob)), r)
	return nil
}

// imageVersion picks where one version of an entry is read: a blob spec,
// or the worktree. name is the path that version has. The index is always
// named with stage 0: git reads ":1:a.png" as stage 1 of a.png, so a file
// named "1:a.png" would otherwise be read as another file.
func imageVersion(e changeEntry, staged bool, side string) (spec, name string, worktree, ok bool) {
	switch {
	case !staged && side == "new":
		return "", e.Path, true, e.Unstaged != "D"
	case !staged:
		// Untracked and intent-to-add have no index version (the latter
		// holds an empty blob), nor has a conflict a stage 0.
		if e.Unstaged == "?" || e.Unstaged == "A" || e.Conflict {
			return "", "", false, false
		}
		name = e.Path
		if e.Unstaged == "R" || e.Unstaged == "C" {
			name = e.Orig
		}
		return ":0:" + name, name, false, true
	case side == "old":
		if e.Staged == "A" {
			return "", "", false, false
		}
		name = e.Path
		if e.Orig != "" {
			name = e.Orig
		}
		// HEAD:<path> splits at the first ':', so the path is taken whole.
		return "HEAD:" + name, name, false, true
	default:
		return ":0:" + e.Path, e.Path, false, e.Staged != "D"
	}
}

// gitBlob reads one blob with `git cat-file --batch`: its size and contents
// come from one read of the object. It is not heavy: it takes neither a slot
// of status/diff nor backs the root off, since rawSlots already bounds it.
func (f *filesAPI) gitBlob(ctx context.Context, root filesRoot, spec string) ([]byte, error) {
	out, _, err := f.git.output(ctx, gitCall{
		root: root.Root, safeDir: root.SafeDir, noFilters: true,
		limit: maxImageSize + catFileHeaderMax, stdin: []byte(spec + "\n"),
	}, "cat-file", "--batch")
	if err != nil {
		if ctx.Err() != nil {
			// The request's budget ran out: git was killed, not refused.
			return nil, errGitTimeout
		}
		return nil, err
	}
	header, body, found := bytes.Cut(out, []byte("\n"))
	if !found {
		return nil, fmt.Errorf("git cat-file: no header in %d bytes", len(out))
	}
	line := string(header)
	if line == spec+" missing" || line == spec+" ambiguous" {
		return nil, errNoVersion
	}
	fields := strings.Fields(line)
	if len(fields) != 3 {
		return nil, fmt.Errorf("git cat-file: unexpected header %q", line)
	}
	size, err := strconv.ParseInt(fields[2], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("git cat-file: unexpected header %q", line)
	}
	if fields[1] != "blob" {
		return nil, errNotImage
	}
	if size > maxImageSize {
		return nil, errImageTooLarge
	}
	if int64(len(body)) < size {
		return nil, fmt.Errorf("git cat-file: %d of %d bytes", len(body), size)
	}
	return body[:size], nil
}
