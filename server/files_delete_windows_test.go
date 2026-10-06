package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// errXDev is what a move across volumes fails with.
var errXDev error = windows.ERROR_NOT_SAME_DEVICE

// A junction on the path or as the target is refused as the link it is.
func TestFilesDeleteJunction(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "sub/b.go", "b\n")
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "x.txt"), "x\n")
	junction(t, filepath.Join(fx.root, "j-in"), filepath.Join(fx.root, "sub"))
	junction(t, filepath.Join(fx.root, "j-out"), outside)
	for _, body := range []map[string]any{
		{"path": "j-in/b.go", "kind": "file", "baseHash": fx.hash(t, "sub/b.go")},
		{"path": "j-out/x.txt", "kind": "file", "baseHash": diskHash(t, filepath.Join(outside, "x.txt"))},
		{"path": "j-in", "kind": "dir"},
	} {
		if code, got := fx.post(t, "delete", body); code != 403 || got["code"] != "symlink" {
			t.Errorf("%v = %d %v", body, code, got)
		}
	}
	if _, err := os.Stat(filepath.Join(outside, "x.txt")); err != nil {
		t.Error("file behind a junction deleted")
	}
}
