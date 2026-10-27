//go:build !windows

package main

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// An assets/ that is a link is no assets directory: the image goes next to
// the Markdown file, never through the link. A directory on the way that is
// a link is refused.
func TestFilesImageSymlinks(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	img := testImage(t, "image/png")
	if err := os.Symlink(fx.outside, filepath.Join(fx.root, "sub", "assets")); err != nil {
		t.Fatal(err)
	}
	if code, body := fx.pasteImage(t, dirQuery("sub"), img, "image/png"); code != http.StatusCreated || body["path"] != "sub/"+pastedName+".png" {
		t.Fatalf("assets link = %d %v", code, body)
	}
	notExist(t, filepath.Join(fx.outside, pastedName+".png"))
	// "in" leads to sub
	if code, body := fx.pasteImage(t, dirQuery("in"), img, "image/png"); code != http.StatusForbidden || body["code"] != "symlink" {
		t.Errorf("dir link = %d %v", code, body)
	}
}

// An assets/ directory under a deny dir's name is refused, never written
func TestFilesImageAssetsDenied(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	cfg := testConfig(t)
	assets := filepath.Join(fx.root, "sub", "assets")
	if err := os.Mkdir(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg.FilesDenyDirs = []string{assets}
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: fx.root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	fx.h = h
	if code, body := fx.pasteImage(t, dirQuery("sub"), testImage(t, "image/png"), "image/png"); code != http.StatusForbidden || body["code"] != "not_allowed" {
		t.Errorf("denied assets = %d %v", code, body)
	}
	notExist(t, filepath.Join(assets, pastedName+".png"))
	notExist(t, filepath.Join(fx.root, "sub", pastedName+".png"))
}

// A directory the server cannot write in: refused with a code, nothing left
func TestFilesImageReadOnlyDir(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	fixedImageTime(t)
	fx := newFilesFixture(t)
	sub := filepath.Join(fx.root, "sub")
	if err := os.Chmod(sub, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(sub, 0o755) })
	if code, body := fx.pasteImage(t, dirQuery("sub"), testImage(t, "image/png"), "image/png"); code != http.StatusForbidden || body["code"] != "permission" {
		t.Errorf("read-only dir = %d %v", code, body)
	}
}
