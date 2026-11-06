//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// runRemoveScript runs removeKeyScript's sh -c body with HOME=home and the
// key on stdin, as the user's ssh would there.
func runRemoveScript(t *testing.T, home, key string) error {
	t.Helper()
	body := strings.TrimSuffix(strings.TrimPrefix(removeKeyScript, "sh -c '"), "'")
	cmd := exec.Command("sh", "-c", body)
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	cmd.Stdin = strings.NewReader(key + "\n")
	return cmd.Run()
}

// Only the key's lines go; when the copy cannot be written, the file stays
// as it was.
func TestRemoveKeyScript(t *testing.T) {
	home := t.TempDir()
	ssh := filepath.Join(home, ".ssh")
	os.MkdirAll(ssh, 0o700)
	f := filepath.Join(ssh, "authorized_keys")
	os.WriteFile(f, []byte("ssh-ed25519 OTHER me\ncommand=\"x\",restrict ssh-ed25519 TERMOTE t\n"), 0o600)
	if err := runRemoveScript(t, home, "TERMOTE"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(f); string(got) != "ssh-ed25519 OTHER me\n" {
		t.Errorf("left %q", got)
	}
	if fi, _ := os.Stat(f); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode().Perm())
	}
	// The last line removed: an empty file, not an error
	os.WriteFile(f, []byte("ssh-ed25519 TERMOTE t\n"), 0o600)
	if err := runRemoveScript(t, home, "TERMOTE"); err != nil {
		t.Errorf("last line: %v", err)
	}
	if os.Getuid() == 0 {
		t.Skip("root writes anywhere")
	}
	// The temp copy cannot be made: nothing changes, and it says so
	os.WriteFile(f, []byte("ssh-ed25519 OTHER me\nssh-ed25519 TERMOTE t\n"), 0o600)
	os.Chmod(ssh, 0o500)
	defer os.Chmod(ssh, 0o700)
	if err := runRemoveScript(t, home, "TERMOTE"); err == nil {
		t.Error("a failed copy reported success")
	}
	if got, _ := os.ReadFile(f); !strings.Contains(string(got), "OTHER") {
		t.Errorf("the file was emptied: %q", got)
	}
	// No key: nothing is touched
	if err := runRemoveScript(t, home, ""); err != nil {
		t.Errorf("empty key: %v", err)
	}
}

// The install script adds the line once, after a last line without its
// newline, making ~/.ssh 0700 and the file 0600 when it creates them.
func TestInstallKeyScript(t *testing.T) {
	home := t.TempDir()
	body := strings.TrimSuffix(strings.TrimPrefix(installKeyScript, "sh -c '"), "'")
	run := func() {
		cmd := exec.Command("sh", "-c", body)
		cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
		cmd.Stdin = strings.NewReader("command=\"x\",restrict ssh-ed25519 KEY t\n")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("install: %v %s", err, out)
		}
	}
	run()
	f := filepath.Join(home, ".ssh", "authorized_keys")
	if fi, _ := os.Stat(filepath.Dir(f)); fi.Mode().Perm() != 0o700 {
		t.Errorf("dir mode %v", fi.Mode().Perm())
	}
	if fi, _ := os.Stat(f); fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode %v", fi.Mode().Perm())
	}
	os.WriteFile(f, []byte("ssh-ed25519 OTHER me"), 0o600)
	run()
	run()
	if got, _ := os.ReadFile(f); string(got) != "ssh-ed25519 OTHER me\ncommand=\"x\",restrict ssh-ed25519 KEY t\n" {
		t.Errorf("file %q", got)
	}
}
