package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// pluginInstall is one entry of installed_plugins.json in a test.
type pluginInstall struct {
	InstallPath string `json:"installPath"`
	ProjectPath string `json:"projectPath,omitempty"`
}

func writePlugins(t *testing.T, claude string, plugins map[string][]pluginInstall) {
	t.Helper()
	b, err := json.Marshal(map[string]any{"version": 2, "plugins": plugins})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(claude, "plugins/installed_plugins.json"), string(b))
}

func writeEnabled(t *testing.T, p string, enabled map[string]any) {
	t.Helper()
	b, err := json.Marshal(map[string]any{"enabledPlugins": enabled, "other": 1})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, p, string(b))
}

func mustSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func TestListAgentCommandsPlugins(t *testing.T) {
	root, claude, outside := t.TempDir(), t.TempDir(), t.TempDir()
	cache := filepath.Join(claude, "plugins/cache/m")
	alpha := filepath.Join(cache, "alpha/1.0.0")
	writeFile(t, filepath.Join(alpha, "commands/run.md"), "---\ndescription: Run it\n---\nSECRET BODY")
	writeFile(t, filepath.Join(alpha, "commands/sub/x.md"), "Nested")
	writeFile(t, filepath.Join(alpha, "commands/dup.md"), "Shadowed by the project's alpha:dup")
	writeFile(t, filepath.Join(alpha, "skills/s1/SKILL.md"), "---\nname: renamed\ndescription: A plugin skill\n---\n")
	writeFile(t, filepath.Join(alpha, "skills/hidden/SKILL.md"), "---\nuser-invocable: false\n---\n")
	for _, p := range []string{"beta", "gamma", "delta", "mine", "other", "bad name", "odd", "rel", "dots"} {
		writeFile(t, filepath.Join(cache, p, "commands/c.md"), p+" command")
	}
	writeFile(t, filepath.Join(outside, "commands/c.md"), "outside command")
	writeFile(t, filepath.Join(root, ".claude/commands/alpha/dup.md"), "Project alpha:dup")
	writePlugins(t, claude, map[string][]pluginInstall{
		"alpha@m": {{InstallPath: alpha}},
		"beta@m":  {{InstallPath: filepath.Join(cache, "beta")}},
		"gamma@m": {{InstallPath: filepath.Join(cache, "gamma")}},
		"delta@m": {{InstallPath: filepath.Join(cache, "delta")}},
		// Installed for this project, and for another one only.
		"mine@m":  {{InstallPath: filepath.Join(cache, "other"), ProjectPath: outside}, {InstallPath: filepath.Join(cache, "mine"), ProjectPath: root}},
		"other@m": {{InstallPath: filepath.Join(cache, "other"), ProjectPath: outside}},
		// Paths that leave <claudeDir>/plugins, or are not absolute.
		"evil@m": {{InstallPath: outside}},
		"dots@m": {{InstallPath: filepath.Join(claude, "plugins", "..", "..", filepath.Base(outside))}},
		"rel@m":  {{InstallPath: "plugins/cache/m/rel"}},
		"base@m": {{InstallPath: filepath.Join(claude, "plugins")}},
		// Not a name that can follow "/".
		"bad name@m": {{InstallPath: filepath.Join(cache, "bad name")}},
		"odd:x@m":    {{InstallPath: filepath.Join(cache, "odd")}},
	})
	writeEnabled(t, filepath.Join(claude, "settings.json"), map[string]any{
		"alpha@m": true, "beta@m": true, "delta@m": false, "mine@m": true, "other@m": true,
		"evil@m": true, "dots@m": true, "rel@m": true, "base@m": true, "bad name@m": true, "odd:x@m": true,
		"notinstalled@m": true,
	})
	// Project scope turns beta off, local scope turns gamma on; a value that
	// is not a boolean changes nothing.
	writeEnabled(t, filepath.Join(root, ".claude/settings.json"), map[string]any{"beta@m": false, "gamma@m": []string{"x"}})
	writeEnabled(t, filepath.Join(root, ".claude/settings.local.json"), map[string]any{"gamma@m": true})

	got := listAgentCommands(root, claude, "", nil).Commands
	want := []agentCommand{
		{"alpha:dup", "Project alpha:dup", "project", "command"},
		{"alpha:run", "Run it", "plugin", "command"},
		{"alpha:sub:x", "Nested", "plugin", "command"},
		{"alpha:renamed", "A plugin skill", "plugin", "skill"},
		{"gamma:c", "gamma command", "plugin", "command"},
		{"mine:c", "mine command", "plugin", "command"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("commands =\n%v\nwant\n%v", got, want)
	}
	for _, c := range got {
		if strings.Contains(c.Description, "SECRET") {
			t.Errorf("a command body leaked: %+v", c)
		}
	}

	// Without a pane root only user-scope settings and installs count.
	got = listAgentCommands("", claude, "", nil).Commands
	names := []string{}
	for _, c := range got {
		names = append(names, c.Name)
	}
	if fmt.Sprint(names) != "[alpha:dup alpha:run alpha:sub:x alpha:renamed beta:c]" {
		t.Errorf("no root = %v", names)
	}
	// A pane root that is gone: its settings are not read either.
	got = listAgentCommands(filepath.Join(root, "missing"), claude, "", nil).Commands
	if len(got) != 5 {
		t.Errorf("missing root = %v", got)
	}
}

func TestListAgentCommandsPluginSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	claude, outside := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(outside, "commands/c.md"), "outside")
	writeFile(t, filepath.Join(outside, "skills/s/SKILL.md"), "outside skill")
	in := filepath.Join(claude, "plugins/cache/m/in")
	writeFile(t, filepath.Join(in, "commands/c.md"), "inside")
	writeFile(t, filepath.Join(in, "shared/s/SKILL.md"), "linked inside the plugin")
	// A skill dir linked inside the plugin is followed, one leading out of it
	// (even into the config dir) is not.
	mustSymlink(t, "../shared/s", filepath.Join(in, "skills/s"))
	writeFile(t, filepath.Join(claude, "skills/u/SKILL.md"), "user skill")
	mustSymlink(t, filepath.Join(claude, "skills/u"), filepath.Join(in, "skills/u"))
	// An installPath that is a symlink inside plugins/ leading out of it.
	mustSymlink(t, outside, filepath.Join(claude, "plugins/cache/m/link"))
	writePlugins(t, claude, map[string][]pluginInstall{
		"in@m":   {{InstallPath: in}},
		"link@m": {{InstallPath: filepath.Join(claude, "plugins/cache/m/link")}},
	})
	writeEnabled(t, filepath.Join(claude, "settings.json"), map[string]any{"in@m": true, "link@m": true})

	got := listAgentCommands("", claude, "", nil).Commands
	want := []agentCommand{
		{"u", "user skill", "user", "skill"},
		{"in:c", "inside", "plugin", "command"},
		{"in:s", "linked inside the plugin", "plugin", "skill"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("commands =\n%v\nwant\n%v", got, want)
	}
}

