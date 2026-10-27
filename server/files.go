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
	"os/user"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
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
	// decodeMaxRunning reads of a file not in UTF-8 run at once,
	// server-wide; the next gets 429.
	decodeMaxRunning = 2
)

var (
	errPathNotAllowed = errors.New("path not allowed")
	errInvalidPath    = inputError("invalid path")
	errNotADirectory  = inputError("not a directory")
	errBadEncoding    = inputError("unknown encoding")
	errDecodeBusy     = &codedError{"busy", "too many files being decoded at once; try again", http.StatusTooManyRequests}
)

// rootChangedError: the client sent a root other than the pane's current one.
type rootChangedError struct{ root string }

func (e *rootChangedError) Error() string { return "root changed" }

// filesAPI serves /api/mux/panes/{id}/files/*: views of the files under a
// pane's root (its git toplevel, else its directory), saves of a text file's
// whole contents (PUT files/content), creates of an empty file (POST
// files/create), renames (POST files/rename), deletes into a trash and
// back (POST files/delete, files/restore), downloads (GET files/download),
// stages, unstages or discards of a change (POST files/changes/apply) and
// the bytes of a document to preview (GET files/document).
type filesAPI struct {
	m        Mux
	dirs     PaneDirer // nil when the backend has none
	allowed  hostAllowlist
	deny     []string // absolute directories never served
	git      *gitRunner
	roots    *rootResolver
	statuses *ttlCache[gitStatus]  // root → git status
	commits  *ttlCache[commitList] // root and commit hash → its files
	finds    *ttlCache[findList]   // root + list kind → file list (files/find)
	rawSlots chan struct{}         // raw requests running, server-wide
	// searchSlots are the content searches running, server-wide.
	searchSlots chan struct{}
	// decodeSlots are the reads of a file not in UTF-8 running,
	// server-wide.
	decodeSlots chan struct{}
	// writeDeny are directories a save never writes to, on top of deny:
	// the install's data dir (its current pointer picks the binary the
	// service runs) and the upload store.
	writeDeny []string
	// homeDirs count as a home dir besides the server user's: no view-only
	// client reads a root at or above one (holdsHome).
	homeDirs   []string
	writeSlots chan struct{} // saves running, server-wide
	writeLocks *writeLocks
	// trash keeps what files/delete removed, for files/restore; nil when
	// the server has no usable trash dir.
	trash *trashStore
	// places are the folders allowed with --allow-path (setPlaces);
	// placeNow caches where each leads now, checked on every request.
	places   []place
	placeNow *ttlCache[string]
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
		statuses:    newTTLCache[gitStatus](filesRootTTL),
		commits:     newTTLCache[commitList](commitFilesTTL),
		finds:       newTTLCache[findList](findListTTL),
		rawSlots:    make(chan struct{}, rawMaxRunning),
		searchSlots: make(chan struct{}, searchMaxRunning),
		decodeSlots: make(chan struct{}, decodeMaxRunning),
		deny:        slices.Concat(filesDenyDirs(systemDenyDirs...), filesDenyDirs(keyDirs()...), filesDenyDirs(denyDirs...)),
		placeNow:    newTTLCache[string](placeCheckTTL),
		writeSlots:  make(chan struct{}, writeMaxRunning),
		writeLocks:  &writeLocks{locks: map[string]*sync.Mutex{}},
	}
	mux.HandleFunc("/api/mux/panes/{id}/files/tree", f.handleTree)
	mux.HandleFunc("/api/mux/panes/{id}/files/content", f.handleContent)
	// More specific than the pattern above: only PUT comes here.
	mux.HandleFunc("PUT /api/mux/panes/{id}/files/content", f.handleWriteContent)
	// Without a method: a GET or PUT gets 405 here, not the /api/ 404.
	mux.HandleFunc("/api/mux/panes/{id}/files/create", f.handleCreateFile)
	mux.HandleFunc("/api/mux/panes/{id}/files/image", f.handleImage)
	mux.HandleFunc("/api/mux/panes/{id}/files/delete", f.handleDeleteFile)
	mux.HandleFunc("/api/mux/panes/{id}/files/restore", f.handleRestoreFile)
	mux.HandleFunc("/api/mux/panes/{id}/files/rename", f.handleRenameFile)
	mux.HandleFunc("/api/mux/panes/{id}/files/find", f.handleFind)
	mux.HandleFunc("/api/mux/panes/{id}/files/search", f.handleSearch)
	mux.HandleFunc("/api/mux/panes/{id}/files/changes", f.handleChanges)
	mux.HandleFunc("/api/mux/panes/{id}/files/changes/apply", f.handleApplyChange)
	mux.HandleFunc("/api/mux/panes/{id}/files/diff", f.handleDiff)
	mux.HandleFunc("/api/mux/panes/{id}/files/commit", f.handleCommit)
	mux.HandleFunc("/api/mux/panes/{id}/files/commit/diff", f.handleCommitDiff)
	mux.HandleFunc("/api/mux/panes/{id}/files/raw", f.handleRaw)
	mux.HandleFunc("/api/mux/panes/{id}/files/download", f.handleDownload)
	mux.HandleFunc("/api/mux/panes/{id}/files/document", f.handleDocument)
	mux.HandleFunc("/api/mux/files/places", f.handlePlaces)
	return f
}

