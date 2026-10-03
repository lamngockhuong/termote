package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"unicode/utf8"
)

const (
	// maxDirEntries caps one directory listing.
	maxDirEntries = 5000
	// maxPreviewSize caps a file shown by the content route.
	maxPreviewSize = 1 << 20
	// binarySniffSize: a NUL byte this early marks a file as binary.
	binarySniffSize = 8 << 10
	// filesTimeout bounds one files request: the pane lookup plus git.
	filesTimeout = muxTimeout + gitTimeout
)

var (
	errPathNotAllowed = errors.New("path not allowed")
	errInvalidPath    = inputError("invalid path")
	errNotADirectory  = inputError("not a directory")
)

// rootChangedError: the client sent a root other than the pane's current one.
type rootChangedError struct{ root string }

func (e *rootChangedError) Error() string { return "root changed" }

// requireFilesRead is where roles (#236, a view-only role) will be enforced on
// the files routes. It allows everything today; a view-only role must at
// least be refused reveal=1 and the contents of sensitive files.
func requireFilesRead(http.ResponseWriter, *http.Request) bool { return true }

// filesAPI serves /api/mux/panes/{id}/files/*: read-only views of the files
// under a pane's root (its git toplevel, else its directory).
type filesAPI struct {
	m        Mux
	dirs     PaneDirer // nil when the backend has none
	allowed  hostAllowlist
	deny     []string // absolute directories never served
	git      *gitRunner
	roots    *rootResolver
	statuses *ttlCache[gitStatus] // root → git status
}

// filesDenyDirs returns the directories the files routes never serve, as
// configured plus their resolved form.
func filesDenyDirs(dirs ...string) []string {
	var out []string
	for _, d := range dirs {
		if d == "" {
			continue
		}
		out = append(out, filepath.Clean(d))
		if r, err := filepath.EvalSymlinks(d); err == nil && r != filepath.Clean(d) {
			out = append(out, r)
		}
	}
	return out
}

// registerFilesRoutes is registered for every backend: one without a pane
// directory answers 501.
func registerFilesRoutes(mux *http.ServeMux, m Mux, allowed hostAllowlist, denyDirs []string) *filesAPI {
	dirs, _ := m.(PaneDirer)
	git := newGitRunner()
	f := &filesAPI{
		m: m, dirs: dirs, allowed: allowed, git: git, roots: newRootResolver(git),
		statuses: newTTLCache[gitStatus](filesRootTTL),
		deny:     append(filesDenyDirs(systemDenyDirs...), filesDenyDirs(denyDirs...)...),
	}
	mux.HandleFunc("/api/mux/panes/{id}/files/tree", f.handleTree)
	mux.HandleFunc("/api/mux/panes/{id}/files/content", f.handleContent)
	mux.HandleFunc("/api/mux/panes/{id}/files/changes", f.handleChanges)
	mux.HandleFunc("/api/mux/panes/{id}/files/diff", f.handleDiff)
	return f
}

// filesRequest is what every files handler starts from.
type filesRequest struct {
	ctx  context.Context
	root filesRoot
}

// begin checks the request and resolves the pane's root. The files routes
// are GETs, which writeGuard lets through, so the cross-site check runs here:
// with --no-auth another page could otherwise make the server run git in a
// pane's repo.
func (f *filesAPI) begin(w http.ResponseWriter, r *http.Request) (*filesRequest, context.CancelFunc, bool) {
	if !requireMethod(w, r, http.MethodGet) {
		return nil, nil, false
	}
	if msg := crossSiteRejection(f.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return nil, nil, false
	}
	if !requireFilesRead(w, r) {
		return nil, nil, false
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if f.dirs == nil || !f.m.Caps().Files {
		f.error(w, "files", errUnsupported)
		return nil, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), filesTimeout)
	root, err := f.roots.paneRoot(ctx, f.dirs, r.PathValue("id"))
	if err == nil {
		if seen := r.URL.Query().Get("root"); seen != "" && seen != root.Root {
			err = &rootChangedError{root.Root}
		}
	}
	if err != nil {
		cancel()
		f.error(w, "files root", err)
		return nil, nil, false
	}
	return &filesRequest{ctx: ctx, root: root}, cancel, true
}

// cleanRelPath turns a client path into a local one ("" is the root). Paths
// that are absolute, climb with "..", hold a NUL or (Windows) name a drive or
// device are refused before os.Root sees them; on Unix '\' is an ordinary
// file name character.
func cleanRelPath(p string) (string, error) {
	if p == "" {
		return ".", nil
	}
	if strings.ContainsRune(p, 0) {
		return "", errInvalidPath
	}
	c := filepath.Clean(filepath.FromSlash(p))
	if !filepath.IsLocal(c) {
		return "", errInvalidPath
	}
	return c, nil
}

