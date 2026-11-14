package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A link to another computer's share, directly or through a link to a local
// folder holding one, is refused before anything opens its target; a link
// that stays on a drive letter resolves as filepath.EvalSymlinks does. A path
// named on a share (a Place the user chose) is not a link and is not refused.
func TestEvalSymlinksRefusesRemoteLinks(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	remote := `\\termote-test.invalid\share\f`
	if err := os.Symlink(remote, filepath.Join(dir, "unc")); err != nil {
		t.Skipf("no symbolic links here (Developer Mode off): %v", err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.Mkdir(filepath.Join(dir, "sub"), 0o700))
	must(os.Symlink(remote, filepath.Join(dir, "sub", "unc")))
	must(os.Symlink(filepath.Join(dir, "sub"), filepath.Join(dir, "tosub")))
	must(os.Symlink(`\\?\UNC\termote-test.invalid\share`, filepath.Join(dir, "longunc")))
	must(os.WriteFile(filepath.Join(dir, "sub", "a.txt"), []byte("a"), 0o600))
	must(os.Symlink(`sub\a.txt`, filepath.Join(dir, "local")))
	for _, p := range []string{
		filepath.Join(dir, "unc"),
		filepath.Join(dir, "unc", "deeper"),
		filepath.Join(dir, "tosub", "unc"),
		filepath.Join(dir, "longunc"),
	} {
		if _, err := evalSymlinks(p); !errors.Is(err, errRemoteLink) {
			t.Errorf("evalSymlinks(%s) = %v, want errRemoteLink", p, err)
		}
	}
	if got, err := evalSymlinks(filepath.Join(dir, "local")); err != nil || got != filepath.Join(dir, "sub", "a.txt") {
		t.Errorf("local link = %q, %v", got, err)
	}
	if got, err := evalSymlinks(filepath.Join(dir, "tosub", "a.txt")); err != nil || got != filepath.Join(dir, "sub", "a.txt") {
		t.Errorf("link to a local folder = %q, %v", got, err)
	}
	// resolvedPath, which the tree, search and the deny lists use, keeps the
	// link itself.
	if got := resolvedPath(filepath.Join(dir, "unc")); got != filepath.Join(dir, "unc") {
		t.Errorf("resolvedPath = %q", got)
	}
}

func TestDriveVolume(t *testing.T) {
	for v, want := range map[string]bool{
		"C:": true, "z:": true, `\\?\C:`: true,
		"": false, `\\host\share`: false, `\\?\UNC\host\share`: false, `\\.\pipe`: false, "1:": false,
	} {
		if got := driveVolume(v); got != want {
			t.Errorf("driveVolume(%q) = %v, want %v", v, got, want)
		}
	}
}
