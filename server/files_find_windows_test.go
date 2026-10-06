package main

import (
	"net/url"
	"path/filepath"
	"testing"
)

// A junction is never walked, wherever it leads, and excluded names are
// compared without case, as Windows compares them.
func TestFilesFindJunctionAndCase(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	writeFile(t, filepath.Join(root, "sub", "hit.txt"), "")
	writeFile(t, filepath.Join(root, "Node_Modules", "hit.js"), "")
	writeFile(t, filepath.Join(outside, "hit_out.txt"), "")
	junction(t, filepath.Join(root, "j-in"), filepath.Join(root, "sub"))
	junction(t, filepath.Join(root, "j-out"), outside)
	fx := newFindFixture(t, root)
	neverReads(t, "Node_Modules")
	_, by := fx.findOK(t, url.Values{"q": {"hit"}, "exclude": {nodeModules}})
	if len(by) != 1 || by["sub/hit.txt"] == nil {
		t.Errorf("results = %v", by)
	}
}