// filesRequest is what every files handler starts from.
type filesRequest struct {
	ctx  context.Context
	root filesRoot
	// view is the root's tracked list for a view-only client (nil for a
	// full one): it reads nothing else (viewHides).
	view *findList
}

// begin checks a GET and resolves the pane's root.
func (f *filesAPI) begin(w http.ResponseWriter, r *http.Request) (*filesRequest, context.CancelFunc, bool) {
	if !requireMethod(w, r, http.MethodGet) {
		return nil, nil, false
	}
	return f.start(w, r, requireFilesRead)
}

// start checks a files request (cross-site, then allow for the role) and
// resolves the pane's root, or with place=<id> that Place (full clients
// only, and not for Changes), refusing one the client saw as another (the
// root query). writeGuard lets GETs through, and with --no-auth another page could
// otherwise make the server run git in a pane's repo.
func (f *filesAPI) start(w http.ResponseWriter, r *http.Request, allow func(http.ResponseWriter, *http.Request) bool) (*filesRequest, context.CancelFunc, bool) {
	if msg := crossSiteRejection(f.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return nil, nil, false
	}
	if !allow(w, r) {
		return nil, nil, false
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	ctx, cancel := context.WithTimeout(r.Context(), filesTimeout)
	var root filesRoot
	var err error
	switch id := r.URL.Query().Get("place"); {
	case id == "":
		root, err = f.paneRootForRead(ctx, r.PathValue("id"))
	case isViewOnly(r):
		// A Place such as ~/dotfiles is not for every paired viewer.
		cancel()
		writeViewOnly(w)
		return nil, nil, false
	case placeRefused(r):
		err = errPlaceNotSupported
	default:
		root, err = f.placeRoot(ctx, id)
	}
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
	req := &filesRequest{ctx: ctx, root: root}
	// The sensitive names are no boundary for a client with a shell, but a
	// view-only client has none: a pane in the home dir would show it
	// shell histories and tool configs holding keys under ordinary names.
	// It reads files in a git repo only, never the home dir or one above it
	// (`git init ~` makes every dotfile an untracked file), and only what git
	// lists as tracked or untracked and not ignored.
	if isViewOnly(r) {
		if f.viewHidesRoot(root) {
			cancel()
			writeViewOnly(w)
			return nil, nil, false
		}
		lists, err := f.findLists(ctx, root, findQuery{})
		if err != nil {
			cancel()
			f.error(w, "files view list", err)
			return nil, nil, false
		}
		req.view = &lists[0]
	}
	return req, cancel, true
}

// paneRootForRead resolves the root of paneID's directory for a read, when
// the backend offers files (errUnsupported otherwise). Files and the
// overview's changes both read through it.
func (f *filesAPI) paneRootForRead(ctx context.Context, paneID string) (filesRoot, error) {
	if f.dirs == nil || !f.m.Caps().Files {
		return filesRoot{}, errUnsupported
	}
	return f.roots.paneRoot(ctx, f.dirs, paneID)
}

// viewHidesRoot reports whether a view-only client may read nothing of
// root: it is no git repo, or it is a home dir or one above it.
func (f *filesAPI) viewHidesRoot(root filesRoot) bool {
	return !root.IsRepo || f.holdsHome(root.Root)
}

// holdsHome reports whether dir is a home dir or one above it, through
// symlinks: the server user's (from the environment, else the user
// database; with neither, every dir counts as holding it) or one of
// f.homeDirs (the container's /workspace when the host mounted its home).
func (f *filesAPI) holdsHome(dir string) bool {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		u, uerr := user.Current()
		if uerr != nil || u.HomeDir == "" {
			return true
		}
		home = u.HomeDir
	}
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	for _, h := range append([]string{home}, f.homeDirs...) {
		if real, err := filepath.EvalSymlinks(h); err == nil {
			h = real
		}
		if underDir(dir, h) {
			return true
		}
	}
	return false
}

