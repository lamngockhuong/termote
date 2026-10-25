package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// writeCodexPlugin installs a plugin under codexHome/plugins/cache with a
// .codex-plugin manifest (when manifest is set) and one skill per name.
func writeCodexPlugin(t *testing.T, codexHome, mkt, name, version, manifest string, skills ...string) string {
	t.Helper()
	dir := filepath.Join(codexHome, "plugins/cache", mkt, name, version)
	if manifest != "" {
		writeFile(t, filepath.Join(dir, ".codex-plugin/plugin.json"), manifest)
	}
	for _, s := range skills {
		writeFile(t, filepath.Join(dir, "skills", s, "SKILL.md"), skill(s, "Skill "+s+" of "+name))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func pluginNames(cmds []agentCommand) string {
	var names []string
	for _, c := range cmds {
		names = append(names, c.Name)
	}
	return strings.Join(names, " ")
}

func TestReadCodexPluginSkills(t *testing.T) {
	useAdminSkills(t, "")
	codexHome, root := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(codexHome, "config.toml"), `
model = "gpt-5"
[plugins."atk@atk"]
enabled = true
[plugins."off@atk"]
enabled = false
[plugins."implicit@atk"]
[plugins."sites@openai-curated"]
[plugins."pages@openai-curated-remote"]
[plugins."missing@atk"]
`)
	writeCodexPlugin(t, codexHome, "atk", "atk", "0.1.18", `{"name":"atk","skills":"./skills/"}`, "review", "breakdown")
	writeCodexPlugin(t, codexHome, "atk", "off", "1.0.0", `{"name":"off"}`, "nope")
	writeCodexPlugin(t, codexHome, "atk", "implicit", "1.0.0", `{"name":"implicit"}`, "on")
	writeCodexPlugin(t, codexHome, "openai-curated", "sites", "1.0.0", `{"name":"sites"}`, "s")
	writeCodexPlugin(t, codexHome, "openai-curated-remote", "pages", "1.0.0", `{"name":"pages"}`, "p")
	writeFile(t, filepath.Join(codexHome, "skills/mine/SKILL.md"), skill("mine", "User codex"))
	writeFile(t, filepath.Join(codexHome, "skills/.system/sys/SKILL.md"), skill("sys", "Bundled"))
	// A project skill that names itself as a plugin's does not stand in for it.
	writeFile(t, filepath.Join(root, ".codex/skills/fake/SKILL.md"), skill("atk:review", "SPOOF"))

	got := listCodexSkills(filesRoot{Root: root}, codexHome, "", nil).Commands
	want := []agentCommand{
		{"mine", "User codex", "user", "skill"},
		{"sys", "Bundled", "system", "skill"},
		{"atk:breakdown", "Skill breakdown of atk", "plugin", "skill"},
		{"atk:review", "Skill review of atk", "plugin", "skill"},
		{"implicit:on", "Skill on of implicit", "plugin", "skill"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("skills =\n%v\nwant\n%v", got, want)
	}
}

func TestCodexEnabledPlugins(t *testing.T) {
	cases := []struct {
		name, config, want string
	}{
		{"no file", "", ""},
		{"default off", "[plugins._default]\nenabled = false\n[plugins.\"a@m\"]\n[plugins.\"b@m\"]\nenabled = true\n", "b@m"},
		{"default on", "[plugins._default]\nenabled = true\n[plugins.\"a@m\"]\n[plugins.\"b@m\"]\nenabled = false\n", "a@m"},
		{"empty default", "[plugins._default]\n[plugins.\"a@m\"]\n", "a@m"},
		{"features off", "[features]\nplugins = false\n[plugins.\"a@m\"]\n", ""},
		{"features on", "[features]\nplugins = true\nother = 1\n[plugins.\"a@m\"]\n", "a@m"},
		{"features not a bool", "[features]\nplugins = \"no\"\n[plugins.\"a@m\"]\n", ""},
		{"broken toml", "[plugins.\"a@m\"\nenabled = true\n", ""},
		// Codex ignores keys it does not know.
		{"unknown key", "[plugins.\"a@m\"]\nenabled = true\nshiny = 1\n", "a@m"},
		// One entry of the wrong type and the whole table is refused.
		{"wrong type", "[plugins.\"a@m\"]\n[plugins.\"b@m\"]\nenabled = \"yes\"\n", ""},
		{"not a table", "[plugins]\n\"a@m\" = {}\n\"b@m\" = 1\n", ""},
		{"plugins not a table", "plugins = 1\n", ""},
		{"bad default", "[plugins._default]\nenabled = 1\n[plugins.\"a@m\"]\n", ""},
		{"mcp ok", "[plugins.\"a@m\".mcp_servers.x]\nenabled = false\nema_auth = \"any\"\ndefault_tools_approval_mode = \"approve\"\nenabled_tools = [\"t\"]\n[plugins.\"a@m\".mcp_servers.x.tools.t]\napproval_mode = \"prompt\"\noutput_token_limit = 10\n[plugins.\"a@m\".mcp_servers.y]\nenabled = true\n", "a@m"},
		{"mcp bad mode", "[plugins.\"a@m\".mcp_servers.x]\ndefault_tools_approval_mode = \"always\"\n", ""},
		{"mcp zero limit", "[plugins.\"a@m\".mcp_servers.x.tools.t]\noutput_token_limit = 0\n", ""},
		{"mcp tools not strings", "[plugins.\"a@m\".mcp_servers.x]\nenabled_tools = [1]\n", ""},
		{"remote fields", "[plugins.\"a@m\"]\nremote_plugin_id = \"r\"\nrelease_id = \"x\"\nauto_provision = true\n", "a@m"},
		// Keys are split at the last "@", and each part is checked.
		{"keys", "[plugins.\"x@my.mkt\"]\n[plugins.\".x@m\"]\n[plugins.\"a..b@m\"]\n[plugins.\"a@b@c\"]\n[plugins.\"nomkt\"]\n[plugins.\"@m\"]\n[plugins.\"a.b@m\"]\n[plugins.\"a-b_c@m-1\"]\n", "a-b_c@m-1 a.b@m"},
		// Keys match exactly, as serde matches them.
		{"key case", "[plugins.\"a@m\"]\nEnabled = false\n[Plugins.\"b@m\"]\n", "a@m"},
		{"features not a table", "features = 1\n[plugins.\"a@m\"]\n", ""},
		{"default not a table", "[plugins]\n_default = 1\n[plugins.\"a@m\"]\n", ""},
		{"mcp not a table", "[plugins.\"a@m\"]\nmcp_servers = 1\n", ""},
		{"mcp server not a table", "[plugins.\"a@m\".mcp_servers]\nx = 1\n", ""},
		{"mcp tools not a table", "[plugins.\"a@m\".mcp_servers.x]\ntools = 1\n", ""},
		{"mcp tool not a table", "[plugins.\"a@m\".mcp_servers.x.tools]\nt = 1\n", ""},
		{"mcp tools not a list", "[plugins.\"a@m\".mcp_servers.x]\ndisabled_tools = \"t\"\n", ""},
		{"mcp limit not a number", "[plugins.\"a@m\".mcp_servers.x.tools.t]\noutput_token_limit = \"9\"\n", ""},
		{"openai", "[plugins.\"a@openai-bundled\"]\n[plugins.\"b@openai-primary-runtime\"]\n[plugins.\"c@openai\"]\n", "c@openai"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			home := t.TempDir()
			if c.config != "" {
				writeFile(t, filepath.Join(home, "config.toml"), c.config)
			}
			var got []string
			for _, id := range codexEnabledPlugins(readCodexConfig(home)) {
				got = append(got, id.name+"@"+id.marketplace)
			}
			if s := strings.Join(got, " "); s != c.want {
				t.Errorf("plugins = %q, want %q", s, c.want)
			}
		})
	}
}

func TestCodexEnabledPluginsFile(t *testing.T) {
	home := t.TempDir()
	// Over 1 MB: not read, even though it is valid TOML.
	writeFile(t, filepath.Join(home, "config.toml"), "[plugins.\"a@m\"]\n#"+strings.Repeat("x", pluginJSONMax))
	if got := codexEnabledPlugins(readCodexConfig(home)); len(got) != 0 {
		t.Errorf("large config = %v", got)
	}
	// A directory in its place.
	dirHome := t.TempDir()
	os.MkdirAll(filepath.Join(dirHome, "config.toml"), 0o755)
	if got := codexEnabledPlugins(readCodexConfig(dirHome)); len(got) != 0 {
		t.Errorf("dir config = %v", got)
	}
	// A symlink to a config elsewhere (a dotfile manager's) is read.
	linkHome, dotfiles := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(dotfiles, "codex.toml"), "[plugins.\"a@m\"]\n")
	symlinkOrSkip(t, filepath.Join(dotfiles, "codex.toml"), filepath.Join(linkHome, "config.toml"))
	if got := codexEnabledPlugins(readCodexConfig(linkHome)); len(got) != 1 {
		t.Errorf("linked config = %v", got)
	}
}

func TestCompareCodexPluginVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.10.0", "1.9.0", 1},
		{"1.0.0-rc1", "1.0.0", -1},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1},
		{"1.0.0-2", "1.0.0-10", -1},
		{"1.0.0-beta", "1.0.0-alpha", 1},
		// Build metadata only breaks a tie.
		{"1.0.0+b", "1.0.0", 1},
		{"1.0.1", "1.0.0+zzz", 1},
		{"1.0.0+2", "1.0.0+10", -1},
		{"1.0.0", "1.0.0", 0},
		{"1.0.0-alpha", "1.0.0-1", 1},
		{"1.0.0-1.a", "1.0.0-1.b", -1},
		{"1.0.0+01", "1.0.0+1", 1},
		{"2.0.0", "10.0.0", -1},
		{"1.0.0-12", "1.0.0-13", -1},
		// Not semver: an empty or odd identifier, in a pre-release or a build.
		{"1.0.0-a..b", "1.0.0", 1},
		{"1.0.0-a_b", "1.0.0", 1},
		{"1.0.0+a..b", "1.0.0", 1},
		{"1.2.0", "1.10.0", -1},
		// Not semver on either side: bytewise.
		{"9", "10", 1},
		{"1.0", "1.0.0", -1},
		{"01.0.0", "1.0.0", -1},
		{"1.0.0-01", "1.0.0", 1},
		{"v2.0.0", "1.0.0", 1},
	}
	for _, c := range cases {
		if got := compareCodexPluginVersions(c.a, c.b); got != c.want {
			t.Errorf("compare(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
		if got := compareCodexPluginVersions(c.b, c.a); got != -c.want {
			t.Errorf("compare(%q, %q) = %d, want %d", c.b, c.a, got, -c.want)
		}
	}
}

func TestCodexActivePluginDir(t *testing.T) {
	pick := func(t *testing.T, versions ...string) string {
		t.Helper()
		home := t.TempDir()
		for _, v := range versions {
			os.MkdirAll(filepath.Join(home, "plugins/cache/m/p", v), 0o755)
		}
		cacheDir := resolvedDir(filepath.Join(home, "plugins/cache"))
		cache, err := os.OpenRoot(cacheDir)
		if err != nil {
			t.Fatal(err)
		}
		defer cache.Close()
		visits := 0
		dir := codexActivePluginDir(cache, cacheDir, codexPluginID{"p", "m"}, &visits)
		if visits != len(versions) {
			t.Errorf("visits = %d", visits)
		}
		return filepath.Base(dir)
	}
	for _, c := range []struct {
		versions []string
		want     string
	}{
		{[]string{"1.0.0", "local", "2.0.0"}, "local"},
		{[]string{"1.9.0", "1.10.0"}, "1.10.0"},
		{[]string{"9", "10"}, "9"},
		{[]string{"1.0.0", "1.0.0-rc1"}, "1.0.0"},
		{[]string{"1.0.0", "bad name", "2.0.0 x"}, "1.0.0"},
		{[]string{"bad name"}, "."},
	} {
		if got := pick(t, c.versions...); got != c.want {
			t.Errorf("versions %v = %q, want %q", c.versions, got, c.want)
		}
	}

	// A version that is a symlink, a file or a junction is not a version.
	home, outside := t.TempDir(), t.TempDir()
	base := filepath.Join(home, "plugins/cache/m/p")
	os.MkdirAll(filepath.Join(base, "1.0.0"), 0o755)
	writeFile(t, filepath.Join(base, "3.0.0"), "a file")
	symlinkOrSkip(t, outside, filepath.Join(base, "2.0.0"))
	cacheDir := resolvedDir(filepath.Join(home, "plugins/cache"))
	cache, _ := os.OpenRoot(cacheDir)
	defer cache.Close()
	visits := commandsMaxVisited - 1
	if got := codexActivePluginDir(cache, cacheDir, codexPluginID{"p", "m"}, &visits); got != "" {
		t.Errorf("over budget = %q", got)
	}
	visits = 0
	if got := codexActivePluginDir(cache, cacheDir, codexPluginID{"p", "m"}, &visits); filepath.Base(got) != "1.0.0" {
		t.Errorf("linked version = %q", got)
	}
	if visits = commandsMaxVisited; codexActivePluginDir(cache, cacheDir, codexPluginID{"p", "m"}, &visits) != "" {
		t.Error("read with no budget left")
	}
}

func TestCodexPluginManifest(t *testing.T) {
	agentSchema := `"$schema":"` + agentPluginSchemaURI + `"`
	cases := []struct {
		name  string
		files map[string]string
		ns    string
		roots string // "" when there is no manifest
	}{
		{"codex", map[string]string{".codex-plugin/plugin.json": `{"name":"atk","skills":"./skills/"}`}, "atk", "skills"},
		{"claude", map[string]string{".claude-plugin/plugin.json": `{"name":"c"}`}, "c", "skills"},
		{"cursor", map[string]string{".cursor-plugin/plugin.json": `{"name":"u"}`}, "u", "skills"},
		{"codex first", map[string]string{".codex-plugin/plugin.json": `{"name":"a"}`, ".claude-plugin/plugin.json": `{"name":"b"}`}, "a", "skills"},
		{"blank name", map[string]string{".codex-plugin/plugin.json": `{"name":"  "}`}, "1.0.0", "skills"},
		{"no name", map[string]string{".codex-plugin/plugin.json": `{}`}, "1.0.0", "skills"},
		{"list", map[string]string{".codex-plugin/plugin.json": `{"skills":["./b","./a/","./a","./skills"]}`}, "1.0.0", "a b skills"},
		{"outside", map[string]string{".codex-plugin/plugin.json": `{"skills":["../x","/abs","x","./","./a/../../b"]}`}, "1.0.0", "skills"},
		{"mixed list", map[string]string{".codex-plugin/plugin.json": `{"skills":["./a",1]}`}, "1.0.0", "skills"},
		{"not paths", map[string]string{".codex-plugin/plugin.json": `{"skills":{"a":1}}`}, "1.0.0", "skills"},
		{"bad type", map[string]string{".codex-plugin/plugin.json": `{"name":"a","version":1}`}, "", ""},
		{"null name", map[string]string{".codex-plugin/plugin.json": `{"name":null}`}, "", ""},
		{"null keyword", map[string]string{".codex-plugin/plugin.json": `{"keywords":["a",null]}`}, "", ""},
		{"interface not object", map[string]string{".codex-plugin/plugin.json": `{"interface":"x"}`}, "", ""},
		{"bad interface", map[string]string{".codex-plugin/plugin.json": `{"interface":{"capabilities":"x"}}`}, "", ""},
		{"ok interface", map[string]string{".codex-plugin/plugin.json": `{"interface":{"displayName":"X","logo":null},"mcpServers":{"a":1},"hooks":7}`}, "1.0.0", "skills"},
		// Keys match exactly, as in serde; a Legacy manifest naming a field
		// twice is refused.
		{"case", map[string]string{".codex-plugin/plugin.json": `{"Name":"foo","SKILLS":"./x"}`}, "1.0.0", "skills"},
		{"duplicate", map[string]string{".codex-plugin/plugin.json": `{"name":"a","name":"b"}`}, "", ""},
		{"duplicate interface", map[string]string{".codex-plugin/plugin.json": `{"interface":{"logo":"a","logo":"b"}}`}, "", ""},
		{"trailing", map[string]string{".codex-plugin/plugin.json": `{"name":"a"} {}`}, "", ""},
		{"null skills", map[string]string{".codex-plugin/plugin.json": `{"name":"a","skills":null}`}, "a", "skills"},
		{"agent duplicate", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"x","name":"ag"}`}, "ag", "skills"},
		{"agent schema case", map[string]string{"plugin.json": `{"$SCHEMA":"` + agentPluginSchemaURI + `","name":"ag"}`, ".codex-plugin/plugin.json": `{"name":"legacy"}`}, "legacy", "skills"},
		{"not json", map[string]string{".codex-plugin/plugin.json": `{`}, "", ""},
		{"array", map[string]string{".codex-plugin/plugin.json": `[]`}, "", ""},
		{"none", map[string]string{"skills/a/SKILL.md": "x"}, "", ""},
		// A root plugin.json is an Agent Plugins manifest only with its $schema.
		{"agent", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"ag","skills":"./custom","author":{"name":"me"}}`, ".codex-plugin/plugin.json": `{"name":"legacy"}`}, "ag", "skills"},
		{"agent bad name", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"Ag"}`}, "", ""},
		{"agent null", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"ag","version":null}`}, "", ""},
		{"agent author not object", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"ag","author":"me"}`}, "", ""},
		{"agent author null", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"ag","author":{"name":null}}`}, "", ""},
		{"agent author number", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"ag","author":{"url":1}}`}, "", ""},
		{"agent keywords", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"ag","keywords":"a"}`}, "", ""},
		{"agent no name", map[string]string{"plugin.json": `{` + agentSchema + `}`}, "", ""},
		{"agent author", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"ag","author":{"nick":"x"}}`}, "", ""},
		{"agent extension", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"ag","extensions":{"com.openai":{"version":2}}}`}, "", ""},
		{"agent other extension", map[string]string{"plugin.json": `{` + agentSchema + `,"name":"ag","extensions":{"com.openai":"x","other":1}}`}, "ag", "skills"},
		{"unsupported schema", map[string]string{"plugin.json": `{"$schema":"https://agent-plugins.org/schemas/2.0.0/plugin.schema.json","name":"ag"}`, ".codex-plugin/plugin.json": `{"name":"legacy"}`}, "", ""},
		{"other schema", map[string]string{"plugin.json": `{"$schema":"https://example.com/s.json"}`, ".codex-plugin/plugin.json": `{"name":"legacy"}`}, "legacy", "skills"},
		{"root not json", map[string]string{"plugin.json": `nope`, ".codex-plugin/plugin.json": `{"name":"legacy"}`}, "legacy", "skills"},
		{"too large", map[string]string{".codex-plugin/plugin.json": `{"name":"a","x":"` + strings.Repeat("x", pluginJSONMax) + `"}`}, "", ""},
		// A manifest dir that is a file ends the search.
		{"dir is a file", map[string]string{".codex-plugin": "x", ".claude-plugin/plugin.json": `{"name":"c"}`}, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "1.0.0")
			os.MkdirAll(dir, 0o755)
			for rel, body := range c.files {
				writeFile(t, filepath.Join(dir, rel), body)
			}
			m, ok := codexPluginManifest(dir, nil)
			ns, roots := m.ns, m.roots
			got := strings.Join(roots, " ")
			if c.roots == "" {
				if ok {
					t.Errorf("manifest found: %q %q", ns, got)
				}
				return
			}
			if !ok || ns != c.ns || got != c.roots {
				t.Errorf("manifest = %v %q %q, want %q %q", ok, ns, got, c.ns, c.roots)
			}
		})
	}

	t.Run("many roots", func(t *testing.T) {
		dir := t.TempDir()
		paths := make([]string, 0, 10000)
		for i := range 10000 {
			paths = append(paths, fmt.Sprintf(`"./r%d"`, i%20))
		}
		writeFile(t, filepath.Join(dir, ".codex-plugin/plugin.json"), `{"skills":[`+strings.Join(paths, ",")+`]}`)
		m, ok := codexPluginManifest(dir, nil)
		roots := m.roots
		if !ok || len(roots) != codexPluginMaxSkillRoots || roots[0] != "r0" {
			t.Errorf("roots = %v", roots)
		}
	})

	t.Run("skip", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, ".codex-plugin/plugin.json"), `{"name":"a"}`)
		writeFile(t, filepath.Join(dir, ".claude-plugin/plugin.json"), `{"name":"b"}`)
		skip := func(_, rel string) bool { return strings.HasPrefix(rel, ".codex-plugin") }
		if _, ok := codexPluginManifest(dir, skip); ok {
			t.Error("a refused manifest was read, or the next one used")
		}
	})

	t.Run("symlinks", func(t *testing.T) {
		outside := t.TempDir()
		writeFile(t, filepath.Join(outside, "plugin.json"), `{"name":"leaked"}`)
		for _, link := range []string{".codex-plugin/plugin.json", "plugin.json"} {
			dir := t.TempDir()
			writeFile(t, filepath.Join(dir, ".claude-plugin/plugin.json"), `{"name":"real"}`)
			os.MkdirAll(filepath.Join(dir, ".codex-plugin"), 0o755)
			symlinkOrSkip(t, filepath.Join(outside, "plugin.json"), filepath.Join(dir, link))
			if m, ok := codexPluginManifest(dir, nil); ok {
				t.Errorf("%s linked: manifest %q", link, m.ns)
			}
		}
		// The manifest's dir as a symlink.
		dir := t.TempDir()
		writeFile(t, filepath.Join(outside, "m/plugin.json"), `{"name":"leaked"}`)
		symlinkOrSkip(t, filepath.Join(outside, "m"), filepath.Join(dir, ".codex-plugin"))
		if m, ok := codexPluginManifest(dir, nil); ok {
			t.Errorf("linked dir: manifest %q", m.ns)
		}
	})
}

