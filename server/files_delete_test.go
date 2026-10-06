package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

// trashFixture is a root behind the files routes with a trash, a deny dir
// (cfg), a dir a write never touches (data) and an upload store (up).
type trashFixture struct {
	root, trashDir string
	f              *filesAPI
	mux            *http.ServeMux
}

func newTrashFixture(t *testing.T) *trashFixture {
	t.Helper()
	base := plainDir(t)
	root := filepath.Join(base, "root")
	trash := filepath.Join(base, "trash")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	up := filepath.Join(root, "up")
	f := registerFilesRoutes(mux, &filesFakeMux{dir: root, files: true}, hostAllowlist{}, []string{filepath.Join(root, "cfg"), up, trash})
	f.writeDeny = filesDenyDirs(filepath.Join(root, "data"), up, trash)
	var err error
	if f.trash, err = newTrashStore(trash); err != nil {
		t.Fatal(err)
	}
	return &trashFixture{root: root, trashDir: trash, f: f, mux: mux}
}

func (fx *trashFixture) trash() *trashStore { return fx.f.trash }

func (fx *trashFixture) trashHas(name string) bool {
	_, err := os.Lstat(filepath.Join(fx.trashDir, name))
	return err == nil
}

// trashNames lists what the trash holds.
func (fx *trashFixture) trashNames(t *testing.T) []string {
	t.Helper()
	ents, err := os.ReadDir(fx.trashDir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	return names
}

func (fx *trashFixture) write(t *testing.T, rel, text string) {
	t.Helper()
	writeFile(t, filepath.Join(fx.root, filepath.FromSlash(rel)), text)
}

func (fx *trashFixture) hash(t *testing.T, rel string) string {
	t.Helper()
	return diskHash(t, filepath.Join(fx.root, filepath.FromSlash(rel)))
}

func (fx *trashFixture) post(t *testing.T, route string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req := apiRequest("POST", "/api/mux/panes/0/files/"+route+"?root="+url.QueryEscape(fx.root), string(b))
	req.Header.Del("Origin")
	rec := serve(fx.mux, req)
	return rec.Code, decodeBody(t, rec)
}

// del deletes the file rel with the hash on the disk, plus extra fields.
func (fx *trashFixture) del(t *testing.T, rel string, extra map[string]any) (int, map[string]any) {
	t.Helper()
	body := map[string]any{"path": rel, "kind": "file", "baseHash": fx.hash(t, rel)}
	for k, v := range extra {
		body[k] = v
	}
	return fx.post(t, "delete", body)
}

func (fx *trashFixture) deleteOK(t *testing.T, rel string) (int, map[string]any) {
	t.Helper()
	code, body := fx.del(t, rel, nil)
	if code != http.StatusOK {
		t.Fatalf("delete %s = %d %v", rel, code, body)
	}
	return code, body
}

func (fx *trashFixture) restore(t *testing.T, id string, reveal bool) (int, map[string]any) {
	t.Helper()
	return fx.post(t, "restore", map[string]any{"trashId": id, "reveal": reveal})
}

func (fx *trashFixture) get(t *testing.T, route string, q url.Values) (int, map[string]any) {
	t.Helper()
	rec := serve(fx.mux, apiRequest("GET", "/api/mux/panes/0/files/"+route+"?"+q.Encode(), ""))
	return rec.Code, decodeBody(t, rec)
}

// setTrashRename replaces trashRename for the test.
func setTrashRename(t *testing.T, fn func(from *os.Root, fromName string, to *os.Root, toName string) error) {
	t.Helper()
	setFindHook(t, &trashRename, fn)
}

func crossDevice(*os.Root, string, *os.Root, string) error {
	return &os.LinkError{Op: "rename", Err: errXDev}
}

func TestFilesDeleteAndRestore(t *testing.T) {
	fx := newTrashFixture(t)
	data := "line one\nline two\n"
	fx.write(t, "dir/a.txt", data)
	code, body := fx.deleteOK(t, "dir/a.txt")
	id, _ := body["trashId"].(string)
	if code != 200 || body["root"] != fx.root || body["path"] != "dir/a.txt" || body["size"] != float64(len(data)) || !trashIDRe.MatchString(id) {
		t.Fatalf("delete = %d %v", code, body)
	}
	notExist(t, filepath.Join(fx.root, "dir", "a.txt"))
	if _, tree := fx.get(t, "tree", url.Values{"path": {"dir"}}); len(tree["entries"].([]any)) != 0 {
		t.Errorf("tree after delete = %v", tree)
	}
	fx.trash().mu.Lock()
	rec, err := fx.trash().readRecordLocked(id)
	fx.trash().mu.Unlock()
	if err != nil || rec.Root != fx.root || rec.Path != "dir/a.txt" || rec.Kind != "file" || rec.Size != int64(len(data)) || time.Since(rec.DeletedAt) > time.Minute {
		t.Errorf("record = %+v %v", rec, err)
	}
	if readText(t, filepath.Join(fx.trashDir, id)) != data {
		t.Error("payload differs")
	}
	// The directory went too: a restore makes it again.
	os.Remove(filepath.Join(fx.root, "dir"))
	code, body = fx.restore(t, id, false)
	if code != 200 || body["root"] != fx.root || body["path"] != "dir/a.txt" {
		t.Fatalf("restore = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "dir", "a.txt")) != data {
		t.Error("restored bytes differ")
	}
	if names := fx.trashNames(t); len(names) != 0 {
		t.Errorf("trash after restore = %v", names)
	}
	// Restored once: nothing left under that id.
	if code, body := fx.restore(t, id, false); code != 404 || body["code"] != "not_in_trash" {
		t.Errorf("second restore = %d %v", code, body)
	}
}

func TestFilesDeleteChanged(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "one\n")
	code, body := fx.post(t, "delete", map[string]any{"path": "a.txt", "kind": "file", "baseHash": hashHex([]byte("old\n"))})
	if code != 409 || body["code"] != "changed" {
		t.Errorf("stale hash = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "one\n" {
		t.Error("file changed")
	}
	// Swapped between the checks and the move: the new file goes back
	// where it was, and the old one is untouched.
	setFindHook(t, &deleteBeforeRename, func(dir *os.Root, base string) {
		os.Rename(filepath.Join(fx.root, "a.txt"), filepath.Join(fx.root, "a.orig"))
		writeFile(t, filepath.Join(fx.root, "a.txt"), "swapped\n")
	})
	if code, body := fx.del(t, "a.txt", nil); code != 409 || body["code"] != "changed" || body["trashId"] != nil {
		t.Errorf("swapped = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "swapped\n" || readText(t, filepath.Join(fx.root, "a.orig")) != "one\n" {
		t.Error("a file was lost")
	}
	if names := fx.trashNames(t); len(names) != 0 {
		t.Errorf("trash = %v", names)
	}
	// Swapped, and the name taken again before the move back: what was
	// moved stays in the trash, and the client gets its id.
	calls := 0
	setTrashRename(t, func(from *os.Root, fromName string, to *os.Root, toName string) error {
		calls++
		err := renameNoReplace(from, fromName, to, toName)
		if calls == 1 {
			writeFile(t, filepath.Join(fx.root, "a.txt"), "third\n")
		}
		return err
	})
	fx.write(t, "a.txt", "fresh\n")
	code, body = fx.del(t, "a.txt", nil)
	id, _ := body["trashId"].(string)
	if code != 409 || body["code"] != "changed" || !trashIDRe.MatchString(id) {
		t.Fatalf("swapped, name taken = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.trashDir, id)) != "swapped\n" || readText(t, filepath.Join(fx.root, "a.txt")) != "third\n" {
		t.Error("files lost")
	}
	// Restoring it never replaces what is there now.
	setTrashRename(t, renameNoReplace)
	if code, body := fx.restore(t, id, false); code != 409 || body["code"] != "exists" || body["path"] != "a.txt" {
		t.Errorf("restore over a file = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "third\n" || !fx.trashHas(id) {
		t.Error("restore replaced a file")
	}
}

func TestFilesDeleteCrossDevice(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "x\n")
	setTrashRename(t, crossDevice)
	if code, body := fx.del(t, "a.txt", nil); code != 409 || body["code"] != "cross_device" {
		t.Errorf("cross device = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "x\n" {
		t.Error("file removed without permanent")
	}
	if names := fx.trashNames(t); len(names) != 0 {
		t.Errorf("trash = %v", names)
	}
	// Confirmed: deleted for good, no Undo.
	code, body := fx.del(t, "a.txt", map[string]any{"permanent": true})
	if code != 200 || body["permanent"] != true || body["trashId"] != nil {
		t.Errorf("permanent = %d %v", code, body)
	}
	notExist(t, filepath.Join(fx.root, "a.txt"))
	// Swapped before the unlink: nothing deleted.
	fx.write(t, "b.txt", "b\n")
	setTrashRename(t, func(*os.Root, string, *os.Root, string) error {
		// Renamed over it: removing it first would let the new file take
		// the freed inode number
		writeFile(t, filepath.Join(fx.root, "b.new"), "other\n")
		os.Rename(filepath.Join(fx.root, "b.new"), filepath.Join(fx.root, "b.txt"))
		return &os.LinkError{Op: "rename", Err: errXDev}
	})
	if code, body := fx.del(t, "b.txt", map[string]any{"permanent": true}); code != 409 || body["code"] != "changed" {
		t.Errorf("swapped before unlink = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "b.txt")) != "other\n" {
		t.Error("swapped file deleted")
	}
	// Gone by the unlink: 404.
	setTrashRename(t, crossDevice)
	setFindHook(t, &deleteBeforeUnlink, func(dir *os.Root, base string) { dir.Remove(base) })
	if code, _ := fx.del(t, "b.txt", map[string]any{"permanent": true}); code != 404 {
		t.Errorf("gone before unlink = %d", code)
	}
	// permanent never skips a trash that works.
	setTrashRename(t, renameNoReplace)
	fx.write(t, "c.txt", "c\n")
	if code, body := fx.del(t, "c.txt", map[string]any{"permanent": true}); code != 200 || body["permanent"] != nil || body["trashId"] == nil {
		t.Errorf("permanent with a trash = %d %v", code, body)
	}
}

func TestFilesRestoreCrossDeviceAndMissing(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	_, body := fx.deleteOK(t, "a.txt")
	id := body["trashId"].(string)
	setFindHook(t, &trashRestore, crossDevice)
	if code, body := fx.restore(t, id, false); code != 409 || body["code"] != "cross_device" {
		t.Errorf("restore across devices = %d %v", code, body)
	}
	setFindHook(t, &trashRestore, renameNoReplace)
	if !fx.trashHas(id) || !fx.trashHas(id+".json") {
		t.Fatal("entry lost")
	}
	// The payload went (by hand): 404, and the record stays for the sweep.
	os.Remove(filepath.Join(fx.trashDir, id))
	if code, body := fx.restore(t, id, false); code != 404 || body["code"] != "not_in_trash" {
		t.Errorf("payload gone = %d %v", code, body)
	}
	for _, bad := range []string{"", "x", strings.Repeat("A", 32), strings.Repeat("0", 31)} {
		if code, _ := fx.restore(t, bad, false); code != 400 {
			t.Errorf("trashId %q = %d", bad, code)
		}
	}
	// A record of another root.
	other := randomHex(16)
	fx.trash().mu.Lock()
	fx.trash().writeRecordLocked(other, trashRecord{Root: "/elsewhere", Path: "x", Kind: "file", DeletedAt: time.Now()})
	// And one whose path is not a local one.
	bad := randomHex(16)
	fx.trash().writeRecordLocked(bad, trashRecord{Root: fx.root, Path: "../x", Kind: "file", DeletedAt: time.Now()})
	fx.trash().mu.Unlock()
	if code, body := fx.restore(t, other, false); code != 409 || body["root"] != fx.root {
		t.Errorf("other root = %d %v", code, body)
	}
	if code, body := fx.restore(t, bad, false); code != 400 || body["code"] != "invalid_path" {
		t.Errorf("bad path = %d %v", code, body)
	}
}

func TestFilesDeleteDir(t *testing.T) {
	fx := newTrashFixture(t)
	empty := filepath.Join(fx.root, "empty")
	if err := os.Mkdir(empty, 0o750); err != nil {
		t.Fatal(err)
	}
	code, body := fx.post(t, "delete", map[string]any{"path": "empty", "kind": "dir"})
	id, _ := body["trashId"].(string)
	if code != 200 || !trashIDRe.MatchString(id) || body["path"] != "empty" {
		t.Fatalf("delete dir = %d %v", code, body)
	}
	notExist(t, empty)
	if fx.trashHas(id) {
		t.Error("a directory has a payload")
	}
	if code, body := fx.restore(t, id, false); code != 200 || body["path"] != "empty" {
		t.Fatalf("restore dir = %d %v", code, body)
	}
	fi, err := os.Stat(empty)
	if err != nil || !fi.IsDir() {
		t.Fatalf("restored dir = %v %v", fi, err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o750&^umask(t) {
		t.Errorf("restored mode = %v", fi.Mode().Perm())
	}
	// Restoring over a directory made since: 409 exists.
	fx.post(t, "delete", map[string]any{"path": "empty", "kind": "dir"})
	code, body = fx.post(t, "delete", map[string]any{"path": "empty2", "kind": "dir"})
	if code != 404 {
		t.Errorf("missing dir = %d %v", code, body)
	}
	fx.write(t, "full/x", "")
	if code, body := fx.post(t, "delete", map[string]any{"path": "full", "kind": "dir"}); code != 409 || body["code"] != "not_empty" {
		t.Errorf("not empty = %d %v", code, body)
	}
	if code, body := fx.post(t, "delete", map[string]any{"path": "full/x", "kind": "dir"}); code != 409 || body["code"] != "not_directory" {
		t.Errorf("file as dir = %d %v", code, body)
	}
	if code, body := fx.post(t, "delete", map[string]any{"path": "full", "kind": "file", "baseHash": "x"}); code != 409 || body["code"] != "not_file" {
		t.Errorf("dir as file = %d %v", code, body)
	}
	// A file swapped in before the rmdir stays.
	if err := os.Mkdir(filepath.Join(fx.root, "swap"), 0o755); err != nil {
		t.Fatal(err)
	}
	setFindHook(t, &deleteBeforeRmdir, func(dir *os.Root, base string) {
		dir.Remove(base)
		writeFile(t, filepath.Join(fx.root, "swap"), "file\n")
	})
	if code, body := fx.post(t, "delete", map[string]any{"path": "swap", "kind": "dir"}); code != 409 || body["code"] != "changed" {
		t.Errorf("swapped dir = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "swap")) != "file\n" {
		t.Error("swapped-in file removed")
	}
	// Gone before the rmdir: 404, no record left.
	if err := os.Mkdir(filepath.Join(fx.root, "gone"), 0o755); err != nil {
		t.Fatal(err)
	}
	setFindHook(t, &deleteBeforeRmdir, func(dir *os.Root, base string) { dir.Remove(base) })
	if code, _ := fx.post(t, "delete", map[string]any{"path": "gone", "kind": "dir"}); code != 404 {
		t.Errorf("gone dir = %d", code)
	}
	for _, n := range fx.trashNames(t) {
		fx.trash().mu.Lock()
		rec, _ := fx.trash().readRecordLocked(strings.TrimSuffix(n, ".json"))
		fx.trash().mu.Unlock()
		if rec.Path == "gone" || rec.Path == "swap" {
			t.Errorf("record of a failed delete: %+v", rec)
		}
	}
	// Restoring a dir when a file took its name.
	setFindHook(t, &deleteBeforeRmdir, func(*os.Root, string) {})
	os.Mkdir(filepath.Join(fx.root, "d2"), 0o755)
	_, body = fx.post(t, "delete", map[string]any{"path": "d2", "kind": "dir"})
	fx.write(t, "d2", "")
	if code, body := fx.restore(t, body["trashId"].(string), false); code != 409 || body["code"] != "exists" || body["path"] != "d2" {
		t.Errorf("restore dir over a file = %d %v", code, body)
	}
}

func umask(t *testing.T) fs.FileMode {
	t.Helper()
	p := filepath.Join(t.TempDir(), "probe")
	if err := os.Mkdir(p, 0o777); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(p)
	return 0o777 &^ fi.Mode().Perm()
}

func TestFilesDeleteRefused(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "a.txt", "a\n")
	fx.write(t, ".env", "SECRET=1\n")
	fx.write(t, "cfg/secret", "s\n")
	fx.write(t, "data/current", "1\n")
	fx.write(t, "up/x.png", "p")
	fx.write(t, ".git/config", "[core]\n")
	fx.write(t, "sub/b.go", "b\n")
	for _, c := range []struct {
		body map[string]any
		want int
		code string
	}{
		{map[string]any{"path": "", "kind": "dir"}, 400, "invalid_path"},
		{map[string]any{"path": ".", "kind": "dir"}, 400, "invalid_path"},
		{map[string]any{"path": "../x", "kind": "file", "baseHash": "x"}, 400, "invalid_path"},
		{map[string]any{"path": "a.txt", "kind": "link"}, 400, ""},
		{map[string]any{"path": "a.txt", "kind": "file"}, 400, ""},
		{map[string]any{"path": "cfg/secret", "kind": "file", "baseHash": "x", "reveal": true}, 403, "not_allowed"},
		{map[string]any{"path": "cfg", "kind": "dir"}, 403, "not_allowed"},
		{map[string]any{"path": "data/current", "kind": "file", "baseHash": "x"}, 403, "not_allowed"},
		{map[string]any{"path": "up/x.png", "kind": "file", "baseHash": "x"}, 403, "not_allowed"},
		{map[string]any{"path": ".git/config", "kind": "file", "baseHash": "x"}, 403, "not_allowed"},
		{map[string]any{"path": ".env", "kind": "file", "baseHash": "x"}, 403, "sensitive"},
		{map[string]any{"path": "missing.txt", "kind": "file", "baseHash": "x"}, 404, ""},
		{map[string]any{"path": "nodir/x.txt", "kind": "file", "baseHash": "x"}, 404, ""},
		{map[string]any{"path": "a.txt/x", "kind": "file", "baseHash": "x"}, 409, "not_directory"},
	} {
		code, body := fx.post(t, "delete", c.body)
		if code != c.want || c.code != "" && body["code"] != c.code {
			t.Errorf("%v = %d %v, want %d %s", c.body, code, body, c.want, c.code)
		}
	}
	// A sensitive file goes with reveal.
	code, body := fx.del(t, ".env", map[string]any{"reveal": true})
	if code != 200 {
		t.Fatalf(".env with reveal = %d %v", code, body)
	}
	if code, body := fx.restore(t, body["trashId"].(string), false); code != 403 || body["code"] != "sensitive" {
		t.Errorf("restore .env without reveal = %d %v", code, body)
	}
	// Several hard links: a delete would only drop one.
	if err := os.Link(filepath.Join(fx.root, "a.txt"), filepath.Join(fx.root, "a.link")); err == nil {
		if code, body := fx.del(t, "a.txt", nil); code != 409 || body["code"] != "hardlink" {
			t.Errorf("hard link = %d %v", code, body)
		}
		os.Remove(filepath.Join(fx.root, "a.link"))
	}
	// Past deleteHashMax: deleted from a terminal.
	setFindHook(t, &deleteHashMax, 1)
	if code, body := fx.del(t, "a.txt", nil); code != 413 || body["code"] != "too_large" {
		t.Errorf("too large = %d %v", code, body)
	}
	setFindHook(t, &deleteHashMax, 512<<20)
	// Every write slot taken: 429.
	for range writeMaxRunning {
		fx.f.writeSlots <- struct{}{}
	}
	if code, body := fx.del(t, "a.txt", nil); code != 429 || body["code"] != "busy" {
		t.Errorf("busy = %d %v", code, body)
	}
	if code, _ := fx.restore(t, strings.Repeat("0", 32), false); code != 404 {
		t.Errorf("restore while busy (unknown id first) = %d", code)
	}
	for range writeMaxRunning {
		<-fx.f.writeSlots
	}
	if readText(t, filepath.Join(fx.root, "a.txt")) != "a\n" {
		t.Error("a refused delete removed the file")
	}
}

func TestFilesDeleteGuards(t *testing.T) {
	base := plainDir(t)
	root := filepath.Join(base, "root")
	writeFile(t, filepath.Join(root, "a.txt"), "a\n")
	cfg := testConfig(t)
	cfg.TrashDir = filepath.Join(base, "trash")
	h, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	q := "?root=" + url.QueryEscape(root)
	body := `{"path":"a.txt","kind":"file","baseHash":"` + hashHex([]byte("a\n")) + `"}`
	for _, route := range []string{"delete", "restore"} {
		path := "/api/mux/panes/0/files/" + route
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
			"root moved":   {apiRequest("POST", path+"?root=/elsewhere", body), http.StatusConflict},
		} {
			if rec := serve(h, c.req); rec.Code != c.want {
				t.Errorf("%s %s = %d %s", route, name, rec.Code, rec.Body)
			}
		}
	}
	if readText(t, filepath.Join(root, "a.txt")) != "a\n" {
		t.Error("a refused request deleted the file")
	}
	// Through the whole server, a delete works.
	if rec := serve(h, apiRequest("POST", "/api/mux/panes/0/files/delete"+q, body)); rec.Code != 200 {
		t.Errorf("delete = %d %s", rec.Code, rec.Body)
	}
}

func TestFilesDeleteTrashUnavailable(t *testing.T) {
	base := plainDir(t)
	root := filepath.Join(base, "root")
	writeFile(t, filepath.Join(root, "a.txt"), "a\n")
	// The trash path is a file: no store, so no deletes.
	blocker := filepath.Join(base, "trash")
	writeFile(t, blocker, "")
	for _, dir := range []string{blocker, ""} {
		cfg := testConfig(t)
		cfg.TrashDir = dir
		h, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
		if err != nil {
			t.Fatal(err)
		}
		for _, route := range []string{"delete", "restore"} {
			rec := serve(h, apiRequest("POST", "/api/mux/panes/0/files/"+route+"?root="+url.QueryEscape(root), `{"path":"a.txt","kind":"file","baseHash":"x","trashId":"x"}`))
			if rec.Code != 503 || decodeBody(t, rec)["code"] != "trash_unavailable" {
				t.Errorf("%q %s = %d", dir, route, rec.Code)
			}
		}
		rec := serve(h, apiRequest("GET", "/api/mux/snapshot", ""))
		if caps := decodeBody(t, rec)["caps"].(map[string]any); caps["trash"] != false {
			t.Errorf("caps without a trash = %v", caps)
		}
	}
	cfg := testConfig(t)
	cfg.TrashDir = filepath.Join(base, "ok")
	h, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	rec := serve(h, apiRequest("GET", "/api/mux/snapshot", ""))
	if caps := decodeBody(t, rec)["caps"].(map[string]any); caps["trash"] != true {
		t.Errorf("caps with a trash = %v", caps)
	}
}

// A file named "create" at the root has the lock key the root's lock once
// had: deleting and restoring it must not take the same mutex twice.
func TestFilesDeleteFileNamedCreate(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "create", "c\n")
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, body := fx.deleteOK(t, "create")
		if code, _ := fx.restore(t, body["trashId"].(string), false); code != 200 {
			t.Errorf("restore = %d", code)
		}
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("delete of a file named create hangs")
	}
}

// The trash and the upload store never show through the Files view, even
// when a pane's root is the home dir that holds them.
func TestFilesTrashNeverServed(t *testing.T) {
	home := plainDir(t)
	cache := filepath.Join(home, ".cache", "termote")
	writeFile(t, filepath.Join(home, "notes.txt"), "n\n")
	writeFile(t, filepath.Join(cache, "uploads", "0123.png"), "png")
	cfg := testConfig(t)
	cfg.UploadDir = filepath.Join(cache, "uploads")
	cfg.TrashDir = filepath.Join(cache, "trash")
	h, _, err := buildServer(cfg, &filesFakeMux{dir: home, files: true})
	if err != nil {
		t.Fatal(err)
	}
	fx := &findFixture{root: home, h: h}
	q := "?root=" + url.QueryEscape(home)
	body := `{"path":".env","kind":"file","baseHash":"` + hashHex([]byte("SECRET=1\n")) + `","reveal":true}`
	writeFile(t, filepath.Join(home, ".env"), "SECRET=1\n")
	rec := serve(h, apiRequest("POST", "/api/mux/panes/0/files/delete"+q, body))
	if rec.Code != 200 {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body)
	}
	id := decodeBody(t, rec)["trashId"].(string)
	for _, p := range []string{".cache/termote/trash", ".cache/termote/trash/" + id, ".cache/termote/trash/" + id + ".json", ".cache/termote/uploads/0123.png"} {
		for _, route := range []string{"tree", "content"} {
			rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/"+route+"?path="+url.QueryEscape(p), ""))
			if rec.Code != http.StatusForbidden {
				t.Errorf("%s %s = %d %s", route, p, rec.Code, rec.Body)
			}
		}
	}
	for _, q := range []string{id, "0123", "png", "json"} {
		if _, by := fx.findOK(t, url.Values{"q": {q}}); len(by) != 0 {
			t.Errorf("find %s = %v", q, by)
		}
	}
}

func TestFilesContentHash(t *testing.T) {
	fx := newTrashFixture(t)
	bin := []byte("\x89PNG\r\n\x1a\n\x00\x00binary")
	writeFile(t, filepath.Join(fx.root, "img.png"), string(bin))
	fx.write(t, ".env", "SECRET=1\n")
	sum := sha256.Sum256(bin)
	code, body := fx.get(t, "content", url.Values{"path": {"img.png"}, "hash": {"1"}})
	if code != 200 || body["hash"] != hex.EncodeToString(sum[:]) || body["size"] != float64(len(bin)) || body["path"] != "img.png" || body["text"] != nil {
		t.Errorf("binary hash = %d %v", code, body)
	}
	// Without hash=1 a binary file is not hashed.
	if _, body := fx.get(t, "content", url.Values{"path": {"img.png"}}); body["hash"] != nil {
		t.Errorf("no hash=1 = %v", body)
	}
	// A sensitive file's hash, never its contents.
	_, body = fx.get(t, "content", url.Values{"path": {".env"}, "hash": {"1"}})
	if body["hash"] != hashHex([]byte("SECRET=1\n")) || body["text"] != nil {
		t.Errorf(".env hash = %v", body)
	}
	// A directory or a file past deleteHashMax has no hash.
	os.Mkdir(filepath.Join(fx.root, "d"), 0o755)
	if _, body := fx.get(t, "content", url.Values{"path": {"d"}, "hash": {"1"}}); body["hash"] != nil {
		t.Errorf("dir hash = %v", body)
	}
	setFindHook(t, &deleteHashMax, 4)
	if _, body := fx.get(t, "content", url.Values{"path": {"img.png"}, "hash": {"1"}}); body["hash"] != nil || body["size"] != float64(len(bin)) {
		t.Errorf("too large = %v", body)
	}
	// The size grew past the limit after the stat.
	setFindHook(t, &deleteHashMax, int64(len(bin)))
	writeFile(t, filepath.Join(fx.root, "grow"), string(bin))
	if _, body := fx.get(t, "content", url.Values{"path": {"grow"}, "hash": {"1"}}); body["hash"] == nil {
		t.Errorf("at the limit = %v", body)
	}
	for q, want := range map[string]int{"cfg/x": 403, "missing": 404, "../x": 400} {
		fx.write(t, "cfg/x", "")
		if code, _ := fx.get(t, "content", url.Values{"path": {q}, "hash": {"1"}}); code != want {
			t.Errorf("%s = %d, want %d", q, code, want)
		}
	}
	for range rawMaxRunning {
		fx.f.rawSlots <- struct{}{}
	}
	if code, body := fx.get(t, "content", url.Values{"path": {"img.png"}, "hash": {"1"}}); code != 429 || body["code"] != "busy" {
		t.Errorf("busy = %d %v", code, body)
	}
}

// A payload whose mtime is a month old was deleted just now: the next
// delete's sweep keeps it, and Undo works.
func TestFilesDeleteKeepsOldMtime(t *testing.T) {
	fx := newTrashFixture(t)
	fx.write(t, "old.txt", "old\n")
	month := time.Now().Add(-30 * 24 * time.Hour)
	os.Chtimes(filepath.Join(fx.root, "old.txt"), month, month)
	_, body := fx.deleteOK(t, "old.txt")
	fx.write(t, "next.txt", "n\n")
	fx.deleteOK(t, "next.txt")
	if code, _ := fx.restore(t, body["trashId"].(string), false); code != 200 {
		t.Errorf("restore = %d", code)
	}
}

// Error mapping for what the OS says.
func TestDeleteError(t *testing.T) {
	if deleteError(&fs.PathError{Err: fs.ErrNotExist}) == nil {
		t.Error("not exist")
	}
	if err := restoreError(&os.LinkError{Err: fs.ErrNotExist}); err != errNotInTrash {
		t.Errorf("restore not exist = %v", err)
	}
	if err := restoreError(&os.LinkError{Err: errXDev}); err != errCrossDevice {
		t.Errorf("restore xdev = %v", err)
	}
	if err := restoreError(&os.LinkError{Err: fs.ErrExist}); err != errCreateExists {
		t.Errorf("restore exists = %v", err)
	}
	if err := deleteError(&fs.PathError{Err: fs.ErrPermission}); err != errEditPermission {
		t.Errorf("permission = %v", err)
	}
}

// Steps that fail on the disk, or a record taken by another restore.
func TestFilesDeleteEdgeFailures(t *testing.T) {
	if (&deleteChangedError{"x"}).Error() != errEditChanged.msg {
		t.Error("deleteChangedError message")
	}
	fx := newTrashFixture(t)
	// The root went away after its checks.
	gone := filesRoot{Root: filepath.Join(plainDir(t), "gone")}
	if _, err := fx.f.deleteFile(gone, deleteRequest{Path: "a", Kind: "dir"}); err == nil {
		t.Error("delete in a missing root")
	}
	if _, err := fx.f.contentHash(gone, "a"); err == nil {
		t.Error("hash in a missing root")
	}
	// Swapped between the check and the open.
	fx.write(t, "a.txt", "a\n")
	setFindHook(t, &deleteBeforeOpen, func(dir *os.Root, base string) {
		// Renamed over it, so the new file never reuses the old inode
		writeFile(t, filepath.Join(fx.root, "a.new"), "b\n")
		os.Rename(filepath.Join(fx.root, "a.new"), filepath.Join(fx.root, "a.txt"))
	})
	if code, body := fx.del(t, "a.txt", nil); code != 409 || body["code"] != "changed" {
		t.Errorf("swapped before open = %d %v", code, body)
	}
	setFindHook(t, &deleteBeforeOpen, func(*os.Root, string) {})
	// The parent of a restore is now a file.
	fx.write(t, "sub/b.go", "b\n")
	_, body := fx.deleteOK(t, "sub/b.go")
	id := body["trashId"].(string)
	os.Remove(filepath.Join(fx.root, "sub"))
	fx.write(t, "sub", "")
	if code, body := fx.restore(t, id, false); code != 409 || body["code"] != "not_directory" {
		t.Errorf("parent is a file = %d %v", code, body)
	}
	os.Remove(filepath.Join(fx.root, "sub"))
	// Every write slot taken: a restore of a real entry gets 429.
	for range writeMaxRunning {
		fx.f.writeSlots <- struct{}{}
	}
	if code, body := fx.restore(t, id, false); code != 429 || body["code"] != "busy" {
		t.Errorf("restore busy = %d %v", code, body)
	}
	for range writeMaxRunning {
		<-fx.f.writeSlots
	}
	// Restored by another request while this one waited for the locks.
	setFindHook(t, &restoreBeforeLock, func() { os.Remove(filepath.Join(fx.trashDir, id+".json")) })
	if code, body := fx.restore(t, id, false); code != 404 || body["code"] != "not_in_trash" {
		t.Errorf("record gone meanwhile = %d %v", code, body)
	}
	setFindHook(t, &restoreBeforeLock, func() {})
	// A record naming a denied path is never restored there.
	denied := randomHex(16)
	fx.trash().mu.Lock()
	fx.trash().writeRecordLocked(denied, trashRecord{Root: fx.root, Path: "cfg/x", Kind: "file", DeletedAt: time.Now()})
	fx.trash().mu.Unlock()
	if code, body := fx.restore(t, denied, false); code != 403 || body["code"] != "not_allowed" {
		t.Errorf("denied record = %d %v", code, body)
	}
	// The root of a record went away after its checks.
	lost := randomHex(16)
	fx.trash().mu.Lock()
	fx.trash().writeRecordLocked(lost, trashRecord{Root: gone.Root, Path: "x", Kind: "file", DeletedAt: time.Now()})
	fx.trash().mu.Unlock()
	if _, err := fx.f.restoreFile(gone, restoreRequest{TrashID: lost}); err == nil {
		t.Error("restore in a missing root")
	}
	// The trash went away: the record cannot be written.
	os.RemoveAll(fx.trashDir)
	fx.write(t, "c.txt", "c\n")
	if code, body := fx.del(t, "c.txt", nil); code != 503 || body["code"] != "trash_unavailable" {
		t.Errorf("delete without a trash dir = %d %v", code, body)
	}
	os.Mkdir(filepath.Join(fx.root, "e"), 0o755)
	if code, _ := fx.post(t, "delete", map[string]any{"path": "e", "kind": "dir"}); code != 503 {
		t.Errorf("rmdir without a trash dir = %d", code)
	}
	if readText(t, filepath.Join(fx.root, "c.txt")) != "c\n" {
		t.Error("file lost")
	}
}
