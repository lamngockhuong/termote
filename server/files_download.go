package main

import (
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// maxDownloadSize caps a file the download route sends.
	maxDownloadSize = 100 << 20
	// downloadChunk is sent per write deadline.
	downloadChunk = 256 << 10
	// downloadPolicy is added to the page's own CSP: a download opened
	// directly runs nothing under termote's origin.
	downloadPolicy = "sandbox; default-src 'none'"
)

var (
	// downloadIdleTimeout drops a client that stopped reading: each chunk
	// gets this long. downloadMaxDuration bounds the whole download, so a
	// slot (shared with files/raw) is never held for ever; it covers
	// 100 MiB at about 0.5 Mbit/s. Variables so tests can shorten them.
	downloadIdleTimeout = 2 * time.Minute
	downloadMaxDuration = 30 * time.Minute
	// downloadBeforeCopy runs between the checks and the copy (tests).
	downloadBeforeCopy = func(*os.File) {}
)

var (
	errDownloadNotFile   = &codedError{"not_file", "not a regular file", http.StatusBadRequest}
	errDownloadTooLarge  = &codedError{"too_large", "file is larger than 100 MiB", http.StatusRequestEntityTooLarge}
	errDownloadBusy      = &codedError{"busy", "too many files at once; try again", http.StatusTooManyRequests}
	errDownloadSensitive = &codedError{"sensitive", "sensitive file; reveal=1 to download it", http.StatusForbidden}
)

// downloadCheck is the answer of check=1: what a download would send.
type downloadCheck struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// handleDownload serves GET files/download?root=&path=&reveal=[&check=1]:
// a regular file under the root as an attachment the browser never renders.
// check=1 runs the same checks and answers {root, path, size} instead, so
// the PWA can tell why a download would fail (a link never tells the page).
func (f *filesAPI) handleDownload(w http.ResponseWriter, r *http.Request) {
	// Added, not set: the browser enforces both policies, on errors too.
	w.Header().Add("Content-Security-Policy", downloadPolicy)
	if !requireWriteRole(w, r) {
		return
	}
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	q := r.URL.Query()
	check := q.Get("check") == "1"
	if check {
		if len(f.rawSlots) == cap(f.rawSlots) {
			f.error(w, "files download", errDownloadBusy)
			return
		}
	} else {
		select {
		case f.rawSlots <- struct{}{}:
			defer func() { <-f.rawSlots }()
		default:
			f.error(w, "files download", errDownloadBusy)
			return
		}
	}
	fh, rel, size, err := f.openDownload(req.root, q.Get("path"), q.Get("reveal") == "1")
	if err != nil {
		f.error(w, "files download", err)
		return
	}
	defer fh.Close()
	if check {
		w.Header().Set("Cache-Control", "no-store")
		jsonOK(w, downloadCheck{Root: req.root.Root, Path: filepath.ToSlash(rel), Size: size})
		return
	}
	by, via := auditWho(r)
	auditf("download", "path", filepath.ToSlash(rel), "size", size, "by", by, "via", via)
	downloadBeforeCopy(fh)
	writeDownload(w, filepath.Base(rel), size, fh)
}

// openDownload checks rel under root and opens it, in a delete's order but
// read only: no symlink or junction on the way (each directory checked as it
// is opened), not denied, a regular file, the one opened, at most 100 MiB.
// A missing file is 404 even when its name is sensitive. The caller closes
// the file.
func (f *filesAPI) openDownload(root filesRoot, p string, reveal bool) (*os.File, string, int64, error) {
	rel, err := cleanRelPath(p)
	if err != nil {
		return nil, "", 0, err
	}
	if rel == "." {
		return nil, "", 0, errDownloadNotFile
	}
	if f.createDenied(root, rel) {
		return nil, "", 0, errCreateNotAllowed
	}
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return nil, "", 0, err
	}
	parent, err := f.walkParents(rt, root, filepath.Dir(rel), false)
	if err != nil {
		return nil, "", 0, deleteError(err)
	}
	defer parent.Close()
	base := filepath.Base(rel)
	lfi, err := parent.Lstat(base)
	if err != nil {
		return nil, "", 0, deleteError(err)
	}
	if lfi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
		return nil, "", 0, errCreateSymlink
	}
	if !lfi.Mode().IsRegular() {
		return nil, "", 0, errDownloadNotFile
	}
	if sensitivePath(root.Root, rel) && !reveal {
		return nil, "", 0, errDownloadSensitive
	}
	fh, err := parent.OpenFile(base, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, "", 0, deleteError(err)
	}
	fi, err := fh.Stat()
	switch {
	case err != nil || !os.SameFile(lfi, fi) || !fi.Mode().IsRegular():
		err = errEditChanged
	case fi.Size() > maxDownloadSize:
		err = errDownloadTooLarge
	}
	if err != nil {
		fh.Close()
		return nil, "", 0, err
	}
	return fh, rel, fi.Size(), nil
}

// writeDownload sends size bytes of r as an attachment named name. Headers
// are gone once it starts, so a short read or a client that stops reading
// only cuts the response (Content-Length no longer matches), logged. A file
// that grew sends only the size checked.
func writeDownload(w http.ResponseWriter, name string, size int64, r io.Reader) {
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	h.Set("Content-Disposition", "attachment; filename*=UTF-8''"+rfc5987Escape(downloadName(name)))
	h.Set("Cache-Control", "no-store")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	rc := http.NewResponseController(w)
	end := time.Now().Add(downloadMaxDuration)
	w.WriteHeader(http.StatusOK)
	for left := size; left > 0; {
		_ = rc.SetWriteDeadline(minTime(time.Now().Add(downloadIdleTimeout), end))
		n, err := io.CopyN(w, r, min(left, downloadChunk))
		left -= n
		if err != nil {
			log.Printf("files download: sending %d of %d bytes: %v", size-left, size, err)
			return
		}
	}
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// downloadName is the file name the browser is offered: without control
// and format characters (bidi, zero-width), which could make one name pose
// as another in the download list.
func downloadName(base string) string {
	if s := stripUnsafeRunes(base); s != "" {
		return s
	}
	return "download"
}

// rfc5987Escape percent-encodes s as an ext-value (RFC 5987): every byte but
// attr-char. url.PathEscape would leave ';' and '=', which end the value.
func rfc5987Escape(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte("!#$&+-.^_`|~", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}

// auditWho names who made a request and how it signed in, for an audit
// line: none for both under --no-auth.
func auditWho(r *http.Request) (by, via string) {
	a, ok := authFrom(r.Context())
	if !ok {
		return "none", "none"
	}
	switch a.Kind {
	case authSession:
		via = "session"
	case authDevice:
		via = "device"
	case authBasic:
		via = "basic"
	case authLocal:
		via = "local"
	default:
		via = "unknown"
	}
	return auditBy(a), via
}
