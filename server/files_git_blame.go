package main

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// maxBlameOutput caps `git blame --incremental` output: a header per run of
// lines and the metadata of each commit once, never the line text. A var:
// tests lower it.
var maxBlameOutput int64 = 8 << 20

// maxBlameSummary caps a commit summary, in bytes, cut at a rune.
const maxBlameSummary = 512

var (
	errBlameNotRepo    = &codedError{"not_repo", "the file is not in a git repository", http.StatusNotFound}
	errBlameNotTracked = &codedError{"not_tracked", "the file is not in the last commit", http.StatusNotFound}
	errBlameTooLarge   = &codedError{"too_large", "file is larger than 1 MiB", http.StatusRequestEntityTooLarge}
	errBlameChanged    = &codedError{"file_changed", "the file changed since it was read", http.StatusConflict}
	errBlameBusy       = &codedError{"busy", "git is busy; try again", http.StatusServiceUnavailable}
	errBlameNoHash     = inputError("hash is required")
)

type blameCommit struct {
	Author  string `json:"author"`
	Time    int64  `json:"time"` // author date, Unix seconds
	Summary string `json:"summary"`
}

type blameRange struct {
	Start  int    `json:"start"` // 1-based line
	Count  int    `json:"count"`
	Commit string `json:"commit,omitempty"` // absent in uncommitted
}

type blameResponse struct {
	Root        string                 `json:"root"`
	Path        string                 `json:"path"`
	Lines       int                    `json:"lines"`
	Commits     map[string]blameCommit `json:"commits"`
	Ranges      []blameRange           `json:"ranges"`
	Uncommitted []blameRange           `json:"uncommitted"`
}

func (f *filesAPI) handleBlame(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	q := r.URL.Query()
	if f.viewHides(req, q.Get("path"), false, false) {
		f.error(w, "git blame", fs.ErrNotExist)
		return
	}
	res, err := f.blame(req.ctx, req.root, q.Get("path"), q.Get("hash"), q.Get("reveal") == "1", req.view == nil)
	if err != nil {
		f.error(w, "git blame", err)
		return
	}
	jsonOKGzip(w, r, res)
}

// blame tells which commit reachable from HEAD last changed each line of the
// file p, for the bytes the client shows: they are read here through os.Root
// and blamed only when their sha256 is hash. git gets them on stdin, so it
// never opens the path itself, and p names only the history to follow.
// linked: as content's.
func (f *filesAPI) blame(ctx context.Context, root filesRoot, p, hash string, reveal, linked bool) (any, error) {
	if !root.IsRepo {
		return nil, errBlameNotRepo
	}
	if hash == "" {
		return nil, errBlameNoHash
	}
	rel, err := cleanRelPath(p)
	if err != nil {
		return nil, err
	}
	if rel == "" || f.denied(root.Root, rel, root.GitDir) {
		return nil, errPathNotAllowed
	}
	at, err := f.rootFor(ctx, root, rel, linked)
	if err != nil {
		return nil, err
	}
	defer at.rt.Close()
	fh, err := at.rt.OpenFile(at.rel, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return nil, err
	}
	b, _, reason, err := readRawFile(fh, maxPreviewSize)
	fh.Close()
	if reason == "too-large" {
		return nil, errBlameTooLarge
	}
	if err != nil || reason != "" {
		return nil, cmp.Or(err, fs.ErrNotExist)
	}
	slash := filepath.ToSlash(rel)
	if sensitivePath(root.Root, rel) && !reveal {
		return sensitiveResponse{Root: root.Root, Path: slash, Sensitive: true}, nil
	}
	if hashHex(b) != hash {
		return nil, errBlameChanged
	}
	// git follows the history of the file the bytes came from: the target of
	// a symlink inside the root, or the file in the other work tree.
	c := gitCall{root: root.Root, safeDir: root.SafeDir}
	gitRel := blameRelPath(root.Root, rel)
	if at.via.root != "" {
		c.root, gitRel = at.via.root, filepath.ToSlash(at.via.rel)
		if root.SafeDir != "" {
			c.safeDir = at.via.root
		}
	}
	// Its cost is one file's history: it never takes the last free slot nor
	// waits for one (status and diff of the root come first), and a slow one
	// never backs the root off.
	run := c
	run.heavy, run.tryOnly, run.noBackoff, run.noFilters, run.stdin, run.limit = true, true, true, true, b, maxBlameOutput
	out, cut, err := f.git.output(ctx, run, "blame", "--incremental", "--no-ignore-revs-file",
		"--no-textconv", "--contents", "-", "--", gitRel)
	if errors.Is(err, errGitBusy) {
		return nil, errBlameBusy
	}
	var ge *gitError
	if errors.As(err, &ge) {
		// Killed because the request ran out of time: not a reason to say
		// the file is not committed
		if ctx.Err() != nil {
			return nil, errGitTimeout
		}
		if !f.inHead(ctx, c, gitRel) {
			return nil, errBlameNotTracked
		}
	}
	if err != nil {
		return nil, err
	}
	if cut {
		return nil, errBlameTooLarge
	}
	res, err := parseBlame(out, countLines(b))
	if err != nil {
		return nil, err
	}
	res.Root, res.Path = root.Root, slash
	return res, nil
}

