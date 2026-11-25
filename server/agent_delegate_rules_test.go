package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// TestGrantPrefixCases runs the cases the PWA's grant-prefix.test.ts runs
// too, so both refuse the same prefixes for the same reason.
func TestGrantPrefixCases(t *testing.T) {
	data, err := os.ReadFile("testdata/grant-prefix-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Prefix, Want string }
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 100 {
		t.Fatalf("only %d cases", len(cases))
	}
	for _, tc := range cases {
		if got := checkGrantPrefix(tc.Prefix); got != tc.Want {
			t.Errorf("prefix %q = %q, want %q", tc.Prefix, got, tc.Want)
		}
	}
}

// TestDelegateTable keeps the table one a reader can trust: a word picks
// one kind of command only, a tool has no commands, and a program has
// some.
func TestDelegateTable(t *testing.T) {
	if len(delegateRules.Tools) == 0 || len(delegateRules.Programs) == 0 {
		t.Fatal("empty table")
	}
	for _, tool := range delegateRules.Tools {
		if _, ok := delegateRules.Programs[tool]; ok {
			t.Errorf("%s is a tool and a program", tool)
		}
	}
	for name, p := range delegateRules.Programs {
		seen := map[string]bool{}
		for _, c := range slices.Concat(p.Commands, p.Script, p.Bare) {
			if seen[c] || c == "" || strings.ToLower(c) != c {
				t.Errorf("%s: command %q", name, c)
			}
			seen[c] = true
		}
		if len(seen) == 0 {
			t.Errorf("%s has no command", name)
		}
		// An option is a switch or takes a value, never both, and is
		// spelled as typed alone (the =value form is derived).
		opts := map[string]bool{}
		for _, o := range slices.Concat(p.Switches, p.ValueOptions) {
			if opts[o] || !strings.HasPrefix(o, "-") || o == "-" || o == "--" || strings.Contains(o, "=") {
				t.Errorf("%s: option %q", name, o)
			}
			opts[o] = true
		}
	}
}

func TestCheckDelegateCommand(t *testing.T) {
	for _, tc := range []struct{ cmd, prefix, want string }{
		{"pnpm test", "pnpm test", ""},
		{"pnpm test --run", "pnpm test --run", ""},
		{"pnpm test src/a.test.ts", "pnpm test", ""},
		{"rg -n foo .", "rg -n", ""},
		{"rg foo .", "rg", ""},
		{"ls", "ls", ""},
		{"go test -run TestX ./server/...", "go test -run", ""},
		{"go test ./server/...", "go test", ""},
		{"npm test", "npm test", ""},
		{"npm run lint src", "npm run lint", ""},
		{"npm --prefix pwa run build", "npm --prefix pwa run build", ""},
		{"pnpm --filter termote run lint", "pnpm --filter termote run lint", ""},
		{"pnpm --filter termote test src", "pnpm --filter termote test", ""},
		{"pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile", ""},
		{"npm ci", "npm ci", ""},
		{"npm audit", "npm audit", ""},
		{"npm audit --json", "npm audit --json", ""},
		{"cargo +nightly test", "cargo +nightly test", ""},
		{"cargo test my_test", "cargo test", ""},
		{"cargo build --release", "cargo build --release", ""},
		{"dotnet test tests/a.csproj", "dotnet test", ""},
		{"pip show requests", "pip show", ""},
		{"go mod init x", "go mod", ""},
		{"ls src", "ls", ""},
		{"cat notes.txt", "cat", ""},
		{"rg foo user@example", "rg foo", ""},
		// Checked alone, a command may hold options: a grant's prefix may.
		{"rg -n --pre=./x.sh foo .", "", ""},
		{"npm test", "", ""},
		{"npm installTest x", "", "command"},
		{"bash -c x", "", "program"},
		// A word after the prefix is never an option: the granted program
		// would run another one through it.
		{"pnpm test --run", "pnpm test", "option"},
		{"pnpm test --reporter=dot src/a.test.ts", "pnpm test", "option"},
		{"npm test --x", "npm test", "option"},
		{"rg -n --pre=./x.sh foo .", "rg -n", "option"},
		{"rg -n foo --pre ./x.sh", "rg -n", "option"},
		{"go test -exec=./x.sh ./...", "go test", "option"},
		{"go test ./... -exec ./x.sh", "go test", "option"},
		{"go test - x", "go test", "option"},
		{"ls -", "ls", "option"},
		{"cargo build --release", "cargo build", "option"},
		{"npm audit --json", "npm audit", "option"},
		// Options that do not start with -.
		{"dotnet test /p:X=1", "dotnet test", "option"},
		{"dotnet build /property=X", "dotnet build", "option"},
		{"eslint @opts", "eslint", "option"},
		{"pytest +x", "pytest", "option"},
		// A bare command takes no word but options, under its prefix too.
		{"pnpm install x", "pnpm install", "command"},
		{"pnpm install --frozen-lockfile x", "pnpm install --frozen-lockfile", "command"},
		{"npm ci x", "npm ci", "command"},
		{"npm audit fix", "npm audit", "command"},
		// An option before the command must be one the table lists for
		// that program, so the agent's word is never taken for the command.
		{"cargo --locked install test evil", "cargo --locked install test", "command"},
		{"npm -w test install evil", "npm -w test install", "command"},
		{"pip -v install show evil", "pip -v install show", "command"},
		{"npm --prefix=pwa test src", "npm --prefix=pwa test", ""},
		// The command must start with the prefix, word for word.
		{"npm run other", "npm run lint", "no_grant"},
		{"npm run lint", "npm run lint src", "no_grant"},
		{"pnpm run lintx", "pnpm run lint", "no_grant"},
		{"pnpm test", "pnpm tests", "no_grant"},
		{"pnpm run lint", "pnpm test", "no_grant"},
		{"cargo test", "cargo build", "no_grant"},
		// A prefix the table refuses, from a grant made under older rules,
		// covers nothing: not even a command the table takes.
		{"npm test", "npm", "no_grant"},
		{"npm run lint", "npm", "no_grant"},
		{"pnpm test", "pnpm", "no_grant"},
		{"pnpm --filter a run lint", "pnpm --filter a", "no_grant"},
		{"pip show x", "pip", "no_grant"},
		{"cargo build", "cargo", "no_grant"},
		{"go test ./...", "go", "no_grant"},
		{"yarn test", "yarn workspace a", "no_grant"},
		// Under those older prefixes, the commands that slipped past the
		// old lists are refused alone, before any prefix.
		{"npm installTest x", "npm", "command"},
		{"npm installT x", "npm", "command"},
		{"npm lin x", "npm", "command"},
		{"npm explore dep npx x", "npm", "command"},
		{"npm explo dep x", "npm", "command"},
		{"npm pack github:a/b", "npm", "command"},
		{"npm distTag rm a latest", "npm", "command"},
		{"npm ogr rm o u", "npm", "command"},
		{"npm exec evil", "npm", "command"},
		{"npm install evil", "npm", "command"},
		{"npm --prefix pwa config set x=y", "npm --prefix pwa", "command"},
		{"pnpm --filter termote node x.js", "pnpm --filter termote", "command"},
		{"pnpm lint", "pnpm", "command"},
		{"yarn workspace a node x.js", "yarn workspace a", "command"},
		{"pip wheel x", "pip", "command"},
		{"pip download x", "pip", "command"},
		{"pip install -r requirements.txt", "pip", "command"},
		{"cargo install evil", "cargo", "command"},
		{"go run example.com/x@latest", "go", "command"},
		{"gem ins x", "gem", "program"},
		{"gem exec x", "gem", "program"},
		{"brew install u/t/f", "brew", "program"},
		{"tar xf a.tar", "tar", "program"},
		{"tar xIf ./x.sh a.tar", "tar xIf", "program"},
		{"/usr/bin/rg foo", "/usr/bin/rg", "program"},
		{"rg.exe foo", "rg.exe", "program"},
		{"X=1 bash x.sh", "X=1 bash", "program"},
		{"git status --short", "git status", "program"},
		{"make test", "make", "program"},
		// What a shell would read as more than words.
		{"pnpm test; rm -rf x", "pnpm test", "chars"},
		{"pnpm test && rm x", "pnpm test", "chars"},
		{"pnpm test | tee o", "pnpm test", "chars"},
		{"pnpm test > o", "pnpm test", "chars"},
		{"pnpm test < i", "pnpm test", "chars"},
		{"pnpm test $HOME", "pnpm test", "chars"},
		{"pnpm test `id`", "pnpm test", "chars"},
		{"pnpm test $(id)", "pnpm test", "chars"},
		{"pnpm test ~/x", "pnpm test", "chars"},
		{"pnpm test 'x'", "pnpm test", "chars"},
		{"pnpm test \"x\"", "pnpm test", "chars"},
		{"pnpm test *.ts", "pnpm test", "chars"},
		{"pnpm test \\x", "pnpm test", "chars"},
		{"pnpm test #x", "pnpm test", "chars"},
		{"pnpm test\nrm x", "pnpm test", "chars"},
		{"pnpm test\trm", "pnpm test", "chars"},
		{"pnpm test\x1b[2J", "pnpm test", "chars"},
		{"pnpm test​", "pnpm test", "chars"},
		{"pnpm test é", "pnpm test", "chars"},
		{"pnpm  test", "pnpm test", "chars"},
		{" pnpm test", "pnpm test", "chars"},
		{"pnpm test ", "pnpm test", "chars"},
		{"", "", "chars"},
		{"", "pnpm test", "chars"},
		{"rg " + strings.Repeat("a", maxGrantCommand), "rg", "chars"},
	} {
		if got := checkDelegateCommand(tc.cmd, tc.prefix); got != tc.want {
			t.Errorf("%q under %q = %q, want %q", tc.cmd, tc.prefix, got, tc.want)
		}
	}
}

func TestCheckDelegatePath(t *testing.T) {
	for rel, want := range map[string]string{
		"src/app.ts":                      "",
		"README.md":                       "",
		"docs/guide.md":                   "",
		".claude/settings.local.json":     "denied_path",
		"sub/.claude/settings.json":       "denied_path",
		".git/hooks/pre-commit":           "denied_path",
		"sub/.git":                        "denied_path",
		".mcp.json":                       "denied_path",
		"CLAUDE.md":                       "denied_path",
		"docs/claude.md":                  "denied_path",
		"AGENTS.md":                       "denied_path",
		"CLAUDE.local.md":                 "denied_path",
		"sub/AGENTS.override.md":          "denied_path",
		"lefthook.yaml":                   "denied_path",
		".lefthook-local.toml":            "denied_path",
		"lefthook.json":                   "denied_path",
		"lint-staged.config.js":           "denied_path",
		"lint-staged.config.mjs":          "denied_path",
		"sub/.lintstagedrc":               "denied_path",
		"sub/.lintstagedrc.json":          "denied_path",
		".lintstagedrc.yaml":              "denied_path",
		"commitlint.config.ts":            "denied_path",
		".commitlintrc.cjs":               "denied_path",
		".commitlintrc":                   "denied_path",
		"src/lint-staged-notes.md":        "",
		".pnpmfile.cjs":                   "denied_path",
		".pnpmfile.mjs":                   "denied_path",
		"pnpm-workspace.yaml":             "denied_path",
		".yarnrc.yaml":                    "denied_path",
		"bunfig.toml":                     "denied_path",
		"GEMINI.md":                       "denied_path",
		".gemini/settings.json":           "denied_path",
		".cursor/rules.md":                "denied_path",
		".devcontainer/devcontainer.json": "denied_path",
		"mise.toml":                       "denied_path",
		".mise.toml":                      "denied_path",
		".exrc":                           "denied_path",
		".gitlab-ci.yml":                  "denied_path",
		".circleci/config.yml":            "denied_path",
		"Jenkinsfile":                     "denied_path",
		"rust-toolchain.toml":             "denied_path",
		"rust-toolchain":                  "denied_path",
		"mise.local.toml":                 "denied_path",
		".config/mise.toml":               "denied_path",
		".config/mise/config.toml":        "denied_path",
		".mise/config.toml":               "denied_path",
		".vimrc":                          "denied_path",
		".nvimrc":                         "denied_path",
		"_exrc":                           "denied_path",
		"justfile":                        "denied_path",
		"Taskfile.yml":                    "denied_path",
		"Gemfile":                         "denied_path",
		"Rakefile":                        "denied_path",
		".config/other.toml":              "",
		".nvim.lua":                       "denied_path",
		"Directory.Build.props":           "denied_path",
		"sub/Directory.Build.targets":     "denied_path",
		"package.json":                    "denied_path",
		"web/package.json":                "denied_path",
		"pnpm-lock.yaml":                  "denied_path",
		"Makefile":                        "denied_path",
		".env":                            "denied_path",
		".env.local":                      "denied_path",
		".envrc":                          "denied_path",
		".husky/pre-commit":               "denied_path",
		".githooks/pre-push":              "denied_path",
		".vscode/settings.json":           "denied_path",
		".github/workflows/ci.yml":        "denied_path",
		"node_modules/x/index.js":         "denied_path",
		".yarn/releases/yarn-4.5.0.cjs":   "denied_path",
		".yarn/plugins/x/plugin.cjs":      "denied_path",
		".Yarn/sdks/x.js":                 "denied_path",
		"pkg/.yarn/cache/x.zip":           "denied_path",
		".yarn":                           "denied_path",
		"docs/yarn.md":                    "",
		".yarnish/x":                      "",
		"lefthook.yml":                    "denied_path",
		"keys/id_rsa":                     "denied_path",
		"../outside.txt":                  "denied_path",
		"a/../../outside.txt":             "denied_path",
		"/etc/passwd":                     "denied_path",
		"":                                "denied_path",
		".github/ISSUE_TEMPLATE/x.md":     "",
		"GIT~1/hooks/pre-commit":          "denied_path",
		"package.json.":                   "denied_path",
		"package.json ":                   "denied_path",
		"src/a.ts:stream":                 "denied_path",
		"AGENT\u017f.md":                  "denied_path",
		".lefthook/x.yml":                 "denied_path",
		".codex/config.toml":              "denied_path",
		".github/actions/x/action.yml":    "denied_path",
		"lefthook-local.yml":              "denied_path",
		"src/.envelope/not-an-env.txt":    "",
	} {
		if got := checkDelegatePath(rel); got != want {
			t.Errorf("%q = %q, want %q", rel, got, want)
		}
	}
}

func TestCheckDelegateFile(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	writeFile(t, filepath.Join(dir, "src", "a.ts"), "x")
	writeFile(t, filepath.Join(outside, "target.ts"), "x")
	if got := checkDelegateFile(dir, "src/a.ts"); got != "" {
		t.Errorf("regular file = %q", got)
	}
	if got := checkDelegateFile(dir, "src/new.ts"); got != "" {
		t.Errorf("new file = %q", got)
	}
	if got := checkDelegateFile(dir, "newdir/x.ts"); got != "" {
		t.Errorf("new dir = %q", got)
	}
	if runtime.GOOS == "windows" {
		t.Skip("symlinks and hard links need privileges on Windows")
	}
	// A symlink as the last component, and as a directory on the way.
	if err := os.Symlink(filepath.Join(outside, "target.ts"), filepath.Join(dir, "src", "link.ts")); err != nil {
		t.Fatal(err)
	}
	if got := checkDelegateFile(dir, "src/link.ts"); got != "symlink" {
		t.Errorf("symlinked file = %q", got)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "out")); err != nil {
		t.Fatal(err)
	}
	if got := checkDelegateFile(dir, "out/target.ts"); got != "symlink" {
		t.Errorf("symlinked dir = %q", got)
	}
	// A hard link to a file elsewhere.
	if err := os.Link(filepath.Join(outside, "target.ts"), filepath.Join(dir, "src", "hard.ts")); err != nil {
		t.Fatal(err)
	}
	if got := checkDelegateFile(dir, "src/hard.ts"); got != "symlink" {
		t.Errorf("hard link = %q", got)
	}
	if got := checkDelegateFile(dir, "src/a.ts/x"); got != "denied_path" {
		t.Errorf("file as a dir = %q", got)
	}
	if got := checkDelegateFile(filepath.Join(dir, "nope"), "a"); got != "denied_path" {
		t.Errorf("no dir = %q", got)
	}
}

