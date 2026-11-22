package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// useStartPromptDir points prompts' files at a dir of the test's, named
// name inside a temporary dir.
func useStartPromptDir(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	prev := startPromptDir
	startPromptDir = func() string { return dir }
	t.Cleanup(func() { startPromptDir = prev })
	return dir
}

// startPromptFiles lists the files in dir.
func startPromptFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, filepath.Join(dir, e.Name()))
	}
	return out
}

// The file holds the text as given, is the user's own (0600 in a 0700
// dir), and a write deletes the old prompts a stopped server left, and
// nothing else.
func TestWriteStartPrompt(t *testing.T) {
	dir := useStartPromptDir(t, "start-prompts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-startPromptKeep - time.Minute)
	for _, n := range []string{"prompt-1.txt", "notes.txt", "prompt-2.txt"} {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if n != "prompt-2.txt" {
			os.Chtimes(p, old, old)
		}
	}
	text := "fix the 'quoted' bug\n\tthen $(this) `too` 🚀\n"
	p, err := writeStartPrompt(text)
	if err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(p); err != nil || string(b) != text {
		t.Fatalf("file = %q %v", b, err)
	}
	if filepath.Dir(p) != dir || !startPromptNameRe.MatchString(filepath.Base(p)) {
		t.Errorf("path = %q", p)
	}
	got := startPromptFiles(t, dir)
	slices.Sort(got)
	want := []string{filepath.Join(dir, "notes.txt"), p, filepath.Join(dir, "prompt-2.txt")}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("files = %q, want %q", got, want)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
			t.Errorf("file mode = %v", fi.Mode())
		}
		if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
			t.Errorf("dir mode = %v", fi.Mode())
		}
	}
	removeStartPrompt(p)
	removeStartPrompt(p) // already gone: nothing to do
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Errorf("after remove: %v", err)
	}
}

// No cache dir, or one that is a symlink, gets no file.
func TestWriteStartPromptRefusedDir(t *testing.T) {
	prev := startPromptDir
	t.Cleanup(func() { startPromptDir = prev })
	startPromptDir = func() string { return "" }
	if _, err := writeStartPrompt("x"); err == nil {
		t.Error("no dir: no error")
	}
	if runtime.GOOS == "windows" {
		return
	}
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "start-prompts")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	startPromptDir = func() string { return link }
	if _, err := writeStartPrompt("x"); err == nil {
		t.Error("symlink dir: no error")
	}
	if files := startPromptFiles(t, real); len(files) != 0 {
		t.Errorf("wrote %q through the symlink", files)
	}
}

func TestPromptSubstitution(t *testing.T) {
	path := "/c/it's here/prompt-1.txt"
	for _, c := range []struct{ shell, kind, want string }{
		{shellPOSIX, "claude", `claude -- "$(command cat -- '/c/it'\''s here/prompt-1.txt')"`},
		{shellPOSIX, "codex", `codex '--no-daemon' -- "$(command cat -- '/c/it'\''s here/prompt-1.txt')"`},
		{shellPOSIX, "opencode", `opencode '--session' 'ses_1' --prompt="$(command cat -- '/c/it'\''s here/prompt-1.txt')"`},
		{shellFish, "claude", `claude -- (command cat -- '/c/it\'s here/prompt-1.txt' | string collect)`},
		{shellFish, "opencode", `opencode '--session' 'ses_1' --prompt=(command cat -- '/c/it\'s here/prompt-1.txt' | string collect)`},
	} {
		args := agentStartArgs[c.kind]()
		if c.kind == "opencode" {
			args = []string{"--session", "ses_1"}
		}
		if got := agentStartLine(c.shell, c.kind, args, path); got != c.want {
			t.Errorf("%s %s:\n got %s\nwant %s", c.shell, c.kind, got, c.want)
		}
	}
	if got := agentStartLine(shellPOSIX, "claude", nil, ""); got != "claude" {
		t.Errorf("no prompt: %q", got)
	}
}

