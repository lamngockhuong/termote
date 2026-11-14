package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Claude Code keeps a session at <claudeDir>/projects/<dir>/<id>.jsonl, where
// <dir> is the cwd it started in with every character other than an ASCII
// letter or digit turned into '-'; a long name is cut and suffixed, so dirs
// with a name of claudeLongDirName or more are read too. The name only
// narrows the scan: the cwd each file records decides.

// claudeLongDirName is the length from which Claude Code may have cut a
// project dir's name.
const claudeLongDirName = 200

// claudeProjectName is the project dir name Claude Code gives dir.
func claudeProjectName(dir string) string {
	// Claude Code replaces each UTF-16 unit of a JavaScript string: one
	// '-' for a rune of the BMP, two for one past it.
	var b strings.Builder
	for _, r := range dir {
		switch {
		case r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9':
			b.WriteRune(r)
		case r > 0xFFFF:
			b.WriteString("--")
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// claudeProjectMatch: a project dir that may hold sessions of root or a
// directory under it.
func claudeProjectMatch(name, enc string) bool {
	if len(name) >= claudeLongDirName {
		return true
	}
	if pathsFold {
		name, enc = strings.ToLower(name), strings.ToLower(enc)
	}
	return name == enc || strings.HasPrefix(name, enc+"-")
}

// scanClaude lists root's Claude Code sessions under claudeDir. truncated:
// historyMaxScan files were read and more are left.
func (h *historyAPI) scanClaude(claudeDir, root string) ([]historySession, bool) {
	if claudeDir == "" || !filepath.IsAbs(claudeDir) {
		return nil, false
	}
	real, err := filepath.EvalSymlinks(claudeDir)
	if err != nil {
		return nil, false
	}
	projects := filepath.Join(real, "projects")
	dirs, err := os.ReadDir(projects)
	if err != nil {
		return nil, false
	}
	enc := claudeProjectName(root)
	var out []historySession
	scanned := 0
	for _, d := range dirs {
		if !claudeProjectMatch(d.Name(), enc) {
			continue
		}
		files, err := os.ReadDir(filepath.Join(projects, d.Name()))
		if err != nil {
			continue
		}
		for _, e := range files {
			id, ok := strings.CutSuffix(e.Name(), ".jsonl")
			if !ok || !isSessionID(id) || e.IsDir() {
				continue
			}
			if scanned == historyMaxScan {
				return out, true
			}
			scanned++
			if s, ok := h.claudeSession(real, filepath.Join(projects, d.Name(), e.Name()), id, root); ok {
				out = append(out, s)
			}
		}
	}
	return out, false
}

// claudeSession reads one transcript for the history, when it resolves
// inside claudeDir and its cwd is inside root.
func (h *historyAPI) claudeSession(claudeDir, p, id, root string) (historySession, bool) {
	f, fi, real, ok := openHistoryFile(claudeDir, p)
	if !ok {
		return historySession{}, false
	}
	defer f.Close()
	file, ok := h.index.get(real, fi, func() (historyFile, bool) { return parseClaudeHistory(f, fi.Size(), id) })
	if !ok {
		return historySession{}, false
	}
	return historyEntry(root, real, fi, file)
}

// claudeHistoryRow is the part of a row the history reads.
type claudeHistoryRow struct {
	Type        string `json:"type"`
	Cwd         string `json:"cwd"`
	GitBranch   string `json:"gitBranch"`
	AITitle     string `json:"aiTitle"`
	CustomTitle string `json:"customTitle"`
}

// parseClaudeHistory reads a transcript's head (cwd, branch, first prompt)
// and tail (latest titles and branch). ok is false for a file that names no
// cwd, or holds no prompt of the user in a head that covers it whole.
func parseClaudeHistory(f *os.File, size int64, id string) (historyFile, bool) {
	head, tail, err := readEnds(f, size, historyHead, historyTail)
	if err != nil {
		return historyFile{}, false
	}
	file := historyFile{agent: "claude", id: id}
	var custom, ai, prompt string
	scan := func(chunk []byte, first bool) {
		for line := range bytes.SplitSeq(chunk, []byte("\n")) {
			if len(line) == 0 {
				continue
			}
			if first && prompt == "" && bytes.Contains(line, []byte(`"user"`)) {
				if e, ok := parseClaudeRow(line, 0); ok && e.Role == "user" {
					for _, p := range e.Parts {
						if p.Kind == "text" && strings.TrimSpace(p.Text) != "" {
							prompt = p.Text
							break
						}
					}
				}
			}
			if !bytes.Contains(line, []byte(`"cwd"`)) && !bytes.Contains(line, []byte(`-title"`)) {
				continue
			}
			var row claudeHistoryRow
			if json.Unmarshal(line, &row) != nil {
				continue
			}
			switch row.Type {
			case "custom-title":
				if t := historyTitle(row.CustomTitle); t != "" {
					custom = t
				}
			case "ai-title":
				if t := historyTitle(row.AITitle); t != "" {
					ai = t
				}
			}
			if row.Cwd != "" && file.cwd == "" {
				file.cwd = row.Cwd
			}
			if b := historyBranch(row.GitBranch); b != "" && b != "HEAD" {
				file.branch = b
			}
		}
	}
	scan(head, true)
	scan(tail, false)
	switch {
	case custom != "":
		file.title, file.src = custom, titleCustom
	case ai != "":
		file.title, file.src = ai, titleAI
	default:
		file.title, file.src = historyTitle(prompt), titlePrompt
	}
	if file.cwd == "" || file.title == "" && size <= historyHead {
		return historyFile{}, false
	}
	return file, true
}
