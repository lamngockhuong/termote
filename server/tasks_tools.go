package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/BurntSushi/toml"
)

// taskGOOS picks the Windows wrapper scripts (gradlew.bat) for pwsh. A
// variable so tests can set it.
var taskGOOS = runtime.GOOS

var errTaskUnknownKind = &codedError{"unknown_task_kind", "this task kind is not known: reload the list", http.StatusBadRequest}

// toolTask is one task of a build tool or task runner in the root. The
// server runs it as its group's program followed by args, each quoted:
// never a text a file supplied, only constants and names the Tasks view
// lists (taskNameRe).
type toolTask struct {
	Name string `json:"name"`
	// Command is the line a POSIX shell gets, shown without quotes: every
	// word is a constant or a name taskNameRe allows, which no shell
	// expands.
	Command string `json:"command"`
	// Detail is what the file says the task runs (a script's body), cut
	// like a package.json script.
	Detail    string   `json:"detail,omitempty"`
	Truncated bool     `json:"truncated,omitempty"`
	Hooks     []string `json:"hooks,omitempty"`
	args      []string
}

// toolGroup is the tasks one tool offers in the root. Tool is also the kind
// a run names.
type toolGroup struct {
	Tool  string     `json:"tool"`
	Label string     `json:"label"`
	File  string     `json:"file"`
	Tasks []toolTask `json:"tasks"`
	// head and pwshHead start the line typed (a POSIX shell's, pwsh's):
	// the program, a wrapper script in the root, and the runner's own
	// arguments, all constants.
	head, pwshHead string
}

// toolRunner is how a group's tasks run: program, or the wrapper script in
// the root when it is a regular file there (os.Root refuses one that links
// out of it), then args.
type toolRunner struct {
	program            string
	args               []string
	posixWrap, winWrap string
}

