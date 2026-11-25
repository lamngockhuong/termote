package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
)

// The rules a delegated answer (agent_delegate.go) holds a dialog's command
// or file to, in one place: what a grant may name, and what no grant ever
// covers.

// refuseDelegation is a delegated answer refused, with why (reason): a
// code, never anything the agent wrote. No key was sent.
func refuseDelegation(reason string) error {
	f := fail(http.StatusConflict, "delegation_out_of_scope", "no grant covers this dialog ("+reason+"); ask the user")
	f.reason = reason
	return f
}

// delegateBadChars are the characters a delegated command never holds:
// what chains, substitutes, expands, redirects or quotes in a shell.
const delegateBadChars = ";&|$(){}*?[]~\\'\"`><!#\n\r\t"

// delegatePrograms is the one table a grant's prefix and a delegated
// command are held to (delegate_programs.json, embedded; the PWA keeps a
// copy, pwa/src/utils/grant-prefix.ts, which its tests check against this
// file). Only a program it names is ever run under a grant, and only the
// commands it names for that program: a prefix never stands for any code at
// all because nothing outside the table is accepted, so no word has to be
// guessed at (an alias, an abbreviation, a command that runs another one).
//
//go:embed delegate_programs.json
var delegateProgramsJSON []byte

// delegateProgram is a program with commands: the word that picks its
// command must be the user's, in the grant's prefix, and one of these.
type delegateProgram struct {
	// Commands take any word after them as an argument (npm test src).
	Commands []string `json:"commands"`
	// Script commands run a script by its name (npm run lint): the name is
	// the user's too, so "npm run" alone is no prefix.
	Script []string `json:"script"`
	// Bare commands take no word after them but options (npm ci, pnpm
	// install): with a name they install the package it names, and "npm
	// audit fix" installs new versions.
	Bare []string `json:"bare"`
	// Toolchain: one +x (rustup's) may come between the name and the
	// command (cargo +nightly test).
	Toolchain bool `json:"toolchain"`
	// Switches are the options taking no value that may come before the
	// command (pnpm -r test), and ValueOptions those taking the next word
	// as their value (npm --prefix pwa test, also --prefix=pwa). Any other
	// option there is refused rather than guessed at: a switch taken for an
	// option with a value hides the word picking the command (cargo
	// --locked install x), and a value taken for a switch is read as that
	// word (npm -w test install x). Each list is per program, as the same
	// option differs between them (-w is a switch to pnpm, takes a value
	// to npm).
	Switches     []string `json:"switches"`
	ValueOptions []string `json:"valueOptions"`
}

type delegateTable struct {
	// Tools are programs of one purpose, with no command that picks what
	// they do: every word after the name is an argument. eslint, jest and
	// pytest still run their config and test files from the worktree, as
	// any test command does (jobs.grant.runsCode).
	Tools    []string                   `json:"tools"`
	Programs map[string]delegateProgram `json:"programs"`
}

var delegateRules = func() delegateTable {
	var t delegateTable
	if err := json.Unmarshal(delegateProgramsJSON, &t); err != nil {
		panic("delegate_programs.json: " + err.Error())
	}
	return t
}()

// commandWord is the index in words of the word that picks the command of
// p, from start on, past the options p lists and their values, or -1 when
// none does or an option before it is not one p lists: one of its
// Switches, one of its ValueOptions followed by a word that is no option,
// or one of those written --name=value (a short option with = and the
// --name=value of an option not listed are refused too: cargo
// --config=alias.clippy=install would make clippy an install).
func commandWord(p delegateProgram, words []string, start int) int {
	for i := start; i < len(words); i++ {
		w := words[i]
		switch {
		case !strings.HasPrefix(w, "-"):
			return i
		case slices.Contains(p.Switches, w):
		case slices.Contains(p.ValueOptions, w):
			i++
			if i >= len(words) || strings.HasPrefix(words[i], "-") {
				return -1
			}
		default:
			name, _, ok := strings.Cut(w, "=")
			if !ok || !strings.HasPrefix(name, "--") || !slices.Contains(p.ValueOptions, name) {
				return -1
			}
		}
	}
	return -1
}

