package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// termote skills: the orchestrator skill embedded in the binary, written for
// Claude Code and Codex only when the user runs skills install. Nothing else
// in termote writes to an agent's directory: start, update and the server
// never do. The skill goes in a directory of its own, with a marker file
// that says termote wrote it; a directory of that name without the marker
// is the user's and is never written to or removed.

//go:embed skills/orchestrator/SKILL.md
var orchestratorSkill string

const (
	// skillDirName is the skill's directory under an agent's skills dir.
	skillDirName = "termote-orchestrator"
	// skillMarkerName marks a skill directory termote wrote, with the
	// version that wrote it.
	skillMarkerName = ".termote-skill.json"
)

const skillsUsage = `usage: termote skills install [--agent claude|codex|all]
       termote skills uninstall [--agent claude|codex|all]
       termote skills status [--json]`

// skillAgent is an agent a skill can be installed for.
type skillAgent struct {
	id    string // claude | codex
	label string
	// dir is the agent's config dir (CLAUDE_CONFIG_DIR or ~/.claude,
	// CODEX_HOME or ~/.codex); the skill goes in dir/skills.
	dir string
}

func (a skillAgent) skillDir() string { return filepath.Join(a.dir, "skills", skillDirName) }

// configured reports whether the agent is set up on this machine: its
// config dir exists.
func (a skillAgent) configured() bool { return isDir(a.dir) }

func (c *cli) skillAgents() []skillAgent {
	return []skillAgent{
		{id: "claude", label: "Claude Code", dir: c.envDir("CLAUDE_CONFIG_DIR", filepath.Join(c.home, ".claude"))},
		{id: "codex", label: "Codex", dir: c.envDir("CODEX_HOME", filepath.Join(c.home, ".codex"))},
	}
}

// skillMarker is what the marker file holds.
type skillMarker struct {
	Version string `json:"version"`
}

// installedSkill reads the marker of a's skill: ok when termote wrote the
// directory, exists when anything is at its path.
func installedSkill(a skillAgent) (m skillMarker, ok, exists bool) {
	dir := a.skillDir()
	st, err := os.Lstat(dir)
	if err != nil {
		return m, false, false
	}
	if !st.IsDir() {
		return m, false, true
	}
	b, err := os.ReadFile(filepath.Join(dir, skillMarkerName))
	if err != nil || json.Unmarshal(b, &m) != nil {
		return skillMarker{}, false, true
	}
	return m, true, true
}

func (c *cli) cmdSkills(args []string) error {
	if len(args) == 0 {
		return usageError(skillsUsage)
	}
	switch args[0] {
	case "install":
		return c.skillsInstall(args[1:])
	case "uninstall":
		return c.skillsUninstall(args[1:])
	case "status":
		return c.skillsStatus(args[1:])
	}
	return usageError("unknown skills command: %s\n%s", args[0], skillsUsage)
}

// skillTargets parses --agent: the agents named, or with all (the default)
// every agent set up on this machine.
func (c *cli) skillTargets(name string, args []string) ([]skillAgent, error) {
	agent := "all"
	fs := c.newFlagSet(name)
	fs.StringVar(&agent, "agent", agent, "")
	if pos, err := parseArgs(fs, args); err != nil {
		return nil, flagErr(err)
	} else if len(pos) > 0 {
		return nil, usageError(skillsUsage)
	}
	var out []skillAgent
	for _, a := range c.skillAgents() {
		switch {
		case agent == a.id:
			if !a.configured() {
				return nil, fmt.Errorf("%s is not set up on this machine (no %s)", a.label, a.dir)
			}
			return []skillAgent{a}, nil
		case agent == "all" && a.configured():
			out = append(out, a)
		}
	}
	if agent != "all" {
		return nil, usageError("--agent is claude, codex or all")
	}
	if len(out) == 0 {
		return nil, errors.New("neither Claude Code (~/.claude) nor Codex (~/.codex) is set up on this machine; install one first")
	}
	return out, nil
}