// heads returns the start of the line for a POSIX shell and for pwsh: on
// Windows pwsh runs the .bat/.cmd wrapper, elsewhere the POSIX one.
func (r toolRunner) heads(rt *os.Root) (string, string) {
	pick := func(wrap, prefix string) string {
		if wrap != "" {
			if fi, err := rt.Stat(wrap); err == nil && fi.Mode().IsRegular() {
				return prefix + wrap
			}
		}
		return r.program
	}
	posix := pick(r.posixWrap, "./")
	pwsh := posix
	if taskGOOS == "windows" {
		pwsh = pick(r.winWrap, `.\`)
	}
	if len(r.args) > 0 {
		rest := " " + strings.Join(r.args, " ")
		posix, pwsh = posix+rest, pwsh+rest
	}
	return posix, pwsh
}

// rootFiles is one discover's view of the root: its names listed once,
// pyproject.toml decoded once for the three tools that read it, and each
// file that is too large or cannot be read named once.
type rootFiles struct {
	ctx   context.Context
	rt    *os.Root
	names []string
	// denied tells a file under the Files deny dirs: never read.
	denied func(name string) bool
	out    *paneTasks

	pyDone bool
	py     *pyprojectDoc
	pyMD   toml.MetaData
}

func newRootFiles(ctx context.Context, rt *os.Root, denied func(string) bool, out *paneTasks) *rootFiles {
	f := &rootFiles{ctx: ctx, rt: rt, denied: denied, out: out}
	if d, err := rt.Open("."); err == nil {
		f.names, _ = d.Readdirnames(-1)
		d.Close()
	}
	return f
}

// has tells whether the root lists name.
func (f *rootFiles) has(name string) bool { return slices.Contains(f.names, name) }

// regular tells whether name is a regular file under the root.
func (f *rootFiles) regular(name string) bool {
	fi, err := f.rt.Stat(name)
	return err == nil && fi.Mode().IsRegular()
}

// read reads name like package.json (readTaskFile); nil when it is under
// a deny dir.
func (f *rootFiles) read(name string) []byte {
	if f.denied(name) {
		return nil
	}
	b, err := readTaskFile(f.rt, name)
	if errors.Is(err, errTaskFileTooLarge) {
		f.tooLarge(name)
	}
	return b
}

func (f *rootFiles) tooLarge(name string) {
	if !slices.Contains(f.out.TooLarge, name) {
		f.out.TooLarge = append(f.out.TooLarge, name)
	}
}

func (f *rootFiles) unreadable(name string) {
	if !slices.Contains(f.out.Unreadable, name) {
		f.out.Unreadable = append(f.out.Unreadable, name)
	}
}

// readTOML decodes name into v; false when it is absent, too large
// (maxTaskTOML), refused by the pre-scan, no valid TOML, or no decode slot
// came before the request ended (then named unreadable too: the rest of the
// list still shows).
func (f *rootFiles) readTOML(name string, v any) (toml.MetaData, bool) {
	b := f.read(name)
	if b == nil {
		return toml.MetaData{}, false
	}
	if len(b) > maxTaskTOML {
		f.tooLarge(name)
		return toml.MetaData{}, false
	}
	md, err := decodeTaskTOML(f.ctx, b, v)
	if err != nil {
		f.unreadable(name)
		return md, false
	}
	return md, true
}

// pyproject is pyproject.toml decoded, nil when it cannot be.
func (f *rootFiles) pyproject() (*pyprojectDoc, toml.MetaData) {
	if !f.pyDone {
		f.pyDone = true
		var doc pyprojectDoc
		if md, ok := f.readTOML("pyproject.toml", &doc); ok {
			f.py, f.pyMD = &doc, md
		}
	}
	return f.py, f.pyMD
}

// groupBuilder gathers one group's tasks: names the Tasks view can run, each
// once (a repeated one keeps its place and takes the last detail), at most
// maxTaskItems; the others are counted in skipped.
type groupBuilder struct {
	group   toolGroup
	runner  toolRunner
	skipped int
	// index finds a listed name's task.
	index map[string]int
}

func (b *groupBuilder) add(name, detail string, args ...string) {
	if !validTaskName(name) {
		b.skipped++
		return
	}
	d, cut := cutCommand(detail)
	if i, ok := b.index[name]; ok {
		b.group.Tasks[i].Detail, b.group.Tasks[i].Truncated = d, cut
		return
	}
	if len(b.group.Tasks) >= maxTaskItems {
		b.skipped++
		return
	}
	if b.index == nil {
		b.index = map[string]int{}
	}
	b.index[name] = len(b.group.Tasks)
	b.group.Tasks = append(b.group.Tasks, toolTask{Name: name, Detail: d, Truncated: cut, args: args})
}

// fixed adds a tool's standard tasks, each run by its own name.
func (b *groupBuilder) fixed(names ...string) {
	for _, n := range names {
		b.add(n, "", n)
	}
}

// taskTool reads one tool's tasks in the root: detect sets the group's file
// and runner and adds its tasks, or leaves it empty.
type taskTool struct {
	kind, label string
	detect      func(f *rootFiles, b *groupBuilder)
}

// taskTools in the order the Tasks view shows them.
var taskTools = []taskTool{
	{"gradle", "Gradle", detectGradle},
	{"maven", "Maven", detectMaven},
	{"pdm", "PDM", detectPDM},
	{"hatch", "Hatch", detectHatch},
	{"poe", "Poe the Poet", detectPoe},
	{"cargo", "Cargo", detectCargo},
	{"go", "Go", detectGo},
	{"just", "just", detectJust},
	{"task", "Task", detectTaskfile},
	{"composer", "Composer", detectComposer},
	{"deno", "Deno", detectDeno},
}

func isToolKind(kind string) bool {
	return slices.ContainsFunc(taskTools, func(t taskTool) bool { return t.kind == kind })
}

// discoverTools adds the root's tool groups to out, and their skipped
// entries.
func discoverTools(f *rootFiles) {
	for _, tool := range taskTools {
		b := &groupBuilder{group: toolGroup{Tool: tool.kind, Label: tool.label, Tasks: []toolTask{}}}
		tool.detect(f, b)
		f.out.Skipped += b.skipped
		if len(b.group.Tasks) == 0 {
			continue
		}
		b.group.head, b.group.pwshHead = b.runner.heads(f.rt)
		for i, t := range b.group.Tasks {
			b.group.Tasks[i].Command = b.group.head + " " + strings.Join(t.args, " ")
		}
		f.out.ToolGroups = append(f.out.ToolGroups, b.group)
	}
}

// scriptDetail is what a script's value in a file runs, as text: a string,
// a list (an argv joined by spaces, or steps by " && "), or the command of
// a table, under the first of keys it has.
func scriptDetail(v any, keys ...string) string {
	switch v := v.(type) {
	case string:
		return v
	case []any:
		return joinStrings(v, " && ")
	case map[string]any:
		for _, k := range keys {
			switch c := v[k].(type) {
			case string:
				return c
			case []any:
				sep := " && "
				if k == "cmd" || k == "command" {
					sep = " "
				}
				return joinStrings(c, sep)
			}
		}
	}
	return ""
}

func joinStrings(v []any, sep string) string {
	var parts []string
	for _, e := range v {
		if s, ok := e.(string); ok {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, sep)
}

var (
	gradleComment = regexp.MustCompile(`(?s)/\*.*?\*/|//[^\n]*`)
	// gradleApp applies the application plugin, gradleBoot Spring Boot's;
	// a dependency on Spring Boot does not apply it.
	gradleApp       = regexp.MustCompile("\\bid\\s*\\(?\\s*[\"']application[\"']|`application`|\\bapply\\s*\\(?\\s*plugin\\s*[:=]\\s*[\"']application[\"']")
	gradleBoot      = regexp.MustCompile(`\bid\s*\(?\s*["']org\.springframework\.boot["']|\bapply\s*\(?\s*plugin\s*[:=]\s*["']org\.springframework\.boot["']|(?i)\balias\s*\(\s*libs\.plugins\.[a-z0-9_.]*spring[._-]?boot[a-z0-9_.]*\s*\)`)
	gradleApplyNo   = regexp.MustCompile(`\bapply\s*\(?\s*false\b`)
	gradlePluginsRe = regexp.MustCompile(`\bplugins\s*\{`)
)

// detectGradle: the standard tasks of the root's build file (only it, no
// script evaluated), run and bootRun when it applies their plugin.
func detectGradle(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "gradle", posixWrap: "gradlew", winWrap: "gradlew.bat"}
	for _, n := range []string{"build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"} {
		if f.has(n) {
			b.group.File = n
			break
		}
	}
	if b.group.File == "" {
		return
	}
	b.fixed("build", "test", "check", "clean", "assemble")
	if !strings.HasPrefix(b.group.File, "build.") {
		return
	}
	text := gradleComment.ReplaceAllString(string(f.read(b.group.File)), "")
	app, boot := false, false
	for _, line := range strings.Split(text, "\n") {
		if gradleApplyNo.MatchString(line) {
			continue
		}
		app = app || gradleApp.MatchString(line)
		boot = boot || gradleBoot.MatchString(line)
	}
	// A bare `application` in a plugins block (Kotlin DSL's accessor).
	for _, loc := range gradlePluginsRe.FindAllStringIndex(text, -1) {
		depth, end := 1, loc[1]
		for end < len(text) && depth > 0 {
			switch text[end] {
			case '{':
				depth++
			case '}':
				depth--
			}
			end++
		}
		if depth == 0 {
			end-- // the closing brace
		}
		for _, part := range strings.FieldsFunc(text[loc[1]:end], func(r rune) bool { return r == '\n' || r == ';' }) {
			app = app || strings.TrimSpace(part) == "application"
		}
	}
	if app {
		b.fixed("run")
	}
	if boot {
		b.fixed("bootRun")
	}
}

// detectMaven: the lifecycle phases of a root pom.xml.
func detectMaven(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "mvn", posixWrap: "mvnw", winWrap: "mvnw.cmd"}
	if f.has("pom.xml") {
		b.group.File = "pom.xml"
		b.fixed("clean", "compile", "test", "package", "verify", "install")
	}
}