func TestReadCodexPluginSkillsNames(t *testing.T) {
	useAdminSkills(t, "")
	home := t.TempDir()
	writeFile(t, filepath.Join(home, "config.toml"), "[plugins.\"a@m\"]\n[plugins.\"a2@m\"]\n[plugins.\"b@m\"]\n[plugins.\"c@m\"]\n[plugins.\"d@m\"]\n")
	// No name: the version dir names the plugin; "2.0.0:x" could not
	// follow "$".
	writeCodexPlugin(t, home, "m", "a", "local", `{"name":""}`, "x")
	writeCodexPlugin(t, home, "m", "a2", "2.0.0", `{"name":""}`, "x")
	// A namespace that cannot follow "$".
	writeCodexPlugin(t, home, "m", "b", "1.0.0", `{"name":"my.plugin"}`, "x")
	// A skill named with a character Codex does not take after "$".
	dir := writeCodexPlugin(t, home, "m", "c", "1.0.0", `{"name":"c"}`, "ok")
	writeFile(t, filepath.Join(dir, "skills/dotted/SKILL.md"), skill("do.tted", "x"))
	// Skill dirs from the manifest, one hidden from the menu.
	dir = writeCodexPlugin(t, home, "m", "d", "1.0.0", `{"name":"d","skills":["./more","./skills"]}`, "s1")
	writeFile(t, filepath.Join(dir, "more/s2/SKILL.md"), skill("s2", "x"))
	writeFile(t, filepath.Join(dir, "more/h/SKILL.md"), "---\nname: h\nuser-invocable: false\n---\n")
	if got := pluginNames(pluginSkills(home, nil)); got != "local:x c:ok d:s2 d:s1" {
		t.Errorf("skills = %q", got)
	}
	for _, c := range pluginSkills(home, nil) {
		if c.Source != "plugin" || c.Kind != "skill" || strings.Contains(c.Description, "SECRET") {
			t.Errorf("entry = %+v", c)
		}
	}
}

