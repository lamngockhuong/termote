package main

import (
	"fmt"
	"strings"
	"time"
)

// Finding the agent process of a tmux/psmux pane: walk the process tree under
// the pane's shell and take the first process that is Claude Code or Codex
// (agent_proc_codex.go). A Claude Code process has a session file in its own
// Claude config dir whose start time matches it. Claude Code never
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

// claudeProc is a process proven to be an agent: Claude Code, or Codex
// (agent "codex", with codexHome instead of claudeDir).
type claudeProc struct {
	agent     string
	pid       int
	procStart string
	claudeDir string
	codexHome string
	// window: the context window Claude Code's argv chose (0: unknown).
	window int64
	// forkOf: the session Claude Code's argv forks (claudeForkOfArgs).
	forkOf string
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
	p, ok := agentProcUnder(key, rootPID)
	if !ok {
		return AgentSession{}, false
	}
	return sessionOfProc(p)
}

// findCodexUnder returns the session of the Codex process running under
// rootPID, without reading its turn status (herdr reports its own). key
// names the pane, as for findClaudeSession.
func findCodexUnder(key string, rootPID int) (AgentSession, bool) {
	p, ok := agentProcUnder(key, rootPID)
	if !ok || p.agent != "codex" {
		return AgentSession{}, false
	}
	return codexSessionOf(p, "", false)
}

// agentProcUnder is the agent process walkForClaude finds under rootPID,
// cached per pane and root pid.
func agentProcUnder(key string, rootPID int) (claudeProc, bool) {
	if rootPID <= 0 || !agentProcSupported {
		return claudeProc{}, false
	}
	r, _ := agentTrees.do(fmt.Sprintf("%s|%d", key, rootPID), func() (claudeProcResult, error) {
		children, err := procTables.do("", procChildrenFunc)
		if err != nil {
			return claudeProcResult{}, nil
		}
		p, ok := walkForClaude(rootPID, children)
		return claudeProcResult{p, ok}, nil
	})
	return r.p, r.found
}

// findClaudeSessionNow is findClaudeSession without caches, for the checks
// right before a write.
func findClaudeSessionNow(rootPID int) (AgentSession, bool) {
	if rootPID <= 0 || !agentProcSupported {
		return AgentSession{}, false
	}
	children, err := procChildrenFunc()
	if err != nil {
		return AgentSession{}, false
	}
	p, ok := walkForClaude(rootPID, children)
	// A suspended Claude Code (Ctrl+Z) still has an idle session file, but
	// the pane's keys now go to the shell.
	if !ok || !procForeground(p.pid) {
		return AgentSession{}, false
	}
	return sessionOfProc(p)
}

// sessionOfProc reads the session file of a proven Claude Code process, or
// the rollout a Codex process holds.
func sessionOfProc(p claudeProc) (AgentSession, bool) {
	if p.agent == "codex" {
		return codexSessionOf(p, "", true)
	}
	f, ok := readClaudeSessionFile(p.claudeDir, p.pid)
	if !ok || f.procStart() != p.procStart || !isSessionID(f.SessionID) {
		return AgentSession{}, false
	}
	return AgentSession{
		Agent: "claude", ID: f.SessionID, Status: claudeStatus(f.Status),
		ClaudeDir: p.claudeDir, ForkOf: p.forkOf, ClaudeWindow: p.window, PID: p.pid, ProcStart: p.procStart,
	}, true
}

// walkForClaude searches rootPID and its descendants breadth-first for Claude
// Code or Codex; the first one met wins.
func walkForClaude(rootPID int, children func(int) []int) (claudeProc, bool) {
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
		if p, ok := codexProcOf(n.pid); ok {
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
	// argv is read with the process, once per walk; only the window and
	// the forked session it names are kept.
	args := procArgs(pid)
	return claudeProc{agent: "claude", pid: pid, procStart: start, claudeDir: dir,
		window: claudeWindowFromArgs(args), forkOf: claudeForkOfArgs(args)}, true
}

// claudeForkOfArgs is the session id Claude Code's argv resumes with
// --fork-session (`--resume <id>`, `-r <id>` or `--resume=<id>`), "" when it
// forks none or names no session id (a search term). Nothing after "--" is an
// option.
func claudeForkOfArgs(args []string) string {
	id, fork := "", false
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		switch a := args[i]; {
		case a == "--fork-session":
			fork = true
		case (a == "--resume" || a == "-r") && i+1 < len(args):
			id = args[i+1]
		case strings.HasPrefix(a, "--resume="):
			id = strings.TrimPrefix(a, "--resume=")
		}
	}
	if !fork || !isSessionID(id) {
		return ""
	}
	return id
}

// claudeProcAlive reports whether pid still runs with the start time the
// session was found with; a write checks it right before touching the pane.
func claudeProcAlive(pid int, procStart string) bool {
	start, ok := procStartTime(pid)
	return ok && start == procStart
}
