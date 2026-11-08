package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com",
		"-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + os.DevNull}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

// linkedFixture is a repository with a linked worktree whose links lead back
// into the main checkout, and one file outside both.
type linkedFixture struct {
	main, wt, outside string
	h                 http.Handler
}

func newLinkedFixture(t *testing.T) *linkedFixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need a privilege on Windows")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fx := &linkedFixture{main: filepath.Join(base, "main"), wt: filepath.Join(base, "wt"), outside: filepath.Join(base, "outside")}
	writeFile(t, filepath.Join(fx.main, "README.md"), "# main\n")
	gitInit(t, fx.main)
	gitRun(t, fx.main, "add", "-A")
	gitRun(t, fx.main, "commit", "-q", "-m", "init")
	gitRun(t, fx.main, "worktree", "add", "-q", fx.wt)
	if err := exec.Command("git", "-C", fx.main, "worktree", "list", "--porcelain", "-z").Run(); err != nil {
		t.Skip("following a link into another work tree needs git 2.36 or later (worktree list -z)")
	}
	writeFile(t, filepath.Join(fx.main, "plans", "plan.md"), "# plan\n")
	writeFile(t, filepath.Join(fx.main, ".env"), "TOKEN=x\n")
	writeFile(t, filepath.Join(fx.main, "plans", "spec.pdf"), "%PDF-1.4\n")
	if err := os.WriteFile(filepath.Join(fx.main, "plans", "shot.png"), testImage(t, "image/png"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Links inside the linked directory: one staying in the main checkout,
	// one into its git dir.
	if err := os.Symlink("plan.md", filepath.Join(fx.main, "plans", "again.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../.git/config", filepath.Join(fx.main, "plans", "git.md")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(fx.outside, "passwd"), "root:x\n")
	for link, target := range map[string]string{
		"plan.md":   filepath.Join(fx.main, "plans", "plan.md"),
		"rel.md":    "../main/plans/plan.md",
		"plans":     filepath.Join(fx.main, "plans"),
		"env.md":    filepath.Join(fx.main, ".env"),
		"config.md": filepath.Join(fx.main, ".git", "config"),
		"meta.md":   filepath.Join(fx.main, ".git", "worktrees", "wt", "HEAD"),
		"out.md":    filepath.Join(fx.outside, "passwd"),
		"broken.md": filepath.Join(fx.main, "missing.md"),
	} {
		if err := os.Symlink(target, filepath.Join(fx.wt, link)); err != nil {
			t.Fatal(err)
		}
	}
	gitAdd(t, fx.wt)
	_, fx.h = viewFilesFixture(t, fx.wt)
	return fx
}

func (fx *linkedFixture) get(t *testing.T, req *http.Request) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	fx.h.ServeHTTP(rec, req)
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body
}

func TestFilesLinkedWorktreeContent(t *testing.T) {
	fx := newLinkedFixture(t)
	for _, p := range []string{"plan.md", "rel.md"} {
		code, body := fx.get(t, fullRequest("/api/mux/panes/0/files/content?path="+p))
		if code != http.StatusOK || body["text"] != "# plan\n" || body["path"] != p || body["root"] != fx.wt {
			t.Errorf("%s = %d %v", p, code, body)
		}
		// Read through the link, never saved through it
		if body["editable"] != false || body["notEditable"] != "symlink" {
			t.Errorf("%s editable = %v %v", p, body["editable"], body["notEditable"])
		}
	}
	// Not followed: the main checkout's git dir, the worktree's own git dir
	// (denied as the root's), a file outside every work tree of the repository.
	for p, want := range map[string]int{"config.md": 400, "meta.md": 403, "out.md": 400, "broken.md": 400} {
		if code, body := fx.get(t, fullRequest("/api/mux/panes/0/files/content?path="+p)); code != want || body["text"] != nil {
			t.Errorf("%s = %d %v, want %d", p, code, body, want)
		}
	}
	// A sensitive target is sensitive through the link.
	code, body := fx.get(t, fullRequest("/api/mux/panes/0/files/content?path=env.md"))
	if code != http.StatusOK || body["sensitive"] != true || body["text"] != nil {
		t.Errorf("env.md = %d %v", code, body)
	}
	code, body = fx.get(t, fullRequest("/api/mux/panes/0/files/content?path=env.md&reveal=1"))
	if code != http.StatusOK || body["text"] != "TOKEN=x\n" {
		t.Errorf("env.md revealed = %d %v", code, body)
	}
	// A directory link is no file to show; a file under it reads as its own.
	code, body = fx.get(t, fullRequest("/api/mux/panes/0/files/content?path=plans"))
	if code != http.StatusOK || body["reason"] != "not-regular" {
		t.Errorf("plans = %d %v", code, body)
	}
	for _, p := range []string{"plans/plan.md", "plans/again.md"} {
		code, body = fx.get(t, fullRequest("/api/mux/panes/0/files/content?path="+p))
		if code != http.StatusOK || body["text"] != "# plan\n" || body["path"] != p || body["notEditable"] != "symlink" {
			t.Errorf("%s = %d %v", p, code, body)
		}
	}
	if code, body := fx.get(t, fullRequest("/api/mux/panes/0/files/content?path=plans/git.md")); code != http.StatusBadRequest || body["text"] != nil {
		t.Errorf("plans/git.md = %d %v, want 400", code, body)
	}
	// Images and documents under it too
	rec := httptest.NewRecorder()
	fx.h.ServeHTTP(rec, fullRequest("/api/mux/panes/0/files/raw?path=plans/shot.png"))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" {
		t.Errorf("raw plans/shot.png = %d %s", rec.Code, rec.Body)
	}
	rec = httptest.NewRecorder()
	fx.h.ServeHTTP(rec, fullRequest("/api/mux/panes/0/files/document?path=plans/spec.pdf"))
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Body.String(), "%PDF-") {
		t.Errorf("document plans/spec.pdf = %d %s", rec.Code, rec.Body)
	}
	// A view-only client reads nothing outside the root.
	for _, p := range []string{"content?path=plan.md", "content?path=plans/plan.md", "tree?path=plans", "raw?path=plans/shot.png", "document?path=plans/spec.pdf"} {
		if code, body := fx.get(t, viewRequest("GET", "/api/mux/panes/0/files/"+p, "")); code != http.StatusNotFound {
			t.Errorf("view %s = %d %v, want 404", p, code, body)
		}
	}
}

