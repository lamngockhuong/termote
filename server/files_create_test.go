package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// create sends a create of body through fx's server.
func (fx *filesFixture) create(t *testing.T, root string, body map[string]any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	q := url.Values{}
	if root != "" {
		q.Set("root", root)
	}
	rec := serve(fx.h, apiRequest("POST", "/api/mux/panes/0/files/create?"+q.Encode(), string(b)))
	return rec.Code, decodeBody(t, rec)
}

func notExist(t *testing.T, p string) {
	t.Helper()
	if _, err := os.Lstat(p); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("%s exists (%v)", p, err)
	}
}

func TestFilesCreate(t *testing.T) {
	fx := newFilesFixture(t)
	code, body := fx.create(t, fx.root, map[string]any{"path": "new.md"})
	if code != http.StatusCreated || body["root"] != fx.root || body["path"] != "new.md" || len(body) != 2 {
		t.Fatalf("create = %d %v", code, body)
	}
	if got := readText(t, filepath.Join(fx.root, "new.md")); got != "" {
		t.Errorf("new.md = %q", got)
	}
	// The missing directories are made.
	code, body = fx.create(t, fx.root, map[string]any{"path": "x/y/z.md"})
	if code != http.StatusCreated || body["path"] != "x/y/z.md" {
		t.Fatalf("nested = %d %v", code, body)
	}
	if fi, err := os.Stat(filepath.Join(fx.root, "x", "y")); err != nil || !fi.IsDir() {
		t.Errorf("x/y = %v %v", fi, err)
	}
	// Under an existing directory.
	if code, body := fx.create(t, fx.root, map[string]any{"path": "sub/c.go"}); code != http.StatusCreated {
		t.Errorf("sub/c.go = %d %v", code, body)
	}
	// The contents go through a save, with the hash a read reports.
	_, got := fx.get(t, "content", url.Values{"path": {"x/y/z.md"}})
	if got["text"] != "" || got["editable"] != true {
		t.Fatalf("GET new = %v", got)
	}
	code, body = fx.put(t, fx.root, map[string]any{"path": "x/y/z.md", "baseHash": got["hash"], "text": "# z\n"})
	if code != 200 || readText(t, filepath.Join(fx.root, "x", "y", "z.md")) != "# z\n" {
		t.Errorf("save = %d %v", code, body)
	}
}

