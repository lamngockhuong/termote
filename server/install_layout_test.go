package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The PWA names the update command from installKind: each layout must be
// told apart, the installer's first since a checkout may hold an install.
func TestInstallKind(t *testing.T) {
	marker := filepath.Join(t.TempDir(), ".dockerenv")
	saved := containerMarkers
	containerMarkers = []string{marker}
	t.Cleanup(func() { containerMarkers = saved })

	tc := newTestCLI(t, "linux")
	if got := tc.installKind(); got != "unknown" {
		t.Errorf("a binary copied by hand = %q, want unknown", got)
	}

	writeFile(t, marker, "")
	if got := tc.installKind(); got != "container" {
		t.Errorf("in a container = %q, want container", got)
	}

	writeFile(t, filepath.Join(tc.projectDir, "pwa", "package.json"), "{}")
	if got := tc.installKind(); got != "checkout" {
		t.Errorf("a checkout = %q, want checkout", got)
	}

	tc.exe = filepath.Join(tc.versionsDir(), "1.0.0", "bin", "termote")
	if got := tc.installKind(); got != "release" {
		t.Errorf("an installed release = %q, want release", got)
	}
}

// homebrewCLI runs from a fake Homebrew keg <prefix>/Cellar/termote/9.9.9
// with <prefix>/opt/termote linked to it, as brew lays an install out.
func homebrewCLI(t *testing.T) (*testCLI, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Homebrew runs on macOS and Linux")
	}
	tc := newTestCLI(t, "linux")
	prefix := filepath.Join(t.TempDir(), "homebrew")
	tc.exe = filepath.Join(prefix, "Cellar", "termote", "9.9.9", "bin", "termote")
	writeFile(t, tc.exe, "bin")
	if err := os.MkdirAll(filepath.Join(prefix, "opt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../Cellar/termote/9.9.9", filepath.Join(prefix, "opt", "termote")); err != nil {
		t.Fatal(err)
	}
	return tc, prefix
}

// A brew install runs from a Cellar path that brew upgrade deletes: the
// service must run the opt link instead, and only one that resolves to this
// binary.
func TestHomebrewInstall(t *testing.T) {
	tc, prefix := homebrewCLI(t)
	opt := filepath.Join(prefix, "opt", "termote", "bin", "termote")
	if got := tc.installKind(); got != "homebrew" {
		t.Errorf("installKind = %q, want homebrew", got)
	}
	if got := tc.stableExe(); got != opt {
		t.Errorf("stableExe = %s, want %s", got, opt)
	}

	// opt pointing at another version: not this keg's link.
	other := filepath.Join(prefix, "Cellar", "termote", "9.9.8", "bin", "termote")
	writeFile(t, other, "old")
	os.Remove(filepath.Join(prefix, "opt", "termote"))
	os.Symlink("../Cellar/termote/9.9.8", filepath.Join(prefix, "opt", "termote"))
	if got, kind := tc.stableExe(), tc.installKind(); got != tc.exe || kind != "unknown" {
		t.Errorf("opt to another version: stableExe %s, kind %s", got, kind)
	}

	// No opt link at all.
	os.Remove(filepath.Join(prefix, "opt", "termote"))
	if got, kind := tc.stableExe(), tc.installKind(); got != tc.exe || kind != "unknown" {
		t.Errorf("no opt link: stableExe %s, kind %s", got, kind)
	}
}

// Brew links <prefix>/bin/termote itself: link writes nothing, and unlink
// leaves a link it did not make.
func TestHomebrewLink(t *testing.T) {
	tc, prefix := homebrewCLI(t)
	if code := tc.main([]string{"link"}); code != 0 {
		t.Fatal(tc.stderr.String())
	}
	target := filepath.Join(tc.userBinDir(), "termote")
	if _, err := os.Lstat(target); err == nil {
		t.Fatal("link created ~/.local/bin/termote on a brew install")
	}
	if !strings.Contains(tc.stdout.String(), filepath.Join(prefix, "bin", "termote")) {
		t.Fatalf("output:\n%s", tc.stdout.String())
	}

	if err := os.MkdirAll(tc.userBinDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	os.Symlink(filepath.Join(prefix, "bin", "termote"), target)
	if code := tc.main([]string{"unlink"}); code != 0 {
		t.Fatal(tc.stderr.String())
	}
	if _, err := os.Lstat(target); err != nil {
		t.Fatal("unlink removed a link it did not make")
	}
}
