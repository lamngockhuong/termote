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
	if len(delegateRules.Tools) == 0 || len(delegateRules.Programs) == 0 || len(delegateRules.FlagOptions) == 0 {
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
	}
	for _, o := range delegateRules.FlagOptions {
		if !strings.HasPrefix(o, "-") || strings.Contains(o, "=") {
			t.Errorf("flag option %q", o)
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
		{"ls /tmp", "ls", ""},
		{"cat /etc/hosts", "cat", ""},
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
		{"tsc @opts", "tsc", "option"},
		{"pytest +x", "pytest", "option"},
		// A bare command takes no word but options, under its prefix too.
		{"pnpm install x", "pnpm install", "command"},
		{"pnpm install --frozen-lockfile x", "pnpm install --frozen-lockfile", "command"},
		{"npm ci x", "npm ci", "command"},
		{"npm audit fix", "npm audit", "command"},
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
