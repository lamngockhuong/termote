package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// findFixture serves the files routes for one pane directory.
type findFixture struct {
	root string
	h    http.Handler
}

func newFindFixture(t *testing.T, root string, deny ...string) *findFixture {
	t.Helper()
	cfg := testConfig(t)
	cfg.FilesDenyDirs = deny
	h, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	return &findFixture{root: root, h: h}
}

func (fx *findFixture) find(t *testing.T, q url.Values) (int, map[string]any) {
	t.Helper()
	rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/0/files/find?"+q.Encode(), ""))
	return rec.Code, decodeBody(t, rec)
}

// findOK runs a find that must succeed and returns its results by path.
func (fx *findFixture) findOK(t *testing.T, q url.Values) (map[string]any, map[string]map[string]any) {
	t.Helper()
	code, body := fx.find(t, q)
	if code != http.StatusOK {
		t.Fatalf("find %v = %d %v", q, code, body)
	}
	by := map[string]map[string]any{}
	for _, r := range body["results"].([]any) {
		m := r.(map[string]any)
		by[m["path"].(string)] = m
	}
	return body, by
}

// setFindHook replaces a test hook of find for the test.
func setFindHook[T any](t *testing.T, p *T, v T) {
	t.Helper()
	old := *p
	*p = v
	t.Cleanup(func() { *p = old })
}

// neverReads fails the test when a walk reads a directory named name.
func neverReads(t *testing.T, name string) {
	t.Helper()
	setFindHook(t, &findBeforeReadDir, func(dir string) {
		if slices.Contains(strings.Split(dir, "/"), name) {
			t.Errorf("walk read %s", dir)
		}
	})
}

func plainDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

const nodeModules = "node_modules"

func TestParseFindQuery(t *testing.T) {
	in, err := parseFindQuery(url.Values{"q": {"  main  "}, "ignored": {"1"}, "fresh": {"1"}, "exclude": {"vendor", "dist", "vendor"}})
	if err != nil || in.q != "main" || !in.ignored || !in.fresh || in.excludeKey != "dist\x00vendor" || !in.excludes.has("dist") {
		t.Fatalf("parse = %+v, %v", in, err)
	}
	if in, _ := parseFindQuery(url.Values{"q": {"x"}}); in.ignored || in.fresh || in.excludeKey != "" {
		t.Errorf("defaults = %+v", in)
	}
	for _, v := range []url.Values{{}, {"q": {"   "}}} {
		if _, err := parseFindQuery(v); err != errFindQueryRequired {
			t.Errorf("%v: %v", v, err)
		}
	}
	if _, err := parseFindQuery(url.Values{"q": {strings.Repeat("x", findMaxQuery+1)}}); err != errFindQueryTooLong {
		t.Errorf("long q: %v", err)
	}
	many := make([]string, findMaxExcludes+1)
	for i := range many {
		many[i] = fmt.Sprint("d", i)
	}
	if _, err := parseFindQuery(url.Values{"q": {"x"}, "exclude": many}); err != errFindInvalidExclude {
		t.Errorf("too many excludes: %v", err)
	}
	for _, bad := range []string{"", ".", "..", "a/b", `a\b`, "a\x00", "*.js", "a?", "[x]", strings.Repeat("x", createMaxName+1)} {
		if _, err := parseFindQuery(url.Values{"q": {"x"}, "exclude": {bad}}); err != errFindInvalidExclude {
			t.Errorf("exclude %q: %v", bad, err)
		}
	}
}

func TestFindFilterAndSplit(t *testing.T) {
	if got := splitNul([]byte("a\x00b\x00par")); !slices.Equal(got, []string{"a", "b"}) {
		t.Errorf("cut = %q", got)
	}
	if got := splitNul([]byte("a\x00")); !slices.Equal(got, []string{"a"}) {
		t.Errorf("whole = %q", got)
	}
	root := plainDir(t)
	f := &filesAPI{deny: []string{filepath.Join(root, "cfg"), filepath.Join(filepath.Dir(root), "elsewhere")}}
	ff := f.newFindFilter(filesRoot{Root: root, GitDir: filepath.Join(root, "meta")})
	for rel, want := range map[string]bool{
		"a.go": false, "cfg": true, "cfg/x": true, "cfgx/y": false, "meta/HEAD": true,
		".git/config": true, "sub/.GIT/x": true, "src/cfg/x": false,
	} {
		if got := ff.skip(rel); got != want {
			t.Errorf("skip(%q) = %v, want %v", rel, got, want)
		}
	}
	// A root inside a deny dir lists nothing.
	f = &filesAPI{deny: []string{filepath.Dir(root)}}
	if !f.newFindFilter(filesRoot{Root: root}).skip("a.go") {
		t.Error("root under a deny dir")
	}
}