func TestCheckDelegateHook(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "lefthook.yml"), `pre-commit:
  commands:
    i18n:
      root: "pwa/"
      run: sh ../scripts/staged-files.sh node scripts/check-i18n.mjs
`)
	writeFile(t, filepath.Join(dir, ".husky", "pre-push"), "./tools/Lint.sh\n")
	writeFile(t, filepath.Join(dir, ".pre-commit-config.yaml"), "repos:\n- repo: local\n  hooks:\n  - id: x\n    entry: python hooks/check.py\n")
	for rel, want := range map[string]string{
		"pwa/scripts/check-i18n.mjs": "denied_path",
		"scripts/staged-files.sh":    "denied_path",
		"tools/lint.sh":              "denied_path",
		"hooks/check.py":             "denied_path",
		"src/a.ts":                   "",
		"scripts/other.sh":           "",
		"pwa/scripts/check.mjs":      "",
	} {
		if got := checkDelegateHook(dir, rel); got != want {
			t.Errorf("checkDelegateHook(%q) = %q, want %q", rel, got, want)
		}
	}
	// No hook config: nothing more is denied.
	if got := checkDelegateHook(t.TempDir(), "scripts/staged-files.sh"); got != "" {
		t.Errorf("no config = %q", got)
	}
	if got := checkDelegateHook(filepath.Join(dir, "missing"), "a.ts"); got != "denied_path" {
		t.Errorf("missing dir = %q", got)
	}
}

