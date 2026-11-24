package main

import "cmp"

// A job's repository (job.Repo): the main checkout of the repository its
// workspace works in, so a job outlives its workspace being closed and
// opened again under a new id (Herdr, a tmux session made again). Only the
// server writes it, from the repositories the nester has cached for the
// groups' folders (no git runs in a request); it never comes from a
// request, never reaches a view-only client, and nothing opens a file or
// runs git with it. A job whose workspace is gone is shown under the first
// open group of the same repository (workspaceNow), and moved there at its
// next write.

// groupRepo is a group's repository as cached.
type groupRepo struct {
	id, repo string
	linked   bool
}

// groupRepos is the repository of each group of snap the nester knows, in
// the snapshot's order. With start, a folder not known yet is looked up in
// the background for a later call.
func (a *agentAPI) groupRepos(snap Snapshot, start bool) []groupRepo {
	if a.nester == nil {
		return nil
	}
	var out []groupRepo
	for _, g := range snap.Groups {
		dir := groupFolder(g)
		if dir == "" {
			continue
		}
		if info, ok := a.nester.info(dir, start); ok {
			if repo := cmp.Or(info.Main, info.Top); repo != "" {
				out = append(out, groupRepo{id: g.ID, repo: repo, linked: info.Linked})
			}
		}
	}
	return out
}

// workspaceNow is the open group j is shown under when its workspace is
// gone: the first of the same repository, a main checkout before a linked
// worktree of it. None while its workspace is open, or without a repository.
func workspaceNow(snap Snapshot, repos []groupRepo, j job) string {
	if j.Workspace == "" || j.Repo == "" || groupIndex(snap.Groups, j.Workspace) >= 0 {
		return ""
	}
	match := ""
	for _, r := range repos {
		if r.repo != j.Repo {
			continue
		}
		if !r.linked {
			return r.id
		}
		if match == "" {
			match = r.id
		}
	}
	return match
}

// anchorJob keeps j's repository with its workspace: recorded while the
// workspace is open and its repository known, dropped with the workspace or
// when this write (from before) moved it to one whose repository is not
// known yet, and a workspace that is gone (not one this write set) moved to
// the group workspaceNow finds, with a workspace event.
func (a *agentAPI) anchorJob(j *job, before string, snap Snapshot, repos []groupRepo) {
	switch {
	case j.Workspace == "":
		j.Repo = ""
	case groupIndex(snap.Groups, j.Workspace) >= 0:
		repo := ""
		for _, r := range repos {
			if r.id == j.Workspace {
				repo = r.repo
			}
		}
		if repo != "" || j.Workspace != before {
			j.Repo = repo
		}
	case j.Workspace != before:
		// Set by this write to a group the last snapshot does not show yet.
		j.Repo = ""
	default:
		if now := workspaceNow(snap, repos, *j); now != "" {
			j.Workspace = now
			a.jobs.addEvent(j, "workspace", now)
		}
	}
}

// jobAnchors is what anchorJob needs, read before the store's lock.
func (a *agentAPI) jobAnchors() (Snapshot, []groupRepo) {
	snap, _ := a.activity.lastSnapshot()
	return snap, a.groupRepos(snap, true)
}
