package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// On Windows "/etc/codex/skills" has no drive, so it is not absolute, but
// opening it would still reach \etc\codex\skills on the current drive.
func TestListCodexSkillsNoAdminDirOnWindows(t *testing.T) {
	if filepath.IsAbs(codexAdminSkills) {
		t.Fatalf("codexAdminSkills %q is absolute on Windows", codexAdminSkills)
	}
	// The same shape that exists: a temp dir without its drive, in slashes.
	admin := t.TempDir()
	writeFile(t, filepath.Join(admin, "org/SKILL.md"), skill("org", "Machine-wide"))
	rooted := filepath.ToSlash(strings.TrimPrefix(admin, filepath.VolumeName(admin)))
	if _, err := os.Stat(filepath.Join(rooted, "org", "SKILL.md")); err != nil {
		t.Skipf("the temp dir is not on the current drive: %v", err)
	}
	useAdminSkills(t, rooted)
	if got := resolvedDir(rooted); got != "" {
		t.Errorf("resolvedDir(%q) = %q, want it refused", rooted, got)
	}
	codexHome := t.TempDir()
	writeFile(t, filepath.Join(codexHome, "skills/mine/SKILL.md"), skill("mine", "User codex"))
	got := listCodexSkills(filesRoot{Root: ""}, codexHome, "", nil).Commands
	if len(got) != 1 || got[0].Name != "mine" {
		t.Errorf("skills = %v, want only the user's", got)
	}
}
