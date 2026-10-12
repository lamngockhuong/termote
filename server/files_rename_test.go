package main

import (
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// rename posts files/rename from rel to newPath, plus extra fields.
func (fx *trashFixture) rename(t *testing.T, rel, newPath string, extra map[string]any) (int, map[string]any) {
	t.Helper()
	body := map[string]any{"path": rel, "newPath": newPath}
	for k, v := range extra {
		body[k] = v
	}
	return fx.post(t, "rename", body)
}

func (fx *trashFixture) exists(rel string) bool {
	_, err := os.Lstat(filepath.Join(fx.root, filepath.FromSlash(rel)))
	return err == nil
}

// caseInsensitive reports whether dir's file system ignores case.
func caseInsensitive(t *testing.T, dir string) bool {
	t.Helper()
	p := filepath.Join(dir, "CaseProbe")
	writeFile(t, p, "")
	defer os.Remove(p)
	_, err := os.Stat(filepath.Join(dir, "caseprobe"))
	return err == nil
}

func TestFilesRename(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	if err := os.Chmod(filepath.Join(fx.root, "a.txt"), 0o640); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(filepath.Join(fx.root, "a.txt"))
	// Within its directory
	code, body := fx.rename(t, "a.txt", "b.txt", nil)
	if code != 200 || body["path"] != "b.txt" || body["root"] != fx.root {
		t.Fatalf("rename = %d %v", code, body)
	}
	if fx.exists("a.txt") || readText(t, filepath.Join(fx.root, "b.txt")) != "a\n" {
		t.Error("the file did not move")
	}
	if after, _ := os.Stat(filepath.Join(fx.root, "b.txt")); after.Mode() != before.Mode() {
		t.Errorf("mode = %v, want %v", after.Mode(), before.Mode())
	}
	// Into an existing directory, then one that does not exist yet
	fx.write(t, "sub/keep", "")
	if code, body := fx.rename(t, "b.txt", "sub/b.txt", nil); code != 200 || body["path"] != "sub/b.txt" {
		t.Fatalf("move = %d %v", code, body)
	}
	if code, body := fx.rename(t, "sub/b.txt", "new/deep/c.txt", nil); code != 200 || body["path"] != "new/deep/c.txt" {
		t.Fatalf("move into new dirs = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "new", "deep", "c.txt")) != "a\n" {
		t.Error("the file did not reach new/deep")
	}
	// Back up, with a Windows separator accepted as cleanRelPath takes it
	if code, body := fx.rename(t, "new/deep/c.txt", "c.txt", nil); code != 200 || body["path"] != "c.txt" {
		t.Fatalf("move up = %d %v", code, body)
	}
}

// The same path does nothing, once the file is there.
func TestFilesRenameSamePath(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "sub/a.txt", "a\n")
	if code, body := fx.rename(t, "sub/a.txt", "sub/./a.txt", nil); code != 200 || body["path"] != "sub/a.txt" {
		t.Errorf("same path = %d %v", code, body)
	}
	if code, _ := fx.rename(t, "sub/gone.txt", "sub/gone.txt", nil); code != 404 {
		t.Errorf("same path, missing = %d", code)
	}
	if readText(t, filepath.Join(fx.root, "sub", "a.txt")) != "a\n" {
		t.Error("the file changed")
	}
}

// Never replacing anything: a file, a directory or a dangling symlink at the
// new path is 409 exists with its path, and both stay as they were.
func TestFilesRenameExists(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	fx.write(t, "b.txt", "b\n")
	fx.write(t, "dir/x", "")
	if code, body := fx.rename(t, "a.txt", "b.txt", nil); code != 409 || body["code"] != "exists" || body["path"] != "b.txt" {
		t.Errorf("over a file = %d %v", code, body)
	}
	if code, body := fx.rename(t, "a.txt", "dir", nil); code != 409 || body["code"] != "exists" || body["path"] != "dir" {
		t.Errorf("over a dir = %d %v", code, body)
	}
	if os.Symlink("nowhere", filepath.Join(fx.root, "dangling")) == nil {
		if code, body := fx.rename(t, "a.txt", "dangling", nil); code != 409 || body["code"] != "exists" {
			t.Errorf("over a dangling symlink = %d %v", code, body)
		}
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "a\n" || readText(t, filepath.Join(fx.root, "b.txt")) != "b\n" {
		t.Error("a refused rename changed a file")
	}
	// Another hard link of the same file: exists, the file never moved.
	if os.Link(filepath.Join(fx.root, "a.txt"), filepath.Join(fx.root, "dir", "a.link")) == nil {
		var moves int
		setFindHook(t, &renameMove, func(from *os.Root, fn string, to *os.Root, tn string, fi fs.FileInfo) error {
			moves++
			return renameNoReplaceChecked(from, fn, to, tn, fi)
		})
		if code, body := fx.rename(t, "a.txt", "dir/a.link", nil); code != 409 || body["code"] != "exists" || moves != 0 {
			t.Errorf("onto its own hard link = %d %v, %d moves", code, body, moves)
		}
	}
}

// A new name differing only in case: renamed on a file system that ignores
// case (through a temporary name), a plain rename elsewhere.
func TestFilesRenameCaseOnly(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "Docs/readme.md", "r\n")
	code, body := fx.rename(t, "Docs/readme.md", "Docs/README.md", nil)
	if code != 200 || body["path"] != "Docs/README.md" {
		t.Fatalf("case only = %d %v", code, body)
	}
	names := listNames(t, filepath.Join(fx.root, "Docs"))
	if len(names) != 1 || names[0] != "README.md" {
		t.Errorf("Docs holds %v", names)
	}
	// Only a directory's case differs: nothing is done where case is
	// ignored, a missing directory is made where it counts.
	code, body = fx.rename(t, "Docs/README.md", "docs/README.md", nil)
	if caseInsensitive(t, fx.root) {
		if code != 200 || body["path"] != "Docs/README.md" {
			t.Errorf("directory case = %d %v", code, body)
		}
	} else if code != 200 || body["path"] != "docs/README.md" {
		t.Errorf("directory case = %d %v", code, body)
	}
}

// The second move of a case-only rename fails: the file goes back.
func TestFilesRenameCaseOnlySecondMoveFails(t *testing.T) {
	fx := newTrashFixture(t)
	if !caseInsensitive(t, fx.root) {
		t.Skip("the file system tells case apart")
	}
	fx.write(t, "a.txt", "a\n")
	var n int
	setFindHook(t, &renameMove, func(from *os.Root, fn string, to *os.Root, tn string, fi fs.FileInfo) error {
		if n++; n == 2 {
			return &os.LinkError{Op: "rename", Err: fs.ErrPermission}
		}
		return renameNoReplaceChecked(from, fn, to, tn, fi)
	})
	if code, body := fx.rename(t, "a.txt", "A.txt", nil); code != 403 || body["code"] != "permission" {
		t.Errorf("second move refused = %d %v", code, body)
	}
	if names := listNames(t, fx.root); !containsName(names, "a.txt") || len(tempNames(names)) != 0 {
		t.Errorf("root holds %v", names)
	}
}

// The case-only path, driven on any file system: the file is moved through
// a temporary name, and if moving it back fails too, the client is told
// where it is.
func TestFilesRenameViaTemp(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "sub/a.txt", "a\n")
	open := func() (*os.Root, fs.FileInfo) {
		rt, err := os.OpenRoot(filepath.Join(fx.root, "sub"))
		if err != nil {
			t.Fatal(err)
		}
		fi, _ := rt.Lstat("a.txt")
		return rt, fi
	}
	// Both moves work
	rt, fi := open()
	if err := renameViaTemp(rt, "a.txt", rt, "b.txt", fi, "sub/a.txt", "sub/b.txt"); err != nil {
		t.Fatal(err)
	}
	rt.Close()
	os.Rename(filepath.Join(fx.root, "sub", "b.txt"), filepath.Join(fx.root, "sub", "a.txt"))
	// The first move fails: nothing moved
	setFindHook(t, &renameMove, func(*os.Root, string, *os.Root, string, fs.FileInfo) error {
		return &os.LinkError{Op: "rename", Err: errXDev}
	})
	rt, fi = open()
	if err := renameViaTemp(rt, "a.txt", rt, "b.txt", fi, "sub/a.txt", "sub/b.txt"); err != errRenameCrossDevice {
		t.Errorf("first move = %v", err)
	}
	// The second move fails and so does moving back: the temporary name
	var n int
	setFindHook(t, &renameMove, func(from *os.Root, fn string, to *os.Root, tn string, fi fs.FileInfo) error {
		if n++; n == 2 {
			// Take the old name, so moving back fails
			writeFile(t, filepath.Join(fx.root, "sub", "a.txt"), "other\n")
			return &os.LinkError{Op: "rename", Err: fs.ErrExist}
		}
		return renameNoReplaceChecked(from, fn, to, tn, fi)
	})
	err := renameViaTemp(rt, "a.txt", rt, "b.txt", fi, "sub/a.txt", "sub/b.txt")
	rc, ok := err.(*renameChangedError)
	if !ok || !strings.HasPrefix(rc.path, "sub/"+renameTempPrefix) {
		t.Fatalf("moving back failed = %v", err)
	}
	rt.Close()
	if readText(t, filepath.Join(fx.root, filepath.FromSlash(rc.path))) != "a\n" {
		t.Error("the file is not at the path told")
	}
}