func TestCheckDelegateCommandToolPaths(t *testing.T) {
	for _, tc := range []struct{ cmd, prefix, want string }{
		{"cat src/a.ts", "cat", ""},
		{"rg foo src", "rg", ""},
		{"cat /etc/hosts", "cat", "path"},
		{"cat ../x", "cat", "path"},
		{"rg foo src/../../x", "rg", "path"},
		{"head C:x", "head", "path"},
		{"diff a //host/share", "diff", "path"},
		// A program's command is not held to it: npm test takes a name.
		{"npm test /x", "npm test", ""},
	} {
		if got := checkDelegateCommand(tc.cmd, tc.prefix); got != tc.want {
			t.Errorf("%q under %q = %q, want %q", tc.cmd, tc.prefix, got, tc.want)
		}
	}
}

func TestPathWordValue(t *testing.T) {
	for w, want := range map[string]string{
		"a": "a", "-n": "", "--count": "", "-fx": "x", "-f=x": "x", "--file=a/b": "a/b", "@opts": "opts", "+x": "x",
	} {
		if got := pathWordValue(w); got != want {
			t.Errorf("%q = %q, want %q", w, got, want)
		}
	}
}

// checkToolPaths holds a tool to the grant's folder: where it runs, and
// where a word leads through a symbolic link.
func TestCheckToolPaths(t *testing.T) {
	dir := t.TempDir()
	out := t.TempDir()
	writeFile(t, filepath.Join(dir, "src", "a.ts"), "x")
	writeFile(t, filepath.Join(dir, "notes.txt"), "x")
	writeFile(t, filepath.Join(out, "secret.txt"), "x")
	src := filepath.Join(dir, "src")
	for _, tc := range []struct {
		dir, cwd string
		words    []string
		want     string
	}{
		{dir, dir, []string{"notes.txt", "src/a.ts"}, ""},
		{dir, src, []string{"a.ts", "-n", "--count", "pattern"}, ""},
		{dir, dir, nil, ""},
		// A word naming no file, or a file under one, is a pattern.
		{dir, dir, []string{"no-such", "notes.txt/x"}, ""},
		{dir, out, []string{"secret.txt"}, "outside"},
		{dir, filepath.Join(dir, "gone"), nil, "outside"},
		{"", dir, nil, "outside"},
		{dir, "", nil, "outside"},
		{"rel", dir, nil, "outside"},
		{dir, "rel", nil, "outside"},
		{filepath.Join(dir, "gone"), dir, nil, "outside"},
		{src, dir, nil, "outside"},
		// A file is no folder to open.
		{filepath.Join(dir, "notes.txt"), filepath.Join(dir, "notes.txt"), nil, "outside"},
	} {
		if got := checkToolPaths(tc.dir, tc.cwd, tc.words); got != tc.want {
			t.Errorf("%q in %q under %q = %q, want %q", tc.words, tc.cwd, tc.dir, got, tc.want)
		}
	}
	if err := os.Symlink(out, filepath.Join(dir, "away")); err != nil {
		t.Skipf("no symlinks: %v", err)
	}
	os.Symlink(filepath.Join(out, "secret.txt"), filepath.Join(dir, "key.txt"))
	os.Symlink(filepath.Join(out, "none"), filepath.Join(dir, "dangling"))
	os.Symlink("notes.txt", filepath.Join(dir, "in.txt"))
	// os.Root takes an absolute target as leaving, wherever it points.
	os.Symlink(filepath.Join(dir, "notes.txt"), filepath.Join(dir, "abs.txt"))
	for _, tc := range []struct {
		cwd   string
		words []string
		want  string
	}{
		{dir, []string{"in.txt"}, ""},
		{dir, []string{"key.txt"}, "outside"},
		{dir, []string{"abs.txt"}, "outside"},
		{dir, []string{"away/secret.txt"}, "outside"},
		{dir, []string{"away/none"}, "outside"},
		{dir, []string{"dangling"}, "outside"},
		{dir, []string{"-fkey.txt"}, "outside"},
		{dir, []string{"--file=key.txt"}, "outside"},
		// A folder reached through a link out of the grant's.
		{filepath.Join(dir, "away"), []string{"secret.txt"}, "outside"},
	} {
		if got := checkToolPaths(dir, tc.cwd, tc.words); got != tc.want {
			t.Errorf("%q in %q = %q, want %q", tc.words, tc.cwd, got, tc.want)
		}
	}
}

