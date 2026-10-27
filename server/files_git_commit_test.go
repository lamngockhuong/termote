package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseNameStatus(t *testing.T) {
	out := "M\x00a\x00R100\x00old\x00new name\x00A\x00line\nbreak\x00D\x00gone\x00"
	files, cut := parseNameStatus([]byte(out), false)
	want := []commitFile{
		{Path: "a", Status: "M"},
		{Path: "new name", Orig: "old", Status: "R"},
		{Path: "line\nbreak", Status: "A"},
		{Path: "gone", Status: "D"},
	}
	if cut || fmt.Sprint(files) != fmt.Sprint(want) {
		t.Errorf("parseNameStatus = %v %v, want %v", files, cut, want)
	}
	// Cut by the output limit: the partial record is dropped.
	if files, cut := parseNameStatus([]byte("M\x00a\x00R100\x00old\x00ne"), true); len(files) != 1 || !cut {
		t.Errorf("cut = %v %v", files, cut)
	}
	// A rename missing its destination is dropped.
	if files, _ := parseNameStatus([]byte("M\x00a\x00R100\x00old\x00"), false); len(files) != 1 {
		t.Errorf("short rename = %v", files)
	}
	var many strings.Builder
	for i := 0; i < maxStatusEntries+3; i++ {
		fmt.Fprintf(&many, "A\x00f%d\x00", i)
	}
	if files, cut := parseNameStatus([]byte(many.String()), false); len(files) != maxStatusEntries || !cut {
		t.Errorf("many = %d %v", len(files), cut)
	}
}

// commit reads files/commit and its files by path.
func (gx *gitFixture) commit(t *testing.T) (map[string]any, map[string]map[string]any) {
	t.Helper()
	code, body := gx.get(t, "commit", nil)
	if code != 200 {
		t.Fatalf("commit = %d %v", code, body)
	}
	c, _ := body["commit"].(map[string]any)
	byPath := map[string]map[string]any{}
	if c != nil {
		for _, e := range c["files"].([]any) {
			m := e.(map[string]any)
			byPath[m["path"].(string)] = m
		}
	}
	return c, byPath
}

func TestFilesCommitAndDiff(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	writeFile(t, filepath.Join(r, "keep.txt"), "k\n")
	writeFile(t, filepath.Join(r, "del.txt"), "d\n")
	writeFile(t, filepath.Join(r, "old.txt"), "same content for rename\n")
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "more")

	writeFile(t, filepath.Join(r, "a.txt"), "one\ntwo\n")
	os.Remove(filepath.Join(r, "del.txt"))
	gitT(t, r, "mv", "old.txt", "new name.txt")
	writeFile(t, filepath.Join(r, "dir", "added.md"), "u1\nu2\n")
	gitT(t, r, "add", "-A")
	gitT(t, r, "commit", "-q", "-m", "subject line\n\nbody text\n")
	// Not committed: never in the commit
	writeFile(t, filepath.Join(r, "untracked.txt"), "x\n")

	c, by := gx.commit(t)
	head := strings.TrimSpace(gitT(t, r, "rev-parse", "HEAD"))
	if c["hash"] != head || c["message"] != "subject line\n\nbody text" || c["author"] == "" || c["time"].(float64) < 1 {
		t.Errorf("commit = %v", c)
	}
	if ps := c["parents"].([]any); len(ps) != 1 {
		t.Errorf("parents = %v", ps)
	}
	check := func(path, status string) {
		t.Helper()
		if e := by[path]; e == nil || e["status"] != status {
			t.Errorf("%s = %v, want %s", path, e, status)
		}
	}
	check("a.txt", "M")
	check("del.txt", "D")
	check("new name.txt", "R")
	check("dir/added.md", "A")
	if by["new name.txt"]["orig"] != "old.txt" {
		t.Errorf("rename orig = %v", by["new name.txt"])
	}
	if len(by) != 4 {
		t.Errorf("files = %v", by)
	}

	diff := func(q url.Values) (int, map[string]any) {
		q.Set("commit", head)
		return gx.get(t, "commit/diff", q)
	}
	if code, d := diff(url.Values{"path": {"a.txt"}}); code != 200 || strings.Join(diffLines(d), ",") != "ctx:one,add:two" {
		t.Errorf("a.txt = %d %v", code, diffLines(d))
	}
	if code, d := diff(url.Values{"path": {"del.txt"}}); code != 200 || strings.Join(diffLines(d), ",") != "del:d" {
		t.Errorf("deleted = %d %v", code, diffLines(d))
	}
	if code, d := diff(url.Values{"path": {"dir/added.md"}}); code != 200 || strings.Join(diffLines(d), ",") != "add:u1,add:u2" {
		t.Errorf("added = %d %v", code, diffLines(d))
	}
	if code, d := diff(url.Values{"path": {"new name.txt"}, "orig": {"old.txt"}}); code != 200 || len(diffLines(d)) != 0 || d["path"] != "new name.txt" {
		t.Errorf("pure rename = %d %v", code, d)
	}

	// Only what the commit changed.
	for name, q := range map[string]url.Values{
		"unchanged":        {"path": {"keep.txt"}},
		"untracked":        {"path": {"untracked.txt"}},
		"wrong orig":       {"path": {"new name.txt"}, "orig": {"keep.txt"}},
		"rename no orig":   {"path": {"new name.txt"}},
		"option injection": {"path": {"--output=" + filepath.Join(r, "pwned")}},
		"outside root":     {"path": {"../x"}},
		"pathspec magic":   {"path": {":(glob)*"}},
	} {
		if code, body := diff(q); code != http.StatusNotFound {
			t.Errorf("%s = %d %v, want 404", name, code, body)
		}
	}
	if _, err := os.Stat(filepath.Join(r, "pwned")); err == nil {
		t.Error("--output path was written")
	}

	// Another commit than HEAD, a rev or an option: never reaches git.
	for _, commit := range []string{"", "HEAD", "HEAD~1", strings.TrimSpace(gitT(t, r, "rev-parse", "HEAD~1")), "--output=x"} {
		if code, body := gx.get(t, "commit/diff", url.Values{"path": {"a.txt"}, "commit": {commit}}); code != http.StatusConflict || body["code"] != "head_moved" {
			t.Errorf("commit %q = %d %v, want 409 head_moved", commit, code, body)
		}
	}
}

