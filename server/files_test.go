package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// filesFakeMux is fakeMux with a pane directory.
type filesFakeMux struct {
	fakeMux
	dir   string
	files bool
}

func (f *filesFakeMux) Caps() Caps { return Caps{Files: f.files} }
func (f *filesFakeMux) PaneDir(context.Context, string) (string, string, error) {
	return f.dir, "%1", nil
}

func TestCleanRelPath(t *testing.T) {
	ok := map[string]string{
		"":             ".",
		".":            ".",
		"a/b.txt":      filepath.Join("a", "b.txt"),
		"a/./b/../c":   filepath.Join("a", "c"),
		"-x":           "-x",
		"tên file.txt": "tên file.txt",
		" spaced ":     " spaced ",
	}
	if runtime.GOOS != "windows" {
		ok[`a\b`] = `a\b` // an ordinary character in a Unix file name
	}
	for in, want := range ok {
		if got, err := cleanRelPath(in); err != nil || got != want {
			t.Errorf("cleanRelPath(%q) = %q, %v, want %q", in, got, err, want)
		}
	}
	bad := []string{"..", "a/../..", "../x", "/etc/passwd", "a\x00b"}
	if runtime.GOOS == "windows" {
		bad = append(bad, `C:\x`, `..\x`, "NUL")
	}
	for _, in := range bad {
		if got, err := cleanRelPath(in); err == nil {
			t.Errorf("cleanRelPath(%q) = %q, want an error", in, got)
		}
	}
}

func TestIsSensitive(t *testing.T) {
	for p, want := range map[string]bool{
		"/r/.env":                        true,
		"/r/.ENV.local":                  true,
		"/r/certs/server.pem":            true,
		"/r/id_ed25519.pub":              true,
		"/r/secrets.yaml":                true,
		"/r/prod.tfstate":                true,
		"/r/prod.tfstate.backup":         true,
		"/r/.htpasswd":                   true,
		"/r/my-service-account-key.json": true,
		"/r/.terraformrc":                true,
		"/r/credentials":                 true,
		"/home/u/.ssh/config":            true,
		"/home/u/.config/gh/hosts.yml":   true,
		"/home/u/.config/gcloud/x/y":     true,
		"/home/u/.aws/config":            true,
		"/r/main.go":                     false,
		"/r/.environment.md":             false,
		"/home/u/.ssh":                   false, // the directory entry itself
		"/home/u/.config/other/x":        false,
		"/r/prod-creds.yaml":             false, // missed: a warning list, not a boundary
	} {
		if got := isSensitive(filepath.FromSlash(p)); got != want {
			t.Errorf("isSensitive(%q) = %v, want %v", p, got, want)
		}
	}
}

// filesFixture builds a pane directory with one of every kind of entry.
type filesFixture struct {
	root, outside, deny string
	h                   http.Handler
}

func newFilesFixture(t *testing.T) *filesFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	deny := filepath.Join(root, "cfg")
	writeFile(t, filepath.Join(root, "a.txt"), "hello\n")
	writeFile(t, filepath.Join(root, "B.md"), "# b\n")
	writeFile(t, filepath.Join(root, "sub", "b.go"), "package b\n")
	writeFile(t, filepath.Join(root, ".env"), "TOKEN=x\n")
	writeFile(t, filepath.Join(root, "secrets.yaml"), "k: v\n")
	writeFile(t, filepath.Join(root, "prod.tfstate"), "{}\n")
	writeFile(t, filepath.Join(root, ".git", "config"), "[remote]\nurl = https://token@x\n")
	writeFile(t, filepath.Join(root, "image.png"), "\x89PNG\r\n\x1a\n\x00\x00\x00")
	writeFile(t, filepath.Join(root, "latin1.txt"), "caf\xe9\n")
	writeFile(t, filepath.Join(deny, "secret"), "key\n")
	writeFile(t, filepath.Join(outside, "passwd"), "root:x\n")
	if err := os.WriteFile(filepath.Join(root, "big.log"), make([]byte, 2<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		for link, target := range map[string]string{
			"notes.txt": ".env",
			"in":        "sub",
			"out":       "../outside/passwd",
			"cfglink":   "cfg/secret",
			"gitlink":   ".git/config",
		} {
			if err := os.Symlink(target, filepath.Join(root, link)); err != nil {
				t.Fatal(err)
			}
		}
	}
	cfg := testConfig(t)
	cfg.FilesDenyDirs = []string{deny}
	h, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	return &filesFixture{root: root, outside: outside, deny: deny, h: h}
}

