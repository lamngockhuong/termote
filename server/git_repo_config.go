package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// A repository's own files can name another path git opens whatever the
// command runs: on Windows one off a drive letter (\\host\share) makes
// Windows connect to that host and send it the user's NTLM hash. git cannot
// be asked first (`git config --no-includes` reads the repository's config,
// includes and all, as it starts), so on Windows the files are read here as
// text before the first git command at a root (repoConfigRefused).
const (
	// repoConfigMaxDepth bounds the includes followed from one config
	// file, as git's own limit does.
	repoConfigMaxDepth = 10
	// repoAlternatesMaxDepth bounds the alternates followed, as git does.
	repoAlternatesMaxDepth = 5
	// repoFileMax: a repository file read here larger than this is refused.
	repoFileMax = 1 << 20
	// repoWorktreesMax bounds the linked worktrees whose gitdir is read.
	repoWorktreesMax = 1024
)

// errRepoOffDrive: a repository file names a path off a drive letter.
var errRepoOffDrive = errors.New("repository names a path off a drive letter")

// gitConfigEntry is one variable of a git config file: section and key
// lowercased, subsection as written (lowercased in the old [a.b] form).
type gitConfigEntry struct {
	section, subsection, key, value string
}

// parseGitConfig reads a git config file as git does: [section] and
// [section "subsection"] headers (a variable may follow one on its line),
// case-insensitive names, values with double quotes, the escapes \" \\ \n
// \t \b (a backspace character, not an erase), a backslash ending a line to
// continue the value on the next, and comments from # or ; outside quotes.
// Anything else is an error.
func parseGitConfig(data []byte) ([]gitConfigEntry, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	p := &gitConfigParser{r: bufio.NewReader(bytes.NewReader(data)), line: 1}
	var out []gitConfigEntry
	section, subsection := "", ""
	for {
		c, err := p.next()
		if err != nil {
			return out, nil
		}
		switch {
		case c == '\n' || isConfigSpace(c):
		case c == '#' || c == ';':
			p.skipLine()
		case c == '[':
			if section, subsection, err = p.header(); err != nil {
				return nil, err
			}
		case isASCIILetter(c):
			if section == "" {
				return nil, p.fail("variable outside a section")
			}
			key, value, err := p.variable(c)
			if err != nil {
				return nil, err
			}
			out = append(out, gitConfigEntry{section, subsection, key, value})
		default:
			return nil, p.fail("unexpected character")
		}
	}
}

type gitConfigParser struct {
	r    *bufio.Reader
	line int
}

// next reads one character, "\r\n" as '\n', as git's get_next_char does.
func (p *gitConfigParser) next() (byte, error) {
	c, err := p.r.ReadByte()
	if err == nil && c == '\r' {
		if b, _ := p.r.Peek(1); len(b) == 1 && b[0] == '\n' {
			c, _ = p.r.ReadByte()
		}
	}
	if err == nil && c == '\n' {
		p.line++
	}
	return c, err
}

// isConfigSpace is C's isspace but for '\n', which ends a line.
func isConfigSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\v' || c == '\f'
}

func (p *gitConfigParser) fail(why string) error {
	return fmt.Errorf("git config line %d: %s", p.line, why)
}

func (p *gitConfigParser) skipLine() {
	for {
		if c, err := p.next(); err != nil || c == '\n' {
			return
		}
	}
}

// header reads a section header after its '['.
func (p *gitConfigParser) header() (section, subsection string, err error) {
	var name []byte
	for {
		c, err := p.next()
		if err != nil {
			return "", "", p.fail("unterminated section header")
		}
		switch {
		case c == ']':
			if len(name) == 0 {
				return "", "", p.fail("empty section name")
			}
			// The old form [section.subsection], its subsection lowercased.
			s, sub, _ := strings.Cut(strings.ToLower(string(name)), ".")
			return s, sub, nil
		case c == ' ' || c == '\t':
			if len(name) == 0 {
				return "", "", p.fail("empty section name")
			}
			sub, err := p.subsection()
			return strings.ToLower(string(name)), sub, err
		case isASCIILetter(c) || isASCIIDigit(c) || c == '-' || c == '.':
			name = append(name, c)
		default:
			return "", "", p.fail("bad section name")
		}
	}
}

