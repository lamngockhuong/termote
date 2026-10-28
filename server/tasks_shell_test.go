package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTaskShellKind(t *testing.T) {
	for name, want := range map[string]string{
		"bash": shellPOSIX, "-zsh": shellPOSIX, "/bin/sh": shellPOSIX, "dash": shellPOSIX, "ash": shellPOSIX,
		"ksh": shellPOSIX, "mksh": shellPOSIX, "yash": shellPOSIX, "fish": shellFish, "pwsh": shellPwsh,
		"pwsh.exe": shellPwsh, "PWSH.EXE": shellPwsh, "powershell": "", "powershell.exe": "", "cmd.exe": "",
		"nu": "", "csh": "", "tcsh": "", "elvish": "", "xonsh": "", "node": "", "": "",
	} {
		if got := taskShellKind(name); got != want {
			t.Errorf("taskShellKind(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestShellQuote(t *testing.T) {
	for _, tc := range []struct{ kind, in, want string }{
		{shellPOSIX, "test", "'test'"},
		{shellPOSIX, "it's", `'it'\''s'`},
		{shellPOSIX, `a\b $(x) ; #`, `'a\b $(x) ; #'`},
		{shellFish, `it's \x`, `'it\'s \\x'`},
		{shellPwsh, "it's", "'it''s'"},
		{shellPwsh, "a\u2019b\u2018c\u201ad\u201be", "'a\u2019\u2019b\u2018\u2018c\u201a\u201ad\u201b\u201be'"},
	} {
		if got := shellQuote(tc.kind, tc.in); got != tc.want {
			t.Errorf("shellQuote(%s, %q) = %q, want %q", tc.kind, tc.in, got, tc.want)
		}
	}
}

func TestTaskCommandAndLine(t *testing.T) {
	script := resolvedTask{Kind: taskKindScript, Name: "test:unit", PackageManager: "pnpm"}
	make := resolvedTask{Kind: taskKindMake, Name: "build"}
	user := resolvedTask{Kind: taskKindUser, ID: "0123456789abcdef", Command: "go test ./... &"}
	gradle := resolvedTask{Kind: "gradle", Name: "build", Head: "./gradlew", PwshHead: `.\gradlew.bat`, Args: []string{"build"}}
	hatch := resolvedTask{Kind: "hatch", Name: "test", Head: "hatch run", PwshHead: "hatch run", Args: []string{"default:test"}}
	goTest := resolvedTask{Kind: "go", Name: "test", Head: "go", PwshHead: "go", Args: []string{"test", "./..."}}
	for _, tc := range []struct {
		kind string
		task resolvedTask
		want string
	}{
		{shellPOSIX, script, "pnpm run 'test:unit'"},
		{shellPwsh, make, "make 'build'"},
		{shellPOSIX, user, "eval 'go test ./... &'"},
		{shellFish, user, "eval 'go test ./... &'"},
		{shellPwsh, user, "Invoke-Expression 'go test ./... &'"},
		{shellPOSIX, gradle, "./gradlew 'build'"},
		{shellFish, gradle, "./gradlew 'build'"},
		{shellPwsh, gradle, `.\gradlew.bat 'build'`},
		{shellPOSIX, hatch, "hatch run 'default:test'"},
		{shellPwsh, goTest, "go 'test' './...'"},
		{shellPOSIX, resolvedTask{Kind: "nope", Head: "x"}, ""},
		{shellPOSIX, resolvedTask{Kind: "go"}, ""},
	} {
		if got := taskCommand(tc.kind, tc.task); got != tc.want {
			t.Errorf("%s %v = %q, want %q", tc.kind, tc.task, got, tc.want)
		}
	}
	n := "0123456789abcdef"
	if got := buildTaskLine(shellPOSIX, "make 'x'", n); got != `printf '\n[termote-task `+n+` start]\n'; make 'x'; printf '\n[termote-task `+n+` exit %d]\n' "$?"` {
		t.Errorf("posix line = %s", got)
	}
	if got := buildTaskLine(shellFish, "make 'x'", n); !strings.HasSuffix(got, `exit %d]\n' $status`) {
		t.Errorf("fish line = %s", got)
	}
	pw := buildTaskLine(shellPwsh, "make 'x'", n)
	if !strings.HasPrefix(pw, "Write-Host \"`n[termote-task "+n+" start]\"; $global:LASTEXITCODE=0; make 'x'; ") ||
		!strings.Contains(pw, "$(if($LASTEXITCODE){$LASTEXITCODE}elseif($?){0}else{1})]") {
		t.Errorf("pwsh line = %s", pw)
	}
	for _, line := range []string{buildTaskLine(shellPOSIX, "x", n), buildTaskLine(shellFish, "x", n), pw} {
		if strings.ContainsAny(line, "\n\r") {
			t.Errorf("a task line holds a line break: %q", line)
		}
		// The line as echoed is no marker.
		if _, ok := parseTaskExit(line, n); ok {
			t.Errorf("the echoed line reads as an end marker: %s", line)
		}
	}
}

func TestParseTaskExit(t *testing.T) {
	n, other := "0123456789abcdef", "fedcba9876543210"
	for _, tc := range []struct {
		text string
		code int
		ok   bool
	}{
		{"[termote-task " + n + " exit 0]", 0, true},
		{"out\n[termote-task " + n + " exit 3]  \r\n$ ", 3, true},
		{"[termote-task " + n + " exit -1073741819]\n", -1073741819, true},
		{"[termote-task " + n + " exit 1]\n[termote-task " + n + " exit 2]\n", 2, true},
		{"[termote-task " + other + " exit 1]", 0, false},
		{"printf '\\n[termote-task " + n + " exit %d]\\n' \"$?\"", 0, false},
		{"x [termote-task " + n + " exit 1]", 0, false},
		{"[termote-task " + n + " exit 12345678901]", 0, false},
		{"", 0, false},
	} {
		code, ok := parseTaskExit(tc.text, n)
		if code != tc.code || ok != tc.ok {
			t.Errorf("%q = %d %v, want %d %v", tc.text, code, ok, tc.code, tc.ok)
		}
	}
}

func TestValidTaskDir(t *testing.T) {
	for _, ok := range []string{"/home/u/my repo", `C:\work\x`, "/tmp/#{pane_id}/$(x)", "/tmp/tên"} {
		if !validTaskDir(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "/a\nb", "/a\rb", "/a\x1bb", "/a\u202eb", "/a\u200bb", "/a\xffb"} {
		if validTaskDir(bad) {
			t.Errorf("%q allowed", bad)
		}
	}
}

// Every POSIX shell on this machine runs the line: the command's output
// between the markers, its exit status in the end one, a user command that
// ends in &, ; or a comment run whole, and names with shell characters
// passed as one word.
func TestTaskLineRunsInShells(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shells")
	}
	shells := map[string]string{}
	for _, s := range []string{"sh", "bash", "dash", "zsh", "ksh", "mksh", "fish"} {
		if p, err := exec.LookPath(s); err == nil {
			shells[s] = p
		}
	}
	if len(shells) == 0 {
		t.Skip("no shell")
	}
	dir := t.TempDir()
	// A fake make that prints its arguments, one per line.
	bin := filepath.Join(dir, "bin")
	os.MkdirAll(bin, 0o755)
	os.WriteFile(filepath.Join(bin, "make"), []byte("#!/bin/sh\nfor a; do echo \"arg:$a\"; done\nexit 4\n"), 0o755)
	nonce := "0123456789abcdef"
	for name, path := range shells {
		kind := taskShellKind(name)
		for _, tc := range []struct {
			task resolvedTask
			out  string
			code int
		}{
			{resolvedTask{Kind: taskKindUser, Command: "echo one; (exit 7)"}, "one", 7},
			{resolvedTask{Kind: taskKindUser, Command: "echo two;"}, "two", 0},
			{resolvedTask{Kind: taskKindUser, Command: "echo three # comment; exit 9"}, "three", 0},
			{resolvedTask{Kind: taskKindUser, Command: "sleep 0 & echo four"}, "four", 0},
			{resolvedTask{Kind: taskKindUser, Command: `echo "it's $((1+1))"`}, "it's 2", 0},
			{resolvedTask{Kind: taskKindMake, Name: "a;b$(echo x)`y`'z\\"}, "arg:a;b$(echo x)`y`'z\\", 4},
			{resolvedTask{Kind: "go", Head: "make", Args: []string{"default:test", "./..."}}, "arg:default:test\narg:./...", 4},
		} {
			if kind == shellFish && strings.Contains(tc.task.Command, "$((") {
				continue // fish has no arithmetic expansion
			}
			line := buildTaskLine(kind, taskCommand(kind, tc.task), nonce)
			cmd := exec.Command(path, "-c", line)
			cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			out, _ := cmd.CombinedOutput()
			code, ok := parseTaskExit(string(out), nonce)
			start := strings.Index(string(out), "[termote-task "+nonce+" start]\n")
			if !ok || code != tc.code || start < 0 || !strings.Contains(string(out)[start:], tc.out+"\n") {
				t.Errorf("%s: %q:\n%s\n= %d %v, want %d", name, tc.task, out, code, ok, tc.code)
			}
		}
	}
}
