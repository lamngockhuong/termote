package main

import (
	"net/http"
	"path/filepath"
	"testing"
)

// An assets/ that is a junction is no assets directory: the image goes next
// to the Markdown file. A junction on the way is refused.
func TestFilesImageJunctions(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	img := testImage(t, "image/png")
	junction(t, filepath.Join(fx.root, "sub", "assets"), fx.outside)
	if code, body := fx.pasteImage(t, dirQuery("sub"), img, "image/png"); code != http.StatusCreated || body["path"] != "sub/"+pastedName+".png" {
		t.Fatalf("assets junction = %d %v", code, body)
	}
	notExist(t, filepath.Join(fx.outside, pastedName+".png"))
	junction(t, filepath.Join(fx.root, "jn"), filepath.Join(fx.root, "sub"))
	if code, body := fx.pasteImage(t, dirQuery("jn"), img, "image/png"); code != http.StatusForbidden || body["code"] != "symlink" {
		t.Errorf("dir junction = %d %v", code, body)
	}
}
