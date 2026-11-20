package main

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func viewCommandsRequest() *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/mux/panes/1/agent/commands", nil)
	return req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d1"}))
}

func commandNames(cmds []agentCommand) []string {
	var names []string
	for _, c := range cmds {
		names = append(names, c.Name)
	}
	return names
}

// A view-only client gets no project command from a pane root Files hides
// from it (no git repo): a command's description is the file's first line.
// The user's commands stay, and a full client still gets the project's.
func TestViewOnlyCommandsOutsideRepo(t *testing.T) {
	root, claude := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(root, ".claude/commands/notes.md"), "PRIVATE-FIRST-LINE db host\nmore")
	writeFile(t, filepath.Join(root, ".claude/skills/plan/SKILL.md"), "---\ndescription: PRIVATE-SKILL\n---\n")
	writeFile(t, filepath.Join(claude, "commands/usr.md"), "User one")
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: claude}
	mux := commandsServer(t, s, true, root, true)

	code, cmds := getCommands(t, mux, viewCommandsRequest())
	if got := commandNames(cmds); code != http.StatusOK || !slices.Equal(got, []string{"usr"}) {
		t.Errorf("view-only outside a repo = %d %v", code, cmds)
	}
	code, cmds = getCommands(t, mux, httptest.NewRequest(http.MethodGet, "/api/mux/panes/1/agent/commands", nil))
	if got := commandNames(cmds); code != http.StatusOK || !slices.Equal(got, []string{"notes", "plan", "usr"}) {
		t.Errorf("full outside a repo = %d %v", code, cmds)
	}
}

// In a repo a view-only client gets the project commands and skills git
// tracks, never an untracked one; a full client gets both.
func TestViewOnlyCommandsTrackedOnly(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root, claude := t.TempDir(), t.TempDir()
	gitInit(t, root)
	writeFile(t, filepath.Join(root, ".claude/commands/build.md"), "Build it")
	writeFile(t, filepath.Join(root, ".claude/skills/ship/SKILL.md"), "---\ndescription: Ship it\n---\n")
	gitAdd(t, root)
	writeFile(t, filepath.Join(root, ".claude/commands/notes.md"), "PRIVATE-FIRST-LINE")
	writeFile(t, filepath.Join(root, ".claude/skills/draft/SKILL.md"), "---\ndescription: PRIVATE-SKILL\n---\n")
	s := AgentSession{Agent: "claude", ID: testSessionID, ClaudeDir: claude}
	mux := commandsServer(t, s, true, root, true)

	code, cmds := getCommands(t, mux, viewCommandsRequest())
	if got := commandNames(cmds); code != http.StatusOK || !slices.Equal(got, []string{"build", "ship"}) {
		t.Errorf("view-only in a repo = %d %v", code, cmds)
	}
	// The full list is cached apart from the view-only one.
	code, cmds = getCommands(t, mux, httptest.NewRequest(http.MethodGet, "/api/mux/panes/1/agent/commands", nil))
	if got := commandNames(cmds); code != http.StatusOK || !slices.Equal(got, []string{"build", "notes", "draft", "ship"}) {
		t.Errorf("full in a repo = %d %v", code, cmds)
	}
}
