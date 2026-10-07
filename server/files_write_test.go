package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// put sends a save of path through fx's server, with the hash of the bytes
// on disk unless base is given.
func (fx *filesFixture) put(t *testing.T, root string, body map[string]any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	q := url.Values{}
	if root != "" {
		q.Set("root", root)
	}
	rec := serve(fx.h, apiRequest("PUT", "/api/mux/panes/0/files/content?"+q.Encode(), string(b)))
	return rec.Code, decodeBody(t, rec)
}

func diskHash(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return hashHex(b)
}

func readText(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// noEditTemps fails when a save left its temporary file in dir.
func noEditTemps(t *testing.T, dir string) {
	t.Helper()
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), editTempPrefix) {
			t.Errorf("temporary file left: %s", e.Name())
		}
	}
}

func TestFilesContentHashAndEditable(t *testing.T) {
	fx := newFilesFixture(t)
	code, body := fx.get(t, "content", url.Values{"path": {"a.txt"}})
	if code != 200 || body["hash"] != hashHex([]byte("hello\n")) || body["editable"] != true || body["notEditable"] != nil {
		t.Errorf("a.txt = %d %v", code, body)
	}
	if runtime.GOOS != "windows" {
		_, body = fx.get(t, "content", url.Values{"path": {"notes.txt"}, "reveal": {"1"}})
		if body["editable"] != false || body["notEditable"] != "symlink" {
			t.Errorf("symlink = %v", body)
		}
		_, body = fx.get(t, "content", url.Values{"path": {"in/b.go"}})
		if body["editable"] != false || body["notEditable"] != "symlink" {
			t.Errorf("symlinked dir = %v", body)
		}
	}
	writeFile(t, filepath.Join(fx.root, "mixed.txt"), "a\r\nb\n")
	_, body = fx.get(t, "content", url.Values{"path": {"mixed.txt"}})
	if body["text"] != "a\r\nb\n" || body["notEditable"] != "mixed-eol" {
		t.Errorf("mixed = %v", body)
	}
	// A NUL past the binary sniff is still shown, but not edited.
	writeFile(t, filepath.Join(fx.root, "nul.txt"), strings.Repeat("x", binarySniffSize)+"\x00")
	_, body = fx.get(t, "content", url.Values{"path": {"nul.txt"}})
	if body["notEditable"] != "nul" {
		t.Errorf("nul = %v", body)
	}
	_, body = fx.get(t, "content", url.Values{"path": {"latin1.txt"}})
	if body["editable"] != nil || body["hash"] != nil {
		t.Errorf("binary = %v", body)
	}
}

func TestFilesWrite(t *testing.T) {
	fx := newFilesFixture(t)
	p := filepath.Join(fx.root, "a.txt")
	base := diskHash(t, p)
	code, body := fx.put(t, fx.root, map[string]any{"path": "a.txt", "baseHash": base, "text": "bye\n"})
	if code != 200 || body["hash"] != hashHex([]byte("bye\n")) || body["size"] != float64(4) || body["path"] != "a.txt" || body["root"] != fx.root {
		t.Fatalf("save = %d %v", code, body)
	}
	if got := readText(t, p); got != "bye\n" {
		t.Errorf("file = %q", got)
	}
	noEditTemps(t, fx.root)
	// The same save again, its reply lost: no false conflict.
	if code, body := fx.put(t, fx.root, map[string]any{"path": "a.txt", "baseHash": base, "text": "bye\n"}); code != 200 {
		t.Errorf("repeat = %d %v", code, body)
	}
	// Changed on the host since it was read.
	writeFile(t, p, "agent\n")
	code, body = fx.put(t, fx.root, map[string]any{"path": "a.txt", "baseHash": base, "text": "mine\n"})
	if code != http.StatusConflict || body["code"] != "changed" || readText(t, p) != "agent\n" {
		t.Errorf("changed = %d %v", code, body)
	}
	// GET then reports what a save would send.
	_, got := fx.get(t, "content", url.Values{"path": {"a.txt"}})
	if got["hash"] != diskHash(t, p) {
		t.Errorf("hash after = %v", got)
	}
}

