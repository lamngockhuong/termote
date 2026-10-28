package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// viewOnlyRepo is a repo whose .gitignore hides secret.log, gen/ and
// hidden.png; link leads to secret.log and linkdir to gen (when this OS
// makes symlinks).
func viewOnlyRepo(t *testing.T) (repo string, links bool) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo = t.TempDir()
	gitInit(t, repo)
	var img bytes.Buffer
	png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 1, 1)))
	for name, data := range map[string][]byte{
		".gitignore":  []byte("secret.log\ngen/\nhidden.png\n"),
		"a.txt":       []byte("hello"),
		"pic.png":     img.Bytes(),
		"hidden.png":  img.Bytes(),
		"secret.log":  []byte("TOKEN=1"),
		"gen/out.txt": []byte("generated"),
		"src/main.go": []byte("package main"),
	} {
		p := filepath.Join(repo, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o700)
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	links = os.Symlink("secret.log", filepath.Join(repo, "link")) == nil &&
		os.Symlink("gen", filepath.Join(repo, "linkdir")) == nil
	gitAdd(t, repo)
	return repo, links
}

// gitAdd stages every file of repo git does not ignore: a view-only client
// sees tracked files only.
func gitAdd(t *testing.T, repo string) {
	t.Helper()
	if out, err := exec.Command("git", "-C", repo, "add", "-A").CombinedOutput(); err != nil {
		t.Fatalf("git add: %v %s", err, out)
	}
}

func fullRequest(path string) *http.Request {
	req := apiRequest("GET", path, "")
	req.Header.Del("Authorization")
	return req
}

func treeNames(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var res treeResponse
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil {
		t.Fatalf("tree: %d %s", rec.Code, rec.Body)
	}
	var names []string
	for _, e := range res.Entries {
		names = append(names, e.Name)
	}
	return "," + strings.Join(names, ",") + ","
}

// A view-only client reads only what git lists as tracked or untracked and
// not ignored, through every read route; a full client reads everything.
func TestViewOnlyFilesSkipIgnored(t *testing.T) {
	repo, links := viewOnlyRepo(t)
	_, h := viewFilesFixture(t, repo)
	const base = "/api/mux/panes/0/files/"

	names := treeNames(t, serve(h, viewRequest("GET", base+"tree", "")))
	for _, hidden := range []string{"secret.log", "gen", "hidden.png"} {
		if strings.Contains(names, ","+hidden+",") {
			t.Errorf("view tree shows %s: %s", hidden, names)
		}
	}
	for _, shown := range []string{"a.txt", "src", ".gitignore", "pic.png"} {
		if !strings.Contains(names, ","+shown+",") {
			t.Errorf("view tree misses %s: %s", shown, names)
		}
	}
	if full := treeNames(t, serve(h, fullRequest(base+"tree"))); !strings.Contains(full, ",secret.log,") || !strings.Contains(full, ",gen,") {
		t.Errorf("full tree: %s", full)
	}

	refused := []string{"content?path=secret.log", "content?path=gen/out.txt", "tree?path=gen", "raw?path=hidden.png"}
	if links {
		refused = append(refused, "content?path=link", "tree?path=linkdir", "content?path=linkdir/out.txt", "diff?path=link&staged=1")
	}
	for _, p := range refused {
		if rec := serve(h, viewRequest("GET", base+p, "")); rec.Code != http.StatusNotFound {
			t.Errorf("view %s: %d %s, want 404", p, rec.Code, rec.Body)
		}
		if rec := serve(h, fullRequest(base+p)); rec.Code != http.StatusOK {
			t.Errorf("full %s: %d %s", p, rec.Code, rec.Body)
		}
	}
	for _, p := range []string{"content?path=a.txt", "content?path=src/main.go", "tree?path=src", "raw?path=pic.png", "diff?path=a.txt&staged=1"} {
		if rec := serve(h, viewRequest("GET", base+p, "")); rec.Code != http.StatusOK {
			t.Errorf("view %s: %d %s", p, rec.Code, rec.Body)
		}
	}

	for _, q := range []string{"secret", "out"} {
		var res findResponse
		json.Unmarshal(serve(h, viewRequest("GET", base+"find?ignored=1&q="+q, "")).Body.Bytes(), &res)
		for _, r := range res.Results {
			if r.Ignored || r.Path == "secret.log" || strings.HasPrefix(r.Path, "gen/") {
				t.Errorf("view find %s: %+v", q, res.Results)
			}
		}
	}
	var res findResponse
	json.Unmarshal(serve(h, fullRequest(base+"find?q=secret&ignored=1")).Body.Bytes(), &res)
	if len(res.Results) == 0 {
		t.Error("full find of an ignored file found nothing")
	}
}