// startPromptPrompts are prompts that would run a command, close a quote,
// pass an option or lose a character if any of them reached the line.
func startPromptPrompts(canary string) []string {
	return []string{
		"fix the 'quoted' bug",
		`say "hi" and $(touch ` + canary + `)`,
		"`touch " + canary + "`",
		"'; touch " + canary + "; echo '",
		`x\'; touch ` + canary + `; echo '`, // closes fish's quote in POSIX quoting
		`x\'; touch ` + canary + `; echo \`, // the same, balanced: runs in fish then
		`"; touch ` + canary + `; "`,
		"line one\nline two\n\tindented; touch " + canary,
		"Tiếng Việt có dấu, 日本語, emoji 🚀 ‘typographic’ “quotes”",
		"--dangerously-skip-permissions",
		"logout",
		`trailing backslash \`,
		"100% {a,b} [glob*] ~ !! !$ $HOME ${PATH} \\n",
		"  spaced  ",
	}
}

// The line, run by each real shell found, hands the agent its server
// arguments and then exactly the prompt (less trailing line breaks) as one
// argument, and runs nothing in it, also from a dir whose name needs
// quoting.
func TestAgentStartLineRealShells(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the POSIX shells and fish")
	}
	shells := map[string][]string{
		"bash": {"--norc", "--noprofile", "-c"},
		"zsh":  {"-f", "-c"},
		"dash": {"-c"},
		"sh":   {"-c"},
		"fish": {"--no-config", "-c"},
	}
	tmp := t.TempDir()
	bin := filepath.Join(tmp, "bin")
	os.Mkdir(bin, 0o700)
	// Each agent writes its arguments, NUL-terminated, to $ARGV_OUT.
	stub := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\000' \"$a\"; done > \"$ARGV_OUT\"\n"
	for _, k := range []string{"claude", "codex", "opencode"} {
		if err := os.WriteFile(filepath.Join(bin, k), []byte(stub), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	useStartPromptDir(t, "it's $(touch x) `y` dir")
	canary := filepath.Join(tmp, "canary")
	ran := 0
	for name, flags := range shells {
		path, err := exec.LookPath(name)
		if err != nil {
			t.Logf("%s not found: skipped", name)
			continue
		}
		ran++
		sh := resumeShellKind(name)
		t.Run(name, func(t *testing.T) {
			for _, kind := range []string{"claude", "codex", "opencode"} {
				for _, prompt := range startPromptPrompts(canary) {
					file, err := writeStartPrompt(prompt)
					if err != nil {
						t.Fatal(err)
					}
					args := agentStartArgs[kind]()
					out := filepath.Join(tmp, "argv")
					os.Remove(out)
					cmd := exec.Command(path, append(slices.Clone(flags), agentStartLine(sh, kind, args, file))...)
					cmd.Dir = tmp
					cmd.Env = []string{"PATH=" + bin + string(os.PathListSeparator) + os.Getenv("PATH"),
						"HOME=" + tmp, "XDG_CONFIG_HOME=" + tmp, "XDG_DATA_HOME=" + tmp, "ARGV_OUT=" + out}
					if b, err := cmd.CombinedOutput(); err != nil {
						t.Fatalf("%s %q: %v %s", kind, prompt, err, b)
					}
					b, err := os.ReadFile(out)
					if err != nil {
						t.Fatalf("%s %q: the agent did not run: %v", kind, prompt, err)
					}
					got := strings.Split(strings.TrimSuffix(string(b), "\x00"), "\x00")
					text := strings.TrimRight(prompt, "\n")
					want := append(slices.Clone(args), "--", text)
					if kind == "opencode" {
						want = append(slices.Clone(args), "--prompt="+text)
					}
					if !slices.Equal(got, want) {
						t.Errorf("%s %q: argv = %q, want %q", kind, prompt, got, want)
					}
					removeStartPrompt(file)
				}
			}
			if _, err := os.Stat(canary); err == nil {
				t.Fatal("a prompt ran a command")
			}
			if _, err := os.Stat(filepath.Join(tmp, "x")); err == nil {
				t.Fatal("the prompt dir's name ran a command")
			}
		})
	}
	if ran == 0 {
		t.Skip("no shell found")
	}
}