func TestFilesLinkedWorktreeTree(t *testing.T) {
	fx := newLinkedFixture(t)
	entries := func(req *http.Request) map[string]map[string]any {
		t.Helper()
		code, body := fx.get(t, req)
		if code != http.StatusOK {
			t.Fatalf("tree = %d %v", code, body)
		}
		m := map[string]map[string]any{}
		for _, e := range body["entries"].([]any) {
			m[e.(map[string]any)["name"].(string)] = e.(map[string]any)
		}
		return m
	}
	byName := entries(fullRequest("/api/mux/panes/0/files/tree"))
	for _, n := range []string{"plan.md", "rel.md"} {
		if e := byName[n]; e["type"] != "symlink" || e["target"] != "file" || e["size"] != float64(len("# plan\n")) {
			t.Errorf("%s = %v", n, e)
		}
	}
	if e := byName["env.md"]; e["target"] != "file" || e["sensitive"] != true {
		t.Errorf("env.md = %v", e)
	}
	if e := byName["plans"]; e["type"] != "symlink" || e["target"] != "dir" {
		t.Errorf("plans = %v", e)
	}
	// Not followed: the git dirs, a path outside the repository, a broken link.
	for _, n := range []string{"config.md", "meta.md", "out.md", "broken.md"} {
		if e := byName[n]; e == nil || e["target"] != nil || e["size"] != float64(0) {
			t.Errorf("%s = %v", n, e)
		}
	}
	// The linked directory lists like one of the root's.
	inside := entries(fullRequest("/api/mux/panes/0/files/tree?path=plans"))
	if e := inside["plan.md"]; e["type"] != "file" || e["size"] != float64(len("# plan\n")) {
		t.Errorf("plans/plan.md = %v", e)
	}
	if e := inside["again.md"]; e["type"] != "symlink" || e["target"] != "file" {
		t.Errorf("plans/again.md = %v", e)
	}
	if e := inside["git.md"]; e["type"] != "symlink" || e["target"] != nil {
		t.Errorf("plans/git.md (into the git dir) = %v", e)
	}
	for n, e := range entries(viewRequest("GET", "/api/mux/panes/0/files/tree", "")) {
		if e["target"] != nil && e["type"] == "symlink" {
			t.Errorf("view %s = %v", n, e)
		}
	}
}