// parseDelegateCommand checks s, a grant's prefix or a delegated command,
// against the table: "" when it names a tool, or a program with one of
// its commands (and a script's name after a script command), else the
// refusal code.
func parseDelegateCommand(s string) string {
	if s == "" || len(s) > maxGrantCommand {
		return "chars"
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 || c > 0x7e || strings.IndexByte(delegateBadChars, c) >= 0 {
			return "chars"
		}
	}
	words := strings.Fields(s)
	// One space between words, none around: what the dialog shows wrapped
	// compares word for word.
	if strings.Join(words, " ") != s {
		return "chars"
	}
	// The first word is the program's bare name exactly as the table
	// spells it: no path, no extension, no other case, and no variable set
	// before it (X=1 bash).
	if isDelegateTool(words[0]) {
		// A tool reads the files its words name: none is absolute or
		// climbs out with .., so it stays in the folder it runs in
		// (checkToolPaths holds that folder to the grant's).
		for _, w := range words[1:] {
			if pathWordLeaves(w) {
				return "path"
			}
		}
		return ""
	}
	p, ok := delegateRules.Programs[words[0]]
	if !ok {
		return "program"
	}
	start := 1
	if p.Toolchain && len(words) > 1 && strings.HasPrefix(words[1], "+") {
		start = 2
	}
	k := commandWord(p, words, start)
	if k < 0 {
		return "command"
	}
	c := words[k]
	switch {
	case slices.Contains(p.Commands, c):
		return ""
	case slices.Contains(p.Script, c):
		if commandWord(p, words, k+1) < 0 {
			return "command"
		}
		return ""
	case slices.Contains(p.Bare, c):
		for _, w := range words[k+1:] {
			if !strings.HasPrefix(w, "-") {
				return "command"
			}
		}
		return ""
	}
	return "command"
}

// isDelegateTool: name is a tool of the table.
func isDelegateTool(name string) bool { return slices.Contains(delegateRules.Tools, name) }

// pathWordValue is the path a word of a tool's command may name: the word
// itself, an option's value after = (--file=x), a short option's attached
// value (-fx), or what follows @ or + (a response file); "" for an option
// with none (-n, --count).
func pathWordValue(w string) string {
	switch {
	case strings.HasPrefix(w, "-"):
		if i := strings.IndexByte(w, '='); i >= 0 {
			return w[i+1:]
		}
		if !strings.HasPrefix(w, "--") && len(w) > 2 {
			return w[2:]
		}
		return ""
	case strings.HasPrefix(w, "@"), strings.HasPrefix(w, "+"):
		return w[1:]
	}
	return w
}

// pathWordLeaves: w may name a file outside the folder the command runs
// in, as written: an absolute path (/x, //host/share), a Windows drive
// (C:x, C:/x), or a .. component. ~ and \ never pass delegateBadChars.
// A pattern spelled that way (rg /api/) is refused too.
func pathWordLeaves(w string) bool {
	v := pathWordValue(w)
	if strings.HasPrefix(v, "/") {
		return true
	}
	if len(v) >= 2 && v[1] == ':' && ('a' <= v[0]|0x20 && v[0]|0x20 <= 'z') {
		return true
	}
	return slices.Contains(strings.Split(v, "/"), "..")
}

