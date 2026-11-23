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
		{"pnpm test --run", "pnpm test", ""},
		{"pnpm test --reporter=dot src/a.test.ts", "pnpm test", ""},
		{"go test ./server/...", "go test", ""},
		{"git status --short", "git status", ""},
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
		{"git -c core.pager=x log", "git", "interpreter"},
		{"git -ccore.pager=x log", "git", "interpreter"},
		{"git log --output=x", "git log", "interpreter"},
		{"git --exec-path=/x status", "git", "interpreter"},
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