// detectPDM: [tool.pdm.scripts] but its shared options (_), with the
// pre_ and post_ scripts PDM runs around each.
func detectPDM(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "pdm", args: []string{"run"}}
	py, md := f.pyproject()
	if py == nil || py.Tool.PDM.Scripts == nil {
		return
	}
	b.group.File = "pyproject.toml"
	for _, k := range tomlKeysUnder(md, "tool", "pdm", "scripts") {
		if k == "_" {
			continue
		}
		b.add(k, scriptDetail(py.Tool.PDM.Scripts[k], "cmd", "shell", "call", "composite"), k)
	}
	for i, t := range b.group.Tasks {
		for _, h := range []string{"pre_" + t.Name, "post_" + t.Name} {
			if _, ok := b.index[h]; ok {
				b.group.Tasks[i].Hooks = append(b.group.Tasks[i].Hooks, h)
			}
		}
	}
}

// detectHatch: the scripts of each environment, from hatch.toml when the
// root has one (Hatch then ignores pyproject's), always run as env:name; the
// default environment's are shown by name. A script name holding ':' would
// run another environment's: left out.
func detectHatch(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "hatch", args: []string{"run"}}
	var envs hatchDoc
	var md toml.MetaData
	prefix := []string{"envs"}
	if f.has("hatch.toml") {
		var ok bool
		if md, ok = f.readTOML("hatch.toml", &envs); !ok {
			return
		}
		b.group.File = "hatch.toml"
	} else {
		py, pmd := f.pyproject()
		if py == nil {
			return
		}
		envs, md, prefix = py.Tool.Hatch, pmd, []string{"tool", "hatch", "envs"}
		b.group.File = "pyproject.toml"
	}
	n := len(prefix)
	seen := map[string]bool{}
	for _, k := range md.Keys() {
		if len(k) < n+3 || !slices.Equal(k[:n], prefix) || k[n+1] != "scripts" || seen[k[n]+":"+k[n+2]] {
			continue
		}
		env, name := k[n], k[n+2]
		seen[env+":"+name] = true
		v := envs.Envs[env].Scripts[name]
		shown, arg := name, env+":"+name
		if env != "default" {
			shown = arg
		}
		if strings.Contains(name, ":") || !validTaskName(arg) {
			b.skipped++
			continue
		}
		b.add(shown, scriptDetail(v), arg)
	}
}

