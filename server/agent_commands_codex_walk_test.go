package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// walkNames walks dir/rel with opts (a fresh budget when none is set) and
// returns the skills' names.
func walkNames(dir, rel string, o codexWalkOpts) string {
	if o.budget == nil {
		o.budget = &codexBudget{deadline: codexNow().Add(time.Minute)}
	}
	var names []string
	for _, s := range walkCodexSkills(dir, rel, o) {
		names = append(names, s.cmd.Name)
	}
	return strings.Join(names, " ")
}

func TestWalkCodexSkillsDepth(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "SKILL.md"), skill("top", "the root's own"))
	writeFile(t, filepath.Join(dir, "a/SKILL.md"), skill("a", "x"))
	writeFile(t, filepath.Join(dir, "group/deploy/SKILL.md"), skill("deploy", "x"))
	writeFile(t, filepath.Join(dir, "d0/d1/d2/d3/d4/d5/SKILL.md"), skill("six", "six dirs down"))
	writeFile(t, filepath.Join(dir, "d0/d1/d2/d3/d4/d5/d6/SKILL.md"), skill("seven", "too deep"))
	// A skill inside a skill is listed too, as Codex walks on below one.
	writeFile(t, filepath.Join(dir, "a/inner/SKILL.md"), skill("inner", "x"))
	writeFile(t, filepath.Join(dir, ".hidden/SKILL.md"), skill("hidden", "x"))
	writeFile(t, filepath.Join(dir, "g/.cache/x/SKILL.md"), skill("cached", "x"))
	writeFile(t, filepath.Join(dir, "lower/skill.md"), skill("lower", "not SKILL.md"))
	writeFile(t, filepath.Join(dir, "file/SKILL.md/x"), "SKILL.md is a dir here")

	if got := walkNames(dir, ".", codexWalkOpts{recursive: true}); got != "top a inner deploy six" {
		t.Errorf("recursive = %q", got)
	}
	// An Agent Plugin's dirs: one level, not the root's own.
	if got := walkNames(dir, ".", codexWalkOpts{}); got != "a" {
		t.Errorf("direct = %q", got)
	}
	// Missing, relative, refused by skip.
	if got := walkNames(dir, "gone", codexWalkOpts{recursive: true}); got != "" {
		t.Errorf("missing = %q", got)
	}
	if got := walkNames("rel", ".", codexWalkOpts{recursive: true}); got != "" {
		t.Errorf("relative = %q", got)
	}
	skip := func(_, rel string) bool {
		r := filepath.ToSlash(rel)
		return strings.Contains(r, "group") || r == "a" || r == "SKILL.md"
	}
	if got := walkNames(dir, ".", codexWalkOpts{recursive: true, skip: skip}); got != "six" {
		t.Errorf("skip = %q", got)
	}
}

func TestWalkCodexSkillsLimits(t *testing.T) {
	dir := t.TempDir()
	// Breadth first: the shallow skills are kept when the budget runs out.
	writeFile(t, filepath.Join(dir, "a-shallow/SKILL.md"), skill("shallow", "x"))
	for i := range 30 {
		os.MkdirAll(filepath.Join(dir, fmt.Sprintf("deep%02d/x/y", i)), 0o755)
	}
	writeFile(t, filepath.Join(dir, "deep29/x/y/SKILL.md"), skill("deep", "x"))
	o := codexWalkOpts{recursive: true, budget: &codexBudget{dirs: codexSkillMaxDirs - 40, deadline: codexNow().Add(time.Minute)}}
	for range 3 {
		if got := walkNames(dir, ".", o); got != "shallow" {
			t.Fatalf("cut short = %q", got)
		}
		o.budget = &codexBudget{dirs: codexSkillMaxDirs - 40, deadline: codexNow().Add(time.Minute)}
	}
	o.budget = &codexBudget{entries: codexSkillMaxEntries, deadline: codexNow().Add(time.Minute)}
	if got := walkNames(dir, ".", o); got != "" {
		t.Errorf("no entries left = %q", got)
	}
	// Past the deadline nothing more is read.
	o.budget = &codexBudget{deadline: codexNow().Add(-time.Second)}
	if got := walkNames(dir, ".", o); got != "" {
		t.Errorf("past the deadline = %q", got)
	}
	// A dir too big to read whole is skipped, the others are not.
	big := t.TempDir()
	writeFile(t, filepath.Join(big, "ok/SKILL.md"), skill("ok", "x"))
	for i := range codexSkillMaxDirEntries + 1 {
		os.MkdirAll(filepath.Join(big, "huge", fmt.Sprintf("e%05d", i)), 0o755)
	}
	writeFile(t, filepath.Join(big, "huge/SKILL.md"), skill("huge", "x"))
	if got := walkNames(big, ".", codexWalkOpts{recursive: true}); got != "ok" {
		t.Errorf("huge dir = %q", got)
	}
	// One root reads at most codexSkillMaxDirs dirs, its own among them.
	many := t.TempDir()
	for i := range codexSkillMaxDirs + 3 {
		writeFile(t, filepath.Join(many, fmt.Sprintf("s%04d/SKILL.md", i)), skill(fmt.Sprintf("s%04d", i), "x"))
	}
	if n := len(walkCodexSkills(many, ".", codexWalkOpts{recursive: true, budget: &codexBudget{deadline: codexNow().Add(time.Minute)}})); n != codexSkillMaxDirs-1 {
		t.Errorf("%d skills", n)
	}
}

