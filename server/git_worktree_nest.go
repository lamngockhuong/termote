package main

import (
	"context"
	"sync"
	"time"
)

// Nesting by git for the backends without worktree groups of their own
// (tmux, Zellij, herdr-core): a group whose first pane works in a linked
// worktree is listed right after the group of its repository's main
// checkout, as Herdr's are. What a folder belongs to is looked up in the
// background and cached, so a snapshot never waits on git.

const (
	// nestFresh is how long a folder's repository stays fresh; nestRetry
	// how long a failed lookup is kept before the next.
	nestFresh = 10 * time.Second
	nestRetry = 30 * time.Second
	// nestCacheMax bounds the folders kept (the cache is cleared when full).
	nestCacheMax = 512
	// nestMaxRunning caps the lookups running at once.
	nestMaxRunning = 4
)

// worktreeRef is a group's membership of a repository's worktree group: its
// repository and whether it is a linked worktree (else the repository's own
// checkout).
type worktreeRef struct {
	repoKey string
	linked  bool
}

// gitNester knows, for each folder a group's first pane works in, its
// repository (repoInfo), looked up in the background.
type gitNester struct {
	// lookup is repoInfo on the files routes' resolver; tests replace it.
	lookup func(ctx context.Context, dir string) (gitRepoInfo, bool, error)
	sem    chan struct{}

	mu      sync.Mutex
	entries map[string]nestEntry
	busy    map[string]bool
	gen     int // bumped by drop: a lookup started before it is discarded
}

type nestEntry struct {
	info  gitRepoInfo
	ok    bool
	until time.Time // looked up again after this
}

func newGitNester(rr *rootResolver) *gitNester {
	return &gitNester{
		lookup:  func(ctx context.Context, dir string) (gitRepoInfo, bool, error) { return repoInfo(ctx, rr, dir) },
		sem:     make(chan struct{}, nestMaxRunning),
		entries: map[string]nestEntry{},
		busy:    map[string]bool{},
	}
}

// drop makes every folder stale after a worktree change: each is looked up
// again at the next full read and served as it was meanwhile, so the view
// does not come apart for a refresh. A lookup already running is discarded.
func (n *gitNester) drop() {
	if n == nil {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	for k, e := range n.entries {
		e.until = time.Time{}
		n.entries[k] = e
	}
	n.gen++
}

// info is dir's repository as cached. With start, a folder not known or no
// longer fresh is looked up in the background, for a later call.
func (n *gitNester) info(dir string, start bool) (gitRepoInfo, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	e, known := n.entries[dir]
	if start && (!known || time.Now().After(e.until)) && !n.busy[dir] {
		n.busy[dir] = true
		go n.resolve(dir, n.gen)
	}
	return e.info, known && e.ok
}

func (n *gitNester) resolve(dir string, gen int) {
	n.sem <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
	info, ok, err := n.lookup(ctx, dir)
	cancel()
	<-n.sem
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.busy, dir)
	if gen != n.gen {
		return
	}
	e := nestEntry{info: info, ok: ok, until: time.Now().Add(nestFresh)}
	if err != nil {
		// Keep what was known, and wait longer before the next try.
		e = n.entries[dir]
		e.until = time.Now().Add(nestRetry)
	}
	if len(n.entries) >= nestCacheMax {
		clear(n.entries)
	}
	n.entries[dir] = e
}

// groupFolder is the folder a group's first pane works in: the first tab's
// first pane (tmux lists every pane of a tab in Processes, the snapshot only
// carries the active one).
func groupFolder(g Group) string {
	if len(g.Tabs) == 0 {
		return ""
	}
	t := g.Tabs[0]
	if len(t.Processes) > 0 {
		return t.Processes[0].Cwd
	}
	if len(t.Panes) > 0 && t.Panes[0].Process != nil {
		return t.Panes[0].Process.Cwd
	}
	return ""
}

// nest fills each group's Worktree from git and lists linked worktrees after
// their repository's group. A group outside a repository, or not known yet,
// is left alone, and so is a repository with no linked worktree open, so a
// plain repository's group looks as it always did. Only with start are
// lookups started (a peek or a view-only read uses what is cached). The
// groups are copied: the snapshot passed in is not written to.
func (n *gitNester) nest(snap Snapshot, start bool) Snapshot {
	if n == nil || len(snap.Groups) == 0 {
		return snap
	}
	infos := make([]gitRepoInfo, len(snap.Groups))
	known := make([]bool, len(snap.Groups))
	withLinked := map[string]bool{}
	for i, g := range snap.Groups {
		dir := groupFolder(g)
		if dir == "" {
			continue
		}
		infos[i], known[i] = n.info(dir, start)
		if known[i] && infos[i].Linked {
			withLinked[infos[i].Common] = true
		}
	}
	if len(withLinked) == 0 {
		return snap
	}
	groups := make([]Group, len(snap.Groups))
	copy(groups, snap.Groups)
	refs := map[string]worktreeRef{}
	for i := range groups {
		info := infos[i]
		if !known[i] || !withLinked[info.Common] {
			continue
		}
		refs[groups[i].ID] = worktreeRef{repoKey: info.Common, linked: info.Linked}
		groups[i].Worktree = &GroupWorktree{Linked: info.Linked, Branch: info.Branch}
	}
	nestWorktrees(groups, refs)
	snap.Groups = groups
	return snap
}

// nestWorktrees puts each repository's linked worktrees right after its own
// checkout, as Herdr's sidebar draws them, and names that checkout as their
// parent; with the checkout not open, they stay together where the first one
// is. Only the snapshot is reordered: a move reads the backend's own order
// (herdr-core moves through the nested view, see hcMux.MoveGroup).
func nestWorktrees(groups []Group, refs map[string]worktreeRef) {
	parent := map[string]string{}  // repository → its checkout's workspace
	linked := map[string][]Group{} // repository → its linked worktrees
	for _, g := range groups {
		ref, ok := refs[g.ID]
		switch {
		case !ok || ref.repoKey == "" || g.Worktree == nil:
		case ref.linked:
			linked[ref.repoKey] = append(linked[ref.repoKey], g)
		case parent[ref.repoKey] == "":
			parent[ref.repoKey] = g.ID
		}
	}
	if len(linked) == 0 {
		return
	}
	out := make([]Group, 0, len(groups))
	placed := map[string]bool{}
	for _, g := range groups {
		ref, ok := refs[g.ID]
		key := ref.repoKey
		if !ok || key == "" || g.Worktree == nil {
			out = append(out, g)
			continue
		}
		if !ref.linked {
			out = append(out, g)
			if parent[key] != g.ID {
				continue
			}
		} else if parent[key] != "" || placed[key] {
			continue
		}
		placed[key] = true
		for _, w := range linked[key] {
			w.Worktree.Parent = parent[key]
			out = append(out, w)
		}
	}
	copy(groups, out)
}
