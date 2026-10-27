package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// allowPathCLI is a test CLI with its config, state and data dirs created,
// as an installed termote has them.
func allowPathCLI(t *testing.T, goos string) *testCLI {
	t.Helper()
	tc := newTestCLI(t, goos)
	for _, d := range []string{tc.configDir(), tc.stateDir(), tc.dataDir(), filepath.Join(tc.home, ".ssh"), filepath.Join(tc.home, ".gnupg")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return tc
}

func mkdir(t *testing.T, p string) string {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestValidateAllowPath(t *testing.T) {
	tc := allowPathCLI(t, runtime.GOOS)
	home := tc.home
	env := tc.allowPathEnv()
	env.isGitDir = func(string) bool { return false }
	notes := mkdir(t, filepath.Join(home, "notes"))
	fish := mkdir(t, filepath.Join(home, ".config", "fish"))
	gitDir := mkdir(t, filepath.Join(home, "proj", ".git", "objects"))
	writeFile(t, filepath.Join(home, "file.txt"), "x")
	sshLink := filepath.Join(home, "keys")
	rootLink := filepath.Join(home, "everything")
	if err := os.Symlink(filepath.Join(home, ".ssh"), sshLink); err != nil {
		t.Skip("no symlinks:", err)
	}
	if err := os.Symlink(string(filepath.Separator), rootLink); err != nil {
		t.Fatal(err)
	}
	root := filepath.VolumeName(home) + string(filepath.Separator)

	for _, p := range []string{notes, fish} {
		if err := validateAllowPath(p, env); err != nil {
			t.Errorf("%s refused: %v", p, err)
		}
	}
	for p, want := range map[string]string{
		root:                                "home directory",
		home:                                "home directory",
		filepath.Dir(home):                  "home directory",
		rootLink:                            "home directory",
		filepath.Join(home, ".ssh"):         "never serves",
		filepath.Join(home, ".gnupg"):       "never serves",
		sshLink:                             "never serves",
		filepath.Join(home, ".local"):       "never serves", // holds the state and data dirs
		filepath.Join(home, ".config"):      "never serves", // holds the config dir
		tc.configDir():                      "never serves",
		filepath.Join(home, "proj", ".git"): "git directory",
		gitDir:                              "git directory",
		filepath.Join(home, "missing"):      "not a directory",
		filepath.Join(home, "file.txt"):     "not a directory",
	} {
		if err := validateAllowPath(p, env); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", p, err, want)
		}
	}
	if err := validateAllowPath(mkdir(t, filepath.Join(home, ".ssh", "x")), env); err == nil {
		t.Error("a folder inside ~/.ssh accepted")
	}
	if runtime.GOOS == "linux" {
		if err := validateAllowPath("/proc", env); err == nil || !strings.Contains(err.Error(), "never serves") {
			t.Errorf("/proc: %v", err)
		}
	}
	// A case-insensitive file system names ~/.ssh in any case.
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		if err := validateAllowPath(filepath.Join(home, ".SSH"), env); err == nil {
			t.Error("~/.SSH accepted")
		}
	}
	if err := validateAllowPath(notes+`"x`, env); !errors.Is(err, errAllowPathChars) {
		t.Errorf("quote: %v", err)
	}
	if err := validateAllowPath(notes, allowPathEnv{}); err == nil {
		t.Error("accepted without a home directory")
	}
	probed := ""
	env.isGitDir = func(d string) bool { probed = d; return true }
	if err := validateAllowPath(notes, env); err == nil || !strings.Contains(err.Error(), "git directory") || probed != notes {
		t.Errorf("git probe: %v, probed %q", err, probed)
	}
}

