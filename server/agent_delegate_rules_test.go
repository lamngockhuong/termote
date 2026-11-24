package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCheckDelegateCommand(t *testing.T) {
	for _, tc := range []struct{ cmd, prefix, want string }{
		{"pnpm test", "pnpm test", ""},
		{"pnpm test --run", "pnpm test --run", ""},
		{"pnpm test src/a.test.ts", "pnpm test", ""},
		{"rg -n foo .", "rg -n", ""},
		{"tar -xf a.tar dir", "tar -xf", ""},
		{"go test -run TestX ./server/...", "go test -run", ""},
		// A word after the prefix is never an option: the granted program
		// would run another one through it.
		{"pnpm test --run", "pnpm test", "option"},
		{"pnpm test --reporter=dot src/a.test.ts", "pnpm test", "option"},
		{"rg -n --pre=./x.sh foo .", "rg -n", "option"},
		{"rg -n foo --pre ./x.sh", "rg -n", "option"},
		{"tar -xf a.tar --to-command=sh", "tar -xf", "option"},
		{"go test -exec=./x.sh ./...", "go test", "option"},
		{"go test ./... -exec ./x.sh", "go test", "option"},
		{"go test - x", "go test", "option"},
		{"ls -", "ls", "option"},
		// tar reads its first argument as option letters without a dash:
		// a prefix of its name alone leaves that word to the command.
		{"tar xIf ./x.sh a.tar", "tar", "option"},
		{"tar xf a.tar", "tar", "option"},
		{"tar t", "tar", "option"},
		{"/usr/bin/tar.exe xIf ./x.sh a.tar", "/usr/bin/tar.exe", "option"},
		{"tar", "tar", ""},
		{"tar xzf a.tar.gz", "tar xzf", ""},
		{"tar xzf a.tar.gz dir", "tar xzf a.tar.gz", ""},
		{"tar -xf a.tar", "tar -xf", ""},
		{"tar xIf ./x.sh a.tar", "", ""},
		{"rg foo .", "rg", ""},
		// A grant's prefix may hold options; checked alone, so may a command.
		{"rg -n --pre=./x.sh foo .", "", ""},
		// sed and ed run a program from their script.
		{"sed 1e./x.sh f", "sed", "interpreter"},
		{"sed -n 1p f", "", "interpreter"},
		{"ed f", "ed", "interpreter"},
		{"/usr/bin/SED.exe x", "", "interpreter"},
		// A package manager's runner word at any position after its name.
		{"pnpm exec rm x", "pnpm", "interpreter"},
		{"pnpm -s exec rm x", "pnpm", "interpreter"},
		{"pnpm --filter termote exec rm x", "pnpm --filter termote", "interpreter"},
		{"pnpm --filter termote dlx evil", "pnpm --filter termote", "interpreter"},
		{"pnpm --filter termote exec", "", "interpreter"},
		{"npm --prefix a x evil", "npm --prefix a", "interpreter"},
		{"yarn workspace a dlx evil", "yarn workspace a", "interpreter"},
		{"yarn workspace a exec evil", "", "interpreter"},
		{"npm run build EXEC", "npm run build", "interpreter"},
		// create and init run a create-* package from the registry.
		{"npm create vite", "npm", "interpreter"},
		{"npm init vite", "npm", "interpreter"},
		{"npm innit vite", "npm", "interpreter"},
		{"npm --prefix pwa init vite", "npm --prefix pwa", "interpreter"},
		{"npm init", "", "interpreter"},
		{"pnpm create vite", "pnpm", "interpreter"},
		{"pnpm --filter termote create vite", "pnpm --filter termote", "interpreter"},
		{"pnpm --filter a create", "", "interpreter"},
		{"yarn create vite", "yarn", "interpreter"},
		{"yarn workspace a create x", "", "interpreter"},
		{"bun create vite", "bun", "interpreter"},
		{"npm CREATE x", "", "interpreter"},
		// An install that names a package fetches it and runs its scripts.
		{"npm install evil", "npm", "interpreter"},
		{"npm i evil", "npm", "interpreter"},
		{"npm isntall evil", "npm", "interpreter"},
		{"npm --prefix pwa install evil", "npm --prefix pwa", "interpreter"},
		{"npm install --save-dev evil", "npm install --save-dev", "interpreter"},
		{"pnpm add evil", "pnpm", "interpreter"},
		{"pnpm --filter termote add -D evil", "", "interpreter"},
		{"pnpm i evil", "pnpm", "interpreter"},
		{"pnpm install --filter termote", "", "interpreter"},
		{"yarn add evil", "yarn", "interpreter"},
		{"yarn workspace a add evil", "yarn workspace a", "interpreter"},
		{"bun add evil", "", "interpreter"},
		{"npm ADD evil", "", "interpreter"},
		{"npm install", "npm", ""},
		{"npm i", "npm", ""},
		{"npm ci", "npm", ""},
		{"pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile", ""},
		{"pnpm --filter termote install", "pnpm --filter termote", ""},
		{"pnpm add", "", ""},
		{"yarn install", "yarn", ""},
		{"cargo add serde", "cargo", ""},
		{"pnpm --filter termote test src/add.test.ts", "pnpm --filter termote test", ""},
		// pnpm and yarn run a word that is no command of theirs as a program:
		// after the prefix it must be a known command.
		{"pnpm init", "pnpm", "interpreter"},
		{"pnpm init", "pnpm init", ""},
		{"pnpm --filter termote node scratch.js", "pnpm --filter termote", "interpreter"},
		{"pnpm --filter=termote node x.js", "pnpm --filter=termote", "interpreter"},
		{"pnpm -r tsx x.ts", "pnpm -r", "interpreter"},
		{"pnpm --unknown v node x.js", "pnpm --unknown", "interpreter"},
		{"pnpm --filter termote test", "pnpm --filter termote", ""},
		{"pnpm --filter termote run build", "pnpm --filter termote", ""},
		{"pnpm --filter termote lint src", "pnpm --filter termote lint", ""},
		{"pnpm -r --if-present test", "pnpm -r --if-present", ""},
		{"yarn x", "yarn", "interpreter"},
		{"yarn node x.js", "yarn", "interpreter"},
		{"yarn workspace a node x.js", "yarn workspace a", "interpreter"},
		{"yarn workspace a test", "yarn workspace a", ""},
		{"yarn run tsx x.ts", "yarn run", "interpreter"},
		{"yarn run tsx x.ts", "yarn", "interpreter"},
		{"yarn run lint src", "yarn run lint", ""},
		{"yarn test", "yarn", ""},
		// npm runs a command from any unique start of its name.
		{"npm --prefix pwa exe cowsay", "npm --prefix pwa", "interpreter"},
		{"npm exe x", "npm", "interpreter"},
		{"npm --prefix pwa cre evil", "npm --prefix pwa", "interpreter"},
		{"npm ini evil", "npm", "interpreter"},
		{"npm --prefix pwa create evil", "npm --prefix pwa", "interpreter"},
		{"npm --prefix pwa init evil", "npm --prefix pwa", "interpreter"},
		{"pnpm --filter termote create evil", "pnpm --filter termote", "interpreter"},
		// config writes the manager's config past the grant; pkg writes
		// package.json.
		{"npm --prefix pwa config set node-options=--inspect=127.0.0.1:9339", "npm --prefix pwa", "interpreter"},
		{"npm --prefix pwa config set node-options=--require=/tmp/x.js", "npm --prefix pwa", "interpreter"},
		{"npm --prefix pwa config set script-shell=/tmp/x.sh", "npm --prefix pwa", "interpreter"},
		{"npm c set node-options=--require=x", "npm", "interpreter"},
		{"npm set node-options=--require=x", "npm", "interpreter"},
		{"npm conf set x=y", "npm", "interpreter"},
		{"npm pkg set scripts.test=./x.sh", "npm", "interpreter"},
		{"pnpm config set node-options=--require=x", "pnpm", "interpreter"},
		{"pnpm --filter termote c set x=y", "pnpm --filter termote", "interpreter"},
		{"yarn config set x y", "yarn", "interpreter"},
		{"npm in", "npm", ""},
		{"npm se react", "npm", ""},
		{"npm --prefix pwa test", "npm --prefix pwa", ""},
		{"npm --prefix pwa run build", "npm --prefix pwa", ""},
		{"npm ci", "npm", ""},
		// tar's old option style under a prefix of its name alone.
		{"tar cIf sh out.tar notes.txt", "tar", "option"},
		{"yarn init", "", ""},
		{"cargo init", "cargo", ""},
		{"go mod init x", "go mod", ""},
		{"pnpm --filter termote test", "pnpm --filter termote", ""},
		{"pnpm --filter termote test src", "pnpm --filter termote test", ""},
		{"npm dlx", "npm", ""},
		{"cargo exec", "cargo", ""},
		{"go test ./server/...", "go test", ""},
		{"git status --short", "git status", "interpreter"},
		{"git ls-remote --upload-pack=node .", "git ls-remote", "interpreter"},
		{"GIT fetch", "GIT", "interpreter"},
		{"python.exe -m x", "python.exe", "interpreter"},
		{"node.exe x", "node.exe", "interpreter"},
		{"python3.12 -m x", "python3.12", "interpreter"},
		{"tsx x.ts", "tsx", "interpreter"},
		{"uvx ruff", "uvx", "interpreter"},
		{"busybox sh", "busybox", "interpreter"},
		{"pnpm dlx evil", "pnpm", "interpreter"},
		{"npm exec evil", "npm", "interpreter"},
		{"npm test", "npm", ""},
		{"pnpm run test", "pnpm run", ""},
		{"pnpm testx", "pnpm test", "no_grant"},
		{"pnpm tests", "pnpm test", "no_grant"},
		{"pnpm lint", "pnpm test", "no_grant"},
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
		{"", "", "chars"},
		{"bash -c x", "bash", "interpreter"},
		{"/bin/sh x.sh", "/bin/sh", "interpreter"},
		{"npx x", "npx", "interpreter"},
		{"env FOO=1 pnpm test", "env", "interpreter"},
		{"sudo pnpm test", "sudo", "interpreter"},
		{"python3 -m pytest", "python3", "interpreter"},
		{"xargs rm", "xargs", "interpreter"},
		{"make test", "make", "interpreter"},
	} {
		if got := checkDelegateCommand(tc.cmd, tc.prefix); got != tc.want {
			t.Errorf("%q under %q = %q, want %q", tc.cmd, tc.prefix, got, tc.want)
		}
	}
}

