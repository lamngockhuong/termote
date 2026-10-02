package main

import (
	"context"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Limits of the custom command listing. Only the start of each file is read,
// and nothing but a name and a one-line description leaves the server.
const (
	// commandsCacheTTL lets the composer reopen its list without a new walk.
	commandsCacheTTL = 5 * time.Second
	// commandsMaxPerSource caps the commands (or skills) read from one dir.
	commandsMaxPerSource = 500
	// commandsMaxDepth caps how deep commands/ is walked (a:b:c:d).
	commandsMaxDepth = 4
	// commandsMaxVisited caps the entries a walk looks at, matching or not.
	commandsMaxVisited = 5000
	// commandHeadSize is how much of a file is read for its front matter.
	commandHeadSize = 8 << 10
	// commandDescMax is the longest description returned, in runes.
	commandDescMax = 200
	// commandNameMax is the longest command name accepted, in runes.
	commandNameMax = 100
)

// agentCommand is a custom slash command or skill as the Chat view lists it.
// The file's body is never part of it.
type agentCommand struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source"` // project | user | plugin
	Kind        string `json:"kind"`   // command | skill
}

type commandsResponse struct {
	Commands []agentCommand `json:"commands"`
}

// registerCommandsRoute adds /api/mux/panes/{id}/agent/commands. It needs the
// files routes' pane root for the project's commands, and the host allowlist:
// it is a GET, which writeGuard lets through, so the cross-site check runs here.
func (a *agentAPI) registerCommandsRoute(mux *http.ServeMux, files *filesAPI, allowed hostAllowlist) {
	a.files, a.allowed = files, allowed
	a.home, _ = os.UserHomeDir()
	a.commands = newTTLCache[commandsResponse](commandsCacheTTL)
	mux.HandleFunc("/api/mux/panes/{id}/agent/commands", a.handleCommands)
}