func TestFilesRenameCrossDevice(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	setFindHook(t, &renameMove, func(*os.Root, string, *os.Root, string, fs.FileInfo) error {
		return &os.LinkError{Op: "rename", Err: errXDev}
	})
	if code, body := fx.rename(t, "a.txt", "mnt/a.txt", nil); code != 409 || body["code"] != "cross_device" {
		t.Errorf("cross device = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "a\n" {
		t.Error("cross_device moved the file")
	}
}

// A file swapped in right before the move is moved back, never replacing
// anything: 409 changed. If it cannot go back, the client is told where it is.
func TestFilesRenameChanged(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	swap := func(dir *os.Root, base string) {
		p := filepath.Join(fx.root, base)
		// Kept under another name: a removed file's inode can be given to
		// the new one, which would then pass for the file checked
		if err := os.Rename(p, filepath.Join(fx.root, "old.txt")); err != nil {
			t.Fatal(err)
		}
		writeFile(t, p, "swapped\n")
	}
	setFindHook(t, &renameBeforeMove, swap)
	if code, body := fx.rename(t, "a.txt", "b.txt", nil); code != 409 || body["code"] != "changed" || body["path"] != nil {
		t.Errorf("swapped = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "swapped\n" || fx.exists("b.txt") {
		t.Error("the swapped file did not go back")
	}
	// The old name taken again before moving back: it stays at the new path.
	setFindHook(t, &renameMove, func(from *os.Root, fn string, to *os.Root, tn string, fi fs.FileInfo) error {
		err := renameNoReplaceChecked(from, fn, to, tn, fi)
		writeFile(t, filepath.Join(fx.root, "a.txt"), "third\n")
		return err
	})
	var reads int
	read := func() (gitStatus, error) { reads++; return gitStatus{}, nil }
	fx.f.statuses.do(fx.root+"\x00x", read)
	if code, body := fx.rename(t, "a.txt", "c.txt", nil); code != 409 || body["code"] != "changed" || body["path"] != "c.txt" {
		t.Errorf("swapped, no way back = %d %v", code, body)
	}
	// It moved: the lists see it
	if fx.f.statuses.do(fx.root+"\x00x", read); reads != 2 {
		t.Error("the root's git status was kept")
	}
}

func TestFilesRenameRefused(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	fx.write(t, ".env", "SECRET=1\n")
	fx.write(t, "cfg/secret", "s\n")
	fx.write(t, "data/current", "1\n")
	fx.write(t, ".git/config", "[core]\n")
	fx.write(t, "dir/x", "")
	deep := strings.Repeat("d/", createMaxParts) + "a"
	for _, c := range []struct {
		path, newPath string
		reveal        bool
		want          int
		code          string
	}{
		{"", "b", false, 400, "invalid_path"},
		{".", "b", false, 400, "invalid_path"},
		{"../a.txt", "b", false, 400, "invalid_path"},
		{"a.txt", "", false, 400, "invalid_name"},
		{"a.txt", ".", false, 400, "invalid_name"},
		{"a.txt", "../b", false, 400, "invalid_name"},
		{"a.txt", "b.", false, 400, "invalid_name"},
		{"a.txt", "b ", false, 400, "invalid_name"},
		{"a.txt", "b\nc", false, 400, "invalid_name"},
		{"a.txt", "x//b", false, 400, "invalid_name"},
		{"a.txt", deep, false, 400, "invalid_name"},
		{"a.txt", ".termote-edit-0123456789abcdef", false, 400, "invalid_name"},
		{"a.txt", ".termote-rename-0123456789abcdef", true, 400, "invalid_name"},
		// A directory to make with a name a create refuses
		{"a.txt", "new./b", false, 400, "invalid_name"},
		{"a.txt", "cfg/b", false, 403, "not_allowed"},
		{"cfg/secret", "b", true, 403, "not_allowed"},
		{"data/current", "b", false, 403, "not_allowed"},
		{"a.txt", "data/b", false, 403, "not_allowed"},
		{".git/config", "b", false, 403, "not_allowed"},
		{"a.txt", ".git/b", false, 403, "not_allowed"},
		{".env", "env.txt", false, 403, "sensitive"},
		{"a.txt", "id_rsa", false, 403, "sensitive"},
		{"dir", "dir2", false, 409, "not_file"},
		{"missing.txt", "b", false, 404, ""},
		{"nodir/x.txt", "b", false, 404, ""},
		{"a.txt/x", "b", false, 409, "not_directory"},
		{"a.txt", "a.txt/b", false, 409, "not_directory"},
	} {
		code, body := fx.rename(t, c.path, c.newPath, map[string]any{"reveal": c.reveal})
		if code != c.want || c.code != "" && body["code"] != c.code {
			t.Errorf("%q → %q = %d %v, want %d %s", c.path, c.newPath, code, body, c.want, c.code)
		}
	}
	// A sensitive name on either side goes with reveal.
	if code, body := fx.rename(t, ".env", "env.txt", map[string]any{"reveal": true}); code != 200 {
		t.Errorf(".env with reveal = %d %v", code, body)
	}
	if code, body := fx.rename(t, "env.txt", ".env", map[string]any{"reveal": true}); code != 200 {
		t.Errorf("to .env with reveal = %d %v", code, body)
	}
	// Another user's file
	setFindHook(t, &renameOwnedByServer, func(fs.FileInfo) bool { return false })
	if code, body := fx.rename(t, "a.txt", "b.txt", nil); code != 403 || body["code"] != "permission" {
		t.Errorf("other owner = %d %v", code, body)
	}
	setFindHook(t, &renameOwnedByServer, fileOwnedByServer)
	// Every write slot taken: 429.
	for range writeMaxRunning {
		fx.f.writeSlots <- struct{}{}
	}
	if code, body := fx.rename(t, "a.txt", "b.txt", nil); code != 429 || body["code"] != "busy" {
		t.Errorf("busy = %d %v", code, body)
	}
	for range writeMaxRunning {
		<-fx.f.writeSlots
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "a\n" {
		t.Error("a refused rename moved the file")
	}
}

// A directory already there with a name a create refuses still takes a
// renamed file.
func TestFilesRenameOddExistingDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows drops a trailing space")
	}
	fx := newTrashFixture(t)
	fx.write(t, "notes /a.txt", "a\n")
	if code, body := fx.rename(t, "notes /a.txt", "notes /b.txt", nil); code != 200 || body["path"] != "notes /b.txt" {
		t.Errorf("in an odd dir = %d %v", code, body)
	}
}

// Renames work with no trash, and drop the cached git status and lists.
func TestFilesRenameNoTrashForgetsRoot(t *testing.T) {
	fx := newTrashFixture(t)
	fx.f.trash = nil
	fx.write(t, "a.txt", "a\n")
	var reads int
	read := func() (gitStatus, error) { reads++; return gitStatus{}, nil }
	fx.f.statuses.do(fx.root+"\x00x", read)
	if code, body := fx.rename(t, "a.txt", "b.txt", nil); code != 200 {
		t.Fatalf("rename without trash = %d %v", code, body)
	}
	if fx.f.statuses.do(fx.root+"\x00x", read); reads != 2 {
		t.Error("the root's git status was kept")
	}
}

// Two renames crossing each other never wait on each other.
func TestFilesRenameCrossingLocks(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	fx.write(t, "b.txt", "b\n")
	done := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		for range 20 {
			wg.Add(2)
			go func() { defer wg.Done(); fx.f.lockRenamed(t, "a.txt", "b.txt") }()
			go func() { defer wg.Done(); fx.f.lockRenamed(t, "b.txt", "a.txt") }()
		}
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("crossing renames hung")
	}
}

