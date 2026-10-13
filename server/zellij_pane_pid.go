package main

import (
	"errors"
	"log"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// A Zellij pane's shell, for the Chat view (the agent runs under it, as
// under a tmux pane's shell). Zellij reports no pid, so: the server is the
// process listening on the session's socket (never found by its argv or a
// pane's ZELLIJ_SESSION_NAME: both keep the old name after a rename), and
// the shell is the one child of that server whose environment has exactly
// ZELLIJ_PANE_ID=<N>. Anything ambiguous is not found.

// zellijServerTTL caches a session's server pid.
const zellijServerTTL = 3 * time.Second

var zellijServers = newTTLCache[int](zellijServerTTL)

var errZellijServerNotFound = errors.New("zellij server not found")

// zellijSocketPath is a session's socket.
func zellijSocketPath(session string) string {
	return filepath.Join(zellijSocketDir(), zellijContractDir, session)
}

// zellijServerPID returns the pid of the process listening on session's
// socket, cached for zellijServerTTL unless fresh.
func zellijServerPID(session string, fresh bool) (int, bool) {
	if fresh {
		pid, err := zellijSocketOwner(zellijSocketPath(session))
		return pid, err == nil
	}
	pid, err := zellijServers.do(session, func() (int, error) { return zellijSocketOwner(zellijSocketPath(session)) })
	return pid, err == nil
}

// zellijPaneShell returns the pid of terminal_n's shell in session.
func zellijPaneShell(session string, n int, fresh bool) (int, bool) {
	children, err := procChildrenFunc()
	if err != nil {
		return 0, false
	}
	return zellijPaneShellIn(session, n, fresh, children)
}

// zellijPaneShellIn is zellijPaneShell with a process table shared by the
// panes of one snapshot.
func zellijPaneShellIn(session string, n int, fresh bool, children func(int) []int) (int, bool) {
	server, ok := zellijServerPID(session, fresh)
	if !ok {
		return 0, false
	}
	want := strconv.Itoa(n)
	found := 0
	for _, c := range children(server) {
		env, ok := procEnviron(c)
		if !ok || zellijEnvValue(env, "ZELLIJ_PANE_ID") != want {
			continue
		}
		if found != 0 {
			return 0, false
		}
		found = c
	}
	return found, found != 0
}

// zellijEnvValue returns key's value when env sets it exactly once.
func zellijEnvValue(env []string, key string) string {
	val, seen := "", 0
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			val, seen = v, seen+1
		}
	}
	if seen != 1 {
		return ""
	}
	return val
}

// parseLsofUnixOwners reads `lsof -U -Fpn` output: the pids holding a
// socket named exactly path.
func parseLsofUnixOwners(out, path string) []int {
	var pids []int
	pid := 0
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "p"):
			pid, _ = strconv.Atoi(line[1:])
		case strings.HasPrefix(line, "n") && line[1:] == path && pid > 0:
			if len(pids) == 0 || pids[len(pids)-1] != pid {
				pids = append(pids, pid)
			}
		}
	}
	return pids
}

// warnZellijTermoteEnv logs each Zellij server of this user whose
// environment holds a TERMOTE_* variable: every pane it opens inherits it,
// and Zellij, unlike tmux, cannot unset it. Restarting that session is the
// fix.
func warnZellijTermoteEnv() {
	for _, pid := range procAllPIDs() {
		if procExeBase(pid) != "zellij" {
			continue
		}
		if args := procArgs(pid); len(args) < 2 || args[1] != "--server" {
			continue
		}
		env, ok := procEnviron(pid)
		if !ok {
			continue
		}
		for _, kv := range env {
			if isTermoteEnv(kv) {
				log.Printf("warning: the Zellij server (pid %d) has TERMOTE_* variables in its environment, which its panes inherit; restart that session", pid)
				break
			}
		}
	}
}
