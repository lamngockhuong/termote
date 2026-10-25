package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// skillNames joins the names a Codex pane lists, each source first.
func skillNames(cmds []agentCommand) string {
	var names []string
	for _, c := range cmds {
		names = append(names, c.Source+":"+c.Name)
	}
	return strings.Join(names, " ")
}

func TestCodexSkillsConfig(t *testing.T) {
	codexHome, home := t.TempDir(), t.TempDir()
	cases := []struct {
		name, config, rules string
		bundled             bool
	}{
		{"none", "", "", true},
		{"name and path", "[[skills.config]]\nname = \"a\"\nenabled = false\n[[skills.config]]\npath = \"/x/SKILL.md\"\nenabled = true\n", "name a off, path /x/SKILL.md on", true},
		{"trimmed name", "[[skills.config]]\nname = \" a \"\nenabled = false\n", "name a off", true},
		// An entry with both selectors, or none, or a blank name, is dropped alone.
		{"bad entries", "[[skills.config]]\nname = \"a\"\npath = \"/x\"\nenabled = false\n[[skills.config]]\nenabled = false\n[[skills.config]]\nname = \"  \"\nenabled = false\n[[skills.config]]\nname = \"b\"\nenabled = false\n", "name b off", true},
		// A selector met again replaces the earlier rule, at the end.
		{"replaced", "[[skills.config]]\nname = \"a\"\nenabled = false\n[[skills.config]]\nname = \"b\"\nenabled = false\n[[skills.config]]\nname = \"a\"\nenabled = true\n", "name b off, name a on", true},
		// Keys Codex does not know are ignored; keys match exactly.
		{"unknown keys", "[skills]\nshiny = 1\n[[skills.config]]\nname = \"a\"\nenabled = false\nnote = \"x\"\nName = \"b\"\n", "name a off", true},
		// Anything of the wrong type, or an entry without enabled: no rule.
		{"no enabled", "[[skills.config]]\nname = \"a\"\nenabled = false\n[[skills.config]]\nname = \"b\"\n", "", true},
		{"Enabled", "[[skills.config]]\nname = \"a\"\nEnabled = false\n", "", true},
		{"enabled not bool", "[[skills.config]]\nname = \"a\"\nenabled = \"no\"\n", "", true},
		{"name not string", "[[skills.config]]\nname = 1\nenabled = false\n", "", true},
		{"config not tables", "[skills]\nconfig = [1]\n", "", true},
		{"config not a list", "[skills]\nconfig = 1\n", "", true},
		{"skills not a table", "skills = 1\n", "", true},
		{"zero tokens", "[skills]\nmax_context_tokens = 0\n[[skills.config]]\nname = \"a\"\nenabled = false\n", "", true},
		{"instructions not bool", "[skills]\ninclude_instructions = 1\n", "", true},
		{"inline config", "[skills]\nconfig = [{ name = \"a\", enabled = false }]\nmax_context_tokens = 100\ninclude_instructions = true\n", "name a off", true},
		// [skills.bundled] enabled = false turns off the bundled skills;
		// a table that does not decode leaves them on.
		{"bundled off", "[skills.bundled]\nenabled = false\n", "", false},
		{"bundled off, rule", "[skills.bundled]\nenabled = false\n[[skills.config]]\nname = \"a\"\nenabled = false\n", "name a off", false},
		{"bundled default", "[skills.bundled]\n", "", true},
		{"bundled not a table", "[skills]\nbundled = false\n", "", true},
		{"bundled not bool", "[skills.bundled]\nenabled = 0\n", "", true},
		{"bundled off, bad rule", "[skills.bundled]\nenabled = false\n[[skills.config]]\nname = \"a\"\n", "", true},
		{"broken toml", "[[skills.config]\n", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			os.Remove(filepath.Join(codexHome, "config.toml"))
			if c.config != "" {
				writeFile(t, filepath.Join(codexHome, "config.toml"), c.config)
			}
			rules, bundled := codexSkillsConfig(readCodexConfig(codexHome), codexHome, home, nil)
			var got []string
			for _, r := range rules {
				sel := "name " + r.name
				if r.path != "" {
					sel = "path " + filepath.ToSlash(r.path)
				}
				if runtime.GOOS == "windows" && r.path != "" {
					sel = "path " + "/" + filepath.Base(filepath.Dir(r.path)) + "/" + filepath.Base(r.path)
				}
				state := "off"
				if r.enabled {
					state = "on"
				}
				got = append(got, sel+" "+state)
			}
			if s := strings.Join(got, ", "); s != c.rules || bundled != c.bundled {
				t.Errorf("rules = %q bundled %v, want %q %v", s, bundled, c.rules, c.bundled)
			}
		})
	}
	// More entries than codexSkillRulesMax: none applies.
	var b strings.Builder
	for i := range codexSkillRulesMax + 1 {
		fmt.Fprintf(&b, "[[skills.config]]\nname = \"s%d\"\nenabled = false\n", i)
	}
	writeFile(t, filepath.Join(codexHome, "config.toml"), b.String())
	if rules, bundled := codexSkillsConfig(readCodexConfig(codexHome), codexHome, home, nil); len(rules) != 0 || !bundled {
		t.Errorf("too many rules: %d, %v", len(rules), bundled)
	}
}

