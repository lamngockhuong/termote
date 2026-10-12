package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// mklinkJ makes a directory junction at link to target (no admin needed).
func mklinkJ(t *testing.T, link, target string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J %s %s: %v %s", link, target, err, out)
	}
}

func TestIsJunctionTag(t *testing.T) {
	const dirReparse = windows.FILE_ATTRIBUTE_DIRECTORY | windows.FILE_ATTRIBUTE_REPARSE_POINT
	cases := []struct {
		attrs, tag uint32
		want       bool
	}{
		{dirReparse, windows.IO_REPARSE_TAG_MOUNT_POINT, true},
		{dirReparse, windows.IO_REPARSE_TAG_SYMLINK, false},
		{dirReparse, 0x8000001B, false}, // app exec link
		{dirReparse, 0x9000001A, false}, // cloud files
		{dirReparse, 0xA000001D, false}, // WSL symlink
		{dirReparse, 0x80000013, false}, // dedup
		{dirReparse, 0, false},
		{windows.FILE_ATTRIBUTE_REPARSE_POINT, windows.IO_REPARSE_TAG_MOUNT_POINT, false}, // not a directory
		{windows.FILE_ATTRIBUTE_DIRECTORY, windows.IO_REPARSE_TAG_MOUNT_POINT, false},     // not a reparse point
	}
	for _, c := range cases {
		if got := isJunctionTag(c.attrs, c.tag); got != c.want {
			t.Errorf("isJunctionTag(%#x, %#x) = %v, want %v", c.attrs, c.tag, got, c.want)
		}
	}
}

func TestIsJunction(t *testing.T) {
	d := t.TempDir()
	os.MkdirAll(filepath.Join(d, "target"), 0o755)
	mklinkJ(t, filepath.Join(d, "j"), filepath.Join(d, "target"))
	mklinkJ(t, filepath.Join(d, "missing"), filepath.Join(d, "nope"))
	writeFile(t, filepath.Join(d, "file"), "x")
	if !isJunction(filepath.Join(d, "j")) {
		t.Error("junction not recognised")
	}
	// The tag says junction; resolveLinkedDir then refuses the missing target.
	if !isJunction(filepath.Join(d, "missing")) {
		t.Error("junction to a missing target not recognised")
	}
	if _, err := resolveLinkedDir(filepath.Join(d, "missing")); err == nil {
		t.Error("missing target resolved")
	}
	for _, p := range []string{filepath.Join(d, "target"), filepath.Join(d, "file"), filepath.Join(d, "none"), `\\localhost\c$\x`, `\\?\C:\x`, `\\.\pipe\x`, "relative"} {
		if isJunction(p) {
			t.Errorf("isJunction(%q) = true", p)
		}
	}
	got, err := resolveLinkedDir(filepath.Join(d, "j"))
	want, _ := filepath.EvalSymlinks(filepath.Join(d, "target"))
	if err != nil || got != want {
		t.Errorf("resolveLinkedDir = %q %v, want %q", got, err, want)
	}
	if _, err := resolveLinkedDir(filepath.Join(d, "file")); err == nil {
		t.Error("a file resolved as a skill dir")
	}
	for _, p := range []string{`\\localhost\c$`, `\\?\UNC\localhost\c$`, `\\.\C:`} {
		if _, err := resolveLinkedDir(p); err == nil {
			t.Errorf("resolveLinkedDir(%q) accepted", p)
		}
	}
}

