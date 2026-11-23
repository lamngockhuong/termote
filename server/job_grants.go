package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"time"
)

// grant is the user's leave, given ahead from the PWA, for the orchestrator
// to answer one narrow kind of permission dialog of one job's agent
// (agent_delegate.go). It is pinned to the agent and, for file edits, the
// directory the job had when it was made.
type grant struct {
	ID      string     `json:"id"`
	Job     string     `json:"job,omitempty"`
	Agent   jobAgent   `json:"agent"`
	Dir     string     `json:"dir,omitempty"`
	Kind    string     `json:"kind"`
	Prefix  string     `json:"prefix,omitempty"`
	Created string     `json:"created"`
	Expires string     `json:"expires"`
	Revoked string     `json:"revoked,omitempty"`
	Uses    []grantUse `json:"uses,omitempty"`
}

// maxGrantUses answers are kept on a grant, the newest.
const maxGrantUses = 50

// grantUse is one dialog answered under a grant.
type grantUse struct {
	At      string `json:"at"`
	Command string `json:"command,omitempty"`
	Path    string `json:"path,omitempty"`
}

const (
	// maxGrantsPerJob grants are kept on a job, those in force first.
	maxGrantsPerJob = 20
	// grantMostMinutes: a grant lasts a day at most, less when asked.
	grantMostMinutes = 24 * 60
)

var errGrantPWAOnly = &codedError{"grant_pwa_only",
	"a grant is given from the PWA, signed in with the password or a paired device", http.StatusForbidden}

// errGrantOutsideWorktree: an edit grant covers the job's worktree, and
// the job's agent works in another folder now (the job was moved).
var errGrantOutsideWorktree = &codedError{"grant_outside_worktree",
	"the job's agent works outside the job's worktree: a grant to edit files covers only the worktree", http.StatusConflict}

// canGrant: r comes from a browser signed in with the password or as a full
// paired device. Never the CLI (the local socket), another termote (the
// bridge), Basic auth or a server without sign-in: a grant is the user's
// own say, given where the user reads the job. It is not a wall against a
// process of the same OS user, which can read the password anyway.
func canGrant(r *http.Request) bool {
	if isLocalSocket(r.Context()) {
		return false
	}
	a, ok := authFrom(r.Context())
	return ok && a.Role == roleFull && (a.Kind == authSession || a.Kind == authDevice)
}

type grantInput struct {
	Kind    string `json:"kind"`
	Prefix  string `json:"prefix"`
	Minutes int    `json:"minutes"`
}

