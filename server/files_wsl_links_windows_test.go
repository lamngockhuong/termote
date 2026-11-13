package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// windowsLinksScript runs in the Windows PowerShell every Windows has (5.1
// on the CI runner): "none" for a plain file or folder (its way up to the
// drive's root looked at) or a folder whose subfolder holds a junction,
// "link" for a junction, a folder holding one, a path through one, or a
// folder whose subfolder holds a symbolic link. A drive's root is
// not asked: a subfolder of it may not be listed (System Volume
// Information).
func TestWindowsLinksScriptInPowerShell(t *testing.T) {
	ps, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("no powershell.exe")
	}
	d := t.TempDir()
	plain := filepath.Join(d, "plain")
	target := filepath.Join(d, "target")
	holder := filepath.Join(d, "holder")
	deep := filepath.Join(d, "deep")
	for _, dir := range []string{plain, target, holder, deep, filepath.Join(deep, "inner")} {
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(plain, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "b.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	mklinkJ(t, filepath.Join(holder, "j"), target)
	// a junction in a subfolder only reaches a local volume (node_modules)
	repo := filepath.Join(d, "repo")
	mklinkJ(t, filepath.Join(repo, "node_modules", "pkg"), target)
	// a symbolic link in a subfolder may reach another computer's share:
	// Explorer draws that subfolder's thumbnail from what is in it
	outer := filepath.Join(d, "outer")
	if err := os.MkdirAll(filepath.Join(outer, "pics"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(target, "b.txt"), filepath.Join(outer, "pics", "s.png")); err != nil {
		t.Fatalf("symlink (the runner may create them): %v", err)
	}
	run := func(p string) string {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, ps, "-NoProfile", "-NonInteractive", "-Command", windowsLinksScript)
		cmd.Env = append(os.Environ(), "TERMOTE_OPEN_PATH="+p)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v %s", p, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	for p, want := range map[string]string{
		plain:                               "none",
		filepath.Join(plain, "a.txt"):       "none",
		filepath.Join(holder, "j"):          "link",
		holder:                              "link",
		filepath.Join(holder, "j", "b.txt"): "link",
		outer:                               "link",
		deep:                                "none",
		repo:                                "none",
	} {
		if got := run(p); got != want {
			t.Errorf("%s = %q, want %q", p, got, want)
		}
	}
	// A name PowerShell would read as code or a wildcard is data.
	odd := filepath.Join(d, "it's $(x) [b]")
	if err := os.Mkdir(odd, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := run(odd); got != "none" {
		t.Errorf("%s = %q, want none", odd, got)
	}
}