func TestReadCodexPluginSkillsLimits(t *testing.T) {
	home := t.TempDir()
	var cfg strings.Builder
	for i := range commandsMaxPlugins + 5 {
		name := fmt.Sprintf("p%02d", i)
		cfg.WriteString("[plugins.\"" + name + "@m\"]\n")
		writeCodexPlugin(t, home, "m", name, "1.0.0", `{"name":"`+name+`"}`, "s")
	}
	writeFile(t, filepath.Join(home, "config.toml"), cfg.String())
	// Enabled, nothing installed.
	if got := pluginSkills(t.TempDir(), nil); got != nil {
		t.Errorf("no codex home config = %v", got)
	}
	if got := pluginSkills(home, nil); len(got) != commandsMaxPlugins {
		t.Errorf("%d plugins read", len(got))
	}

	// Each plugin walks its skill dirs on a budget of its own: a plugin with
	// a huge tree does not hide the skills of the next one.
	home = t.TempDir()
	writeFile(t, filepath.Join(home, "config.toml"), "[plugins.\"a@m\"]\n[plugins.\"b@m\"]\n")
	dir := writeCodexPlugin(t, home, "m", "a", "1.0.0", `{"name":"a"}`, "a-first")
	for i := range codexSkillMaxDirs + 10 {
		os.MkdirAll(filepath.Join(dir, "skills", fmt.Sprintf("e%05d", i)), 0o755)
	}
	writeCodexPlugin(t, home, "m", "b", "1.0.0", `{"name":"b"}`, "late1", "late2", "late3")
	if got := pluginNames(pluginSkills(home, nil)); got != "a:a-first b:late1 b:late2 b:late3" {
		t.Errorf("skills = %s", got)
	}
}

