package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"time"
)

// termote agents start --worktree <branch>: the agent starts in a new git
// worktree of the workspace's repository, on a new branch, in the first pane
// of the workspace the backend opens for it, so agents working side by side
// never share a checkout. The same command run again after a failure goes on
// in the worktree it made; a branch that exists without a worktree is
// refused, so an agent never works in a branch the user has left half done.
// Nothing made is ever removed: what stays is named.

var (
	// agentsWorktreeBusyMost: how long a create waits, in all, for another
	// worktree change to finish.
	agentsWorktreeBusyMost = 90 * time.Second
	// agentsWorktreeSettle: how long the list is read for a create that did
	// not answer in time, which may still finish.
	agentsWorktreeSettle = 60 * time.Second
	// agentsWorktreePaneWait: how long the new workspace is given to show
	// its pane, with its directory.
	agentsWorktreePaneWait = 15 * time.Second
	agentsWorktreeEvery    = time.Second
)

// errAgentsMaybeSent: the request went and no answer came; it may have
// been carried out.
var errAgentsMaybeSent = errors.New(socketNoAnswerMsg)

type worktreeListing struct {
	RepoName  string     `json:"repoName"`
	Worktrees []Worktree `json:"worktrees"`
	Branches  []string   `json:"branches"`
}

func (l worktreeListing) find(branch string) (Worktree, bool) {
	for _, w := range l.Worktrees {
		if w.Branch == branch {
			return w, true
		}
	}
	return Worktree{}, false
}

func (c *cli) worktreeList(port int, groupID string) (worktreeListing, error) {
	var l worktreeListing
	err := c.agentsGet(port, "/api/mux/worktrees?groupId="+url.QueryEscape(groupID), &l)
	return l, err
}

// worktreeTarget makes (or, run again, finds) branch's worktree of g's
// repository and returns the first pane of its workspace.
func (c *cli) worktreeTarget(port int, s Snapshot, g Group, kind, branch, base, label string) (startTarget, error) {
	// Every check before anything is made.
	if kind == "codex" && !s.Caps.AgentStartCodex {
		return startTarget{}, fmt.Errorf("the %s backend of this server cannot start Codex", plainText(s.Backend))
	}
	if !s.Caps.Worktrees {
		return startTarget{}, fmt.Errorf("the %s backend of this server cannot make worktrees", plainText(s.Backend))
	}
	list, err := c.worktreeList(port, g.ID)
	if err != nil {
		return startTarget{}, err
	}
	b := plainText(branch)
	var groupID string
	fresh := true // the workspace is opened by this command
	switch wt, found := list.find(branch); {
	case found && !wt.Linked:
		return startTarget{}, fmt.Errorf("branch %s is the main worktree's; pick a new branch name", b)
	case found && !wt.Openable:
		return startTarget{}, fmt.Errorf("the worktree of branch %s (%s) cannot be opened; pick a new branch name", b, plainText(wt.Path))
	case found:
		// A run before this one made it: go on there.
		var already bool
		groupID, already, err = c.openWorktree(port, g.ID, branch)
		fresh = !already
	case slices.Contains(list.Branches, branch):
		return startTarget{}, fmt.Errorf("branch %s already exists; pick a new name or open it from the PWA", b)
	default:
		groupID, err = c.createWorktree(port, g.ID, branch, base, label)
	}
	if err != nil {
		return startTarget{}, err
	}
	if list, err = c.worktreeList(port, g.ID); err != nil {
		return startTarget{}, err
	}
	wt, found := list.find(branch)
	if !found {
		return startTarget{}, fmt.Errorf("the worktree of branch %s is not in the list after it was made; see the PWA's worktrees", b)
	}
	t := startTarget{dir: wt.Path, used: !fresh, keep: fmt.Sprintf("workspace %s, branch %s, in %s stays", plainText(groupID), b, plainText(wt.Path))}
	p, err := c.worktreePane(port, groupID, wt.Path)
	if err != nil {
		return startTarget{}, t.note(err)
	}
	t.paneID = p.pane.ID
	t.where = fmt.Sprintf("workspace %s, branch %s", plainText(p.group.Name), b)
	return t, nil
}

