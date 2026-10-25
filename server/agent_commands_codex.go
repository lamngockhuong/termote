package main

import (
	"path"
	"path/filepath"
	"strings"
)

// codexAdminSkills is the machine-wide skill dir Codex reads on Unix; the
// path is not absolute on Windows, so it is never opened there.
var codexAdminSkills = "/etc/codex/skills"

// codexProjectMaxDirs caps the dirs from the repo root down to the pane's
// whose skill dirs are read.
const codexProjectMaxDirs = 32

// codexSource is one skill root of a Codex pane: rel under dir.
type codexSource struct {
	dir, rel, source string
	real             string // dir/rel resolved
	o                codexWalkOpts
}

// listCodexSkills reads the skills Codex 0.164.0 offers after "$"
// (codex-rs/ext/skills/src/host_roots.rs, host_service.rs), each root walked
// as Codex walks it (walkCodexSkills):
//
//   - the project's: .codex/skills and .agents/skills of every dir from the
//     repo root down to the pane's directory (pr.Dir), whether Codex trusts
//     the project or not; outside a repo, of the pane's directory only;
//   - the user's: codexHome/skills and home's ~/.agents/skills;
//   - the system ones: codexHome/skills/.system (unless [skills.bundled] turns
//     them off) and codexAdminSkills;
//   - those of the plugins config.toml enables (readCodexPluginSkills).
//
// Skills [[skills.config]] turns off are dropped first, by path, so that
// another skill of the same name still shows. Codex keeps every skill of a
// name; Termote keeps one, the first met in this order: the repo root's, the
// user's, the system ones, then the dirs below the repo root, top down, so
// that a dir further down (a vendored dependency) cannot stand in for a skill
// of the repo or of the user. A plugin's skill wins over any other of its name.
// Codex has no custom "/" commands. skip refuses a file by its dir and path,
// as for Claude Code.
func listCodexSkills(pr filesRoot, codexHome, home string, skip func(dir, rel string) bool) commandsResponse {
	deadline := codexNow().Add(codexSkillDeadline)
	agents := ""
	if home != "" {
		agents = filepath.Join(home, ".agents", "skills")
	}
	rootReal := resolvedDir(pr.Root)
	homeReal := resolvedDir(home)
	codexReal := resolvedDir(codexHome)
	deny := []string{
		resolvedDir(filepath.Join(codexHome, "plugins")),
		resolvedDir(filepath.Join(codexHome, "skills", ".system")),
	}
	userAllow := []string{resolvedDir(filepath.Join(codexHome, "skills")), resolvedDir(agents)}
	project := codexWalkOpts{source: "project", recursive: true, allow: []string{rootReal}, deny: deny,
		stop: rootReal, within: rootReal, skip: skip, budget: &codexBudget{deadline: deadline}}
	user := func(stop string) codexWalkOpts {
		return codexWalkOpts{source: "user", recursive: true, allow: userAllow, deny: deny, stop: stop,
			skip: skip, budget: &codexBudget{deadline: deadline}}
	}
	system := codexWalkOpts{source: "system", recursive: true, stop: codexReal, skip: skip,
		budget: &codexBudget{deadline: deadline}}
	adminReal := resolvedDir(codexAdminSkills)
	admin := codexWalkOpts{source: "system", recursive: true, allow: []string{adminReal}, deny: deny,
		stop: filepath.Dir(adminReal), skip: skip, budget: &codexBudget{deadline: deadline}}

	chain := codexProjectChain(pr)
	var sources []codexSource
	add := func(dir, rel string, o codexWalkOpts) {
		if dir != "" {
			sources = append(sources, codexSource{dir: dir, rel: rel, source: o.source, o: o})
		}
	}
	if len(chain) > 0 {
		add(pr.Root, ".codex/skills", project)
		add(pr.Root, ".agents/skills", project)
	}
	add(codexHome, "skills", user(codexReal))
	add(home, ".agents/skills", user(homeReal))
	add(codexHome, "skills/.system", system)
	add(codexAdminSkills, ".", admin)
	for _, rel := range chain[min(1, len(chain)):] {
		add(pr.Root, path.Join(rel, ".codex/skills"), project)
		add(pr.Root, path.Join(rel, ".agents/skills"), project)
	}

	// A project dir that is also the user's (the pane in home, a .codex that
	// is CODEX_HOME) is read once, as the user's.
	others := map[string]bool{}
	var bases []string
	for i := range sources {
		s := &sources[i]
		s.real = resolvedDir(filepath.Join(s.dir, filepath.FromSlash(s.rel)))
		if s.real != "" {
			// The dir as named too: a rule's path names it through its links
			// (a symlinked CODEX_HOME, /home on Fedora Atomic).
			bases = append(bases, s.real, filepath.Join(s.dir, filepath.FromSlash(s.rel)))
			if s.source != "project" {
				others[s.real] = true
			}
		}
	}
	cfg := readCodexConfig(codexHome)
	if codexHome != "" {
		cache := filepath.Join(codexHome, "plugins", "cache")
		bases = append(bases, resolvedDir(cache), cache)
	}
	rules, bundled := codexSkillsConfig(cfg, codexHome, home, bases)

	var all []codexSkill
	for _, s := range sources {
		if s.real == "" || (s.source == "project" && others[s.real]) || (!bundled && s.o.source == "system" && s.dir == codexHome) {
			continue
		}
		all = append(all, walkCodexSkills(s.dir, s.rel, s.o)...)
	}
	nonPlugin := len(all)
	all = append(all, readCodexPluginSkills(cfg, codexHome, skip, deadline)...)
	off := rules.disabled(all)

	// The plugins' skills first, so that a name kept for one is listed.
	seen := map[string]bool{}
	var plugins []agentCommand
	for i := nonPlugin; i < len(all) && len(plugins) < codexSkillMaxTotal; i++ {
		if s := all[i]; !off[i] && !seen[s.cmd.Name] {
			seen[s.cmd.Name] = true
			plugins = append(plugins, s.cmd)
		}
	}
	cmds := []agentCommand{}
	for i, s := range all[:nonPlugin] {
		if len(cmds)+len(plugins) == codexSkillMaxTotal {
			break
		}
		if !off[i] && !seen[s.cmd.Name] {
			seen[s.cmd.Name] = true
			cmds = append(cmds, s.cmd)
		}
	}
	return commandsResponse{Commands: append(cmds, plugins...)}
}

// codexProjectChain returns the dirs, relative to pr.Root and slash-separated,
// whose skill dirs are the project's: "" (the root), then each dir down to
// the pane's directory when the root is a repo holding it; at most
// codexProjectMaxDirs, the root and the deepest kept. A dir inside the repo's
// git directory, or with a .git on its path, is never one. Without a root,
// none.
func codexProjectChain(pr filesRoot) []string {
	root := resolvedDir(pr.Root)
	if root == "" {
		return nil
	}
	chain := []string{""}
	dir := resolvedDir(pr.Dir)
	if !pr.IsRepo || dir == "" || !pathWithin(root, dir) {
		return chain
	}
	if git := resolvedDir(pr.GitDir); git != "" && (dir == git || pathWithin(git, dir)) {
		return chain
	}
	rel, err := filepath.Rel(root, dir)
	if err != nil {
		return chain
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	for i := range parts {
		if parts[i] == ".git" {
			return chain
		}
		chain = append(chain, strings.Join(parts[:i+1], "/"))
	}
	if len(chain) > codexProjectMaxDirs {
		chain = append([]string{""}, chain[len(chain)-codexProjectMaxDirs+1:]...)
	}
	return chain
}
