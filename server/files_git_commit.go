package main

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// maxCommitMessage caps the metadata of one commit read (the message is
	// the part that grows).
	maxCommitMessage = 64 << 10
	// commitFilesTTL keeps the files of a commit: a hash never changes what
	// it names, so opening each file of a large commit lists it once.
	commitFilesTTL = 30 * time.Second
)

// errHeadMoved: a commit diff asked for a commit that is no longer HEAD. The
// client reads the commit again.
var errHeadMoved = &codedError{"head_moved", "HEAD moved", http.StatusConflict}

var commitHashRe = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

type commitFile struct {
	Path      string `json:"path"`
	Orig      string `json:"orig,omitempty"` // the source of a rename or copy
	Status    string `json:"status"`         // M A D R C T
	Sensitive bool   `json:"sensitive"`
}

type commitInfo struct {
	Hash      string       `json:"hash"`
	Parents   []string     `json:"parents"`
	Author    string       `json:"author"`
	Time      int64        `json:"time"` // author date, Unix seconds
	Message   string       `json:"message"`
	Files     []commitFile `json:"files"`
	Truncated bool         `json:"truncated"`
}

type commitList struct {
	files     []commitFile
	truncated bool
}

type commitResponse struct {
	Root   string      `json:"root"`
	IsRepo bool        `json:"isRepo"`
	Commit *commitInfo `json:"commit,omitempty"` // absent before the first commit
}

// headCommit reads HEAD's hash, parents, author and message; nil before the
// first commit. Only HEAD: no client rev reaches git.
func (f *filesAPI) headCommit(ctx context.Context, root filesRoot) (*commitInfo, error) {
	c := gitCall{root: root.Root, safeDir: root.SafeDir}
	out, _, err := f.git.output(ctx, c, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	var ge *gitError
	if errors.As(err, &ge) && len(bytes.TrimSpace(out)) == 0 {
		return nil, nil // unborn HEAD
	}
	if err != nil {
		return nil, err
	}
	hash := strings.TrimSpace(string(out))
	if !commitHashRe.MatchString(hash) {
		return nil, errors.New("git rev-parse: unexpected output")
	}
	c.limit = maxCommitMessage
	out, _, err = f.git.output(ctx, c, "log", "-1", "--no-show-signature", "--no-mailmap",
		"--format=%H%x00%P%x00%an%x00%at%x00%B", hash, "--")
	if err != nil {
		return nil, err
	}
	parts := strings.SplitN(string(out), "\x00", 5)
	if len(parts) != 5 || parts[0] != hash {
		return nil, errors.New("git log: unexpected output")
	}
	at, _ := strconv.ParseInt(parts[3], 10, 64)
	return &commitInfo{
		Hash:    hash,
		Parents: strings.Fields(parts[1]),
		Author:  parts[2],
		Time:    at,
		Message: strings.TrimRight(parts[4], "\n"),
		Files:   []commitFile{},
	}, nil
}

// treeArgs names what a commit is compared with: its first parent (a merge
// shows what it brought into the branch), or nothing for a root commit.
func (ci *commitInfo) treeArgs() []string {
	if len(ci.Parents) == 0 {
		return []string{"--root", ci.Hash}
	}
	return []string{ci.Parents[0], ci.Hash}
}

// commitFiles lists the files ci changed, shared by every client of the
// root for commitFilesTTL. The list is never changed once cached.
func (f *filesAPI) commitFiles(ctx context.Context, root filesRoot, ci *commitInfo) error {
	ctx = context.WithoutCancel(ctx) // shared by every client of the root
	list, err := f.commits.do(statusKey(root)+"\x00"+ci.Hash, func() (commitList, error) {
		args := append([]string{"diff-tree", "-r", "-z", "--name-status", "--no-commit-id", "-M",
			"--no-ext-diff", "--no-textconv", "--ignore-submodules=all"}, ci.treeArgs()...)
		out, cut, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, noFilters: true, heavy: true, limit: maxStatusOutput},
			args...)
		if err != nil {
			return commitList{}, err
		}
		files, truncated := parseNameStatus(out, cut)
		for i := range files {
			e := &files[i]
			e.Sensitive = commitFileSensitive(root.Root, e)
		}
		return commitList{files, truncated}, nil
	})
	if err != nil {
		return err
	}
	ci.Files, ci.Truncated = list.files, list.truncated
	return nil
}

