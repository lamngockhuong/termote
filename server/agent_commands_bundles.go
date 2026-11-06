package main

import (
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// bundleManifest is the manifest that makes a dir in the user's skills dir a
// plugin bundle; only its name is read.
const bundleManifest = ".claude-plugin/plugin.json"

// readSkillBundles lists the commands and skills of the plugin bundles in
// <claudeDir>/skills, as Claude Code loads them: an entry there (a dir, or a
// symlink or Windows junction to one) holding .claude-plugin/plugin.json and
// no SKILL.md, the layout some kit installers use. Each is named
// "<manifest name>:<name>" with source plugin. The bundle, its commands/ and
// skills/ dirs and each skill dir in skills/ may be links leading into allow
// or into a hidden dir right under home (~/.<kit>, where a kit keeps its
// store), never into home's other dirs; every dir reached is opened as an
// os.Root of its own, with skip checked from every dir holding it. All
// bundles share one visit budget (commandsMaxVisited) and one cap
// (commandsMaxPerSource), and at most commandsMaxPlugins are read.
func readSkillBundles(claudeDir, home string, allow []string, skip func(dir, rel string) bool) []agentCommand {
	skills := filepath.Join(claudeDir, "skills")
	if !filepath.IsAbs(skills) {
		return nil
	}
	rt, err := os.OpenRoot(skills)
	if err != nil {
		return nil
	}
	defer rt.Close()
	b := bundleReader{allow: slices.Clip(allow)}
	if h := resolvedDir(home); h != "" && filepath.Dir(h) != h {
		b.home = h
	}
	// skip is also checked from home, so a sensitive dir on the way is seen.
	skipDirs := b.allow
	if b.home != "" {
		skipDirs = append(skipDirs, b.home)
	}
	b.skip = skipFromAllowed(skipDirs, skip)
	linkAllow := b.linkAllow()

	top := &commandReader{rt: rt, dir: skills}
	bundles := 0
	for _, e := range top.readDir(".") {
		if bundles == commandsMaxPlugins || len(b.out) >= commandsMaxPerSource || b.visited >= commandsMaxVisited {
			break
		}
		if strings.HasPrefix(e.Name(), ".") || !dirLike(e, filepath.Join(skills, e.Name())) {
			continue
		}
		dir := b.linkedDir(filepath.Join(skills, e.Name()))
		if dir == "" {
			continue
		}
		name, ok := bundleName(dir, e.Name(), b.skip)
		if !ok {
			continue
		}
		bundles++
		opts := commandOpts{source: "plugin", prefix: name + ":", allow: linkAllow, skip: b.skip}
		if d := b.linkedDir(filepath.Join(dir, "commands")); d != "" {
			b.read(d, opts, func(r *commandReader) { r.walkCommands(".", "", 1) })
		}
		if d := b.linkedDir(filepath.Join(dir, "skills")); d != "" {
			b.read(d, opts, func(r *commandReader) { r.readSkills(".") })
		}
	}
	return b.out
}

// bundleReader holds what every bundle of one listing shares.
type bundleReader struct {
	allow   []string // resolved dirs a link may lead into
	home    string   // resolved home, "" when unknown or a filesystem root
	skip    func(dir, rel string) bool
	visited int
	out     []agentCommand
}

// linkAllow is allow plus the hidden dirs right under home that the bundles'
// skill dirs may lead into, as readLinkedSkill checks them. A hidden dir that
// is itself a link is left out: a target is compared with resolved paths.
func (b *bundleReader) linkAllow() []string {
	out := slices.Clip(b.allow)
	if b.home == "" {
		return out
	}
	entries, _ := os.ReadDir(b.home)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") && e.IsDir() {
			out = append(out, filepath.Join(b.home, e.Name()))
		}
	}
	return out
}

// linkedDir returns the real path of the dir p, its links resolved
// (resolvedDir), when it lies inside allow or inside a hidden dir right under
// home, or "".
func (b *bundleReader) linkedDir(p string) string {
	real := resolvedDir(p)
	if real == "" {
		return ""
	}
	if slices.ContainsFunc(b.allow, func(d string) bool { return pathWithin(d, real) }) {
		return real
	}
	if b.home == "" || !pathWithin(b.home, real) {
		return ""
	}
	// pathWithin rules out "." and "..": the first part is a dir under home.
	rel, err := filepath.Rel(b.home, real)
	if first, _, _ := strings.Cut(filepath.ToSlash(rel), "/"); err != nil || !strings.HasPrefix(first, ".") {
		return ""
	}
	return real
}

// read lists dir, opened as an os.Root, with fn, on the shared budget and cap.
func (b *bundleReader) read(dir string, opts commandOpts, fn func(*commandReader)) {
	rt, err := os.OpenRoot(dir)
	if err != nil {
		return
	}
	defer rt.Close()
	r := &commandReader{commandOpts: opts, rt: rt, dir: dir, visited: b.visited, out: b.out}
	fn(r)
	b.visited, b.out = r.visited, r.out
}

// dirLike reports whether the dir entry at p is a dir, a symlink, or on
// Windows a directory junction; any other entry is never followed.
func dirLike(e fs.DirEntry, p string) bool {
	return e.IsDir() || e.Type()&fs.ModeSymlink != 0 || (e.Type()&fs.ModeIrregular != 0 && isJunction(p))
}

// bundleName reads the manifest of the bundle dir: its name, else the entry's
// own name. A dir holding SKILL.md is a skill, not a bundle; a manifest that
// is not a regular file of at most pluginJSONMax, or a name Claude Code would
// not accept as a plugin's, is no bundle either.
func bundleName(dir, entry string, skip func(dir, rel string) bool) (string, bool) {
	rt, err := os.OpenRoot(dir)
	if err != nil {
		return "", false
	}
	defer rt.Close()
	if _, err := rt.Lstat("SKILL.md"); err == nil {
		return "", false
	}
	fi, err := rt.Lstat(bundleManifest)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > pluginJSONMax {
		return "", false
	}
	if skip != nil && skip(dir, filepath.FromSlash(bundleManifest)) {
		return "", false
	}
	f, err := rt.OpenFile(bundleManifest, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return "", false
	}
	defer f.Close()
	if got, err := f.Stat(); err != nil || !os.SameFile(got, fi) {
		return "", false
	}
	var m struct {
		Name string `json:"name"`
	}
	b, _ := io.ReadAll(io.LimitReader(f, pluginJSONMax))
	if json.Unmarshal(b, &m) != nil {
		return "", false
	}
	name := strings.TrimSpace(m.Name)
	if name == "" {
		name = entry
	}
	if !validCommandName(name) || strings.Contains(name, ":") {
		return "", false
	}
	return name, true
}
