//go:build !windows

package main

import (
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// The errors a full disk, a full quota and a read-only mount give.
var (
	errDiskFull      error = syscall.ENOSPC
	errQuotaFull     error = syscall.EDQUOT
	errReadOnlyMount error = syscall.EROFS
)

func TestFilesCreateSymlink(t *testing.T) {
	fx := newFilesFixture(t)
	os.Symlink(".git", filepath.Join(fx.root, "gd"))
	os.Symlink("cfg", filepath.Join(fx.root, "cd"))
	os.Symlink("../outside", filepath.Join(fx.root, "od"))
	for _, rel := range []string{"in/new.go", "in/x/y.go", "gd/new/x.md", "gd/x", "cd/new/x", "od/x", "od/new/x"} {
		code, got := fx.create(t, fx.root, map[string]any{"path": rel, "reveal": true})
		if code != http.StatusForbidden || got["code"] != "symlink" {
			t.Errorf("%s = %d %v", rel, code, got)
		}
	}
	for _, p := range []string{"sub/new.go", "sub/x", ".git/new", ".git/x", "cfg/new", "cfg/x"} {
		notExist(t, filepath.Join(fx.root, p))
	}
	notExist(t, filepath.Join(fx.outside, "x"))
	notExist(t, filepath.Join(fx.outside, "new"))
	// The name itself is a symlink, broken or not: never followed.
	os.Symlink("missing.txt", filepath.Join(fx.root, "dangling"))
	for _, rel := range []string{"dangling", "out", "in"} {
		code, got := fx.create(t, fx.root, map[string]any{"path": rel})
		if code != http.StatusConflict || got["code"] != "exists" {
			t.Errorf("%s = %d %v", rel, code, got)
		}
	}
	notExist(t, filepath.Join(fx.root, "missing.txt"))
}

// A directory swapped for a symlink between its checks and its open: the
// directory opened is not the one checked, and nothing is made in it.
func TestFilesCreateSwappedDir(t *testing.T) {
	fx := newFilesFixture(t)
	defer func() { createBeforeOpenDir = func(*os.Root, string) {} }()
	// once runs swap at the next directory open only.
	once := func(swap func()) {
		createBeforeOpenDir = func(*os.Root, string) {
			createBeforeOpenDir = func(*os.Root, string) {}
			swap()
		}
	}
	// A directory the walk makes, then one that was there.
	for _, rel := range []string{"swap/x.md", "sub/x.md"} {
		dir := filepath.Join(fx.root, filepath.Dir(rel))
		once(func() {
			if err := os.Rename(dir, dir+".moved"); err != nil {
				t.Fatal(err)
			}
			os.Symlink("cfg", dir)
		})
		code, got := fx.create(t, fx.root, map[string]any{"path": rel})
		if code != http.StatusForbidden || got["code"] != "symlink" {
			t.Errorf("%s = %d %v", rel, code, got)
		}
		notExist(t, filepath.Join(fx.root, "cfg", "x.md"))
		os.Remove(dir)
		os.Rename(dir+".moved", dir)
	}
	// Swapped for a link out of the root.
	esc := filepath.Join(fx.root, "esc")
	once(func() {
		os.Remove(esc)
		os.Symlink(fx.outside, esc)
	})
	if code, got := fx.create(t, fx.root, map[string]any{"path": "esc/x.md"}); code != http.StatusForbidden || got["code"] != "symlink" {
		t.Errorf("escape = %d %v", code, got)
	}
	notExist(t, filepath.Join(fx.outside, "x.md"))
}

func TestFilesCreatePermission(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs a non-root user")
	}
	fx := newFilesFixture(t)
	for dir, mode := range map[string]os.FileMode{"ro": 0o555, "noexec": 0o644, "zero": 0} {
		p := filepath.Join(fx.root, dir)
		os.Mkdir(p, 0o755)
		os.Chmod(p, mode)
		t.Cleanup(func() { os.Chmod(p, 0o755) })
	}
	for _, rel := range []string{"ro/x.md", "ro/new/x.md", "noexec/new/x.md", "zero/x.md"} {
		code, got := fx.create(t, fx.root, map[string]any{"path": rel})
		if code != http.StatusForbidden || got["code"] != "permission" {
			t.Errorf("%s = %d %v", rel, code, got)
		}
	}
	notExist(t, filepath.Join(fx.root, "ro", "new"))
}

// New files and directories take the umask, like ones a shell makes.
func TestFilesCreateUmask(t *testing.T) {
	fx := newFilesFixture(t)
	for i, mask := range []int{0o022, 0o077} {
		rel := filepath.Join("m"+string(rune('a'+i)), "f.sh")
		old := syscall.Umask(mask)
		code, got := fx.create(t, fx.root, map[string]any{"path": rel})
		syscall.Umask(old)
		if code != http.StatusCreated {
			t.Fatalf("%o = %d %v", mask, code, got)
		}
		fi, _ := os.Stat(filepath.Join(fx.root, rel))
		di, _ := os.Stat(filepath.Join(fx.root, filepath.Dir(rel)))
		if fi.Mode().Perm() != os.FileMode(0o666&^mask) || di.Mode().Perm() != os.FileMode(0o777&^mask) {
			t.Errorf("umask %o: file %o, dir %o", mask, fi.Mode().Perm(), di.Mode().Perm())
		}
	}
}