func (c *cli) skillsInstall(args []string) error {
	targets, err := c.skillTargets("skills install", args)
	if err != nil {
		return err
	}
	failed := false
	for _, a := range targets {
		if err := c.installSkill(a); err != nil {
			c.errorf("%s: %v", a.label, err)
			failed = true
			continue
		}
		c.infof("Installed the termote-orchestrator skill v%s for %s: %s", c.version, a.label, a.skillDir())
		if c.termotePluginInstalled(a) {
			c.warnf("%s also has the termote plugin installed, which brings the same skill: keep one of the two (termote skills uninstall --agent %s, or remove the plugin)", a.label, a.id)
		}
	}
	if failed {
		return &exitError{code: 1}
	}
	fmt.Fprintln(c.out, "Start a new session of the agent to load it; ask it to coordinate your termote agents.")
	return nil
}

// installSkill writes a's skill, refusing a directory termote did not write.
func (c *cli) installSkill(a skillAgent) error {
	dir := a.skillDir()
	if _, ok, exists := installedSkill(a); exists && !ok && !emptyDir(dir) {
		return fmt.Errorf("%s exists and termote did not write it; it is left as it is (rename or remove it to install)", dir)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// The marker first: an install cut short leaves a directory termote
	// still knows as its own, which the next install or uninstall finishes.
	marker, _ := json.Marshal(skillMarker{Version: c.version})
	if err := writeFileReplace(filepath.Join(dir, skillMarkerName), append(marker, '\n')); err != nil {
		return err
	}
	return writeFileReplace(filepath.Join(dir, "SKILL.md"), []byte(orchestratorSkill))
}

// emptyDir reports whether dir is a directory (not a link) with nothing in
// it: one termote made and an install left before writing anything.
func emptyDir(dir string) bool {
	st, err := os.Lstat(dir)
	if err != nil || !st.IsDir() {
		return false
	}
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) == 0
}

// skillTempPrefix starts the temporary files writeFileReplace makes.
const skillTempPrefix = ".tmp-termote-"

// writeFileReplace writes data to path through a temporary file renamed
// over it, so an agent never reads half a skill.
func writeFileReplace(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), skillTempPrefix+"*")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmp.Name(), 0o644)
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), path)
	}
	if werr != nil {
		os.Remove(tmp.Name())
	}
	return werr
}

// termotePluginInstalled reports whether a has the termote plugin of the
// termote-plugins marketplace installed, which carries the same skill.
func (c *cli) termotePluginInstalled(a skillAgent) bool {
	var file, needle string
	switch a.id {
	case "claude":
		file, needle = filepath.Join(a.dir, "plugins", "installed_plugins.json"), `"termote@termote"`
	case "codex":
		file, needle = filepath.Join(a.dir, "config.toml"), "termote@termote"
	}
	b, err := os.ReadFile(file)
	return err == nil && strings.Contains(string(b), needle)
}

func (c *cli) skillsUninstall(args []string) error {
	targets, err := c.skillTargets("skills uninstall", args)
	if err != nil {
		return err
	}
	failed := false
	for _, a := range targets {
		_, ok, exists := installedSkill(a)
		switch {
		case !exists:
			c.infof("%s: the termote-orchestrator skill is not installed", a.label)
			continue
		case !ok:
			c.errorf("%s: %s was not written by termote; it is left as it is", a.label, a.skillDir())
			failed = true
			continue
		}
		if err := removeSkill(a.skillDir()); err != nil {
			c.errorf("%s: %v", a.label, err)
			failed = true
			continue
		}
		c.infof("Removed the termote-orchestrator skill for %s", a.label)
	}
	if failed {
		return &exitError{code: 1}
	}
	return nil
}