func TestReadCodexPluginSkillsSymlinks(t *testing.T) {
	useAdminSkills(t, "")
	real, outside := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(real, "config.toml"), "[plugins.\"a@m\"]\n")
	dir := writeCodexPlugin(t, real, "m", "a", "1.0.0", `{"name":"a","skills":["./skills","./out"]}`, "in")
	writeFile(t, filepath.Join(outside, "o/SKILL.md"), skill("o", "outside"))
	writeFile(t, filepath.Join(dir, "shared/linked/SKILL.md"), skill("linked", "inside the plugin"))
	// A skill dir, and a skill root, that lead out of the plugin; one that
	// stays in it.
	symlinkOrSkip(t, filepath.Join(outside, "o"), filepath.Join(dir, "skills/o"))
	symlinkOrSkip(t, outside, filepath.Join(dir, "out"))
	symlinkOrSkip(t, filepath.Join(dir, "shared/linked"), filepath.Join(dir, "skills/linked"))
	// CODEX_HOME itself a symlink: followed.
	link := filepath.Join(t.TempDir(), "codex")
	symlinkOrSkip(t, real, link)
	if got := pluginNames(pluginSkills(link, nil)); got != "a:in a:linked" {
		t.Errorf("skills = %q", got)
	}

	// A version dir that is a link to an install is not one.
	home := t.TempDir()
	writeFile(t, filepath.Join(home, "config.toml"), "[plugins.\"a@m\"]\n")
	os.MkdirAll(filepath.Join(home, "plugins/cache/m/a"), 0o755)
	symlinkOrSkip(t, filepath.Join(real, "plugins/cache/m/a/1.0.0"), filepath.Join(home, "plugins/cache/m/a/2.0.0"))
	if got := pluginSkills(home, nil); len(got) != 0 {
		t.Errorf("linked version = %v", got)
	}
}