func (fx *filesFixture) get(t *testing.T, route string, q url.Values) (int, map[string]any) {
	t.Helper()
	rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/0/files/"+route+"?"+q.Encode(), ""))
	return rec.Code, decodeBody(t, rec)
}

func TestFilesTree(t *testing.T) {
	fx := newFilesFixture(t)
	code, body := fx.get(t, "tree", nil)
	if code != http.StatusOK {
		t.Fatalf("tree = %d %v", code, body)
	}
	if body["root"] != fx.root || body["isRepo"] != false || body["path"] != "." || body["truncated"] != false {
		t.Errorf("tree header = %v", body)
	}
	var names []string
	byName := map[string]map[string]any{}
	for _, e := range body["entries"].([]any) {
		m := e.(map[string]any)
		names = append(names, m["name"].(string))
		byName[m["name"].(string)] = m
	}
	if _, ok := byName[".git"]; ok {
		t.Error(".git listed")
	}
	// Directories (and links to them) first, then names without case.
	want := []string{"cfg", "sub", ".env", "a.txt", "B.md", "big.log", "image.png", "latin1.txt", "prod.tfstate", "secrets.yaml"}
	if runtime.GOOS != "windows" {
		want = []string{"cfg", "in", "sub", ".env", "a.txt", "B.md", "big.log", "cfglink", "gitlink", "image.png", "latin1.txt", "notes.txt", "out", "prod.tfstate", "secrets.yaml"}
	}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Errorf("names = %v\nwant    %v", names, want)
	}
	if e := byName["a.txt"]; e["type"] != "file" || e["size"] != float64(6) || e["sensitive"] != false {
		t.Errorf("a.txt = %v", e)
	}
	for _, n := range []string{".env", "secrets.yaml", "prod.tfstate"} {
		if byName[n]["sensitive"] != true {
			t.Errorf("%s not sensitive: %v", n, byName[n])
		}
	}
	if runtime.GOOS != "windows" {
		if e := byName["notes.txt"]; e["type"] != "symlink" || e["target"] != "file" || e["sensitive"] != true {
			t.Errorf("notes.txt -> .env = %v", e)
		}
		if e := byName["in"]; e["target"] != "dir" {
			t.Errorf("in -> sub = %v", e)
		}
		if e := byName["out"]; e["target"] != nil {
			t.Errorf("out (leaves the root) = %v", e)
		}
	}

	code, body = fx.get(t, "tree", url.Values{"path": {"sub"}})
	if es := body["entries"].([]any); code != 200 || body["path"] != "sub" || len(es) != 1 {
		t.Errorf("tree sub = %d %v", code, body)
	}
	if runtime.GOOS != "windows" {
		if code, body = fx.get(t, "tree", url.Values{"path": {"in"}}); code != 200 || len(body["entries"].([]any)) != 1 {
			t.Errorf("tree through a dir link = %d %v", code, body)
		}
	}
	for path, wantCode := range map[string]int{
		"a.txt":     http.StatusBadRequest, // not a directory
		"missing":   http.StatusNotFound,
		"..":        http.StatusBadRequest,
		"/etc":      http.StatusBadRequest,
		".git":      http.StatusForbidden,
		"cfg":       http.StatusForbidden,
		"sub/../..": http.StatusBadRequest,
	} {
		if code, body := fx.get(t, "tree", url.Values{"path": {path}}); code != wantCode {
			t.Errorf("tree %q = %d %v, want %d", path, code, body, wantCode)
		}
	}
}

func TestIsGitDirName(t *testing.T) {
	for name, want := range map[string]bool{
		".git": true, ".GIT": true, ".git.": true, ".git ": true, "GIT~1": true, "git~2": true,
		".gitignore": false, "git": false, ".github": false, "a.git": false,
	} {
		if got := isGitDirName(name); got != want {
			t.Errorf("isGitDirName(%q) = %v, want %v", name, got, want)
		}
	}
}

// A file the server cannot read is a 403, not a logged 500.
func TestFilesContentPermissionDenied(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs Unix permissions and a non-root user")
	}
	fx := newFilesFixture(t)
	p := filepath.Join(fx.root, "locked.txt")
	writeFile(t, p, "x\n")
	os.Chmod(p, 0)
	if code, body := fx.get(t, "content", url.Values{"path": {"locked.txt"}}); code != http.StatusForbidden || body["error"] != "permission denied" {
		t.Errorf("unreadable = %d %v", code, body)
	}
}