// A list cut short refuses what it does not hold.
func TestViewOnlyFilesIncompleteList(t *testing.T) {
	repo, _ := viewOnlyRepo(t)
	old := findMaxPaths
	findMaxPaths = 1
	t.Cleanup(func() { findMaxPaths = old })
	_, h := viewFilesFixture(t, repo)
	const base = "/api/mux/panes/0/files/"
	shown := 0
	for _, p := range []string{".gitignore", "a.txt", "pic.png", "src/main.go"} {
		if serve(h, viewRequest("GET", base+"content?path="+p, "")).Code == http.StatusOK {
			shown++
		}
		if rec := serve(h, fullRequest(base+"content?path="+p)); rec.Code != http.StatusOK {
			t.Errorf("full %s: %d", p, rec.Code)
		}
	}
	if shown != 1 {
		t.Errorf("view read %d files of a list cut to 1", shown)
	}
}

// A pane in the home dir, or in a repo holding it, shows a view-only client
// nothing; a full one everything.
func TestViewOnlyFilesRefuseHome(t *testing.T) {
	repo, _ := viewOnlyRepo(t)
	_, h := viewFilesFixture(t, repo)
	for _, home := range []string{repo, filepath.Join(repo, "src")} {
		t.Setenv("HOME", home)
		t.Setenv("USERPROFILE", home)
		for _, p := range []string{"tree", "content?path=a.txt", "find?q=a"} {
			assertViewOnly(t, "home "+home+": "+p, serve(h, viewRequest("GET", "/api/mux/panes/0/files/"+p, "")))
		}
		if rec := serve(h, fullRequest("/api/mux/panes/0/files/content?path=a.txt")); rec.Code != http.StatusOK {
			t.Errorf("full in home: %d", rec.Code)
		}
	}
}

// commitAll commits everything in repo.
func commitAll(t *testing.T, repo string) {
	t.Helper()
	for _, args := range [][]string{{"add", "-A"}, {"-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "x"}} {
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Skipf("git %v: %v %s", args, err, out)
		}
	}
}

// A tracked file deleted from the worktree is gone from the list, and git
// status still vouches for it: a view-only client reads its diff. A symlink
// to a tracked directory lists what that directory holds.
func TestViewOnlyFilesDeletedAndLinkedDir(t *testing.T) {
	repo, links := viewOnlyRepo(t)
	commitAll(t, repo)
	if err := os.Remove(filepath.Join(repo, "a.txt")); err != nil {
		t.Fatal(err)
	}
	_, h := viewFilesFixture(t, repo)
	const base = "/api/mux/panes/0/files/"
	if rec := serve(h, viewRequest("GET", base+"diff?path=a.txt", "")); rec.Code != http.StatusOK {
		t.Errorf("view diff of a deleted file: %d %s", rec.Code, rec.Body)
	}
	if !links {
		return
	}
	if err := os.Symlink("src", filepath.Join(repo, "srclink")); err != nil {
		t.Fatal(err)
	}
	gitAdd(t, repo)
	_, h = viewFilesFixture(t, repo)
	if names := treeNames(t, serve(h, viewRequest("GET", base+"tree?path=srclink", ""))); names != ",main.go," {
		t.Errorf("view tree of a link to a tracked dir: %s", names)
	}
}

// holdsHome follows symlinks to the home dir, and counts homeDirs too (the
// container's /workspace holding the host home).
func TestFilesHoldsHome(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	os.MkdirAll(filepath.Join(home, "src"), 0o700)
	link := filepath.Join(root, "link")
	f := &filesAPI{}
	if err := os.Symlink(home, link); err == nil {
		t.Setenv("HOME", link)
		t.Setenv("USERPROFILE", link)
		if !f.holdsHome(home) || !f.holdsHome(root) || f.holdsHome(filepath.Join(home, "src")) {
			t.Error("home behind a symlink")
		}
	}
	t.Setenv("HOME", filepath.Join(root, "elsewhere"))
	t.Setenv("USERPROFILE", filepath.Join(root, "elsewhere"))
	f.homeDirs = []string{home}
	if !f.holdsHome(home) || f.holdsHome(filepath.Join(home, "src")) {
		t.Error("homeDirs not counted")
	}
}

