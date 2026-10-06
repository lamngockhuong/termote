package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

// A file system without RENAME_NOREPLACE: link + unlink, still never
// replacing anything.
func TestRenameNoReplaceFallback(t *testing.T) {
	setFindHook(t, &renameat2, func(int, string, int, string, uint) error { return unix.EINVAL })
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	_, body := fx.deleteOK(t, "a.txt")
	id := body["trashId"].(string)
	fx.write(t, "a.txt", "new\n")
	if code, got := fx.restore(t, id, false); code != 409 || got["code"] != "exists" {
		t.Errorf("restore over a file = %d %v", code, got)
	}
	os.Remove(filepath.Join(fx.root, "a.txt"))
	if code, _ := fx.restore(t, id, false); code != 200 || readText(t, filepath.Join(fx.root, "a.txt")) != "a\n" {
		t.Errorf("restore = %d", code)
	}
	fi, _ := os.Stat(filepath.Join(fx.root, "a.txt"))
	if fi.Sys().(*syscall.Stat_t).Nlink != 1 {
		t.Error("restored file kept a second link")
	}
}

// Unlinking a directory (a swap the checks missed) fails: unlinkAt never
// removes one.
func TestUnlinkAtRefusesDir(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "d"), 0o755)
	rt, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if err := unlinkAt(rt, "d"); err == nil {
		t.Error("unlinkAt removed a directory")
	}
	closed, _ := os.OpenRoot(dir)
	closed.Close()
	if err := unlinkAt(closed, "d"); err == nil {
		t.Error("closed root")
	}
	if err := renameNoReplace(rt, "d", closed, "e"); err == nil {
		t.Error("closed target root")
	}
}