// checkToolPaths is "" when a tool's command, run in cwd (the transcript's
// folder for the call), names no file outside dir, the grant's folder:
// cwd is in dir once both are resolved, and no word leads out of it
// through a symbolic link (os.Root refuses one that does). A word naming
// no file (a pattern) passes. Else "outside", also when either folder is
// unknown. The words already passed pathWordLeaves.
func checkToolPaths(dir, cwd string, words []string) string {
	if dir == "" || cwd == "" || !filepath.IsAbs(dir) || !filepath.IsAbs(cwd) {
		return "outside"
	}
	rd, err1 := filepath.EvalSymlinks(dir)
	rc, err2 := filepath.EvalSymlinks(cwd)
	if err1 != nil || err2 != nil {
		return "outside"
	}
	rel, err := filepath.Rel(rd, rc)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "outside"
	}
	root, err := os.OpenRoot(rd)
	if err != nil {
		return "outside"
	}
	defer root.Close()
	for _, w := range words {
		v := pathWordValue(w)
		if v == "" {
			continue
		}
		_, err := root.Stat(filepath.Join(rel, filepath.FromSlash(v)))
		if err != nil && !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, syscall.ENOTDIR) {
			return "outside"
		}
	}
	return ""
}

// grantRulesRefuse: g, a bash grant, is one these rules no longer take
// (made under older ones): its prefix is refused, or it names a tool and
// holds no folder to keep the tool's files in.
func grantRulesRefuse(g grant) bool {
	if g.Kind != "bash" {
		return false
	}
	if checkGrantPrefix(g.Prefix) != "" {
		return true
	}
	first, _, _ := strings.Cut(g.Prefix, " ")
	return isDelegateTool(first) && g.Dir == ""
}

// checkGrantPrefix is "" when p may be a bash grant's prefix, else the
// refusal code.
func checkGrantPrefix(p string) string {
	return parseDelegateCommand(p)
}

// checkDelegateCommand is "" when cmd may be answered under a grant whose
// prefix is prefix (an empty prefix: checks cmd alone), else the refusal
// code. A prefix the table refuses (a grant made under older rules)
// covers nothing: no_grant.
func checkDelegateCommand(cmd, prefix string) string {
	// cmd is checked alone first, so a bare command's words past the
	// prefix can only be options, refused below ("npm ci x" is refused
	// under "npm ci" as it is alone).
	if code := parseDelegateCommand(cmd); code != "" || prefix == "" {
		return code
	}
	if checkGrantPrefix(prefix) != "" {
		return "no_grant"
	}
	if cmd == prefix {
		return ""
	}
	if !strings.HasPrefix(cmd, prefix+" ") {
		return "no_grant"
	}
	// A word after the prefix is never an option: a granted program runs
	// another one through its own (rg --pre=x, go test -exec=x), so only
	// what the user typed in the prefix chooses options.
	for _, w := range strings.Fields(cmd[len(prefix):]) {
		if optionLike(w) {
			return "option"
		}
	}
	return ""
}

// optionLike is a word a program may read as an option: -x, and also
// @file (a response file of options: gcc @opts, javac, dotnet), +cmd (vim
// +q, less +F) and /name: (MSBuild's /p:X=1, dotnet build's).
func optionLike(w string) bool {
	if strings.HasPrefix(w, "-") || strings.HasPrefix(w, "@") || strings.HasPrefix(w, "+") {
		return true
	}
	return windowsOptionRe.MatchString(w)
}

// windowsOptionRe is an option written /name: or /name=.
var windowsOptionRe = regexp.MustCompile(`^/[A-Za-z][A-Za-z0-9-]*[:=]`)

// maxGrantCommand bounds a delegated command; maxGrantPrefix a grant's
// prefix.
const (
	maxGrantCommand = 4096
	maxGrantPrefix  = 200
)