func TestCodexRulePath(t *testing.T) {
	codexHome, home, base := t.TempDir(), t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(base, "real/SKILL.md"), "x")
	symlinkOrSkip(t, filepath.Join(base, "real"), filepath.Join(base, "link"))
	realBase := resolvedDir(base)
	cases := []struct{ in, want string }{
		{"~", home},
		{"~/a/SKILL.md", filepath.Join(home, "a/SKILL.md")},
		{"~other/x", filepath.Join(codexHome, "~other/x")},
		{"skills/a/SKILL.md", filepath.Join(codexHome, "skills/a/SKILL.md")},
		{filepath.Join(base, "x/../real/SKILL.md"), filepath.Join(realBase, "real/SKILL.md")},
		// Links are resolved inside the listed dirs only.
		{filepath.Join(base, "link/SKILL.md"), filepath.Join(realBase, "real/SKILL.md")},
		{filepath.Join(base, "gone/SKILL.md"), filepath.Join(base, "gone/SKILL.md")},
	}
	for _, c := range cases {
		if got := codexRulePath(c.in, codexHome, home, []string{"", realBase, base}); got != c.want {
			t.Errorf("%q = %q, want %q", c.in, got, c.want)
		}
	}
	// Outside them, the path is only cleaned.
	other := t.TempDir()
	if got := codexRulePath(filepath.Join(other, "a/../b"), codexHome, home, []string{realBase}); got != filepath.Join(other, "b") {
		t.Errorf("outside = %q", got)
	}
	if got := codexRulePath("~/x", codexHome, "", nil); got != filepath.Join(codexHome, "~/x") {
		t.Errorf("no home = %q", got)
	}
}