func TestListAgentCommandsJunctions(t *testing.T) {
	root, claudeReal, home, outside := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(outside, "skill/SKILL.md"), "---\ndescription: outside skill\n---\n")
	writeFile(t, filepath.Join(outside, "secret.md"), "---\ndescription: outside\n---\n")
	writeFile(t, filepath.Join(root, "shared/inside/SKILL.md"), "---\ndescription: inside skill\n---\n")
	writeFile(t, filepath.Join(home, ".agents/skills/managed/SKILL.md"), "---\ndescription: managed\n---\n")
	writeFile(t, filepath.Join(claudeReal, "shared/mine/SKILL.md"), "---\ndescription: mine\n---\n")
	os.MkdirAll(filepath.Join(root, ".claude/skills"), 0o755)
	os.MkdirAll(filepath.Join(claudeReal, "skills"), 0o755)

	// Followed: into the root, ~/.agents/skills, and the Claude dir whose
	// own path is a junction (the allowed dir is reached through it).
	mklinkJ(t, filepath.Join(root, ".claude/skills/in"), filepath.Join(root, "shared/inside"))
	mklinkJ(t, filepath.Join(claudeReal, "skills/managed"), filepath.Join(home, ".agents/skills/managed"))
	claude := filepath.Join(t.TempDir(), "claude-link")
	mklinkJ(t, claude, claudeReal)
	mklinkJ(t, filepath.Join(claudeReal, "skills/mine"), filepath.Join(claudeReal, "shared/mine"))
	// Not followed: outside every allowed dir, a missing target, a path that
	// reads as inside the root but leaves it through another junction, and
	// a junction in commands/ (dirs there are never followed).
	mklinkJ(t, filepath.Join(root, ".claude/skills/out"), filepath.Join(outside, "skill"))
	mklinkJ(t, filepath.Join(root, ".claude/skills/gone"), filepath.Join(root, "nope"))
	mklinkJ(t, filepath.Join(root, "escape"), outside)
	mklinkJ(t, filepath.Join(root, ".claude/skills/esc"), filepath.Join(root, "escape/skill"))
	mklinkJ(t, filepath.Join(root, ".claude/commands/dir"), outside)

	got := listAgentCommands(root, claude, home, nil).Commands
	want := []agentCommand{
		{"in", "inside skill", "project", "skill"},
		{"managed", "managed", "user", "skill"},
		{"mine", "mine", "user", "skill"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("commands =\n%v\nwant\n%v", got, want)
	}
}

func TestListAgentCommandsJunctionSkip(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "shared/s/SKILL.md"), "x")
	mklinkJ(t, filepath.Join(root, ".claude/skills/s"), filepath.Join(root, "shared/s"))
	// skip sees the resolved target from the allowed dir holding it.
	var seen []string
	skip := func(dir, rel string) bool {
		seen = append(seen, rel)
		return rel == filepath.Join("shared", "s", "SKILL.md")
	}
	if got := listAgentCommands(root, "", "", skip).Commands; len(got) != 0 {
		t.Fatalf("skipped skill listed: %v (skip saw %v)", got, seen)
	}
}

func TestListCodexSkillsJunctions(t *testing.T) {
	root, codexHome, home, outside := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	useAdminSkills(t, "")
	writeFile(t, filepath.Join(outside, "out/SKILL.md"), skill("out", "outside"))
	writeFile(t, filepath.Join(home, ".agents/skills/managed/SKILL.md"), skill("managed", "installed by a manager"))
	writeFile(t, filepath.Join(root, "shared/real/SKILL.md"), skill("real", "in the project"))
	mklinkJ(t, filepath.Join(codexHome, "skills/out"), filepath.Join(outside, "out"))
	mklinkJ(t, filepath.Join(codexHome, "skills/linked"), filepath.Join(home, ".agents/skills/managed"))
	mklinkJ(t, filepath.Join(codexHome, "skills/gone"), filepath.Join(codexHome, "nope"))
	mklinkJ(t, filepath.Join(root, ".codex/skills/proj"), filepath.Join(root, "shared/real"))

	got := listCodexSkills(root, codexHome, home, nil).Commands
	want := []agentCommand{
		{"real", "in the project", "project", "skill"},
		{"managed", "installed by a manager", "user", "skill"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("skills =\n%v\nwant\n%v", got, want)
	}
}

func TestListAgentCommandsPluginJunctions(t *testing.T) {
	claude, outside := t.TempDir(), t.TempDir()
	cache := filepath.Join(claude, "plugins/cache/m")
	writeFile(t, filepath.Join(cache, "inside/1.0.0/commands/c.md"), "inside command")
	writeFile(t, filepath.Join(outside, "commands/c.md"), "outside command")
	// An installPath through a junction counts where the junction leads:
	// inside <claudeDir>/plugins it is read, outside it is not.
	mklinkJ(t, filepath.Join(cache, "in-link"), filepath.Join(cache, "inside/1.0.0"))
	mklinkJ(t, filepath.Join(cache, "esc"), outside)
	writePlugins(t, claude, map[string][]pluginInstall{
		"inside@m": {{InstallPath: filepath.Join(cache, "in-link")}},
		"esc@m":    {{InstallPath: filepath.Join(cache, "esc")}},
	})
	writeEnabled(t, filepath.Join(claude, "settings.json"), map[string]any{"inside@m": true, "esc@m": true})

	got := listAgentCommands("", claude, "", nil).Commands
	want := []agentCommand{{"inside:c", "inside command", "plugin", "command"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("commands = %v, want %v", got, want)
	}
}