// denied reports whether rel under root is never served: under a deny dir
// (f.deny, then extra), or inside the repo's .git, by its path or by where
// its symlinks lead. The check runs before the open: a local process that
// can write inside the root could swap a link in between, but such a process
// can read the file itself anyway.
func (f *filesAPI) denied(root, rel string, extra ...string) bool {
	abs := filepath.Join(root, rel)
	paths := []string{abs}
	if real, err := filepath.EvalSymlinks(abs); err == nil && real != abs {
		paths = append(paths, real)
	}
	for _, p := range paths {
		for _, d := range f.deny {
			if underDir(d, p) {
				return true
			}
		}
		for _, d := range extra {
			if d != "" && underDir(d, p) {
				return true
			}
		}
		if r, err := filepath.Rel(root, p); err == nil && filepath.IsLocal(r) {
			for _, part := range strings.Split(filepath.ToSlash(r), "/") {
				if isGitDirName(part) {
					return true
				}
			}
		}
	}
	return false
}

// isGitDirName matches a path component that can name the repo's .git:
// Windows ignores case and trailing dots and spaces, and answers to the 8.3
// short name (GIT~1). Elsewhere this only refuses a few more odd names.
func isGitDirName(part string) bool {
	return strings.EqualFold(strings.TrimRight(part, ". "), ".git") ||
		strings.HasPrefix(strings.ToUpper(part), "GIT~")
}

// underDir reports whether p is dir or below it. File names are compared
// without case where the file system usually ignores it.
func underDir(dir, p string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		dir, p = strings.ToLower(dir), strings.ToLower(p)
	}
	rel, err := filepath.Rel(dir, p)
	return err == nil && filepath.IsLocal(rel)
}

// sensitivePath checks the path asked for and, through symlinks, the file it
// leads to: notes.txt -> .env is sensitive.
func sensitivePath(root, rel string) bool {
	abs := filepath.Join(root, rel)
	if isSensitive(abs) {
		return true
	}
	real, err := filepath.EvalSymlinks(abs)
	return err == nil && isSensitive(real)
}

type fileEntry struct {
	Name string `json:"name"`
	Type string `json:"type"` // dir | file | symlink | other
	// Target is what a symlink inside the root leads to (dir | file | other);
	// empty for a broken one or one that leaves the root.
	Target    string `json:"target,omitempty"`
	Size      int64  `json:"size"`
	Sensitive bool   `json:"sensitive"`
}

type treeResponse struct {
	Root      string      `json:"root"`
	IsRepo    bool        `json:"isRepo"`
	Path      string      `json:"path"`
	Entries   []fileEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

func (f *filesAPI) handleTree(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	res, err := f.tree(req.root, r.URL.Query().Get("path"))
	if err != nil {
		f.error(w, "files tree", err)
		return
	}
	jsonOK(w, res)
}

func (f *filesAPI) tree(root filesRoot, p string) (treeResponse, error) {
	rel, err := cleanRelPath(p)
	if err != nil {
		return treeResponse{}, err
	}
	if f.denied(root.Root, rel, root.GitDir) {
		return treeResponse{}, errPathNotAllowed
	}
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return treeResponse{}, err
	}
	defer rt.Close()
	d, err := rt.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return treeResponse{}, err
	}
	defer d.Close()
	if fi, err := d.Stat(); err != nil {
		return treeResponse{}, err
	} else if !fi.IsDir() {
		return treeResponse{}, errNotADirectory
	}
	ents, err := d.ReadDir(maxDirEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return treeResponse{}, err
	}
	res := treeResponse{Root: root.Root, IsRepo: root.IsRepo, Path: filepath.ToSlash(rel), Entries: []fileEntry{}}
	if len(ents) > maxDirEntries {
		ents, res.Truncated = ents[:maxDirEntries], true
	}
	for _, e := range ents {
		if isGitDirName(e.Name()) {
			continue
		}
		child := filepath.Join(rel, e.Name())
		fe := fileEntry{Name: e.Name(), Type: entryType(e.Type())}
		switch fe.Type {
		case "file":
			if info, err := e.Info(); err == nil {
				fe.Size = info.Size()
			}
		case "symlink":
			// Stat through the root: a link that leaves it fails. A link
			// into a denied dir shows nothing of its target.
			if f.denied(root.Root, child, root.GitDir) {
				break
			}
			if info, err := rt.Stat(child); err == nil {
				fe.Target = entryType(info.Mode().Type())
				if fe.Target == "file" {
					fe.Size = info.Size()
				}
			}
		}
		fe.Sensitive = fe.Type != "dir" && sensitivePath(root.Root, child)
		res.Entries = append(res.Entries, fe)
	}
	sort.Slice(res.Entries, func(i, j int) bool {
		a, b := res.Entries[i], res.Entries[j]
		if ad, bd := isDirEntry(a), isDirEntry(b); ad != bd {
			return ad
		}
		if al, bl := strings.ToLower(a.Name), strings.ToLower(b.Name); al != bl {
			return al < bl
		}
		return a.Name < b.Name
	})
	return res, nil
}