func TestListCodexSkillsRules(t *testing.T) {
	useAdminSkills(t, "")
	root, codexHome, home := t.TempDir(), t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(root, ".agents/skills/deploy/SKILL.md"), skill("deploy", "Project deploy"))
	writeFile(t, filepath.Join(home, ".agents/skills/deploy/SKILL.md"), skill("deploy", "User deploy"))
	writeFile(t, filepath.Join(codexHome, "skills/lint/SKILL.md"), skill("lint", "x"))
	writeFile(t, filepath.Join(codexHome, "skills/fmt/SKILL.md"), skill("fmt", "x"))
	writeFile(t, filepath.Join(codexHome, "skills/.system/imagegen/SKILL.md"), skill("imagegen", "Bundled"))
	writeCodexPlugin(t, codexHome, "atk", "atk", "1.0.0", `{"name":"atk"}`, "review", "plan")
	writeFile(t, filepath.Join(root, ".codex/skills/review/SKILL.md"), skill("atk:review", "Project one of a plugin's name"))
	list := func(config string) string {
		t.Helper()
		writeFile(t, filepath.Join(codexHome, "config.toml"), "[plugins.\"atk@atk\"]\n"+config)
		return skillNames(listCodexSkills(filesRoot{Root: root}, codexHome, home, nil).Commands)
	}
	all := "project:deploy user:lint user:fmt system:imagegen plugin:atk:plan plugin:atk:review"
	if got := list(""); got != strings.Replace(all, "user:lint user:fmt", "user:fmt user:lint", 1) {
		t.Errorf("no rules = %s", got)
	}
	// Off by path: another skill of that name still shows.
	projDeploy := filepath.Join(root, ".agents/skills/deploy/SKILL.md")
	got := list(fmt.Sprintf("[[skills.config]]\npath = %q\nenabled = false\n", projDeploy))
	if !strings.Contains(got, "user:deploy") || strings.Contains(got, "project:deploy") {
		t.Errorf("project deploy off = %s", got)
	}
	// Off by name: every skill of the name; a later path rule turns one on.
	got = list(fmt.Sprintf("[[skills.config]]\nname = \"deploy\"\nenabled = false\n[[skills.config]]\npath = %q\nenabled = true\n",
		filepath.Join(home, ".agents/skills/deploy/SKILL.md")))
	if !strings.Contains(got, "user:deploy") || strings.Contains(got, "project:deploy") {
		t.Errorf("name off, user on = %s", got)
	}
	// A path relative to config.toml's dir, and "~".
	got = list("[[skills.config]]\npath = \"skills/lint/SKILL.md\"\nenabled = false\n[[skills.config]]\npath = \"~/.agents/skills/deploy/SKILL.md\"\nenabled = false\n" +
		fmt.Sprintf("[[skills.config]]\npath = %q\nenabled = false\n", projDeploy))
	if strings.Contains(got, "lint") || strings.Contains(got, "deploy") {
		t.Errorf("relative and ~ = %s", got)
	}
	// A plugin's skill off by its full name: every skill of that name, the
	// project's too; the other plugin skill shows.
	got = list("[[skills.config]]\nname = \"atk:review\"\nenabled = false\n")
	if strings.Contains(got, "plugin:atk:review") || !strings.Contains(got, "plugin:atk:plan") {
		t.Errorf("plugin skill off = %s", got)
	}
	if strings.Contains(got, "atk:review") {
		t.Errorf("a skill of the name turned off shows = %s", got)
	}
	// Bundled skills off: the .system dir is not read.
	if got := list("[skills.bundled]\nenabled = false\n"); strings.Contains(got, "imagegen") {
		t.Errorf("bundled off = %s", got)
	}
}

func TestListCodexSkillsProjectChain(t *testing.T) {
	useAdminSkills(t, "")
	root, codexHome, home := t.TempDir(), t.TempDir(), t.TempDir()
	for _, d := range []string{"", "a", "a/b"} {
		tag := strings.ReplaceAll(d, "/", "")
		if tag == "" {
			tag = "root"
		}
		writeFile(t, filepath.Join(root, d, ".codex/skills/c-"+tag+"/SKILL.md"), skill("c-"+tag, "x"))
		writeFile(t, filepath.Join(root, d, ".agents/skills/g-"+tag+"/SKILL.md"), skill("g-"+tag, "x"))
	}
	// A skill further down does not stand in for the repo's or the user's.
	writeFile(t, filepath.Join(root, "a/b/.agents/skills/deploy/SKILL.md"), skill("deploy", "SPOOF"))
	writeFile(t, filepath.Join(root, "a/b/.agents/skills/lint/SKILL.md"), skill("lint", "SPOOF"))
	writeFile(t, filepath.Join(root, ".agents/skills/deploy/SKILL.md"), skill("deploy", "Repo deploy"))
	writeFile(t, filepath.Join(home, ".agents/skills/lint/SKILL.md"), skill("lint", "User lint"))
	realRoot := resolvedDir(root)
	pr := filesRoot{Root: root, IsRepo: true, GitDir: filepath.Join(root, ".git"), Dir: filepath.Join(realRoot, "a/b")}
	cmds := listCodexSkills(pr, codexHome, home, nil).Commands
	want := "project:c-root project:deploy project:g-root user:lint project:c-a project:g-a project:c-ab project:g-ab"
	if got := skillNames(cmds); got != want {
		t.Errorf("chain = %s\nwant    %s", got, want)
	}
	for _, c := range cmds {
		if c.Description == "SPOOF" {
			t.Errorf("a dir further down stood in: %+v", c)
		}
	}
	// Outside a repo, or the pane's dir outside the root: the root only.
	for _, p := range []filesRoot{
		{Root: root, Dir: filepath.Join(realRoot, "a/b")},
		{Root: root, IsRepo: true, Dir: t.TempDir()},
		{Root: root, IsRepo: true},
	} {
		if got := skillNames(listCodexSkills(p, codexHome, home, nil).Commands); got != "project:c-root project:deploy project:g-root user:lint" {
			t.Errorf("%+v = %s", p, got)
		}
	}
}