func TestGitDirProbe(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	bare := filepath.Join(dir, "bare.git")
	work := filepath.Join(dir, "work")
	for _, args := range [][]string{{"init", "-q", "--bare", bare}, {"init", "-q", work}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	probe := gitDirProbe(newGitRunner())
	plain := mkdir(t, filepath.Join(dir, "plain"))
	for d, want := range map[string]bool{
		bare: true, filepath.Join(bare, "objects"): true, filepath.Join(work, ".git"): true,
		work: false, mkdir(t, filepath.Join(work, "sub")): false, plain: false,
	} {
		if got := probe(d); got != want {
			t.Errorf("%s: %v, want %v", d, got, want)
		}
	}
}

func TestNormalizeAndMergePaths(t *testing.T) {
	if _, err := normalizeAllowPath(""); err == nil {
		t.Error("empty path accepted")
	}
	wd, _ := os.Getwd()
	if p, err := normalizeAllowPath("rel/../x"); err != nil || p != filepath.Join(wd, "x") {
		t.Errorf("relative: %q %v", p, err)
	}
	a, b, c := filepath.FromSlash("/a"), filepath.FromSlash("/b"), filepath.FromSlash("/c")
	if got := mergePaths([]string{c, a}, []string{b, a}, []string{c}); strings.Join(got, ",") != strings.Join([]string{a, b}, ",") {
		t.Errorf("merge: %v", got)
	}
	if got := mergePaths(nil, nil, []string{a}); len(got) != 0 {
		t.Errorf("remove of nothing: %v", got)
	}
}

func TestSplitPaths(t *testing.T) {
	if got := splitPaths("/a b:/c,d::"); strings.Join(got, "|") != "/a b|/c,d" {
		t.Errorf("split: %q", got)
	}
	if splitPaths("") != nil {
		t.Error("empty list not nil")
	}
}

func TestParseStartArgsPaths(t *testing.T) {
	tc := newTestCLI(t, "linux")
	notes := mkdir(t, filepath.Join(tc.home, "notes"))
	o, _, err := tc.parseStartArgs([]string{"--allow-path", notes + string(filepath.Separator), "--remove-path", filepath.Join(notes, "..", "old")})
	if err != nil || strings.Join(o.newPaths, ",") != notes || strings.Join(o.removePaths, ",") != filepath.Join(tc.home, "old") {
		t.Fatalf("got %+v %v", o, err)
	}
	if _, _, err := tc.parseStartArgs([]string{"--allow-path", ""}); err == nil {
		t.Error("empty --allow-path accepted")
	}
	// Saved, plus added, minus removed.
	mergeSaved(&o, map[string]bool{}, &savedConfig{AllowPaths: []string{filepath.Join(tc.home, "old"), filepath.Join(tc.home, "keep")}})
	if strings.Join(o.allowPaths, ",") != filepath.Join(tc.home, "keep")+","+notes {
		t.Fatalf("merged: %v", o.allowPaths)
	}
}

func TestStartAllowPaths(t *testing.T) {
	tc := allowPathCLI(t, "linux")
	notes := mkdir(t, filepath.Join(tc.home, "notes"))
	gone := filepath.Join(tc.home, "gone")
	saved := &savedConfig{AllowPaths: []string{gone, notes}}

	// A saved path that no longer passes is reported, kept and not fatal.
	o := startOptions{mux: "tmux", allowPaths: []string{gone, notes}}
	if err := tc.startAllowPaths(o, saved); err != nil {
		t.Fatal(err)
	}
	want := "Allowed path skipped: " + gone + ": not a directory (remove it with: termote start --remove-path " + gone + ")"
	if !strings.Contains(tc.stdout.String(), want) {
		t.Errorf("skipped saved path not reported:\n%s", tc.stdout.String())
	}

	// A new one that fails refuses the start.
	o = startOptions{mux: "tmux", allowPaths: []string{tc.home}, newPaths: []string{tc.home}}
	if err := tc.startAllowPaths(o, nil); err == nil || !strings.Contains(err.Error(), "--allow-path "+tc.home+": is your home directory") {
		t.Errorf("home accepted: %v", err)
	}
	colon := mkdir(t, filepath.Join(tc.home, "a:b"))
	o = startOptions{mux: "tmux", allowPaths: []string{colon}, newPaths: []string{colon}}
	if err := tc.startAllowPaths(o, nil); err == nil || !strings.Contains(err.Error(), "':' cannot be saved") {
		t.Errorf("':' accepted on Unix: %v", err)
	}

	// --remove-path of a path not saved says so.
	tc.stdout.Reset()
	o = startOptions{mux: "tmux", removePaths: []string{filepath.Join(tc.home, "other")}}
	if err := tc.startAllowPaths(o, saved); err != nil || !strings.Contains(tc.stdout.String(), "not an allowed path, nothing to remove") {
		t.Errorf("unknown remove: %v\n%s", err, tc.stdout.String())
	}

	// psmux has no Files: a Place needs herdr on Windows. ':' is fine there.
	win := allowPathCLI(t, "windows")
	if err := win.savablePath(`C:\notes`); err != nil {
		t.Errorf("':' refused on Windows: %v", err)
	}
	wnotes := mkdir(t, filepath.Join(win.home, "notes"))
	o = startOptions{mux: "tmux", allowPaths: []string{wnotes}, newPaths: []string{wnotes}}
	if err := win.startAllowPaths(o, nil); err != nil || !strings.Contains(win.stdout.String(), "Places need a backend with Files (on Windows: --mux herdr)") {
		t.Errorf("windows tmux: %v\n%s", err, win.stdout.String())
	}
	win.stdout.Reset()
	o.mux = "herdr"
	if err := win.startAllowPaths(o, nil); err != nil || strings.Contains(win.stdout.String(), "Places need") {
		t.Errorf("windows herdr warned: %v\n%s", err, win.stdout.String())
	}
}

func TestStartRefusesAllowPathBeforeTouchingServices(t *testing.T) {
	tc := allowPathCLI(t, "linux")
	tc.runner.paths["tmux"] = true
	tc.procs = func() ([]procInfo, error) { t.Fatal("services touched"); return nil, nil }
	link := filepath.Join(tc.home, "keys")
	if err := os.Symlink(filepath.Join(tc.home, ".ssh"), link); err != nil {
		t.Skip("no symlinks:", err)
	}
	for _, p := range []string{tc.home, "/", filepath.Join(tc.home, ".ssh"), filepath.Join(tc.home, ".local"), link, mkdir(t, filepath.Join(tc.home, "r", ".git"))} {
		tc.stderr.Reset()
		if code := tc.main([]string{"start", "--mux", "tmux", "--allow-path", p}); code == 0 || !strings.Contains(tc.stderr.String(), "--allow-path") {
			t.Errorf("%s: code %d, stderr %q", p, code, tc.stderr.String())
		}
	}
	if fileExists(tc.configFile()) {
		t.Fatal("config saved for a refused start")
	}
}

func TestShowAccessInfoPaths(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.showAccessInfo(startOptions{port: 7680, mux: "tmux"}, "", false)
	if !strings.Contains(tc.stdout.String(), "Allowed paths: none\n") || !strings.Contains(tc.stdout.String(), "termote start --allow-path <dir>") {
		t.Errorf("no paths:\n%s", tc.stdout.String())
	}
	tc.stdout.Reset()
	tc.showAccessInfo(startOptions{port: 7680, mux: "tmux", allowPaths: []string{"/n", "/m"}}, "", false)
	if !strings.Contains(tc.stdout.String(), "Allowed paths: /n, /m\n") {
		t.Errorf("paths:\n%s", tc.stdout.String())
	}
}

func TestAllowPathSocketDirs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("named pipes")
	}
	old := allowPathSocketDirs
	t.Cleanup(func() { allowPathSocketDirs = old })
	dirs := defaultSocketDirs(func(k string) string {
		if k == "XDG_RUNTIME_DIR" {
			return "/run/user/1000"
		}
		return ""
	})
	for _, want := range []string{"/tmp", "/run", "/var/run", os.TempDir(), "/run/user/1000"} {
		if !slices.Contains(dirs, want) {
			t.Errorf("%s not refused: %v", want, dirs)
		}
	}
	allowPathSocketDirs = defaultSocketDirs
	home := t.TempDir() // under /tmp itself
	env := newAllowPathEnv("/nonexistent-home", nil)
	env.isGitDir = nil
	for _, p := range []string{home, "/tmp"} {
		if err := validateAllowPath(p, env); err == nil || !strings.Contains(err.Error(), "never serves") {
			t.Errorf("%s: %v", p, err)
		}
	}
}

func TestAllowPathRefusesTermoteCache(t *testing.T) {
	tc := allowPathCLI(t, runtime.GOOS)
	mkdir(t, filepath.Join(tc.cacheDir(), "termote", "trash"))
	env := tc.allowPathEnv()
	env.isGitDir = nil
	for _, p := range []string{tc.cacheDir(), filepath.Join(tc.cacheDir(), "termote", "trash")} {
		if err := validateAllowPath(p, env); err == nil || !strings.Contains(err.Error(), "never serves") {
			t.Errorf("%s: %v", p, err)
		}
	}
}