// viewHides reports whether a view-only request may not read p (dir: as a
// directory): p is not in the root's tracked list (git ignores it, or the
// list was cut short), or its symlinks lead to a path that is not. listed:
// p is vouched for already (a git status entry), only where it leads is
// checked. A full request is never hidden anything.
func (f *filesAPI) viewHides(req *filesRequest, p string, dir, listed bool) bool {
	if req.view == nil {
		return false
	}
	rel, err := cleanRelPath(p)
	if err != nil {
		return false // refused by the handler's own check
	}
	slash := filepath.ToSlash(rel)
	if !listed && !req.view.listed(slash, dir) {
		return true
	}
	to, ok := realRel(req.root.Root, rel)
	if !ok {
		return true
	}
	// Vouched for and no symlink on the way (a deleted file included): seen.
	return !(listed && to == slash) && !req.view.listed(to, dir)
}

// realRel is where rel under root (resolved, as rootResolver returns it)
// leads through its symlinks, '/'-separated and relative to root; ok false
// when that is outside root. A path that does not resolve (gone) is itself.
func realRel(root, rel string) (string, bool) {
	abs := filepath.Join(root, rel)
	return realRelOf(root, rel, resolvedPath(abs))
}

// resolvedPath is where abs leads through its symlinks; abs itself when it
// does not resolve (gone).
func resolvedPath(abs string) string {
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	return abs
}

// realRelOf is realRel with rel's resolved form (resolvedPath) known.
func realRelOf(root, rel, real string) (string, bool) {
	if real == filepath.Join(root, rel) {
		return filepath.ToSlash(rel), true
	}
	to, err := filepath.Rel(root, real)
	if err != nil || !filepath.IsLocal(to) {
		return "", false
	}
	return filepath.ToSlash(to), true
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
	return f.deniedPaths(root, abs, resolvedPath(abs), extra...)
}