// lockRenamed takes and drops a rename's locks, waiting for a slot.
func (f *filesAPI) lockRenamed(t *testing.T, a, b string) {
	for {
		unlock, err := f.lockRename("/r", a, b)
		if err == nil {
			unlock()
			return
		}
		time.Sleep(time.Millisecond)
	}
}

func TestFilesRenameGuards(t *testing.T) {
	base := plainDir(t)
	root := filepath.Join(base, "root")
	writeFile(t, filepath.Join(root, "a.txt"), "a\n")
	cfg := testConfig(t)
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	q := "?root=" + url.QueryEscape(root)
	path := "/api/mux/panes/0/files/rename"
	body := `{"path":"a.txt","newPath":"b.txt"}`
	cross := apiRequest("POST", path+q, body)
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	cross.Header.Set("Origin", "https://evil.example")
	form := apiRequest("POST", path+q, body)
	form.Header.Set("Content-Type", "text/plain")
	for name, c := range map[string]struct {
		req  *http.Request
		want int
	}{
		"cross-site":   {cross, http.StatusForbidden},
		"content type": {form, http.StatusUnsupportedMediaType},
		"no root":      {apiRequest("POST", path, body), http.StatusBadRequest},
		"get":          {apiRequest("GET", path+q, ""), http.StatusMethodNotAllowed},
		"bad json":     {apiRequest("POST", path+q, "{"), http.StatusBadRequest},
		"too large":    {apiRequest("POST", path+q, `{"path":"`+strings.Repeat("a", 9<<10)+`"}`), http.StatusBadRequest},
		"root moved":   {apiRequest("POST", path+"?root=/elsewhere", body), http.StatusConflict},
	} {
		if rec := serve(h, c.req); rec.Code != c.want {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body)
		}
	}
	if readText(t, filepath.Join(root, "a.txt")) != "a\n" {
		t.Error("a refused request moved the file")
	}
	if rec := serve(h, apiRequest("POST", path+q, body)); rec.Code != 200 {
		t.Errorf("rename = %d %s", rec.Code, rec.Body)
	}
}