// A view-only client searches what it may read: the files git tracks, never
// through a link to an ignored one, and never makes the server rebuild the
// list.
func TestViewOnlyFilesSearch(t *testing.T) {
	repo, links := viewOnlyRepo(t)
	_, h := viewFilesFixture(t, repo)
	const base = "/api/mux/panes/0/files/search?q="
	search := func(req *http.Request) []string {
		t.Helper()
		rec := serve(h, req)
		return searchPaths(decodeSearch(t, rec.Code, rec.Body.Bytes()))
	}
	if got := search(viewRequest("GET", base+"TOKEN", "")); len(got) != 0 {
		t.Errorf("view search of an ignored file: %q", got)
	}
	// A full client searches no ignored file either, but reads a link to
	// one, as its tree and content do.
	var want []string
	if links {
		want = []string{"link"}
	}
	if got := search(fullRequest(base + "TOKEN")); !slices.Equal(got, want) {
		t.Errorf("full search = %q, want %q", got, want)
	}
	// A link the list holds that leads out of the root is never read
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "o.txt"), "hello outside\n")
	if os.Symlink(filepath.Join(outside, "o.txt"), filepath.Join(repo, "out")) == nil {
		// The full request reads the list again, holding the link
		if got := search(fullRequest(base + "outside&fresh=1")); len(got) != 0 {
			t.Errorf("full search through a link out of the root: %q", got)
		}
		if got := search(viewRequest("GET", base+"outside", "")); len(got) != 0 {
			t.Errorf("view search through a link out of the root: %q", got)
		}
		os.Remove(filepath.Join(repo, "out"))
	}
	if got := search(viewRequest("GET", base+"hello", "")); !slices.Equal(got, []string{"a.txt"}) {
		t.Errorf("view search of a tracked file = %q", got)
	}
	writeFile(t, filepath.Join(repo, "later.txt"), "hello later\n")
	gitAdd(t, repo)
	if got := search(viewRequest("GET", base+"later&fresh=1", "")); len(got) != 0 {
		t.Errorf("view fresh rebuilt the list: %q", got)
	}
	if got := search(fullRequest(base + "later&fresh=1")); !slices.Equal(got, []string{"later.txt"}) {
		t.Errorf("full fresh = %q", got)
	}
	if got := search(viewRequest("GET", base+"later", "")); !slices.Equal(got, []string{"later.txt"}) {
		t.Errorf("view after a full fresh = %q", got)
	}
}

// A file git does not track, not ignored either (a repo under a dotfile dir,
// a secret nobody added), is shown to a full client only: a view-only one
// gets it from no route, and Changes leaves its entry out.
func TestViewOnlyFilesTrackedOnly(t *testing.T) {
	home := t.TempDir()
	repo := filepath.Join(home, ".config", "tool")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	gitInit(t, repo)
	writeFile(t, filepath.Join(repo, "tracked.txt"), "hello tracked\n")
	gitAdd(t, repo)
	writeFile(t, filepath.Join(repo, "token.txt"), "hello untracked\n")
	writeFile(t, filepath.Join(repo, "draft.png"), "not really a png")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	_, h := viewFilesFixture(t, repo)
	const base = "/api/mux/panes/0/files/"

	if names := treeNames(t, serve(h, viewRequest("GET", base+"tree", ""))); strings.Contains(names, "token.txt") || !strings.Contains(names, ",tracked.txt,") {
		t.Errorf("view tree: %s", names)
	}
	if names := treeNames(t, serve(h, fullRequest(base+"tree"))); !strings.Contains(names, ",token.txt,") {
		t.Errorf("full tree: %s", names)
	}
	var found findResponse
	json.Unmarshal(serve(h, viewRequest("GET", base+"find?q=token", "")).Body.Bytes(), &found)
	if len(found.Results) != 0 {
		t.Errorf("view find: %+v", found.Results)
	}
	rec := serve(h, viewRequest("GET", base+"search?q=hello", ""))
	if got := searchPaths(decodeSearch(t, rec.Code, rec.Body.Bytes())); !slices.Equal(got, []string{"tracked.txt"}) {
		t.Errorf("view search = %q", got)
	}
	for _, p := range []string{"content?path=token.txt", "raw?path=draft.png", "document?path=token.txt",
		"diff?path=token.txt", "raw?path=draft.png&side=new"} {
		if rec := serve(h, viewRequest("GET", base+p, "")); rec.Code != http.StatusNotFound {
			t.Errorf("view %s: %d %s, want 404", p, rec.Code, rec.Body)
		}
	}
	if rec := serve(h, fullRequest(base+"diff?path=token.txt")); rec.Code != http.StatusOK {
		t.Errorf("full diff of an untracked file: %d %s", rec.Code, rec.Body)
	}

	changes := func(req *http.Request) []string {
		t.Helper()
		var res changesResponse
		if rec := serve(h, req); rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil {
			t.Fatalf("changes: %d %s", rec.Code, rec.Body)
		}
		var paths []string
		for _, e := range res.Entries {
			paths = append(paths, e.Path)
		}
		slices.Sort(paths)
		return paths
	}
	if got := changes(viewRequest("GET", base+"changes", "")); !slices.Equal(got, []string{"tracked.txt"}) {
		t.Errorf("view changes = %q", got)
	}
	if got := changes(fullRequest(base + "changes")); !slices.Equal(got, []string{"draft.png", "token.txt", "tracked.txt"}) {
		t.Errorf("full changes = %q", got)
	}
}
