package main

import (
	"context"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
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
	Source      string `json:"source"` // project | user
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
		return listAgentCommands(root, s.ClaudeDir, a.commandSkip), nil
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
// (.claude/commands, .claude/skills) and the user's in claudeDir (commands,
// skills). Either dir may be empty. A name met twice keeps its first entry,
// project before user. skip, when set, refuses a file by its dir and path
// (the files routes' denied dirs and sensitive names).
func listAgentCommands(root, claudeDir string, skip func(dir, rel string) bool) commandsResponse {
	var out []agentCommand
	if root != "" {
		out = append(out, readCommandDir(root, ".claude", "project", skip)...)
	}
	if claudeDir != "" {
		out = append(out, readCommandDir(claudeDir, ".", "user", skip)...)
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

// commandReader lists one dir's commands and skills. The dir is opened as an
// os.Root, so neither a path nor a symlink can lead a read outside it, and a
// file that is itself a symlink is never read: inside the root it could still
// name a file that is not a command (.env, credentials).
type commandReader struct {
	rt      *os.Root
	dir     string
	source  string
	skip    func(dir, rel string) bool
	visited int // dir entries looked at, against commandsMaxVisited
	out     []agentCommand
}

func readCommandDir(dir, base, source string, skip func(dir, rel string) bool) []agentCommand {
	if !filepath.IsAbs(dir) {
		return nil
	}
	rt, err := os.OpenRoot(dir)
	if err != nil {
		return nil
	}
	defer rt.Close()
	r := &commandReader{rt: rt, dir: dir, source: source, skip: skip}
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
			cmd := prefix + strings.TrimSuffix(name, path.Ext(name))
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
// (user-invocable: false) is left out. A symlinked skill dir is followed as
// long as it stays in the root; its SKILL.md must be a file of its own.
func (r *commandReader) readSkills(dir string, start int) {
	for _, e := range r.readDir(dir) {
		if r.full(start) {
			return
		}
		if strings.HasPrefix(e.Name(), ".") || (!e.IsDir() && e.Type()&fs.ModeSymlink == 0) {
			continue
		}
		meta, ok := r.readHead(path.Join(dir, e.Name(), "SKILL.md"))
		if !ok || meta.hidden {
			continue
		}
		name := e.Name()
		if meta.name != "" {
			name = meta.name
		}
		if !validCommandName(name) {
			continue
		}
		r.out = append(r.out, agentCommand{Name: name, Description: meta.description, Source: r.source, Kind: "skill"})
	}
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
