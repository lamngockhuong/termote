package main

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// branchRepo is a repo on trunk with a worktree on feat holding two
// commits: a change, a new file, a rename, a deletion and a .env; trunk has
// moved on since. The fixture's pane is in the worktree.
func branchRepo(t *testing.T) (gx *gitFixture, main string) {
	t.Helper()
	gx = newGitFixture(t)
	main = gx.repo
	gitT(t, main, "branch", "-M", "trunk")
	writeFile(t, filepath.Join(main, "del.txt"), "d\n")
	writeFile(t, filepath.Join(main, "old.txt"), "same content for rename\n")
	gitT(t, main, "add", ".")
	gitT(t, main, "commit", "-q", "-m", "base")
	wt := filepath.Join(t.TempDir(), "wt")
	gitT(t, main, "worktree", "add", "-q", "-b", "feat", wt)
	wt, _ = filepath.EvalSymlinks(wt)
	writeFile(t, filepath.Join(wt, "a.txt"), "one\ntwo\n")
	writeFile(t, filepath.Join(wt, "dir", "new.md"), "n1\n")
	gitT(t, wt, "add", ".")
	gitT(t, wt, "commit", "-q", "-m", "one")
	gitT(t, wt, "mv", "old.txt", "renamed.txt")
	gitT(t, wt, "rm", "-q", "del.txt")
	writeFile(t, filepath.Join(wt, ".env"), "TOKEN=secret\n")
	gitT(t, wt, "add", ".")
	gitT(t, wt, "commit", "-q", "-m", "two")
	// Trunk moves on: not part of the branch.
	writeFile(t, filepath.Join(main, "trunk-only.txt"), "t\n")
	gitT(t, main, "add", ".")
	gitT(t, main, "commit", "-q", "-m", "trunk")
	// Not committed: not part of the range either.
	writeFile(t, filepath.Join(wt, "a.txt"), "one\ntwo\nthree\n")
	gx.repo = wt
	gx.h = newTestHandler(t, &filesFakeMux{dir: wt, files: true})
	return gx, main
}

func branchFilesBy(t *testing.T, body map[string]any) map[string]map[string]any {
	t.Helper()
	by := map[string]map[string]any{}
	for _, e := range body["files"].([]any) {
		m := e.(map[string]any)
		by[m["path"].(string)] = m
	}
	return by
}