func TestListAgentCommandsPluginFiles(t *testing.T) {
	claude := t.TempDir()
	writeFile(t, filepath.Join(claude, "commands/mine.md"), "Mine")
	writeFile(t, filepath.Join(claude, "plugins/cache/m/p/commands/c.md"), "plugin")
	writeEnabled(t, filepath.Join(claude, "settings.json"), map[string]any{"p@m": true})
	installed := filepath.Join(claude, "plugins/installed_plugins.json")
	list := func() []agentCommand { return listAgentCommands("", claude, "", nil).Commands }

	// No installed_plugins.json, a broken one, one too big, one that is a
	// dir: the user's commands are still listed.
	if got := list(); len(got) != 1 || got[0].Name != "mine" {
		t.Errorf("no plugins file = %v", got)
	}
	writeFile(t, installed, "{")
	if got := list(); len(got) != 1 {
		t.Errorf("broken JSON = %v", got)
	}
	big := `{"plugins":{"p@m":[{"installPath":` + fmt.Sprintf("%q", filepath.Join(claude, "plugins/cache/m/p")) + `}]},"pad":"` + strings.Repeat("x", pluginJSONMax) + `"}`
	writeFile(t, installed, big)
	if got := list(); len(got) != 1 {
		t.Errorf("huge JSON = %v", got)
	}
	os.Remove(installed)
	os.MkdirAll(installed, 0o755)
	if got := list(); len(got) != 1 {
		t.Errorf("JSON dir = %v", got)
	}
	os.Remove(installed)
	writePlugins(t, claude, map[string][]pluginInstall{"p@m": {{InstallPath: filepath.Join(claude, "plugins/cache/m/p")}}})
	if got := list(); len(got) != 2 || got[1].Name != "p:c" || got[1].Source != "plugin" {
		t.Errorf("plugin = %v", got)
	}
	// A broken settings.json enables nothing.
	writeFile(t, filepath.Join(claude, "settings.json"), "not json")
	if got := list(); len(got) != 1 {
		t.Errorf("broken settings = %v", got)
	}
	// A config dir without plugins/, or missing.
	if got := enabledPluginDirs("", t.TempDir()); got != nil {
		t.Errorf("no plugins dir = %v", got)
	}
	if got := enabledPluginDirs("", filepath.Join(claude, "missing")); got != nil {
		t.Errorf("missing config dir = %v", got)
	}
}