// deniedPaths is denied with abs's resolved form (resolvedPath) known.
func (f *filesAPI) deniedPaths(root, abs, real string, extra ...string) bool {
	paths := []string{abs}
	if real != abs {
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
// without case where the file system usually ignores it. Elsewhere a mount
// can ignore case too (a Windows drive under WSL, ext4 casefold, vfat): a
// path that only differs in case is under dir when its ancestor of that name
// is the same directory.
func underDir(dir, p string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		rel, err := filepath.Rel(strings.ToLower(dir), strings.ToLower(p))
		return err == nil && filepath.IsLocal(rel)
	}
	if rel, err := filepath.Rel(dir, p); err == nil && filepath.IsLocal(rel) {
		return true
	}
	rel, err := filepath.Rel(strings.ToLower(dir), strings.ToLower(p))
	if err != nil || !filepath.IsLocal(rel) {
		return false
	}
	// The ancestor of p as deep as dir: p with rel's components dropped.
	anc := p
	if rel != "." {
		for range strings.Split(rel, string(filepath.Separator)) {
			anc = filepath.Dir(anc)
		}
	}
	a, errA := os.Stat(anc)
	d, errD := os.Stat(dir)
	return errA == nil && errD == nil && os.SameFile(a, d)
}

// sensitivePath checks the path asked for and, through symlinks, the file it
// leads to: notes.txt -> .env is sensitive.
func sensitivePath(root, rel string) bool {
	abs := filepath.Join(root, rel)
	return isSensitive(abs) || isSensitive(resolvedPath(abs))
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
	Root   string `json:"root"`
	IsRepo bool   `json:"isRepo"`
	// Dir is the pane's directory under Root ("/"-separated), absent at the
	// root itself or outside it: what a relative path the agent wrote in the
	// Chat view starts from.
	Dir       string      `json:"dir,omitempty"`
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
	p := r.URL.Query().Get("path")
	if f.viewHides(req, p, true, false) {
		f.error(w, "files tree", fs.ErrNotExist)
		return
	}
	res, err := f.tree(req.root, p)
	if err != nil {
		f.error(w, "files tree", err)
		return
	}
	if req.view != nil {
		// Listed under where the directory leads: git lists nothing below
		// a symlink.
		base, _ := realRel(req.root.Root, filepath.FromSlash(res.Path))
		res.Entries = slices.DeleteFunc(res.Entries, func(e fileEntry) bool {
			return !req.view.listed(path.Join(base, e.Name), true)
		})
	}
	res.Dir = paneDirRel(req.root)
	// A view-only client learns no directory its list does not hold
	if req.view != nil && res.Dir != "" && !req.view.listed(res.Dir, true) {
		res.Dir = ""
	}
	jsonOK(w, res)
}

// paneDirRel is the pane's directory under root, "/"-separated; "" at the
// root, outside it or when not known. Both are resolved (paneRoot), so a
// symlink on the way does not hide one under the other.
func paneDirRel(root filesRoot) string {
	if root.Dir == "" {
		return ""
	}
	rel, err := filepath.Rel(root.Root, root.Dir)
	if err != nil || rel == "." || !filepath.IsLocal(rel) {
		return ""
	}
	return filepath.ToSlash(rel)
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
	// Hash is the sha256 of the bytes read, sent back as a save's baseHash.
	Hash string `json:"hash"`
	// Encoding is what Text was decoded from, sent back with a save; BOM:
	// the file starts with that encoding's byte order mark.
	Encoding string `json:"encoding"`
	BOM      bool   `json:"bom,omitempty"`
	// Editable: a save of this file would be taken; NotEditable says why not.
	Editable    bool   `json:"editable"`
	NotEditable string `json:"notEditable,omitempty"`
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
	if q.Get("hash") == "1" {
		// It answers for a sensitive file not revealed too, which a client
		// with a shell could read anyway; a view-only client deletes
		// nothing, so has no use for it.
		if !requireWriteRole(w, r) {
			return
		}
		// Hashing reads up to 512 MiB: a slot of the raw route's, so a
		// burst of them never reads several at once.
		select {
		case f.rawSlots <- struct{}{}:
			defer func() { <-f.rawSlots }()
		default:
			f.error(w, "files hash", errRawBusy)
			return
		}
		res, err := f.contentHash(req.root, q.Get("path"))
		if err != nil {
			f.error(w, "files hash", err)
			return
		}
		jsonOK(w, res)
		return
	}
	enc, ok := parseEncoding(q.Get("encoding"))
	if !ok {
		f.error(w, "files content", errBadEncoding)
		return
	}
	if f.viewHides(req, q.Get("path"), false, false) {
		f.error(w, "files content", fs.ErrNotExist)
		return
	}
	res, err := f.content(req.root, q.Get("path"), q.Get("reveal") == "1", enc)
	if err != nil {
		f.error(w, "files content", err)
		return
	}
	jsonOK(w, res)
}

// content reads the file p for the content route, decoded from enc, or
// from the encoding detectEncoding finds when enc is empty.
func (f *filesAPI) content(root filesRoot, p string, reveal bool, enc textEncoding) (any, error) {
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
	fh, err := rt.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, err
	}
	b, size, reason, err := readRawFile(fh)
	fh.Close()
	if err != nil {
		return nil, err
	}
	slash := filepath.ToSlash(rel)
	// Never decoded, nor holding a slot, before it is revealed.
	if sensitivePath(root.Root, rel) && !reveal {
		return sensitiveResponse{Root: root.Root, Path: slash, Sensitive: true}, nil
	}
	if reason != "" {
		return unpreviewableResponse{Root: root.Root, Path: slash, Size: size, Reason: reason}, nil
	}
	// A UTF-8 file is read as it was before encodings: no slot. Anything
	// else is detected or decoded, a few at once.
	if enc != encUTF8 && (enc != "" || !utf8.Valid(b)) {
		select {
		case f.decodeSlots <- struct{}{}:
			defer func() { <-f.decodeSlots }()
		default:
			return nil, errDecodeBusy
		}
	}
	if enc == "" {
		var ok bool
		if enc, ok = detectEncoding(b); !ok {
			return unpreviewableResponse{Root: root.Root, Path: slash, Size: size, Reason: "binary"}, nil
		}
	}
	d := decodeText(b, enc)
	why := f.editCheck(rt, root, rel, d)
	return contentResponse{
		Root: root.Root, Path: slash, Size: size, Text: d.Text,
		Hash: hashHex(b), Encoding: string(d.Enc), BOM: d.BOM,
		Editable: why == "", NotEditable: why,
	}, nil
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
	b, size, reason, err := readTextFile(fh)
	if err != nil || reason != "" {
		return "", size, reason, err
	}
	return string(b), int64(len(b)), "", nil
}

// statPreview checks that the open file fh can be previewed for what it is:
// reason not-regular or too-large when not. size is its size.
func statPreview(fh *os.File) (size int64, reason string, err error) {
	fi, err := fh.Stat()
	if err != nil {
		return 0, "", err
	}
	if !fi.Mode().IsRegular() {
		return 0, "not-regular", nil
	}
	if fi.Size() > maxPreviewSize {
		return fi.Size(), "too-large", nil
	}
	return fi.Size(), "", nil
}

