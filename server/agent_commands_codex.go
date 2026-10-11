package main

import (
	"path/filepath"
)

// codexAdminSkills is the machine-wide skill dir Codex reads on Unix; the
// path is not absolute on Windows, so it is never opened there.
var codexAdminSkills = "/etc/codex/skills"

// listCodexSkills reads the skills Codex 0.162.0 offers after "$"
// (codex-rs/ext/skills/src/host_roots.rs), in its order: the project's
// (root/.codex/skills, root/.agents/skills), the user's (codexHome/skills,
// home's ~/.agents/skills), then the system ones (codexHome/skills/.system,
// shipped with Codex, and codexAdminSkills). Any dir may be empty. A name met
// twice keeps its first entry. Codex has no custom "/" commands; plugin
// skills, skills turned off in config.toml and the trust Codex needs before it
// loads a project's skills are not looked at, and only one level of skill
// dirs is read. A symlinked skill dir is followed into codexHome, root, home's
// ~/.agents/skills or codexAdminSkills. skip refuses a file by its dir and
// path, as for Claude Code.
func listCodexSkills(root, codexHome, home string, skip func(dir, rel string) bool) commandsResponse {
	agents := ""
	if home != "" {
		agents = filepath.Join(home, ".agents", "skills")
	}
	var allow []string
	for _, d := range []string{codexHome, root, agents, codexAdminSkills} {
		if real := resolvedDir(d); real != "" {
			allow = append(allow, real)
		}
	}
	dirs := []struct{ dir, rel, source string }{
		{root, ".codex/skills", "project"},
		{root, ".agents/skills", "project"},
		{codexHome, "skills", "user"},
		{home, ".agents/skills", "user"},
		{codexHome, "skills/.system", "system"},
		{codexAdminSkills, ".", "system"},
	}
	seen := map[string]bool{}
	cmds := []agentCommand{}
	for _, d := range dirs {
		if d.dir == "" || (skip != nil && skip(d.dir, filepath.FromSlash(d.rel))) {
			continue
		}
		for _, c := range readSkillDir(d.dir, d.rel, commandOpts{source: d.source, allow: allow, skip: skip}) {
			if !seen[c.Name] {
				seen[c.Name] = true
				cmds = append(cmds, c)
			}
		}
	}
	return commandsResponse{Commands: cmds}
}