func TestGrantRulesRefuse(t *testing.T) {
	for _, tc := range []struct {
		g    grant
		want bool
	}{
		{grant{Kind: "bash", Prefix: "npm test"}, false},
		{grant{Kind: "bash", Prefix: "npm"}, true},
		{grant{Kind: "bash", Prefix: "cat", Dir: "/w"}, false},
		{grant{Kind: "bash", Prefix: "rg -n", Dir: "/w"}, false},
		// A tool's grant made before grants held a folder.
		{grant{Kind: "bash", Prefix: "cat"}, true},
		{grant{Kind: "bash", Prefix: "cat /etc", Dir: "/w"}, true},
		{grant{Kind: "edit", Dir: "/w"}, false},
		{grant{Kind: "ci"}, false},
	} {
		if got := grantRulesRefuse(tc.g); got != tc.want {
			t.Errorf("%+v = %v, want %v", tc.g, got, tc.want)
		}
	}
}

// A tool grant never reads the home folder's keys, nor a sensitive file of
// its own folder, and diff never walks a folder, where a link committed to
// the repository can lead out of it.
func TestCheckToolCommand(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	wt := filepath.Join(home, "proj")
	outside := filepath.Join(base, "outside-key")
	writeFile(t, outside, "k\n")
	writeFile(t, filepath.Join(home, ".ssh", "id_test"), "k\n")
	writeFile(t, filepath.Join(wt, ".env"), "k\n")
	writeFile(t, filepath.Join(wt, "src", "a.ts"), "a\n")
	writeFile(t, filepath.Join(wt, "dirB", "k"), "x\n")
	os.MkdirAll(filepath.Join(wt, "dirA"), 0o755)
	if err := os.Symlink(outside, filepath.Join(wt, "dirA", "k")); err != nil {
		t.Skip(err)
	}
	for _, tc := range []struct {
		dir, cwd, cmd, want string
	}{
		{wt, wt, "cat src/a.ts", ""},
		{wt, wt, "rg foo src", ""},
		{wt, wt, "diff src/a.ts dirB/k", ""},
		{wt, wt, "diff dirA dirB", "directory"},
		{wt, wt, "cat .env", "denied_path"},
		{home, home, "cat .ssh/id_test", "outside"},
		{home, wt, "cat src/a.ts", "outside"},
		{base, wt, "cat src/a.ts", "outside"},
	} {
		if got := checkToolCommand(tc.dir, tc.cwd, home, strings.Fields(tc.cmd)); got != tc.want {
			t.Errorf("%q in %s under %s = %q, want %q", tc.cmd, tc.cwd, tc.dir, got, tc.want)
		}
	}
}