func isDirEntry(e fileEntry) bool { return e.Type == "dir" || e.Target == "dir" }

func entryType(m fs.FileMode) string {
	switch {
	case m.IsDir():
		return "dir"
	case m.IsRegular():
		return "file"
	case m&fs.ModeSymlink != 0:
		return "symlink"
	}
	return "other"
}

type contentResponse struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	Text string `json:"text"`
}

type unpreviewableResponse struct {
	Root        string `json:"root"`
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	Previewable bool   `json:"previewable"`
	Reason      string `json:"reason"` // binary | too-large | not-regular
}

type sensitiveResponse struct {
	Root      string `json:"root"`
	Path      string `json:"path"`
	Sensitive bool   `json:"sensitive"`
}

func (f *filesAPI) handleContent(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	q := r.URL.Query()
	res, err := f.content(req.root, q.Get("path"), q.Get("reveal") == "1")
	if err != nil {
		f.error(w, "files content", err)
		return
	}
	jsonOK(w, res)
}

func (f *filesAPI) content(root filesRoot, p string, reveal bool) (any, error) {
	rel, err := cleanRelPath(p)
	if err != nil {
		return nil, err
	}
	if f.denied(root.Root, rel, root.GitDir) {
		return nil, errPathNotAllowed
	}
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return nil, err
	}
	defer rt.Close()
	text, size, reason, err := readPreview(rt, rel)
	if err != nil {
		return nil, err
	}
	slash := filepath.ToSlash(rel)
	if sensitivePath(root.Root, rel) && !reveal {
		return sensitiveResponse{Root: root.Root, Path: slash, Sensitive: true}, nil
	}
	if reason != "" {
		return unpreviewableResponse{Root: root.Root, Path: slash, Size: size, Reason: reason}, nil
	}
	return contentResponse{Root: root.Root, Path: slash, Size: size, Text: text}, nil
}

// readPreview reads a regular text file of at most maxPreviewSize. Every
// check runs on the open handle, so a file swapped after the path checks is
// still judged by what was opened. reason is set when it cannot be shown.
func readPreview(rt *os.Root, rel string) (text string, size int64, reason string, err error) {
	fh, err := rt.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return "", 0, "", err
	}
	defer fh.Close()
	fi, err := fh.Stat()
	if err != nil {
		return "", 0, "", err
	}
	if !fi.Mode().IsRegular() {
		return "", 0, "not-regular", nil
	}
	size = fi.Size()
	if size > maxPreviewSize {
		return "", size, "too-large", nil
	}
	b, err := io.ReadAll(io.LimitReader(fh, maxPreviewSize+1))
	if err != nil {
		return "", size, "", err
	}
	if len(b) > maxPreviewSize {
		return "", size, "too-large", nil
	}
	if isBinary(b) {
		return "", size, "binary", nil
	}
	return string(b), int64(len(b)), "", nil
}

// isBinary: a NUL byte near the start, or not UTF-8.
func isBinary(b []byte) bool {
	return bytes.IndexByte(b[:min(len(b), binarySniffSize)], 0) >= 0 || !utf8.Valid(b)
}

// error maps a files error to a response. Client mistakes are returned as
// they are; anything else is logged and answered generically.
func (f *filesAPI) error(w http.ResponseWriter, op string, err error) {
	var rc *rootChangedError
	var ie inputError
	switch {
	case errors.As(err, &rc):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": rc.Error(), "root": rc.root})
	case errors.As(err, &ie):
		jsonError(w, ie.Error(), http.StatusBadRequest)
	case isPathEscape(err):
		jsonError(w, "path outside root", http.StatusBadRequest)
	case errors.Is(err, errNotChanged):
		jsonError(w, errNotChanged.Error(), http.StatusNotFound)
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOTDIR):
		jsonError(w, "not found", http.StatusNotFound)
	case errors.Is(err, fs.ErrPermission):
		jsonError(w, "permission denied", http.StatusForbidden)
	case errors.Is(err, errPathNotAllowed):
		jsonError(w, errPathNotAllowed.Error(), http.StatusForbidden)
	case errors.Is(err, errUnsupported):
		jsonError(w, errUnsupported.Error(), http.StatusNotImplemented)
	case errors.Is(err, errGitTimeout):
		jsonError(w, "git timed out", http.StatusServiceUnavailable)
	default:
		log.Printf("%s %s error: %v", f.m.Name(), op, err)
		jsonError(w, "files request failed", http.StatusInternalServerError)
	}
}

// isPathEscape matches os.Root's error for a path (or symlink) that leaves the
// root; the error value is not exported.
func isPathEscape(err error) bool {
	var pe *fs.PathError
	return errors.As(err, &pe) && strings.Contains(pe.Err.Error(), "path escapes from parent")
}
