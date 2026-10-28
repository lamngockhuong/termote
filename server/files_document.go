package main

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	// maxDocumentSize caps a PDF, .xlsx or .docx the document route sends:
	// the PWA holds it whole while a worker parses it.
	maxDocumentSize = 30 << 20
	// documentSniffSize is read to check a document's kind: a PDF may have
	// bytes before its %PDF- header.
	documentSniffSize = 1024
)

var (
	errDocumentTooLarge  = &codedError{"too_large", "file is larger than 30 MiB", http.StatusRequestEntityTooLarge}
	errNotDocument       = &codedError{"not_document", "not a PDF, .xlsx or .docx file", http.StatusUnsupportedMediaType}
	errDocumentEncrypted = &codedError{"encrypted", "password-protected or encrypted file", http.StatusUnsupportedMediaType}
	errDocumentBusy      = &codedError{"busy", "too many files at once; try again", http.StatusTooManyRequests}
	errDocumentSide      = inputError("side is not supported")
)

// documentTooLargeError carries the size of a document over the limit, so
// the client can say how large it is.
type documentTooLargeError struct{ size int64 }

func (e *documentTooLargeError) Error() string { return errDocumentTooLarge.msg }
func (e *documentTooLargeError) Unwrap() error { return errDocumentTooLarge }

// oleMagic starts a Compound File: an .xlsx or .docx saved with a password
// (or IRM) is one, not a zip.
var oleMagic = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}

// documentKind tells a document's kind from its name: pdf, xlsx or docx.
func documentKind(path string) (string, bool) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".pdf":
		return "pdf", true
	case ".xlsx":
		return "xlsx", true
	case ".docx":
		return "docx", true
	}
	return "", false
}

// checkDocument checks that head, the first bytes of a file named as kind,
// is one: a PDF holds %PDF- (after any junk), an .xlsx or .docx is a zip.
func checkDocument(kind string, head []byte) error {
	if bytes.HasPrefix(head, []byte(lfsPointerPrefix)) {
		return errLFSPointer
	}
	if kind == "pdf" {
		if !bytes.Contains(head, []byte("%PDF-")) {
			return errNotDocument
		}
		return nil
	}
	if bytes.HasPrefix(head, oleMagic) {
		return errDocumentEncrypted
	}
	if !bytes.HasPrefix(head, []byte("PK\x03\x04")) {
		return errNotDocument
	}
	return nil
}

// handleDocument serves GET files/document?root=&path=&reveal=: the bytes
// of a PDF, .xlsx or .docx under the root, for the PWA to parse in a
// worker. A view-only client reads it too, as it reads files/raw; each send
// is audited, as a download is.
func (f *filesAPI) handleDocument(w http.ResponseWriter, r *http.Request) {
	// Added, not set: the browser enforces both policies, on errors too.
	w.Header().Add("Content-Security-Policy", downloadPolicy)
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	if !f.takeRawSlot(r) {
		f.error(w, "files document", errDocumentBusy)
		return
	}
	defer func() { <-f.rawSlots }()
	q := r.URL.Query()
	fh, rel, size, err := f.openDocument(req, q)
	if err != nil {
		f.error(w, "files document", err)
		return
	}
	defer fh.Close()
	by, via := auditWho(r)
	auditf("document", "path", filepath.ToSlash(rel), "size", size, "by", by, "via", via)
	writeDownload(w, filepath.Base(rel), size, fh)
}

// openDocument checks and opens the document q names. Every check runs on
// the open handle, in content()'s order: a missing file is 404 even when its
// name is sensitive. The caller closes the file.
func (f *filesAPI) openDocument(req *filesRequest, q url.Values) (*os.File, string, int64, error) {
	if q.Get("side") != "" {
		return nil, "", 0, errDocumentSide
	}
	p := q.Get("path")
	if f.viewHides(req, p, false, false) {
		return nil, "", 0, os.ErrNotExist
	}
	rel, err := cleanRelPath(p)
	if err != nil {
		return nil, "", 0, err
	}
	kind, ok := documentKind(rel)
	if !ok {
		return nil, "", 0, errNotDocument
	}
	root := req.root
	if f.denied(root.Root, rel, root.GitDir) {
		return nil, "", 0, errPathNotAllowed
	}
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return nil, "", 0, err
	}
	defer rt.Close()
	fh, err := rt.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, "", 0, err
	}
	size, err := checkDocumentFile(root.Root, rel, kind, q.Get("reveal") == "1", fh)
	if err != nil {
		fh.Close()
		return nil, "", 0, err
	}
	return fh, rel, size, nil
}

// checkDocumentFile checks the open fh and leaves it at its start: not
// sensitive unless revealed, a regular file within the limit, of kind.
func checkDocumentFile(root, rel, kind string, reveal bool, fh *os.File) (int64, error) {
	if sensitivePath(root, rel) && !reveal {
		return 0, errSensitiveImage
	}
	fi, err := fh.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return 0, errNotDocument
	}
	if fi.Size() > maxDocumentSize {
		return 0, &documentTooLargeError{fi.Size()}
	}
	head := make([]byte, documentSniffSize)
	n, err := io.ReadFull(fh, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return 0, err
	}
	if err := checkDocument(kind, head[:n]); err != nil {
		return 0, err
	}
	if _, err := fh.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	return fi.Size(), nil
}