func TestCheckDelegatePath(t *testing.T) {
	for rel, want := range map[string]string{
		"src/app.ts":                   "",
		"README.md":                    "",
		"docs/guide.md":                "",
		".claude/settings.local.json":  "denied_path",
		"sub/.claude/settings.json":    "denied_path",
		".git/hooks/pre-commit":        "denied_path",
		"sub/.git":                     "denied_path",
		".mcp.json":                    "denied_path",
		"CLAUDE.md":                    "denied_path",
		"docs/claude.md":               "denied_path",
		"AGENTS.md":                    "denied_path",
		"CLAUDE.local.md":              "denied_path",
		"sub/AGENTS.override.md":       "denied_path",
		".pnpmfile.cjs":                "denied_path",
		".pnpmfile.mjs":                "denied_path",
		"pnpm-workspace.yaml":          "denied_path",
		".yarnrc.yaml":                 "denied_path",
		"bunfig.toml":                  "denied_path",
		"package.json":                 "denied_path",
		"web/package.json":             "denied_path",
		"pnpm-lock.yaml":               "denied_path",
		"Makefile":                     "denied_path",
		".env":                         "denied_path",
		".env.local":                   "denied_path",
		".envrc":                       "denied_path",
		".husky/pre-commit":            "denied_path",
		".githooks/pre-push":           "denied_path",
		".vscode/settings.json":        "denied_path",
		".github/workflows/ci.yml":     "denied_path",
		"node_modules/x/index.js":      "denied_path",
		"lefthook.yml":                 "denied_path",
		"keys/id_rsa":                  "denied_path",
		"../outside.txt":               "denied_path",
		"a/../../outside.txt":          "denied_path",
		"/etc/passwd":                  "denied_path",
		"":                             "denied_path",
		".github/ISSUE_TEMPLATE/x.md":  "",
		"GIT~1/hooks/pre-commit":       "denied_path",
		"package.json.":                "denied_path",
		"package.json ":                "denied_path",
		"src/a.ts:stream":              "denied_path",
		"AGENT\u017f.md":               "denied_path",
		".lefthook/x.yml":              "denied_path",
		".codex/config.toml":           "denied_path",
		".github/actions/x/action.yml": "denied_path",
		"lefthook-local.yml":           "denied_path",
		"src/.envelope/not-an-env.txt": "",
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
