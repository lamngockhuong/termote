package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestValidTaskName(t *testing.T) {
	for _, ok := range []string{"test", "build:prod", "lint_fix", "a.b", "a@1/x", "x+y", "a-b", "9", strings.Repeat("a", 100)} {
		if !validTaskName(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "-rf", "@scope/x", ".hidden", "a b", "a;b", "$(x)", "a`b`", "#{x}", "#(x)", "a'b", `a\b`, "a\nb", "tên", "a’b", strings.Repeat("a", 101)} {
		if validTaskName(bad) {
			t.Errorf("%q allowed", bad)
		}
	}
}

func TestParsePackageJSON(t *testing.T) {
	long := "a" + strings.Repeat("é", maxScriptShown) // cut inside an é
	scripts, pm, skipped := parsePackageJSON([]byte(`{
		"name": "x", "nested": {"scripts": {"no": "x"}}, "list": [1, {"a": 2}],
		"packageManager": "pnpm@9.1.0",
		"scripts": {
			"test": "vitest run",
			"pretest": "tsc",
			"posttest": "echo done",
			"build": "vite build",
			"bad name": "x",
			"-rf": "x",
			"num": 1,
			"long": "` + long + `",
			"build": "vite build --mode prod"
		}
	}`))
	if pm != "pnpm@9.1.0" || skipped != 3 {
		t.Errorf("pm %q skipped %d", pm, skipped)
	}
	got := []string{}
	for _, s := range scripts {
		got = append(got, fmt.Sprintf("%s=%s%v", s.Name, s.Command[:min(len(s.Command), 22)], s.Hooks))
	}
	want := "test=vitest run[pretest posttest] pretest=tsc[] posttest=echo done[] build=vite build --mode prod[] long=" + long[:22] + "[]"
	if strings.Join(got, " ") != want {
		t.Errorf("scripts = %s\nwant      %s", strings.Join(got, " "), want)
	}
	last := scripts[len(scripts)-1]
	if !last.Truncated || len(last.Command) != maxScriptShown-1 || scripts[0].Truncated {
		t.Errorf("cut = %v %d", last.Truncated, len(last.Command))
	}

	for _, data := range []string{``, `[]`, `{"scripts": "x"}`, `{"scripts": []}`, `{"scripts": {"a": }`, `{"scripts": {"a": "x"`, `{"scripts": {1: "x"}}`, `{"a": }`, `{"packageManager": }`, `{"a"`, `{1: 2}`, `{"packageManager": 3}`} {
		scripts, pm, _ := parsePackageJSON([]byte(data))
		if len(scripts) != 0 || pm != "" {
			t.Errorf("%s: %v %q", data, scripts, pm)
		}
	}
}

func TestParsePackageJSONLimit(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"scripts":{`)
	for i := range maxTaskItems + 3 {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `"s%d":"x"`, i)
	}
	b.WriteString("}}")
	scripts, _, skipped := parsePackageJSON([]byte(b.String()))
	if len(scripts) != maxTaskItems || skipped != 3 {
		t.Errorf("%d scripts, %d skipped", len(scripts), skipped)
	}
}

func TestParseMakeTargets(t *testing.T) {
	mk := strings.Join([]string{
		"URL = http://x",
		"HOST ?= a:b",
		"X += c:d",
		"FOO != cmd:x",
		"export A := 1",
		"B := c:d",
		"C ::= e:f",
		"D :::= g:h",
		"LONG = a \\",
		"  b:c",
		".PHONY: build test",
		"%.o: %.c",
		"$(X): y",
		"build: deps # comment: x",
		"\techo build: recipe",
		"a b: c",
		"ifeq ($(X),1)",
		"inside: x",
		"endif",
		"define BODY",
		"notatarget: x",
		"endef",
		"test:: unit",
		"test: again",
		"bad;name: x",
		"-include other.mk",
		"# all: commented",
		"deploy: TARGET_VAR = 1",
		"",
		"   ",
		"no colon here",
		"windows:\r",
		"override define BLOCK",
		"ghost: x",
		"endef",
		"$(info a:b)",
		"$(OBJ) extra: y",
	}, "\n")
	targets, skipped := parseMakeTargets([]byte(mk))
	got := []string{}
	for _, tg := range targets {
		got = append(got, tg.Name)
	}
	if want := "build a b inside test deploy windows"; strings.Join(got, " ") != want || skipped != 1 {
		t.Errorf("targets = %v skipped %d, want %s", got, skipped, want)
	}

	var b strings.Builder
	for i := range maxTaskItems + 2 {
		fmt.Fprintf(&b, "t%d:\n", i)
	}
	targets, skipped = parseMakeTargets([]byte(b.String()))
	if len(targets) != maxTaskItems || skipped != 2 {
		t.Errorf("%d targets, %d skipped", len(targets), skipped)
	}
}

func openTestRoot(t *testing.T, dir string) *os.Root {
	t.Helper()
	rt, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rt.Close() })
	return rt
}

func TestPickMakefileAndPackageManager(t *testing.T) {
	dir := t.TempDir()
	rt := openTestRoot(t, dir)
	if got := pickMakefile(rt); got != "" {
		t.Errorf("none = %q", got)
	}
	writeFile(t, filepath.Join(dir, "Makefile"), "a:\n")
	if got := pickMakefile(rt); got != "Makefile" {
		t.Errorf("Makefile only = %q", got)
	}
	writeFile(t, filepath.Join(dir, "GNUmakefile"), "a:\n")
	if got := pickMakefile(rt); got != "GNUmakefile" {
		t.Errorf("all = %q", got)
	}
	// A root that cannot be listed has none
	closed, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	closed.Close()
	if got := pickMakefile(closed); got != "" {
		t.Errorf("closed root = %q", got)
	}
	// Where the file system ignores case, the name shown is the file's
	if runtime.GOOS != "linux" {
		cased := t.TempDir()
		writeFile(t, filepath.Join(cased, "MAKEFILE"), "a:\n")
		if got := pickMakefile(openTestRoot(t, cased)); got != "MAKEFILE" {
			t.Errorf("MAKEFILE = %q", got)
		}
	}

	if got := detectPackageManager(rt, ""); got != "npm" {
		t.Errorf("default = %s", got)
	}
	for _, tc := range []struct{ lock, want string }{
		{"bun.lockb", "bun"}, {"bun.lock", "bun"}, {"yarn.lock", "yarn"}, {"pnpm-lock.yaml", "pnpm"},
	} {
		writeFile(t, filepath.Join(dir, tc.lock), "")
		if got := detectPackageManager(rt, "unknown@1"); got != tc.want {
			t.Errorf("with %s = %s", tc.lock, got)
		}
	}
	for field, want := range map[string]string{"yarn@4.1.0": "yarn", "npm@10": "npm", "bun@1.1": "bun", "pnpm": "pnpm"} {
		if got := detectPackageManager(rt, field); got != want {
			t.Errorf("%s = %s", field, got)
		}
	}
}

func TestReadTaskFile(t *testing.T) {
	dir := t.TempDir()
	rt := openTestRoot(t, dir)
	writeFile(t, filepath.Join(dir, "ok.json"), "{}")
	if b, err := readTaskFile(rt, "ok.json"); err != nil || string(b) != "{}" {
		t.Errorf("ok = %q %v", b, err)
	}
	os.WriteFile(filepath.Join(dir, "big"), make([]byte, maxTaskFile+1), 0o644)
	if _, err := readTaskFile(rt, "big"); !errors.Is(err, errTaskFileTooLarge) {
		t.Errorf("big = %v", err)
	}
	os.WriteFile(filepath.Join(dir, "edge"), make([]byte, maxTaskFile), 0o644)
	if _, err := readTaskFile(rt, "edge"); err != nil {
		t.Errorf("edge = %v", err)
	}
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	if _, err := readTaskFile(rt, "sub"); !errors.Is(err, errTaskFileNotRegular) {
		t.Errorf("dir = %v", err)
	}
	if _, err := readTaskFile(rt, "missing"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing = %v", err)
	}
	if runtime.GOOS == "windows" {
		return
	}
	outside := filepath.Join(t.TempDir(), "package.json")
	writeFile(t, outside, `{"scripts":{"x":"y"}}`)
	os.Symlink(outside, filepath.Join(dir, "out.json"))
	if _, err := readTaskFile(rt, "out.json"); err == nil {
		t.Error("a symlink out of the root was read")
	}
	if _, err := exec.LookPath("mkfifo"); err != nil {
		return
	}
	exec.Command("mkfifo", filepath.Join(dir, "pipe")).Run()
	done := make(chan error, 1)
	go func() {
		_, err := readTaskFile(rt, "pipe")
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, errTaskFileNotRegular) {
			t.Errorf("fifo = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reading a FIFO hung")
	}
	if os.Geteuid() != 0 {
		writeFile(t, filepath.Join(dir, "secret"), "x")
		os.Chmod(filepath.Join(dir, "secret"), 0)
		if _, err := readTaskFile(rt, "secret"); err == nil {
			t.Error("an unreadable file was read")
		}
	}
}

// A read that fails after the open (a directory opened as a file on some
// systems) is an error, not an empty file.
func TestReadTaskFileReadFails(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("/proc")
	}
	rt := openTestRoot(t, "/proc/self")
	// mem is a regular file whose read at offset 0 fails.
	if _, err := readTaskFile(rt, "mem"); err == nil {
		t.Error("a failed read returned no error")
	}
}
