package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// maxProcessName caps a pane's process name, in bytes.
	maxProcessName = 32
	// maxProcessCwd caps a pane's process directory, in bytes.
	maxProcessCwd = 4096
)

// stripUnsafeRunes removes control and format characters (zero-width,
// bidi overrides and isolates), so a name cannot hide or reorder the text
// around it in a confirmation. Invalid UTF-8 is dropped too.
func stripUnsafeRunes(s string) string {
	return strings.Map(func(r rune) rune {
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
}

// capBytes cuts s to at most n bytes on a rune boundary.
func capBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// processName is what a pane shows of its foreground process: the first word
// of the name the OS reports, after its last '/'. A process can set its own
// title ("npm run dev", "sshd: user@pts/0"), so everything from the first
// space, '=' or ':' on is dropped: no argument text leaves the server.
func processName(raw string) string {
	s := raw
	if i := strings.IndexFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == '=' || r == ':' }); i >= 0 {
		s = s[:i]
	}
	s = stripUnsafeRunes(s)
	if i := strings.LastIndexByte(s, '/'); i >= 0 {
		s = s[i+1:]
	}
	return capBytes(s, maxProcessName)
}

// processCwd is a pane's process directory as sent to clients, or "" when it
// is not an absolute path.
func processCwd(raw string) string {
	s := capBytes(stripUnsafeRunes(raw), maxProcessCwd)
	if !filepath.IsAbs(s) && !strings.HasPrefix(s, "/") {
		return ""
	}
	return s
}

const (
	// herdrProcFresh is how long a pane's process stays fresh: Herdr sends
	// no event when a pane's foreground process changes.
	herdrProcFresh = 5 * time.Second
	// herdrProcBudget bounds one refresh of every stale pane, so a snapshot
	// stays well inside muxTimeout however many panes there are.
	herdrProcBudget = 1500 * time.Millisecond
	// herdrProcParallel is how many pane.process_info calls run at once.
	herdrProcParallel = 4
	// herdrProcRetry is how long a Herdr without pane.process_info is left
	// alone before it is asked again (it may have been updated).
	herdrProcRetry = 5 * time.Minute
	// herdrProcKeep is how long a name outlives failed reads: past it the
	// pane shows no process rather than one that may have exited.
	herdrProcKeep = 3 * herdrProcFresh
)

// herdrProcEntry is one pane's last read; name "" means none could be told.
// fetched is the last attempt, ok the last read that succeeded.
type herdrProcEntry struct {
	name        string
	fetched, ok time.Time
}

// herdrProcCache keeps each pane's foreground process name apart from the
// snapshot cache: the view is shared and cached up to 30s, while names go
// stale in seconds and cost one call per pane.
type herdrProcCache struct {
	mu       sync.Mutex
	entries  map[string]herdrProcEntry
	running  chan struct{} // closed when the refresh in progress ends; nil when none runs
	disabled time.Time     // no calls before this (Herdr lacks pane.process_info)
	now      func() time.Time
}

func newHerdrProcCache() *herdrProcCache {
	return &herdrProcCache{entries: map[string]herdrProcEntry{}, now: time.Now}
}