// openWorktree opens branch's existing worktree, or names the workspace
// that shows it.
// already: the workspace was open before.
func (c *cli) openWorktree(port int, sourceID, branch string) (id string, already bool, err error) {
	r, err := c.agentsCall(port, http.MethodPost, "/api/mux/worktrees/open", map[string]string{"groupId": sourceID, "branch": branch},
		worktreeCallTimeout+15*time.Second)
	if err != nil {
		return "", false, err
	}
	return worktreeGroupID(r)
}

func worktreeGroupID(r agentsReply) (string, bool, error) {
	if r.status != http.StatusOK {
		return "", false, agentsRefusal(r)
	}
	var made struct {
		ID          string `json:"id"`
		AlreadyOpen bool   `json:"alreadyOpen"`
	}
	if json.Unmarshal(r.body, &made) != nil || made.ID == "" {
		return "", false, errors.New("unexpected answer from the server to the worktree")
	}
	return made.ID, made.AlreadyOpen, nil
}

// createWorktree makes branch's worktree and its workspace. Another change
// running (busy) is waited for; a create that did not answer in time is
// followed in the list, never made again.
func (c *cli) createWorktree(port int, sourceID, branch, base, label string) (string, error) {
	body := map[string]string{"groupId": sourceID, "branch": branch, "base": base, "label": label}
	until := time.Now().Add(agentsWorktreeBusyMost)
	pause := agentsWorktreeEvery
	for {
		r, err := c.agentsCall(port, http.MethodPost, "/api/mux/worktrees", body, worktreeTimeout+15*time.Second)
		switch {
		case errors.Is(err, errAgentsMaybeSent):
			return c.settleWorktree(port, sourceID, branch)
		case err != nil:
			return "", err
		case r.status == http.StatusOK:
			id, _, err := worktreeGroupID(r)
			return id, err
		}
		switch r.failure().Code {
		case "busy":
			if time.Now().Add(pause).After(until) {
				return "", agentsRefusal(r)
			}
			time.Sleep(pause)
			pause = min(2*pause, 10*time.Second)
			continue
		case "unknown":
			return c.settleWorktree(port, sourceID, branch)
		}
		return "", agentsRefusal(r)
	}
}

// settleWorktree reads the list until branch's worktree shows, for a create
// whose end the server could not wait for.
func (c *cli) settleWorktree(port int, sourceID, branch string) (string, error) {
	until := time.Now().Add(agentsWorktreeSettle)
	for {
		if list, err := c.worktreeList(port, sourceID); err == nil {
			if wt, ok := list.find(branch); ok && wt.Linked {
				// Opened by the create this command sent.
				if wt.GroupID != "" {
					return wt.GroupID, nil
				}
				id, _, err := c.openWorktree(port, sourceID, branch)
				return id, err
			}
		}
		if time.Now().After(until) {
			return "", fmt.Errorf("the worktree of branch %s did not show up; nothing was started (check the PWA's worktrees before trying again)", plainText(branch))
		}
		time.Sleep(agentsWorktreeEvery)
	}
}

// worktreePane waits for workspace groupID to show its first pane in dir,
// the worktree's directory.
func (c *cli) worktreePane(port int, groupID, dir string) (snapPane, error) {
	until := time.Now().Add(agentsWorktreePaneWait)
	for {
		s, err := c.agentsSnapshot(port)
		if err != nil {
			return snapPane{}, err
		}
		for _, p := range snapshotPanes(s) {
			if p.group.ID != groupID {
				continue
			}
			switch cwd := p.cwd(); {
			case cwd == "":
			case sameDirPath(cwd, dir):
				return p, nil
			default:
				return snapPane{}, fmt.Errorf("the worktree's workspace opened in %s, not in %s; nothing was started", plainText(cwd), plainText(dir))
			}
			break // the first pane only
		}
		if time.Now().After(until) {
			return snapPane{}, errors.New("the worktree's workspace did not show its pane and directory in time; nothing was started")
		}
		time.Sleep(agentsWorktreeEvery)
	}
}

// sameDirPath: a and b are one directory, through symlinks.
func sameDirPath(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ra, err1 := filepath.EvalSymlinks(a)
	rb, err2 := filepath.EvalSymlinks(b)
	return err1 == nil && err2 == nil && ra == rb
}
