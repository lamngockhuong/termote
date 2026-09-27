package webui

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestEmbeddedServesBuild(t *testing.T) {
	root := fstest.MapFS{
		"dist/index.html":  {Data: []byte("<html>app</html>")},
		"dist/assets/a.js": {Data: []byte("js")},
		"dist/.gitkeep":    {},
	}
	got := embedded(root)
	b, err := fs.ReadFile(got, "index.html")
	if err != nil || string(b) != "<html>app</html>" {
		t.Fatalf("index.html = %q, %v", b, err)
	}
	if _, err := fs.Stat(got, "assets/a.js"); err != nil {
		t.Fatalf("assets/a.js: %v", err)
	}
}

func TestEmbeddedPlaceholderWithoutBuild(t *testing.T) {
	got := embedded(fstest.MapFS{"dist/.gitkeep": {}})
	b, err := fs.ReadFile(got, "index.html")
	if err != nil || !strings.Contains(string(b), "make build") {
		t.Fatalf("placeholder = %q, %v", b, err)
	}
}

func TestFSFromDisk(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("disk"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := fs.ReadFile(FS(dir), "index.html")
	if err != nil || string(b) != "disk" {
		t.Fatalf("index.html = %q, %v", b, err)
	}
}

// The real embed always matches .gitkeep, so a build without the PWA still
// serves an index.html.
func TestFSEmbeddedHasIndex(t *testing.T) {
	if _, err := fs.Stat(FS(""), "index.html"); err != nil {
		t.Fatal(err)
	}
}