func (a *agentAPI) handleCommands(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if msg := crossSiteRejection(a.allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	if !requireAgentRead(w, r) {
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	paneID := r.PathValue("id")
	s, err := a.session(paneID)
	if err != nil {
		a.agentError(w, "agent session", err)
		return
	}
	if s.Agent != "claude" {
		// The commands and skills listed are Claude Code's; another agent's
		// config dir is never read here.
		jsonOK(w, commandsResponse{Commands: []agentCommand{}})
		return
	}
	// Without a pane root (a backend without one, a directory gone) the
	// user's commands are still listed.
	root := ""
	if f := a.files; f != nil && f.dirs != nil && f.m.Caps().Files {
		ctx, cancel := context.WithTimeout(r.Context(), filesTimeout)
		if pr, err := f.roots.paneRoot(ctx, f.dirs, paneID); err == nil &&
			!f.denied(pr.Root, ".claude") {
			root = pr.Root
		}
		cancel()
	}
	res, _ := a.commands.do(root+"\x00"+s.ClaudeDir, func() (commandsResponse, error) {
		return listAgentCommands(root, s.ClaudeDir, a.home, a.commandSkip), nil
	})
	jsonOK(w, res)
}

// commandSkip refuses a file the files routes would not show either: under
// a denied dir (termote's own config and state, /proc, .git) or with a name
// that usually holds secrets.
func (a *agentAPI) commandSkip(dir, rel string) bool {
	if a.files != nil && a.files.denied(dir, rel) {
		return true
	}
	return sensitivePath(dir, rel)
}

// listAgentCommands reads the project's commands and skills under root
// (.claude/commands, .claude/skills), the user's in claudeDir (commands,
// skills), then those of the plugins enabled and installed there. Any dir may
// be empty. A name met twice keeps its first entry, project before user
// before plugin. A symlinked skill dir is followed into claudeDir, root or
// home's ~/.agents/skills (where skill managers install). skip, when set,
// refuses a file by its dir and path (the files routes' denied dirs and
// sensitive names).
func listAgentCommands(root, claudeDir, home string, skip func(dir, rel string) bool) commandsResponse {
	var allow []string
	for _, d := range []string{claudeDir, root, filepath.Join(home, ".agents", "skills")} {
		if real := resolvedDir(d); real != "" {
			allow = append(allow, real)
		}
	}
	var out []agentCommand
	if root != "" {
		out = append(out, readCommandDir(root, ".claude", commandOpts{source: "project", allow: allow, skip: skip})...)
	}
	if claudeDir != "" {
		out = append(out, readCommandDir(claudeDir, ".", commandOpts{source: "user", allow: allow, skip: skip})...)
		out = append(out, readPluginCommands(root, claudeDir, skip)...)
	}
	seen := map[string]bool{}
	cmds := make([]agentCommand, 0, len(out))
	for _, c := range out {
		if !seen[c.Name] {
			seen[c.Name] = true
			cmds = append(cmds, c)
		}
	}
	return commandsResponse{Commands: cmds}
}

// resolvedDir returns dir with its symlinks resolved, or "" when it is
// empty, relative or cannot be resolved.
func resolvedDir(dir string) string {
	if dir == "" || !filepath.IsAbs(dir) {
		return ""
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return ""
	}
	return real
}

// commandOpts says how one dir's entries are named and read.
type commandOpts struct {
	source string
	prefix string   // put before each name: "<plugin>:" for a plugin's
	allow  []string // resolved dirs a symlinked skill dir may lead into
	skip   func(dir, rel string) bool
}

// commandReader lists one dir's commands and skills. The dir is opened as an
// os.Root, so neither a path nor a symlink can lead a read outside it, and a
// file that is itself a symlink is never read: inside the root it could still
// name a file that is not a command (.env, credentials).
type commandReader struct {
	commandOpts
	rt      *os.Root
	dir     string
	visited int // dir entries looked at, against commandsMaxVisited
	out     []agentCommand
}

func readCommandDir(dir, base string, opts commandOpts) []agentCommand {
	if !filepath.IsAbs(dir) {
		return nil
	}
	rt, err := os.OpenRoot(dir)
	if err != nil {
		return nil
	}
	defer rt.Close()
	r := &commandReader{commandOpts: opts, rt: rt, dir: dir}
	r.walkCommands(path.Join(base, "commands"), "", 1)
	commands := len(r.out)
	r.visited = 0
	r.readSkills(path.Join(base, "skills"), commands)
	return r.out
}

// readDir reads at most what is left of the visit budget from dir, sorted.
func (r *commandReader) readDir(dir string) []fs.DirEntry {
	left := commandsMaxVisited - r.visited
	if left <= 0 {
		return nil
	}
	d, err := r.rt.Open(dir)
	if err != nil {
		return nil
	}
	defer d.Close()
	entries, _ := d.ReadDir(left)
	r.visited += len(entries)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries
}

// full reports whether this source has its commandsMaxPerSource entries.
func (r *commandReader) full(start int) bool { return len(r.out)-start >= commandsMaxPerSource }

// walkCommands lists *.md under dir: commands/a/b.md is /a:b. Symlinked
// dirs are not followed, and the walk stops commandsMaxDepth levels down.
func (r *commandReader) walkCommands(dir, prefix string, depth int) {
	for _, e := range r.readDir(dir) {
		if r.full(0) {
			return
		}
		name := e.Name()
		p := path.Join(dir, name)
		switch {
		case strings.HasPrefix(name, "."):
		case e.IsDir():
			if depth < commandsMaxDepth {
				r.walkCommands(p, prefix+name+":", depth+1)
			}
		case e.Type().IsRegular() && strings.EqualFold(path.Ext(name), ".md"):
			cmd := r.prefix + prefix + strings.TrimSuffix(name, path.Ext(name))
			if !validCommandName(cmd) {
				continue
			}
			if meta, ok := r.readHead(p); ok {
				r.out = append(r.out, agentCommand{Name: cmd, Description: meta.description, Source: r.source, Kind: "command"})
			}
		}
	}
}

// readSkills lists dir/*/SKILL.md: the skill is named by its front matter
// name, else its directory. A skill hidden from the / menu
// (user-invocable: false) is left out. A symlinked skill dir is followed
// when it leads into an allowed dir; its SKILL.md must be a file of its own.
func (r *commandReader) readSkills(dir string, start int) {
	for _, e := range r.readDir(dir) {
		if r.full(start) {
			return
		}
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		var meta commandMeta
		var ok bool
		switch {
		case e.IsDir():
			meta, ok = r.readHead(path.Join(dir, e.Name(), "SKILL.md"))
		case e.Type()&fs.ModeSymlink != 0:
			meta, ok = r.readLinkedSkill(path.Join(dir, e.Name()))
		}
		if !ok || meta.hidden {
			continue
		}
		name := e.Name()
		if meta.name != "" {
			name = meta.name
		}
		name = r.prefix + name
		if !validCommandName(name) {
			continue
		}
		r.out = append(r.out, agentCommand{Name: name, Description: meta.description, Source: r.source, Kind: "skill"})
	}
}

// readLinkedSkill reads the SKILL.md of the skill dir the symlink p leads to,
// when that dir is inside one of the allowed dirs. The target is opened as an
// os.Root of its own, so a read cannot leave it either.
func (r *commandReader) readLinkedSkill(p string) (commandMeta, bool) {
	target, err := filepath.EvalSymlinks(filepath.Join(r.dir, filepath.FromSlash(p)))
	if err != nil || !slices.ContainsFunc(r.allow, func(d string) bool { return pathWithin(d, target) }) {
		return commandMeta{}, false
	}
	rt, err := os.OpenRoot(target)
	if err != nil {
		return commandMeta{}, false
	}
	defer rt.Close()
	linked := &commandReader{rt: rt, dir: target}
	if r.skip != nil {
		// Checked from each allowed dir holding the target too: a .git dir
		// on the way to it is only seen from above.
		linked.skip = func(dir, rel string) bool {
			full := filepath.Join(dir, rel)
			for _, d := range r.allow {
				if rel, err := filepath.Rel(d, full); err == nil && pathWithin(d, full) && r.skip(d, rel) {
					return true
				}
			}
			return r.skip(dir, rel)
		}
	}
	return linked.readHead("SKILL.md")
}

// readHead reads the start of p when it is a regular file, not a symlink,
// and skip does not refuse it.
func (r *commandReader) readHead(p string) (commandMeta, bool) {
	if fi, err := r.rt.Lstat(p); err != nil || !fi.Mode().IsRegular() {
		return commandMeta{}, false
	}
	if r.skip != nil && r.skip(r.dir, filepath.FromSlash(p)) {
		return commandMeta{}, false
	}
	return readCommandHead(r.rt, p)
}

type commandMeta struct {
	name        string
	description string
	hidden      bool
}

// readCommandHead reads the first commandHeadSize bytes of p. A read that
// fails part way leaves the description to what was read.
func readCommandHead(rt *os.Root, p string) (commandMeta, bool) {
	f, err := rt.Open(p)
	if err != nil {
		return commandMeta{}, false
	}
	defer f.Close()
	head := make([]byte, commandHeadSize)
	n, _ := io.ReadFull(f, head)
	return parseCommandMeta(head[:n]), true
}

// parseCommandMeta reads name, description and user-invocable from YAML
// front matter (plain, quoted or block scalar values at the top level). With
// no description there, the first non-empty line of the body stands in,
// heading marks stripped.
func parseCommandMeta(b []byte) commandMeta {
	text := strings.ReplaceAll(strings.ToValidUTF8(string(b), "\uFFFD"), "\r\n", "\n")
	text = strings.TrimPrefix(text, "\uFEFF")
	var m commandMeta
	body := text
	if rest, ok := strings.CutPrefix(text, "---\n"); ok {
		lines := strings.Split(rest, "\n")
		end := -1
		for i, l := range lines {
			if t := strings.TrimRight(l, " \t"); t == "---" || t == "..." {
				end = i
				break
			}
		}
		if end >= 0 {
			fields := frontMatterFields(lines[:end])
			m.name = strings.TrimSpace(fields["name"])
			m.description = fields["description"]
			m.hidden = strings.EqualFold(strings.TrimSpace(fields["user-invocable"]), "false")
			body = strings.Join(lines[end+1:], "\n")
		} else {
			// Front matter cut off by the read limit: no body line either.
			body = ""
		}
	}
	if strings.TrimSpace(m.description) == "" {
		for _, l := range strings.Split(body, "\n") {
			if l = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(l), "#")); l != "" {
				m.description = l
				break
			}
		}
	}
	m.description = clipRunes(strings.Join(strings.Fields(m.description), " "), commandDescMax)
	return m
}