func TestFilesTreeTruncates(t *testing.T) {
	fx := newFilesFixture(t)
	dir := filepath.Join(fx.root, "many")
	os.MkdirAll(dir, 0o755)
	for i := 0; i < maxDirEntries+10; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%05d", i)), nil, 0o644)
	}
	code, body := fx.get(t, "tree", url.Values{"path": {"many"}})
	if code != 200 || body["truncated"] != true || len(body["entries"].([]any)) != maxDirEntries {
		t.Errorf("tree many = %d truncated=%v n=%d", code, body["truncated"], len(body["entries"].([]any)))
	}
}

func TestFilesContent(t *testing.T) {
	fx := newFilesFixture(t)
	code, body := fx.get(t, "content", url.Values{"path": {"a.txt"}})
	if code != 200 || body["text"] != "hello\n" || body["size"] != float64(6) || body["path"] != "a.txt" || body["root"] != fx.root {
		t.Errorf("a.txt = %d %v", code, body)
	}
	if code, body = fx.get(t, "content", url.Values{"path": {"sub/b.go"}}); code != 200 || body["text"] != "package b\n" {
		t.Errorf("sub/b.go = %d %v", code, body)
	}
	for path, reason := range map[string]string{"image.png": "binary", "latin1.txt": "binary", "big.log": "too-large", "sub": "not-regular"} {
		code, body := fx.get(t, "content", url.Values{"path": {path}})
		if code != 200 || body["previewable"] != false || body["reason"] != reason || body["text"] != nil {
			t.Errorf("%s = %d %v, want %s", path, code, body, reason)
		}
	}
	// Sensitive: nothing of the contents without reveal=1.
	sensitive := []string{".env", "secrets.yaml", "prod.tfstate"}
	if runtime.GOOS != "windows" {
		sensitive = append(sensitive, "notes.txt")
	}
	for _, p := range sensitive {
		rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/0/files/content?path="+url.QueryEscape(p), ""))
		if rec.Code != 200 || strings.Contains(rec.Body.String(), "text") || !strings.Contains(rec.Body.String(), `"sensitive":true`) {
			t.Errorf("%s without reveal = %d %s", p, rec.Code, rec.Body.String())
		}
	}
	if code, body = fx.get(t, "content", url.Values{"path": {".env"}, "reveal": {"1"}}); code != 200 || body["text"] != "TOKEN=x\n" {
		t.Errorf(".env with reveal = %d %v", code, body)
	}
	// Never served, reveal or not.
	never := []string{".git/config", "cfg/secret", ".GIT/config"}
	if runtime.GOOS != "windows" {
		never = append(never, "cfglink", "gitlink")
	}
	for _, p := range never {
		if code, body := fx.get(t, "content", url.Values{"path": {p}, "reveal": {"1"}}); code != http.StatusForbidden {
			t.Errorf("%s = %d %v, want 403", p, code, body)
		}
	}
	bad := map[string]int{"../outside/passwd": 400, "/etc/passwd": 400, "a\x00b": 400, "missing.txt": 404, "a.txt/x": 404}
	if runtime.GOOS != "windows" {
		bad["out"] = 400 // a symlink that leaves the root
	}
	for p, want := range bad {
		code, body := fx.get(t, "content", url.Values{"path": {p}})
		if code != want {
			t.Errorf("%q = %d %v, want %d", p, code, body, want)
		}
		if strings.Contains(fmt.Sprint(body), "root:x") {
			t.Errorf("%q leaked a file outside the root", p)
		}
	}
	if _, body := fx.get(t, "content", url.Values{"path": {"out"}}); runtime.GOOS != "windows" && body["error"] != "path outside root" {
		t.Errorf("out error = %v", body)
	}
}

