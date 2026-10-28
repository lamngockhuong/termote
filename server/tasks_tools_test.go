package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// discoverFiles lists the tasks of a root holding files (name → text).
func discoverFiles(t *testing.T, files map[string]string, deny ...string) paneTasks {
	t.Helper()
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	for name, text := range files {
		writeFile(t, filepath.Join(dir, name), text)
	}
	for i, d := range deny {
		deny[i] = filepath.Join(dir, d)
	}
	api := &tasksAPI{files: &filesAPI{deny: deny}}
	out, err := api.discover(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// toolGroupOf returns out's group of tool, nil when none.
func toolGroupOf(out paneTasks, tool string) *toolGroup {
	for i, g := range out.ToolGroups {
		if g.Tool == tool {
			return &out.ToolGroups[i]
		}
	}
	return nil
}

func toolNames(g *toolGroup) []string {
	if g == nil {
		return nil
	}
	var out []string
	for _, tt := range g.Tasks {
		out = append(out, tt.Name)
	}
	return out
}

func toolTaskOf(g *toolGroup, name string) toolTask {
	for _, tt := range g.Tasks {
		if tt.Name == name {
			return tt
		}
	}
	return toolTask{}
}

func TestToolGroupsOrderAndCommands(t *testing.T) {
	out := discoverFiles(t, map[string]string{
		"build.gradle":   "plugins { id 'java' }\n",
		"pom.xml":        "<project/>",
		"pyproject.toml": "[tool.pdm.scripts]\nlint = \"ruff .\"\n[tool.hatch.envs.default.scripts]\ncov = \"pytest\"\n[tool.poe.tasks]\nfmt = \"black .\"\n",
		"Cargo.toml":     "[package]\nname = \"x\"\n",
		"go.mod":         "module x\n",
		"justfile":       "hello:\n\techo hi\n",
		"Taskfile.yml":   "version: '3'\ntasks:\n  web:\n    cmds: [echo]\n",
		"composer.json":  `{"scripts":{"phpunit":"phpunit"}}`,
		"deno.json":      `{"tasks":{"dev":"deno run main.ts"}}`,
	})
	var tools []string
	for _, g := range out.ToolGroups {
		tools = append(tools, g.Tool)
	}
	if want := []string{"gradle", "maven", "pdm", "hatch", "poe", "cargo", "go", "just", "task", "composer", "deno"}; !slices.Equal(tools, want) {
		t.Fatalf("tools = %v", tools)
	}
	for tool, want := range map[string]string{
		"gradle": "gradle build", "maven": "mvn clean", "pdm": "pdm run lint", "hatch": "hatch run default:cov",
		"poe": "poe fmt", "cargo": "cargo build", "go": "go build ./...", "just": "just hello", "task": "task web",
		"composer": "composer run-script phpunit", "deno": "deno task dev",
	} {
		if g := toolGroupOf(out, tool); g.Tasks[0].Command != want || g.Label == "" || g.File == "" {
			t.Errorf("%s = %+v, want %q", tool, g, want)
		}
	}
	if len(out.Unreadable) != 0 || len(out.TooLarge) != 0 || out.Skipped != 0 {
		t.Errorf("unreadable %v, too large %v, skipped %d", out.Unreadable, out.TooLarge, out.Skipped)
	}
	if d := toolTaskOf(toolGroupOf(out, "deno"), "dev").Detail; d != "deno run main.ts" {
		t.Errorf("deno detail = %q", d)
	}
}

func TestDetectGradle(t *testing.T) {
	base := []string{"build", "test", "check", "clean", "assemble"}
	for _, tc := range []struct {
		files map[string]string
		file  string
		extra []string
	}{
		{map[string]string{"settings.gradle.kts": "rootProject.name = \"x\""}, "settings.gradle.kts", nil},
		{map[string]string{"settings.gradle": "", "build.gradle": ""}, "build.gradle", nil},
		{map[string]string{"build.gradle.kts": "plugins {\n  application\n}\n", "build.gradle": "apply plugin: 'x'"}, "build.gradle.kts", []string{"run"}},
		{map[string]string{"build.gradle.kts": "plugins { java; application }"}, "build.gradle.kts", []string{"run"}},
		{map[string]string{"build.gradle.kts": "plugins {\n  id(\"application\")\n  id(\"org.springframework.boot\") version \"3.2.0\"\n}"}, "build.gradle.kts", []string{"run", "bootRun"}},
		{map[string]string{"build.gradle": "plugins {\n  id 'org.springframework.boot' version '3'\n}\n"}, "build.gradle", []string{"bootRun"}},
		{map[string]string{"build.gradle.kts": "plugins { alias(libs.plugins.spring.boot) }"}, "build.gradle.kts", []string{"bootRun"}},
		{map[string]string{"build.gradle.kts": "plugins { alias(libs.plugins.springBoot) }"}, "build.gradle.kts", []string{"bootRun"}},
		{map[string]string{"build.gradle": "apply plugin: 'application'\napply plugin: \"org.springframework.boot\""}, "build.gradle", []string{"run", "bootRun"}},
		{map[string]string{"build.gradle.kts": "plugins {\n  `application`\n}"}, "build.gradle.kts", []string{"run"}},
		// Declared, not applied; a dependency; comments; a config block.
		{map[string]string{"build.gradle.kts": "plugins {\n  id(\"org.springframework.boot\") version \"3\" apply false\n}"}, "build.gradle.kts", nil},
		{map[string]string{"build.gradle.kts": "dependencies { implementation(\"org.springframework.boot:spring-boot-starter\") }"}, "build.gradle.kts", nil},
		{map[string]string{"build.gradle.kts": "plugins {\n  // id(\"application\")\n  /* application */\n}"}, "build.gradle.kts", nil},
		{map[string]string{"build.gradle.kts": "application {\n  mainClass.set(\"x\")\n}"}, "build.gradle.kts", nil},
		{map[string]string{"build.gradle.kts": "plugins { application"}, "build.gradle.kts", []string{"run"}},
		{map[string]string{"build.gradle.kts": "plugins {\n  id(\"java\").apply { }\n  application\n}"}, "build.gradle.kts", []string{"run"}},
	} {
		g := toolGroupOf(discoverFiles(t, tc.files), "gradle")
		if want := append(slices.Clone(base), tc.extra...); g == nil || g.File != tc.file || !slices.Equal(toolNames(g), want) {
			t.Errorf("%v = %+v, want %v", tc.files, g, want)
		}
	}
	if g := toolGroupOf(discoverFiles(t, map[string]string{"README": ""}), "gradle"); g != nil {
		t.Errorf("no build file = %+v", g)
	}
}

// The wrapper script runs when it is a regular file in the root: the .bat
// one from pwsh on Windows.
func TestToolWrapper(t *testing.T) {
	defer func(g string) { taskGOOS = g }(taskGOOS)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	outside := t.TempDir()
	writeFile(t, filepath.Join(dir, "pom.xml"), "<project/>")
	writeFile(t, filepath.Join(dir, "build.gradle"), "")
	writeFile(t, filepath.Join(dir, "gradlew"), "#!/bin/sh")
	writeFile(t, filepath.Join(dir, "gradlew.bat"), "@echo off")
	writeFile(t, filepath.Join(outside, "mvnw"), "#!/bin/sh")
	if err := os.Symlink(filepath.Join(outside, "mvnw"), filepath.Join(dir, "mvnw")); err != nil {
		t.Skip("no symlinks:", err)
	}
	os.Mkdir(filepath.Join(dir, "mvnw.cmd"), 0o755)
	api := &tasksAPI{files: &filesAPI{}}
	for _, tc := range []struct {
		goos                        string
		gradle, gradlePw, mvn, mvPw string
	}{
		{"linux", "./gradlew", "./gradlew", "mvn", "mvn"},
		{"windows", "./gradlew", `.\gradlew.bat`, "mvn", "mvn"},
	} {
		taskGOOS = tc.goos
		out, _ := api.discover(context.Background(), dir)
		g, m := toolGroupOf(out, "gradle"), toolGroupOf(out, "maven")
		if g.head != tc.gradle || g.pwshHead != tc.gradlePw || m.head != tc.mvn || m.pwshHead != tc.mvPw || g.Tasks[0].Command != "./gradlew build" {
			t.Errorf("%s: gradle %q %q, maven %q %q", tc.goos, g.head, g.pwshHead, m.head, m.pwshHead)
		}
	}
	os.Remove(filepath.Join(dir, "gradlew"))
	taskGOOS = "windows"
	out, _ := api.discover(context.Background(), dir)
	if g := toolGroupOf(out, "gradle"); g.head != "gradle" || g.pwshHead != `.\gradlew.bat` {
		t.Errorf("no posix wrapper: %q %q", g.head, g.pwshHead)
	}
}

func TestDetectPDM(t *testing.T) {
	out := discoverFiles(t, map[string]string{"pyproject.toml": `
[tool.pdm.scripts]
_ = {env_file = ".env"}
pre_test = "echo pre"
test = {cmd = ["pytest", "-x"]}
post_test = {shell = "echo post"}
start = {call = "app:main"}
all = {composite = ["lint", "test"]}
"bad name" = "x"
lint = "ruff ."
other = {env = {A = "1"}}
`})
	g := toolGroupOf(out, "pdm")
	if want := []string{"pre_test", "test", "post_test", "start", "all", "lint", "other"}; !slices.Equal(toolNames(g), want) || out.Skipped != 1 {
		t.Fatalf("pdm = %v, skipped %d", toolNames(g), out.Skipped)
	}
	for name, want := range map[string]string{"test": "pytest -x", "post_test": "echo post", "start": "app:main", "all": "lint && test", "other": ""} {
		if d := toolTaskOf(g, name).Detail; d != want {
			t.Errorf("%s detail = %q, want %q", name, d, want)
		}
	}
	if h := toolTaskOf(g, "test").Hooks; !slices.Equal(h, []string{"pre_test", "post_test"}) {
		t.Errorf("hooks = %v", h)
	}
	if c := toolTaskOf(g, "test").Command; c != "pdm run test" {
		t.Errorf("command = %q", c)
	}
}

func TestDetectHatch(t *testing.T) {
	py := `
[tool.hatch.envs.default.scripts]
test = "pytest"
"a:b" = "x"
[tool.hatch.envs.lint.scripts]
check = ["ruff .", "mypy ."]
[tool.hatch.envs.lint]
dependencies = ["ruff"]
[tool.hatch.envs."bad env".scripts]
x = "y"
`
	g := toolGroupOf(discoverFiles(t, map[string]string{"pyproject.toml": py}), "hatch")
	if !slices.Equal(toolNames(g), []string{"test", "lint:check"}) || g.File != "pyproject.toml" {
		t.Fatalf("hatch = %+v", g)
	}
	if tt := toolTaskOf(g, "test"); tt.Command != "hatch run default:test" || !slices.Equal(tt.args, []string{"default:test"}) {
		t.Errorf("test = %+v", tt)
	}
	if d := toolTaskOf(g, "lint:check").Detail; d != "ruff . && mypy ." {
		t.Errorf("detail = %q", d)
	}
	// hatch.toml wins over pyproject.
	out := discoverFiles(t, map[string]string{"pyproject.toml": py, "hatch.toml": "[envs.default.scripts]\nunit = \"pytest\"\n"})
	if g := toolGroupOf(out, "hatch"); g.File != "hatch.toml" || !slices.Equal(toolNames(g), []string{"unit"}) {
		t.Errorf("hatch.toml = %+v", g)
	}
	out = discoverFiles(t, map[string]string{"pyproject.toml": py, "hatch.toml": "[envs"})
	if g := toolGroupOf(out, "hatch"); g != nil || !slices.Equal(out.Unreadable, []string{"hatch.toml"}) {
		t.Errorf("bad hatch.toml = %+v %v", g, out.Unreadable)
	}
	if g := toolGroupOf(discoverFiles(t, map[string]string{"pyproject.toml": "[project]\nname='x'\n"}), "hatch"); g != nil {
		t.Errorf("no scripts = %+v", g)
	}
}

func TestDetectPoe(t *testing.T) {
	py := "[tool.poe.tasks]\n_private = \"x\"\nfmt = \"black .\"\ntest.cmd = \"pytest\"\nall = [\"fmt\", \"test\"]\nhelp = {help = \"h\"}\n"
	for lock, head := range map[string]string{"": "poe", "poetry.lock": "poetry run poe", "uv.lock": "uv run poe"} {
		files := map[string]string{"pyproject.toml": py}
		if lock != "" {
			files[lock] = ""
		}
		g := toolGroupOf(discoverFiles(t, files), "poe")
		if !slices.Equal(toolNames(g), []string{"fmt", "test", "all", "help"}) || g.Tasks[0].Command != head+" fmt" {
			t.Errorf("%s: %+v", lock, g)
		}
		if d := toolTaskOf(g, "test").Detail + "|" + toolTaskOf(g, "all").Detail; d != "pytest|fmt && test" {
			t.Errorf("details = %q", d)
		}
	}
}

// pyproject.toml is read and decoded once for PDM, Hatch and Poe, and named
// once when it cannot be.
func TestPyprojectOnce(t *testing.T) {
	out := discoverFiles(t, map[string]string{"pyproject.toml": "[tool.pdm.scripts\n"})
	if len(out.ToolGroups) != 0 || !slices.Equal(out.Unreadable, []string{"pyproject.toml"}) {
		t.Errorf("bad = %v %v", out.ToolGroups, out.Unreadable)
	}
	out = discoverFiles(t, map[string]string{"pyproject.toml": "a" + strings.Repeat(".a", 20) + " = 1"})
	if !slices.Equal(out.Unreadable, []string{"pyproject.toml"}) {
		t.Errorf("hostile = %v", out.Unreadable)
	}
	out = discoverFiles(t, map[string]string{"pyproject.toml": "# " + strings.Repeat("x", maxTaskTOML)})
	if !slices.Equal(out.TooLarge, []string{"pyproject.toml"}) || len(out.Unreadable) != 0 {
		t.Errorf("large = %v %v", out.TooLarge, out.Unreadable)
	}
	out = discoverFiles(t, map[string]string{"pyproject.toml": strings.Repeat("x", maxTaskFile+1)})
	if !slices.Equal(out.TooLarge, []string{"pyproject.toml"}) {
		t.Errorf("larger = %v", out.TooLarge)
	}
}

func TestDetectCargo(t *testing.T) {
	base := []string{"build", "check", "test", "clippy", "fmt"}
	for _, tc := range []struct {
		files map[string]string
		want  []string
	}{
		{map[string]string{"Cargo.toml": "[package]\nname='x'\n"}, base},
		{map[string]string{"Cargo.toml": "[package]\nname='x'\n", "src/main.rs": "fn main(){}"}, append(slices.Clone(base), "run")},
		{map[string]string{"Cargo.toml": "[[bin]]\nname='x'\n"}, append(slices.Clone(base), "run")},
		{map[string]string{"Cargo.toml": "[package\n"}, base},
		{map[string]string{"Cargo.toml": "", ".cargo/config.toml": "[alias]\nb = \"build\"\nxtask = \"run -p xtask --\"\nci = [\"test\", \"--all\"]\ntest = \"t\"\n"},
			append(slices.Clone(base), "xtask", "ci")},
		// Cargo reads .cargo/config first.
		{map[string]string{"Cargo.toml": "", ".cargo/config": "[alias]\nold = \"build\"\n", ".cargo/config.toml": "[alias]\nnew = \"build\"\n"},
			append(slices.Clone(base), "old")},
		{map[string]string{"Cargo.toml": "", ".cargo/config.toml": "[alias\n"}, base},
		// Cargo runs its own info; an alias overrides the external fmt.
		{map[string]string{"Cargo.toml": "", ".cargo/config.toml": "[alias]\ninfo = \"check\"\nfmt = \"fmt --all\"\n"}, base},
		{map[string]string{"Cargo.toml": "", ".cargo/other": ""}, base},
	} {
		if g := toolGroupOf(discoverFiles(t, tc.files), "cargo"); !slices.Equal(toolNames(g), tc.want) {
			t.Errorf("%v = %v, want %v", tc.files, toolNames(g), tc.want)
		}
	}
	g := toolGroupOf(discoverFiles(t, map[string]string{"Cargo.toml": "", ".cargo/config.toml": "[alias]\nci = [\"test\", \"--all\"]\nfmt = \"fmt --all\"\n"}), "cargo")
	if tt := toolTaskOf(g, "ci"); tt.Detail != "test --all" || tt.Command != "cargo ci" {
		t.Errorf("alias = %+v", tt)
	}
	if tt := toolTaskOf(g, "fmt"); tt.Detail != "fmt --all" || g.Tasks[4].Name != "fmt" {
		t.Errorf("fmt alias = %+v", tt)
	}
	out := discoverFiles(t, map[string]string{"Cargo.toml": "", ".cargo/config.toml": "[alias\n"})
	if !slices.Equal(out.Unreadable, []string{".cargo/config.toml"}) {
		t.Errorf("unreadable = %v", out.Unreadable)
	}
}

func TestDetectGo(t *testing.T) {
	g := toolGroupOf(discoverFiles(t, map[string]string{"go.mod": "module x"}), "go")
	if !slices.Equal(toolNames(g), []string{"build", "test", "vet"}) || g.Tasks[1].Command != "go test ./..." {
		t.Errorf("go = %+v", g)
	}
	g = toolGroupOf(discoverFiles(t, map[string]string{"go.mod": "module x", "main.go": "package main"}), "go")
	if tt := toolTaskOf(g, "run"); tt.Command != "go run ." || !slices.Equal(tt.args, []string{"run", "."}) {
		t.Errorf("run = %+v", tt)
	}
}

func TestParseJustRecipes(t *testing.T) {
	text := strings.Join([]string{
		"set shell := [\"bash\", \"-c\"]",
		"alias b := build",
		"export FOO := \"1\"",
		"version := `git describe`",
		"import 'other.just'",
		"mod sub",
		"# A comment",
		"default: build",
		"",
		"build target='all' *flags:",
		"    cargo build",
		"@quiet:",
		"\techo q",
		"[private] # not listed",
		"hidden:",
		"[no-cd, private]",
		"hidden2:",
		"[group('ci')]",
		"# doc",
		"[linux]",
		"os-one:",
		"[macos]",
		"os-one:",
		"_helper:",
		"deploy env:",
		"push +files:",
		"opt +files='a b':",
		"dollar $x='1':",
		"quoted msg=\"a: b\" other=(x + 'y'):",
		"[private]",
		"",
		"after-blank:",
		"[group: 'x']",
		"grouped:",
		"broken header",
		"  indented:",
	}, "\r\n")
	want := []string{"default", "build", "quiet", "os-one", "opt", "dollar", "quoted", "after-blank", "grouped"}
	if got := parseJustRecipes([]byte(text)); !slices.Equal(got, want) {
		t.Errorf("recipes = %v, want %v", got, want)
	}
}

func TestDetectJust(t *testing.T) {
	g := toolGroupOf(discoverFiles(t, map[string]string{".JustFile": "a:\n"}), "just")
	if g == nil || g.File != ".JustFile" || g.Tasks[0].Command != "just a" {
		t.Errorf("just = %+v", g)
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	writeFile(t, filepath.Join(dir, "justfile"), "a:\n")
	if err := os.WriteFile(filepath.Join(dir, ".justfile"), []byte("b:\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if names, _ := os.ReadDir(dir); len(names) < 2 {
		t.Skip("file system folds case")
	}
	out, _ := (&tasksAPI{files: &filesAPI{}}).discover(context.Background(), dir)
	if toolGroupOf(out, "just") != nil || !slices.Equal(out.Unreadable, []string{".justfile", "justfile"}) {
		t.Errorf("two justfiles = %v %v", out.ToolGroups, out.Unreadable)
	}
}

func TestParseTaskfile(t *testing.T) {
	text := strings.Join([]string{
		"version: '3'",
		"vars:",
		"  X: 1",
		"tasks:  # the tasks",
		"  # a comment",
		"  build:",
		"    cmds:",
		"      - go build",
		"      - internal: true",
		"  build:web:",
		"    desc: web",
		"  \"quoted:name\":",
		"    cmds: [x]",
		"  'single''q':",
		"    cmds: [x]",
		"  secret:",
		"    internal: true",
		"  secret2:",
		"    desc: x",
		"    internal: true  # hidden",
		"  build:",
		"    cmds: [again]",
		"  inline: echo hi",
		"  - listed",
		"  \"esc\\\"aped\": x",
		"  \"unclosed:",
		"  'unclosed:",
		"  'q'x:",
		"  nocolon",
		"  ':'",
		"",
		"includes:",
		"  other: ./other.yml",
	}, "\n")
	tasks, skipped := parseTaskfile([]byte(text))
	want := []string{"build", "build:web", "quoted:name", "single'q", "inline"}
	if !slices.Equal(tasks, want) || skipped != 7 {
		t.Errorf("tasks = %v %d, want %v", tasks, skipped, want)
	}
	if tasks, _ := parseTaskfile([]byte("tasks: {a: {cmds: [x]}}\n")); len(tasks) != 0 {
		t.Errorf("flow map = %v", tasks)
	}
}

func TestDetectTaskfile(t *testing.T) {
	out := discoverFiles(t, map[string]string{
		"taskfile.dist.yaml": "tasks:\n  dist:\n    cmds: [x]\n",
		"Taskfile.yaml":      "tasks:\n  main:\n    cmds: [x]\n  bad name:\n    cmds: [x]\n",
	})
	g := toolGroupOf(out, "task")
	if g.File != "Taskfile.yaml" || !slices.Equal(toolNames(g), []string{"main"}) || out.Skipped != 1 {
		t.Errorf("task = %+v, skipped %d", g, out.Skipped)
	}
}

func TestDetectComposerAndDeno(t *testing.T) {
	out := discoverFiles(t, map[string]string{
		"composer.json": `{"name":"x","scripts":{"test":"phpunit","ci":["@lint","@test"],"test":"phpunit --stop","x y":"no"},"scripts-descriptions":{}}`,
		"deno.jsonc": `{
  // tasks
  "tasks": {
    "dev": "deno run -A main.ts", /* inline */
    "check": {"command": "deno check", "description": "x",},
    "url": "echo http://x/*y*/",
  },
}`,
	})
	c := toolGroupOf(out, "composer")
	if !slices.Equal(toolNames(c), []string{"test", "ci"}) || toolTaskOf(c, "test").Detail != "phpunit --stop" ||
		toolTaskOf(c, "ci").Detail != "@lint && @test" || out.Skipped != 1 {
		t.Errorf("composer = %+v, skipped %d", c, out.Skipped)
	}
	d := toolGroupOf(out, "deno")
	if d.File != "deno.jsonc" || !slices.Equal(toolNames(d), []string{"dev", "check", "url"}) ||
		toolTaskOf(d, "check").Detail != "deno check" || toolTaskOf(d, "url").Detail != "echo http://x/*y*/" {
		t.Errorf("deno = %+v", d)
	}
	// deno.json wins; bad JSON, no object, no tasks.
	out = discoverFiles(t, map[string]string{"deno.json": `{"tasks":{"a":"b"}}`, "deno.jsonc": `{"tasks":{"c":"d"}}`, "composer.json": `[1]`})
	if g := toolGroupOf(out, "deno"); g.File != "deno.json" || !slices.Equal(out.Unreadable, []string{"composer.json"}) {
		t.Errorf("precedence = %+v %v", g, out.Unreadable)
	}
	out = discoverFiles(t, map[string]string{"deno.json": `{"tasks":`, "composer.json": `{"scripts":[]}`})
	if len(out.ToolGroups) != 0 || !slices.Equal(out.Unreadable, []string{"deno.json"}) {
		t.Errorf("bad = %v %v", out.ToolGroups, out.Unreadable)
	}
	out = discoverFiles(t, map[string]string{"composer.json": strings.Repeat(" ", maxTaskFile+1)})
	if len(out.ToolGroups) != 0 || !slices.Equal(out.TooLarge, []string{"composer.json"}) {
		t.Errorf("large = %v", out.TooLarge)
	}
}

func TestStripJSONC(t *testing.T) {
	for in, want := range map[string]string{
		`{"a": "x // y", "b": [1, 2,], } // end`: `{"a": "x // y", "b": [1, 2 ]  }       `,
		"[1, /* c */ ]":                          "[1          ]",
		`{"a": "q\"/*"}`:                         `{"a": "q\"/*"}`,
		"/* open":                                "       ",
		"[1,\n// c\n]":                           "[1 \n    \n]",
	} {
		if got := string(stripJSONC([]byte(in))); got != want {
			t.Errorf("%q = %q, want %q", in, got, want)
		}
	}
	if stripJSONC(nil) != nil {
		t.Error("nil")
	}
}

// Each group lists at most maxTaskItems, names once, the rest counted.
func TestToolGroupLimitsAndCut(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(`{"scripts":{`)
	for i := range maxTaskItems + 3 {
		fmt.Fprintf(&sb, `"s%d":"x",`, i)
	}
	sb.WriteString(`"s0":"` + strings.Repeat("é", maxScriptShown) + `"}}`)
	out := discoverFiles(t, map[string]string{"composer.json": sb.String()})
	g := toolGroupOf(out, "composer")
	if len(g.Tasks) != maxTaskItems || out.Skipped != 3 || !g.Tasks[0].Truncated || len(g.Tasks[0].Detail) > maxScriptShown {
		t.Errorf("limit: %d tasks, skipped %d, first %v", len(g.Tasks), out.Skipped, g.Tasks[0].Truncated)
	}
}

// Files under a deny dir are never read.
func TestToolFilesDeny(t *testing.T) {
	out := discoverFiles(t, map[string]string{"composer.json": `{"scripts":{"a":"b"}}`}, ".")
	if len(out.ToolGroups) != 0 {
		t.Errorf("deny = %v", out.ToolGroups)
	}
}

// No TOML slot in time: those files are named unreadable, the rest listed.
func TestDiscoverTOMLBusy(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	for _, n := range []string{"pyproject.toml", "Cargo.toml"} {
		writeFile(t, filepath.Join(dir, n), "a = 1")
	}
	for range tomlDecodeSlots {
		tomlSlots <- struct{}{}
	}
	defer func() {
		for range tomlDecodeSlots {
			<-tomlSlots
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	writeFile(t, filepath.Join(dir, "go.mod"), "module x")
	out, err := (&tasksAPI{files: &filesAPI{}}).discover(ctx, dir)
	if err != nil || !slices.Equal(out.Unreadable, []string{"pyproject.toml", "Cargo.toml"}) ||
		toolGroupOf(out, "go") == nil || !slices.Equal(toolNames(toolGroupOf(out, "cargo")), []string{"build", "check", "test", "clippy", "fmt"}) {
		t.Errorf("busy = %v %v %v", err, out.Unreadable, out.ToolGroups)
	}
}

func TestScriptDetail(t *testing.T) {
	for _, tc := range []struct {
		v    any
		keys []string
		want string
	}{
		{"x", nil, "x"},
		{[]any{"a", 1, "b"}, nil, "a && b"},
		{map[string]any{"cmd": []any{"a", "b"}}, []string{"cmd"}, "a b"},
		{map[string]any{"composite": []any{"a", "b"}}, []string{"cmd", "composite"}, "a && b"},
		{map[string]any{"cmd": 1, "shell": "s"}, []string{"cmd", "shell"}, "s"},
		{map[string]any{"x": "y"}, []string{"cmd"}, ""},
		{1, nil, ""},
	} {
		if got := scriptDetail(tc.v, tc.keys...); got != tc.want {
			t.Errorf("%v = %q, want %q", tc.v, got, tc.want)
		}
	}
}

func TestIsToolKind(t *testing.T) {
	for _, k := range []string{"script", "make", "user", "", "Gradle"} {
		if isToolKind(k) {
			t.Errorf("%q is a tool kind", k)
		}
	}
	for _, tool := range taskTools {
		if !isToolKind(tool.kind) {
			t.Errorf("%q is not", tool.kind)
		}
	}
}

// The largest files each parser reads, every line a new name, list in
// linear time: names past maxTaskItems are only counted.
func TestToolParsersLinear(t *testing.T) {
	var task, just, py strings.Builder
	task.WriteString("tasks:\n")
	py.WriteString("[tool.poe.tasks]\n")
	for i := 0; task.Len() < maxTaskFile-40; i++ {
		fmt.Fprintf(&task, "  t%d:\n", i)
		fmt.Fprintf(&just, "r%d:\n", i)
	}
	for i := 0; py.Len() < maxTaskTOML-40; i++ {
		fmt.Fprintf(&py, "p%d = \"x\"\n", i)
	}
	start := time.Now()
	out := discoverFiles(t, map[string]string{"Taskfile.yml": task.String(), "justfile": just.String(), "pyproject.toml": py.String()})
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("took %v", took)
	}
	for _, tool := range []string{"task", "just", "poe"} {
		if g := toolGroupOf(out, tool); g == nil || len(g.Tasks) != maxTaskItems {
			t.Errorf("%s = %d tasks", tool, len(toolNames(g)))
		}
	}
	if out.Skipped < 3*maxTaskItems {
		t.Errorf("skipped %d", out.Skipped)
	}
}