// commitFileSensitive: a name (or a rename's source) that may hold secrets,
// through symlinks in the worktree.
func commitFileSensitive(root string, e *commitFile) bool {
	return sensitivePath(root, filepath.FromSlash(e.Path)) ||
		e.Orig != "" && sensitivePath(root, filepath.FromSlash(e.Orig))
}

// parseNameStatus reads `git diff-tree -z --name-status` output: a status
// then its path, or a rename's/copy's score, source and destination. A record
// cut by the output limit is dropped.
func parseNameStatus(out []byte, cut bool) ([]commitFile, bool) {
	fields := strings.Split(string(out), "\x00")
	if cut {
		fields = fields[:len(fields)-1]
	}
	files := []commitFile{}
	truncated := cut
	for i := 0; i < len(fields) && fields[i] != ""; {
		st := fields[i][:1]
		need := 2
		if st == "R" || st == "C" {
			need = 3
		}
		if i+need > len(fields) || fields[i+need-1] == "" {
			break
		}
		if len(files) == maxStatusEntries {
			truncated = true
			break
		}
		e := commitFile{Status: st, Path: fields[i+need-1]}
		if need == 3 {
			e.Orig = fields[i+1]
		}
		files = append(files, e)
		i += need
	}
	return files, truncated
}

func (f *filesAPI) handleCommit(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	res := commitResponse{Root: req.root.Root, IsRepo: req.root.IsRepo}
	if req.root.IsRepo {
		ci, err := f.headCommit(req.ctx, req.root)
		if err == nil && ci != nil {
			err = f.commitFiles(req.ctx, req.root, ci)
		}
		if err != nil {
			f.error(w, "git commit", err)
			return
		}
		res.Commit = ci
	}
	jsonOK(w, res)
}

func (f *filesAPI) handleCommitDiff(w http.ResponseWriter, r *http.Request) {
	req, cancel, ok := f.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	q := r.URL.Query()
	// The path is checked against the commit's files by commitDiff; where a
	// symlink in the worktree leads is not.
	if f.viewHides(req, q.Get("path"), false, true) {
		f.error(w, "git commit diff", fs.ErrNotExist)
		return
	}
	res, err := f.commitDiff(req.ctx, req.root, q.Get("commit"), q.Get("path"), q.Get("orig"), q.Get("reveal") == "1")
	if err != nil {
		f.error(w, "git commit diff", err)
		return
	}
	jsonOK(w, res)
}

// commitDiff is the diff of one file of HEAD, which must still be the commit
// the client saw.
func (f *filesAPI) commitDiff(ctx context.Context, root filesRoot, commit, path, orig string, reveal bool) (diffResponse, error) {
	if !root.IsRepo {
		return diffResponse{}, errNotChanged
	}
	ci, err := f.headCommit(ctx, root)
	if err != nil {
		return diffResponse{}, err
	}
	if ci == nil || ci.Hash != commit {
		return diffResponse{}, errHeadMoved
	}
	if err := f.commitFiles(ctx, root, ci); err != nil {
		return diffResponse{}, err
	}
	var entry *commitFile
	for i := range ci.Files {
		if e := &ci.Files[i]; e.Path == path && e.Orig == orig {
			entry = e
		}
	}
	if entry == nil {
		return diffResponse{}, errNotChanged
	}
	if f.deniedPath(root.Root, path, root.GitDir) || orig != "" && f.deniedPath(root.Root, orig, root.GitDir) {
		return diffResponse{}, errPathNotAllowed
	}
	res := diffResponse{Root: root.Root, Path: path, Hunks: []diffHunk{}}
	// Checked again now: the cached list may predate a symlink change.
	if (entry.Sensitive || commitFileSensitive(root.Root, entry)) && !reveal {
		res.Sensitive, res.Hunks = true, nil
		return res, nil
	}
	args := append([]string{"diff-tree", "-p", "-r", "--no-commit-id", "-M", "--no-ext-diff", "--no-textconv",
		"--no-color", "--ignore-submodules=all", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3"},
		ci.treeArgs()...)
	args = append(args, "--")
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
