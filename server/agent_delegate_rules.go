package main

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
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

// delegateInterpreters are the first words a delegated command never
// starts with: a shell, an interpreter, or a program that runs another
// one, so a prefix never stands for any code at all.
var delegateInterpreters = []string{
	"bash", "sh", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd",
	"env", "sudo", "doas", "su", "command", "builtin", "nice", "time", "script", "ssh",
	"npx", "pnpx", "bunx", "dlx", "node", "deno", "bun", "python", "python2", "python3", "perl", "ruby", "php", "lua", "awk",
	"eval", "exec", "source", ".", "xargs", "find", "nohup", "timeout", "watch", "make",
}

// delegateGitOptions are git options that run something else or write
// elsewhere.
var delegateGitOptions = []string{"-c", "--output", "--exec-path", "--config-env"}

// checkDelegateCommand is "" when cmd may be answered under a grant whose
// prefix is prefix (an empty prefix: checks cmd alone, as a prefix is when
// a grant is made), else the refusal code.
func checkDelegateCommand(cmd, prefix string) string {
	if cmd == "" || len(cmd) > maxGrantCommand {
		return "chars"
	}
	for i := 0; i < len(cmd); i++ {
		if c := cmd[i]; c < 0x20 || c > 0x7e || strings.IndexByte(delegateBadChars, c) >= 0 {
			return "chars"
		}
	}
	words := strings.Fields(cmd)
	// One space between words, none around: what the dialog shows wrapped
	// compares word for word.
	if strings.Join(words, " ") != cmd {
		return "chars"
	}
	first := filepath.Base(words[0])
	if slices.Contains(delegateInterpreters, strings.ToLower(first)) {
		return "interpreter"
	}
	if first == "git" {
		for _, w := range words[1:] {
			for _, o := range delegateGitOptions {
				if w == o || strings.HasPrefix(w, o+"=") || (o == "-c" && strings.HasPrefix(w, "-c") && len(w) > 2) {
					return "interpreter"
				}
			}
		}
	}
	if prefix != "" && cmd != prefix && !strings.HasPrefix(cmd, prefix+" ") {
		return "no_grant"
	}
	return ""
}

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
	".npmrc", ".yarnrc", ".yarnrc.yml", ".gitmodules", ".gitattributes", "lefthook.yml", ".lefthook.yml", ".pre-commit-config.yaml",
}

// delegateDeniedDirs are directories nothing under which a grant covers
// ("/"-separated, lowercased, from the worktree's root down).
var delegateDeniedDirs = []string{".git", ".claude", ".husky", ".githooks", ".vscode", ".idea", ".github/workflows", "node_modules"}

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