// readRawFile reads the open file fh when it is a regular file of at most
// maxPreviewSize, whatever its bytes are; reason says why not (not-regular,
// too-large). size is its size, or the bytes read once read.
func readRawFile(fh *os.File) (b []byte, size int64, reason string, err error) {
	size, reason, err = statPreview(fh)
	if err != nil || reason != "" {
		return nil, size, reason, err
	}
	b, err = io.ReadAll(io.LimitReader(fh, maxPreviewSize+1))
	if err != nil {
		return nil, size, "", err
	}
	if len(b) > maxPreviewSize {
		return nil, size, "too-large", nil
	}
	return b, int64(len(b)), "", nil
}

// readTextFile reads the open file fh when it is a regular UTF-8 text file
// of at most maxPreviewSize; reason says why not (not-regular, too-large,
// binary) and size is its size then. A NUL byte in the first
// binarySniffSize bytes stops the read there.
func readTextFile(fh *os.File) (b []byte, size int64, reason string, err error) {
	size, reason, err = statPreview(fh)
	if err != nil || reason != "" {
		return nil, size, reason, err
	}
	lr := io.LimitReader(fh, maxPreviewSize+1)
	head := make([]byte, binarySniffSize)
	n, err := io.ReadFull(lr, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return nil, size, "", err
	}
	if bytes.IndexByte(head[:n], 0) >= 0 {
		return head[:n], size, "binary", nil
	}
	rest, err := io.ReadAll(lr)
	if err != nil {
		return nil, size, "", err
	}
	b = append(head[:n], rest...)
	if len(b) > maxPreviewSize {
		return b, size, "too-large", nil
	}
	if !utf8.Valid(b) {
		return b, size, "binary", nil
	}
	return b, size, "", nil
}

// error maps a files error to a response. Client mistakes are returned as
// they are; anything else is logged and answered generically.
func (f *filesAPI) error(w http.ResponseWriter, op string, err error) {
	var rc *rootChangedError
	var ie inputError
	var re *codedError
	var ne *notEditableError
	var ee *createExistsError
	var dc *deleteChangedError
	var mc *renameChangedError
	var dt *documentTooLargeError
	var ue *unencodableError
	switch {
	case errors.As(err, &ue):
		// Where the character is and which it is, from the text the
		// client sent: never the file's own text.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(map[string]any{"error": ue.Error(), "code": "unencodable", "line": ue.line, "char": ue.char})
	case errors.As(err, &ee):
		// The name taken, cleaned, so the client opens what is there.
		jsonCodeBody(w, errCreateExists.status, map[string]string{"error": ee.Error(), "code": errCreateExists.code, "path": ee.path})
	case errors.As(err, &dc):
		// The file was swapped while it was deleted, and what was moved
		// could not go back: the client can still undo it.
		jsonCodeBody(w, errEditChanged.status, map[string]string{"error": errEditChanged.msg, "code": errEditChanged.code, "trashId": dc.trashID})
	case errors.As(err, &mc):
		// The file was swapped while it was renamed, and what was moved
		// could not go back: where it is now, so the client follows it.
		jsonCodeBody(w, errEditChanged.status, map[string]string{"error": errEditChanged.msg, "code": errEditChanged.code, "path": mc.path})
	case errors.As(err, &dt):
		// The size, so the client can say how large the file is.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(errDocumentTooLarge.status)
		json.NewEncoder(w).Encode(map[string]any{"error": dt.Error(), "code": errDocumentTooLarge.code, "size": dt.size})
	case errors.As(err, &re):
		jsonErrorCode(w, re.code, re.msg, re.status)
	case errors.As(err, &ne):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(map[string]string{"error": ne.Error(), "code": "not_editable", "reason": ne.reason})
	case errors.As(err, &rc):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": rc.Error(), "root": rc.root})
	case errors.As(err, &ie):
		jsonError(w, ie.Error(), http.StatusBadRequest)
	case isPathEscape(err):
		jsonError(w, "path outside root", http.StatusBadRequest)
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

// jsonCodeBody writes body as a JSON error response with status.
func jsonCodeBody(w http.ResponseWriter, status int, body map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

// isPathEscape matches os.Root's error for a path (or symlink) that leaves the
// root; the error value is not exported.
func isPathEscape(err error) bool {
	var pe *fs.PathError
	return errors.As(err, &pe) && strings.Contains(pe.Err.Error(), "path escapes from parent")
}