func TestFilesCommitRootMergeAndUnborn(t *testing.T) {
	requireGit(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "init", "-q", "-b", "main")
	gx := &gitFixture{repo: dir, h: newTestHandler(t, &filesFakeMux{dir: dir, files: true})}
	if c, _ := gx.commit(t); c != nil {
		t.Errorf("unborn = %v", c)
	}
	if code, body := gx.get(t, "commit/diff", url.Values{"path": {"a.txt"}, "commit": {"0000000000000000000000000000000000000000"}}); code != http.StatusConflict {
		t.Errorf("unborn diff = %d %v", code, body)
	}

	writeFile(t, filepath.Join(dir, "a.txt"), "one\n")
	gitT(t, dir, "add", ".")
	gitT(t, dir, "commit", "-q", "-m", "root")
	time.Sleep(filesRootTTL)
	c, by := gx.commit(t)
	if c == nil || len(c["parents"].([]any)) != 0 || by["a.txt"]["status"] != "A" {
		t.Fatalf("root commit = %v %v", c, by)
	}
	if code, d := gx.get(t, "commit/diff", url.Values{"path": {"a.txt"}, "commit": {c["hash"].(string)}}); code != 200 || strings.Join(diffLines(d), ",") != "add:one" {
		t.Errorf("root diff = %d %v", code, diffLines(d))
	}

	// A merge shows what it brought into the first parent.
	gitT(t, dir, "checkout", "-q", "-b", "side")
	writeFile(t, filepath.Join(dir, "side.txt"), "s\n")
	gitT(t, dir, "add", ".")
	gitT(t, dir, "commit", "-q", "-m", "side")
	gitT(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "main.txt"), "m\n")
	gitT(t, dir, "add", ".")
	gitT(t, dir, "commit", "-q", "-m", "main")
	gitT(t, dir, "merge", "-q", "--no-edit", "--no-ff", "side")
	c, by = gx.commit(t)
	if len(c["parents"].([]any)) != 2 || len(by) != 1 || by["side.txt"]["status"] != "A" {
		t.Errorf("merge = %v %v", c, by)
	}
}