func TestWalkCodexSkillsSymlinks(t *testing.T) {
	dir, allowed, outside := t.TempDir(), t.TempDir(), t.TempDir()
	symlinkOrSkip(t, allowed, filepath.Join(t.TempDir(), "probe"))
	writeFile(t, filepath.Join(allowed, "pkg/real-name/SKILL.md"), "---\ndescription: named by the link's target\n---\n")
	writeFile(t, filepath.Join(allowed, ".private/p/SKILL.md"), skill("private", "behind a hidden dir"))
	writeFile(t, filepath.Join(allowed, "denied/d/SKILL.md"), skill("denied", "x"))
	writeFile(t, filepath.Join(outside, "o/SKILL.md"), skill("outside", "x"))
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	os.MkdirAll(filepath.Join(dir, "g"), 0o755)
	must(os.Symlink(filepath.Join(allowed, "pkg/real-name"), filepath.Join(dir, "link")))
	must(os.Symlink(filepath.Join(allowed, ".private"), filepath.Join(dir, "priv")))
	must(os.Symlink(filepath.Join(allowed, "denied"), filepath.Join(dir, "den")))
	must(os.Symlink(outside, filepath.Join(dir, "out")))
	must(os.Symlink(filepath.Join(allowed, "nowhere"), filepath.Join(dir, "dangling")))
	// A loop, and a link back to the walk's own root.
	must(os.Symlink(dir, filepath.Join(dir, "g/back")))
	must(os.Symlink(filepath.Join(dir, "g"), filepath.Join(dir, "g/self")))
	writeFile(t, filepath.Join(dir, "g/s/SKILL.md"), skill("g-s", "x"))
	realDir := resolvedDir(dir)
	o := codexWalkOpts{recursive: true, allow: []string{resolvedDir(allowed), realDir}, deny: []string{resolvedDir(filepath.Join(allowed, "denied"))}}
	if got := walkNames(dir, ".", o); got != "real-name g-s" {
		t.Errorf("followed = %q", got)
	}
	// Without allowed dirs (the system root), no link is followed.
	if got := walkNames(dir, ".", codexWalkOpts{recursive: true}); got != "g-s" {
		t.Errorf("not followed = %q", got)
	}
	// Depth counts across links: a chain of links ends six dirs down.
	chain := t.TempDir()
	prev := chain
	for i := range 8 {
		next := filepath.Join(t.TempDir(), "n")
		writeFile(t, filepath.Join(next, "SKILL.md"), skill(fmt.Sprintf("n%d", i), "x"))
		must(os.Symlink(next, filepath.Join(prev, "l")))
		prev = next
	}
	o = codexWalkOpts{recursive: true, allow: []string{resolvedDir(os.TempDir())}}
	if got := walkNames(chain, ".", o); got != "n0 n1 n2 n3 n4 n5" {
		t.Errorf("link chain = %q", got)
	}
}