// detectPoe: [tool.poe.tasks] but the private ones (_), run through Poetry
// or uv when the root has their lockfile (poe is then in its environment,
// not on PATH).
func detectPoe(f *rootFiles, b *groupBuilder) {
	switch {
	case f.has("poetry.lock"):
		b.runner = toolRunner{program: "poetry", args: []string{"run", "poe"}}
	case f.has("uv.lock"):
		b.runner = toolRunner{program: "uv", args: []string{"run", "poe"}}
	default:
		b.runner = toolRunner{program: "poe"}
	}
	py, md := f.pyproject()
	if py == nil || py.Tool.Poe.Tasks == nil {
		return
	}
	b.group.File = "pyproject.toml"
	for _, k := range tomlKeysUnder(md, "tool", "poe", "tasks") {
		if strings.HasPrefix(k, "_") {
			continue
		}
		b.add(k, scriptDetail(py.Tool.Poe.Tasks[k], "cmd", "shell", "script", "ref", "expr", "sequence"), k)
	}
}

// cargoBuiltins are Cargo's own commands and their aliases: an [alias] of
// one of these names never runs (Cargo warns and runs its own). clippy and
// fmt are external commands, which an alias overrides: theirs shows on the
// listed task.
var cargoBuiltins = map[string]bool{}

func init() {
	for _, n := range strings.Fields(`b c d r t rm add bench build check clean config doc fetch fix
		generate-lockfile git-checkout help info init install locate-project login logout metadata new owner
		package pkgid publish read-manifest remove report run rustc rustdoc search test tree uninstall
		update vendor verify-project version yank`) {
		cargoBuiltins[n] = true
	}
}

