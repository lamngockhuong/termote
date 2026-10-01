package main

import (
	"fmt"
	"time"
)

// Finding the Claude Code process of a tmux/psmux pane: walk the process tree
// under the pane's shell and take the first process that has a session file
// in its own Claude config dir whose start time matches it. Claude Code never
// removes its session files, so a file for a pid proves nothing on its own: a
// dead session's pid can be reused by any other process.

const (
	agentProcMaxDepth = 6
	agentProcMaxNodes = 256
	// agentTreeTTL caches the result of a walk. The session file itself is
	// read again on every lookup, because /clear or a resume changes the
	// session id while the process stays the same.
	agentTreeTTL = 3 * time.Second
)

// claudeProc is a process proven to be Claude Code.
type claudeProc struct {
	pid       int
	procStart string
	claudeDir string
}

// agentTrees caches walks keyed by pane and root pid.
var agentTrees = newTTLCache[claudeProcResult](agentTreeTTL)

// procTables shares one process listing between the walks of one snapshot
// (on macOS a listing is a `ps -A`).
var procTables = newTTLCache[func(int) []int](time.Second)

type claudeProcResult struct {
	p     claudeProc
	found bool
}

// findClaudeSession returns the Claude Code session running under rootPID.
// key names the pane, so a pane whose shell changed gets a new walk.
func findClaudeSession(key string, rootPID int) (AgentSession, bool) {
	if rootPID <= 0 || !agentProcSupported {
		return AgentSession{}, false
	}
	r, _ := agentTrees.do(fmt.Sprintf("%s|%d", key, rootPID), func() (claudeProcResult, error) {
		p, ok := walkForClaude(rootPID)
		return claudeProcResult{p, ok}, nil
	})
	if !r.found {
		return AgentSession{}, false
	}
	f, ok := readClaudeSessionFile(r.p.claudeDir, r.p.pid)
	if !ok || f.procStart() != r.p.procStart || !isSessionID(f.SessionID) {
		return AgentSession{}, false
	}
	return AgentSession{
		Agent: "claude", ID: f.SessionID, Status: claudeStatus(f.Status),
		ClaudeDir: r.p.claudeDir, PID: r.p.pid, ProcStart: r.p.procStart,
	}, true
}

// walkForClaude searches rootPID and its descendants breadth-first.
func walkForClaude(rootPID int) (claudeProc, bool) {
	children, err := procTables.do("", procChildrenFunc)
	if err != nil {
		return claudeProc{}, false
	}
	domain := claudePIDDomain()
	type node struct{ pid, depth int }
	queue := []node{{rootPID, 0}}
	seen := map[int]bool{rootPID: true}
	for len(queue) > 0 && len(seen) <= agentProcMaxNodes {
		n := queue[0]
		queue = queue[1:]
		if p, ok := claudeProcOf(n.pid, domain); ok {
			return p, true
		}
		if n.depth == agentProcMaxDepth {
			continue
		}
		for _, c := range children(n.pid) {
			if !seen[c] {
				seen[c] = true
				queue = append(queue, node{c, n.depth + 1})
			}
		}
	}
	return claudeProc{}, false
}

// claudeProcOf checks whether pid is a live Claude Code process: its own
// config dir has a session file for pid, recorded with pid's start time and,
// where pid namespaces exist, this namespace.
func claudeProcOf(pid int, domain string) (claudeProc, bool) {
	dir, ok := procClaudeDir(pid)
	if !ok {
		return claudeProc{}, false
	}
	f, ok := readClaudeSessionFile(dir, pid)
	if !ok || f.procStart() == "" {
		return claudeProc{}, false
	}
	if domain != "" && f.PIDDomain != domain {
		return claudeProc{}, false
	}
	start, ok := procStartTime(pid)
	if !ok || start != f.procStart() {
		return claudeProc{}, false
	}
	return claudeProc{pid: pid, procStart: start, claudeDir: dir}, true
}

// claudeProcAlive reports whether pid still runs with the start time the
// session was found with; a write checks it right before touching the pane.
func claudeProcAlive(pid int, procStart string) bool {
	start, ok := procStartTime(pid)
	return ok && start == procStart
}
