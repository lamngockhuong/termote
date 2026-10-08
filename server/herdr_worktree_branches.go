package main

import (
	"context"
	"errors"
	"log"
	"slices"
	"sync"
	"time"
)

const (
	// herdrBranchFresh is how long a repository's branches are fresh; a
	// worktree event or change makes them stale at once.
	herdrBranchFresh = 10 * time.Second
	// herdrBranchKeep is how long branches outlive failed reads: past it a
	// workspace shows no branch rather than one that may have changed.
	herdrBranchKeep = 30 * time.Second
	// herdrBranchBudget bounds one refresh of every stale repository.
	herdrBranchBudget = 1500 * time.Millisecond
	// herdrBranchRetry is how long a busy Herdr, or one without
	// worktree.list, is left alone.
	herdrBranchRetry = 5 * time.Minute
)

// herdrBranchRepo is one repository's last read: workspace → branch.
// fetched is the last attempt, ok the last read that succeeded.
type herdrBranchRepo struct {
	byGroup     map[string]string
	fetched, ok time.Time
}

// herdrBranchCache keeps each worktree workspace's branch, which
// session.snapshot does not carry: worktree.list runs git, so it is read in
// the background, never on a snapshot's path (stale-while-revalidate).
type herdrBranchCache struct {
	mu       sync.Mutex
	repos    map[string]*herdrBranchRepo // repo_key →
	running  bool
	gen      uint64    // bumped by drop
	disabled time.Time // no calls before this
	lastErr  string    // logged once until another one
	now      func() time.Time
	fetch    func(ctx context.Context, sourceID string) (map[string]string, error)
	done     chan struct{} // tests: receives after each refresh
}

func newHerdrBranchCache(fetch func(context.Context, string) (map[string]string, error)) *herdrBranchCache {
	return &herdrBranchCache{repos: map[string]*herdrBranchRepo{}, now: time.Now, fetch: fetch}
}

// branches returns the branch of each workspace of v's worktree groups that
// is known, and starts one background refresh when a repository is stale.
// Repositories no longer in v are dropped.
func (c *herdrBranchCache) branches(v herdrView) map[string]string {
	sources := map[string]string{} // repo_key → a workspace to list through
	for id, ref := range v.worktrees {
		if s, ok := sources[ref.repoKey]; !ok || id < s {
			sources[ref.repoKey] = id
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.repos {
		if _, ok := sources[key]; !ok {
			delete(c.repos, key)
		}
	}
	now := c.now()
	out := map[string]string{}
	var stale []string
	for key := range sources {
		r := c.repos[key]
		if r == nil {
			stale = append(stale, key)
			continue
		}
		if now.Sub(r.fetched) >= herdrBranchFresh {
			stale = append(stale, key)
		}
		if now.Sub(r.ok) < herdrBranchKeep {
			for id, b := range r.byGroup {
				if _, ok := v.worktrees[id]; ok {
					out[id] = b
				}
			}
		}
	}
	if len(stale) > 0 && !c.running && !now.Before(c.disabled) {
		// Oldest first, so a budget too short for all of them still gets
		// round to every one.
		slices.SortFunc(stale, func(a, b string) int {
			return c.lastFetched(a).Compare(c.lastFetched(b))
		})
		jobs := make([][2]string, len(stale))
		for i, key := range stale {
			jobs[i] = [2]string{key, sources[key]}
		}
		c.running = true
		go c.refresh(jobs, c.gen)
	}
	return out
}

func (c *herdrBranchCache) lastFetched(key string) time.Time {
	if r := c.repos[key]; r != nil {
		return r.fetched
	}
	return time.Time{}
}

// refresh reads each {repo_key, source} in turn within herdrBranchBudget.
// A read that started before a drop is kept but stays stale.
func (c *herdrBranchCache) refresh(jobs [][2]string, gen uint64) {
	ctx, cancel := context.WithTimeout(context.Background(), herdrBranchBudget)
	defer cancel()
	defer func() {
		c.mu.Lock()
		c.running = false
		done := c.done
		c.mu.Unlock()
		if done != nil {
			done <- struct{}{}
		}
	}()
	for _, job := range jobs {
		if ctx.Err() != nil {
			return
		}
		byGroup, err := c.fetch(ctx, job[1])
		c.mu.Lock()
		r := c.repos[job[0]]
		if r == nil {
			r = &herdrBranchRepo{}
			c.repos[job[0]] = r
		}
		now := c.now()
		if c.gen == gen {
			r.fetched = now
		}
		if err == nil {
			r.byGroup, r.ok = byGroup, now
		}
		var he *herdrError
		off := errors.As(err, &he) && (he.Code == "worktree_busy" || he.Code == "invalid_request")
		if off {
			c.disabled = now.Add(herdrBranchRetry)
		}
		logIt := err != nil && err.Error() != c.lastErr
		if err != nil {
			c.lastErr = err.Error()
		}
		c.mu.Unlock()
		if logIt {
			log.Printf("herdr worktree branches: %v", err)
		}
		if off {
			return
		}
	}
}

// drop makes every repository stale: a worktree was created, opened or
// removed. What is known is still served until the next read.
func (c *herdrBranchCache) drop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	for _, r := range c.repos {
		r.fetched = time.Time{}
	}
}
