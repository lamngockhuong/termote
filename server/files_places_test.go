package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
)

// placeFixture is a server with a pane directory and one Place, notes, in
// a home dir of its own.
type placeFixture struct {
	base, home, pane, place, outside, id string
	h                                    http.Handler
	files                                *filesAPI
}

func newPlaceFixture(t *testing.T, place func(home string) string) *placeFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fx := &placeFixture{base: base, home: filepath.Join(base, "home"), pane: filepath.Join(base, "pane"), outside: filepath.Join(base, "outside")}
	writeFile(t, filepath.Join(fx.pane, "pane.txt"), "pane\n")
	writeFile(t, filepath.Join(fx.outside, "passwd"), "root:x\n")
	writeFile(t, filepath.Join(fx.home, ".ssh", "id_ed25519"), "KEY\n")
	if place == nil {
		place = func(home string) string {
			p := filepath.Join(home, "notes")
			writeFile(t, filepath.Join(p, "todo.md"), "buy milk\n")
			writeFile(t, filepath.Join(p, "sub", "deep.txt"), "needle here\n")
			writeFile(t, filepath.Join(p, ".env"), "TOKEN=x\n")
			return p
		}
	}
	fx.place = place(fx.home)
	fx.id = placeID(fx.place)
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass = true, ""
	cfg.TrashDir = filepath.Join(base, "trash")
	cfg.Places = placeSpecs([]string{fx.place})
	cfg.PlaceEnv = newAllowPathEnv(fx.home, nil, filepath.Join(base, "cfg"))
	m := &filesFakeMux{dir: fx.pane, files: true}
	h, hub, _, err := buildServer(cfg, m)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	fx.h = asRole(h, true)
	// The same files API, for checks below the routes.
	fx.files = registerFilesRoutes(http.NewServeMux(), m, hostAllowlist{}, nil)
	fx.files.setPlaces(buildPlaces(cfg.Places, cfg.PlaceEnv))
	return fx
}

func (fx *placeFixture) q(kv ...string) url.Values {
	q := url.Values{"place": {fx.id}}
	for i := 0; i+1 < len(kv); i += 2 {
		q.Set(kv[i], kv[i+1])
	}
	return q
}

func (fx *placeFixture) get(t *testing.T, route string, q url.Values) (int, string) {
	t.Helper()
	rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/0/files/"+route+"?"+q.Encode(), ""))
	return rec.Code, rec.Body.String()
}