func TestCodexProjectChain(t *testing.T) {
	root := t.TempDir()
	real := resolvedDir(root)
	deep := real
	var parts []string
	for i := range codexProjectMaxDirs + 3 {
		parts = append(parts, fmt.Sprintf("d%d", i))
	}
	deep = filepath.Join(append([]string{real}, parts...)...)
	os.MkdirAll(deep, 0o755)
	gitDir := filepath.Join(root, ".git")
	os.MkdirAll(filepath.Join(gitDir, "modules/sub"), 0o755)
	os.MkdirAll(filepath.Join(root, "x/.git/y"), 0o755)
	sep := t.TempDir()
	os.MkdirAll(filepath.Join(sep, "in"), 0o755)

	chain := codexProjectChain(filesRoot{Root: root, IsRepo: true, Dir: deep})
	if len(chain) != codexProjectMaxDirs || chain[0] != "" || chain[len(chain)-1] != strings.Join(parts, "/") {
		t.Errorf("deep chain: %d dirs, %q … %q", len(chain), chain[0], chain[len(chain)-1])
	}
	if got := codexProjectChain(filesRoot{Root: root, IsRepo: true, Dir: real}); len(got) != 1 {
		t.Errorf("pane at the root = %q", got)
	}
	// Never inside the git dir, nor at or below a .git on the way.
	if got := codexProjectChain(filesRoot{Root: root, IsRepo: true, GitDir: gitDir, Dir: filepath.Join(gitDir, "modules/sub")}); len(got) != 1 {
		t.Errorf("in the git dir = %q", got)
	}
	if got := codexProjectChain(filesRoot{Root: root, IsRepo: true, GitDir: gitDir, Dir: filepath.Join(real, "x/.git/y")}); strings.Join(got, ",") != ",x" {
		t.Errorf("below a .git = %q", got)
	}
	// A git dir elsewhere (--separate-git-dir) inside the work tree too.
	if got := codexProjectChain(filesRoot{Root: sep, IsRepo: true, GitDir: filepath.Join(sep, "in"), Dir: filepath.Join(sep, "in")}); len(got) != 1 {
		t.Errorf("separate git dir = %q", got)
	}
	if got := codexProjectChain(filesRoot{}); got != nil {
		t.Errorf("no root = %q", got)
	}
}

func TestListCodexSkillsHomeRoot(t *testing.T) {
	useAdminSkills(t, "")
	home := t.TempDir()
	codexHome := filepath.Join(home, ".codex")
	writeFile(t, filepath.Join(home, ".agents/skills/mine/SKILL.md"), skill("mine", "x"))
	writeFile(t, filepath.Join(codexHome, "skills/usr/SKILL.md"), skill("usr", "x"))
	// The pane in home: home's ~/.agents/skills and CODEX_HOME's skills are
	// the user's, read once.
	got := skillNames(listCodexSkills(filesRoot{Root: home}, codexHome, home, nil).Commands)
	if got != "user:usr user:mine" {
		t.Errorf("home root = %s", got)
	}
}