func TestFilesCommitSensitiveAndDenied(t *testing.T) {
	gx := newGitFixture(t)
	deny := filepath.Join(gx.repo, "cfg")
	writeFile(t, filepath.Join(gx.repo, ".env"), "TOKEN=secret\n")
	writeFile(t, filepath.Join(deny, "secret"), "k\n")
	gitT(t, gx.repo, "add", ".")
	gitT(t, gx.repo, "commit", "-q", "-m", "env")
	cfg := testConfig(t)
	cfg.FilesDenyDirs = []string{deny}
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: gx.repo, files: true})
	if err != nil {
		t.Fatal(err)
	}
	gx.h = h
	c, by := gx.commit(t)
	if by[".env"]["sensitive"] != true || by["cfg/secret"]["sensitive"] != false {
		t.Errorf("files = %v", by)
	}
	head := c["hash"].(string)
	rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/commit/diff?"+url.Values{"path": {".env"}, "commit": {head}}.Encode(), ""))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "TOKEN") || !strings.Contains(rec.Body.String(), `"sensitive":true`) {
		t.Errorf("without reveal = %d %s", rec.Code, rec.Body.String())
	}
	if code, d := gx.get(t, "commit/diff", url.Values{"path": {".env"}, "commit": {head}, "reveal": {"1"}}); code != 200 || strings.Join(diffLines(d), ",") != "add:TOKEN=secret" {
		t.Errorf("with reveal = %d %v", code, diffLines(d))
	}
	if code, body := gx.get(t, "commit/diff", url.Values{"path": {"cfg/secret"}, "commit": {head}}); code != http.StatusForbidden {
		t.Errorf("denied = %d %v", code, body)
	}
	// A view-only client reads the commit, never revealed.
	_, vh := viewFilesFixture(t, gx.repo)
	const base = "/api/mux/panes/0/files/"
	if rec := serve(vh, viewRequest("GET", base+"commit", "")); rec.Code != 200 || !strings.Contains(rec.Body.String(), head) {
		t.Errorf("view commit = %d %s", rec.Code, rec.Body)
	}
	q := url.Values{"path": {".env"}, "commit": {head}}
	if rec := serve(vh, viewRequest("GET", base+"commit/diff?"+q.Encode(), "")); rec.Code != 200 || strings.Contains(rec.Body.String(), "TOKEN") {
		t.Errorf("view diff = %d %s", rec.Code, rec.Body)
	}
	q.Set("reveal", "1")
	if rec := serve(vh, viewRequest("GET", base+"commit/diff?"+q.Encode(), "")); rec.Code != http.StatusForbidden {
		t.Errorf("view reveal = %d %s", rec.Code, rec.Body)
	}
	// Renamed out of the denied dir: its source is refused too
	gitT(t, gx.repo, "mv", "cfg/secret", "out.txt")
	gitT(t, gx.repo, "commit", "-q", "-m", "move")
	c, _ = gx.commit(t)
	if code, body := gx.get(t, "commit/diff", url.Values{"path": {"out.txt"}, "orig": {"cfg/secret"}, "commit": {c["hash"].(string)}}); code != http.StatusForbidden {
		t.Errorf("denied orig = %d %v", code, body)
	}
}

func TestFilesCommitPlainDirAndGitFailure(t *testing.T) {
	requireUnixShell(t)
	gx := newGitFixture(t)
	plain := t.TempDir()
	h := newTestHandler(t, &filesFakeMux{dir: plain, files: true})
	rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/commit", ""))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), `"commit"`) || !strings.Contains(rec.Body.String(), `"isRepo":false`) {
		t.Errorf("plain dir = %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/commit/diff?path=a.txt&commit=x", "")); rec.Code != http.StatusNotFound {
		t.Errorf("plain dir diff = %d %s", rec.Code, rec.Body)
	}

	f := registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: gx.repo, files: true}, hostAllowlist{}, nil)
	root := filesRoot{Root: gx.repo, IsRepo: true}
	// rev-parse fails with output: not an unborn HEAD but an error.
	f.git.bin = writeScript(t, "echo oops; exit 2")
	if _, err := f.headCommit(t.Context(), root); err == nil {
		t.Error("failing rev-parse: no error")
	}
	if _, err := f.commitDiff(t.Context(), root, strings.Repeat("a", 40), "a.txt", "", false); err == nil || err == errHeadMoved {
		t.Errorf("commit diff, failing rev-parse = %v", err)
	}
	f.git.bin = writeScript(t, "echo nothex")
	if _, err := f.headCommit(t.Context(), root); err == nil {
		t.Error("bad rev-parse output: no error")
	}
	hash := strings.Repeat("a", 40)
	// A fake git: HEAD is hash; the subcommand named in $FAIL fails
	fake := func(fail string) {
		f.git.bin = writeScript(t, `case " $* " in
*" `+fail+` "*) exit 1 ;;
*" rev-parse "*) echo `+hash+` ;;
*" log "*) printf '`+hash+`\000\000me\0001\000msg' ;;
*" diff-tree "*) printf 'M\000a.txt\000' ;;
esac`)
	}
	fake("log")
	if _, err := f.headCommit(t.Context(), root); err == nil {
		t.Error("failing log: no error")
	}
	f.git.bin = writeScript(t, `if [ "$(echo "$@" | grep -c rev-parse)" = 1 ]; then echo `+hash+`; else printf other; fi`)
	if _, err := f.headCommit(t.Context(), root); err == nil {
		t.Error("bad log output: no error")
	}
	for _, fail := range []string{"rev-parse", "diff-tree"} {
		fake(fail)
		if _, err := f.commitDiff(t.Context(), root, hash, "a.txt", "", false); err == nil {
			t.Errorf("commit diff, failing %s: no error", fail)
		}
	}
	// The file list read, its diff fails (the failed list is no longer kept)
	f.commits = newTTLCache[commitList](commitFilesTTL)
	f.git.bin = writeScript(t, `case " $* " in
*" -p "*) exit 1 ;;
*" rev-parse "*) echo `+hash+` ;;
*" log "*) printf '`+hash+`\000\000me\0001\000msg' ;;
*" diff-tree "*) printf 'M\000a.txt\000' ;;
esac`)
	if _, err := f.commitDiff(t.Context(), root, hash, "a.txt", "", false); err == nil {
		t.Error("failing diff-tree -p: no error")
	}

	rec = httptest.NewRecorder()
	f.handleCommit(rec, apiRequest("POST", "/api/mux/panes/0/files/commit", ""))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST commit = %d", rec.Code)
	}
}

