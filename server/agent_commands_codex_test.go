package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// useAdminSkills points codexAdminSkills at dir for one test.
func useAdminSkills(t *testing.T, dir string) {
	t.Helper()
	old := codexAdminSkills
	codexAdminSkills = dir
	t.Cleanup(func() { codexAdminSkills = old })
}

func skill(name, desc string) string {
	return "---\nname: " + name + "\ndescription: " + desc + "\n---\nSECRET BODY"
}

func TestListCodexSkills(t *testing.T) {
	root, codexHome, home, admin := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	useAdminSkills(t, admin)
	writeFile(t, filepath.Join(root, ".codex/skills/proj/SKILL.md"), skill("proj", "Project codex"))
	writeFile(t, filepath.Join(root, ".agents/skills/shared/SKILL.md"), skill("shared", "Project agents"))
	writeFile(t, filepath.Join(root, ".agents/skills/hidden/SKILL.md"), "---\nuser-invocable: false\n---\n")
	writeFile(t, filepath.Join(root, ".claude/skills/claude-only/SKILL.md"), skill("claude-only", "Not Codex's"))
	writeFile(t, filepath.Join(codexHome, "skills/mine/SKILL.md"), skill("mine", "User codex"))
	writeFile(t, filepath.Join(codexHome, "skills/proj/SKILL.md"), skill("proj", "Shadowed by the project's"))
	writeFile(t, filepath.Join(codexHome, "skills/.system/imagegen/SKILL.md"), skill("imagegen", "Bundled"))
	writeFile(t, filepath.Join(codexHome, "prompts/old.md"), "custom prompts are gone from Codex")
	writeFile(t, filepath.Join(home, ".agents/skills/ak-debug/SKILL.md"), skill("ak:debug", "From a skill manager"))
	writeFile(t, filepath.Join(home, ".agents/skills/mine/SKILL.md"), skill("mine", "Shadowed"))
	writeFile(t, filepath.Join(admin, "org/SKILL.md"), skill("org", "Machine-wide"))
	writeFile(t, filepath.Join(admin, "imagegen/SKILL.md"), skill("imagegen", "Shadowed"))

	got := listCodexSkills(root, codexHome, home, nil).Commands
	want := []agentCommand{
		{"proj", "Project codex", "project", "skill"},
		{"shared", "Project agents", "project", "skill"},
		{"mine", "User codex", "user", "skill"},
		{"ak:debug", "From a skill manager", "user", "skill"},
		{"imagegen", "Bundled", "system", "skill"},
		{"org", "Machine-wide", "system", "skill"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("skills =\n%v\nwant\n%v", got, want)
	}
	for _, c := range got {
		if strings.Contains(c.Description, "SECRET") {
			t.Errorf("a skill body leaked: %+v", c)
		}
	}

	// No Codex home, no pane root: home's and the machine's only.
	got = listCodexSkills("", "", home, nil).Commands
	if len(got) != 4 || got[0].Name != "ak:debug" || got[3].Name != "org" {
		t.Errorf("no codex home = %v", got)
	}
	// Nothing at all: an empty list, never null.
	useAdminSkills(t, "")
	if got := listCodexSkills("", "", "", nil).Commands; got == nil || len(got) != 0 {
		t.Errorf("no dirs = %#v", got)
	}
	// A Codex home that is gone.
	if got := listCodexSkills("", filepath.Join(codexHome, "gone"), "", nil).Commands; len(got) != 0 {
		t.Errorf("missing codex home = %v", got)
	}
	// A path that is not absolute (the Unix one on Windows) is never opened.
	useAdminSkills(t, "etc/codex/skills")
	if got := listCodexSkills("", "relative", "", nil).Commands; len(got) != 0 {
		t.Errorf("relative dirs = %v", got)
	}
}

func TestListCodexSkillsSkip(t *testing.T) {
	root, codexHome := t.TempDir(), t.TempDir()
	useAdminSkills(t, "")
	writeFile(t, filepath.Join(root, ".codex/skills/denied/SKILL.md"), skill("denied", "x"))
	writeFile(t, filepath.Join(root, ".agents/skills/ok/SKILL.md"), skill("ok", "fine"))
	writeFile(t, filepath.Join(codexHome, "skills/id_rsa/SKILL.md"), skill("key", "refused by name"))
	var asked []string
	skip := func(dir, rel string) bool {
		asked = append(asked, rel)
		return rel == filepath.FromSlash(".codex/skills") || strings.Contains(rel, "id_rsa")
	}
	got := listCodexSkills(root, codexHome, "", skip).Commands
	if len(got) != 1 || got[0].Name != "ok" {
		t.Fatalf("skills = %v", got)
	}
	// A denied dir is not opened at all.
	for _, rel := range asked {
		if strings.HasPrefix(rel, filepath.FromSlash(".codex/skills/")) {
			t.Errorf("read under a denied dir: %s", rel)
		}
	}
}

func TestListCodexSkillsSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	root, codexHome, home, outside := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	useAdminSkills(t, "")
	writeFile(t, filepath.Join(outside, "out/SKILL.md"), skill("out", "outside"))
	writeFile(t, filepath.Join(home, ".agents/skills/managed/SKILL.md"), skill("managed", "installed by a manager"))
	writeFile(t, filepath.Join(root, "shared/real/SKILL.md"), skill("real", "x"))
	os.MkdirAll(filepath.Join(codexHome, "skills"), 0o755)
	os.MkdirAll(filepath.Join(root, ".codex/skills/linkfile"), 0o755)
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.Symlink(filepath.Join(outside, "out"), filepath.Join(codexHome, "skills/out")))
	// Skill managers link a skill dir from ~/.agents/skills: followed.
	must(os.Symlink(filepath.Join(home, ".agents/skills/managed"), filepath.Join(codexHome, "skills/linked")))
	// A SKILL.md that is itself a symlink is never read.
	must(os.Symlink(filepath.Join(root, "shared/real/SKILL.md"), filepath.Join(root, ".codex/skills/linkfile/SKILL.md")))

	got := listCodexSkills(root, codexHome, home, nil).Commands
	want := []agentCommand{{"managed", "installed by a manager", "user", "skill"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("skills = %v, want %v", got, want)
	}
}

