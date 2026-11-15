package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// Codex keeps no index by directory: a thread is a rollout under
// <CODEX_HOME>/sessions/<Y>/<M>/<D>/, its cwd on the session_meta first
// line. The scan walks the days newest first and stops after
// historyMaxScan rollouts. Titles come from session_index.jsonl, where the
// TUI records each thread's name, else the first prompt.

// codexHistoryMeta is the part of session_meta the history reads.
type codexHistoryMeta struct {
	Type    string `json:"type"`
	Payload struct {
		ID           string `json:"id"`
		Cwd          string `json:"cwd"`
		ThreadSource string `json:"thread_source"`
		Parent       string `json:"parent_thread_id"`
		ForkedFrom   string `json:"forked_from_id"`
		Git          *struct {
			Branch string `json:"branch"`
		} `json:"git"`
	} `json:"payload"`
}

// scanCodex lists root's Codex threads under codexHome.
func (h *historyAPI) scanCodex(codexHome, root string) ([]historySession, bool) {
	if codexHome == "" || !filepath.IsAbs(codexHome) {
		return nil, false
	}
	home, err := filepath.EvalSymlinks(codexHome)
	if err != nil {
		return nil, false
	}
	sessions, err := filepath.EvalSymlinks(filepath.Join(home, "sessions"))
	if err != nil {
		return nil, false
	}
	names := codexThreadNames(home)
	var out []historySession
	scanned := 0
	for _, y := range numberedDirs(sessions) {
		for _, m := range numberedDirs(filepath.Join(sessions, y)) {
			for _, d := range numberedDirs(filepath.Join(sessions, y, m)) {
				day := filepath.Join(sessions, y, m, d)
				files, err := os.ReadDir(day)
				if err != nil {
					continue
				}
				// Rollout names start with their time: newest last.
				for _, e := range slices.Backward(files) {
					match := codexRolloutRe.FindStringSubmatch(e.Name())
					if match == nil || e.IsDir() {
						continue
					}
					if scanned == historyMaxScan {
						return forkTitles(out, names), true
					}
					scanned++
					if s, ok := h.codexSession(sessions, filepath.Join(day, e.Name()), match[1], root, names); ok {
						out = append(out, s)
					}
				}
			}
		}
	}
	return forkTitles(out, names), false
}

// forkTitles gives a fork that has no prompt of its own yet the title of
// the thread it was forked from (named, or listed with one), as Codex shows
// it that conversation.
func forkTitles(sessions []historySession, names map[string]string) []historySession {
	byID := make(map[string]int, len(sessions))
	for i, s := range sessions {
		byID[s.ID] = i
	}
	for i := range sessions {
		from := sessions[i].forkOf
		for range codexForkDepth {
			if sessions[i].Title != "" || from == "" {
				break
			}
			if name := names[from]; name != "" {
				sessions[i].Title, sessions[i].TitleSource = name, titleCustom
				break
			}
			j, ok := byID[from]
			if !ok {
				break
			}
			sessions[i].Title, sessions[i].TitleSource = sessions[j].Title, sessions[j].TitleSource
			from = sessions[j].forkOf
		}
	}
	return sessions
}

// numberedDirs lists dir's subdirectories named by a number, highest
// first.
func numberedDirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type num struct {
		name string
		n    int
	}
	var nums []num
	for _, e := range entries {
		n, err := strconv.Atoi(e.Name())
		if err != nil || n < 0 || !e.IsDir() {
			continue
		}
		nums = append(nums, num{e.Name(), n})
	}
	slices.SortFunc(nums, func(a, b num) int { return b.n - a.n })
	out := make([]string, len(nums))
	for i, n := range nums {
		out[i] = n.name
	}
	return out
}

// codexSession reads one rollout for the history.
func (h *historyAPI) codexSession(sessions, p, id, root string, names map[string]string) (historySession, bool) {
	f, fi, real, ok := openHistoryFile(sessions, p)
	if !ok {
		return historySession{}, false
	}
	defer f.Close()
	// The name the rollout resolves to must still carry the id.
	if m := codexRolloutRe.FindStringSubmatch(filepath.Base(real)); m == nil || m[1] != id {
		return historySession{}, false
	}
	file, ok := h.index.get(real, fi, func() (historyFile, bool) { return parseCodexHistory(f, fi.Size(), id) })
	if !ok || file.child {
		return historySession{}, false
	}
	if name := names[id]; name != "" {
		file.title, file.src = name, titleCustom
	}
	return historyEntry(root, real, fi, file)
}

// parseCodexHistory reads a rollout's session_meta line and the first
// prompt after it. ok is false for a rollout whose first line is no
// session_meta of id.
func parseCodexHistory(f *os.File, size int64, id string) (historyFile, bool) {
	r := bufio.NewReaderSize(io.LimitReader(f, historyCodexMeta+historyHead), historyCodexMeta)
	first, err := r.ReadSlice('\n')
	if err != nil {
		return historyFile{}, false
	}
	var meta codexHistoryMeta
	if json.Unmarshal(first, &meta) != nil || meta.Type != "session_meta" || meta.Payload.ID != id {
		return historyFile{}, false
	}
	file := historyFile{agent: "codex", id: id, cwd: meta.Payload.Cwd, src: titlePrompt}
	file.child = meta.Payload.ThreadSource != "" && meta.Payload.ThreadSource != "user"
	if meta.Payload.ThreadSource == "user" && isSessionID(meta.Payload.ForkedFrom) && meta.Payload.ForkedFrom != id {
		file.forkOf = meta.Payload.ForkedFrom
	}
	if meta.Payload.ThreadSource == "subagent" {
		file.parent = meta.Payload.Parent
		if file.parent == "" {
			file.parent = meta.Payload.ForkedFrom
		}
		if !isSessionID(file.parent) {
			file.parent = ""
		}
	}
	if g := meta.Payload.Git; g != nil {
		file.branch = historyBranch(g.Branch)
	}
	start := int64(len(first))
	rest, _ := io.ReadAll(io.LimitReader(r, historyHead))
	if start+int64(len(rest)) < size {
		if i := bytes.LastIndexByte(rest, '\n'); i >= 0 {
			rest = rest[:i+1]
		} else {
			rest = nil
		}
	}
	entries, _ := codexJournal{}.Parse(bytes.NewReader(rest), start)
	for _, e := range entries {
		if e.Role != "user" {
			continue
		}
		for _, p := range e.Parts {
			if p.Kind == "text" && strings.TrimSpace(p.Text) != "" {
				file.title = historyTitle(p.Text)
				break
			}
		}
		if file.title != "" {
			break
		}
	}
	if file.cwd == "" {
		return historyFile{}, false
	}
	return file, true
}

// codexThreadNames reads <home>/session_index.jsonl (home resolved): each
// thread's latest name, by id. Only its first historyCodexIndex bytes are
// read; a read cut short keeps the names before.
func codexThreadNames(home string) map[string]string {
	names := map[string]string{}
	f, _, _, ok := openHistoryFile(home, filepath.Join(home, "session_index.jsonl"))
	if !ok {
		return names
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, historyCodexIndex))
	for line := range bytes.SplitSeq(b, []byte("\n")) {
		var row struct {
			ID   string `json:"id"`
			Name string `json:"thread_name"`
		}
		if json.Unmarshal(line, &row) != nil || !isSessionID(row.ID) {
			continue
		}
		if t := historyTitle(row.Name); t != "" {
			names[row.ID] = t
		}
	}
	return names
}
