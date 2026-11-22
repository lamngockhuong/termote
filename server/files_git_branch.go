package main

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
)

// GET files/branch?base= lists what the pane's branch changed since it left
// base: the files between the merge base of base and HEAD and HEAD, and how
// many commits HEAD has past it. GET files/branch/diff?base=&path=&orig= is
// one of those files' diff. Both only read. base is a branch name (checked
// as a worktree branch is, then resolved to a commit with --end-of-options),
// by default the branch the repo's main worktree has checked out; a path is
// only ever one of the list, so a client cannot steer git at anything else.

var (
	errInvalidBase  = &codedError{"invalid_base", "the base is not a valid branch name", http.StatusBadRequest}
	errBaseNotFound = &codedError{"base_not_found", "the base names no commit", http.StatusNotFound}
	errBaseRequired = &codedError{"base_required", "name a base: the main worktree has no branch other than this one checked out", http.StatusConflict}
	errNoMergeBase  = &codedError{"no_merge_base", "the branch shares no history with the base", http.StatusConflict}
)

type branchResponse struct {
	Root      string       `json:"root"`
	IsRepo    bool         `json:"isRepo"`
	Branch    string       `json:"branch,omitempty"`
	Base      string       `json:"base,omitempty"`
	MergeBase string       `json:"mergeBase,omitempty"` // abbreviated
	Commits   int          `json:"commits"`
	Files     []commitFile `json:"files"`
	Truncated bool         `json:"truncated"`
}

// branchRange is HEAD and where it left base, as full hashes.
type branchRange struct {
	base, branch, mergeBase, head string
}

// branchRange resolves base (the main worktree's branch when empty) and
// the range from where HEAD left it. head is "" on an unborn HEAD.
func (f *filesAPI) branchRange(ctx context.Context, root filesRoot, base string) (branchRange, error) {
	c := gitCall{root: root.Root, safeDir: root.SafeDir}
	var br branchRange
	if out, _, err := f.git.output(ctx, c, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		br.branch = strings.TrimSpace(string(out))
	}
	if base == "" {
		main, err := f.mainBranch(ctx, root)
		if err != nil {
			return br, err
		}
		if main == "" || main == br.branch {
			return br, errBaseRequired
		}
		base = main
	}
	if !validBranchName(base) {
		return br, errInvalidBase
	}
	br.base = base
	head, err := f.revCommit(ctx, c, "HEAD")
	if err != nil || head == "" {
		return br, err
	}
	br.head = head
	from, err := f.revCommit(ctx, c, base)
	if err != nil {
		return br, err
	}
	if from == "" {
		return br, errBaseNotFound
	}
	out, _, err := f.git.output(ctx, c, "merge-base", from, head)
	var ge *gitError
	if errors.As(err, &ge) && len(bytes.TrimSpace(out)) == 0 {
		return br, errNoMergeBase
	}
	if err != nil {
		return br, err
	}
	br.mergeBase = strings.TrimSpace(string(out))
	if !commitHashRe.MatchString(br.mergeBase) {
		return br, errors.New("git merge-base: unexpected output")
	}
	return br, nil
}

// revCommit is the commit rev names, "" when it names none.
func (f *filesAPI) revCommit(ctx context.Context, c gitCall, rev string) (string, error) {
	out, _, err := f.git.output(ctx, c, "rev-parse", "--verify", "--quiet", "--end-of-options", rev+"^{commit}")
	var ge *gitError
	if errors.As(err, &ge) && len(bytes.TrimSpace(out)) == 0 {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	hash := strings.TrimSpace(string(out))
	if !commitHashRe.MatchString(hash) {
		return "", errors.New("git rev-parse: unexpected output")
	}
	return hash, nil
}

// mainBranch is the branch the repo's main worktree (the first one git
// lists) has checked out, "" when it is detached.
func (f *filesAPI) mainBranch(ctx context.Context, root filesRoot) (string, error) {
	out, _, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, limit: maxStatusOutput}, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return "", err
	}
	for _, field := range strings.Split(string(out), "\x00") {
		if field == "" {
			break // the end of the first worktree's record
		}
		if ref, ok := strings.CutPrefix(field, "branch refs/heads/"); ok {
			return ref, nil
		}
	}
	return "", nil
}