// detectCargo: Cargo's standard commands, run when the package has a
// binary, and the aliases of the root's .cargo/config (Cargo reads it
// before .cargo/config.toml).
func detectCargo(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "cargo"}
	if !f.has("Cargo.toml") {
		return
	}
	b.group.File = "Cargo.toml"
	b.fixed("build", "check", "test", "clippy", "fmt")
	var doc cargoDoc
	if _, ok := f.readTOML("Cargo.toml", &doc); ok && len(doc.Bin) > 0 || f.regular("src/main.rs") {
		b.fixed("run")
	}
	if !f.has(".cargo") {
		return
	}
	name := ".cargo/config.toml"
	if _, err := f.rt.Lstat(".cargo/config"); err == nil {
		name = ".cargo/config"
	}
	var cfg cargoConfigDoc
	md, ok := f.readTOML(name, &cfg)
	if !ok {
		return
	}
	for _, k := range tomlKeysUnder(md, "alias") {
		if cargoBuiltins[k] {
			continue
		}
		detail := scriptDetail(cfg.Alias[k])
		if args, ok := cfg.Alias[k].([]any); ok {
			detail = joinStrings(args, " ")
		}
		b.add(k, detail, k)
	}
}

// detectGo: build, test and vet every package of a root go.mod; run the
// root package when it has main.go.
func detectGo(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "go"}
	if !f.has("go.mod") {
		return
	}
	b.group.File = "go.mod"
	for _, n := range []string{"build", "test", "vet"} {
		b.add(n, "", n, "./...")
	}
	if f.has("main.go") {
		b.add("run", "", "run", ".")
	}
}

// detectJust: the public recipes of the root's justfile that take no
// argument. just refuses a root with two candidates (justfile and
// .justfile, in any case): named unreadable.
func detectJust(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "just"}
	var found []string
	for _, n := range f.names {
		if strings.EqualFold(n, "justfile") || strings.EqualFold(n, ".justfile") {
			found = append(found, n)
		}
	}
	slices.Sort(found)
	if len(found) > 1 {
		for _, n := range found {
			f.unreadable(n)
		}
		return
	}
	if len(found) == 0 {
		return
	}
	b.group.File = found[0]
	for _, name := range parseJustRecipes(f.read(found[0])) {
		b.add(name, "", name)
	}
}

var (
	justHeaderName = regexp.MustCompile(`^@?([A-Za-z_][A-Za-z0-9_-]*)`)
	justKeywords   = map[string]bool{"set": true, "alias": true, "export": true, "import": true, "mod": true}
)

// parseJustRecipes lists a justfile's recipes that run with no argument:
// not private (a _ name or a [private] attribute), every parameter with a
// default, each once.
func parseJustRecipes(b []byte) []string {
	var out []string
	seen := map[string]bool{}
	private := false
	for _, line := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "" || line != strings.TrimLeft(line, " \t"):
			// A recipe's body, or a blank line, ends the attributes.
			private = false
			continue
		case strings.HasPrefix(trimmed, "#"):
			continue
		case strings.HasPrefix(trimmed, "["):
			private = private || justAttrPrivate(trimmed)
			continue
		}
		isPrivate := private
		private = false
		m := justHeaderName.FindStringSubmatch(line)
		if m == nil || justKeywords[strings.Fields(line)[0]] {
			continue
		}
		name := m[1]
		params, ok := justHeaderParams(line[len(m[0]):])
		if !ok || isPrivate || strings.HasPrefix(name, "_") || seen[name] {
			continue
		}
		required := slices.ContainsFunc(params, func(p string) bool {
			p = strings.TrimPrefix(p, "$")
			return !strings.HasPrefix(p, "*") && !strings.Contains(p, "=")
		})
		if !required {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

// justAttrPrivate tells whether an attribute line ([a], [a, b(x)],
// [group: 'x']) holds private.
func justAttrPrivate(line string) bool {
	// Up to the last ']': a comment may follow.
	inner := line[1:]
	if i := strings.LastIndexByte(inner, ']'); i >= 0 {
		inner = inner[:i]
	}
	for _, a := range splitTopLevel(inner, ',') {
		a = strings.TrimSpace(a)
		if i := strings.IndexAny(a, "(:"); i >= 0 {
			a = a[:i]
		}
		if strings.TrimSpace(a) == "private" {
			return true
		}
	}
	return false
}

// justHeaderParams reads a recipe header after its name: the parameters up
// to the header's ':' (not ':='), quotes and parentheses kept whole; false
// when the line is no recipe header (an assignment, no ':').
func justHeaderParams(rest string) ([]string, bool) {
	var params []string
	var cur strings.Builder
	var quote byte
	depth := 0
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		switch {
		case quote != 0:
			cur.WriteByte(c)
			if c == quote {
				quote = 0
			}
			continue
		case c == '"' || c == '\'' || c == '`':
			quote = c
		case c == '(':
			depth++
		case c == ')':
			depth--
		case depth == 0 && c == ':':
			if i+1 < len(rest) && rest[i+1] == '=' {
				return nil, false
			}
			if cur.Len() > 0 {
				params = append(params, cur.String())
			}
			return params, true
		case depth == 0 && (c == ' ' || c == '\t'):
			if cur.Len() > 0 {
				params = append(params, cur.String())
				cur.Reset()
			}
			continue
		}
		cur.WriteByte(c)
	}
	return nil, false
}

