package main

import (
	"context"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	// maxStatusEntries caps one git status listing.
	maxStatusEntries = 5000
	// maxStatusOutput caps git status output read.
	maxStatusOutput = 8 << 20
	// maxDiffOutput caps one file's diff; the rest is dropped (truncated).
	maxDiffOutput = 1 << 20
)

// errNotChanged: a diff or an apply asked for a path git status does not
// list. Only listed paths reach git, so a client cannot steer it at anything
// else.
var errNotChanged = &codedError{"not_changed", "not changed", http.StatusNotFound}

type changeEntry struct {
	Path string `json:"path"`
	Orig string `json:"orig,omitempty"` // the source of a rename or copy
	// Staged: index against HEAD (M A D R C T); Unstaged: worktree against
	// the index (M D T, or ? untracked). "" means unchanged on that side.
	Staged    string `json:"staged"`
	Unstaged  string `json:"unstaged"`
	Conflict  bool   `json:"conflict,omitempty"`
	Sensitive bool   `json:"sensitive"`
	// The file's mode in HEAD, the index and the worktree (porcelain v2,
	// "100644"); empty for an untracked or conflicted entry.
	modeHead, modeIndex, modeWorktree string
}

type gitStatus struct {
	Branch    string
	Entries   []changeEntry
	Truncated bool
}

type changesResponse struct {
	Root      string        `json:"root"`
	IsRepo    bool          `json:"isRepo"`
	Branch    string        `json:"branch,omitempty"`
	Entries   []changeEntry `json:"entries"`
	Truncated bool          `json:"truncated"`
}

type diffLine struct {
	Kind      string `json:"kind"` // ctx | add | del
	Old       int    `json:"old,omitempty"`
	New       int    `json:"new,omitempty"`
	Text      string `json:"text"`
	NoNewline bool   `json:"noNewline,omitempty"`
}

type diffHunk struct {
	Header string     `json:"header"`
	Lines  []diffLine `json:"lines"`
	// ID names the hunk for files/changes/apply; set only on a hunk that can
	// be applied alone (hunkID).
	ID string `json:"id,omitempty"`
	// raw is the hunk as git printed it, header included.
	raw string
}

type diffResponse struct {
	Root      string     `json:"root"`
	Path      string     `json:"path"`
	Binary    bool       `json:"binary,omitempty"`
	Conflict  bool       `json:"conflict,omitempty"`
	Truncated bool       `json:"truncated"`
	Sensitive bool       `json:"sensitive,omitempty"`
	Reason    string     `json:"reason,omitempty"` // too-large | not-regular, for a file read whole
	Hunks     []diffHunk `json:"hunks"`
	// WorktreeHash is the sha256 of the worktree file an unstaged diff was
	// taken against (hashed before it), the baseHash a discard of the whole
	// file sends.
	WorktreeHash string `json:"worktreeHash,omitempty"`
	// head is every line before the first hunk.
	head []string
}

// parseStatus reads `git status --porcelain=v2 -z --branch` output. A record
// cut by the output limit is dropped.
func parseStatus(out []byte, cut bool) gitStatus {
	var st gitStatus
	st.Truncated = cut
	recs := strings.Split(string(out), "\x00")
	// The last element follows the final NUL: empty, or a cut record.
	recs = recs[:len(recs)-1]
	for i := 0; i < len(recs); i++ {
		r := recs[i]
		if h, ok := strings.CutPrefix(r, "# branch.head "); ok {
			st.Branch = h
			continue
		}
		if len(st.Entries) >= maxStatusEntries {
			st.Truncated = true
			break
		}
		var e changeEntry
		switch {
		case strings.HasPrefix(r, "1 "):
			f := strings.SplitN(r, " ", 9)
			if len(f) != 9 {
				continue
			}
			e = changeEntry{Path: f[8], modeHead: f[3], modeIndex: f[4], modeWorktree: f[5]}
			e.Staged, e.Unstaged = statusXY(f[1])
		case strings.HasPrefix(r, "2 "):
			// The source path is the next NUL-separated record.
			f := strings.SplitN(r, " ", 10)
			if len(f) != 10 || i+1 >= len(recs) {
				continue
			}
			i++
			e = changeEntry{Path: f[9], Orig: recs[i], modeHead: f[3], modeIndex: f[4], modeWorktree: f[5]}
			e.Staged, e.Unstaged = statusXY(f[1])
		case strings.HasPrefix(r, "u "):
			f := strings.SplitN(r, " ", 11)
			if len(f) != 11 {
				continue
			}
			e = changeEntry{Path: f[10], Conflict: true}
		case strings.HasPrefix(r, "? "):
			e = changeEntry{Path: r[2:], Unstaged: "?"}
		default:
			continue // "!" ignored, other headers
		}
		st.Entries = append(st.Entries, e)
	}
	return st
}