// names returns the process name of each of panes that has one, refreshing
// stale ones first through fetch. Only one refresh runs at a time: a caller
// arriving during one waits for it (or for ctx), then reads what it left.
// Entries of panes not in panes are dropped.
func (c *herdrProcCache) names(ctx context.Context, panes []string, fetch func(context.Context, string) (string, error)) map[string]string {
	c.mu.Lock()
	keep := make(map[string]bool, len(panes))
	for _, p := range panes {
		keep[p] = true
	}
	for p := range c.entries {
		if !keep[p] {
			delete(c.entries, p)
		}
	}
	var stale []string
	if now := c.now(); !now.Before(c.disabled) {
		for _, p := range panes {
			if e, ok := c.entries[p]; !ok || now.Sub(e.fetched) >= herdrProcFresh {
				stale = append(stale, p)
			}
		}
	}
	switch {
	case len(stale) == 0:
	case c.running != nil:
		wait := c.running
		c.mu.Unlock()
		wctx, cancel := context.WithTimeout(ctx, herdrProcBudget)
		select {
		case <-wait:
		case <-wctx.Done():
		}
		cancel()
		c.mu.Lock()
	default:
		done := make(chan struct{})
		c.running = done
		c.mu.Unlock()
		c.refresh(ctx, stale, fetch)
		c.mu.Lock()
		c.running = nil
		close(done)
	}
	out := make(map[string]string, len(panes))
	// While lookups are off nothing is read again, so no name is served.
	if c.now().Before(c.disabled) {
		c.mu.Unlock()
		return out
	}
	now := c.now()
	for _, p := range panes {
		if e := c.entries[p]; e.name != "" && now.Sub(e.ok) < herdrProcKeep {
			out[p] = e.name
		}
	}
	c.mu.Unlock()
	return out
}

// refresh reads stale panes, herdrProcParallel at a time, within
// herdrProcBudget. A pane whose read failed keeps its previous name until
// it is stale again; one never reached keeps its entry as it was.
func (c *herdrProcCache) refresh(ctx context.Context, stale []string, fetch func(context.Context, string) (string, error)) {
	// The reads serve every waiting snapshot, so the request that started
	// them leaving does not cut them short; the budget still bounds them.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), herdrProcBudget)
	defer cancel()
	jobs := make(chan string)
	var wg sync.WaitGroup
	for range min(herdrProcParallel, len(stale)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range jobs {
				name, err := fetch(ctx, p)
				c.mu.Lock()
				e := c.entries[p]
				e.fetched = c.now()
				if err == nil {
					e.name, e.ok = name, e.fetched
				}
				c.entries[p] = e
				var he *herdrError
				if errors.As(err, &he) && he.Code == "invalid_request" {
					c.disabled = c.now().Add(herdrProcRetry)
				}
				c.mu.Unlock()
			}
		}()
	}
feed:
	for _, p := range stale {
		c.mu.Lock()
		off := c.now().Before(c.disabled)
		c.mu.Unlock()
		if off {
			break
		}
		select {
		case jobs <- p:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
}

// herdrProcessInfo is the part of pane.process_info this server decodes:
// pids and names only. argv, argv0 and cmdline are never read into anything.
type herdrProcessInfo struct {
	ShellPID  int `json:"shell_pid"`
	GroupID   int `json:"foreground_process_group_id"`
	Processes []struct {
		PID  int    `json:"pid"`
		Name string `json:"name"`
	} `json:"foreground_processes"`
}

// leader is the foreground process group's leader (its pid is the group
// id), else the first foreground process; ok is false when there is none.
func (p herdrProcessInfo) leader() (pid int, name string, ok bool) {
	for _, f := range p.Processes {
		if f.PID == p.GroupID {
			return f.PID, f.Name, true
		}
	}
	if len(p.Processes) == 0 {
		return 0, "", false
	}
	return p.Processes[0].PID, p.Processes[0].Name, true
}

// knownShells are names an idle pane's shell has. Herdr reports only the
// foreground processes, so after "exec vim" the one process left has the
// shell's pid; its name is how the two are told apart.
var knownShells = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "fish": true, "dash": true, "ash": true, "ksh": true,
	"mksh": true, "yash": true, "csh": true, "tcsh": true, "nu": true, "elvish": true, "xonsh": true,
	"pwsh": true, "powershell": true, "cmd": true,
}

// idleShell reports whether the pane shows only its shell waiting for input:
// one foreground process, the shell itself, leading its group, with a
// shell's name.
func (p herdrProcessInfo) idleShell() bool {
	if len(p.Processes) != 1 {
		return false
	}
	f := p.Processes[0]
	name := strings.TrimSuffix(strings.ToLower(processName(f.Name)), ".exe")
	return f.PID != 0 && f.PID == p.ShellPID && f.PID == p.GroupID && knownShells[name]
}
