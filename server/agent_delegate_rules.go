package main

import (
	"errors"
	"io"
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
	// GNU's and the other builds of awk and make.
	"gawk", "mawk", "nawk", "gmake",
	// sed and ed run a program from their script (sed's e command, ed's !).
	"sed", "ed",
	// More interpreters, and wrappers that run the program named after them.
	"gsed", "pythonw", "py", "pypy", "pypy3", "java", "jshell", "rscript", "julia", "tclsh", "wish", "expect", "osascript", "stdbuf", "setsid", "flock", "strace", "ltrace", "gdb", "lldb", "valgrind", "chroot", "unshare", "nsenter", "runuser", "pkexec", "ionice", "taskset", "chrt", "xvfb-run", "systemd-run", "caffeinate",
	// git runs any program through its options (--upload-pack, -x,
	// --exec, difftool, bisect run, submodule foreach) and its config.
	"git",
	// Container engines: "docker run <image>" runs any image of a
	// registry, and "docker compose up" reads a compose file the agent can
	// edit, which may mount the whole machine.
	"docker", "podman", "nerdctl", "docker-compose", "podman-compose",
}

// delegateSubcommands are programs whose command, the word after the
// name, must be one of these: cargo runs "cargo <x>", for any x no command
// of its own, as the program cargo-<x> it finds on PATH, and its install
// fetches and builds a crate the agent names. Each is spelled out: cargo's
// aliases (b, t, c) are ones a cargo config may redefine. One +toolchain
// (rustup's) may come before the command; after the grant's prefix it is
// an option like any other. build and test still run code the agent can
// edit (build.rs, its tests), as any build or test command does.
var delegateSubcommands = map[string][]string{
	"cargo": {"build", "test", "check", "clippy", "fmt"},
}

// delegateRunners are package managers with a word that runs any package:
// "pnpm dlx x", "npm exec x", and also after options ("pnpm -s exec x",
// "pnpm --filter a exec x"), so the word is refused at any position after
// the program's name. create and init fetch and run a create-* package
// ("npm init vite" is "npm exec create-vite"; innit is npm's alias).
// config, c and set write the manager's own config, outside the worktree
// and past the grant ("npm config set node-options=--require=x" loads x in
// every later npm script), and npm's pkg writes package.json, which no
// edit grant covers. The last ones act on the registry with the user's
// login (publish the worktree, change an owner, make a token); pnpm hands
// them to npm.
var delegateRunners = map[string][]string{
	"npm": {"exec", "x", "create", "init", "innit", "config", "c", "set", "pkg",
		"publish", "unpublish", "deprecate", "dist-tag", "dist-tags", "owner", "author", "access", "token",
		"adduser", "add-user", "login", "logout", "signin", "signout", "team", "org", "star", "unstar"},
	"pnpm": {"dlx", "exec", "x", "create", "config", "c", "set", "pkg",
		"publish", "unpublish", "deprecate", "dist-tag", "owner", "access", "token",
		"adduser", "login", "logout", "team", "star", "unstar"},
	"yarn": {"dlx", "exec", "create", "config", "publish", "login", "logout", "owner", "team", "tag", "npm"},
	"bun":  {"x", "create"},
}

// delegateAbbrevNames are the exact words npm takes for one of its own
// commands although they start a runner word of its: npm also runs a
// command from any unique start of its name ("npm exe x" is "npm exec
// x"), so another word of two letters or more that starts one is refused
// too ("in", "add" are install's aliases, "un" uninstall's, "se" search's).
var delegateAbbrevNames = []string{"in", "add", "un", "se"}

// delegateKnownCommands are the commands of pnpm and yarn a delegated
// command may name after the grant's prefix: both run a word that is no
// command of theirs as a script or, without one, as a program ("pnpm
// --filter a node x.js" runs node), so the word that picks the command is
// one of these unless the user typed it into the prefix. yarn has no run
// here: "yarn run <name>" runs any program of node_modules/.bin too.
var delegateKnownCommands = map[string][]string{
	"pnpm": {"add", "audit", "bin", "dedupe", "fetch", "i", "install", "install-test", "it", "licenses", "list", "ls",
		"outdated", "pack", "prune", "rb", "rebuild", "remove", "rm", "root", "run", "run-script", "start", "store",
		"t", "test", "tst", "un", "uninstall", "unlink", "up", "update", "upgrade", "why"},
	"yarn": {"add", "audit", "info", "install", "licenses", "list", "outdated", "pack", "remove", "start", "test",
		"up", "upgrade", "why"},
}