func TestListCodexSkillsLinkedChainDir(t *testing.T) {
	useAdminSkills(t, "")
	root, outside, codexHome := t.TempDir(), t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(outside, ".agents/skills/away/SKILL.md"), skill("away", "another project's"))
	os.MkdirAll(filepath.Join(root, "a"), 0o755)
	// A skill dir on the way that is a symlink out of the root.
	symlinkOrSkip(t, filepath.Join(outside, ".agents"), filepath.Join(root, "a/.agents"))
	symlinkOrSkip(t, filepath.Join(outside, ".agents"), filepath.Join(root, ".agents"))
	pr := filesRoot{Root: root, IsRepo: true, Dir: filepath.Join(resolvedDir(root), "a")}
	if got := skillNames(listCodexSkills(pr, codexHome, "", nil).Commands); got != "" {
		t.Errorf("linked dir on the way = %s", got)
	}
}

// A reply holds at most codexSkillMaxTotal skills, whichever dirs they come
// from.
func TestListCodexSkillsMaxTotal(t *testing.T) {
	useAdminSkills(t, "")
	codexHome, home := t.TempDir(), t.TempDir()
	for i := range 1500 {
		writeFile(t, filepath.Join(codexHome, fmt.Sprintf("skills/c%04d/SKILL.md", i)), skill(fmt.Sprintf("c%04d", i), "x"))
	}
	for i := range 600 {
		writeFile(t, filepath.Join(home, fmt.Sprintf(".agents/skills/h%04d/SKILL.md", i)), skill(fmt.Sprintf("h%04d", i), "x"))
	}
	cmds := listCodexSkills(filesRoot{}, codexHome, home, nil).Commands
	if len(cmds) != codexSkillMaxTotal || cmds[len(cmds)-1].Name != "h0499" {
		t.Errorf("%d skills, last %v", len(cmds), cmds[len(cmds)-1])
	}
}

// A rule's path names a skill through a symlinked CODEX_HOME (or /home):
// it is resolved as the skill's path is.
func TestListCodexSkillsRulesLinkedHome(t *testing.T) {
	useAdminSkills(t, "")
	real := t.TempDir()
	codexHome := filepath.Join(t.TempDir(), "codex")
	symlinkOrSkip(t, real, codexHome)
	writeFile(t, filepath.Join(real, "skills/bar/SKILL.md"), skill("bar", "x"))
	writeFile(t, filepath.Join(real, "skills/baz/SKILL.md"), skill("baz", "x"))
	writeFile(t, filepath.Join(real, "config.toml"), "[[skills.config]]\npath = \"skills/bar/SKILL.md\"\nenabled = false\n")
	if got := skillNames(listCodexSkills(filesRoot{}, codexHome, "", nil).Commands); got != "user:baz" {
		t.Errorf("skills = %s", got)
	}
}

// The reply cap never drops a plugin skill whose name kept another out.
func TestListCodexSkillsMaxTotalKeepsPlugins(t *testing.T) {
	useAdminSkills(t, "")
	codexHome, home := t.TempDir(), t.TempDir()
	for i := range codexSkillMaxTotal {
		writeFile(t, filepath.Join(home, fmt.Sprintf(".agents/skills/h%04d/SKILL.md", i)), skill(fmt.Sprintf("h%04d", i), "x"))
	}
	writeFile(t, filepath.Join(codexHome, "config.toml"), "[plugins.\"atk@atk\"]\n")
	writeCodexPlugin(t, codexHome, "atk", "atk", "1.0.0", `{"name":"atk"}`, "review")
	writeFile(t, filepath.Join(codexHome, "skills/x/SKILL.md"), skill("atk:review", "Shadowed"))
	cmds := listCodexSkills(filesRoot{}, codexHome, home, nil).Commands
	if len(cmds) != codexSkillMaxTotal || cmds[len(cmds)-1].Name != "atk:review" || cmds[len(cmds)-1].Source != "plugin" {
		t.Errorf("%d skills, last %+v", len(cmds), cmds[len(cmds)-1])
	}
}
