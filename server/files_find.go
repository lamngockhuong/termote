package main

import (
	"context"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	// findMaxResults caps the paths one find answers; more sets truncated.
	findMaxResults = 200
	// findMaxQuery caps the query, in bytes.
	findMaxQuery = 256
	// findMaxExcludes caps the excluded names one find takes.
	findMaxExcludes = 50
	// findListTTL caches the file list of a root: a query is matched
	// against it at every key typed.
	findListTTL = 30 * time.Second
)

var (
	// findMaxPaths caps the paths one list reads (git output or a walk),
	// findMaxDepth the directories deep a walk goes and findWalkTimeout
	// how long a walk runs. Past any of them the list is incomplete.
	// Variables, so tests can lower them.
	findMaxPaths    = 200_000
	findMaxDepth    = createMaxParts
	findWalkTimeout = 5 * time.Second
	// findListOutput caps what one git ls-files may write; a cut list is
	// incomplete.
	findListOutput int64 = 16 << 20

	errFindQueryRequired  = inputError("q is required")
	errFindQueryTooLong   = inputError("q is too long")
	errFindInvalidExclude = &rawError{"invalid_exclude", "invalid excluded name", http.StatusBadRequest}
)

// findBeforeReadDir runs before a walk reads a directory ('/'-separated,
// relative to the root); only tests set it, to prove a directory is never
// read.
var findBeforeReadDir = func(dir string) {}

// findBeforeBuild runs when a file list is built instead of taken from the
// cache; only tests set it.
var findBeforeBuild = func(key string) {}

// findEntry is one path of a file list.
type findEntry struct {
	rel     string // '/'-separated, relative to the root
	lower   string // rel in lower case, what a query is matched against
	ignored bool   // from the ignored list of a repo
}

func newFindEntry(rel string, ignored bool) findEntry {
	return findEntry{rel: rel, lower: strings.ToLower(rel), ignored: ignored}
}

// findList is the files of a root a query is matched against.
type findList struct {
	entries []findEntry
	// incomplete: reading stopped early (a limit, or git's output cut), so
	// some files are missing.
	incomplete bool
}

type findResult struct {
	Path      string `json:"path"`
	Ignored   bool   `json:"ignored"`
	Sensitive bool   `json:"sensitive"`
}

type findResponse struct {
	Root       string       `json:"root"`
	IsRepo     bool         `json:"isRepo"`
	Results    []findResult `json:"results"`
	Truncated  bool         `json:"truncated"`
	Incomplete bool         `json:"incomplete"`
}

// findQuery is a parsed GET files/find.
type findQuery struct {
	q        string
	ignored  bool
	fresh    bool
	excludes findExcludes
	// excludeKey names the excluded set in a cache key.
	excludeKey string
}

// findExcludes are directory names a walk never enters, compared as the
// file system usually compares names.
type findExcludes map[string]bool

func (x findExcludes) has(name string) bool { return x[foldName(name)] }

// foldName is name as compared on this OS: without case where the file
// system usually ignores it (as underDir).
func foldName(name string) string {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.ToLower(name)
	}
	return name
}

