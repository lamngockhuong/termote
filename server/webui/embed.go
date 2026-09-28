// Package webui holds the PWA build embedded in the termote binary.
//
// The build step (make build, the shims, CI) copies pwa's Vite output into
// dist/ before `go build`. In git, dist/ only holds .gitkeep, so the embed
// pattern always matches and a plain `go build` or `go test` still works; the
// binary then serves a placeholder page instead of the app.
package webui

import (
	"embed"
	"io/fs"
	"os"
	"testing/fstest"
)

//go:embed all:dist
var files embed.FS

// placeholder is served when the binary was built without the PWA.
const placeholder = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Termote</title></head>
<body>
<h1>Termote</h1>
<p>The PWA was not built into this binary. Run <code>make build</code> (or <code>pnpm --filter termote build</code> and rebuild the server).</p>
</body>
</html>
`

// FS returns the files to serve at /. A non-empty dir (TERMOTE_PWA_DIR, for
// PWA development) is served from disk; otherwise the embedded build, or the
// placeholder page when the build was not embedded.
func FS(dir string) fs.FS {
	if dir != "" {
		return os.DirFS(dir)
	}
	return embedded(files)
}

// Built reports whether the embedded build holds the app.
func Built() bool {
	_, err := fs.Stat(files, "dist/index.html")
	return err == nil
}

func embedded(root fs.FS) fs.FS {
	sub, err := fs.Sub(root, "dist")
	if err == nil {
		if _, err = fs.Stat(sub, "index.html"); err == nil {
			return sub
		}
	}
	return fstest.MapFS{"index.html": {Data: []byte(placeholder), Mode: 0o444}}
}
