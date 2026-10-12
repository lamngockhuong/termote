package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

// A file system without RENAME_NOREPLACE: link, check, unlink. A file put at
// the old name in between is kept, and so is the file once the old name is
// gone.
func TestFilesRenameFallback(t *testing.T) {
	setFindHook(t, &renameat2, func(int, string, int, string, uint) error { return unix.EINVAL })
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	if code, body := fx.rename(t, "a.txt", "b.txt", nil); code != 200 {
		t.Fatalf("rename = %d %v", code, body)
	}
	fi, _ := os.Stat(filepath.Join(fx.root, "b.txt"))
	if fx.exists("a.txt") || fi.Sys().(*syscall.Stat_t).Nlink != 1 {
		t.Error("the fallback left two links")
	}
	// An agent writes a new b.txt over the old one between the link and the
	// check: its file stays, the rename is refused.
	setFindHook(t, &linkBeforeCheck, func() {
		tmp := filepath.Join(fx.root, "tmp")
		writeFile(t, tmp, "agent\n")
		os.Rename(tmp, filepath.Join(fx.root, "b.txt"))
	})
	if code, body := fx.rename(t, "b.txt", "c.txt", nil); code != 409 || body["code"] != "changed" {
		t.Errorf("rewritten in between = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "b.txt")) != "agent\n" || fx.exists("c.txt") {
		t.Error("the agent's file was not kept alone")
	}
	// Replaced and the new link gone too: refused, logged, nothing else.
	fx.write(t, "f.txt", "f\n")
	setFindHook(t, &linkBeforeCheck, func() {
		os.Remove(filepath.Join(fx.root, "g.txt"))
		tmp := filepath.Join(fx.root, "tmp")
		writeFile(t, tmp, "agent\n")
		os.Rename(tmp, filepath.Join(fx.root, "f.txt"))
	})
	if code, body := fx.rename(t, "f.txt", "g.txt", nil); code != 409 || body["code"] != "changed" {
		t.Errorf("replaced, link gone = %d %v", code, body)
	}
	// The old name removed in between: the new link is the file, kept.
	setFindHook(t, &linkBeforeCheck, func() { os.Remove(filepath.Join(fx.root, "b.txt")) })
	if code, body := fx.rename(t, "b.txt", "d.txt", nil); code != 200 || readText(t, filepath.Join(fx.root, "d.txt")) != "agent\n" {
		t.Errorf("removed in between = %d %v", code, body)
	}
	// The link itself refused (a name taken): nothing moved.
	setFindHook(t, &linkBeforeCheck, func() {})
	fx.write(t, "e.txt", "e\n")
	rt, _ := os.OpenRoot(fx.root)
	defer rt.Close()
	fi, _ = rt.Lstat("d.txt")
	if err := renameNoReplaceChecked(rt, "d.txt", rt, "e.txt", fi); err == nil {
		t.Error("the fallback replaced a file")
	}
}