// subsection reads `"name"]` after a section name and its blanks.
func (p *gitConfigParser) subsection() (string, error) {
	c, err := p.next()
	for err == nil && (c == ' ' || c == '\t') {
		c, err = p.next()
	}
	if err != nil || c != '"' {
		return "", p.fail("bad subsection")
	}
	var sub []byte
	for {
		c, err := p.next()
		if err != nil || c == '\n' {
			return "", p.fail("unterminated subsection")
		}
		switch c {
		case '"':
			if c, err := p.next(); err != nil || c != ']' {
				return "", p.fail("bad subsection end")
			}
			return string(sub), nil
		case '\\':
			if c, err = p.next(); err != nil || c == '\n' {
				return "", p.fail("unterminated subsection")
			}
		}
		sub = append(sub, c)
	}
}

// variable reads a variable whose name starts with first: a name alone is
// true, else `= value` up to the end of its line.
func (p *gitConfigParser) variable(first byte) (key, value string, err error) {
	name := []byte{toLowerASCII(first)}
	for blank := false; ; {
		c, err := p.next()
		switch {
		case err != nil, c == '\n':
			return string(name), "true", nil
		case (isASCIILetter(c) || isASCIIDigit(c) || c == '-') && !blank:
			name = append(name, toLowerASCII(c))
		case isConfigSpace(c):
			blank = true
		case c == '#' || c == ';':
			p.skipLine()
			return string(name), "true", nil
		case c == '=':
			value, err := p.value()
			return string(name), value, err
		default:
			return "", "", p.fail("bad variable name")
		}
	}
}

func isASCIILetter(c byte) bool { return c|0x20 >= 'a' && c|0x20 <= 'z' }
func isASCIIDigit(c byte) bool  { return c >= '0' && c <= '9' }

func toLowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c | 0x20
	}
	return c
}

// value reads a value after its '=', as git's parse_value does: blanks
// outside quotes are dropped at either end and kept between words.
func (p *gitConfigParser) value() (string, error) {
	var v []byte
	quoted, space := false, 0
	for {
		c, err := p.next()
		if err != nil || c == '\n' {
			if quoted {
				return "", p.fail("unterminated quote")
			}
			return string(v), nil
		}
		if !quoted {
			if isConfigSpace(c) {
				space++
				continue
			}
			if c == '#' || c == ';' {
				p.skipLine()
				return string(v), nil
			}
		}
		if len(v) > 0 {
			for ; space > 0; space-- {
				v = append(v, ' ')
			}
		}
		space = 0
		switch c {
		case '\\':
			c, err = p.next()
			switch {
			case err != nil:
				return "", p.fail("backslash at the end of the file")
			case c == '\n':
			case c == 't':
				v = append(v, '\t')
			case c == 'n':
				v = append(v, '\n')
			case c == 'b':
				v = append(v, '\b')
			case c == '\\' || c == '"':
				v = append(v, c)
			default:
				return "", p.fail("bad escape")
			}
		case '"':
			quoted = !quoted
		default:
			v = append(v, c)
		}
	}
}

// repoConfigRefused reports why the repository dir is in (as git would find
// it, walking up) must not be handed to git, or nil: a .git file, commondir,
// objects/info/alternates or a linked worktree's gitdir that names a path
// off a drive letter outside the Places (the test refusesDir uses), a config
// file (config, config.worktree, and every local file they include) whose
// include.path, includeIf.*.path, core.worktree, core.excludesFile or
// core.attributesFile does, or a file it cannot read or parse. A link to
// such a path is refused as evalSymlinks refuses it. dir has been through
// evalSymlinks. The walk stops only at a git directory git takes too; one it
// may pass by is checked and passed by.
func (rr *rootResolver) repoConfigRefused(dir string) error {
	for d := dir; ; {
		gitDir, err := rr.gitDirAt(d)
		if err != nil {
			return err
		}
		if gitDir != "" {
			valid, err := rr.checkGitDir(gitDir, d)
			if err != nil || valid {
				return err
			}
		}
		// Where d's own entry is no repository git takes (an empty folder,
		// one without a HEAD), git tries d itself as a bare repository
		// before it walks up, so d is checked too.
		if gitDir != d {
			if _, err := os.Lstat(filepath.Join(d, "HEAD")); err == nil {
				valid, err := rr.checkGitDir(d, d)
				if err != nil || valid {
					return err
				}
			}
		}
		parent := filepath.Dir(d)
		if parent == d {
			return nil
		}
		d = parent
	}
}

