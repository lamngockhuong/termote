package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// gitWorktreeMux is the worktree routes' backend for tmux, Zellij and
// herdr-core: termote runs git itself (git_worktrees.go) and opens or closes
// the group through the backend's own NewGroup and CloseGroup. A group's
// worktree is the one its first pane works in.
type gitWorktreeMux struct {
	m     Mux
	git   *gitRunner
	roots *rootResolver
	nest  *gitNester
	deny  []string
	// base is where new checkouts go (worktreeBase).
	base string
	// validName checks a new group's name the backend's way (tmux,
	// Zellij); nil: the backend takes none (hc names a space after its
	// folder, so a label is not used there).
	validName func(string) bool
}

// gitWorktreeBackend reports whether m gets its worktrees from
// gitWorktreeMux: tmux and psmux, Zellij, and herdr-core.
func gitWorktreeBackend(m Mux) bool {
	switch m.(type) {
	case tmuxMux, *tmuxMux, *zellijMux, *hcMux:
		return true
	}
	return false
}

// worktreeMuxFor is the worktree backend of m: its own (Herdr), else
// gitWorktreeMux on the files routes' git runner, resolver and deny list
// for a backend gitWorktreeBackend names, else nil.
func worktreeMuxFor(m Mux, files *filesAPI, nest *gitNester) worktreeMux {
	if wm, ok := m.(worktreeMux); ok {
		return wm
	}
	if !gitWorktreeBackend(m) {
		return nil
	}
	gm := &gitWorktreeMux{m: m, git: files.git, roots: files.roots, nest: nest, deny: files.deny, base: worktreeBase(m.Name())}
	switch m.(type) {
	case *zellijMux:
		gm.validName = validZellijName
	case *hcMux:
	default:
		gm.validName = validTmuxGroupName
	}
	return gm
}

// maxGitGroupID caps a group id's length; the real check is the snapshot.
const maxGitGroupID = 128

// ValidGroupID: non-empty, short, without control characters. Whether the
// group exists is checked against the snapshot by each operation.
func (*gitWorktreeMux) ValidGroupID(id string) bool {
	return id != "" && len(id) <= maxGitGroupID && utf8.ValidString(id) &&
		strings.IndexFunc(id, unicode.IsControl) < 0
}

// source finds group id in the snapshot and its first pane's repository.
func (g *gitWorktreeMux) source(ctx context.Context, id string) (gitRepoInfo, Snapshot, error) {
	snap, err := peekSnapshot(ctx, g.m)
	if err != nil {
		return gitRepoInfo{}, Snapshot{}, err
	}
	i := groupIndex(snap.Groups, id)
	if i < 0 {
		return gitRepoInfo{}, Snapshot{}, errUnknownGroup
	}
	dir := groupFolder(snap.Groups[i])
	if dir == "" {
		return gitRepoInfo{}, Snapshot{}, errWorktreeNotGit
	}
	repo, ok, err := repoInfo(ctx, g.roots, dir)
	switch {
	case err != nil:
		return gitRepoInfo{}, Snapshot{}, err
	case !ok:
		return gitRepoInfo{}, Snapshot{}, errWorktreeNotGit
	}
	return repo, snap, nil
}

func groupIndex(groups []Group, id string) int {
	for i, gr := range groups {
		if gr.ID == id {
			return i
		}
	}
	return -1
}

// list is repo's worktrees, each with the groups whose first pane works in
// it (GroupID the first, in snapshot order).
func (g *gitWorktreeMux) list(ctx context.Context, repo gitRepoInfo, snap Snapshot) ([]Worktree, error) {
	entries, err := listWorktrees(ctx, g.git, repo)
	if err != nil {
		return nil, err
	}
	type shown struct{ top, id string }
	var tops []shown
	for _, gr := range snap.Groups {
		if dir := groupFolder(gr); dir != "" {
			if r, err := g.roots.resolve(ctx, dir); err == nil && r.IsRepo {
				tops = append(tops, shown{r.Root, gr.ID})
			}
		}
	}
	out := make([]Worktree, 0, len(entries))
	for _, e := range entries {
		w := Worktree{Path: e.Path, Branch: e.Branch, Linked: e.Linked, Openable: e.openable()}
		for _, t := range tops {
			if sameAllowPath(t.top, e.Path) {
				if w.GroupID == "" {
					w.GroupID = t.id
				}
				w.groups += map[bool]string{true: "", false: "\x00"}[w.groups == ""] + t.id
			}
		}
		out = append(out, w)
	}
	return out, nil
}

// ListWorktrees lists the worktrees of the source group's repository.
func (g *gitWorktreeMux) ListWorktrees(ctx context.Context, sourceID string) (WorktreeList, error) {
	repo, snap, err := g.source(ctx, sourceID)
	if err != nil {
		return WorktreeList{}, err
	}
	list, err := g.list(ctx, repo, snap)
	if err != nil {
		return WorktreeList{}, err
	}
	root := repo.Main
	if root == "" {
		root = repo.Top
	}
	return WorktreeList{RepoName: repo.Name, RepoRoot: root, SafeDir: repo.SafeDir, Worktrees: list}, nil
}

// groupName is the name a new group showing branch's checkout gets: none
// for hc; else the label when given, or the branch's slug ('.' made '-',
// which tmux refuses in a session name; no leading '-' or '='; at most 64
// bytes). A name the backend would refuse is invalid_name, checked before
// anything is made.
func (g *gitWorktreeMux) groupName(label, branch string) (string, error) {
	if g.validName == nil {
		return "", nil
	}
	name := label
	if name == "" {
		slug, err := branchSlug(branch)
		if err != nil {
			return "", err
		}
		name = strings.TrimLeft(strings.ReplaceAll(slug, ".", "-"), "-=")
		if len(name) > 64 {
			name = name[:64]
		}
		if name = strings.TrimRight(name, "-"); name == "" {
			name = "worktree"
		}
	}
	if !g.validName(name) {
		return "", errWorktreeName
	}
	return name, nil
}