// delegateDeniedNames are files no grant lets an agent edit, whatever the
// user wrote: what configures the agent itself, runs as a hook or a
// script, or holds secrets. Lowercased base names.
var delegateDeniedNames = []string{
	".mcp.json", "claude.md", "agents.md", ".envrc", "package.json", "makefile", "gnumakefile",
	"pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json",
	"go.sum", "cargo.lock", "gemfile.lock", "poetry.lock", "composer.lock", "uv.lock",
	".npmrc", ".yarnrc", ".yarnrc.yml", ".gitmodules", ".gitattributes", ".pre-commit-config.yaml",
	"opencode.json", "opencode.jsonc",
	// Claude Code and Codex read these as instructions too.
	"claude.local.md", "agents.override.md",
	// The package managers run or read these when they install.
	".pnpmfile.cjs", ".pnpmfile.mjs", "pnpm-workspace.yaml", ".yarnrc.yaml", "bunfig.toml",
	// Gemini CLI reads GEMINI.md as instructions; mise runs the tasks and
	// hooks of its config on entering the folder; vim and Neovim run a
	// folder's .exrc and .nvim.lua; MSBuild imports Directory.Build.* into
	// every project below it.
	"gemini.md", "mise.toml", ".mise.toml", ".exrc", ".nvim.lua", "directory.build.props", "directory.build.targets",
	// More of the same: CI pipelines run on the next push (as
	// .github/workflows), a rust-toolchain file's path runs as cargo,
	// mise's local config, vim's other folder configs, and the files the
	// task runners and Ruby's tools run (as the Makefile).
	".gitlab-ci.yml", "jenkinsfile", "rust-toolchain", "rust-toolchain.toml", "mise.local.toml", ".mise.local.toml",
	".vimrc", ".nvimrc", "_exrc", "justfile", ".justfile", "taskfile.yml", "taskfile.yaml", "gemfile", "rakefile",
}

// delegateHookConfigs are the files that make git hooks run a program:
// lefthook's (also denied names) and pre-commit's. checkDelegateHook reads
// them, and the scripts of .husky, for the files they run.
var delegateHookConfigs = func() []string {
	var names []string
	for _, base := range []string{"lefthook", "lefthook-local"} {
		for _, ext := range []string{".yml", ".yaml", ".json", ".jsonc", ".toml"} {
			names = append(names, base+ext, "."+base+ext)
		}
	}
	return append(names, ".pre-commit-config.yaml")
}()

func init() { delegateDeniedNames = append(delegateDeniedNames, delegateHookConfigs...) }

// hookScriptRe is a word of a hook config that names a script file.
var hookScriptRe = regexp.MustCompile(`[A-Za-z0-9_@+./-]+\.(?:sh|bash|zsh|js|mjs|cjs|ts|mts|cts|py|rb|pl|ps1|go)\b`)

// maxHookConfig bounds what checkDelegateHook reads of one file, and
// maxHookScripts how many of .husky's.
const (
	maxHookConfig  = 64 << 10
	maxHookScripts = 64
)

// checkDelegateHook is "denied_path" when rel, under dir, is a file a git
// hook of dir runs: named in a hook config at dir's root or in a script of
// .husky, compared by the end of its path ("../scripts/x.sh" in a command
// run from a subfolder denies every scripts/x.sh), since such a file runs
// at the user's next commit or push, past the grant. A config dir does
// not hold, or one too large, denies nothing more; what a hook script
// reads in turn is not followed.
func checkDelegateHook(dir, rel string) string {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "denied_path"
	}
	defer root.Close()
	files := slices.Clone(delegateHookConfigs)
	if d, err := root.Open(".husky"); err == nil {
		names, _ := d.Readdirnames(maxHookScripts)
		d.Close()
		for _, n := range names {
			files = append(files, ".husky/"+n)
		}
	}
	rel = strings.ToLower(filepath.ToSlash(rel))
	for _, name := range files {
		f, err := root.Open(name)
		if err != nil {
			continue
		}
		b, _ := io.ReadAll(io.LimitReader(f, maxHookConfig))
		f.Close()
		for _, w := range hookScriptRe.FindAllString(string(b), -1) {
			w = strings.ToLower(w)
			for strings.HasPrefix(w, "./") || strings.HasPrefix(w, "../") {
				w = w[strings.Index(w, "/")+1:]
			}
			w = strings.TrimPrefix(w, "/")
			if w != "" && (rel == w || strings.HasSuffix(rel, "/"+w)) {
				return "denied_path"
			}
		}
	}
	return ""
}