func TestListAgentCommandsPluginLimits(t *testing.T) {
	claude := t.TempDir()
	plugins := map[string][]pluginInstall{}
	enabled := map[string]any{}
	for i := 0; i < commandsMaxPlugins+5; i++ {
		key := fmt.Sprintf("p%02d@m", i)
		dir := filepath.Join(claude, "plugins/cache/m", key)
		writeFile(t, filepath.Join(dir, "commands/c.md"), "x")
		plugins[key] = []pluginInstall{{InstallPath: dir}}
		enabled[key] = true
	}
	writePlugins(t, claude, plugins)
	writeEnabled(t, filepath.Join(claude, "settings.json"), enabled)
	got := listAgentCommands("", claude, "", nil).Commands
	if len(got) != commandsMaxPlugins || got[0].Name != "p00:c" || got[len(got)-1].Name != fmt.Sprintf("p%02d:c", commandsMaxPlugins-1) {
		t.Fatalf("got %d plugin commands: first %v", len(got), got[0])
	}

	// The plugin source as a whole stops at commandsMaxPerSource entries.
	claude = t.TempDir()
	plugins, enabled = map[string][]pluginInstall{}, map[string]any{}
	for _, key := range []string{"a@m", "b@m"} {
		dir := filepath.Join(claude, "plugins/cache/m", key)
		for i := 0; i < commandsMaxPerSource*3/4; i++ {
			writeFile(t, filepath.Join(dir, "commands", fmt.Sprintf("c%03d.md", i)), "x")
		}
		plugins[key] = []pluginInstall{{InstallPath: dir}}
		enabled[key] = true
	}
	writePlugins(t, claude, plugins)
	writeEnabled(t, filepath.Join(claude, "settings.json"), enabled)
	if got := listAgentCommands("", claude, "", nil).Commands; len(got) != commandsMaxPerSource {
		t.Errorf("got %d plugin commands, want %d", len(got), commandsMaxPerSource)
	}
}