// blameRelPath is rel as git names it: where a symlink inside root leads.
// rel itself when it does not resolve inside root (it changed since it was
// read): git then follows the history of that name, or finds none.
func blameRelPath(root, rel string) string {
	real, err := filepath.EvalSymlinks(filepath.Join(root, rel))
	if err != nil {
		return filepath.ToSlash(rel)
	}
	if to, ok := realRelOf(root, rel, real); ok {
		return to
	}
	return filepath.ToSlash(rel)
}

// inHead reports whether HEAD's tree holds rel (a path under c.root): what
// tells a file git never committed from a blame failing for another reason.
func (f *filesAPI) inHead(ctx context.Context, c gitCall, rel string) bool {
	_, _, err := f.git.output(ctx, c, "cat-file", "-e", "HEAD:./"+rel)
	return err == nil
}

// countLines counts lines as git does: each "\n" ends one, and text after
// the last one is one more.
func countLines(b []byte) int {
	n := bytes.Count(b, []byte{'\n'})
	if len(b) > 0 && b[len(b)-1] != '\n' {
		n++
	}
	return n
}

// parseBlame reads `git blame --incremental`: per run of lines a header
// "<hash> <orig line> <final line> <count>", the commit's metadata the first
// time it appears, then "filename <path>". Every one of lines lines must be
// blamed exactly once. The all-zero hash (not committed) goes to
// Uncommitted, never Commits; adjacent runs of one commit are merged.
func parseBlame(out []byte, lines int) (*blameResponse, error) {
	bad := errors.New("git blame: unexpected output")
	by := make([]string, lines+1)
	commits := map[string]blameCommit{}
	var cur string
	inHeader := false
	for _, line := range strings.Split(string(out), "\n") {
		if !inHeader {
			if line == "" {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) != 4 || !commitHashRe.MatchString(fields[0]) {
				return nil, bad
			}
			final, err1 := strconv.Atoi(fields[2])
			count, err2 := strconv.Atoi(fields[3])
			if err1 != nil || err2 != nil || final < 1 || count < 1 || final > lines || count > lines-final+1 {
				return nil, bad
			}
			cur = fields[0]
			if strings.Trim(cur, "0") == "" {
				cur = "0"
			} else if _, seen := commits[cur]; !seen {
				commits[cur] = blameCommit{}
			}
			for i := final; i < final+count; i++ {
				if by[i] != "" {
					return nil, bad
				}
				by[i] = cur
			}
			inHeader = true
			continue
		}
		key, val, _ := strings.Cut(line, " ")
		if key == "filename" {
			inHeader = false
			continue
		}
		if cur == "0" {
			continue
		}
		c := commits[cur]
		switch key {
		case "author":
			c.Author = val
		case "author-time":
			c.Time, _ = strconv.ParseInt(val, 10, 64)
		case "summary":
			c.Summary = truncateRunes(val, maxBlameSummary)
		}
		commits[cur] = c
	}
	if inHeader {
		return nil, bad
	}
	res := &blameResponse{Lines: lines, Commits: commits, Ranges: []blameRange{}, Uncommitted: []blameRange{}}
	for i := 1; i <= lines; {
		h := by[i]
		if h == "" {
			return nil, bad
		}
		j := i
		for j <= lines && by[j] == h {
			j++
		}
		if h == "0" {
			res.Uncommitted = append(res.Uncommitted, blameRange{Start: i, Count: j - i})
		} else {
			res.Ranges = append(res.Ranges, blameRange{Start: i, Count: j - i, Commit: h})
		}
		i = j
	}
	return res, nil
}

// truncateRunes cuts s to at most n bytes without splitting a UTF-8 rune.
func truncateRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}