func TestFilesBranch(t *testing.T) {
	gx, _ := branchRepo(t)
	code, body := gx.get(t, "branch", nil)
	if code != 200 || body["base"] != "trunk" || body["branch"] != "feat" || body["commits"] != float64(2) || len(body["mergeBase"].(string)) != 12 {
		t.Fatalf("branch = %d %v", code, body)
	}
	by := branchFilesBy(t, body)
	for path, status := range map[string]string{"a.txt": "M", "dir/new.md": "A", "renamed.txt": "R", "del.txt": "D", ".env": "A"} {
		if by[path] == nil || by[path]["status"] != status {
			t.Errorf("%s = %v, want %s", path, by[path], status)
		}
	}
	if len(by) != 5 || by["renamed.txt"]["orig"] != "old.txt" || by[".env"]["sensitive"] != true {
		t.Errorf("files = %v", by)
	}
	diff := func(q url.Values) (int, map[string]any) { return gx.get(t, "branch/diff", q) }
	// The committed change only, not the edit since.
	if code, d := diff(url.Values{"path": {"a.txt"}}); code != 200 || strings.Join(diffLines(d), ",") != "ctx:one,add:two" {
		t.Errorf("a.txt = %d %v", code, diffLines(d))
	}
	if code, d := diff(url.Values{"path": {"del.txt"}, "base": {"trunk"}}); code != 200 || strings.Join(diffLines(d), ",") != "del:d" {
		t.Errorf("deleted = %d %v", code, diffLines(d))
	}
	if code, d := diff(url.Values{"path": {"renamed.txt"}, "orig": {"old.txt"}}); code != 200 || len(diffLines(d)) != 0 {
		t.Errorf("rename = %d %v", code, d)
	}
	if code, d := diff(url.Values{"path": {".env"}}); code != 200 || d["sensitive"] != true || d["hunks"] != nil {
		t.Errorf(".env = %d %v", code, d)
	}
	if code, d := diff(url.Values{"path": {".env"}, "reveal": {"1"}}); code != 200 || strings.Join(diffLines(d), ",") != "add:TOKEN=secret" {
		t.Errorf(".env revealed = %d %v", code, diffLines(d))
	}
	// Only a path of the range reaches git.
	for name, q := range map[string]url.Values{
		"unchanged":        {"path": {"keep.txt"}},
		"trunk only":       {"path": {"trunk-only.txt"}},
		"rename no orig":   {"path": {"renamed.txt"}},
		"option injection": {"path": {"--output=" + filepath.Join(gx.repo, "pwned")}},
		"pathspec magic":   {"path": {":(glob)*"}},
	} {
		if code, body := diff(q); code != http.StatusNotFound {
			t.Errorf("%s = %d %v, want 404", name, code, body)
		}
	}
	if _, err := os.Stat(filepath.Join(gx.repo, "pwned")); err == nil {
		t.Error("--output path was written")
	}
	// A base that is no branch name never reaches git.
	for _, base := range []string{"-x", "--output=x", "a..b", "HEAD", "@{1}", "x y"} {
		for _, route := range []string{"branch", "branch/diff"} {
			if code, body := gx.get(t, route, url.Values{"base": {base}, "path": {"a.txt"}}); code != http.StatusBadRequest || body["code"] != "invalid_base" {
				t.Errorf("%s base %q = %d %v", route, base, code, body)
			}
		}
	}
	if code, body := gx.get(t, "branch", url.Values{"base": {"nope"}}); code != http.StatusNotFound || body["code"] != "base_not_found" {
		t.Errorf("unknown base = %d %v", code, body)
	}
	// Only a branch is a base: a commit hash or a tag would show a file as
	// it was at any commit of HEAD's history.
	first := strings.TrimSpace(gitT(t, gx.repo, "rev-list", "--max-parents=0", "HEAD"))
	gitT(t, gx.repo, "tag", "v1", first)
	for _, base := range []string{first, "v1"} {
		for _, route := range []string{"branch", "branch/diff"} {
			if code, body := gx.get(t, route, url.Values{"base": {base}, "path": {"a.txt"}}); code != http.StatusNotFound || body["code"] != "base_not_found" {
				t.Errorf("%s base %q = %d %v", route, base, code, body)
			}
		}
	}
	// A remote branch is one.
	gitT(t, gx.repo, "update-ref", "refs/remotes/origin/trunk", "refs/heads/trunk")
	if code, body := gx.get(t, "branch", url.Values{"base": {"origin/trunk"}}); code != 200 || body["commits"] != float64(2) {
		t.Errorf("remote branch = %d %v", code, body)
	}
	// A tag named like the branch does not win over it.
	gitT(t, gx.repo, "tag", "trunk", "HEAD")
	if code, body := gx.get(t, "branch", url.Values{"base": {"trunk"}}); code != 200 || body["commits"] != float64(2) {
		t.Errorf("tag beside the branch = %d %v", code, body)
	}
	// Against itself: nothing.
	if code, body := gx.get(t, "branch", url.Values{"base": {"feat"}}); code != 200 || body["commits"] != float64(0) || len(body["files"].([]any)) != 0 {
		t.Errorf("itself = %d %v", code, body)
	}
}