// delegateFlagOptions are pnpm's and yarn's options that take no value.
// Any other option without "=" is taken to take the word after it, so the
// word picking the command is never mistaken for an option's value the
// user typed.
var delegateFlagOptions = []string{"-r", "--recursive", "-s", "--silent", "-w", "--workspace-root", "--parallel",
	"--stream", "--if-present", "--aggregate-output", "--bail", "--no-bail", "--sequential", "--color", "--no-color",
	"--frozen-lockfile", "--prod", "--dev", "--offline", "--prefer-offline", "--reverse", "--include-workspace-root",
	"-D", "-P", "-O"}

// commandWord is the index in words (a pnpm or yarn command) of the word
// that picks its command, past options and their values ("yarn workspace
// <name>" is skipped too), or -1 when none does.
func commandWord(words []string, first string) int {
	for i := 1; i < len(words); i++ {
		w := words[i]
		switch {
		case strings.HasPrefix(w, "-"):
			if !strings.Contains(w, "=") && !slices.Contains(delegateFlagOptions, w) {
				i++
			}
		case first == "yarn" && strings.ToLower(w) == "workspace":
			i++
		default:
			return i
		}
	}
	return -1
}

// delegateInstallers are package managers' words that install the
// packages named after them: an install fetches a package the agent names
// and runs its install scripts, and writes package.json and the lockfile,
// which no edit grant covers. Refused when any word after one is no option
// ("npm i x", "pnpm add -D x"); an install with no package ("npm ci",
// "pnpm install --frozen-lockfile", "pnpm --filter a install") installs
// what the lockfile holds. npm's list holds its aliases of install.
var delegateInstallers = map[string][]string{
	"npm":  {"install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add"},
	"pnpm": {"install", "i", "add"},
	"yarn": {"install", "add"},
	"bun":  {"install", "i", "add", "a"},
}

// delegateBundledOptions are programs that read their first argument as
// option letters even without a dash (GNU tar: "tar xIf ./x.sh a.tar"
// runs ./x.sh), so that word is an option when it comes after the prefix.
var delegateBundledOptions = []string{"tar"}

// interpreterVersionRe: a versioned name of an interpreter (python3.12).
var interpreterVersionRe = regexp.MustCompile(`^(python|pypy|perl|ruby|php|lua|node|deno|bun)[0-9.]*$`)

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
	// A variable set before the program (X=1 bash) is what env does: the
	// program is not the first word, and the variable can make any one run
	// another (NODE_OPTIONS, LD_PRELOAD).
	if strings.Contains(words[0], "=") {
		return "interpreter"
	}
	first := commandName(words[0])
	if slices.Contains(delegateInterpreters, first) || interpreterVersionRe.MatchString(first) {
		return "interpreter"
	}
	if runs, ok := delegateRunners[first]; ok {
		for _, w := range words[1:] {
			lw := strings.ToLower(w)
			if slices.Contains(runs, lw) {
				return "interpreter"
			}
			if first == "npm" && len(lw) >= 2 && !slices.Contains(delegateAbbrevNames, lw) &&
				slices.ContainsFunc(runs, func(r string) bool { return strings.HasPrefix(r, lw) }) {
				return "interpreter"
			}
		}
	}
	if inst, ok := delegateInstallers[first]; ok {
		for i := 1; i < len(words); i++ {
			if slices.Contains(inst, strings.ToLower(words[i])) &&
				slices.ContainsFunc(words[i+1:], func(w string) bool { return !strings.HasPrefix(w, "-") }) {
				return "interpreter"
			}
		}
	}
	if allowed, ok := delegateSubcommands[first]; ok {
		k := 1
		if k < len(words) && strings.HasPrefix(words[k], "+") {
			k++
		}
		if k < len(words) && !slices.Contains(allowed, words[k]) {
			return "interpreter"
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
		if optionLike(w) {
			return "option"
		}
	}
	// pnpm and yarn run a word that is no command of theirs as a program:
	// one the user did not type in the prefix must be a known command, and
	// yarn's name after run must be the user's too.
	if known, ok := delegateKnownCommands[first]; ok {
		n := len(strings.Fields(prefix))
		k := commandWord(words, first)
		if k >= n && !slices.Contains(known, strings.ToLower(words[k])) {
			return "interpreter"
		}
		if first == "yarn" && k >= 0 && strings.ToLower(words[k]) == "run" && k+1 >= n && k+1 < len(words) {
			return "interpreter"
		}
	}
	// A prefix of the program's name alone leaves its first argument to
	// the command: for tar that word is an option bundle, dash or not.
	if slices.Contains(delegateBundledOptions, first) && len(strings.Fields(prefix)) == 1 && len(words) > 1 {
		return "option"
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
	".gemini", ".cursor", ".devcontainer"}

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