// gitDirAt returns the git directory git tries at d: d/.git (a directory,
// or the one a "gitdir: <path>" file names), else d itself when it holds a
// HEAD (a bare repository, or inside a git directory); "" for neither.
// repoConfigRefused tries d too when the first is no repository.
func (rr *rootResolver) gitDirAt(d string) (string, error) {
	entry := filepath.Join(d, ".git")
	fi, err := os.Lstat(entry)
	switch {
	case err == nil && fi.Mode().IsRegular():
		b, missing, err := readRepoFile(entry)
		if err != nil || missing {
			return "", err
		}
		target, ok := strings.CutPrefix(strings.TrimRight(string(b), "\r\n"), "gitdir:")
		if !ok {
			return "", nil // git refuses such a repository itself
		}
		return rr.repoPath(strings.TrimSpace(target), d)
	case err == nil:
		return entry, nil
	case !errors.Is(err, fs.ErrNotExist):
		return "", err
	}
	if _, err := os.Lstat(filepath.Join(d, "HEAD")); err == nil {
		return d, nil
	}
	return "", nil
}

// configPath resolves a path a config value names (an include, or a file git
// opens) as git expands it before repoPath: git drops %(prefix)/ before an
// absolute path and uses it as written, and ~/ is the user's home (git's
// HOME), read like any local file (a home on a share is the user's own and
// passes). %(prefix)/ before a relative path (git's own install directory)
// and ~user (another user's home) resolve to "". A value led by
// ":(optional)" names the path after it.
func (rr *rootResolver) configPath(v, base string) (string, error) {
	v = strings.TrimPrefix(v, ":(optional)")
	if rest, ok := strings.CutPrefix(v, "%(prefix)/"); ok {
		if !strings.HasPrefix(rest, "/") && !strings.HasPrefix(rest, `\`) && (len(rest) < 2 || rest[1] != ':') {
			return "", nil
		}
		v = rest
	}
	rest, ok := strings.CutPrefix(v, "~")
	if !ok {
		return rr.offDrivePath(v, base, "")
	}
	user, tail, _ := strings.Cut(strings.ReplaceAll(rest, `\`, "/"), "/")
	if user != "" {
		return "", nil
	}
	home, err := gitHomeDir()
	if err != nil {
		return "", err
	}
	return rr.offDrivePath(filepath.Join(home, filepath.FromSlash(tail)), base, home)
}

// gitHomeDir is the home directory git expands ~ to: HOME, else (Git for
// Windows) HOMEDRIVE and HOMEPATH, else the user profile.
func gitHomeDir() (string, error) {
	if h := os.Getenv("HOME"); h != "" {
		return h, nil
	}
	if d, p := os.Getenv("HOMEDRIVE"), os.Getenv("HOMEPATH"); runtime.GOOS == "windows" && d != "" && p != "" {
		if fi, err := os.Stat(d + p); err == nil && fi.IsDir() {
			return d + p, nil
		}
	}
	return os.UserHomeDir()
}

// repoPath resolves a path a repository file names literally (a gitfile's
// gitdir:, commondir, alternates, a linked worktree's gitdir: git expands
// neither ~ nor %(prefix) there) against base; see offDrivePath.
func (rr *rootResolver) repoPath(v, base string) (string, error) {
	return rr.offDrivePath(v, base, "")
}

// offDrivePath resolves v against base, refusing a path off a drive letter
// outside the Places and home (the user's own home, when v came from ~): a
// share (\\host\share, //host/share), a device or long-form path (\\.\,
// \\?\UNC\) or an NT path (\??\UNC\).
func (rr *rootResolver) offDrivePath(v, base, home string) (string, error) {
	if w := strings.ReplaceAll(v, "/", `\`); strings.HasPrefix(w, `\\`) || strings.HasPrefix(w, `\??\`) {
		if nt, ok := strings.CutPrefix(w, `\??\`); ok {
			w = `\\?\` + nt // the same path in the form refusesDir reads
		}
		// The Place is looked up with v's own separators too: the same as
		// w on Windows, and what a test's slash Place matches elsewhere.
		p := filepath.FromSlash(v)
		if rr.refusesDir(w, true) && !rr.inPlace(p) && (home == "" || !underDir(home, p)) {
			return "", errRepoOffDrive
		}
		return p, nil
	}
	v = filepath.FromSlash(v)
	switch {
	case filepath.IsAbs(v), filepath.VolumeName(v) != "":
		return v, nil
	case strings.HasPrefix(v, string(filepath.Separator)):
		return filepath.VolumeName(base) + v, nil // rooted on base's drive
	}
	return filepath.Join(base, v), nil
}

// realRepoDir is p once evalSymlinks has checked every link on its way, so
// nothing opens a path below it through a link off a drive; "" when p is
// not there.
func realRepoDir(p string) (string, error) {
	r, err := evalSymlinks(p)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	return r, err
}

// checkGitDir checks the git directory g and its common directory; valid
// reports whether git takes g as a repository (is_git_directory: a HEAD
// naming a ref or an object, objects and refs directories in the common
// directory), so that the walk up stops there. git reads commondir and
// looks at what it names before anything else, so that is checked
// always; the config, alternates and linked worktrees only when g holds a
// HEAD, since git reads them only from a directory it takes as a repository.
// top is the directory git found g from, where it runs.
func (rr *rootResolver) checkGitDir(g, top string) (valid bool, err error) {
	if g, err = realRepoDir(g); g == "" || err != nil {
		return false, err
	}
	common := g
	b, missing, err := readRepoFile(filepath.Join(g, "commondir"))
	if err != nil {
		return false, err
	}
	if !missing {
		c, err := rr.repoPath(strings.TrimRight(string(b), "\r\n"), g)
		if err != nil {
			return false, err
		}
		if c != "" {
			if common, err = realRepoDir(c); err != nil || common == "" {
				return false, err
			}
		}
	}
	if _, err := os.Lstat(filepath.Join(g, "HEAD")); err != nil {
		return false, nil
	}
	// A relative path a key names starts from the git dir (core.worktree)
	// or the work tree git runs in: top, or a core.worktree either file,
	// or a file it includes, sets (git reads both files as one).
	files := []string{filepath.Join(common, "config"), filepath.Join(g, "config.worktree")}
	bases := []string{g, top}
	for _, f := range files {
		bases = rr.worktreeBases(f, g, 0, bases)
	}
	for _, f := range files {
		if err := rr.checkConfigFile(f, 0, bases); err != nil {
			return false, err
		}
	}
	if err := rr.checkAlternates(filepath.Join(common, "objects"), 0); err != nil {
		return false, err
	}
	if err := rr.checkWorktrees(common); err != nil {
		return false, err
	}
	return validHead(filepath.Join(g, "HEAD")) && lstatIsDir(filepath.Join(common, "objects")) &&
		lstatIsDir(filepath.Join(common, "refs")), nil
}

// validHead reports whether p is a HEAD git accepts: a file holding
// "ref: refs/..." or an object id.
func validHead(p string) bool {
	b, missing, err := readRepoFile(p)
	if err != nil || missing {
		return false
	}
	s := strings.TrimRight(string(b), "\r\n")
	if strings.HasPrefix(s, "ref: refs/") {
		return true
	}
	return (len(s) == 40 || len(s) == 64) && strings.Trim(s, "0123456789abcdef") == ""
}

// lstatIsDir reports whether p is a directory itself, not a link to one,
// which Stat would follow.
func lstatIsDir(p string) bool {
	fi, err := os.Lstat(p)
	return err == nil && fi.IsDir()
}

// worktreeBases appends to bases each core.worktree f and the local files it
// includes set, resolved literally against the git dir g as git resolves
// it. A file it cannot read or parse adds nothing: checkConfigFile refuses it.
func (rr *rootResolver) worktreeBases(f, g string, depth int, bases []string) []string {
	b, missing, err := readRepoFile(f)
	if err != nil || missing || depth > repoConfigMaxDepth {
		return bases
	}
	entries, err := parseGitConfig(b)
	if err != nil {
		return bases
	}
	for _, e := range entries {
		switch {
		case e.section == "core" && e.subsection == "" && e.key == "worktree":
			if w, err := rr.repoPath(e.value, g); err == nil {
				bases = append(bases, w)
			}
		case e.key == "path" && (e.section == "include" && e.subsection == "" || e.section == "includeif"):
			if p, err := rr.configPath(e.value, filepath.Dir(f)); err == nil && p != "" {
				bases = rr.worktreeBases(p, g, depth+1, bases)
			}
		}
	}
	return bases
}

// checkConfigFile checks one config file and, depth deep, the local files
// it includes; a missing one is skipped, as git skips it. bases are the git
// dir first, then the work tree git runs in: what a relative path a key
// names starts from.
func (rr *rootResolver) checkConfigFile(f string, depth int, bases []string) error {
	if depth > repoConfigMaxDepth {
		return errors.New("repository config includes too deep")
	}
	b, missing, err := readRepoFile(f)
	if err != nil || missing {
		return err
	}
	entries, err := parseGitConfig(b)
	if err != nil {
		return err
	}
	for _, e := range entries {
		include := e.key == "path" && (e.section == "include" && e.subsection == "" || e.section == "includeif")
		opened := e.subsection == "" && (e.section == "core" &&
			(e.key == "worktree" || e.key == "excludesfile" || e.key == "attributesfile") ||
			e.section == "mailmap" && e.key == "file" || e.section == "diff" && e.key == "orderfile")
		if !include && !opened {
			continue
		}
		if include {
			p, err := rr.configPath(e.value, filepath.Dir(f))
			if err != nil {
				return err
			}
			if p != "" {
				if err := rr.checkConfigFile(p, depth+1, bases); err != nil {
					return err
				}
			}
			continue
		}
		// git opens the path, which may still lead off a drive through a
		// link, from wherever a relative one starts: each base is checked.
		// git reads core.worktree literally (no ~ or %(prefix)/).
		resolve := rr.configPath
		if e.key == "worktree" {
			resolve = rr.repoPath
		}
		for _, base := range append([]string{filepath.Dir(f)}, bases...) {
			p, err := resolve(e.value, base)
			if err != nil {
				return err
			}
			if p == "" {
				break
			}
			if _, err := realRepoDir(p); errors.Is(err, errRemoteLink) {
				return err
			}
		}
	}
	return nil
}

// checkAlternates checks objects/info/alternates under the objects
// directory objects: one path a line (relative to objects, or C-quoted),
// each followed depth deep as git follows them.
func (rr *rootResolver) checkAlternates(objects string, depth int) error {
	b, missing, err := readRepoFile(filepath.Join(objects, "info", "alternates"))
	if err != nil || missing || depth >= repoAlternatesMaxDepth {
		return err
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || line[0] == '#' {
			continue
		}
		if line[0] == '"' {
			uq, ok := unquoteC(line)
			if !ok {
				return errors.New("bad alternates line")
			}
			line = uq
		}
		p, err := rr.repoPath(line, objects)
		if err != nil {
			return err
		}
		if p == "" {
			continue
		}
		if p, err = realRepoDir(p); err != nil {
			return err
		}
		if p != "" {
			if err := rr.checkAlternates(p, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkWorktrees checks the gitdir file of each linked worktree under
// common/worktrees: `git worktree list` looks at the path each one names.
func (rr *rootResolver) checkWorktrees(common string) error {
	dir := filepath.Join(common, "worktrees")
	f, err := os.Open(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	names, err := f.Readdirnames(repoWorktreesMax + 1)
	f.Close()
	if err != nil && err != io.EOF {
		return err
	}
	if len(names) > repoWorktreesMax {
		return errors.New("too many linked worktrees")
	}
	for _, n := range names {
		b, missing, err := readRepoFile(filepath.Join(dir, n, "gitdir"))
		if err != nil {
			return err
		}
		if missing {
			continue
		}
		p, err := rr.repoPath(strings.TrimRight(string(b), "\r\n"), filepath.Join(dir, n))
		if err != nil {
			return err
		}
		if p != "" {
			if err := rr.checkWorktreeGitfile(p); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkWorktreeGitfile checks the gitfile entry of a linked worktree (the
// path its gitdir names): git worktree list, and ownWorktree after it, read
// the git dir that file names, refused off a drive as a pane's own gitfile
// is. A link on the way is checked by realRepoDir.
func (rr *rootResolver) checkWorktreeGitfile(entry string) error {
	// Another error (a drive with no media, access denied) leaves nothing
	// git could open there either: a stale worktree does not refuse the
	// repository.
	real, err := realRepoDir(entry)
	if errors.Is(err, errRemoteLink) {
		return err
	}
	if real == "" || err != nil {
		return nil
	}
	if fi, err := os.Lstat(real); err != nil || !fi.Mode().IsRegular() {
		return nil
	}
	b, _, err := readRepoFile(real)
	if err != nil {
		return err
	}
	if target, ok := strings.CutPrefix(strings.TrimRight(string(b), "\r\n"), "gitdir:"); ok {
		_, err = rr.repoPath(strings.TrimSpace(target), filepath.Dir(entry))
	}
	return err
}

// readRepoFile reads a small file of a repository once evalSymlinks has
// checked every link on its way; missing reports a file that is not there.
func readRepoFile(p string) (b []byte, missing bool, err error) {
	real, err := realRepoDir(p)
	if real == "" || err != nil {
		return nil, err == nil, err
	}
	f, err := os.Open(real)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || fi.IsDir() {
		return nil, false, cmpErr(err, errors.New("a directory where a repository file belongs"))
	}
	b, err = io.ReadAll(io.LimitReader(f, repoFileMax+1))
	if err == nil && len(b) > repoFileMax {
		err = errors.New("repository file too large")
	}
	return b, false, err
}

// cmpErr returns err, or def when err is nil.
func cmpErr(err, def error) error {
	if err != nil {
		return err
	}
	return def
}