func TestFilesFindRepo(t *testing.T) {
	requireGit(t)
	r := newTestRepo(t)
	writeFile(t, filepath.Join(r, ".gitignore"), nodeModules+"/\nplans/\n*.log\nvendor/\n")
	writeFile(t, filepath.Join(r, "src", "deep", "er", "main.go"), "package main\n")
	writeFile(t, filepath.Join(r, "vendor", "lib", "main_vendor.go"), "package lib\n")
	writeFile(t, filepath.Join(r, "gone.txt"), "x\n")
	gitT(t, r, "add", "-f", ".")
	gitT(t, r, "commit", "-q", "-m", "files")
	os.Remove(filepath.Join(r, "gone.txt"))
	writeFile(t, filepath.Join(r, "untracked_main.txt"), "u\n")
	writeFile(t, filepath.Join(r, "plans", "p1", "main-plan.md"), "p\n")
	writeFile(t, filepath.Join(r, "src", "main.log"), "l\n")
	writeFile(t, filepath.Join(r, nodeModules, "pkg", "main.js"), "m\n")
	writeFile(t, filepath.Join(r, "vendor", "untracked_main.go"), "v\n")
	writeFile(t, filepath.Join(r, ".env.main"), "SECRET=1\n")
	// An untracked nested repo and a submodule: git lists directories.
	nested := filepath.Join(r, "nested_main")
	gitT(t, filepath.Dir(nested), "init", "-q", nested)
	writeFile(t, filepath.Join(nested, "inner_main.go"), "x\n")
	sm := filepath.Join(r, "sub_main")
	gitT(t, filepath.Dir(sm), "init", "-q", sm)
	writeFile(t, filepath.Join(sm, "f"), "x\n")
	gitT(t, sm, "add", ".")
	gitT(t, sm, "commit", "-q", "-m", "s")
	head := strings.TrimSpace(gitT(t, sm, "rev-parse", "HEAD"))
	gitT(t, r, "update-index", "--add", "--cacheinfo", "160000,"+head+",sub_main")

	fx := newFindFixture(t, r)
	body, by := fx.findOK(t, url.Values{"q": {"main"}})
	if body["root"] != r || body["isRepo"] != true || body["truncated"] != false || body["incomplete"] != false {
		t.Errorf("header = %v", body)
	}
	got := slices.Sorted(func(yield func(string) bool) {
		for p := range by {
			if !yield(p) {
				return
			}
		}
	})
	// Tracked (vendor/ too, though ignored and excludable) and untracked
	// files; not ignored ones, directories or files gone from the disk.
	want := []string{".env.main", "src/deep/er/main.go", "untracked_main.txt", "vendor/lib/main_vendor.go"}
	if !slices.Equal(got, want) {
		t.Errorf("toggle off = %q\nwant %q", got, want)
	}
	if by[".env.main"]["sensitive"] != true || by["untracked_main.txt"]["sensitive"] != false || by["untracked_main.txt"]["ignored"] != false {
		t.Errorf("flags = %v %v", by[".env.main"], by["untracked_main.txt"])
	}
	if _, by := fx.findOK(t, url.Values{"q": {"gone"}}); len(by) != 0 {
		t.Errorf("deleted file found: %v", by)
	}

	// Ignored on: plans/ is searched, an excluded node_modules never read.
	neverReads(t, nodeModules)
	q := url.Values{"q": {"main"}, "ignored": {"1"}, "exclude": {nodeModules, "vendor"}}
	_, by = fx.findOK(t, q)
	for _, p := range []string{"plans/p1/main-plan.md", "src/main.log"} {
		if by[p] == nil || by[p]["ignored"] != true {
			t.Errorf("%s = %v", p, by[p])
		}
	}
	for _, p := range []string{nodeModules + "/pkg/main.js", "vendor/untracked_main.go"} {
		if by[p] != nil {
			t.Errorf("excluded %s found", p)
		}
	}
	if by["vendor/lib/main_vendor.go"] == nil {
		t.Error("tracked file under an excluded name not found")
	}
	// Without the exclusion the ignored tree is walked.
	setFindHook(t, &findBeforeReadDir, func(string) {})
	if _, by = fx.findOK(t, url.Values{"q": {"main"}, "ignored": {"1"}}); by[nodeModules+"/pkg/main.js"] == nil || by["vendor/untracked_main.go"] == nil {
		t.Errorf("not excluded = %v", by)
	}
}

