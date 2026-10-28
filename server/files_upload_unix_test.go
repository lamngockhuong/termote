//go:build !windows

package main

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// A directory on the way that is a link is refused, never written through
func TestFilesUploadSymlinkDir(t *testing.T) {
	fx := newUploadFixture(t)
	outside := filepath.Join(filepath.Dir(fx.root), "outside")
	mkdir(t, outside)
	if err := os.Symlink(outside, filepath.Join(fx.root, "link")); err != nil {
		t.Fatal(err)
	}
	for _, check := range []string{"", "1"} {
		code, body := fx.upload(t, uploadQuery("link", "n.txt", "check", check), []byte("x"))
		if code != http.StatusForbidden || body["code"] != "symlink" {
			t.Errorf("check %q = %d %v", check, code, body)
		}
	}
	notExist(t, filepath.Join(outside, "n.txt"))
}

// A directory the server cannot write in: refused with a code, nothing left
func TestFilesUploadReadOnlyDir(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	fx := newUploadFixture(t)
	sub := filepath.Join(fx.root, "sub")
	if err := os.Chmod(sub, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(sub, 0o755) })
	if code, body := fx.upload(t, uploadQuery("sub", "n.txt"), []byte("x")); code != http.StatusForbidden || body["code"] != "permission" {
		t.Errorf("read-only = %d %v", code, body)
	}
	notExist(t, filepath.Join(sub, "n.txt"))
	noTemps(t, sub)
}

// A full disk is the disk's: 507, never the body's error
func TestStreamNewFileStorageFull(t *testing.T) {
	if _, err := streamNewFile(&fakeFile{writeErr: syscall.ENOSPC}, strings.NewReader("x"), uploadBodyError); err != errStorageFull {
		t.Errorf("ENOSPC = %v", err)
	}
	if _, err := streamNewFile(&fakeFile{syncErr: syscall.EDQUOT}, strings.NewReader("x"), uploadBodyError); err != errStorageFull {
		t.Errorf("EDQUOT = %v", err)
	}
	if !isLinkUnsupported(&os.LinkError{Err: syscall.EPERM}) || isLinkUnsupported(&os.LinkError{Err: syscall.EEXIST}) {
		t.Error("isLinkUnsupported")
	}
}

// The disk refuses the file's name: its own code, the temp removed
func TestFilesUploadDiskRefusesLink(t *testing.T) {
	fx := newUploadFixture(t)
	old := uploadLink
	t.Cleanup(func() { uploadLink = old })
	for errno, want := range map[syscall.Errno]struct {
		code int
		key  string
	}{
		syscall.EROFS:  {http.StatusForbidden, "read_only"},
		syscall.ENOSPC: {http.StatusInsufficientStorage, "storage_full"},
		syscall.EACCES: {http.StatusForbidden, "permission"},
	} {
		uploadLink = func(*os.Root, string, string) error { return &os.LinkError{Op: "link", Err: errno} }
		if code, body := fx.upload(t, uploadQuery(".", "n.txt"), []byte("x")); code != want.code || body["code"] != want.key {
			t.Errorf("%v = %d %v", errno, code, body)
		}
		notExist(t, filepath.Join(fx.root, "n.txt"))
		noTemps(t, fx.root)
	}
	// A FUSE mount without link: renamed instead
	uploadLink = func(*os.Root, string, string) error { return &os.LinkError{Op: "link", Err: syscall.ENOSYS} }
	if code, body := fx.upload(t, uploadQuery(".", "n.txt"), []byte("x")); code != http.StatusCreated || body["path"] != "n.txt" {
		t.Errorf("ENOSYS = %d %v", code, body)
	}
}

// Into a Place: written there; a Place swapped for a link since is refused
func TestFilesUploadPlace(t *testing.T) {
	old := placeCheckTTL
	placeCheckTTL = 0
	t.Cleanup(func() { placeCheckTTL = old })
	fx := newPlaceFixture(t, func(home string) string {
		real := mkdir(t, filepath.Join(home, "real"))
		link := filepath.Join(home, "notes")
		if err := os.Symlink(real, link); err != nil {
			t.Fatal(err)
		}
		return link
	})
	post := func() (int, string) {
		q := uploadQuery(".", "up.txt", "place", fx.id)
		q.Set("root", filepath.Join(fx.home, "real"))
		rec := serve(fx.h, fileUploadRequest("", q, bytes.NewReader([]byte("x"))))
		return rec.Code, rec.Body.String()
	}
	if code, body := post(); code != http.StatusCreated || !strings.Contains(body, `"up.txt"`) {
		t.Fatalf("place = %d %s", code, body)
	}
	os.Remove(fx.place)
	os.Symlink(filepath.Join(fx.home, ".ssh"), fx.place)
	if code, body := post(); code != http.StatusForbidden || errCode(body) != "place_moved" {
		t.Errorf("swapped place = %d %s", code, body)
	}
	notExist(t, filepath.Join(fx.home, ".ssh", "up.txt"))
}
