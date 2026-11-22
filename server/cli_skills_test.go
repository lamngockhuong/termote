package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func skillsCLI(t *testing.T, agents ...string) *testCLI {
	t.Helper()
	tc := newTestCLI(t, runtime.GOOS)
	for _, a := range agents {
		if err := os.MkdirAll(filepath.Join(tc.home, "."+a), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return tc
}

func claudeSkillDir(tc *testCLI) string {
	return filepath.Join(tc.home, ".claude", "skills", skillDirName)
}

func codexSkillDir(tc *testCLI) string {
	return filepath.Join(tc.home, ".codex", "skills", skillDirName)
}

func TestSkillsInstallForEveryAgentSetUp(t *testing.T) {
	tc := skillsCLI(t, "claude", "codex")
	if err := tc.dispatch("skills", []string{"install"}); err != nil {
		t.Fatalf("%v (%s)", err, tc.stderr)
	}
	for _, dir := range []string{claudeSkillDir(tc), codexSkillDir(tc)} {
		if b := mustRead(t, filepath.Join(dir, "SKILL.md")); string(b) != orchestratorSkill {
			t.Errorf("%s: skill %q", dir, b[:min(len(b), 40)])
		}
		var m skillMarker
		if json.Unmarshal(mustRead(t, filepath.Join(dir, skillMarkerName)), &m) != nil || m.Version != "1.0.0" {
			t.Errorf("%s: marker %+v", dir, m)
		}
		if leftovers, _ := filepath.Glob(filepath.Join(dir, ".tmp-termote-*")); len(leftovers) != 0 {
			t.Errorf("temporary files left: %v", leftovers)
		}
	}
	if !strings.Contains(tc.stdout.String(), "for Claude Code") || !strings.Contains(tc.stdout.String(), "for Codex") {
		t.Errorf("out %s", tc.stdout)
	}
	// Again, from a newer binary: replaced.
	tc.version = "1.1.0"
	if err := tc.dispatch("skills", []string{"install", "--agent", "codex"}); err != nil {
		t.Fatal(err)
	}
	m, ok, _ := installedSkill(tc.skillAgents()[1])
	if !ok || m.Version != "1.1.0" {
		t.Errorf("reinstall: %+v %v", m, ok)
	}
}

// The skill frontmatter names the skill and says when to use it.
func TestOrchestratorSkillContent(t *testing.T) {
	if !strings.HasPrefix(orchestratorSkill, "---\nname: termote-orchestrator\ndescription: ") {
		t.Fatalf("frontmatter: %q", orchestratorSkill[:min(len(orchestratorSkill), 80)])
	}
	for _, want := range []string{"termote agents list", "termote update", "show-password", "One pane at a time", "yes"} {
		if !strings.Contains(orchestratorSkill, want) {
			t.Errorf("the skill lost %q", want)
		}
	}
}

// Every termote command and flag the skill runs exists, as for the agent
// guide.
func TestOrchestratorSkillCommandsExist(t *testing.T) {
	tc := newTestCLI(t, runtime.GOOS)
	tc.printHelp()
	help := tc.stdout.String()
	cmds := helpCommands(help)
	found := guideInvocations(orchestratorSkill)
	if len(found) < 3 {
		t.Fatalf("too few commands in the skill: %v", found)
	}
	for cmd, flags := range found {
		if !cmds[cmd] {
			t.Errorf("the skill runs termote %s, which help does not list", cmd)
		}
		for _, f := range flags {
			if !strings.Contains(help, f) {
				t.Errorf("the skill passes %s to termote %s, which help does not list", f, cmd)
			}
		}
	}
}

func TestSkillsInstallOnlyWhereSetUp(t *testing.T) {
	tc := skillsCLI(t, "claude")
	if err := tc.dispatch("skills", []string{"install"}); err != nil {
		t.Fatal(err)
	}
	if isDir(filepath.Join(tc.home, ".codex")) {
		t.Error("install made ~/.codex")
	}
	if err := tc.dispatch("skills", []string{"install", "--agent", "codex"}); err == nil || !strings.Contains(err.Error(), "Codex is not set up") {
		t.Errorf("codex: %v", err)
	}
	none := skillsCLI(t)
	if err := none.dispatch("skills", []string{"install"}); err == nil || !strings.Contains(err.Error(), "neither Claude Code") {
		t.Errorf("none: %v", err)
	}
	if err := none.dispatch("skills", []string{"install", "--agent", "vim"}); exitCode(err) != 2 {
		t.Errorf("bad agent: %v", err)
	}
	for _, args := range [][]string{nil, {"bogus"}, {"install", "extra"}, {"status", "x"}} {
		if err := none.dispatch("skills", args); exitCode(err) != 2 {
			t.Errorf("%v: %v", args, err)
		}
	}
}

// The agents' own directories are honoured.
func TestSkillsConfigDirsFromEnv(t *testing.T) {
	tc := skillsCLI(t)
	claude, codex := filepath.Join(tc.home, "cc"), filepath.Join(tc.home, "cx")
	os.MkdirAll(claude, 0o755)
	os.MkdirAll(codex, 0o755)
	tc.env["CLAUDE_CONFIG_DIR"], tc.env["CODEX_HOME"] = claude, codex
	if err := tc.dispatch("skills", []string{"install"}); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{claude, codex} {
		if !fileExists(filepath.Join(d, "skills", skillDirName, "SKILL.md")) {
			t.Errorf("no skill in %s", d)
		}
	}
}

// A directory of the same name the user made is never written to or
// removed.
func TestSkillsLeaveTheUsersDirectory(t *testing.T) {
	tc := skillsCLI(t, "claude", "codex")
	mine := filepath.Join(claudeSkillDir(tc), "SKILL.md")
	writeFile(t, mine, "my own")
	err := tc.dispatch("skills", []string{"install"})
	if exitCode(err) != 1 || !strings.Contains(tc.stderr.String(), "termote did not write it") {
		t.Errorf("install: %v %s", err, tc.stderr)
	}
	if string(mustRead(t, mine)) != "my own" || !fileExists(filepath.Join(codexSkillDir(tc), "SKILL.md")) {
		t.Error("install wrote over the user's skill, or skipped Codex")
	}
	tc.stdout.Reset()
	if err := tc.dispatch("skills", []string{"status"}); err != nil || !strings.Contains(tc.stdout.String(), "exists but termote did not write it") {
		t.Errorf("status: %v %s", err, tc.stdout)
	}
	if err := tc.dispatch("skills", []string{"uninstall"}); exitCode(err) != 1 || string(mustRead(t, mine)) != "my own" {
		t.Errorf("uninstall: %v", err)
	}
	if fileExists(codexSkillDir(tc)) {
		t.Error("uninstall left Codex's skill")
	}
	// A file where the directory goes is not ours either.
	os.RemoveAll(claudeSkillDir(tc))
	writeFile(t, claudeSkillDir(tc), "a file")
	if err := tc.dispatch("skills", []string{"install", "--agent", "claude"}); exitCode(err) != 1 {
		t.Errorf("file in the way: %v", err)
	}
}

func TestSkillsUninstall(t *testing.T) {
	tc := skillsCLI(t, "claude")
	if err := tc.dispatch("skills", []string{"uninstall"}); err != nil || !strings.Contains(tc.stdout.String(), "not installed") {
		t.Errorf("nothing installed: %v %s", err, tc.stdout)
	}
	if err := tc.dispatch("skills", []string{"install"}); err != nil {
		t.Fatal(err)
	}
	// A file the user added stays, with the directory.
	extra := filepath.Join(claudeSkillDir(tc), "notes.md")
	writeFile(t, extra, "keep")
	if err := tc.dispatch("skills", []string{"uninstall"}); exitCode(err) != 1 || !fileExists(extra) || !fileExists(filepath.Join(claudeSkillDir(tc), skillMarkerName)) {
		t.Errorf("with an extra file: %v", err)
	}
	os.Remove(extra)
	tc.dispatch("skills", []string{"install"})
	tc.stdout.Reset()
	if err := tc.dispatch("skills", []string{"uninstall", "--agent", "claude"}); err != nil || fileExists(claudeSkillDir(tc)) || !strings.Contains(tc.stdout.String(), "Removed") {
		t.Errorf("uninstall: %v %s", err, tc.stdout)
	}
}

func TestSkillsStatus(t *testing.T) {
	tc := skillsCLI(t, "claude", "codex")
	tc.dispatch("skills", []string{"install", "--agent", "claude"})
	writeFile(t, filepath.Join(tc.home, ".codex", "config.toml"), "[plugins.\"termote@termote\"]\nenabled = true\n")
	tc.stdout.Reset()
	if err := tc.dispatch("skills", []string{"status"}); err != nil {
		t.Fatal(err)
	}
	out := tc.stdout.String()
	if !strings.Contains(out, "Claude Code: v1.0.0 installed, matches") || !strings.Contains(out, "Codex: not installed") || !strings.Contains(out, "plugin is installed for Codex") {
		t.Errorf("status:\n%s", out)
	}
	tc.version = "1.2.0"
	tc.stdout.Reset()
	tc.dispatch("skills", []string{"status", "--json"})
	var st struct {
		Version string        `json:"version"`
		Agents  []skillStatus `json:"agents"`
	}
	if err := json.Unmarshal(tc.stdout.Bytes(), &st); err != nil || st.Version != "1.2.0" || !st.Agents[0].Installed || st.Agents[0].Current || st.Agents[0].Version != "1.0.0" || !st.Agents[1].Plugin {
		t.Errorf("status --json: %v %+v", err, st)
	}
	tc.stdout.Reset()
	tc.dispatch("skills", []string{"status"})
	if !strings.Contains(tc.stdout.String(), "this termote is v1.2.0; update it: termote skills install --agent claude") {
		t.Errorf("stale: %s", tc.stdout)
	}
	none := skillsCLI(t)
	none.dispatch("skills", []string{"status"})
	if !strings.Contains(none.stdout.String(), "Claude Code: not set up") {
		t.Errorf("none: %s", none.stdout)
	}
}

// Installing next to the plugin warns about two copies of the skill.
func TestSkillsInstallWarnsAboutPlugin(t *testing.T) {
	tc := skillsCLI(t, "claude")
	writeFile(t, filepath.Join(tc.home, ".claude", "plugins", "installed_plugins.json"), `{"plugins":{"termote@termote":[{}]}}`)
	if err := tc.dispatch("skills", []string{"install"}); err != nil || !strings.Contains(tc.stdout.String(), "also has the termote plugin installed") {
		t.Errorf("%v %s", err, tc.stdout)
	}
}

// update names a skill termote installed for another version, and says
// nothing on a machine where none was installed.
func TestSkillUpdateHint(t *testing.T) {
	tc := skillsCLI(t, "claude", "codex")
	tc.skillUpdateHint("1.0.0")
	if tc.stdout.Len() != 0 {
		t.Errorf("nothing installed: %s", tc.stdout)
	}
	tc.dispatch("skills", []string{"install", "--agent", "codex"})
	tc.stdout.Reset()
	tc.skillUpdateHint("1.0.0")
	if tc.stdout.Len() != 0 {
		t.Errorf("same version: %s", tc.stdout)
	}
	tc.skillUpdateHint("1.1.0")
	if out := tc.stdout.String(); !strings.Contains(out, "for Codex is v1.0.0; update it: termote skills install --agent codex") || strings.Contains(out, "Claude") {
		t.Errorf("hint: %s", out)
	}
}