func TestFilesWriteRoot(t *testing.T) {
	fx := newFilesFixture(t)
	body := map[string]any{"path": "a.txt", "baseHash": diskHash(t, filepath.Join(fx.root, "a.txt")), "text": "x\n"}
	if code, got := fx.put(t, "", body); code != http.StatusBadRequest || got["error"] != "root is required" {
		t.Errorf("no root = %d %v", code, got)
	}
	if code, got := fx.put(t, "/elsewhere", body); code != http.StatusConflict || got["root"] != fx.root {
		t.Errorf("other root = %d %v", code, got)
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "hello\n" {
		t.Error("written despite the root")
	}
}

func TestFilesWriteRequest(t *testing.T) {
	fx := newFilesFixture(t)
	base := diskHash(t, filepath.Join(fx.root, "a.txt"))
	for name, tc := range map[string]struct {
		body map[string]any
		code int
		key  string
	}{
		"no baseHash": {map[string]any{"path": "a.txt", "text": "x"}, 400, ""},
		"no path":     {map[string]any{"baseHash": base, "text": "x"}, 400, ""},
		"climbs":      {map[string]any{"path": "../outside/passwd", "baseHash": base, "text": "x"}, 400, ""},
		"NUL":         {map[string]any{"path": "a.txt", "baseHash": base, "text": "a\x00b"}, 422, "not_text"},
		"lone CR":     {map[string]any{"path": "a.txt", "baseHash": base, "text": "a\rb"}, 422, "not_text"},
		"missing":     {map[string]any{"path": "nope.txt", "baseHash": base, "text": "x"}, 404, ""},
		"missing dir": {map[string]any{"path": "nodir/x.txt", "baseHash": base, "text": "x"}, 404, ""},
		"directory":   {map[string]any{"path": "sub", "baseHash": base, "text": "x"}, 422, "not_editable"},
		"too large":   {map[string]any{"path": "big.log", "baseHash": base, "text": "x"}, 413, "too_large"},
		"text > 1MiB": {map[string]any{"path": "a.txt", "baseHash": base, "text": strings.Repeat("x", maxPreviewSize+1)}, 413, "too_large"},
	} {
		code, got := fx.put(t, fx.root, tc.body)
		if code != tc.code || (tc.key != "" && got["code"] != tc.key) {
			t.Errorf("%s = %d %v", name, code, got)
		}
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "hello\n" {
		t.Error("a.txt written")
	}
	rec := serve(fx.h, apiRequest("PUT", "/api/mux/panes/0/files/content?root="+url.QueryEscape(fx.root), "{"))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad JSON = %d", rec.Code)
	}
	// A body past the limit is cut off unread.
	big := `{"path":"a.txt","baseHash":"x","text":"` + strings.Repeat("x", fileWriteBody) + `"}`
	rec = serve(fx.h, apiRequest("PUT", "/api/mux/panes/0/files/content?root="+url.QueryEscape(fx.root), big))
	if code, key := rawCode(t, rec); code != http.StatusRequestEntityTooLarge || key != "too_large" {
		t.Errorf("big body = %d %q", code, key)
	}
}

// Control characters cost six bytes each in JSON; 1 MiB of them still fits.
func TestFilesWriteEscapedBody(t *testing.T) {
	fx := newFilesFixture(t)
	p := filepath.Join(fx.root, "a.txt")
	text := strings.Repeat("\x01", maxPreviewSize-64<<10)
	code, body := fx.put(t, fx.root, map[string]any{"path": "a.txt", "baseHash": diskHash(t, p), "text": text})
	if code != 200 || readText(t, p) != text {
		t.Errorf("escaped = %d %v", code, body)
	}
}

func TestFilesWriteGuards(t *testing.T) {
	fx := newFilesFixture(t)
	path := "/api/mux/panes/0/files/content?root=" + url.QueryEscape(fx.root)
	body := `{"path":"a.txt","baseHash":"` + diskHash(t, filepath.Join(fx.root, "a.txt")) + `","text":"x"}`
	for name, tc := range map[string]struct {
		set  func(*http.Request)
		code int
	}{
		"cross-site":   {func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		"other origin": {func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") }, 403},
		"text/plain":   {func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		"no auth":      {func(r *http.Request) { r.Header.Del("Authorization") }, 401},
	} {
		req := apiRequest("PUT", path, body)
		tc.set(req)
		if rec := serve(fx.h, req); rec.Code != tc.code {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body.String())
		}
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "hello\n" {
		t.Error("a.txt written")
	}
	// Without writeGuard in front (the route alone), the handler still
	// refuses a cross-site request.
	mux := http.NewServeMux()
	registerFilesRoutes(mux, &filesFakeMux{dir: fx.root, files: true}, hostAllowlist{}, nil)
	req := apiRequest("PUT", path, body)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(mux, req); rec.Code != http.StatusForbidden {
		t.Errorf("route cross-site = %d", rec.Code)
	}
}

func TestFilesWriteSensitive(t *testing.T) {
	fx := newFilesFixture(t)
	p := filepath.Join(fx.root, ".env")
	body := map[string]any{"path": ".env", "baseHash": diskHash(t, p), "text": "TOKEN=y\n"}
	if code, got := fx.put(t, fx.root, body); code != http.StatusForbidden || got["code"] != "sensitive" {
		t.Errorf("no reveal = %d %v", code, got)
	}
	body["reveal"] = true
	if code, got := fx.put(t, fx.root, body); code != 200 || readText(t, p) != "TOKEN=y\n" {
		t.Errorf("reveal = %d %v", code, got)
	}
	if !isSensitive(filepath.Join(fx.root, editTempPrefix+"0123")) {
		t.Error("a temporary file is not sensitive")
	}
}

func TestFilesWriteDenied(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(base, "root")
	writeFile(t, filepath.Join(root, ".git", "config"), "[core]\n")
	writeFile(t, filepath.Join(root, "cfg", "secret"), "k\n")
	writeFile(t, filepath.Join(root, "data", "current.txt"), "1.0.0\n")
	writeFile(t, filepath.Join(root, "ok.txt"), "ok\n")
	cfg := testConfig(t)
	cfg.FilesDenyDirs = []string{filepath.Join(root, "cfg")}
	cfg.FilesWriteDenyDirs = []string{filepath.Join(root, "data")}
	cfg.UploadDir = filepath.Join(root, "uploads")
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "uploads", "x.txt"), "u\n")
	fx := &filesFixture{root: root, h: h}
	paths := []string{".git/config", "cfg/secret", "data/current.txt", "uploads/x.txt"}
	if runtime.GOOS != "windows" {
		os.Symlink(".git", filepath.Join(root, "gd"))
		paths = append(paths, "gd/config")
	}
	for _, rel := range paths {
		code, got := fx.put(t, root, map[string]any{"path": rel, "baseHash": "x", "text": "pwned\n", "reveal": true})
		if code != http.StatusForbidden || got["error"] != "path not allowed" {
			t.Errorf("%s = %d %v", rel, code, got)
		}
	}
	if readText(t, filepath.Join(root, ".git", "config")) != "[core]\n" || readText(t, filepath.Join(root, "data", "current.txt")) != "1.0.0\n" {
		t.Error("a denied file was written")
	}
	// Readable, but a save would be refused.
	if _, got := fx.get(t, "content", url.Values{"path": {"data/current.txt"}}); got["text"] != "1.0.0\n" || got["notEditable"] != "denied-write" {
		t.Errorf("GET data = %v", got)
	}
	if _, got := fx.get(t, "content", url.Values{"path": {"ok.txt"}}); got["editable"] != true {
		t.Errorf("GET ok = %v", got)
	}
}

func TestFilesWriteKeepsModeAndCRLF(t *testing.T) {
	fx := newFilesFixture(t)
	for _, perm := range []os.FileMode{0o600, 0o755} {
		p := filepath.Join(fx.root, "m.sh")
		os.WriteFile(p, []byte("a\n"), perm)
		os.Chmod(p, perm)
		if code, got := fx.put(t, fx.root, map[string]any{"path": "m.sh", "baseHash": diskHash(t, p), "text": "b\n"}); code != 200 {
			t.Fatalf("%o = %d %v", perm, code, got)
		}
		fi, _ := os.Stat(p)
		if runtime.GOOS != "windows" && fi.Mode().Perm() != perm {
			t.Errorf("mode = %o, want %o", fi.Mode().Perm(), perm)
		}
	}
	p := filepath.Join(fx.root, "crlf.md")
	writeFile(t, p, "---\r\nstatus: review\r\n---\r\n")
	code, got := fx.put(t, fx.root, map[string]any{"path": "crlf.md", "baseHash": diskHash(t, p), "text": "---\nstatus: approved\n---\n"})
	if code != 200 || readText(t, p) != "---\r\nstatus: approved\r\n---\r\n" || got["hash"] != diskHash(t, p) {
		t.Errorf("crlf = %d %v %q", code, got, readText(t, p))
	}
	// CRLF restored past 1 MiB.
	half := strings.Repeat("x\r\n", maxPreviewSize/3)
	writeFile(t, p, half)
	code, got = fx.put(t, fx.root, map[string]any{"path": "crlf.md", "baseHash": diskHash(t, p), "text": strings.Repeat("x\n", maxPreviewSize/3+1)})
	if code != http.StatusRequestEntityTooLarge || got["code"] != "too_large" {
		t.Errorf("crlf > 1MiB = %d %v", code, got)
	}
}

func TestFilesWriteSweepsTemps(t *testing.T) {
	fx := newFilesFixture(t)
	old := filepath.Join(fx.root, editTempPrefix+"0123456789abcdef")
	fresh := filepath.Join(fx.root, editTempPrefix+"fedcba9876543210")
	// Not a name a save creates: a user's file, kept however old
	mine := filepath.Join(fx.root, editTempPrefix+"notes")
	writeFile(t, old, "x")
	writeFile(t, fresh, "x")
	writeFile(t, mine, "x")
	past := time.Now().Add(-time.Hour)
	os.Chtimes(old, past, past)
	os.Chtimes(mine, past, past)
	p := filepath.Join(fx.root, "a.txt")
	if code, got := fx.put(t, fx.root, map[string]any{"path": "a.txt", "baseHash": diskHash(t, p), "text": "z\n"}); code != 200 {
		t.Fatalf("save = %d %v", code, got)
	}
	if _, err := os.Stat(old); !errors.Is(err, os.ErrNotExist) {
		t.Error("old temporary file kept")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("fresh temporary file removed")
	}
	if _, err := os.Stat(mine); err != nil {
		t.Error("a user's file removed")
	}
}

// The file changes between the first read and the rename: nothing is
// written and the temporary file goes.
func TestReplaceFileChanged(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "f"), "agent\n")
	rt, _ := os.OpenRoot(dir)
	defer rt.Close()
	if err := replaceFile(rt, "f", []byte("mine\n"), 0o644, []byte("before\n")); err != errEditChanged {
		t.Errorf("err = %v", err)
	}
	if readText(t, filepath.Join(dir, "f")) != "agent\n" {
		t.Error("written")
	}
	noEditTemps(t, dir)
	if err := replaceFile(rt, "gone", []byte("x"), 0o644, nil); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("gone = %v", err)
	}
	noEditTemps(t, dir)
}

