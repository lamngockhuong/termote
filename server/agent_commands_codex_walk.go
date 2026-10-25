package main

import (
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Limits of a Codex skill walk. Codex caps each root at 2000 dirs and 20000
// entries (MAX_SKILLS_DIRS_PER_ROOT, MAX_SKILLS_ENTRIES_PER_ROOT); Termote
// also caps one dir's listing, the links followed and the whole reply, and
// gives the whole listing a deadline, returning what was read by then.
const (
	codexSkillMaxDepth      = 6 // MAX_SCAN_DEPTH: dirs below a root
	codexSkillMaxDirs       = 2000
	codexSkillMaxEntries    = 20000
	codexSkillMaxDirEntries = 4096 // a dir with more is skipped whole
	codexSkillMaxLinks      = 64   // symlinked dirs followed in one walk
	codexSkillMaxTotal      = 2000 // skills in one reply
	codexSkillDeadline      = 2 * time.Second
	codexSkillNameMax       = 64  // MAX_NAME_LEN
	codexSkillQualifiedMax  = 129 // MAX_QUALIFIED_NAME_LEN
)

// codexNow is replaced by tests.
var codexNow = time.Now

// codexSkill is a skill listed for a Codex pane, with the resolved path of
// its SKILL.md, which [[skills.config]] rules match.
type codexSkill struct {
	cmd  agentCommand
	path string
}

// codexBudget counts what walks sharing it read, against the per-root caps
// and the listing's deadline.
type codexBudget struct {
	dirs, entries int
	deadline      time.Time
}

func (b *codexBudget) spent() bool {
	return b.dirs >= codexSkillMaxDirs || b.entries >= codexSkillMaxEntries || !codexNow().Before(b.deadline)
}

// codexWalkOpts says how one skill root is walked.
type codexWalkOpts struct {
	source string
	// prefix is "<namespace>:" for a plugin's skills; nested manifests are
	// then not looked for, as Codex gives a plugin root its namespace.
	prefix string
	// recursive walks codexSkillMaxDepth levels; else only <root>/<dir>/SKILL.md
	// is read (an Agent Plugin, DirectChildren).
	recursive bool
	// allow lists the resolved dirs a symlinked dir may lead into; with none,
	// links are not followed (the system root). deny lists the resolved dirs
	// a link never leads into, even inside an allowed one.
	allow, deny []string
	// stop is the resolved dir above which no plugin manifest is looked for
	// to name the root's skills (a repo root, home, CODEX_HOME).
	stop string
	// within, when set, is the resolved dir the root must be inside (a repo
	// root: a dir on the way that is a symlink must not lead out of it).
	within string
	skip   func(dir, rel string) bool
	budget *codexBudget
}

// codexWalkDir is one dir waiting in a walk: rel under the root rt of the
// resolved dir base; real is its resolved path.
type codexWalkDir struct {
	rt        *os.Root
	base, rel string
	real      string
	depth     int
	ns        string
}

// walkCodexSkills lists the skills under dir/rel as Codex's discovery does
// (codex-rs/ext/skills/src/loader/discovery.rs): breadth first, each dir read
// whole and sorted, hidden dirs left out, a SKILL.md at any depth up to
// codexSkillMaxDepth (the root's own too), and on below it. Every file is read
// through an os.Root, never through a symlink; a symlinked dir is followed,
// through an os.Root of its target, only into the allowed dirs, never into a
// denied one or one already walked. A skill is named by its front matter
// (codexSkillMeta), and by the nearest valid plugin manifest above it.
func walkCodexSkills(dir, rel string, o codexWalkOpts) []codexSkill {
	if !filepath.IsAbs(dir) || (o.skip != nil && o.skip(dir, filepath.FromSlash(rel))) {
		return nil
	}
	real := resolvedDir(filepath.Join(dir, filepath.FromSlash(rel)))
	if real == "" || o.within != "" && real != o.within && !pathWithin(o.within, real) {
		return nil
	}
	rt, err := os.OpenRoot(dir)
	if err != nil {
		return nil
	}
	roots := []*os.Root{rt}
	defer func() {
		for _, r := range roots {
			r.Close()
		}
	}()
	ns := ""
	if o.prefix == "" {
		ns = codexAncestorNamespace(real, o.stop, o.skip)
	}
	queue := []codexWalkDir{{rt: rt, base: dir, rel: path.Clean(rel), real: real, ns: ns}}
	visited := map[string]bool{real: true}
	var out []codexSkill
	for len(queue) > 0 && !o.budget.spent() {
		d := queue[0]
		queue = queue[1:]
		o.budget.dirs++
		entries, ok := readWholeDir(d.rt, d.rel)
		o.budget.entries += len(entries)
		if !ok {
			continue
		}
		if o.prefix == "" && d.depth > 0 {
			d.ns = codexDirNamespace(d, entries, o.skip)
		}
		if (o.recursive || d.depth == 1) && slices.ContainsFunc(entries, isSkillFile) {
			if s, ok := o.readSkill(d); ok {
				out = append(out, s)
			}
		}
		if d.depth >= codexSkillMaxDepth || (!o.recursive && d.depth > 0) {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			child := path.Join(d.rel, name)
			if o.skip != nil && o.skip(d.base, filepath.FromSlash(child)) {
				continue
			}
			switch {
			case e.IsDir():
				p := filepath.Join(d.real, name)
				if !visited[p] {
					visited[p] = true
					queue = append(queue, codexWalkDir{rt: d.rt, base: d.base, rel: child, real: p, depth: d.depth + 1, ns: d.ns})
				}
			case e.Type()&fs.ModeSymlink != 0 || e.Type()&fs.ModeIrregular != 0 && isJunction(filepath.Join(d.real, name)):
				target, base := o.linkTarget(filepath.Join(d.real, name))
				if target == "" || visited[target] || len(roots) > codexSkillMaxLinks {
					continue
				}
				visited[target] = true
				lrt, err := os.OpenRoot(target)
				if err != nil {
					continue
				}
				roots = append(roots, lrt)
				// Codex names a linked dir's skills from above its target,
				// here no higher than the allowed dir holding it.
				ns := d.ns
				if o.prefix == "" {
					if n := codexAncestorNamespace(filepath.Dir(target), base, o.skip); n != "" {
						ns = n
					}
				}
				queue = append(queue, codexWalkDir{rt: lrt, base: target, rel: ".", real: target, depth: d.depth + 1, ns: ns})
			}
		}
	}
	return out
}

// isSkillFile reports whether e is a SKILL.md file, named exactly so (a
// case-insensitive file system would also open skill.md by that name).
func isSkillFile(e fs.DirEntry) bool { return e.Name() == "SKILL.md" && e.Type().IsRegular() }

// readWholeDir reads rel under rt, sorted, when it is a dir of at most
// codexSkillMaxDirEntries entries.
func readWholeDir(rt *os.Root, rel string) ([]fs.DirEntry, bool) {
	f := openRootDir(rt, rel)
	if f == nil {
		return nil, false
	}
	defer f.Close()
	entries, err := f.ReadDir(codexSkillMaxDirEntries + 1)
	if (err != nil && err != io.EOF) || len(entries) > codexSkillMaxDirEntries {
		return entries, false
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, true
}

// linkTarget returns the resolved dir the symlink (or junction) p leads to,
// and the allowed dir holding it, when a walk may enter it: inside an allowed
// dir, not inside a denied one, with no hidden dir on the way down from the
// allowed one.
func (o codexWalkOpts) linkTarget(p string) (string, string) {
	target, err := resolveLinkedDir(p)
	if err != nil {
		return "", ""
	}
	if slices.ContainsFunc(o.deny, func(d string) bool { return d != "" && (d == target || pathWithin(d, target)) }) {
		return "", ""
	}
	for _, a := range o.allow {
		if a == "" || !pathWithin(a, target) {
			continue
		}
		rel, err := filepath.Rel(a, target)
		if err != nil {
			continue
		}
		hidden := slices.ContainsFunc(strings.Split(filepath.ToSlash(rel), "/"), func(s string) bool {
			return strings.HasPrefix(s, ".") && s != "."
		})
		if !hidden && (o.skip == nil || !o.skip(a, rel)) {
			return target, a
		}
	}
	return "", ""
}

// readSkill reads d's SKILL.md and names the skill. Its default name is the
// resolved dir's, as Codex takes it from the canonical path.
func (o codexWalkOpts) readSkill(d codexWalkDir) (codexSkill, bool) {
	r := &commandReader{commandOpts: commandOpts{skip: o.skip}, rt: d.rt, dir: d.base}
	head, ok := r.readHeadBytes(path.Join(d.rel, "SKILL.md"))
	if !ok {
		return codexSkill{}, false
	}
	name, desc, ok := codexSkillMeta(head, filepath.Base(d.real))
	if !ok {
		return codexSkill{}, false
	}
	switch {
	case o.prefix != "":
		name = o.prefix + name
	case d.ns != "":
		name = d.ns + ":" + name
	}
	if utf8.RuneCountInString(name) > codexSkillQualifiedMax || !validCodexMention(name) {
		return codexSkill{}, false
	}
	return codexSkill{
		cmd:  agentCommand{Name: name, Description: clipRunes(desc, commandDescMax), Source: o.source, Kind: "skill"},
		path: filepath.Join(d.real, "SKILL.md"),
	}, true
}

// codexSkillMeta reads a SKILL.md's name and description as
// parse_skill_frontmatter_metadata does (codex-rs/skills/src/parser.rs): the
// file must open with a "---" line (spaces around it allowed, a byte order
// mark not) and close it with another within commandHeadSize, a line between;
// the description must be set and not blank (the body never stands in); the
// name, when blank, is defaultName, of at most codexSkillNameMax runes. YAML
// that cannot parse makes Codex drop the skill, but Codex first quotes the
// values it can (repair_frontmatter_scalar_fields); of the rest, only name or
// description set twice is detected here.
func codexSkillMeta(head []byte, defaultName string) (name, desc string, ok bool) {
	text := strings.ReplaceAll(strings.ToValidUTF8(string(head), "\uFFFD"), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", "", false
	}
	end := -1
	for i, l := range lines[1:] {
		if strings.TrimSpace(l) == "---" {
			end = i + 1
			break
		}
	}
	// The last line may be cut by the read limit: it does not close.
	if end < 2 || (end == len(lines)-1 && len(head) >= commandHeadSize) {
		return "", "", false
	}
	block := lines[1:end]
	seen := map[string]bool{}
	quoted := map[string]bool{}
	for _, l := range block {
		if l == "" || l[0] == ' ' || l[0] == '\t' || strings.HasPrefix(l, "#") {
			continue
		}
		if k, v, found := strings.Cut(l, ":"); found {
			if k = strings.TrimSpace(k); k == "name" || k == "description" {
				if seen[k] {
					return "", "", false
				}
				seen[k] = true
				v = strings.TrimSpace(v)
				quoted[k] = v != "" && strings.ContainsAny(v[:1], `"'`)
			}
		}
	}
	fields := frontMatterFields(block)
	desc = codexScalar(fields["description"], quoted["description"])
	if desc == "" {
		return "", "", false
	}
	name = codexScalar(fields["name"], quoted["name"])
	if name == "" {
		name = strings.Join(strings.Fields(defaultName), " ")
	}
	if name == "" {
		name = "skill"
	}
	if utf8.RuneCountInString(name) > codexSkillNameMax {
		return "", "", false
	}
	return name, desc, true
}

// codexScalar is a front matter value on one line, whitespace collapsed
// (sanitize_single_line), with YAML's null read as no value unless quoted.
func codexScalar(v string, quoted bool) string {
	v = strings.Join(strings.Fields(v), " ")
	switch v {
	case "~", "null", "Null", "NULL":
		if !quoted {
			return ""
		}
	}
	return v
}

// codexManifestDirs are the dirs holding a plugin manifest that names the
// skills below them (DISCOVERABLE_PLUGIN_MANIFEST_PATHS).
var codexManifestDirs = []string{".codex-plugin", ".claude-plugin", ".cursor-plugin"}

// codexDirNamespace returns the namespace of the skills under d: that of a
// valid manifest in d, else the one d inherited.
func codexDirNamespace(d codexWalkDir, entries []fs.DirEntry, skip func(dir, rel string) bool) string {
	if !slices.ContainsFunc(entries, func(e fs.DirEntry) bool {
		return e.IsDir() && slices.Contains(codexManifestDirs, e.Name())
	}) {
		return d.ns
	}
	if ns, ok := codexNamespaceManifest(d.rt, d.base, d.rel, d.real, skip); ok {
		return ns
	}
	return d.ns
}

// codexAncestorNamespace returns the namespace a valid manifest gives the
// skills of the root real: the root's own, else the nearest dir above it, up
// to stop. Codex looks up to the file system's root; Termote reads nothing
// above the dir the root belongs to.
func codexAncestorNamespace(real, stop string, skip func(dir, rel string) bool) string {
	if stop == "" || stop != real && !pathWithin(stop, real) {
		stop = real
	}
	rt, err := os.OpenRoot(stop)
	if err != nil {
		return ""
	}
	defer rt.Close()
	for dir := real; ; dir = filepath.Dir(dir) {
		rel, err := filepath.Rel(stop, dir)
		if err != nil {
			return ""
		}
		if ns, ok := codexNamespaceManifest(rt, stop, filepath.ToSlash(rel), dir, skip); ok {
			return ns
		}
		if dir == stop || filepath.Dir(dir) == dir {
			return ""
		}
	}
}

// codexNamespaceManifest reads the namespace the plugin manifest in rel
// (under rt, whose dir is base; real is rel resolved) gives the skills below
// it, as plugin_namespace_for_root_uri does: the first of codexManifestDirs
// holding a plugin.json file is read, and its name, when a string, is the
// namespace (the dir's own name when blank). Other keys are ignored. Termote
// takes only a real dir and a regular file, not a symlink, of at most
// pluginJSONMax.
func codexNamespaceManifest(rt *os.Root, base, rel, real string, skip func(dir, rel string) bool) (string, bool) {
	for _, m := range codexManifestDirs {
		p := path.Join(rel, m, "plugin.json")
		if fi, err := rt.Lstat(path.Join(rel, m)); err != nil || !fi.IsDir() {
			continue
		}
		fi, err := rt.Lstat(p)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		b, st := readPluginManifest(rt, base, p, skip)
		if st != manifestFound {
			return "", false
		}
		obj, dups, ok := jsonMembers(b)
		if !ok || dups["name"] {
			return "", false
		}
		var name string
		if raw, set := obj["name"]; set && json.Unmarshal(raw, &name) != nil || isJSONNull(obj["name"]) {
			return "", false
		}
		if strings.TrimSpace(name) == "" {
			name = filepath.Base(real)
		}
		return name, true
	}
	return "", false
}