func TestFilesBranchBaseRequiredAndNoHistory(t *testing.T) {
	gx := newGitFixture(t)
	// The pane is the main worktree: no other branch to compare with.
	if code, body := gx.get(t, "branch", nil); code != http.StatusConflict || body["code"] != "base_required" {
		t.Errorf("main worktree = %d %v", code, body)
	}
	// Detached main worktree.
	gitT(t, gx.repo, "checkout", "-q", "--detach")
	if code, body := gx.get(t, "branch", nil); code != http.StatusConflict || body["code"] != "base_required" {
		t.Errorf("detached = %d %v", code, body)
	}
	gitT(t, gx.repo, "checkout", "-q", "--orphan", "other")
	writeFile(t, filepath.Join(gx.repo, "o.txt"), "o\n")
	gitT(t, gx.repo, "add", ".")
	gitT(t, gx.repo, "commit", "-q", "-m", "orphan")
	gitT(t, gx.repo, "branch", "-f", "first", "HEAD@{2}")
	if code, body := gx.get(t, "branch", url.Values{"base": {"first"}}); code != http.StatusConflict || body["code"] != "no_merge_base" {
		t.Errorf("no history = %d %v", code, body)
	}
	if code, body := gx.get(t, "branch/diff", url.Values{"base": {"first"}, "path": {"o.txt"}}); code != http.StatusConflict || body["code"] != "no_merge_base" {
		t.Errorf("diff no history = %d %v", code, body)
	}
}

func TestFilesBranchUnbornAndPlainDir(t *testing.T) {
	requireGit(t)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	gitT(t, dir, "init", "-q")
	gitT(t, dir, "symbolic-ref", "HEAD", "refs/heads/new")
	gx := &gitFixture{repo: dir, h: newTestHandler(t, &filesFakeMux{dir: dir, files: true})}
	if code, body := gx.get(t, "branch", url.Values{"base": {"trunk"}}); code != 200 || body["commits"] != float64(0) || len(body["files"].([]any)) != 0 {
		t.Errorf("unborn = %d %v", code, body)
	}
	if code, body := gx.get(t, "branch/diff", url.Values{"base": {"trunk"}, "path": {"a"}}); code != http.StatusNotFound {
		t.Errorf("unborn diff = %d %v", code, body)
	}
	plain, _ := filepath.EvalSymlinks(t.TempDir())
	px := &gitFixture{repo: plain, h: newTestHandler(t, &filesFakeMux{dir: plain, files: true})}
	if code, body := px.get(t, "branch", nil); code != 200 || body["isRepo"] != false {
		t.Errorf("plain = %d %v", code, body)
	}
	if code, body := px.get(t, "branch/diff", url.Values{"path": {"a"}}); code != http.StatusNotFound {
		t.Errorf("plain diff = %d %v", code, body)
	}
}

// A view-only client sees the branch's files it could open, never a deleted
// one's or a rename source's contents, and never reveals.
func TestViewOnlyBranch(t *testing.T) {
	gx, _ := branchRepo(t)
	_, vh := viewFilesFixture(t, gx.repo)
	const base = "/api/mux/panes/0/files/"
	rec := serve(vh, viewRequest("GET", base+"branch", ""))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "del.txt") || !strings.Contains(rec.Body.String(), "dir/new.md") {
		t.Errorf("view branch = %d %s", rec.Code, rec.Body)
	}
	q := url.Values{"path": {"a.txt"}}
	if rec := serve(vh, viewRequest("GET", base+"branch/diff?"+q.Encode(), "")); rec.Code != 200 || !strings.Contains(rec.Body.String(), "two") {
		t.Errorf("view diff = %d %s", rec.Code, rec.Body)
	}
	for name, q := range map[string]url.Values{
		"deleted": {"path": {"del.txt"}},
		"rename":  {"path": {"renamed.txt"}, "orig": {"old.txt"}},
	} {
		if rec := serve(vh, viewRequest("GET", base+"branch/diff?"+q.Encode(), "")); rec.Code != http.StatusNotFound {
			t.Errorf("view %s = %d %s", name, rec.Code, rec.Body)
		}
	}
	q = url.Values{"path": {".env"}, "reveal": {"1"}}
	if rec := serve(vh, viewRequest("GET", base+"branch/diff?"+q.Encode(), "")); strings.Contains(rec.Body.String(), "TOKEN") {
		t.Errorf("view reveal = %d %s", rec.Code, rec.Body)
	}
}