func TestCodexSkillMeta(t *testing.T) {
	long := strings.Repeat("n", codexSkillNameMax)
	cases := []struct {
		head, name, desc string
		ok               bool
	}{
		{"---\nname: a\ndescription: d\n---\nbody", "a", "d", true},
		{"--- \nname: a\ndescription:   d   e \n ---\n", "a", "d e", true},
		{"---\ndescription: d\n---\n", "dir", "d", true},
		{"---\nname: ~\ndescription: d\n---\n", "dir", "d", true},
		{"---\nname: " + long + "\ndescription: d\n---\n", long, "d", true},
		{"---\nname: " + long + "x\ndescription: d\n---\n", "", "", false},
		{"---\ndescription: |\n  block\n  text\n---\n", "dir", "block text", true},
		{"---\ndescription: \"quoted: yes\"\n---\n", "dir", "quoted: yes", true},
		{"---\nuser-invocable: false\ndescription: d\n---\n", "dir", "d", true},
		{"---\nnot a key\n# a comment\n  indented\ndescription: d\n---\n", "dir", "d", true},
		{"no front matter\n", "", "", false},
		{"\uFEFF---\ndescription: d\n---\n", "", "", false},
		{"---\ndescription: d\n...\n", "", "", false},
		{"---\n---\n", "", "", false},
		{"---\nname: a\n---\nThe body is no description.", "", "", false},
		{"---\ndescription: null\n---\n", "", "", false},
		{"---\nname: \"null\"\ndescription: 'null'\n---\n", "null", "null", true},
		{"---\ndescription: \"  \"\n---\n", "", "", false},
		// Flow collections and values Codex quotes before parsing.
		{"---\ndescription: d\nkeywords: [a, b]\nargument-hint: [task] [--fast]\nx: @y\n---\n", "dir", "d", true},
		{"---\ndescription: d\ndescription: e\n---\n", "", "", false},
		{"---\nname: a\nname: b\ndescription: d\n---\n", "", "", false},
		{"---\ndescription: d\n", "", "", false},
	}
	for _, c := range cases {
		name, desc, ok := codexSkillMeta([]byte(c.head), "dir")
		if name != c.name || desc != c.desc || ok != c.ok {
			t.Errorf("%q = %q %q %v, want %q %q %v", c.head, name, desc, ok, c.name, c.desc, c.ok)
		}
	}
	if name, _, ok := codexSkillMeta([]byte("---\ndescription: d\n---\n"), "  "); !ok || name != "skill" {
		t.Errorf("blank dir name = %q %v", name, ok)
	}
	// Closed only past the read limit: Codex reads on, Termote does not.
	head := "---\ndescription: d\n" + strings.Repeat("x: y\n", commandHeadSize/5) + "---\n"
	if _, _, ok := codexSkillMeta([]byte(head[:commandHeadSize]), "dir"); ok {
		t.Error("front matter cut by the read limit accepted")
	}
}

func TestWalkCodexSkillsNames(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "long/SKILL.md"), skill(strings.Repeat("n", 60), "x"))
	writeFile(t, filepath.Join(dir, "unicode/SKILL.md"), skill("kiểm-tra", "x"))
	writeFile(t, filepath.Join(dir, "dotted/SKILL.md"), skill("a.b", "x"))
	writeFile(t, filepath.Join(dir, "plain/SKILL.md"), skill("_lead", "x"))
	// 60 + ":" + 60 = 121 runes: past validCommandName's 100, within Codex's 129.
	ns := strings.Repeat("p", 60)
	if got := walkNames(dir, ".", codexWalkOpts{recursive: true, prefix: ns + ":"}); got != ns+":"+strings.Repeat("n", 60)+" "+ns+":_lead" {
		t.Errorf("prefixed = %q", got)
	}
	ns = strings.Repeat("p", 70)
	if got := walkNames(dir, ".", codexWalkOpts{recursive: true, prefix: ns + ":"}); got != ns+":_lead" {
		t.Errorf("past 129 = %q", got)
	}
}