func TestReadCodexPluginSkillsSkip(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, "config.toml"), "[plugins.\"a@m\"]\n")
	dir := writeCodexPlugin(t, home, "m", "a", "1.0.0", `{"name":"a","skills":["./skills","./denied"]}`, "ok", "id_rsa")
	writeFile(t, filepath.Join(dir, "denied/x/SKILL.md"), skill("x", "x"))
	var asked []string
	skip := func(_, rel string) bool {
		asked = append(asked, rel)
		return rel == "denied" || strings.Contains(rel, "id_rsa")
	}
	if got := pluginNames(pluginSkills(home, skip)); got != "a:ok" {
		t.Errorf("skills = %q", got)
	}
	for _, rel := range asked {
		if strings.HasPrefix(rel, "denied"+string(filepath.Separator)) {
			t.Errorf("read under a denied dir: %s", rel)
		}
	}
}

func TestValidCodexNames(t *testing.T) {
	for v, want := range map[string]bool{"1.0.0+b_1": true, "local": true, "": false, ".": false, "..": false, "1 0": false, "a/b": false} {
		if got := validCodexPluginVersion(v); got != want {
			t.Errorf("version %q = %v", v, got)
		}
	}
	for n, want := range map[string]bool{"a.b-c1": true, "a--b": false, "a..b": false, "-a": false, "a-": false, "A": false, "a_b": false, "": false, strings.Repeat("a", 65): false, strings.Repeat("a", 64): true} {
		if got := validAgentPluginName(n); got != want {
			t.Errorf("agent name %q = %v", n, got)
		}
	}
	for p, want := range map[string]string{"./a/b/": "a/b", "./a/./b": "a/b", "./a..b": "a..b", "../a": "", "./": "", "a": "", "./a/../b": "", ".//x": ""} {
		if got, ok := codexManifestPath(p); got != want || ok != (want != "") {
			t.Errorf("path %q = %q %v", p, got, ok)
		}
	}
	// A backslash separates on Windows only, as in Codex.
	got, ok := codexManifestPath(`./a\..\b`)
	if runtime.GOOS == "windows" {
		if ok {
			t.Errorf(`backslash ".." accepted: %q`, got)
		}
		for _, p := range []string{`./\abs`, `./C:\x`} {
			if _, ok := codexManifestPath(p); ok {
				t.Errorf("%q accepted", p)
			}
		}
	} else if !ok {
		t.Error("a name with a backslash refused")
	}
}

