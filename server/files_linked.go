package main

import (
	"bytes"
	"context"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// A symlink that leaves the pane's root is followed only into another work
// tree of the root's own repository (a file or a directory): a linked
// worktree whose generated files or folders link back to the main checkout
// reads them like its own. What it leads to is opened through os.Root at
// that work tree, never by the path the link names, and stays read-only (a
// save refuses a path through a symlink).

// linkedFile is what a path leaving the root through a symlink leads to.
type linkedFile struct {
	root string // the work tree it is in, resolved
	rel  string // its path under root
}

// maxWorktreeList caps git worktree list's output.
const maxWorktreeList = 256 << 10

// worktreeListFailed logs once that git worktree list failed: an older git
// than 2.36 has no -z, and links into other work trees are not followed.
var worktreeListFailed sync.Once

// worktreeRoots lists the work trees of root's repository (bare ones and
// ones that do not lead back to it left out, see ownWorktrees), resolved;
// none when root is not a repo or git cannot list them. The list is kept
// for filesRootTTL (f.worktrees), as a tree, an image or a search asks for
// it once per link.
func (f *filesAPI) worktreeRoots(ctx context.Context, root filesRoot) []string {
	if !root.IsRepo {
		return nil
	}
	list := func() ([]string, error) {
		out, truncated, err := f.git.output(ctx, gitCall{root: root.Root, safeDir: root.SafeDir, limit: maxWorktreeList},
			"worktree", "list", "--porcelain", "-z")
		if err != nil {
			worktreeListFailed.Do(func() {
				log.Printf("files: git worktree list failed, links into other work trees are not followed (needs git 2.36 or later): %v", err)
			})
		}
		if err != nil || truncated {
			return nil, nil
		}
		return ownWorktrees(parseWorktreeList(out), commonGitDir(root.GitDir)), nil
	}
	if f.worktrees == nil {
		trees, _ := list()
		return trees
	}
	trees, _ := f.worktrees.do(root.Root+"\x00"+root.SafeDir, list)
	return trees
}

// parseWorktreeList reads `git worktree list --porcelain -z`: NUL-ended
// lines, a record per work tree ended by an empty one. Each path is
// resolved; a bare repository or a path that does not resolve is left out.
func parseWorktreeList(out []byte) []string {
	var trees []string
	cur, bare := "", false
	flush := func() {
		if cur != "" && !bare && filepath.IsAbs(cur) {
			if real, err := filepath.EvalSymlinks(cur); err == nil {
				trees = append(trees, filepath.Clean(real))
			}
		}
		cur, bare = "", false
	}
	for _, line := range bytes.Split(out, []byte{0}) {
		switch {
		case len(line) == 0:
			flush()
		case bytes.HasPrefix(line, []byte("worktree ")):
			flush()
			cur = filepath.FromSlash(string(line[len("worktree "):]))
		case bytes.Equal(line, []byte("bare")):
			bare = true
		}
	}
	flush()
	return trees
}

// ownWorktrees keeps the work trees whose .git leads back to the shared git
// directory common: the main one's is common itself, a linked one's
// <common>/worktrees/<name>. git lists a linked work tree from the record
// under <common>/worktrees, which can name any directory (written by hand,
// or unpacked with the repository).
func ownWorktrees(trees []string, common string) []string {
	if common == "" {
		return nil
	}
	var own []string
	for _, w := range trees {
		if g, ok := gitEntryTarget(w); ok && (sameAllowPath(g, common) || sameAllowPath(filepath.Dir(g), filepath.Join(common, "worktrees"))) {
			own = append(own, w)
		}
	}
	return own
}

// commonGitDir is the git directory shared by every work tree of the repo
// whose git dir (resolved) is gitDir: a linked worktree's is
// <common>/worktrees/<name>, which holds a commondir file (a main one in a
// directory named worktrees does not).
func commonGitDir(gitDir string) string {
	if gitDir == "" {
		return ""
	}
	if parent := filepath.Dir(gitDir); filepath.Base(parent) == "worktrees" && fileExists(filepath.Join(gitDir, "commondir")) {
		return filepath.Dir(parent)
	}
	return gitDir
}

// linkedTarget is where the symlink rel under root leads when that is
// outside root: inside one of trees (the deepest that holds it), neither
// under a deny dir nor in a git dir (the root's, the shared one or a .git
// below that work tree). ok false otherwise: rel does not resolve, stays in
// root, or leads anywhere else. The check runs before the open, as denied's.
func (f *filesAPI) linkedTarget(root filesRoot, rel string, trees []string) (linkedFile, bool) {
	abs := filepath.Join(root.Root, rel)
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return linkedFile{}, false
	}
	if _, inside := realRelOf(root.Root, rel, real); inside {
		return linkedFile{}, false
	}
	best := linkedFile{}
	for _, w := range trees {
		to, err := filepath.Rel(w, real)
		if err != nil || !filepath.IsLocal(to) || len(w) <= len(best.root) {
			continue
		}
		best = linkedFile{root: w, rel: to}
	}
	if best.root == "" || f.deniedPaths(best.root, abs, real, root.GitDir, commonGitDir(root.GitDir)) {
		return linkedFile{}, false
	}
	return best, true
}

// openInRoot opens rel under dir through os.Root to read it, never waiting
// on a FIFO.
func openInRoot(dir, rel string) (*os.File, error) {
	rt, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer rt.Close()
	return rt.OpenFile(rel, os.O_RDONLY|openNonblock, 0)
}

// readRoot is the os.Root a path under the pane's root is read through, and
// the path under it: the pane root's own, or the work tree of the repository
// the path leads into (via set, see rootFor).
type readRoot struct {
	rt  *os.Root
	rel string
	via linkedFile
}

// rootFor opens the os.Root rel under root is read through. When rel leads
// out of root (through a symlink, rel itself or a directory above it) and
// linked is set, that is the work tree of the repository it leads into
// (linkedTarget); otherwise root's own, where opening rel fails as before.
// The caller closes rt.
func (f *filesAPI) rootFor(ctx context.Context, root filesRoot, rel string, linked bool) (readRoot, error) {
	rt, err := os.OpenRoot(root.Root)
	if err != nil {
		return readRoot{}, err
	}
	if _, err := rt.Stat(rel); !linked || !isPathEscape(err) {
		return readRoot{rt: rt, rel: rel}, nil
	}
	if t, ok := f.linkedTarget(root, rel, f.worktreeRoots(ctx, root)); ok {
		if lrt, err := os.OpenRoot(t.root); err == nil {
			rt.Close()
			return readRoot{rt: lrt, rel: t.rel, via: t}, nil
		}
	}
	return readRoot{rt: rt, rel: rel}, nil
}

// openRead opens rel under root to read it, never waiting on a FIFO, through
// rootFor.
func (f *filesAPI) openRead(ctx context.Context, root filesRoot, rel string, linked bool) (*os.File, error) {
	at, err := f.rootFor(ctx, root, rel, linked)
	if err != nil {
		return nil, err
	}
	defer at.rt.Close()
	return at.rt.OpenFile(at.rel, os.O_RDONLY|openNonblock, 0)
}