func TestFilesFindDenied(t *testing.T) {
	requireGit(t)
	root := plainDir(t)
	gitT(t, root, "init", "-q", "--separate-git-dir="+filepath.Join(root, "meta"))
	writeFile(t, filepath.Join(root, "x_conf.txt"), "x\n")
	writeFile(t, filepath.Join(root, "cfg", "x_conf_secret"), "s\n")
	gitT(t, root, "add", "x_conf.txt")
	gitT(t, root, "commit", "-q", "-m", "x")
	deny := filepath.Join(root, "cfg")
	fx := newFindFixture(t, root, deny)
	for _, q := range []url.Values{{"q": {"conf"}}, {"q": {"conf"}, "ignored": {"1"}}, {"q": {"config"}}, {"q": {"HEAD"}}} {
		_, by := fx.findOK(t, q)
		for p := range by {
			if p != "x_conf.txt" {
				t.Errorf("%v: %s served", q, p)
			}
		}
	}
	// Outside a repo: .git and a deny dir are never walked.
	plain := plainDir(t)
	writeFile(t, filepath.Join(plain, ".git", "config_x"), "c\n")
	writeFile(t, filepath.Join(plain, "cfg", "config_y"), "c\n")
	writeFile(t, filepath.Join(plain, "config_z"), "c\n")
	want := 1
	if runtime.GOOS != "windows" {
		// A link into a deny dir is listed by the walk, never sent.
		if err := os.Symlink("cfg/config_y", filepath.Join(plain, "config_link")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("config_z", filepath.Join(plain, "config_ok")); err != nil {
			t.Fatal(err)
		}
		want = 2
	}
	fx = newFindFixture(t, plain, filepath.Join(plain, "cfg"))
	neverReads(t, ".git")
	if _, by := fx.findOK(t, url.Values{"q": {"config"}}); len(by) != want || by["config_z"] == nil {
		t.Errorf("plain = %v", by)
	}
}

func TestFilesFindOutsideRepo(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, "a", "b", "c", "d", "e", "f", "deep_hit.go"), "x\n")
	writeFile(t, filepath.Join(root, nodeModules, "hit.js"), "x\n")
	writeFile(t, filepath.Join(root, "sub", "hit.txt"), "x\n")
	if runtime.GOOS != "windows" {
		if err := os.Symlink("sub", filepath.Join(root, "dirlink")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("sub/hit.txt", filepath.Join(root, "filelink_hit")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("missing", filepath.Join(root, "broken_hit")); err != nil {
			t.Fatal(err)
		}
	}
	fx := newFindFixture(t, root)
	neverReads(t, nodeModules)
	body, by := fx.findOK(t, url.Values{"q": {"hit"}, "exclude": {nodeModules}, "ignored": {"1"}})
	want := []string{"a/b/c/d/e/f/deep_hit.go", "sub/hit.txt"}
	if runtime.GOOS != "windows" {
		want = append(want, "filelink_hit")
	}
	if len(by) != len(want) || body["isRepo"] != false || body["incomplete"] != false {
		t.Errorf("results = %v, want %q", by, want)
	}
	for _, p := range want {
		if by[p] == nil || by[p]["ignored"] != false {
			t.Errorf("%s = %v", p, by[p])
		}
	}
}

func TestFilesFindLimits(t *testing.T) {
	root := plainDir(t)
	for i := range findMaxResults + 1 {
		writeFile(t, filepath.Join(root, fmt.Sprintf("hit%03d.txt", i)), "")
	}
	fx := newFindFixture(t, root)
	body, by := fx.findOK(t, url.Values{"q": {"hit"}})
	if len(by) != findMaxResults || body["truncated"] != true || body["incomplete"] != false || by["hit000.txt"] == nil {
		t.Errorf("201 matches = %d truncated=%v", len(by), body["truncated"])
	}
	// Past findMaxPaths the list stops and says so.
	setFindHook(t, &findMaxPaths, 10)
	body, by = fx.findOK(t, url.Values{"q": {"hit"}, "fresh": {"1"}})
	if len(by) != 10 || body["incomplete"] != true || body["truncated"] != false {
		t.Errorf("max paths = %d %v", len(by), body)
	}
	setFindHook(t, &findMaxPaths, 1000)
	// Too deep, and out of time.
	deep := plainDir(t)
	writeFile(t, filepath.Join(deep, "a", "b", "c", "hit.txt"), "")
	writeFile(t, filepath.Join(deep, "hit.txt"), "")
	fx = newFindFixture(t, deep)
	setFindHook(t, &findMaxDepth, 2)
	if body, by := fx.findOK(t, url.Values{"q": {"hit"}}); len(by) != 1 || body["incomplete"] != true {
		t.Errorf("depth = %v %v", by, body)
	}
	setFindHook(t, &findMaxDepth, 32)
	setFindHook(t, &findWalkTimeout, 0)
	if body, by := fx.findOK(t, url.Values{"q": {"hit"}, "fresh": {"1"}}); len(by) != 0 || body["incomplete"] != true {
		t.Errorf("timeout = %v %v", by, body)
	}
}

func TestFilesFindRepoLimits(t *testing.T) {
	requireGit(t)
	r := newTestRepo(t)
	writeFile(t, filepath.Join(r, ".gitignore"), "ign/\n")
	for i := range 5 {
		writeFile(t, filepath.Join(r, fmt.Sprintf("t%d.txt", i)), "")
		writeFile(t, filepath.Join(r, "ign", fmt.Sprintf("i%d.txt", i)), "")
		writeFile(t, filepath.Join(r, fmt.Sprintf("i%d.ign", i)), "")
	}
	fx := newFindFixture(t, r)
	setFindHook(t, &findMaxPaths, 3)
	if body, by := fx.findOK(t, url.Values{"q": {"."}}); len(by) != 3 || body["incomplete"] != true {
		t.Errorf("tracked max = %v %v", by, body)
	}
	if body, _ := fx.findOK(t, url.Values{"q": {"i"}, "ignored": {"1"}}); body["incomplete"] != true {
		t.Errorf("ignored max = %v", body)
	}
	// Ignored files git names one by one count too.
	writeFile(t, filepath.Join(r, ".gitignore"), "*.ign\n")
	setFindHook(t, &findMaxPaths, 2)
	if body, _ := fx.findOK(t, url.Values{"q": {"ign"}, "ignored": {"1"}, "fresh": {"1"}}); body["incomplete"] != true {
		t.Errorf("ignored files max = %v", body)
	}
	// git output cut by the limit: the partial path is dropped.
	setFindHook(t, &findMaxPaths, 1000)
	setFindHook(t, &findListOutput, 20)
	body, by := fx.findOK(t, url.Values{"q": {"t"}, "fresh": {"1"}})
	if body["incomplete"] != true {
		t.Errorf("cut = %v", body)
	}
	for p := range by {
		if _, err := os.Lstat(filepath.Join(r, p)); err != nil {
			t.Errorf("partial path %q listed", p)
		}
	}
}

func TestFilesFindCache(t *testing.T) {
	requireGit(t)
	r := newTestRepo(t)
	fx := newFindFixture(t, r)
	var mu sync.Mutex
	builds := map[string]int{}
	setFindHook(t, &findBeforeBuild, func(key string) {
		mu.Lock()
		builds[key]++
		mu.Unlock()
	})
	count := func(key string) int {
		mu.Lock()
		defer mu.Unlock()
		return builds[key]
	}
	fx.findOK(t, url.Values{"q": {"a"}})
	fx.findOK(t, url.Values{"q": {"b"}})
	if count("tracked") != 1 {
		t.Errorf("tracked built %d times, want 1", count("tracked"))
	}
	// A new file shows only once the list is read again: fresh=1, or a
	// create or a save (forgetRoot).
	writeFile(t, filepath.Join(r, "later.txt"), "")
	if _, by := fx.findOK(t, url.Values{"q": {"later"}}); len(by) != 0 {
		t.Errorf("cached list = %v", by)
	}
	if _, by := fx.findOK(t, url.Values{"q": {"later"}, "fresh": {"1"}}); by["later.txt"] == nil {
		t.Errorf("fresh = %v", by)
	}
	b := url.Values{"root": {r}}
	rec := serve(fx.h, apiRequest("POST", "/api/mux/panes/0/files/create?"+b.Encode(), `{"path":"made.txt"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	if _, by := fx.findOK(t, url.Values{"q": {"made"}}); by["made.txt"] == nil {
		t.Errorf("after create = %v", by)
	}
	if count("tracked") != 3 {
		t.Errorf("tracked built %d times, want 3", count("tracked"))
	}
}

// A request that leaves while the list is built does not fail the one
// waiting on the same list.
func TestFilesFindSharedBuildSurvivesCancel(t *testing.T) {
	requireGit(t)
	r := newTestRepo(t)
	fx := newFindFixture(t, r)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	setFindHook(t, &findBeforeBuild, func(string) {
		once.Do(func() { close(started) })
		<-release
	})
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan int)
	go func() {
		req := apiRequest("GET", "/api/mux/panes/0/files/find?q=a", "").WithContext(ctx)
		first <- serve(fx.h, req).Code
	}()
	<-started
	cancel()
	second := make(chan map[string]any)
	go func() {
		_, by := fx.findOK(t, url.Values{"q": {"a"}})
		second <- map[string]any{"a": by["a.txt"]}
	}()
	time.Sleep(50 * time.Millisecond)
	close(release)
	<-first
	if got := <-second; got["a"] == nil {
		t.Errorf("second request = %v", got)
	}
}

func TestFilesFindGitFailures(t *testing.T) {
	requireUnixShell(t)
	requireGit(t)
	r := newTestRepo(t)
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: r, files: true}, hostAllowlist{}, nil)
	get := func(route string) int {
		rec := serve(mux, apiRequest("GET", "/api/mux/panes/0/files/"+route, ""))
		return rec.Code
	}
	// ls-files times out: 503, and the root does not back off for status.
	f.git.bin = writeScript(t, `case "$*" in *ls-files*) sleep 5;; esac; exec git "$@"`)
	f.git.timeout = 300 * time.Millisecond
	if code := get("find?q=a"); code != http.StatusServiceUnavailable {
		t.Errorf("find timeout = %d", code)
	}
	f.git.timeout = gitTimeout
	if code := get("changes"); code != http.StatusOK {
		t.Errorf("changes after a find timeout = %d", code)
	}
	// The failure is not cached: the next search runs git again
	f.git.bin = "git"
	if code := get("find?q=a"); code != http.StatusOK {
		t.Errorf("find after a timeout = %d", code)
	}
	// Either ls-files failing is an error.
	for _, script := range []string{
		`case "$*" in *" -co "*) exit 1;; esac; exec git "$@"`,
		`case "$*" in *" -d "*) exit 1;; esac; exec git "$@"`,
		`case "$*" in *" -i "*) exit 1;; esac; exec git "$@"`,
	} {
		f.git.bin = writeScript(t, script)
		f.finds.forgetPrefix("")
		if code := get("find?q=a&ignored=1"); code != http.StatusInternalServerError {
			t.Errorf("%s: find = %d", script, code)
		}
	}
}

// A root the server cannot open fails cleanly.
func TestFilesFindUnreadableRoot(t *testing.T) {
	requireUnixShell(t)
	if os.Geteuid() == 0 {
		t.Skip("root reads any directory")
	}
	requireGit(t)
	r := newTestRepo(t)
	f := &filesAPI{git: newGitRunner(), finds: newTTLCache[findList](findListTTL), statuses: newTTLCache[gitStatus](findListTTL)}
	plain := plainDir(t)
	if err := os.Chmod(r, 0o300); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(plain, 0o300); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(r, 0o755); os.Chmod(plain, 0o755) })
	root := filesRoot{Root: r, IsRepo: true}
	if _, err := f.findIgnored(t.Context(), root, nil); err == nil {
		t.Error("findIgnored: no error")
	}
	if _, err := f.findWalkRoot(filesRoot{Root: plain}, nil); err == nil {
		t.Error("findWalkRoot: no error")
	}
	if _, err := f.findResults(root, "a", nil); err == nil {
		t.Error("findResults: no error")
	}
	// A directory gone between the listing and the walk is skipped.
	w := &findWalk{rt: nil, b: newFindBudget()}
	rt, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	w.rt = rt
	w.walk("missing", 1)
	if len(w.out) != 0 || w.b.stopped {
		t.Errorf("missing dir = %v %v", w.out, w.b.stopped)
	}
}

func TestFilesFindGuards(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, "a.txt"), "")
	fx := newFindFixture(t, root)
	for _, c := range []struct {
		name string
		req  *http.Request
		want int
		code string
	}{
		{"post", apiRequest("POST", "/api/mux/panes/0/files/find?q=a", "{}"), http.StatusMethodNotAllowed, ""},
		{"no q", apiRequest("GET", "/api/mux/panes/0/files/find", ""), http.StatusBadRequest, ""},
		{"bad exclude", apiRequest("GET", "/api/mux/panes/0/files/find?q=a&exclude=a/b", ""), http.StatusBadRequest, "invalid_exclude"},
		{"root moved", apiRequest("GET", "/api/mux/panes/0/files/find?q=a&root=/elsewhere", ""), http.StatusConflict, ""},
	} {
		rec := serve(fx.h, c.req)
		if rec.Code != c.want {
			t.Errorf("%s = %d %s", c.name, rec.Code, rec.Body)
			continue
		}
		if c.code != "" && decodeBody(t, rec)["code"] != c.code {
			t.Errorf("%s code = %s", c.name, rec.Body)
		}
	}
	cross := apiRequest("GET", "/api/mux/panes/0/files/find?q=a", "")
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(fx.h, cross); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
}