// handleGrants gives a grant to job {id} (POST), or ends grant {gid}
// (DELETE /grants/{gid}).
func (a *agentAPI) handleGrants(w http.ResponseWriter, r *http.Request) {
	del := r.PathValue("gid") != ""
	if (del && r.Method != http.MethodDelete) || (!del && r.Method != http.MethodPost) {
		w.Header().Set("Allow", map[bool]string{true: "DELETE", false: "POST"}[del])
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !requireWriteRole(w, r) {
		return
	}
	if !canGrant(r) {
		writeJobError(w, errGrantPWAOnly)
		return
	}
	var in grantInput
	if !del && !decodeJobBody(w, r, &in) {
		return
	}
	if a.jobs == nil {
		writeJobError(w, errJobsUnavailable)
		return
	}
	id := r.PathValue("id")
	if !validTemplateID(id) {
		writeJobError(w, errJobNotFound)
		return
	}
	auth, _ := authFrom(r.Context())
	now := a.jobs.now()
	if del {
		gid := r.PathValue("gid")
		j, err := a.jobs.update(id, "", func(j *job) error {
			for i := range j.Grants {
				if j.Grants[i].ID == gid {
					if j.Grants[i].Revoked == "" {
						j.Grants[i].Revoked = now.UTC().Format(activityTimeFormat)
						a.jobs.addEvent(j, "revoked", grantText(j.Grants[i]))
					}
					return nil
				}
			}
			return &codedError{"grant_not_found", "no such grant", http.StatusNotFound}
		})
		if err != nil {
			writeJobError(w, err)
			return
		}
		auditf("grant_revoked", "grant", gid, "job", id, "by", auditBy(auth))
		jsonOK(w, map[string]any{"job": a.viewJob(j)})
		return
	}
	g, err := newGrant(in, now)
	if err != nil {
		writeJobError(w, err)
		return
	}
	// What the job's agent is now decides; the grant is pinned to it.
	cur, ok := a.jobs.job(id)
	if !ok {
		writeJobError(w, errJobNotFound)
		return
	}
	live := a.viewJob(cur).Live
	if cur.Agent == nil || live.Status == "gone" || live.Status == "unknown" {
		writeJobError(w, invalidJob("the job's agent does not run: a grant needs it"))
		return
	}
	if g.Kind == "edit" && live.OutsideWorktree {
		writeJobError(w, errGrantOutsideWorktree)
		return
	}
	j, err := a.jobs.update(id, "", func(j *job) error {
		if jobFinished(j.State) || j.Agent == nil || !sameJobAgent(*j.Agent, *cur.Agent) {
			return invalidJob("the job changed: look at it again")
		}
		g.Job, g.Agent = j.ID, *j.Agent
		if g.Kind == "edit" {
			if j.Worktree == nil || j.Worktree.Dir == "" {
				return invalidJob("a grant to edit files needs the job's worktree")
			}
			g.Dir = j.Worktree.Dir
		}
		j.Grants = append(j.Grants, g)
		trimGrants(j, now)
		a.jobs.addEvent(j, "grant", grantText(g))
		return nil
	})
	if err != nil {
		writeJobError(w, err)
		return
	}
	auditf("grant_created", "grant", g.ID, "job", id, "kind", g.Kind, "prefix", g.Prefix, "expires", g.Expires, "by", auditBy(auth))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"job": a.viewJob(j), "grant": g.ID})
}

// newGrant checks in: a prefix the rules accept (bash), and a length.
func newGrant(in grantInput, now time.Time) (grant, error) {
	g := grant{ID: newTemplateID(), Kind: in.Kind, Created: now.UTC().Format(activityTimeFormat)}
	switch in.Kind {
	case "bash":
		p := strings.TrimSpace(in.Prefix)
		if len(p) > maxGrantPrefix {
			return grant{}, invalidGrant("chars")
		}
		if code := checkDelegateCommand(p, ""); code != "" {
			return grant{}, invalidGrant(code)
		}
		g.Prefix = p
	case "edit":
		if in.Prefix != "" {
			return grant{}, invalidGrant("chars")
		}
	default:
		return grant{}, invalidJob("a grant is to run a command (bash) or edit files (edit)")
	}
	minutes := in.Minutes
	if minutes == 0 {
		minutes = grantMostMinutes
	}
	if minutes < 1 || minutes > grantMostMinutes {
		return grant{}, invalidJob("a grant lasts 1 minute to 24 hours")
	}
	g.Expires = now.Add(time.Duration(minutes) * time.Minute).UTC().Format(time.RFC3339Nano)
	return g, nil
}

// invalidGrant names the rule a grant's prefix breaks.
func invalidGrant(reason string) error {
	return &codedError{"grant_invalid", "the command prefix is refused (" + reason + ")", http.StatusBadRequest}
}

// trimGrants keeps maxGrantsPerJob grants, dropping ended ones first.
func trimGrants(j *job, now time.Time) {
	for len(j.Grants) > maxGrantsPerJob {
		i := slices.IndexFunc(j.Grants, func(g grant) bool { return !grantInForce(*j, g, now) })
		if i < 0 {
			i = 0
		}
		j.Grants = slices.Delete(j.Grants, i, i+1)
	}
}

func grantText(g grant) string {
	if g.Kind == "bash" {
		return "run " + g.Prefix
	}
	return "edit files in the worktree"
}