// A commit whose tree is gone: git fails, and the client gets no git text.
func TestFilesCommitMissingTree(t *testing.T) {
	gx := newGitFixture(t)
	tree := strings.TrimSpace(gitT(t, gx.repo, "rev-parse", "HEAD^{tree}"))
	if err := os.Remove(filepath.Join(gx.repo, ".git", "objects", tree[:2], tree[2:])); err != nil {
		t.Fatal(err)
	}
	rec := serve(gx.h, apiRequest("GET", "/api/mux/panes/0/files/commit", ""))
	if rec.Code < 500 || strings.Contains(rec.Body.String(), tree) || strings.Contains(rec.Body.String(), "fatal") {
		t.Errorf("missing tree = %d %s", rec.Code, rec.Body)
	}
}

// A view-only client is refused a commit file a symlink leads out of what it
// may read, as files/diff is.
func TestViewOnlyCommitDiffSymlink(t *testing.T) {
	repo, links := viewOnlyRepo(t)
	if !links {
		t.Skip("no symlinks")
	}
	gitT(t, repo, "add", ".")
	gitT(t, repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "all")
	_, h := viewFilesFixture(t, repo)
	head := strings.TrimSpace(gitT(t, repo, "rev-parse", "HEAD"))
	q := url.Values{"path": {"link"}, "commit": {head}}
	if rec := serve(h, viewRequest("GET", "/api/mux/panes/0/files/commit/diff?"+q.Encode(), "")); rec.Code != http.StatusNotFound {
		t.Errorf("view link = %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, fullRequest("/api/mux/panes/0/files/commit/diff?"+q.Encode())); rec.Code != http.StatusOK {
		t.Errorf("full link = %d %s", rec.Code, rec.Body)
	}
}

// The files of a commit are listed once for every diff opened in it, and a
// file of a cached list is still checked for a sensitive name.
func TestFilesCommitFilesCached(t *testing.T) {
	requireUnixShell(t)
	gx := newGitFixture(t)
	f := registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: gx.repo, files: true}, hostAllowlist{}, nil)
	root := filesRoot{Root: gx.repo, IsRepo: true}
	hash := strings.Repeat("a", 40)
	count := filepath.Join(t.TempDir(), "count")
	f.git.bin = writeScript(t, `case " $* " in
*" -p "*) printf '' ;;
*" rev-parse "*) echo `+hash+` ;;
*" log "*) printf '`+hash+`\000\000me\0001\000msg' ;;
*" diff-tree "*) echo x >> `+count+`; printf 'M\000a.txt\000M\000notes.txt\000' ;;
esac`)
	for i := 0; i < 3; i++ {
		if _, err := f.commitDiff(t.Context(), root, hash, "a.txt", "", false); err != nil {
			t.Fatal(err)
		}
	}
	if b, _ := os.ReadFile(count); strings.Count(string(b), "x") != 1 {
		t.Errorf("file list read %d times", strings.Count(string(b), "x"))
	}
	// notes.txt became a link to .env after the list was cached
	writeFile(t, filepath.Join(gx.repo, ".env"), "TOKEN=1\n")
	if err := os.Symlink(".env", filepath.Join(gx.repo, "notes.txt")); err != nil {
		t.Skip("no symlinks")
	}
	if d, err := f.commitDiff(t.Context(), root, hash, "notes.txt", "", false); err != nil || !d.Sensitive {
		t.Errorf("link to .env = %+v %v", d, err)
	}
}