// splitTopLevel splits s on sep outside quotes and parentheses.
func splitTopLevel(s string, sep byte) []string {
	var out []string
	var quote byte
	depth, start := 0, 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '(':
			depth++
		case c == ')':
			depth--
		case c == sep && depth == 0:
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

// taskfileNames are the files go-task reads, in its order.
var taskfileNames = []string{
	"Taskfile.yml", "taskfile.yml", "Taskfile.yaml", "taskfile.yaml",
	"Taskfile.dist.yml", "taskfile.dist.yml", "Taskfile.dist.yaml", "taskfile.dist.yaml",
}

// detectTaskfile: the tasks of the root's Taskfile but internal ones.
func detectTaskfile(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "task"}
	i := slices.IndexFunc(taskfileNames, f.has)
	if i < 0 {
		return
	}
	b.group.File = taskfileNames[i]
	tasks, skipped := parseTaskfile(f.read(b.group.File))
	b.skipped += skipped
	for _, name := range tasks {
		b.add(name, "", name)
	}
}

var taskfileInternal = regexp.MustCompile(`^internal:\s*true\s*(#.*)?$`)

// parseTaskfile lists the keys of a Taskfile's top-level tasks map, read
// line by line (no YAML library): each key one indent under a column-0
// "tasks:", a YAML scalar ("a:b" is one name), but those with
// "internal: true", each once. A key that is no scalar it reads is counted
// in skipped.
func parseTaskfile(b []byte) (tasks []string, skipped int) {
	in := false
	keyIndent, propIndent := 0, 0
	current := ""
	seen, internal := map[string]bool{}, map[string]bool{}
	for _, line := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if indent == 0 {
			in = strings.HasPrefix(line, "tasks:") && isYAMLRest(line[len("tasks:"):])
			keyIndent, current = 0, ""
			continue
		}
		if !in {
			continue
		}
		if keyIndent == 0 {
			keyIndent = indent
		}
		switch {
		case indent == keyIndent:
			current, propIndent = "", 0
			name, ok := yamlKey(trimmed)
			if !ok {
				skipped++
				continue
			}
			if !seen[name] {
				seen[name] = true
				tasks = append(tasks, name)
				current = name
			}
		case indent > keyIndent && current != "":
			if propIndent == 0 {
				propIndent = indent
			}
			if indent == propIndent && taskfileInternal.MatchString(trimmed) {
				internal[current] = true
			}
		}
	}
	return slices.DeleteFunc(tasks, func(n string) bool { return internal[n] }), skipped
}

// isYAMLRest: what follows a key's ':' leaves its value on the next lines
// (nothing, or a comment).
func isYAMLRest(s string) bool {
	s = strings.TrimSpace(s)
	return s == "" || strings.HasPrefix(s, "#")
}