// delegateDeniedDirs are directories nothing under which a grant covers
// ("/"-separated, lowercased, from the worktree's root down).
var delegateDeniedDirs = []string{".git", ".claude", ".codex", ".opencode", ".agents", ".husky", ".githooks", ".lefthook",
	".vscode", ".idea", ".cargo", ".github/workflows", ".github/actions", "node_modules",
	// Agent and editor settings that run or instruct: Gemini CLI, Cursor,
	// a dev container's commands.
	".gemini", ".cursor", ".devcontainer",
	// CircleCI's pipeline, and mise's other config folders.
	".circleci", ".mise", ".config/mise", ".config/mise.toml",
	// Yarn Berry runs the release its config names (.yarn/releases) for
	// every yarn command, why and install alike, and loads the plugins in
	// .yarn/plugins.
	".yarn"}

// checkDelegatePath is "" when rel, a path relative to a grant's dir, may
// be edited under it, else the refusal code. Only the names are read here;
// checkDelegateFile looks at the files.
func checkDelegatePath(rel string) string {
	rel = filepath.ToSlash(rel)
	if rel == "" || rel == "." || filepath.IsAbs(rel) || strings.HasPrefix(rel, "/") {
		return "denied_path"
	}
	parts := strings.Split(strings.ToLower(rel), "/")
	if slices.Contains(parts, "..") || slices.Contains(parts, ".") || slices.Contains(parts, "") {
		return "denied_path"
	}
	// Only names a file system cannot read as another: printable ASCII
	// (case folding maps some other letters to ASCII ones on macOS), no
	// Windows short name (GIT~1), stream (a:b), or trailing dot or space,
	// which Windows drops when it writes.
	for _, part := range parts {
		for i := 0; i < len(part); i++ {
			if c := part[i]; c < 0x20 || c > 0x7e || c == '~' || c == ':' || c == '\\' {
				return "denied_path"
			}
		}
		if strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return "denied_path"
		}
	}
	base := parts[len(parts)-1]
	if slices.Contains(delegateDeniedNames, base) || strings.HasPrefix(base, ".env") || isSensitive("/"+strings.Join(parts, "/")) {
		return "denied_path"
	}
	joined := strings.Join(parts, "/")
	for _, d := range delegateDeniedDirs {
		// A name of one component is denied anywhere, as a file too (a
		// submodule's .git file).
		if strings.HasPrefix(joined, d+"/") || joined == d || (!strings.Contains(d, "/") && slices.Contains(parts, d)) {
			return "denied_path"
		}
	}
	return ""
}

// checkDelegateFile is "" when no component of rel under dir is a symlink
// (the last one included) and the file, if it exists, is a regular file
// with one link. What is not there yet (a file Write creates) is fine.
// Between this check and the agent's write a symlink can still appear: a
// grant to edit is a grant to an agent that can run commands there anyway.
func checkDelegateFile(dir, rel string) string {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "denied_path"
	}
	defer root.Close()
	parts := strings.Split(filepath.ToSlash(rel), "/")
	for i := range parts {
		p := filepath.Join(parts[:i+1]...)
		fi, err := root.Lstat(p)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return ""
		case err != nil:
			return "denied_path"
		case fi.Mode()&fs.ModeSymlink != 0:
			return "symlink"
		case i < len(parts)-1 && !fi.IsDir():
			return "denied_path"
		case i == len(parts)-1:
			if !fi.Mode().IsRegular() {
				return "denied_path"
			}
			f, err := root.Open(p)
			if err != nil {
				return "denied_path"
			}
			n, err := fileLinks(f, fi)
			f.Close()
			if err != nil || n > 1 {
				return "symlink"
			}
		}
	}
	return ""
}
