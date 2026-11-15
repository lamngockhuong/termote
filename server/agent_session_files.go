package main

import (
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// The files of one agent session, for the reads that add up what a session
// did (its tokens, the files it touched): its own journal first, then its
// subagents' (Claude Code's subagents/agent-*.jsonl, the rollouts of the
// Codex threads it started). Every file is found by the server under the
// agent's own dirs and opened through the checks of the read that lists it
// elsewhere: the transcript through the journal adapter's Locate, Claude
// Code's subagents as the subagent tree opens them, Codex rollouts as the
// history does.

// sessionFile is one open file of a session; sub marks a subagent's.
type sessionFile struct {
	path string // resolved, the incremental scanners' key
	f    *os.File
	fi   os.FileInfo
	sub  bool
}

func closeSessionFiles(files []sessionFile) {
	for _, f := range files {
		f.f.Close()
	}
}

// sessionFiles opens s's files. The error is the journal's own when it has
// none (errTranscriptNotWritten, errNoTranscript). The caller closes them.
func (h *historyAPI) sessionFiles(s AgentSession) ([]sessionFile, error) {
	switch s.Agent {
	case "claude":
		return claudeSessionFiles(s)
	case "codex":
		return h.codexSessionFiles(s)
	}
	return nil, errAgentUnsupported
}

func claudeSessionFiles(s AgentSession) ([]sessionFile, error) {
	path, err := claudeJournal{}.Locate(s)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(s.ClaudeDir)
	if err != nil {
		return nil, errNoTranscript
	}
	f, fi, real, ok := openHistoryFile(root, path)
	if !ok {
		return nil, errNoTranscript
	}
	files := []sessionFile{{path: real, f: f, fi: fi}}
	proj, ok := claudeSessionProject(root, real, s.ID)
	if !ok {
		return files, nil
	}
	dir, err := openSubagentsDir(root, proj, s.ID)
	if err != nil {
		return files, nil
	}
	defer dir.Close()
	for _, e := range listSubagentDir(dir) {
		if m := subagentFileRe.FindStringSubmatch(e.Name()); m == nil || m[2] != "jsonl" {
			continue
		}
		if f, fi, ok := openPlainFile(dir, e); ok {
			p := filepath.Join(root, "projects", proj, s.ID, "subagents", e.Name())
			files = append(files, sessionFile{path: p, f: f, fi: fi, sub: true})
		}
	}
	return files, nil
}

// claudeSessionProject is the project dir of the transcript at path (found
// by Locate, inside root): it is projects/<proj>/<id>.jsonl unless the
// transcript was a link to another place in root.
func claudeSessionProject(root, path, id string) (string, bool) {
	rel, err := filepath.Rel(root, path)
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if err != nil || len(parts) != 3 || parts[0] != "projects" || parts[2] != id+".jsonl" {
		return "", false
	}
	return parts[1], true
}

func (h *historyAPI) codexSessionFiles(s AgentSession) ([]sessionFile, error) {
	path, err := codexJournal{}.Locate(s)
	if err != nil {
		return nil, err
	}
	sessions, err := filepath.EvalSymlinks(filepath.Join(s.CodexHome, "sessions"))
	if err != nil {
		return nil, errNoTranscript
	}
	f, fi, real, ok := openHistoryFile(sessions, path)
	if !ok {
		return nil, errNoTranscript
	}
	files := []sessionFile{{path: real, f: f, fi: fi}}
	for _, p := range h.codexChildRollouts(sessions, real, s.ID) {
		if f, fi, real, ok := openHistoryFile(sessions, p); ok {
			files = append(files, sessionFile{path: real, f: f, fi: fi, sub: true})
		}
	}
	return files, nil
}

// codexChildRollouts lists the rollouts of the threads id started, and of
// theirs, by the parent their session_meta names (through the history's
// index). A thread starts after its parent, so the day dirs are walked from
// the parent rollout's own, oldest first, at most historyMaxScan rollouts.
func (h *historyAPI) codexChildRollouts(sessions, parent, id string) []string {
	rel, err := filepath.Rel(sessions, filepath.Dir(parent))
	from := strings.Split(filepath.ToSlash(rel), "/")
	if err != nil || len(from) != 3 {
		return nil
	}
	ids := map[string]bool{id: true}
	var out []string
	scanned := 0
	for _, y := range slices.Backward(numberedDirs(sessions)) {
		for _, m := range slices.Backward(numberedDirs(filepath.Join(sessions, y))) {
			for _, d := range slices.Backward(numberedDirs(filepath.Join(sessions, y, m))) {
				if dayBefore([]string{y, m, d}, from) {
					continue
				}
				day := filepath.Join(sessions, y, m, d)
				entries, err := os.ReadDir(day)
				if err != nil {
					continue
				}
				for _, e := range entries {
					match := codexRolloutRe.FindStringSubmatch(e.Name())
					if match == nil || e.IsDir() || ids[match[1]] {
						continue
					}
					if scanned == historyMaxScan {
						return out
					}
					scanned++
					p := filepath.Join(day, e.Name())
					if file, ok := h.codexIndexed(sessions, p, match[1]); ok && file.child && ids[file.parent] {
						ids[match[1]] = true
						out = append(out, p)
					}
				}
			}
		}
	}
	return out
}

// dayBefore: the day dir a (year, month, day) is before b.
func dayBefore(a, b []string) bool {
	for i := range a {
		x, y := numberOf(a[i]), numberOf(b[i])
		if x != y {
			return x < y
		}
	}
	return false
}

func numberOf(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// codexIndexed is the history index's parse of the rollout at p.
func (h *historyAPI) codexIndexed(sessions, p, id string) (historyFile, bool) {
	f, fi, real, ok := openHistoryFile(sessions, p)
	if !ok {
		return historyFile{}, false
	}
	defer f.Close()
	if m := codexRolloutRe.FindStringSubmatch(filepath.Base(real)); m == nil || m[1] != id {
		return historyFile{}, false
	}
	return h.index.get(real, fi, func() (historyFile, bool) { return parseCodexHistory(f, fi.Size(), id) })
}

// sessionTarget is the session a request names: ?agent=&session= picks one
// of the pane root's history (as the history transcript does), none the
// pane's running one. It answers the request itself when there is none.
func (a *agentAPI) sessionTarget(w http.ResponseWriter, r *http.Request) (AgentSession, bool) {
	q := r.URL.Query()
	agent, id := q.Get("agent"), q.Get("session")
	if agent == "" && id == "" {
		s, err := a.session(r.PathValue("id"))
		if err != nil {
			a.agentError(w, "agent session", err)
			return AgentSession{}, false
		}
		return s, true
	}
	if (agent != "claude" && agent != "codex") || !isSessionID(id) {
		jsonErrorCode(w, "invalid_request", "invalid agent or session", http.StatusBadRequest)
		return AgentSession{}, false
	}
	root, ok := a.historyRoot(w, r)
	if !ok {
		return AgentSession{}, false
	}
	s, ok := a.findHistorySession(root.Root, agent, id)
	if !ok {
		writeCoded(w, errSessionNotFound)
		return AgentSession{}, false
	}
	return a.historyAgentSession(s), true
}