func parseFindQuery(v url.Values) (findQuery, error) {
	q := strings.TrimSpace(v.Get("q"))
	if q == "" {
		return findQuery{}, errFindQueryRequired
	}
	if len(q) > findMaxQuery {
		return findQuery{}, errFindQueryTooLong
	}
	names := v["exclude"]
	if len(names) > findMaxExcludes {
		return findQuery{}, errFindInvalidExclude
	}
	ex := findExcludes{}
	for _, n := range names {
		if !validFindExclude(n) {
			return findQuery{}, errFindInvalidExclude
		}
		ex[foldName(n)] = true
	}
	keys := make([]string, 0, len(ex))
	for k := range ex {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return findQuery{
		q: q, ignored: v.Get("ignored") == "1", fresh: v.Get("fresh") == "1",
		excludes: ex, excludeKey: strings.Join(keys, "\x00"),
	}, nil
}

// validFindExclude: one directory name, never a path or a pattern.
func validFindExclude(n string) bool {
	return n != "" && len(n) <= createMaxName && n != "." && n != ".." &&
		!strings.ContainsAny(n, "/\\\x00*?[")
}

// findFilter drops, by name alone, the paths a list never holds: a .git
// component, or a path under a deny dir or the repo's git dir. It is cheap
// enough for every path of a list; the results also pass f.denied, which
// follows symlinks.
type findFilter struct {
	all      bool     // the root itself is denied
	prefixes []string // denied dirs under the root, '/'-separated, folded
}

func (f *filesAPI) newFindFilter(root filesRoot) findFilter {
	var ff findFilter
	for _, d := range append(append([]string{}, f.deny...), root.GitDir) {
		if d == "" {
			continue
		}
		if underDir(d, root.Root) {
			return findFilter{all: true}
		}
		if rel, err := filepath.Rel(root.Root, d); err == nil && filepath.IsLocal(rel) {
			ff.prefixes = append(ff.prefixes, foldName(filepath.ToSlash(rel)))
		}
	}
	return ff
}

func (ff findFilter) skip(rel string) bool {
	if ff.all {
		return true
	}
	for _, part := range strings.Split(rel, "/") {
		if isGitDirName(part) {
			return true
		}
	}
	r := foldName(rel)
	for _, p := range ff.prefixes {
		if r == p || strings.HasPrefix(r, p+"/") {
			return true
		}
	}
	return false
}

// findBudget bounds one list: the paths read and a deadline.
type findBudget struct {
	left     int
	deadline time.Time
	stopped  bool
}

func newFindBudget() *findBudget {
	return &findBudget{left: findMaxPaths, deadline: time.Now().Add(findWalkTimeout)}
}

// take counts one path read; false once the budget is spent.
func (b *findBudget) take() bool {
	if !b.stopped && (b.left <= 0 || !time.Now().Before(b.deadline)) {
		b.stopped = true
	}
	if b.stopped {
		return false
	}
	b.left--
	return true
}

// findWalk lists files under directories of a root.
type findWalk struct {
	rt      *os.Root
	ex      findExcludes
	ff      findFilter
	b       *findBudget
	ignored bool
	out     []findEntry
}

// walk adds the files under dir ('/'-separated, "." for the root, depth
// components deep). An excluded name, a symlink to a directory and a
// junction (irregular) are never entered; a symlink to a file inside the
// root is listed, as the tree shows it.
func (w *findWalk) walk(dir string, depth int) {
	if depth >= findMaxDepth {
		w.b.stopped = true
		return
	}
	findBeforeReadDir(dir)
	d, err := w.rt.Open(filepath.FromSlash(dir))
	if err != nil {
		return
	}
	defer d.Close()
	for {
		ents, err := d.ReadDir(256)
		for _, e := range ents {
			if !w.b.take() {
				return
			}
			name := e.Name()
			rel := name
			if dir != "." {
				rel = dir + "/" + name
			}
			if w.ff.skip(rel) {
				continue
			}
			switch t := e.Type(); {
			case t.IsDir():
				if !w.ex.has(name) {
					w.walk(rel, depth+1)
				}
			case t.IsRegular():
				w.out = append(w.out, newFindEntry(rel, w.ignored))
			case t&fs.ModeSymlink != 0:
				if fi, err := w.rt.Stat(filepath.FromSlash(rel)); err == nil && fi.Mode().IsRegular() {
					w.out = append(w.out, newFindEntry(rel, w.ignored))
				}
			}
			if w.b.stopped {
				return
			}
		}
		if err != nil {
			return // io.EOF, or a directory that went away
		}
	}
}

// splitNul splits git -z output. The last element follows the final NUL:
// empty, or a path cut by the output limit, so it is always dropped.
func splitNul(out []byte) []string {
	parts := strings.Split(string(out), "\x00")
	return parts[:len(parts)-1]
}

// findCall is how find runs git: a slot of the semaphore like status, but a
// timeout does not back the root off, so a huge untracked tree never makes
// the Changes view fail too.
func findCall(root filesRoot) gitCall {
	return gitCall{root: root.Root, safeDir: root.SafeDir, heavy: true, noBackoff: true, limit: findListOutput}
}

// findTracked lists the tracked and untracked (not ignored) files of a
// repo. Directories git lists (an untracked nested repo, a submodule) and
// tracked files gone from the disk are left out. Excluded names do not
// apply: a committed vendor/ is always searched.
func (f *filesAPI) findTracked(ctx context.Context, root filesRoot) (findList, error) {
	out, cut, err := f.git.output(ctx, findCall(root), "ls-files", "-co", "--exclude-standard", "--deduplicate", "-z")
	if err != nil {
		return findList{}, err
	}
	gone, _, err := f.git.output(ctx, findCall(root), "ls-files", "-d", "-z")
	if err != nil {
		return findList{}, err
	}
	deleted := map[string]bool{}
	for _, p := range splitNul(gone) {
		deleted[p] = true
	}
	ff := f.newFindFilter(root)
	l := findList{incomplete: cut}
	for _, p := range splitNul(out) {
		if p == "" || strings.HasSuffix(p, "/") || deleted[p] || ff.skip(p) {
			continue
		}
		if len(l.entries) >= findMaxPaths {
			l.incomplete = true
			break
		}
		l.entries = append(l.entries, newFindEntry(p, false))
	}
	return l, nil
}

// findIgnored lists the ignored files of a repo. git names a directory
// that is ignored whole once (with a trailing '/'); it is walked, never
// entering an excluded name at any depth. A path with an excluded
// component is dropped without being read.
func (f *filesAPI) findIgnored(ctx context.Context, root filesRoot, ex findExcludes) (findList, error) {
	out, cut, err := f.git.output(ctx, findCall(root), "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z")
	if err != nil {
		return findList{}, err
	}
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return findList{}, err
	}
	defer rt.Close()
	w := &findWalk{rt: rt, ex: ex, ff: f.newFindFilter(root), b: newFindBudget(), ignored: true}
	for _, p := range splitNul(out) {
		p, isDir := strings.CutSuffix(p, "/")
		if p == "" || w.ff.skip(p) || hasExcludedPart(p, ex) {
			continue
		}
		if isDir {
			w.walk(p, strings.Count(p, "/")+1)
		} else if w.b.take() {
			w.out = append(w.out, newFindEntry(p, true))
		}
		if w.b.stopped {
			break
		}
	}
	return findList{entries: w.out, incomplete: cut || w.b.stopped}, nil
}