func TestRenameError(t *testing.T) {
	if err := renameError(&os.LinkError{Op: "rename", Err: fs.ErrExist}, "x/b"); err.(*createExistsError).path != "x/b" {
		t.Errorf("exists = %v", err)
	}
	if err := renameError(&os.LinkError{Op: "rename", Err: errXDev}, "b"); err != errRenameCrossDevice {
		t.Errorf("cross device = %v", err)
	}
	if err := renameError(fs.ErrNotExist, "b"); err != fs.ErrNotExist {
		t.Errorf("missing = %v", err)
	}
}

func TestValidRenameTarget(t *testing.T) {
	for p, want := range map[string]bool{
		"a.txt":                                true,
		"notes /a.txt":                         true, // the directory may exist; checked if made
		"a/b/c.md":                             true,
		"a.":                                   false,
		"a ":                                   false,
		"":                                     false,
		"a//b":                                 false,
		"a\x00b":                               false,
		`a\`:                                   false,
		"x/" + "\x01":                          false,
		strings.Repeat("a", 256):               false,
		".termote-rename-0123456789abcdef":     false,
		"x/.termote-edit-0123456789abcdef":     false,
		".termote-rename-0123456789abcdef.txt": true,
	} {
		if got := validRenameTarget(p); got != want {
			t.Errorf("validRenameTarget(%q) = %v, want %v", p, got, want)
		}
	}
	if validCreateName(".termote-rename-0123456789abcdef") {
		t.Error("a create took a rename's temporary name")
	}
	if !isSensitive("/r/" + renameTempPrefix + "0123456789abcdef") {
		t.Error("a rename's temporary file is not sensitive")
	}
}

func listNames(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	return names
}

func containsName(names []string, name string) bool {
	for _, n := range names {
		if n == name {
			return true
		}
	}
	return false
}

func tempNames(names []string) []string {
	var out []string
	for _, n := range names {
		if strings.HasPrefix(n, renameTempPrefix) {
			out = append(out, n)
		}
	}
	return out
}