// openGroup opens a group in the checkout at path. A failure leaves the
// checkout (Open worktree recovers it) and answers open_failed.
func (g *gitWorktreeMux) openGroup(ctx context.Context, name, path string) (string, error) {
	cwd, err := resolveGroupCwd(ctx, path, g.deny)
	if err == nil {
		var id string
		if id, err = g.m.NewGroup(ctx, name, cwd); err == nil {
			return id, nil
		}
	}
	log.Printf("worktree: open a group in %s: %v", path, err)
	return "", errWorktreeOpenFailed
}

// CreateWorktree checks branch out in a new worktree under base (an existing
// branch as it is, a new one from base) and opens a group there.
func (g *gitWorktreeMux) CreateWorktree(ctx context.Context, sourceID, branch, base, label string) (string, error) {
	repo, _, err := g.source(ctx, sourceID)
	if err != nil {
		return "", err
	}
	if repo.Linked {
		return "", errWorktreeLinkedSource
	}
	exists, err := branchExistsIn(ctx, g.git, gitCall{root: repo.Top, safeDir: repo.SafeDir}, branch)
	switch {
	case err != nil:
		return "", err
	case exists && base != "":
		return "", errWorktreeBranchExists
	}
	name, err := g.groupName(label, branch)
	if err != nil {
		return "", err
	}
	path, err := newWorktreePath(g.base, repo.Name, branch, g.deny)
	if err != nil {
		var ce *codedError
		if !errors.As(err, &ce) || ce != errWorktreeName {
			log.Printf("worktree: %v", err)
			err = errWorktreeCreateFailed
		}
		return "", err
	}
	defer g.nest.drop()
	if err := addWorktree(ctx, g.git, repo, path, branch, base, exists); err != nil {
		return "", err
	}
	return g.openGroup(ctx, name, path)
}

// OpenWorktree opens a group in branch's existing linked worktree, or names
// the group already showing it.
func (g *gitWorktreeMux) OpenWorktree(ctx context.Context, sourceID, branch string) (string, bool, error) {
	repo, snap, err := g.source(ctx, sourceID)
	if err != nil {
		return "", false, err
	}
	if repo.Linked {
		return "", false, errWorktreeLinkedSource
	}
	list, err := g.list(ctx, repo, snap)
	if err != nil {
		return "", false, err
	}
	var match []Worktree
	for _, w := range list {
		if w.Branch == branch {
			match = append(match, w)
		}
	}
	switch {
	case len(match) == 0:
		return "", false, errWorktreeNotFound
	case len(match) > 1:
		return "", false, errWorktreeAmbiguous
	case !match[0].Openable:
		return "", false, errWorktreeNotFound
	case match[0].GroupID != "":
		return match[0].GroupID, true, nil
	}
	name, err := g.groupName("", branch)
	if err != nil {
		return "", false, err
	}
	defer g.nest.drop()
	id, err := g.openGroup(ctx, name, match[0].Path)
	return id, false, err
}

// RemoveWorktree closes every group working in the linked worktree (the
// one named first), then deletes the checkout: the path is git's,
// re-derived from the group, never the client's, so nothing is left running
// in a deleted folder. Without force a dirty worktree changes nothing; a
// locked one is refused before anything closes. On Windows the delete waits
// for the closed groups' processes to let go of the folder (a file still
// open there answers in_use, nothing deleted). A remove that fails after
// the close leaves the checkout and the groups closed.
func (g *gitWorktreeMux) RemoveWorktree(ctx context.Context, groupID string, force bool) error {
	repo, snap, err := g.source(ctx, groupID)
	if err != nil {
		return err
	}
	if !repo.Linked {
		return errWorktreeNotLinked
	}
	entries, err := listWorktrees(ctx, g.git, repo)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(entries, func(e worktreeEntry) bool { return sameAllowPath(e.Path, repo.Top) })
	if i < 0 || !entries[i].Linked {
		return errWorktreeNotLinked
	}
	if entries[i].Locked {
		return fmt.Errorf("worktree %s is locked", entries[i].Path)
	}
	list, err := g.list(ctx, repo, snap)
	if err != nil {
		return err
	}
	groups := []string{groupID}
	for _, w := range list {
		if sameAllowPath(w.Path, entries[i].Path) {
			for _, id := range w.groupIDs() {
				if id != groupID {
					groups = append(groups, id)
				}
			}
		}
	}
	if !force {
		dirty, err := worktreeDirty(ctx, g.git, repo)
		if err != nil {
			return err
		}
		if dirty {
			return errWorktreeDirty
		}
	}
	defer g.nest.drop()
	for _, id := range groups {
		if err := g.m.CloseGroup(ctx, id); err != nil {
			return err
		}
	}
	if err := waitWorktreeFree(ctx, entries[i].Path); err != nil {
		if err != errWorktreeInUse {
			log.Printf("worktree remove %s: %v", entries[i].Path, err)
			err = errWorktreeFailed
		}
		return err
	}
	return removeWorktree(ctx, g.git, repo, entries[i].Path)
}

// branchExistsIn reports whether branch is a local branch of the repository
// c runs in (git show-ref --verify, exit 1: it is not).
func branchExistsIn(ctx context.Context, git *gitRunner, c gitCall, branch string) (bool, error) {
	_, _, err := git.output(ctx, c, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() == 1 {
		return false, nil
	}
	return err == nil, err
}
