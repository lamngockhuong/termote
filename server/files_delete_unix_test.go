//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// errXDev is what a rename across file systems fails with.
var errXDev error = syscall.EXDEV

func TestFilesDeleteSymlinks(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "sub/b.go", "b\n")
	fx.write(t, "a.txt", "a\n")
	os.Symlink("sub", filepath.Join(fx.root, "in"))
	os.Symlink("a.txt", filepath.Join(fx.root, "link.txt"))
	os.Symlink("sub", filepath.Join(fx.root, "dirlink"))
	for _, body := range []map[string]any{
		{"path": "in/b.go", "kind": "file", "baseHash": fx.hash(t, "sub/b.go")},
		{"path": "link.txt", "kind": "file", "baseHash": fx.hash(t, "a.txt")},
		{"path": "dirlink", "kind": "dir"},
	} {
		if code, got := fx.post(t, "delete", body); code != 403 || got["code"] != "symlink" {
			t.Errorf("%v = %d %v", body, code, got)
		}
	}
	if readText(t, filepath.Join(fx.root, "sub", "b.go")) != "b\n" || readText(t, filepath.Join(fx.root, "a.txt")) != "a\n" {
		t.Error("a file behind a symlink was deleted")
	}
	// A FIFO is no regular file.
	if err := syscall.Mkfifo(filepath.Join(fx.root, "fifo"), 0o600); err == nil {
		if code, got := fx.post(t, "delete", map[string]any{"path": "fifo", "kind": "file", "baseHash": "x"}); code != 409 || got["code"] != "not_file" {
			t.Errorf("fifo = %d %v", code, got)
		}
	}
}

// Names a create refuses but a disk holds come back from the trash.
func TestFilesDeleteRestoresOddNames(t *testing.T) {
	fx := newTrashFixture(t)
	for _, name := range []string{"a.", "x "} {
		fx.write(t, name, name)
		_, body := fx.deleteOK(t, name)
		if code, got := fx.restore(t, body["trashId"].(string), false); code != 200 || got["path"] != name {
			t.Errorf("%q restore = %d %v", name, code, got)
		}
		if readText(t, filepath.Join(fx.root, name)) != name {
			t.Errorf("%q bytes differ", name)
		}
	}
}

// A file of another user is not the server's to delete (only checkable
// when the tests run as root, which can own a file as anyone).
func TestFilesDeleteOtherOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to make a file of another user")
	}
	fx := newTrashFixture(t)
	fx.write(t, "theirs.txt", "t\n")
	if err := os.Chown(filepath.Join(fx.root, "theirs.txt"), 65534, 65534); err != nil {
		t.Skip(err)
	}
	if code, got := fx.del(t, "theirs.txt", nil); code != 403 || got["code"] != "permission" {
		t.Errorf("other owner = %d %v", code, got)
	}
}

// A directory the server cannot write: the move fails with EACCES.
func TestFilesDeletePermission(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes any directory")
	}
	fx := newTrashFixture(t)
	fx.write(t, "ro/a.txt", "a\n")
	ro := filepath.Join(fx.root, "ro")
	os.Chmod(ro, 0o555)
	t.Cleanup(func() { os.Chmod(ro, 0o755) })
	if code, got := fx.del(t, "ro/a.txt", nil); code != 403 || got["code"] != "permission" {
		t.Errorf("read-only dir = %d %v", code, got)
	}
	if names := fx.trashNames(t); len(names) != 0 {
		t.Errorf("trash after a failed move = %v", names)
	}
	os.Chmod(ro, 0o755)
	_, body := fx.deleteOK(t, "ro/a.txt")
	os.Chmod(ro, 0o555)
	if code, got := fx.restore(t, body["trashId"].(string), false); code != 403 || got["code"] != "permission" {
		t.Errorf("restore into a read-only dir = %d %v", code, got)
	}
}

// A file the server cannot read cannot be hashed, so it is not deleted.
func TestFilesDeleteUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads any file")
	}
	fx := newTrashFixture(t)
	fx.write(t, "secret.bin", "s")
	hash := fx.hash(t, "secret.bin")
	os.Chmod(filepath.Join(fx.root, "secret.bin"), 0)
	if code, got := fx.post(t, "delete", map[string]any{"path": "secret.bin", "kind": "file", "baseHash": hash}); code != 403 || got["code"] != "permission" {
		t.Errorf("unreadable = %d %v", code, got)
	}
}

func TestTrashUnreadableRecord(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads any file")
	}
	tt := newTestTrash(t)
	id := randomHex(16)
	writeFile(t, filepath.Join(tt.dir, id+".json"), "{}")
	os.Chmod(filepath.Join(tt.dir, id+".json"), 0)
	tt.mu.Lock()
	defer tt.mu.Unlock()
	if _, err := tt.readRecordLocked(id); err == nil || err == errNotInTrash {
		t.Errorf("unreadable record = %v", err)
	}
}

// A trash the server can no longer write: nothing is deleted.
func TestFilesDeleteReadOnlyTrash(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes any directory")
	}
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	os.Chmod(fx.trashDir, 0o500)
	t.Cleanup(func() { os.Chmod(fx.trashDir, 0o700) })
	if code, got := fx.del(t, "a.txt", nil); code != 503 || got["code"] != "trash_unavailable" {
		t.Errorf("read-only trash = %d %v", code, got)
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "a\n" {
		t.Error("file lost")
	}
	if !isStorageFull(syscall.ENOSPC) || trashError(syscall.ENOSPC) != errStorageFull {
		t.Error("full disk")
	}
}