// A FIFO answers not-regular at once instead of waiting for a writer.
func TestFilesContentFIFODoesNotHang(t *testing.T) {
	if _, err := exec.LookPath("mkfifo"); err != nil || runtime.GOOS == "windows" {
		t.Skip("needs mkfifo")
	}
	fx := newFilesFixture(t)
	if err := exec.Command("mkfifo", filepath.Join(fx.root, "pipe")).Run(); err != nil {
		t.Fatal(err)
	}
	done := make(chan map[string]any, 1)
	go func() {
		_, body := fx.get(t, "content", url.Values{"path": {"pipe"}})
		done <- body
	}()
	select {
	case body := <-done:
		if body["reason"] != "not-regular" {
			t.Errorf("fifo = %v", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("content of a FIFO hung")
	}
	_, body := fx.get(t, "tree", nil)
	for _, e := range body["entries"].([]any) {
		if m := e.(map[string]any); m["name"] == "pipe" && m["type"] != "other" {
			t.Errorf("pipe entry = %v", m)
		}
	}
}

// The root a client saw must still be the pane's: otherwise 409 with the new
// one, so it reloads instead of reading paths of another directory.
func TestFilesRootChanged(t *testing.T) {
	fx := newFilesFixture(t)
	if code, _ := fx.get(t, "tree", url.Values{"root": {fx.root}}); code != 200 {
		t.Errorf("same root = %d", code)
	}
	code, body := fx.get(t, "content", url.Values{"root": {"/elsewhere"}, "path": {"a.txt"}})
	if code != http.StatusConflict || body["root"] != fx.root || body["text"] != nil {
		t.Errorf("other root = %d %v", code, body)
	}
}

// The deny list holds when the pane's root is above it (cwd = $HOME).
func TestFilesDenyDirsAboveRoot(t *testing.T) {
	fx := newFilesFixture(t)
	code, body := fx.get(t, "content", url.Values{"path": {"cfg/secret"}, "reveal": {"1"}})
	if code != http.StatusForbidden || body["error"] != "path not allowed" {
		t.Errorf("cfg/secret = %d %v", code, body)
	}
	if runtime.GOOS == "linux" {
		f := &filesAPI{deny: filesDenyDirs(systemDenyDirs...)}
		if !f.denied("/", "proc/1/environ") || !f.denied("/proc", ".") || f.denied("/", "home") {
			t.Error("system deny dirs not applied")
		}
	}
}

func TestFilesDenyDirsResolvesLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	base, _ := filepath.EvalSymlinks(t.TempDir())
	real := filepath.Join(base, "real")
	os.MkdirAll(real, 0o755)
	link := filepath.Join(base, "link")
	os.Symlink(real, link)
	got := filesDenyDirs(link, "", filepath.Join(base, "missing"))
	if strings.Join(got, ",") != strings.Join([]string{link, real, filepath.Join(base, "missing")}, ",") {
		t.Errorf("filesDenyDirs = %v", got)
	}
}

func TestFilesGuards(t *testing.T) {
	fx := newFilesFixture(t)
	path := "/api/mux/panes/0/files/content?path=a.txt"

	req := apiRequest("POST", path, "{}")
	if rec := serve(fx.h, req); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
	for name, set := range map[string]func(*http.Request){
		"cross-site":   func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		"same-site":    func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "same-site") },
		"other origin": func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") },
		"bad host":     func(r *http.Request) { r.Host = "evil.example" },
	} {
		req := apiRequest("GET", path, "")
		set(req)
		if rec := serve(fx.h, req); rec.Code != http.StatusForbidden || strings.Contains(rec.Body.String(), "hello") {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body.String())
		}
	}
	req = apiRequest("GET", path, "")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Origin", "http://localhost:7680")
	if rec := serve(fx.h, req); rec.Code != 200 {
		t.Errorf("same-origin = %d", rec.Code)
	}
	req = apiRequest("GET", path, "")
	req.Header.Del("Authorization")
	if rec := serve(fx.h, req); rec.Code != http.StatusUnauthorized {
		t.Errorf("no auth = %d", rec.Code)
	}
	rec := serve(fx.h, apiRequest("GET", path, ""))
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(rec.Header().Get("Cache-Control"), "no-store") {
		t.Errorf("headers = %v", rec.Header())
	}
}

func TestFilesUnsupportedBackend(t *testing.T) {
	for name, m := range map[string]Mux{
		"no PaneDirer": &fakeMux{},
		"cap off":      &filesFakeMux{dir: t.TempDir()},
	} {
		rec := serve(newTestHandler(t, m), apiRequest("GET", "/api/mux/panes/0/files/tree", ""))
		if rec.Code != http.StatusNotImplemented {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestFilesErrorFallback(t *testing.T) {
	f := &filesAPI{m: &fakeMux{}}
	for err, want := range map[error]int{
		errGitTimeout:              http.StatusServiceUnavailable,
		fmt.Errorf("disk on fire"): http.StatusInternalServerError,
		errDirNotAvailable:         http.StatusBadRequest,
	} {
		rec := httptest.NewRecorder()
		f.error(rec, "test", err)
		if rec.Code != want {
			t.Errorf("%v = %d, want %d", err, rec.Code, want)
		}
	}
	// A pane directory that is gone.
	h := newTestHandler(t, &filesFakeMux{dir: filepath.Join(t.TempDir(), "gone"), files: true})
	if rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/tree", "")); rec.Code != http.StatusBadRequest {
		t.Errorf("gone dir = %d", rec.Code)
	}
}