func TestCommandsRouteCodex(t *testing.T) {
	root, codexHome, home := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	useAdminSkills(t, "")
	writeFile(t, filepath.Join(root, ".codex/skills/proj/SKILL.md"), skill("proj", "Project one"))
	writeFile(t, filepath.Join(root, ".claude/commands/claude.md"), "Claude Code's, not Codex's")
	writeFile(t, filepath.Join(codexHome, "skills/usr/SKILL.md"), skill("usr", "User one"))
	writeFile(t, filepath.Join(codexHome, "skills/.system/sys/SKILL.md"), skill("sys", "System one"))
	writeFile(t, filepath.Join(home, ".agents/skills/agent/SKILL.md"), skill("agent", "Home one"))
	s := AgentSession{Agent: "codex", ID: testCodexID, CodexHome: codexHome}
	path := "/api/mux/panes/1/agent/commands"

	code, cmds := getCommands(t, commandsServer(t, s, true, root, true), httptest.NewRequest(http.MethodGet, path, nil))
	got := ""
	for _, c := range cmds {
		got += c.Source + ":" + c.Name + " "
	}
	if code != http.StatusOK || got != "project:proj user:usr user:agent system:sys " {
		t.Fatalf("GET = %d %q", code, got)
	}

	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if code, _ := getCommands(t, commandsServer(t, s, true, root, true), req); code != http.StatusForbidden {
		t.Errorf("cross-site = %d", code)
	}

	// Without a pane root, the user's and the system's.
	code, cmds = getCommands(t, commandsServer(t, s, true, root, false), httptest.NewRequest(http.MethodGet, path, nil))
	if code != http.StatusOK || len(cmds) != 3 || cmds[0].Name != "usr" {
		t.Errorf("no files caps = %d %v", code, cmds)
	}

	// Another agent: nothing is read.
	other := AgentSession{Agent: "other", ID: testCodexID, ClaudeDir: codexHome, CodexHome: codexHome}
	code, cmds = getCommands(t, commandsServer(t, other, true, root, true), httptest.NewRequest(http.MethodGet, path, nil))
	if code != http.StatusOK || cmds == nil || len(cmds) != 0 {
		t.Errorf("other agent = %d %v", code, cmds)
	}
}