func (fx *placeFixture) post(t *testing.T, method, route string, q url.Values, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	rec := serve(fx.h, apiRequest(method, "/api/mux/panes/0/files/"+route+"?"+q.Encode(), string(b)))
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func errCode(body string) string {
	var b struct{ Code string }
	json.Unmarshal([]byte(body), &b)
	return b.Code
}

func TestPlaceIDAndNames(t *testing.T) {
	if id := placeID("/home/a/notes/"); id != placeID("/home/a/notes") || len(id) != 16 || id == placeID("/home/a/other") {
		t.Fatalf("id %q", id)
	}
	got := placeNames([]string{"/a/work/notes", "/b/home/notes", "/c/docs"})
	if strings.Join(got, "|") != "notes (work)|notes (home)|docs" {
		t.Fatalf("names %q", got)
	}
	specs := placeSpecs([]string{"/a/docs"})
	if len(specs) != 1 || specs[0].ID != placeID("/a/docs") || specs[0].Name != "docs" {
		t.Fatalf("specs %+v", specs)
	}
	env := parsePlacesEnv(`[{"id":"abc","name":"n","path":"/places/abc-n"},{"path":"/places/x"}]`)
	if len(env) != 2 || env[0].ID != "abc" || env[1].Path != "/places/x" {
		t.Fatalf("env %+v", env)
	}
	if parsePlacesEnv("") != nil || parsePlacesEnv("{bad") != nil {
		t.Fatal("bad TERMOTE_PLACES accepted")
	}
	if !slices.Contains(termoteEnvKeys, "TERMOTE_PLACES") {
		t.Fatal("TERMOTE_PLACES not scrubbed from the environment")
	}
}

func TestBuildPlacesSkipsRefused(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(base, "home")
	ok := mkdir(t, filepath.Join(home, "notes"))
	mkdir(t, filepath.Join(home, ".ssh"))
	env := newAllowPathEnv(home, nil)
	env.isGitDir = nil
	got := buildPlaces([]placeSpec{
		{Path: ok},
		{Path: filepath.Join(home, ".ssh")},
		{Path: home},
		{Path: "relative"},
		{Path: filepath.Join(home, "missing")},
		{Path: ok, Name: "dup"}, // same id
		{ID: "given", Name: "N", Path: ok},
	}, env)
	if len(got) != 2 || got[0].ID != placeID(ok) || got[0].Name != "notes" || got[0].Resolved != ok || got[1].ID != "given" || got[1].Name != "N" {
		t.Fatalf("places %+v", got)
	}
	if got := buildPlaces([]placeSpec{{Path: ok}}, allowPathEnv{}); len(got) != 0 {
		t.Fatalf("served without a home dir to check against: %+v", got)
	}
}

func TestPlacesRouteAndCaps(t *testing.T) {
	fx := newPlaceFixture(t, nil)
	rec := serve(fx.h, apiRequest("GET", "/api/mux/files/places", ""))
	var res struct{ Places []placeEntry }
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil || len(res.Places) != 1 ||
		res.Places[0] != (placeEntry{ID: fx.id, Name: "notes", Path: fx.place}) {
		t.Fatalf("places = %d %s", rec.Code, rec.Body)
	}
	if rec := serve(fx.h, apiRequest("POST", "/api/mux/files/places", "{}")); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST places = %d", rec.Code)
	}
	req := apiRequest("GET", "/api/mux/files/places", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(fx.h, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site places = %d", rec.Code)
	}
	snap := serve(fx.h, apiRequest("GET", "/api/mux/snapshot", ""))
	if !strings.Contains(snap.Body.String(), `"places":true`) {
		t.Errorf("caps.places not set: %s", snap.Body)
	}
}

func TestPlaceReadRoutes(t *testing.T) {
	fx := newPlaceFixture(t, nil)
	if runtime.GOOS != "windows" {
		os.Symlink(filepath.Join(fx.outside, "passwd"), filepath.Join(fx.place, "out"))
		os.Symlink(filepath.Join(fx.home, ".ssh"), filepath.Join(fx.place, "keys"))
	}
	code, body := fx.get(t, "tree", fx.q())
	var tree treeResponse
	json.Unmarshal([]byte(body), &tree)
	if code != http.StatusOK || tree.Root != fx.place || tree.IsRepo || !strings.Contains(body, `"todo.md"`) || strings.Contains(body, "pane.txt") {
		t.Fatalf("tree = %d %s", code, body)
	}
	for _, e := range tree.Entries {
		if (e.Name == "out" || e.Name == "keys") && e.Target != "" {
			t.Errorf("%s leads out of the place and shows its target: %+v", e.Name, e)
		}
	}
	// The pane's own root is untouched.
	if code, body := fx.get(t, "tree", nil); code != http.StatusOK || !strings.Contains(body, "pane.txt") {
		t.Errorf("pane tree = %d %s", code, body)
	}
	if code, body := fx.get(t, "content", fx.q("path", "todo.md")); code != http.StatusOK || !strings.Contains(body, "buy milk") {
		t.Errorf("content = %d %s", code, body)
	}
	if code, body := fx.get(t, "content", fx.q("path", ".env")); code == http.StatusOK && strings.Contains(body, "TOKEN") {
		t.Errorf(".env read without reveal: %s", body)
	}
	if code, body := fx.get(t, "find", fx.q("q", "deep")); code != http.StatusOK || !strings.Contains(body, "sub/deep.txt") {
		t.Errorf("find = %d %s", code, body)
	}
	if code, body := fx.get(t, "search", fx.q("q", "needle")); code != http.StatusOK || !strings.Contains(body, "sub/deep.txt") {
		t.Errorf("search = %d %s", code, body)
	}
	if code, body := fx.get(t, "download", fx.q("path", "todo.md")); code != http.StatusOK || body != "buy milk\n" {
		t.Errorf("download = %d %q", code, body)
	}
	if runtime.GOOS != "windows" {
		if code, body := fx.get(t, "content", fx.q("path", "out")); code != http.StatusBadRequest || !strings.Contains(body, "path outside root") {
			t.Errorf("symlink out = %d %s", code, body)
		}
		if code, _ := fx.get(t, "content", fx.q("path", "keys/id_ed25519")); code == http.StatusOK {
			t.Error("~/.ssh read through a link in the place")
		}
	}
}

func TestPlaceRefusals(t *testing.T) {
	fx := newPlaceFixture(t, nil)
	if code, body := fx.get(t, "tree", url.Values{"place": {"0123456789abcdef"}}); code != http.StatusNotFound || errCode(body) != "unknown_place" {
		t.Errorf("unknown place = %d %s", code, body)
	}
	code, body := fx.get(t, "tree", fx.q("root", fx.pane))
	var moved struct{ Root string }
	json.Unmarshal([]byte(body), &moved)
	if code != http.StatusConflict || moved.Root != fx.place {
		t.Errorf("root mismatch = %d %s", code, body)
	}
	for _, route := range []string{"changes", "diff", "commit", "commit/diff", "raw"} {
		q := fx.q("path", "todo.md")
		if route == "raw" {
			q.Set("side", "new")
		}
		if code, body := fx.get(t, route, q); code != http.StatusBadRequest || errCode(body) != "place_not_supported" {
			t.Errorf("%s = %d %s", route, code, body)
		}
	}
	if code, out := fx.post(t, "POST", "changes/apply", fx.q("root", fx.place), map[string]any{"path": "todo.md", "action": "stage"}); code != http.StatusBadRequest || out["code"] != "place_not_supported" {
		t.Errorf("apply = %d %v", code, out)
	}

	// View-only: no place reachable or listed.
	for _, p := range []string{"tree", "content?path=todo.md"} {
		sep := "?"
		if strings.Contains(p, "?") {
			sep = "&"
		}
		assertViewOnly(t, "view "+p, serve(fx.h, viewRequest("GET", "/api/mux/panes/0/files/"+p+sep+"place="+fx.id, "")))
	}
}

func TestPlaceViewOnlyHidden(t *testing.T) {
	fx := newPlaceFixture(t, nil)
	list := serve(fx.h, viewRequest("GET", "/api/mux/files/places", ""))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"places":[]`) {
		t.Errorf("viewer places = %d %s", list.Code, list.Body)
	}
	snap := serve(fx.h, viewRequest("GET", "/api/mux/snapshot", ""))
	if snap.Code != http.StatusOK || strings.Contains(snap.Body.String(), `"places":true`) {
		t.Errorf("caps.places set for a viewer: %d %s", snap.Code, snap.Body)
	}
}

func TestPlaceWriteRoutes(t *testing.T) {
	fixedImageTime(t)
	fx := newPlaceFixture(t, nil)
	root := fx.q("root", fx.place)
	todo := filepath.Join(fx.place, "todo.md")
	if code, out := fx.post(t, "PUT", "content", root, map[string]any{"path": "todo.md", "baseHash": diskHash(t, todo), "text": "buy bread\n"}); code != http.StatusOK || out["root"] != fx.place {
		t.Fatalf("save = %d %v", code, out)
	}
	if readText(t, todo) != "buy bread\n" {
		t.Fatal("save did not reach the place")
	}
	if code, out := fx.post(t, "POST", "create", root, map[string]any{"path": "new/idea.md"}); code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create = %d %v", code, out)
	}
	if !fileExists(filepath.Join(fx.place, "new", "idea.md")) {
		t.Fatal("create did not reach the place")
	}
	if code, out := fx.post(t, "POST", "rename", root, map[string]any{"path": "new/idea.md", "newPath": "idea.md"}); code != http.StatusOK {
		t.Fatalf("rename = %d %v", code, out)
	}
	idea := filepath.Join(fx.place, "idea.md")
	code, out := fx.post(t, "POST", "delete", root, map[string]any{"path": "idea.md", "kind": "file", "baseHash": diskHash(t, idea)})
	if code != http.StatusOK || fileExists(idea) {
		t.Fatalf("delete = %d %v", code, out)
	}
	if code, out := fx.post(t, "POST", "restore", root, map[string]any{"trashId": out["trashId"]}); code != http.StatusOK || !fileExists(idea) {
		t.Fatalf("restore = %d %v", code, out)
	}
	img := testImage(t, "image/png")
	rec := serve(fx.h, imageRequest(fx.place, url.Values{"dir": {"sub"}, "place": {fx.id}}, bytes.NewReader(img), "image/png"))
	if rec.Code != http.StatusCreated || !fileExists(filepath.Join(fx.place, "sub", pastedName+".png")) {
		t.Fatalf("image = %d %s", rec.Code, rec.Body)
	}
	// A view-only client writes nothing, in a place or not.
	b, _ := json.Marshal(map[string]any{"path": "todo.md", "baseHash": diskHash(t, todo), "text": "x"})
	if rec := serve(fx.h, viewRequest("PUT", "/api/mux/panes/0/files/content?"+root.Encode(), string(b))); rec.Code != http.StatusForbidden {
		t.Errorf("view-only save = %d %s", rec.Code, rec.Body)
	}
}

func TestPlaceMovedAfterStart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	old := placeCheckTTL
	placeCheckTTL = 0
	t.Cleanup(func() { placeCheckTTL = old })
	fx := newPlaceFixture(t, func(home string) string {
		real := mkdir(t, filepath.Join(home, "real"))
		writeFile(t, filepath.Join(real, "a.txt"), "a")
		link := filepath.Join(home, "notes")
		if err := os.Symlink(real, link); err != nil {
			t.Fatal(err)
		}
		return link
	})
	if code, body := fx.get(t, "tree", fx.q()); code != http.StatusOK || !strings.Contains(body, "a.txt") {
		t.Fatalf("tree = %d %s", code, body)
	}
	os.Remove(fx.place)
	os.Symlink(filepath.Join(fx.home, ".ssh"), fx.place)
	if code, body := fx.get(t, "tree", fx.q()); code != http.StatusForbidden || errCode(body) != "place_moved" {
		t.Errorf("swapped place = %d %s", code, body)
	}
}

func TestPlaceInsideRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	var repo string
	fx := newPlaceFixture(t, func(home string) string {
		repo = mkdir(t, filepath.Join(home, "repo"))
		gitInit(t, repo)
		writeFile(t, filepath.Join(repo, "docs", "a.md"), "a")
		return filepath.Join(repo, "docs")
	})
	code, body := fx.get(t, "tree", fx.q())
	var tree treeResponse
	json.Unmarshal([]byte(body), &tree)
	if code != http.StatusOK || tree.Root != fx.place || tree.IsRepo {
		t.Fatalf("place in a repo = %d %s", code, body)
	}
	root, err := fx.files.placeRoot(t.Context(), fx.id)
	if err != nil || root.GitDir != filepath.Join(repo, ".git") {
		t.Fatalf("enclosing git dir not kept denied: %+v %v", root, err)
	}

	top := newPlaceFixture(t, func(home string) string {
		r := mkdir(t, filepath.Join(home, "top"))
		gitInit(t, r)
		writeFile(t, filepath.Join(r, "a.md"), "a")
		return r
	})
	code, body = top.get(t, "tree", top.q())
	json.Unmarshal([]byte(body), &tree)
	if code != http.StatusOK || tree.Root != top.place || !tree.IsRepo {
		t.Fatalf("repo place = %d %s", code, body)
	}
}

// A pane's root and a Place inside it share a file's lock and drop each
// other's cached lists.
func TestPlaceOverlapsPaneRoot(t *testing.T) {
	if fileLockKey("/repo", "notes/a.md") != fileLockKey("/repo/notes", "a.md") {
		t.Fatal("lock keys differ for one file")
	}
	fx := newPlaceFixture(t, nil)
	f := fx.files
	f.finds.do(fx.base+"\x00all", func() (findList, error) { return findList{}, nil })
	f.finds.do(fx.place+"\x00all", func() (findList, error) { return findList{}, nil })
	f.finds.do(fx.outside+"\x00all", func() (findList, error) { return findList{}, nil })
	f.forgetRoot(fx.place)
	f.finds.mu.Lock()
	var left []string
	for k := range f.finds.entries {
		left = append(left, k)
	}
	f.finds.mu.Unlock()
	if len(left) != 1 || !strings.HasPrefix(left[0], fx.outside) {
		t.Fatalf("left after a write in the place: %q", left)
	}
	// Two saves of one file, through two roots, never interleave.
	var mu sync.Mutex
	inside := 0
	var wg sync.WaitGroup
	for _, k := range []string{fileLockKey(fx.base, "home/notes/todo.md"), fileLockKey(fx.place, "todo.md")} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			unlock := f.writeLocks.lock(k)
			mu.Lock()
			inside++
			if inside > 1 {
				t.Error("both held the lock")
			}
			mu.Unlock()
			mu.Lock()
			inside--
			mu.Unlock()
			unlock()
		}()
	}
	wg.Wait()
}

func TestKeyDirsDeniedInPaneRoot(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	t.Setenv("HOME", base)
	t.Setenv("USERPROFILE", base)
	writeFile(t, filepath.Join(base, ".ssh", "id_ed25519"), "KEY")
	writeFile(t, filepath.Join(base, ".gnupg", "x"), "K")
	writeFile(t, filepath.Join(base, "a.txt"), "a")
	h, _, _, err := buildServer(testConfig(t), &filesFakeMux{dir: base, files: true})
	if err != nil {
		t.Fatal(err)
	}
	// Listed by name, as every denied dir is, but never opened.
	for _, p := range []string{"tree?path=.ssh", "tree?path=.gnupg", "content?path=.ssh/id_ed25519", "content?path=.gnupg/x"} {
		if rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/"+p, "")); rec.Code != http.StatusForbidden {
			t.Errorf("%s = %d %s", p, rec.Code, rec.Body)
		}
	}
	if rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/content?path=a.txt", "")); rec.Code != http.StatusOK {
		t.Errorf("a.txt = %d %s", rec.Code, rec.Body)
	}
}

func TestTrustRepoPlaces(t *testing.T) {
	rr := newRootResolver(newGitRunner())
	rr.ownedByServer = func(string) bool { return false }
	rr.inContainer = func() bool { return true }
	rr.placeDirs = []string{filepath.FromSlash("/places/ab-notes")}
	if !rr.trustRepo(filepath.FromSlash("/places/ab-notes/sub")) || rr.trustRepo(filepath.FromSlash("/places/other")) {
		t.Fatal("place mounts not trusted as the workspace is")
	}
	rr.inContainer = func() bool { return false }
	if rr.trustRepo(filepath.FromSlash("/places/ab-notes")) {
		t.Fatal("trusted outside the container")
	}
}
