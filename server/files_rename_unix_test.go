//go:build !windows

package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestFilesRenameSymlinks(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	fx.write(t, "real/b.txt", "b\n")
	os.Symlink("a.txt", filepath.Join(fx.root, "link.txt"))
	os.Symlink("real", filepath.Join(fx.root, "linkdir"))
	for _, c := range [][2]string{
		{"link.txt", "c.txt"},      // the source is a symlink
		{"linkdir/b.txt", "c.txt"}, // a symlink above the source
		{"a.txt", "linkdir/c.txt"}, // a symlink above the new path
	} {
		if code, body := fx.rename(t, c[0], c[1], nil); code != 403 || body["code"] != "symlink" {
			t.Errorf("%s → %s = %d %v", c[0], c[1], code, body)
		}
	}
	if !fx.exists("a.txt") || !fx.exists("real/b.txt") || fx.exists("real/c.txt") {
		t.Error("a refused rename moved a file")
	}
}

// Renaming writes the directory, not the file: a file nobody may read is
// renamed, a directory the server may not write is 403 permission.
func TestFilesRenamePermissions(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores permissions")
	}
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	os.Chmod(filepath.Join(fx.root, "a.txt"), 0)
	if code, body := fx.rename(t, "a.txt", "b.txt", nil); code != 200 {
		t.Errorf("unreadable file = %d %v", code, body)
	}
	os.MkdirAll(filepath.Join(fx.root, "locked"), 0o755)
	os.Chmod(filepath.Join(fx.root, "locked"), 0o555)
	t.Cleanup(func() { os.Chmod(filepath.Join(fx.root, "locked"), 0o755) })
	if code, body := fx.rename(t, "b.txt", "locked/b.txt", nil); code != 403 || body["code"] != "permission" {
		t.Errorf("read-only dir = %d %v", code, body)
	}
}

// Two hard links whose names differ only in case, on a file system that
// tells case apart: the move through a temporary name meets the other link,
// and the file goes back to its name.
func TestFilesRenameCaseHardLink(t *testing.T) {
	fx := newTrashFixture(t)
	if caseInsensitive(t, fx.root) {
		t.Skip("the file system ignores case")
	}
	fx.write(t, "a.txt", "a\n")
	if err := os.Link(filepath.Join(fx.root, "a.txt"), filepath.Join(fx.root, "A.txt")); err != nil {
		t.Skip("no hard links here")
	}
	if code, body := fx.rename(t, "a.txt", "A.txt", nil); code != 409 || body["code"] != "exists" {
		t.Errorf("onto its own case-differing link = %d %v", code, body)
	}
	if names := listNames(t, fx.root); !containsName(names, "a.txt") || len(tempNames(names)) != 0 {
		t.Errorf("root holds %v", names)
	}
}

// The second move of a two-move rename fails and moving back works: the
// error of the second move, the file at its name.
func TestRenameViaTempMovesBack(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.txt"), "a\n")
	rt, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	fi, _ := rt.Lstat("a.txt")
	var n int
	setFindHook(t, &renameMove, func(from *os.Root, fn string, to *os.Root, tn string, fi fs.FileInfo) error {
		if n++; n == 2 {
			return &os.LinkError{Op: "rename", Err: syscall.EACCES}
		}
		return renameNoReplaceChecked(from, fn, to, tn, fi)
	})
	if err := renameViaTemp(rt, "a.txt", rt, "A.txt", fi, "a.txt", "A.txt"); err != errEditPermission {
		t.Errorf("second move refused = %v", err)
	}
	if names := listNames(t, dir); len(names) != 1 || names[0] != "a.txt" {
		t.Errorf("dir holds %v", names)
	}
}

// What a closed or missing directory makes of the helpers: errors, never a move.
func TestRenameHelpersFail(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.txt"), "a\n")
	rt, _ := os.OpenRoot(dir)
	closed, _ := os.OpenRoot(dir)
	closed.Close()
	defer rt.Close()
	fi, _ := rt.Lstat("a.txt")
	if sameDir(rt, closed) || sameDir(closed, rt) {
		t.Error("a closed root is the same dir")
	}
	if err := moveFile(rt, "a.txt", closed, "b.txt", fi, "a.txt", "b.txt"); err == nil {
		t.Error("moveFile into a closed root worked")
	}
	f := &filesAPI{}
	if _, err := f.openParent(filesRoot{Root: filepath.Join(dir, "missing")}, "a.txt", nil); err == nil {
		t.Error("openParent of a missing root worked")
	}
	if err := renameNoReplaceChecked(rt, "a.txt", closed, "b.txt", fi); err == nil {
		t.Error("renameNoReplaceChecked into a closed root worked")
	}
	writeFile(t, filepath.Join(dir, "b.txt"), "b\n")
	if err := renameNoReplaceChecked(rt, "a.txt", rt, "b.txt", fi); err == nil {
		t.Error("renameNoReplaceChecked replaced a file")
	}
	if (&renameChangedError{"x"}).Error() != errEditChanged.msg {
		t.Error("renameChangedError text")
	}
}