// yamlKey reads a mapping key at the start of s: quoted, or plain up to the
// first ':' followed by a space or the end of the line.
func yamlKey(s string) (string, bool) {
	var key, rest string
	switch s[0] {
	case '"':
		end := strings.IndexByte(s[1:], '"')
		if end < 0 || strings.Contains(s[1:end+1], `\`) {
			return "", false
		}
		key, rest = s[1:end+1], s[end+2:]
	case '\'':
		i := 1
		var sb strings.Builder
		for ; i < len(s); i++ {
			if s[i] == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					sb.WriteByte('\'')
					i++
					continue
				}
				break
			}
			sb.WriteByte(s[i])
		}
		if i >= len(s) {
			return "", false
		}
		key, rest = sb.String(), s[i+1:]
	default:
		for i := 0; i < len(s); i++ {
			if s[i] == ':' && (i+1 == len(s) || s[i+1] == ' ' || s[i+1] == '\t') {
				key, rest = s[:i], s[i:]
				break
			}
		}
		if rest == "" {
			return "", false
		}
	}
	if !strings.HasPrefix(rest, ":") || len(rest) > 1 && rest[1] != ' ' && rest[1] != '\t' {
		return "", false
	}
	return key, true
}

// detectComposer: the scripts of composer.json.
func detectComposer(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "composer", args: []string{"run-script"}}
	if !f.has("composer.json") {
		return
	}
	jsonTasks(f, b, "composer.json", f.read("composer.json"), "scripts")
}

// detectDeno: the tasks of deno.json, else deno.jsonc (both may hold
// comments and trailing commas).
func detectDeno(f *rootFiles, b *groupBuilder) {
	b.runner = toolRunner{program: "deno", args: []string{"task"}}
	for _, n := range []string{"deno.json", "deno.jsonc"} {
		if f.has(n) {
			jsonTasks(f, b, n, stripJSONC(f.read(n)), "tasks")
			return
		}
	}
}

// jsonTasks adds the keys of b's top-level object field, in the file's
// order, each run by its name; a file that is no JSON object is named
// unreadable.
func jsonTasks(f *rootFiles, b *groupBuilder, name string, data []byte, field string) {
	if data == nil {
		return
	}
	entries, err := jsonObjectField(data, field)
	if err != nil {
		f.unreadable(name)
		return
	}
	b.group.File = name
	for _, e := range entries {
		b.add(e.key, scriptDetail(e.val, "command"), e.key)
	}
}

type jsonEntry struct {
	key string
	val any
}

var errNotJSONObject = errors.New("not a JSON object")

// jsonObjectField returns the entries of the object under field of the
// object in b, in their order; none when field is absent or no object.
func jsonObjectField(b []byte, field string) ([]jsonEntry, error) {
	if !json.Valid(b) {
		return nil, errNotJSONObject
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	if t, _ := dec.Token(); t != json.Delim('{') {
		return nil, errNotJSONObject
	}
	// b is valid JSON: reading its tokens cannot fail.
	var raw json.RawMessage
	for dec.More() {
		key, _ := dec.Token()
		var v json.RawMessage
		dec.Decode(&v)
		if key == field {
			raw = v
		}
	}
	in := json.NewDecoder(bytes.NewReader(raw))
	if t, _ := in.Token(); t != json.Delim('{') {
		return nil, nil
	}
	var out []jsonEntry
	for in.More() {
		key, _ := in.Token()
		var v any
		in.Decode(&v)
		out = append(out, jsonEntry{key.(string), v})
	}
	return out, nil
}

// stripJSONC turns JSONC into JSON: comments and trailing commas, outside
// strings, become spaces.
func stripJSONC(b []byte) []byte {
	if b == nil {
		return nil
	}
	out := slices.Clone(b)
	inString := false
	lastComma := -1
	for i := 0; i < len(out); i++ {
		c := out[i]
		switch {
		case inString:
			if c == '\\' {
				i++
			} else if c == '"' {
				inString = false
			}
		case c == '"':
			inString, lastComma = true, -1
		case c == '/' && i+1 < len(out) && out[i+1] == '/':
			for ; i < len(out) && out[i] != '\n'; i++ {
				out[i] = ' '
			}
		case c == '/' && i+1 < len(out) && out[i+1] == '*':
			j := i + 2
			for j+1 < len(out) && !(out[j] == '*' && out[j+1] == '/') {
				j++
			}
			end := min(j+2, len(out))
			for k := i; k < end; k++ {
				if out[k] != '\n' {
					out[k] = ' '
				}
			}
			i = end - 1
		case c == ',':
			lastComma = i
		case c == '}' || c == ']':
			if lastComma >= 0 {
				out[lastComma] = ' '
			}
			lastComma = -1
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
		default:
			lastComma = -1
		}
	}
	return out
}