// No work trees when the root is no repository or git cannot list them, and
// a link that stays in the root is no linked target.
func TestLinkedTargetEdges(t *testing.T) {
	fx := newLinkedFixture(t)
	f := &filesAPI{git: newGitRunner()}
	if got := f.worktreeRoots(t.Context(), filesRoot{Root: fx.wt}); got != nil {
		t.Errorf("not a repo: %v", got)
	}
	if got := f.worktreeRoots(t.Context(), filesRoot{Root: filepath.Join(fx.wt, "missing"), IsRepo: true}); got != nil {
		t.Errorf("git failing: %v", got)
	}
	if err := os.Symlink("README.md", filepath.Join(fx.wt, "in.md")); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.linkedTarget(filesRoot{Root: fx.wt}, "in.md", []string{fx.main, fx.wt}); ok {
		t.Error("a link inside the root counted as linked")
	}
	gone := filesRoot{Root: filepath.Join(fx.wt, "gone")}
	if _, err := f.openRead(t.Context(), gone, "a.md", true); err == nil {
		t.Error("root gone: no error")
	}
	if _, err := f.tree(t.Context(), gone, "", true); err == nil {
		t.Error("tree, root gone: no error")
	}
	if _, _, err := f.content(t.Context(), gone, "a.md", false, "", true); err == nil {
		t.Error("content, root gone: no error")
	}
	if fh, err := f.openRead(t.Context(), filesRoot{Root: fx.wt}, "README.md", true); err != nil {
		t.Errorf("README.md = %v", err)
	} else {
		fh.Close()
	}
}

func TestParseWorktreeList(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, b, bare := filepath.Join(base, "a"), filepath.Join(base, "b"), filepath.Join(base, "bare.git")
	for _, d := range []string{a, b, bare} {
		os.MkdirAll(d, 0o755)
	}
	out := "worktree " + bare + "\x00bare\x00\x00" +
		"worktree " + a + "\x00HEAD abc\x00branch refs/heads/main\x00\x00" +
		"worktree " + filepath.Join(base, "gone") + "\x00prunable gitdir file points to non-existent location\x00\x00" +
		"worktree relative\x00\x00" +
		"worktree " + b + "\x00detached\x00\x00"
	got := parseWorktreeList([]byte(out))
	if strings.Join(got, ",") != a+","+b {
		t.Errorf("parseWorktreeList = %v", got)
	}
}

func TestCommonGitDir(t *testing.T) {
	dir := t.TempDir()
	// A linked worktree's git dir holds commondir; a main one does not, even
	// in a directory named worktrees.
	for _, d := range []string{"r/.git/worktrees/wt", "srv/repo.git/worktrees/feature"} {
		writeFile(t, filepath.Join(dir, filepath.FromSlash(d), "commondir"), "../..\n")
	}
	if err := os.MkdirAll(filepath.Join(dir, "x", "worktrees", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	for in, want := range map[string]string{
		"":                               "",
		"r/.git":                         "r/.git",
		"r/.git/worktrees/wt":            "r/.git",
		"srv/repo.git/worktrees/feature": "srv/repo.git",
		"x/worktrees/.git":               "x/worktrees/.git",
	} {
		if in != "" {
			in, want = filepath.Join(dir, filepath.FromSlash(in)), filepath.Join(dir, filepath.FromSlash(want))
		}
		if got := commonGitDir(in); got != want {
			t.Errorf("commonGitDir(%q) = %q, want %q", in, got, want)
		}
	}
}

// A work tree git lists only because the repository's own record of it
// names that directory (a gitdir file written by hand, or unpacked from an
// archive) is no work tree of the repository: its .git does not lead back,
// so a link into it is not followed.
func TestFilesLinkedForgedWorktree(t *testing.T) {
	fx := newLinkedFixture(t)
	gitRun(t, fx.main, "worktree", "add", "-q", filepath.Join(filepath.Dir(fx.main), "wt2"))
	record := filepath.Join(fx.main, ".git", "worktrees", "wt2", "gitdir")
	if err := os.WriteFile(record, []byte(filepath.Join(fx.outside, ".git")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, body := fx.get(t, fullRequest("/api/mux/panes/0/files/content?path=out.md")); code != http.StatusBadRequest || body["text"] != nil {
		t.Errorf("out.md through a forged work tree = %d %v", code, body)
	}
	f := &filesAPI{git: newGitRunner()}
	root := filesRoot{Root: fx.wt, IsRepo: true, GitDir: filepath.Join(fx.main, ".git", "worktrees", "wt")}
	for _, w := range f.worktreeRoots(t.Context(), root) {
		if w == fx.outside {
			t.Errorf("worktreeRoots lists %s", w)
		}
	}
}
