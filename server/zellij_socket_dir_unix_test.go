//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// No zellij command runs while the socket dir could be another user's.
func TestZellijSocketDirOfAnotherUserRefused(t *testing.T) {
	log := useFakeZellij(t, nil)
	old := fileOwner
	fileOwner = func(os.FileInfo) (int, bool) { return os.Getuid() + 1, true }
	t.Cleanup(func() { fileOwner = old })
	if _, err := zellijListSessions(t.Context()); !errors.Is(err, errZellijSocketDir) {
		t.Fatalf("list = %v, want the socket dir refused", err)
	}
	if _, err := zellijAction(t.Context(), "main", "list-tabs"); !errors.Is(err, errZellijSocketDir) {
		t.Fatalf("action = %v, want the socket dir refused", err)
	}
	if _, err := newTestZellijMux().AttachView(t.Context(), zellijPaneID("main", 0), Size{}); !errors.Is(err, errZellijSocketDir) {
		t.Fatalf("view = %v, want the socket dir refused", err)
	}
	if got := log(); got != "" {
		t.Errorf("zellij ran:\n%s", got)
	}
}

func TestZellijSocketDirModes(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "zellij")
	t.Setenv("ZELLIJ_SOCKET_DIR", dir)
	contract := filepath.Join(dir, zellijContractDir)
	// Missing: made 0700.
	if err := zellijCheckSocketDir(); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("socket dir made as %v, %v", fi, err)
	}
	for _, tc := range []struct {
		name          string
		dir, contract os.FileMode
		ok            bool
	}{
		// What Zellij makes under umask 002: the socket dir group-writable,
		// its contract dir 0700.
		{"zellij's own", 0o775, 0o700, true},
		{"private", 0o700, 0o700, true},
		{"writable by others", 0o777, 0o700, false},
		{"contract dir others can enter", 0o700, 0o755, false},
		{"contract dir of the group", 0o700, 0o770, false},
	} {
		os.MkdirAll(contract, 0o700)
		os.Chmod(dir, tc.dir)
		os.Chmod(contract, tc.contract)
		if err := zellijCheckSocketDir(); (err == nil) != tc.ok {
			t.Errorf("%s: %v", tc.name, err)
		}
	}
	os.Chmod(dir, 0o700)
	// A contract dir that is a file, a socket dir that is a symlink.
	os.RemoveAll(contract)
	os.WriteFile(contract, nil, 0o600)
	if err := zellijCheckSocketDir(); err == nil {
		t.Error("a contract file was taken for its dir")
	}
	os.Remove(contract)
	link := filepath.Join(base, "link")
	os.Symlink(dir, link)
	t.Setenv("ZELLIJ_SOCKET_DIR", link)
	if err := zellijCheckSocketDir(); err == nil || !strings.Contains(err.Error(), "not private") {
		t.Errorf("a symlinked socket dir = %v", err)
	}
	// A socket dir that cannot be made.
	file := filepath.Join(base, "file")
	os.WriteFile(file, nil, 0o600)
	t.Setenv("ZELLIJ_SOCKET_DIR", filepath.Join(file, "zellij"))
	if err := zellijCheckSocketDir(); err == nil {
		t.Error("an unmakeable socket dir was taken")
	}
}