func TestReadCodexPluginSkillsMaxTotal(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, "config.toml"), "[plugins.\"a@m\"]\n[plugins.\"b@m\"]\n")
	for _, p := range []struct {
		name string
		n    int
	}{{"a", codexSkillMaxTotal - 3}, {"b", 10}} {
		dir := writeCodexPlugin(t, home, "m", p.name, "1.0.0", `{"name":"`+p.name+`"}`)
		for i := range p.n {
			writeFile(t, filepath.Join(dir, "skills", fmt.Sprintf("s%04d", i), "SKILL.md"), skill(fmt.Sprintf("s%04d", i), "x"))
		}
	}
	got := pluginSkills(home, nil)
	if len(got) != codexSkillMaxTotal || got[len(got)-1].Name != "b:s0002" {
		t.Errorf("%d skills, last %v", len(got), got[len(got)-1])
	}
}

func TestReadCodexPluginSkillsNoCache(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, "config.toml"), "[plugins.\"a@m\"]\n")
	if got := pluginSkills(home, nil); got != nil {
		t.Errorf("no plugins/cache = %v", got)
	}
	if got := pluginSkills("", nil); got != nil {
		t.Errorf("no codex home = %v", got)
	}
}

// pluginSkills lists the plugin skills codexHome's config.toml enables, as
// the Chat view gets them.
func pluginSkills(codexHome string, skip func(dir, rel string) bool) []agentCommand {
	var out []agentCommand
	for _, s := range readCodexPluginSkills(readCodexConfig(codexHome), codexHome, skip, codexNow().Add(codexSkillDeadline)) {
		out = append(out, s.cmd)
	}
	return out
}

// A plugin dir that is a file, a plugins/cache that is a file, a manifest
// that is not one JSON object, and an Agent Plugin manifest that is not an
// object: each reads as no plugin.
func TestCodexUnreadablePluginInputs(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	writeFile(t, file, "x")
	if _, ok := codexPluginManifest(file, nil); ok {
		t.Error("manifest of a plugin dir that is a file")
	}
	home := t.TempDir()
	writeFile(t, filepath.Join(home, "config.toml"), "[plugins.\"a@m\"]\n")
	writeFile(t, filepath.Join(home, "plugins", "cache"), "x")
	if got := pluginSkills(home, nil); got != nil {
		t.Errorf("plugins/cache is a file = %v", got)
	}
	if _, ok := parseAgentPluginManifest([]byte(`["x"]`)); ok {
		t.Error("agent manifest that is an array")
	}
	if _, _, ok := jsonMembers([]byte(`{"a":1 x}`)); ok {
		t.Error("object with junk after a member decoded")
	}
}