// removeSkill removes dir, which termote wrote, when it holds only the files
// termote writes there; otherwise it removes nothing, so the directory keeps
// its marker and a later install or uninstall still knows it.
func removeSkill(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if n := e.Name(); n != "SKILL.md" && n != skillMarkerName && !strings.HasPrefix(n, skillTempPrefix) {
			return fmt.Errorf("%s holds files termote did not write (%s); it is left as it is", dir, n)
		}
	}
	// The marker last, so a removal cut short is still termote's to finish.
	for _, e := range entries {
		if n := e.Name(); n != skillMarkerName {
			if err := os.Remove(filepath.Join(dir, n)); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	if err := os.Remove(filepath.Join(dir, skillMarkerName)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Remove(dir)
}

// skillStatus is one agent's line of skills status.
type skillStatus struct {
	Agent      string `json:"agent"`
	Configured bool   `json:"configured"`
	Installed  bool   `json:"installed"`
	// Foreign: a directory of the skill's name that termote did not write.
	Foreign bool   `json:"foreign,omitempty"`
	Path    string `json:"path"`
	Version string `json:"version,omitempty"`
	// Current: the installed SKILL.md is this termote's, the same version
	// and the same text (a checkout's build keeps the version of its last
	// release while the skill changes).
	Current bool `json:"current"`
	// Differs: the version is this termote's but the text is not.
	Differs bool `json:"differs,omitempty"`
	Plugin  bool `json:"plugin"`
}

func (c *cli) skillsStatus(args []string) error {
	asJSON := false
	fs := c.newFlagSet("skills status")
	fs.BoolVar(&asJSON, "json", false, "")
	if pos, err := parseArgs(fs, args); err != nil {
		return flagErr(err)
	} else if len(pos) > 0 {
		return usageError(skillsUsage)
	}
	var rows []skillStatus
	for _, a := range c.skillAgents() {
		m, ok, exists := installedSkill(a)
		sameVersion := ok && m.Version == c.version
		sameText := ok && skillTextCurrent(a)
		rows = append(rows, skillStatus{Agent: a.id, Configured: a.configured(), Installed: ok, Foreign: exists && !ok,
			Path: a.skillDir(), Version: m.Version, Current: sameVersion && sameText, Differs: sameVersion && !sameText,
			Plugin: c.termotePluginInstalled(a)})
	}
	if asJSON {
		return writeJSON(c.out, map[string]any{"version": c.version, "agents": rows})
	}
	for i, r := range rows {
		label := c.skillAgents()[i].label
		switch {
		case !r.Configured:
			fmt.Fprintf(c.out, "%s: not set up on this machine\n", label)
		case r.Foreign:
			fmt.Fprintf(c.out, "%s: %s exists but termote did not write it\n", label, r.Path)
		case !r.Installed:
			fmt.Fprintf(c.out, "%s: not installed (termote skills install --agent %s)\n", label, r.Agent)
		case r.Current:
			fmt.Fprintf(c.out, "%s: v%s installed, matches this termote (%s)\n", label, r.Version, r.Path)
		case r.Differs:
			fmt.Fprintf(c.out, "%s: v%s installed, but its SKILL.md is not the one this termote carries; update it: termote skills install --agent %s\n", label, r.Version, r.Agent)
		default:
			fmt.Fprintf(c.out, "%s: v%s installed, this termote is v%s; update it: termote skills install --agent %s\n", label, r.Version, c.version, r.Agent)
		}
		if r.Plugin {
			fmt.Fprintf(c.out, "  the termote plugin is installed for %s too\n", label)
		}
	}
	return nil
}

// skillTextCurrent: a's installed SKILL.md is the one embedded in this
// binary, read up to a limit (a regular file only, never through a link).
func skillTextCurrent(a skillAgent) bool {
	path := filepath.Join(a.skillDir(), "SKILL.md")
	st, err := os.Lstat(path)
	if err != nil || !st.Mode().IsRegular() || st.Size() != int64(len(orchestratorSkill)) {
		return false
	}
	b, err := os.ReadFile(path)
	return err == nil && string(b) == orchestratorSkill
}

// skillUpdateHint, after an update to version, names each agent whose
// installed skill termote wrote for another version. It prints nothing when
// no skill was installed.
func (c *cli) skillUpdateHint(version string) {
	for _, a := range c.skillAgents() {
		if m, ok, _ := installedSkill(a); ok && m.Version != version {
			c.infof("The termote-orchestrator skill for %s is v%s; update it: termote skills install --agent %s", a.label, m.Version, a.id)
		}
	}
}