// frontMatterFields returns the top-level scalar fields of a YAML block.
// Indented lines continue the field above them (a block scalar or a folded
// plain value); nested maps and lists come back as text nobody reads.
func frontMatterFields(lines []string) map[string]string {
	out := map[string]string{}
	key := ""
	var parts []string
	flush := func() {
		if key != "" {
			out[key] = strings.Join(parts, " ")
		}
		key, parts = "", nil
	}
	for _, l := range lines {
		if l == "" || l[0] == ' ' || l[0] == '\t' {
			if key != "" {
				if t := strings.TrimSpace(l); t != "" {
					parts = append(parts, t)
				}
			}
			continue
		}
		flush()
		k, v, ok := strings.Cut(l, ":")
		if !ok || strings.HasPrefix(k, "#") {
			continue
		}
		key = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		switch {
		case v == "" || strings.ContainsAny(v[:1], "|>"):
			// A block scalar: its indented lines follow.
		default:
			parts = append(parts, unquoteYAML(v))
		}
	}
	flush()
	return out
}

// unquoteYAML strips YAML quotes from a one-line value.
func unquoteYAML(v string) string {
	if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
		if s, err := strconv.Unquote(v); err == nil {
			return s
		}
		return v[1 : len(v)-1]
	}
	if len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'' {
		return strings.ReplaceAll(v[1:len(v)-1], "''", "'")
	}
	// A trailing comment on a plain value.
	if i := strings.Index(v, " #"); i >= 0 {
		v = strings.TrimSpace(v[:i])
	}
	return v
}

// validCommandName accepts what can follow "/" in Claude Code's input box:
// letters, digits and - _ . : with no leading punctuation.
func validCommandName(s string) bool {
	if s == "" || utf8.RuneCountInString(s) > commandNameMax {
		return false
	}
	for i, r := range s {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r):
		case i > 0 && strings.ContainsRune("-_.:", r):
		default:
			return false
		}
	}
	return true
}

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}