func TestWalkCodexSkillsNamespace(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".agents/skills")
	writeFile(t, filepath.Join(root, "plain/SKILL.md"), skill("plain", "x"))
	writeFile(t, filepath.Join(root, "vendor/.claude-plugin/plugin.json"), `{"name":"atk","version":1,"other":{}}`)
	writeFile(t, filepath.Join(root, "vendor/skills/review/SKILL.md"), skill("review", "x"))
	// A broken manifest further down falls back to the one above it.
	writeFile(t, filepath.Join(root, "vendor/skills/sub/.codex-plugin/plugin.json"), `{"name":`)
	writeFile(t, filepath.Join(root, "vendor/skills/sub/x/SKILL.md"), skill("x", "x"))
	// A valid one further down wins; a blank name is the dir's.
	writeFile(t, filepath.Join(root, "vendor/skills/inner/.cursor-plugin/plugin.json"), `{"name":" "}`)
	writeFile(t, filepath.Join(root, "vendor/skills/inner/y/SKILL.md"), skill("y", "x"))
	// The first manifest dir holding a file is the one read.
	os.MkdirAll(filepath.Join(root, "two/.codex-plugin"), 0o755)
	writeFile(t, filepath.Join(root, "two/.claude-plugin/plugin.json"), `{"name":"second"}`)
	writeFile(t, filepath.Join(root, "two/z/SKILL.md"), skill("z", "x"))
	// A name that is not a string, or set twice, gives no namespace.
	writeFile(t, filepath.Join(root, "bad/.codex-plugin/plugin.json"), `{"name":7}`)
	writeFile(t, filepath.Join(root, "bad/b/SKILL.md"), skill("b", "x"))
	writeFile(t, filepath.Join(root, "dup/.codex-plugin/plugin.json"), `{"name":"a","name":"b"}`)
	writeFile(t, filepath.Join(root, "dup/d/SKILL.md"), skill("d", "x"))

	o := codexWalkOpts{recursive: true, stop: resolvedDir(home)}
	want := "plain b d second:z atk:review inner:y atk:x"
	if got := walkNames(root, ".", o); got != want {
		t.Errorf("names = %q, want %q", got, want)
	}

	// A manifest above the root, up to stop, names every skill below it.
	repo := t.TempDir()
	writeFile(t, filepath.Join(repo, ".claude-plugin/plugin.json"), `{"name":"dev"}`)
	writeFile(t, filepath.Join(repo, ".agents/skills/review/SKILL.md"), skill("review", "x"))
	if got := walkNames(repo, ".agents/skills", codexWalkOpts{recursive: true, stop: resolvedDir(repo)}); got != "dev:review" {
		t.Errorf("repo manifest = %q", got)
	}
	// Not past stop.
	if got := walkNames(repo, ".agents/skills", codexWalkOpts{recursive: true, stop: resolvedDir(filepath.Join(repo, ".agents"))}); got != "review" {
		t.Errorf("past stop = %q", got)
	}
	// A manifest skip refuses gives no namespace.
	refuse := func(_, rel string) bool {
		return strings.HasSuffix(filepath.ToSlash(rel), ".claude-plugin/plugin.json")
	}
	if got := walkNames(root, "vendor", codexWalkOpts{recursive: true, skip: refuse}); got != "review inner:y x" {
		t.Errorf("refused manifest = %q", got)
	}
	// A plugin's skills keep its namespace: a manifest inside is not looked at.
	if got := walkNames(root, "vendor", codexWalkOpts{recursive: true, prefix: "atk:"}); got != "atk:review atk:y atk:x" {
		t.Errorf("plugin = %q", got)
	}
	// A manifest that is a symlink is not read.
	if runtime.GOOS != "windows" {
		lr := t.TempDir()
		writeFile(t, filepath.Join(t.TempDir(), "plugin.json"), `{"name":"linked"}`)
		os.MkdirAll(filepath.Join(lr, ".codex-plugin"), 0o755)
		os.Symlink(filepath.Join(lr, "nowhere.json"), filepath.Join(lr, ".codex-plugin/plugin.json"))
		writeFile(t, filepath.Join(lr, "s/SKILL.md"), skill("s", "x"))
		if got := walkNames(lr, ".", codexWalkOpts{recursive: true, stop: resolvedDir(lr)}); got != "s" {
			t.Errorf("linked manifest = %q", got)
		}
	}
}

// A root that is a file cannot be opened as one, and so lists nothing; the
// namespace search above it finds no manifest either.
func TestWalkCodexSkillsFileRoot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	writeFile(t, file, "x")
	if got := walkNames(file, ".", codexWalkOpts{source: "user", recursive: true}); got != "" {
		t.Errorf("walk of a file = %q", got)
	}
	if ns := codexAncestorNamespace(file, file, nil); ns != "" {
		t.Errorf("namespace of a file root = %q", ns)
	}
}

// A symlinked skill dir is named by a manifest above its target, as Codex
// names it from the target's canonical path.
func TestWalkCodexSkillsLinkedNamespace(t *testing.T) {
	home := t.TempDir()
	symlinkOrSkip(t, home, filepath.Join(t.TempDir(), "probe"))
	writeFile(t, filepath.Join(home, "plugins-src/atk/.claude-plugin/plugin.json"), `{"name":"atk"}`)
	writeFile(t, filepath.Join(home, "plugins-src/atk/skills/review/SKILL.md"), skill("review", "x"))
	root := filepath.Join(home, ".agents/skills")
	os.MkdirAll(root, 0o755)
	if err := os.Symlink(filepath.Join(home, "plugins-src/atk/skills/review"), filepath.Join(root, "review")); err != nil {
		t.Fatal(err)
	}
	o := codexWalkOpts{recursive: true, allow: []string{resolvedDir(home)}, stop: resolvedDir(home)}
	if got := walkNames(root, ".", o); got != "atk:review" {
		t.Errorf("linked skill = %q", got)
	}
}