func hasExcludedPart(rel string, ex findExcludes) bool {
	for _, part := range strings.Split(rel, "/") {
		if ex.has(part) {
			return true
		}
	}
	return false
}

// findWalkRoot lists the files of a root that is not a repo.
func (f *filesAPI) findWalkRoot(root filesRoot, ex findExcludes) (findList, error) {
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return findList{}, err
	}
	defer rt.Close()
	w := &findWalk{rt: rt, ex: ex, ff: f.newFindFilter(root), b: newFindBudget()}
	w.walk(".", 0)
	return findList{entries: w.out, incomplete: w.b.stopped}, nil
}

// findLists returns the lists a query of root is matched against, from the
// cache when fresh enough. Building one is shared by every request waiting
// on it, so it never stops because the first of them left (the PWA cancels
// the previous request at each key).
func (f *filesAPI) findLists(ctx context.Context, root filesRoot, in findQuery) ([]findList, error) {
	ctx = context.WithoutCancel(ctx)
	prefix := root.Root + "\x00" + root.SafeDir + "\x00"
	cached := func(key string, build func() (findList, error)) (findList, error) {
		l, err := f.finds.do(prefix+key, func() (findList, error) {
			findBeforeBuild(key)
			return build()
		})
		if err != nil {
			// A failure (git timed out) is not kept: the next key tries again
			f.finds.forgetPrefix(prefix + key)
		}
		return l, err
	}
	if !root.IsRepo {
		l, err := cached("walk\x00"+in.excludeKey, func() (findList, error) { return f.findWalkRoot(root, in.excludes) })
		return []findList{l}, err
	}
	tracked, err := cached("tracked", func() (findList, error) { return f.findTracked(ctx, root) })
	if err != nil || !in.ignored {
		return []findList{tracked}, err
	}
	ignored, err := cached("ignored\x00"+in.excludeKey, func() (findList, error) { return f.findIgnored(ctx, root, in.excludes) })
	return []findList{tracked, ignored}, err
}

// forgetRoot drops what is cached of root's files (git status, file
// lists), so the next read sees a save, a create or a delete.
func (f *filesAPI) forgetRoot(root string) {
	f.statuses.forgetPrefix(root + "\x00")
	f.finds.forgetPrefix(root + "\x00")
}

// handleFind serves GET files/find: the paths under the pane's root that
// match a query by name, best first. Only names are sent, as the tree does.
func (f *filesAPI) handleFind(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	in, err := parseFindQuery(r.URL.Query())
	if err != nil {
		f.error(w, "files find", err)
		return
	}
	if in.fresh {
		f.finds.forgetPrefix(req.root.Root + "\x00")
	}
	var res findResponse
	lists, err := f.findLists(req.ctx, req.root, in)
	if err == nil {
		res, err = f.findResults(req.root, in.q, lists)
	}
	if err != nil {
		f.error(w, "files find", err)
		return
	}
	jsonOK(w, res)
}

// findResults ranks the lists against q and keeps the best findMaxResults
// paths that are served (f.denied, through symlinks) and still files on the
// disk, so truncated is only set when one more would have been sent.
func (f *filesAPI) findResults(root filesRoot, q string, lists []findList) (findResponse, error) {
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return findResponse{}, err
	}
	defer rt.Close()
	res := findResponse{Root: root.Root, IsRepo: root.IsRepo, Results: []findResult{}}
	entries := make([][]findEntry, len(lists))
	for i, l := range lists {
		entries[i] = l.entries
		res.Incomplete = res.Incomplete || l.incomplete
	}
	for _, e := range rankFind(q, entries...) {
		rel := filepath.FromSlash(e.rel)
		if f.denied(root.Root, rel, root.GitDir) {
			continue
		}
		if fi, err := rt.Lstat(rel); err != nil || fi.IsDir() {
			continue
		}
		if len(res.Results) == findMaxResults {
			res.Truncated = true
			break
		}
		res.Results = append(res.Results, findResult{Path: e.rel, Ignored: e.ignored, Sensitive: sensitivePath(root.Root, rel)})
	}
	return res, nil
}