// branchFiles lists the files changed from br's merge base to HEAD.
func (f *filesAPI) branchFiles(ctx context.Context, root filesRoot, br branchRange) ([]commitFile, bool, error) {
	out, cut, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, noFilters: true, heavy: true, limit: maxStatusOutput},
		"diff", "-z", "--name-status", "-M", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", br.mergeBase, br.head, "--")
	if err != nil {
		return nil, false, err
	}
	files, truncated := parseNameStatus(out, cut)
	for i := range files {
		files[i].Sensitive = commitFileSensitive(root.Root, &files[i])
	}
	return files, truncated, nil
}

func (f *filesAPI) handleBranch(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	res := branchResponse{Root: req.root.Root, IsRepo: req.root.IsRepo, Files: []commitFile{}}
	if req.root.IsRepo {
		br, err := f.branchRange(req.ctx, req.root, r.URL.Query().Get("base"))
		if err != nil {
			f.error(w, "git branch", err)
			return
		}
		res.Branch, res.Base = br.branch, br.base
		if br.head != "" {
			res.MergeBase = br.mergeBase[:12]
			out, _, err := f.git.output(req.ctx, gitCall{root: req.root.Root, safeDir: req.root.SafeDir}, "rev-list", "--count", br.mergeBase+".."+br.head)
			if err != nil {
				f.error(w, "git branch", err)
				return
			}
			res.Commits, _ = strconv.Atoi(strings.TrimSpace(string(out)))
			if res.Files, res.Truncated, err = f.branchFiles(req.ctx, req.root, br); err != nil {
				f.error(w, "git branch", err)
				return
			}
		}
		// A view-only client sees the files it could open, as in Changes.
		if req.view != nil {
			res.Files = deleteHidden(res.Files, func(e commitFile) bool { return f.viewHides(req, e.Path, false, false) })
		}
	}
	jsonOK(w, res)
}

func deleteHidden(files []commitFile, hide func(commitFile) bool) []commitFile {
	out := files[:0]
	for _, e := range files {
		if !hide(e) {
			out = append(out, e)
		}
	}
	return out
}

func (f *filesAPI) handleBranchDiff(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	q := r.URL.Query()
	if f.viewHides(req, q.Get("path"), false, false) {
		f.error(w, "git branch diff", fs.ErrNotExist)
		return
	}
	// A view-only client never reveals a sensitive file's contents.
	reveal := q.Get("reveal") == "1" && req.view == nil
	res, err := f.branchDiff(req.ctx, req.root, q.Get("base"), q.Get("path"), q.Get("orig"), reveal, req.view != nil)
	if err != nil {
		f.error(w, "git branch diff", err)
		return
	}
	jsonOK(w, res)
}

// branchDiff is the diff of one file of the branch since it left base.
// headOnly (a view-only client): never a file the branch deleted or a
// rename's source, as if missing.
func (f *filesAPI) branchDiff(ctx context.Context, root filesRoot, base, path, orig string, reveal, headOnly bool) (diffResponse, error) {
	if !root.IsRepo {
		return diffResponse{}, errNotChanged
	}
	br, err := f.branchRange(ctx, root, base)
	if err != nil {
		return diffResponse{}, err
	}
	if br.head == "" {
		return diffResponse{}, errNotChanged
	}
	files, _, err := f.branchFiles(ctx, root, br)
	if err != nil {
		return diffResponse{}, err
	}
	var entry *commitFile
	for i := range files {
		if e := &files[i]; e.Path == path && e.Orig == orig {
			entry = e
		}
	}
	if entry == nil {
		return diffResponse{}, errNotChanged
	}
	if headOnly && (entry.Status == "D" || entry.Status == "R") {
		return diffResponse{}, fs.ErrNotExist
	}
	if f.deniedPath(root.Root, path, root.GitDir) || orig != "" && f.deniedPath(root.Root, orig, root.GitDir) {
		return diffResponse{}, errPathNotAllowed
	}
	res := diffResponse{Root: root.Root, Path: path, Hunks: []diffHunk{}}
	if (entry.Sensitive || commitFileSensitive(root.Root, entry)) && !reveal {
		res.Sensitive, res.Hunks = true, nil
		return res, nil
	}
	args := []string{"diff", "-M", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all",
		"--src-prefix=a/", "--dst-prefix=b/", "--unified=3", br.mergeBase, br.head, "--"}
	if orig != "" {
		args = append(args, ":(literal)"+orig)
	}
	args = append(args, ":(literal)"+path)
	out, cut, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, noFilters: true, heavy: true, limit: maxDiffOutput}, args...)
	if err != nil {
		return diffResponse{}, err
	}
	res.Hunks, _, res.Binary = parseUnifiedDiff(out)
	if res.Hunks == nil {
		res.Hunks = []diffHunk{}
	}
	res.Truncated = cut
	return res, nil
}
