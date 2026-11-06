package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// linkDir makes link lead to the dir target: a junction on Windows (no
// privilege needed), a symlink elsewhere.
func linkDir(t *testing.T, link, target string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
			t.Fatalf("mklink /J %s %s: %v %s", link, target, err, out)
		}
		return
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

// A kit laid out the way some installers lay one out: a link in ~/.claude/skills to
// an install dir holding .claude-plugin/plugin.json, whose commands/ and
// skill dirs are links into a store elsewhere under home.
func TestListAgentCommandsSkillBundles(t *testing.T) {
	claude, home, outside := t.TempDir(), t.TempDir(), t.TempDir()
	store := filepath.Join(home, ".kit/store")
	writeFile(t, filepath.Join(store, "skills/a/SKILL.md"), "---\nname: a\ndescription: Skill A\n---\nSECRET BODY")
	writeFile(t, filepath.Join(store, "skills/hidden/SKILL.md"), "---\nuser-invocable: false\ndescription: x\n---\n")
	writeFile(t, filepath.Join(store, "commands/x.md"), "---\ndescription: Cmd X\n---\n")
	writeFile(t, filepath.Join(store, "commands/sub/y.md"), "Cmd Y")
	writeFile(t, filepath.Join(outside, "skills/o/SKILL.md"), "---\ndescription: outside\n---\n")
	install := filepath.Join(home, ".kit/install")
	writeFile(t, filepath.Join(install, ".claude-plugin/plugin.json"), `{"name":"kit","version":"1"}`)
	linkDir(t, filepath.Join(install, "skills/a"), filepath.Join(store, "skills/a"))
	linkDir(t, filepath.Join(install, "skills/hidden"), filepath.Join(store, "skills/hidden"))
	// A skill dir leaving home is not followed.
	linkDir(t, filepath.Join(install, "skills/out"), filepath.Join(outside, "skills/o"))
	linkDir(t, filepath.Join(install, "commands"), filepath.Join(store, "commands"))
	linkDir(t, filepath.Join(claude, "skills/kit"), install)

	// A real bundle dir with no name in its manifest is named by its dir.
	writeFile(t, filepath.Join(claude, "skills/plain/.claude-plugin/plugin.json"), "{}")
	writeFile(t, filepath.Join(claude, "skills/plain/skills/b/SKILL.md"), "---\ndescription: B\n---\n")
	// A dir with SKILL.md stays a skill, manifest or not.
	writeFile(t, filepath.Join(claude, "skills/both/SKILL.md"), "---\ndescription: plain skill\n---\n")
	writeFile(t, filepath.Join(claude, "skills/both/.claude-plugin/plugin.json"), `{"name":"both"}`)
	writeFile(t, filepath.Join(claude, "skills/both/skills/z/SKILL.md"), "z")
	// No bundle: a name with a colon, a manifest that is not JSON, a bundle
	// outside home and every allowed dir.
	writeFile(t, filepath.Join(claude, "skills/bad/.claude-plugin/plugin.json"), `{"name":"a:b"}`)
	writeFile(t, filepath.Join(claude, "skills/bad/skills/c/SKILL.md"), "c")
	writeFile(t, filepath.Join(claude, "skills/broken/.claude-plugin/plugin.json"), "{")
	writeFile(t, filepath.Join(claude, "skills/broken/skills/d/SKILL.md"), "d")
	writeFile(t, filepath.Join(outside, "far/.claude-plugin/plugin.json"), `{"name":"far"}`)
	writeFile(t, filepath.Join(outside, "far/skills/f/SKILL.md"), "f")
	linkDir(t, filepath.Join(claude, "skills/far"), filepath.Join(outside, "far"))
	// Home's own dirs that are not hidden are out of reach: a bundle there,
	// and a bundle's commands/ or skill dir leading there.
	writeFile(t, filepath.Join(home, "notes/n.md"), "---\ndescription: private note\n---\n")
	writeFile(t, filepath.Join(home, "notes/s/SKILL.md"), "---\ndescription: private skill\n---\n")
	writeFile(t, filepath.Join(home, "visible/.claude-plugin/plugin.json"), `{"name":"visible"}`)
	writeFile(t, filepath.Join(home, "visible/skills/v/SKILL.md"), "v")
	linkDir(t, filepath.Join(claude, "skills/visible"), filepath.Join(home, "visible"))
	writeFile(t, filepath.Join(home, ".kit/peek/.claude-plugin/plugin.json"), `{"name":"peek"}`)
	linkDir(t, filepath.Join(home, ".kit/peek/commands"), filepath.Join(home, "notes"))
	linkDir(t, filepath.Join(home, ".kit/peek/skills/s"), filepath.Join(home, "notes/s"))
	linkDir(t, filepath.Join(claude, "skills/peek"), filepath.Join(home, ".kit/peek"))
	// A manifest over the size cap.
	writeFile(t, filepath.Join(claude, "skills/huge/.claude-plugin/plugin.json"), `{"name":"huge","x":"`+strings.Repeat("a", pluginJSONMax)+`"}`)
	writeFile(t, filepath.Join(claude, "skills/huge/skills/h/SKILL.md"), "h")

	got := listAgentCommands("", claude, home, nil).Commands
	want := []agentCommand{
		{"both", "plain skill", "user", "skill"},
		{"kit:sub:y", "Cmd Y", "plugin", "command"},
		{"kit:x", "Cmd X", "plugin", "command"},
		{"kit:a", "Skill A", "plugin", "skill"},
		{"plain:b", "B", "plugin", "skill"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("commands =\n%v\nwant\n%v", got, want)
	}
	for _, c := range got {
		if strings.Contains(c.Description, "SECRET") {
			t.Errorf("a skill body leaked: %+v", c)
		}
	}

	// Without a home only the bundle inside the Claude dir is read.
	got = listAgentCommands("", claude, "", nil).Commands
	want = []agentCommand{{"both", "plain skill", "user", "skill"}, {"plain:b", "B", "plugin", "skill"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("no home: commands =\n%v\nwant\n%v", got, want)
	}

	// skip sees a linked file from the allowed dir holding it (home here),
	// a dir on the way included.
	skip := func(dir, rel string) bool {
		return rel == filepath.Join(".kit", "store", "commands", "x.md") ||
			rel == filepath.Join("skills", "plain", ".claude-plugin", "plugin.json") ||
			strings.HasPrefix(rel, filepath.Join(".kit", "store", "skills")+string(filepath.Separator))
	}
	got = listAgentCommands("", claude, home, skip).Commands
	want = []agentCommand{{"both", "plain skill", "user", "skill"}, {"kit:sub:y", "Cmd Y", "plugin", "command"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("skip: commands =\n%v\nwant\n%v", got, want)
	}
}

// A bundle in the pane's project is never read: a cloned repo cannot widen
// where links lead.
func TestListAgentCommandsSkillBundleNotInRoot(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".claude/skills/pb/.claude-plugin/plugin.json"), `{"name":"pb"}`)
	writeFile(t, filepath.Join(root, ".claude/skills/pb/skills/s/SKILL.md"), "s")
	if got := listAgentCommands(root, t.TempDir(), t.TempDir(), nil).Commands; len(got) != 0 {
		t.Fatalf("project bundle listed: %v", got)
	}
}

func TestListAgentCommandsSkillBundleLimits(t *testing.T) {
	claude := t.TempDir()
	for i := range commandsMaxPlugins + 1 {
		b := filepath.Join(claude, "skills", fmt.Sprintf("b%02d", i))
		writeFile(t, filepath.Join(b, ".claude-plugin/plugin.json"), "{}")
		writeFile(t, filepath.Join(b, "skills/s/SKILL.md"), "s")
	}
	got := listAgentCommands("", claude, "", nil).Commands
	if len(got) != commandsMaxPlugins || got[len(got)-1].Name != fmt.Sprintf("b%02d:s", commandsMaxPlugins-1) {
		t.Fatalf("got %d entries, last %+v", len(got), got[len(got)-1])
	}

	// One cap across bundles: the second is read only up to it.
	claude = t.TempDir()
	for i := range commandsMaxPerSource - 1 {
		writeFile(t, filepath.Join(claude, "skills/a/commands", fmt.Sprintf("c%03d.md", i)), "x")
	}
	for _, b := range []string{"a", "b"} {
		writeFile(t, filepath.Join(claude, "skills", b, ".claude-plugin/plugin.json"), "{}")
	}
	writeFile(t, filepath.Join(claude, "skills/b/commands/one.md"), "x")
	writeFile(t, filepath.Join(claude, "skills/b/commands/two.md"), "x")
	got = listAgentCommands("", claude, "", nil).Commands
	if len(got) != commandsMaxPerSource || got[len(got)-1].Name != "b:one" {
		t.Fatalf("got %d entries, last %+v", len(got), got[len(got)-1])
	}
}
