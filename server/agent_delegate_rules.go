package main

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
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
	"npx", "pnpx", "bunx", "dlx", "uvx", "uv", "pipx", "tsx", "ts-node", "busybox", "node", "deno", "bun",
	"python", "perl", "ruby", "php", "lua", "awk", "eval", "exec", "source", ".", "xargs", "find", "nohup", "timeout",
	"watch", "make",
	// sed and ed run a program from their script (sed's e command, ed's !).
	"sed", "ed",
	// git runs any program through its options (--upload-pack, -x,
	// --exec, difftool, bisect run, submodule foreach) and its config.
	"git",
}

// delegateRunners are package managers with a word that runs any package:
// "pnpm dlx x", "npm exec x", and also after options ("pnpm -s exec x",
// "pnpm --filter a exec x"), so the word is refused at any position after
// the program's name. create and init fetch and run a create-* package
// ("npm init vite" is "npm exec create-vite"; innit is npm's alias).
var delegateRunners = map[string][]string{
	"npm":  {"exec", "x", "create", "init", "innit"},
	"pnpm": {"dlx", "exec", "x", "create"},
	"yarn": {"dlx", "exec", "create"},
	"bun":  {"x", "create"},
}

// delegateBundledOptions are programs that read their first argument as
// option letters even without a dash (GNU tar: "tar xIf ./x.sh a.tar"
// runs ./x.sh), so that word is an option when it comes after the prefix.
var delegateBundledOptions = []string{"tar"}

// interpreterVersionRe: a versioned name of an interpreter (python3.12).
var interpreterVersionRe = regexp.MustCompile(`^(python|perl|ruby|php|lua|node|deno|bun)[0-9.]*$`)

// commandName is a command's first word as its program is found: its base
// name, lowercased, without a Windows extension.
func commandName(w string) string {
	n := strings.ToLower(filepath.Base(strings.ReplaceAll(w, "\\", "/")))
	for _, ext := range []string{".exe", ".cmd", ".bat", ".com", ".ps1"} {
		n = strings.TrimSuffix(n, ext)
	}
	return n
}

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
	first := commandName(words[0])
	if slices.Contains(delegateInterpreters, first) || interpreterVersionRe.MatchString(first) {
		return "interpreter"
	}
	if runs, ok := delegateRunners[first]; ok {
		for _, w := range words[1:] {
			if slices.Contains(runs, strings.ToLower(w)) {
				return "interpreter"
			}
		}
	}
	if prefix == "" || cmd == prefix {
		return ""
	}
	if !strings.HasPrefix(cmd, prefix+" ") {
		return "no_grant"
	}
	// A word after the prefix is never an option: a granted program runs
	// another one through its own (rg --pre=x, tar --to-command=x, go test
	// -exec=x), so only what the user typed in the prefix chooses options.
	for _, w := range strings.Fields(cmd[len(prefix):]) {
		if strings.HasPrefix(w, "-") {
			return "option"
		}
	}
	// A prefix of the program's name alone leaves its first argument to
	// the command: for tar that word is an option bundle, dash or not.
	if slices.Contains(delegateBundledOptions, first) && len(strings.Fields(prefix)) == 1 && len(words) > 1 {
		return "option"
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
	"lefthook-local.yml", ".lefthook-local.yml", "opencode.json", "opencode.jsonc",
}

// delegateDeniedDirs are directories nothing under which a grant covers
// ("/"-separated, lowercased, from the worktree's root down).
var delegateDeniedDirs = []string{".git", ".claude", ".codex", ".opencode", ".agents", ".husky", ".githooks", ".lefthook",
	".vscode", ".idea", ".cargo", ".github/workflows", ".github/actions", "node_modules"}

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
