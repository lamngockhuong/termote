package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// A junction above the source or the new path, or as the source, is refused
// as the link it is.
func TestFilesRenameJunction(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	fx.write(t, "sub/b.go", "b\n")
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "x.txt"), "x\n")
	junction(t, filepath.Join(fx.root, "j-in"), filepath.Join(fx.root, "sub"))
	junction(t, filepath.Join(fx.root, "j-out"), outside)
	for _, c := range [][2]string{
		{"j-in/b.go", "c.go"},
		{"j-out/x.txt", "x.txt"},
		{"a.txt", "j-out/a.txt"},
		{"j-in", "j2"},
	} {
		if code, body := fx.rename(t, c[0], c[1], nil); code != 403 || body["code"] != "symlink" {
			t.Errorf("%s → %s = %d %v", c[0], c[1], code, body)
		}
	}
	if _, err := os.Stat(filepath.Join(outside, "x.txt")); err != nil {
		t.Error("a file behind a junction moved")
	}
	if _, err := os.Stat(filepath.Join(outside, "a.txt")); err == nil {
		t.Error("a file moved through a junction")
	}
}

// A file another program holds open without sharing delete access: 409
// in_use, the file stays.
func TestFilesRenameInUse(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	p, _ := windows.UTF16PtrFromString(filepath.Join(fx.root, "a.txt"))
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	if code, body := fx.rename(t, "a.txt", "b.txt", nil); code != 409 || body["code"] != "in_use" {
		t.Errorf("open elsewhere = %d %v", code, body)
	}
	if !fx.exists("a.txt") || fx.exists("b.txt") {
		t.Error("a file held open moved")
	}
}