// statusXY splits a porcelain XY field; '.' is unchanged.
func statusXY(xy string) (staged, unstaged string) {
	if len(xy) != 2 {
		return "", ""
	}
	side := func(c byte) string {
		if c == '.' {
			return ""
		}
		return string(c)
	}
	return side(xy[0]), side(xy[1])
}

// parseUnifiedDiff turns one file's `git diff` output into hunks with line
// numbers, and the lines before the first one (head). Each hunk is read by
// its header's line counts, so a removed line that reads "--- x" is still a
// line. A line cut by the output limit is dropped.
func parseUnifiedDiff(out []byte) (hunks []diffHunk, head []string, binary bool) {
	lines := strings.Split(string(out), "\n")
	// The element after the final '\n' is empty, or the cut line.
	lines = lines[:len(lines)-1]
	var cur *diffHunk
	var raw strings.Builder
	var oldN, newN, oldLeft, newLeft int
	// end closes the hunk being read: its text as git printed it.
	end := func() {
		if cur != nil {
			cur.raw = raw.String()
		}
		raw.Reset()
	}
	for _, l := range lines {
		if cur != nil && (oldLeft > 0 || newLeft > 0 || strings.HasPrefix(l, `\`)) {
			in := true
			switch {
			case strings.HasPrefix(l, `\`):
				if n := len(cur.Lines); n > 0 {
					cur.Lines[n-1].NoNewline = true
				}
			case strings.HasPrefix(l, "+") && newLeft > 0:
				cur.Lines = append(cur.Lines, diffLine{Kind: "add", New: newN, Text: l[1:]})
				newN++
				newLeft--
			case strings.HasPrefix(l, "-") && oldLeft > 0:
				cur.Lines = append(cur.Lines, diffLine{Kind: "del", Old: oldN, Text: l[1:]})
				oldN++
				oldLeft--
			case (strings.HasPrefix(l, " ") || l == "") && oldLeft > 0 && newLeft > 0:
				text := ""
				if l != "" {
					text = l[1:]
				}
				cur.Lines = append(cur.Lines, diffLine{Kind: "ctx", Old: oldN, New: newN, Text: text})
				oldN++
				newN++
				oldLeft--
				newLeft--
			default:
				in = false
			}
			if in {
				raw.WriteString(l + "\n")
				continue
			}
		}
		if strings.HasPrefix(l, "@@ ") {
			end()
			o, oc, n, nc, ok := parseHunkHeader(l)
			if !ok {
				cur = nil
				continue
			}
			hunks = append(hunks, diffHunk{Header: l, Lines: []diffLine{}})
			cur = &hunks[len(hunks)-1]
			raw.WriteString(l + "\n")
			oldN, newN, oldLeft, newLeft = o, n, oc, nc
			continue
		}
		if len(hunks) == 0 && cur == nil {
			head = append(head, l)
		}
		if strings.HasPrefix(l, "Binary files ") && strings.HasSuffix(l, " differ") {
			binary = true
		}
	}
	end()
	return hunks, head, binary
}

// parseHunkHeader reads "@@ -a[,b] +c[,d] @@".
func parseHunkHeader(h string) (oldStart, oldCount, newStart, newCount int, ok bool) {
	f := strings.Fields(h)
	if len(f) < 4 || f[3] != "@@" || !strings.HasPrefix(f[1], "-") || !strings.HasPrefix(f[2], "+") {
		return 0, 0, 0, 0, false
	}
	rng := func(s string) (int, int, bool) {
		a, b, has := strings.Cut(s, ",")
		start, err := strconv.Atoi(a)
		if err != nil {
			return 0, 0, false
		}
		count := 1
		if has {
			if count, err = strconv.Atoi(b); err != nil {
				return 0, 0, false
			}
		}
		return start, count, true
	}
	oldStart, oldCount, ok1 := rng(f[1][1:])
	newStart, newCount, ok2 := rng(f[2][1:])
	return oldStart, oldCount, newStart, newCount, ok1 && ok2
}

// wholeFileHunk shows a file git has no diff for (untracked, conflicted) as
// one hunk of added lines.
func wholeFileHunk(text string) []diffHunk {
	if text == "" {
		return []diffHunk{}
	}
	noNL := !strings.HasSuffix(text, "\n")
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	h := diffHunk{Header: "@@ -0,0 +1," + strconv.Itoa(len(lines)) + " @@", Lines: make([]diffLine, len(lines))}
	for i, l := range lines {
		h.Lines[i] = diffLine{Kind: "add", New: i + 1, Text: l}
	}
	h.Lines[len(lines)-1].NoNewline = noNL
	return []diffHunk{h}
}

// gitStatusArgs is the status every reader of a root's changes runs.
var gitStatusArgs = []string{"status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all",
	"--ignore-submodules=all", "--find-renames"}

// statusKey names root in f.statuses.
func statusKey(root filesRoot) string { return root.Root + "\x00" + root.SafeDir }

// status runs git status for the root, shared by every client for
// filesRootTTL. A timeout makes the root back off (gitRunner).
func (f *filesAPI) status(ctx context.Context, root filesRoot) (gitStatus, error) {
	ctx = context.WithoutCancel(ctx) // shared by every client of the root
	return f.statuses.do(statusKey(root), func() (gitStatus, error) {
		out, cut, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, noFilters: true, heavy: true, limit: maxStatusOutput},
			gitStatusArgs...)
		if err != nil {
			return gitStatus{}, err
		}
		st := parseStatus(out, cut)
		for i := range st.Entries {
			e := &st.Entries[i]
			// Through symlinks too: an untracked notes.txt -> .env is read
			// whole by the diff route.
			e.Sensitive = sensitivePath(root.Root, filepath.FromSlash(e.Path)) ||
				e.Orig != "" && sensitivePath(root.Root, filepath.FromSlash(e.Orig))
		}
		return st, nil
	})
}

func (f *filesAPI) handleChanges(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	res := changesResponse{Root: req.root.Root, IsRepo: req.root.IsRepo, Entries: []changeEntry{}}
	if req.root.IsRepo {
		st, err := f.status(req.ctx, req.root)
		if err != nil {
			f.error(w, "git status", err)
			return
		}
		res.Branch, res.Truncated = st.Branch, st.Truncated
		res.Entries = append(res.Entries, st.Entries...)
	}
	jsonOK(w, res)
}

func (f *filesAPI) handleDiff(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	q := r.URL.Query()
	// The path is checked against git status by diff; where a symlink in
	// the worktree leads is not.
	if f.viewHides(req, q.Get("path"), false, true) {
		f.error(w, "git diff", fs.ErrNotExist)
		return
	}
	res, err := f.diff(req.ctx, req.root, q.Get("path"), q.Get("orig"), q.Get("staged") == "1", q.Get("reveal") == "1")
	if err != nil {
		f.error(w, "git diff", err)
		return
	}
	jsonOK(w, res)
}

func (f *filesAPI) diff(ctx context.Context, root filesRoot, path, orig string, staged, reveal bool) (diffResponse, error) {
	if !root.IsRepo {
		return diffResponse{}, errNotChanged
	}
	st, err := f.status(ctx, root)
	if err != nil {
		return diffResponse{}, err
	}
	entry := findChange(st, path, orig, staged)
	if entry == nil {
		return diffResponse{}, errNotChanged
	}
	rel, err := cleanRelPath(path)
	if err != nil {
		return diffResponse{}, err
	}
	if f.denied(root.Root, rel, root.GitDir) || orig != "" && f.deniedPath(root.Root, orig, root.GitDir) {
		return diffResponse{}, errPathNotAllowed
	}
	res := diffResponse{Root: root.Root, Path: path, Conflict: entry.Conflict, Hunks: []diffHunk{}}
	// Checked again now: the cached status may predate a symlink change.
	if (entry.Sensitive || sensitivePath(root.Root, rel)) && !reveal {
		res.Sensitive, res.Hunks = true, nil
		return res, nil
	}
	if !staged && (entry.Unstaged == "?" || entry.Conflict) {
		// git has no diff of these: show the file as it is in the worktree,
		// read through os.Root with the content route's checks.
		rt, err := os.OpenRoot(root.Root)
		if err != nil {
			return diffResponse{}, err
		}
		defer rt.Close()
		text, _, reason, err := readPreview(rt, rel)
		if err != nil {
			return diffResponse{}, err
		}
		switch reason {
		case "":
			res.Hunks = wholeFileHunk(text)
		case "binary":
			res.Binary = true
		default:
			res.Reason = reason
		}
		return res, nil
	}
	if !staged {
		// Before the diff: a file written after it is refused by a discard
		// rather than replaced unseen.
		res.WorktreeHash = worktreeHash(root.Root, rel)
	}
	args := []string{"diff"}
	if staged {
		args = append(args, "--cached")
	}
	// The prefixes are fixed: an apply builds its patch from this output,
	// whatever diff.noprefix or diff.mnemonicPrefix the user set.
	args = append(args, "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all",
		"--src-prefix=a/", "--dst-prefix=b/", "-M", "--unified=3", "--")
	// orig only names a rename's source, which only the index side has.
	if staged && orig != "" {
		args = append(args, ":(literal)"+orig)
	}
	args = append(args, ":(literal)"+path)
	out, cut, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, noFilters: true, heavy: true, limit: maxDiffOutput}, args...)
	if err != nil {
		return diffResponse{}, err
	}
	res.Hunks, res.head, res.Binary = parseUnifiedDiff(out)
	if res.Hunks == nil {
		res.Hunks = []diffHunk{}
	}
	res.Truncated = cut
	if !res.Truncated && !res.Binary && hunksApply(entry, staged) && hunkHeadOK(res.head, path) {
		for i := range res.Hunks {
			res.Hunks[i].ID = hunkID(res.Hunks[i].raw)
		}
	}
	return res, nil
}

// hunksApply reports whether the hunks of entry's diff on that side can be
// applied one at a time: a change in place (M), of a regular file whose mode
// stays the same. A rename, a copy, a mode change or a symlink is applied
// whole only.
func hunksApply(e *changeEntry, staged bool) bool {
	letter, from, to := e.Unstaged, e.modeIndex, e.modeWorktree
	if staged {
		letter, from, to = e.Staged, e.modeHead, e.modeIndex
	}
	regular := from == "100644" || from == "100755"
	return letter == "M" && e.Orig == "" && !e.Conflict && regular && from == to
}

// worktreeHash is the sha256 of the regular file rel under root, read
// through os.Root; "" for one that is missing, not regular or larger than
// maxPreviewSize (no discard of the whole file takes it), or when the root
// cannot be opened (the diff then fails).
func worktreeHash(root, rel string) string {
	rt, err := os.OpenRoot(root)
	if err != nil {
		return ""
	}
	defer rt.Close()
	fh, err := rt.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return ""
	}
	defer fh.Close()
	if fi, err := fh.Stat(); err != nil || !fi.Mode().IsRegular() || fi.Size() > maxPreviewSize {
		return ""
	}
	// A read cut short hashes to what no discard matches: it is refused.
	b, _ := io.ReadAll(io.LimitReader(fh, maxPreviewSize))
	return hashHex(b)
}

// findChange returns the status entry for path (and orig) when it is listed
// on the side asked for, else nil. Only listed paths reach git, so a client
// cannot steer it at anything else.
func findChange(st gitStatus, path, orig string, staged bool) *changeEntry {
	for i := range st.Entries {
		e := &st.Entries[i]
		side := e.Unstaged != "" || e.Conflict
		if staged {
			side = e.Staged != ""
		}
		if e.Path == path && e.Orig == orig && side {
			return e
		}
	}
	return nil
}

// deniedPath is denied for a git path ("/"-separated, relative to the root).
func (f *filesAPI) deniedPath(root, p string, extra ...string) bool {
	rel, err := cleanRelPath(p)
	return err != nil || f.denied(root, rel, extra...)
}
