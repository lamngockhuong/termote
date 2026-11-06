package main

import (
	"context"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Find and content search through a directory symlink that leads into
// another work tree of the repository (linkedTarget): a linked worktree's
// docs/records -> <main checkout>/docs/records is searched like one of the
// root's directories. What it holds is listed by that work tree's git, so
// its files are tracked, untracked or ignored as the work tree sees them
// (a linked node_modules stays ignored), and named under the link.

// maxLinkedDirs caps the linked directories one list reads; a variable, so
// tests can lower it.
var maxLinkedDirs = 64

// linkedDir is a symlink of the root leading to a directory of another work
// tree.
type linkedDir struct {
	rel string     // the link, '/'-separated, under the root
	to  linkedFile // the directory it leads to
	// safeDir is passed as safe.directory to git in that work tree: the
	// repository was trusted at the root (filesRoot.SafeDir), so is it there.
	safeDir string
}

// findLinkedDirs lists the untracked symlinks of root (ignored or not, as
// `git ls-files -o --directory` names them: never one inside an untracked
// directory) that lead to a directory of another work tree of the
// repository. None outside a repo or when the repository has no other work
// tree. A symlink git tracks is not looked at. incomplete: git failed or
// cut its list, so a link may have been missed.
func (f *filesAPI) findLinkedDirs(ctx context.Context, root filesRoot) (dirs []linkedDir, incomplete bool) {
	trees := f.worktreeRoots(ctx, root)
	if len(trees) < 2 {
		return nil, false
	}
	// git names no path through a symlink: Lstat sees the link itself. Deny
	// dirs and git dirs are left to linkedTarget.
	out, cut, err := f.git.output(ctx, findCall(root), "ls-files", "-o", "--directory", "-z")
	for _, p := range splitNul(out) {
		native := filepath.FromSlash(p)
		if strings.HasSuffix(p, "/") {
			continue
		}
		if fi, err := os.Lstat(filepath.Join(root.Root, native)); err != nil || fi.Mode()&fs.ModeSymlink == 0 {
			continue
		}
		t, ok := f.linkedTarget(root, native, trees)
		if !ok {
			continue
		}
		if fi, err := os.Lstat(filepath.Join(t.root, t.rel)); err != nil || !fi.IsDir() {
			continue
		}
		d := linkedDir{rel: p, to: t}
		if root.SafeDir != "" {
			d.safeDir = t.root
		}
		dirs = append(dirs, d)
		if len(dirs) == maxLinkedDirs {
			break
		}
	}
	return dirs, cut || err != nil
}

// findLinkedFiles lists the files under dirs, named under their links: with
// ignored, the ones each work tree's git ignores (a directory ignored whole
// walked, never entering an excluded name, nor a link of an excluded name),
// else the tracked and untracked ones it does not. It stops at left paths with what was read before;
// incomplete is set when one was left out, or a directory could not be read.
// Deny dirs are left to the reads (findResults, searchScan.file), as git
// lists no .git.
func (f *filesAPI) findLinkedFiles(ctx context.Context, dirs []linkedDir, ignored bool, ex findExcludes, left int) (entries []findEntry, read []string, incomplete bool) {
	b := newFindBudget()
	b.left = left
	for _, d := range dirs {
		if ignored && hasExcludedPart(d.rel, ex) {
			continue
		}
		to := filepath.ToSlash(d.to.rel)
		args := []string{"ls-files", "-co", "--exclude-standard", "--deduplicate", "-z", "--", ":(literal)" + to}
		if ignored {
			args = []string{"ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z", "--", ":(literal)" + to}
		}
		out, cut, err := f.git.output(ctx, gitCall{root: d.to.root, safeDir: d.safeDir, heavy: true, noBackoff: true, limit: findListOutput}, args...)
		rt, rerr := os.OpenRoot(d.to.root)
		incomplete = incomplete || cut || err != nil || rerr != nil
		if rerr != nil {
			continue
		}
		// A path of the work tree ('/'-separated, under the directory: the
		// pathspec) named under the link
		under := func(p string) string {
			rel, _ := filepath.Rel(filepath.FromSlash(to), filepath.FromSlash(p))
			return path.Join(d.rel, filepath.ToSlash(rel))
		}
		w := &findWalk{rt: rt, ex: ex, b: b, ignored: ignored}
		for _, p := range splitNul(out) {
			p, isDir := strings.CutSuffix(p, "/")
			// git names an ignored directory above the linked one whole
			// (.claude/ for .claude/plans): only the linked one is read.
			if strings.HasPrefix(to, p+"/") {
				p, isDir = to, true
			}
			if ignored && hasExcludedPart(p, ex) {
				continue
			}
			if isDir {
				w.walk(p, strings.Count(p, "/")+1)
			} else if b.take() {
				w.out = append(w.out, newFindEntry(p, ignored))
			}
			if b.stopped {
				break
			}
		}
		rt.Close()
		for _, e := range w.out {
			entries = append(entries, newFindEntry(under(e.rel), ignored))
		}
		for _, r := range w.read {
			read = append(read, under(r))
		}
		incomplete = incomplete || w.deep
		if b.stopped {
			return entries, read, true
		}
	}
	return entries, read, incomplete
}

// withLinked adds to l the files under root's linked directories
// (findLinkedDirs, findLinkedFiles), up to findMaxPaths in all; a failure
// there only marks l incomplete. The view-only index (files, dirs) never
// holds them.
func (f *filesAPI) withLinked(ctx context.Context, root filesRoot, l findList, ignored bool, ex findExcludes) findList {
	dirs, cut := f.findLinkedDirs(ctx, root)
	entries, read, incomplete := f.findLinkedFiles(ctx, dirs, ignored, ex, findMaxPaths-len(l.entries))
	l.entries = append(l.entries, entries...)
	l.read = append(l.read, read...)
	l.incomplete = l.incomplete || cut || incomplete
	return l
}
