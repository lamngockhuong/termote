//go:build !windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sshHostName runs ssh -G -- <host> without git or Termote variables and
// reads the hostname it prints; a failing ssh, or none on PATH, is "".
func TestSSHHostNameRunsSSH(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "log")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" > " + log + "\nenv >> " + log + "\n" +
		"case \"$3\" in fail.example) exit 255;; esac\nprintf 'user git\\nhostname github.com\\nport 22\\n'\n"
	if err := os.WriteFile(filepath.Join(dir, "ssh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("GIT_DIR", "/elsewhere")
	t.Setenv("TERMOTE_PASS", "secret")
	if got := sshHostName(context.Background(), "work.github.com"); got != "github.com" {
		t.Errorf("got %q, want github.com", got)
	}
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	out := string(b)
	if args, _, _ := strings.Cut(out, "\n"); args != "-G -- work.github.com" {
		t.Errorf("ssh ran with %q", args)
	}
	if strings.Contains(out, "GIT_DIR=") || strings.Contains(out, "TERMOTE_PASS=") {
		t.Error("ssh got a git or Termote variable")
	}
	if got := sshHostName(context.Background(), "fail.example"); got != "" {
		t.Errorf("failing ssh gave %q", got)
	}
	t.Setenv("PATH", t.TempDir())
	if got := sshHostName(context.Background(), "work.github.com"); got != "" {
		t.Errorf("no ssh gave %q", got)
	}
}