func TestFilesWriteBusy(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.txt"), "a\n")
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: dir, files: true}, hostAllowlist{}, nil)
	for i := 0; i < writeMaxRunning; i++ {
		f.writeSlots <- struct{}{}
	}
	root, _ := filepath.EvalSymlinks(dir)
	path := "/api/mux/panes/0/files/content?root=" + url.QueryEscape(root)
	body := `{"path":"a.txt","baseHash":"` + hashHex([]byte("a\n")) + `","text":"b\n"}`
	// The route alone: no Host allowlist to match an Origin against.
	put := func() *http.Request {
		req := apiRequest("PUT", path, body)
		req.Header.Del("Origin")
		return req
	}
	if code, key := rawCode(t, serve(mux, put())); code != 429 || key != "busy" {
		t.Errorf("busy = %d %q", code, key)
	}
	<-f.writeSlots
	if rec := serve(mux, put()); rec.Code != 200 {
		t.Errorf("free slot = %d %s", rec.Code, rec.Body.String())
	}
	if len(f.writeSlots) != writeMaxRunning-1 {
		t.Errorf("slots held = %d", len(f.writeSlots))
	}
}

func TestTextEditReason(t *testing.T) {
	for in, want := range map[string]struct {
		crlf   bool
		reason string
	}{
		"":             {false, ""},
		"a\nb\n":       {false, ""},
		"a\r\nb\r\n":   {true, ""},
		"a\r\nb\n":     {false, "mixed-eol"},
		"a\rb":         {false, "mixed-eol"},
		"a\r\n\r":      {false, "mixed-eol"},
		"a\x00":        {false, "nul"},
		"no newline":   {false, ""},
		"\r\n":         {true, ""},
		"a\r\r\nb\r\n": {false, "mixed-eol"},
	} {
		crlf, reason := textEditReason([]byte(in))
		if crlf != want.crlf || reason != want.reason {
			t.Errorf("textEditReason(%q) = %v %q, want %v %q", in, crlf, reason, want.crlf, want.reason)
		}
	}
}