func TestFilesCreateExists(t *testing.T) {
	fx := newFilesFixture(t)
	for _, rel := range []string{"a.txt", "sub", "sub/b.go", "B.md"} {
		code, got := fx.create(t, fx.root, map[string]any{"path": rel})
		if code != http.StatusConflict || got["code"] != "exists" {
			t.Errorf("%s = %d %v", rel, code, got)
		}
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "hello\n" {
		t.Error("a.txt replaced")
	}
	// A second create of the same name: never replaced.
	fx.create(t, fx.root, map[string]any{"path": "n.txt"})
	writeFile(t, filepath.Join(fx.root, "n.txt"), "typed\n")
	if code, got := fx.create(t, fx.root, map[string]any{"path": "n.txt"}); code != http.StatusConflict || got["code"] != "exists" {
		t.Errorf("again = %d %v", code, got)
	}
	if readText(t, filepath.Join(fx.root, "n.txt")) != "typed\n" {
		t.Error("n.txt replaced")
	}
	// A parent that is a file.
	for _, rel := range []string{"a.txt/x.md", "sub/b.go/y/z.md"} {
		code, got := fx.create(t, fx.root, map[string]any{"path": rel})
		if code != http.StatusConflict || got["code"] != "not_directory" {
			t.Errorf("%s = %d %v", rel, code, got)
		}
	}
}

func TestFilesCreateDenied(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(base, "root")
	writeFile(t, filepath.Join(root, ".git", "config"), "[core]\n")
	writeFile(t, filepath.Join(root, "cfg", "secret"), "k\n")
	writeFile(t, filepath.Join(root, "data", "current.txt"), "1.0.0\n")
	cfg := testConfig(t)
	cfg.FilesDenyDirs = []string{filepath.Join(root, "cfg")}
	cfg.FilesWriteDenyDirs = []string{filepath.Join(root, "data")}
	cfg.UploadDir = filepath.Join(root, "uploads")
	h, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	fx := &filesFixture{root: root, h: h}
	for _, rel := range []string{".git/x", ".git/new/x", ".GIT/hooks/pre-commit", "cfg/x", "cfg/new/x", "data/x", "data/new/x", "uploads/x.png", "uploads"} {
		code, got := fx.create(t, root, map[string]any{"path": rel, "reveal": true})
		if code != http.StatusForbidden || got["code"] != "not_allowed" {
			t.Errorf("%s = %d %v", rel, code, got)
		}
	}
	// .GIT/hooks is .git/hooks where names ignore case (macOS, Windows)
	for _, p := range []string{".git/x", ".git/new", ".git/hooks", ".GIT/hooks", "cfg/x", "cfg/new", "data/x", "data/new"} {
		notExist(t, filepath.Join(root, p))
	}
}

// A denied directory is also refused by what it is once it exists, before
// anything is made inside it: walkParents checks every level it opens.
func TestWalkParentsDenied(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	if err := os.Mkdir(filepath.Join(dir, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	f := registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: dir, files: true}, hostAllowlist{}, nil)
	f.writeDeny = []string{filepath.Join(dir, "data")}
	for _, parent := range []string{"data", filepath.Join("data", "new")} {
		rt, _ := os.OpenRoot(dir)
		if d, err := f.walkParents(rt, filesRoot{Root: dir}, parent); err != errCreateNotAllowed {
			t.Errorf("%s = %v %v", parent, d, err)
		}
	}
	notExist(t, filepath.Join(dir, "data", "new"))
}

func TestFilesCreateSensitive(t *testing.T) {
	fx := newFilesFixture(t)
	code, got := fx.create(t, fx.root, map[string]any{"path": "conf/.env.local"})
	if code != http.StatusForbidden || got["code"] != "sensitive" {
		t.Errorf("no reveal = %d %v", code, got)
	}
	notExist(t, filepath.Join(fx.root, "conf"))
	code, got = fx.create(t, fx.root, map[string]any{"path": "conf/.env.local", "reveal": true})
	if code != http.StatusCreated || got["path"] != "conf/.env.local" {
		t.Errorf("reveal = %d %v", code, got)
	}
}

func TestFilesCreateInvalidName(t *testing.T) {
	fx := newFilesFixture(t)
	deep := strings.Repeat("d/", createMaxParts) + "x"
	for _, p := range []string{
		"", ".", "..", "../x", "/abs", "a/../../x", "a\x00b", "docs/", `docs\`, "a//b", "a./b", "a /b", "x.", "x ", "a\nb", "a\rb", "a\x1fb", "a\x7fb",
		editTempPrefix + "0123456789abcdef", "d/" + editTempPrefix + "0123456789abcdef",
		deep, strings.Repeat("x", createMaxPath+1), strings.Repeat("n", createMaxName+1),
	} {
		code, got := fx.create(t, fx.root, map[string]any{"path": p, "reveal": true})
		if code != http.StatusBadRequest || got["code"] != "invalid_name" {
			t.Errorf("%q = %d %v", p, code, got)
		}
	}
	notExist(t, filepath.Join(fx.root, "docs"))
	notExist(t, filepath.Join(fx.root, "d"))
	// At the limits: taken.
	for _, p := range []string{
		strings.Repeat("e/", createMaxParts-1) + "x", strings.Repeat("n", createMaxName),
		editTempPrefix + "notes", ".hidden", "tên file.md", "-x",
	} {
		// Every .termote-edit-* name is sensitive.
		if code, got := fx.create(t, fx.root, map[string]any{"path": p, "reveal": true}); code != http.StatusCreated {
			t.Errorf("%q = %d %v", p, code, got)
		}
	}
}

func TestFilesCreateRequest(t *testing.T) {
	fx := newFilesFixture(t)
	body := map[string]any{"path": "r.md"}
	if code, got := fx.create(t, "", body); code != http.StatusBadRequest || got["error"] != "root is required" {
		t.Errorf("no root = %d %v", code, got)
	}
	if code, got := fx.create(t, "/elsewhere", body); code != http.StatusConflict || got["root"] != fx.root || got["code"] != nil {
		t.Errorf("other root = %d %v", code, got)
	}
	notExist(t, filepath.Join(fx.root, "r.md"))
	path := "/api/mux/panes/0/files/create?root=" + url.QueryEscape(fx.root)
	for _, m := range []string{"GET", "PUT", "DELETE"} {
		if rec := serve(fx.h, apiRequest(m, path, `{"path":"r.md"}`)); rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "POST" {
			t.Errorf("%s = %d %s", m, rec.Code, rec.Body.String())
		}
	}
	if rec := serve(fx.h, apiRequest("POST", path, "{")); rec.Code != http.StatusBadRequest {
		t.Errorf("bad JSON = %d", rec.Code)
	}
	big := `{"path":"r.md","x":"` + strings.Repeat("x", maxJSONBody) + `"}`
	if rec := serve(fx.h, apiRequest("POST", path, big)); rec.Code != http.StatusBadRequest {
		t.Errorf("big body = %d", rec.Code)
	}
	notExist(t, filepath.Join(fx.root, "r.md"))
}

func TestFilesCreateGuards(t *testing.T) {
	fx := newFilesFixture(t)
	path := "/api/mux/panes/0/files/create?root=" + url.QueryEscape(fx.root)
	body := `{"path":"g.md"}`
	for name, tc := range map[string]struct {
		set  func(*http.Request)
		code int
	}{
		"cross-site":   {func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		"other origin": {func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") }, 403},
		"text/plain":   {func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		"no auth":      {func(r *http.Request) { r.Header.Del("Authorization") }, 401},
	} {
		req := apiRequest("POST", path, body)
		tc.set(req)
		if rec := serve(fx.h, req); rec.Code != tc.code {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body.String())
		}
	}
	notExist(t, filepath.Join(fx.root, "g.md"))
	// Without writeGuard in front (the route alone), the handler still
	// refuses a cross-site request.
	mux := http.NewServeMux()
	registerFilesRoutes(mux, &filesFakeMux{dir: fx.root, files: true}, hostAllowlist{}, nil)
	req := apiRequest("POST", path, body)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(mux, req); rec.Code != http.StatusForbidden {
		t.Errorf("route cross-site = %d", rec.Code)
	}
	notExist(t, filepath.Join(fx.root, "g.md"))
}

func TestFilesCreateBusy(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: dir, files: true}, hostAllowlist{}, nil)
	for i := 0; i < writeMaxRunning; i++ {
		f.writeSlots <- struct{}{}
	}
	post := func() *http.Request {
		req := apiRequest("POST", "/api/mux/panes/0/files/create?root="+url.QueryEscape(dir), `{"path":"b.md"}`)
		req.Header.Del("Origin")
		return req
	}
	if code, key := rawCode(t, serve(mux, post())); code != 429 || key != "busy" {
		t.Errorf("busy = %d %q", code, key)
	}
	notExist(t, filepath.Join(dir, "b.md"))
	<-f.writeSlots
	if rec := serve(mux, post()); rec.Code != http.StatusCreated {
		t.Errorf("free slot = %d %s", rec.Code, rec.Body.String())
	}
	if len(f.writeSlots) != writeMaxRunning-1 {
		t.Errorf("slots held = %d", len(f.writeSlots))
	}
}

// A create drops the cached git status of its root.
func TestFilesCreateForgetsStatus(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	f := registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: dir, files: true}, hostAllowlist{}, nil)
	calls := 0
	read := func() {
		f.statuses.do(dir+"\x00.", func() (gitStatus, error) { calls++; return gitStatus{}, nil })
	}
	read()
	read()
	if _, err := f.createFile(filesRoot{Root: dir}, createRequest{Path: "s.md"}); err != nil {
		t.Fatal(err)
	}
	read()
	if calls != 2 {
		t.Errorf("reads after a create = %d, want 2", calls)
	}
	// A root that is gone: nothing is made.
	gone := filepath.Join(dir, "gone")
	if _, err := f.createFile(filesRoot{Root: gone}, createRequest{Path: "s.md"}); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("gone root = %v", err)
	}
}

func TestCreateError(t *testing.T) {
	escape := &fs.PathError{Op: "openat", Path: "x", Err: errors.New("path escapes from parent")}
	other := errors.New("disk on fire")
	for in, want := range map[error]error{
		errCreateSymlink: errCreateSymlink,
		&fs.PathError{Op: "mkdirat", Path: "x", Err: fs.ErrExist}:      errCreateExists,
		&fs.PathError{Op: "openat", Path: "x", Err: syscall.EISDIR}:    errCreateExists,
		&fs.PathError{Op: "openat", Path: "x", Err: syscall.ENOTDIR}:   errCreateNotDir,
		&fs.PathError{Op: "mkdirat", Path: "x", Err: fs.ErrPermission}: errEditPermission,
		escape: errCreateSymlink,
		other:  other,
	} {
		if got := createError(in); got != want {
			t.Errorf("createError(%v) = %v, want %v", in, got, want)
		}
	}
}