func TestListAgentCommandsLinkedSkills(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	root, claude, home, elsewhere := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	agents := filepath.Join(home, ".agents/skills")
	writeFile(t, filepath.Join(agents, "find/SKILL.md"), "---\ndescription: Find skills\n---\n")
	writeFile(t, filepath.Join(agents, "abs/SKILL.md"), "---\nname: absolute\n---\nAbsolute link")
	writeFile(t, filepath.Join(agents, "secret/SKILL.md"), "refused by skip")
	writeFile(t, filepath.Join(agents, "file/real.md"), "x")
	mustSymlink(t, "real.md", filepath.Join(agents, "file/SKILL.md"))
	writeFile(t, filepath.Join(elsewhere, "far/SKILL.md"), "outside every allowed dir")
	writeFile(t, filepath.Join(agents, "plain.md"), "a file, not a dir")
	writeFile(t, filepath.Join(root, "tools/proj/SKILL.md"), "In the pane root")

	rel, err := filepath.Rel(filepath.Join(claude, "skills"), filepath.Join(agents, "find"))
	if err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, rel, filepath.Join(claude, "skills/find"))
	mustSymlink(t, filepath.Join(agents, "abs"), filepath.Join(claude, "skills/abs"))
	mustSymlink(t, filepath.Join(agents, "secret"), filepath.Join(claude, "skills/secret"))
	mustSymlink(t, filepath.Join(agents, "file"), filepath.Join(claude, "skills/file"))
	mustSymlink(t, filepath.Join(elsewhere, "far"), filepath.Join(claude, "skills/far"))
	mustSymlink(t, filepath.Join(agents, "plain.md"), filepath.Join(claude, "skills/plain"))
	mustSymlink(t, filepath.Join(agents, "gone"), filepath.Join(claude, "skills/gone"))
	// A user skill may lead into the pane root, a project one into the
	// config dir.
	mustSymlink(t, filepath.Join(root, "tools/proj"), filepath.Join(claude, "skills/proj"))
	writeFile(t, filepath.Join(claude, "shared/cfg/SKILL.md"), "In the config dir")
	mustSymlink(t, filepath.Join(claude, "shared/cfg"), filepath.Join(root, ".claude/skills/cfg"))

	var asked []string
	skip := func(dir, rel string) bool {
		asked = append(asked, filepath.Join(dir, rel))
		return strings.Contains(dir, "secret")
	}
	got := listAgentCommands(root, claude, home, skip).Commands
	want := []agentCommand{
		{"cfg", "In the config dir", "project", "skill"},
		{"absolute", "Absolute link", "user", "skill"},
		{"find", "Find skills", "user", "skill"},
		{"proj", "In the pane root", "user", "skill"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("commands =\n%v\nwant\n%v", got, want)
	}
	// skip is asked with the link's target, the dir actually read.
	real, _ := filepath.EvalSymlinks(filepath.Join(agents, "secret"))
	if !strings.Contains(strings.Join(asked, "\n"), filepath.Join(real, "SKILL.md")) {
		t.Errorf("skip asked for %v", asked)
	}
	// Without the home dir, ~/.agents/skills is not allowed.
	got = listAgentCommands(root, claude, "", nil).Commands
	if len(got) != 2 || got[0].Name != "cfg" || got[1].Name != "proj" {
		t.Errorf("no home = %v", got)
	}
}

func TestListAgentCommandsPluginLinkedSettings(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	claude, dotfiles := t.TempDir(), t.TempDir()
	dir := filepath.Join(claude, "plugins/cache/m/p")
	writeFile(t, filepath.Join(dir, "commands/c.md"), "plugin")
	writePlugins(t, claude, map[string][]pluginInstall{"p@m": {{InstallPath: dir}}})
	// settings.json linked from a dotfiles repo, as stow or yadm do.
	writeEnabled(t, filepath.Join(dotfiles, "settings.json"), map[string]any{"p@m": true})
	mustSymlink(t, filepath.Join(dotfiles, "settings.json"), filepath.Join(claude, "settings.json"))
	if got := listAgentCommands("", claude, "", nil).Commands; len(got) != 1 || got[0].Name != "p:c" {
		t.Fatalf("commands = %v", got)
	}
}

func TestListAgentCommandsLinkedSkillInGitDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".git/x/SKILL.md"), "---\ndescription: FROM_GIT\n---\n")
	writeFile(t, filepath.Join(root, "tools/ok/SKILL.md"), "fine")
	mustSymlink(t, "../../.git/x", filepath.Join(root, ".claude/skills/g"))
	mustSymlink(t, "../../tools/ok", filepath.Join(root, ".claude/skills/ok"))
	a := &agentAPI{files: &filesAPI{}}
	got := listAgentCommands(root, "", "", a.commandSkip).Commands
	if len(got) != 1 || got[0].Name != "ok" {
		t.Fatalf("commands = %v", got)
	}
}