func TestEditReasonError(t *testing.T) {
	for reason, want := range map[string]error{
		"not-writable": errEditPermission,
		"other-owner":  errEditPermission,
		"denied-write": errPathNotAllowed,
	} {
		if got := editReasonError(reason); got != want {
			t.Errorf("%s = %v", reason, got)
		}
	}
	var ne *notEditableError
	if err := editReasonError("symlink"); !errors.As(err, &ne) || ne.reason != "symlink" || err.Error() != "file is not editable: symlink" {
		t.Errorf("symlink = %v", err)
	}
}

// A save drops the cached git status of its root: the Changes view reads
// the status right after.
func TestFilesWriteForgetsStatus(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	writeFile(t, filepath.Join(dir, "a.txt"), "a\n")
	f := registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: dir, files: true}, hostAllowlist{}, nil)
	calls := 0
	read := func() {
		f.statuses.do(dir+"\x00.", func() (gitStatus, error) { calls++; return gitStatus{}, nil })
	}
	read()
	read()
	if calls != 1 {
		t.Fatalf("cached reads = %d", calls)
	}
	if _, err := f.writeContent(filesRoot{Root: dir}, writeRequest{Path: "a.txt", BaseHash: hashHex([]byte("a\n")), Text: "b\n"}); err != nil {
		t.Fatal(err)
	}
	read()
	if calls != 2 {
		t.Errorf("reads after a save = %d, want 2", calls)
	}
}

func TestSaveError(t *testing.T) {
	other := errors.New("disk on fire")
	for in, want := range map[error]error{
		&fs.PathError{Op: "write", Path: "x", Err: errDiskFull}:         errStorageFull,
		&fs.PathError{Op: "write", Path: "x", Err: errQuotaFull}:        errStorageFull,
		&fs.PathError{Op: "openat", Path: "x", Err: errReadOnlyMount}:   errReadOnlyFiles,
		&fs.PathError{Op: "renameat", Path: "x", Err: fs.ErrPermission}: errEditPermission,
		other: other,
	} {
		if got := saveError(in); got != want {
			t.Errorf("saveError(%v) = %v, want %v", in, got, want)
		}
	}
}
