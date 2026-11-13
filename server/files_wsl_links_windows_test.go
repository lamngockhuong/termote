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
// on the CI runner): "none" for a plain file, folder or drive root, "link"
// for a junction, a folder holding one, or a path through one.
func TestWindowsLinksScriptInPowerShell(t *testing.T) {
	ps, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("no powershell.exe")
	}
	d := t.TempDir()
	plain := filepath.Join(d, "plain")
	target := filepath.Join(d, "target")
	holder := filepath.Join(d, "holder")
	for _, dir := range []string{plain, target, holder} {
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
		filepath.VolumeName(d) + `\`:        "none",
		filepath.Join(holder, "j"):          "link",
		holder:                              "link",
		filepath.Join(holder, "j", "b.txt"): "link",
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
