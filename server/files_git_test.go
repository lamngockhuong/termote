package main

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseStatus(t *testing.T) {
	// Captured from git 2.53, plus a name with a newline and a space.
	out := "# branch.oid 37a5f5\x00# branch.head main\x00" +
		"1 MM N... 100644 100644 100644 422c2b 82e335 a\x00" +
		"2 R. N... 100644 100644 100644 587be6 587be6 R100 new name\x00old\x00" +
		"u UU N... 100644 100644 100644 100644 f2ad6c ab7768 2638c4 c\x00" +
		"1 .D N... 100644 100644 000000 aa bb gone\x00" +
		"1 A. N... 000000 100644 100644 00 cc added\x00" +
		"? sp ace\x00? line\nbreak\x00! ignored\x00"
	st := parseStatus([]byte(out), false)
	want := []changeEntry{
		{Path: "a", Staged: "M", Unstaged: "M"},
		{Path: "new name", Orig: "old", Staged: "R"},
		{Path: "c", Conflict: true},
		{Path: "gone", Unstaged: "D"},
		{Path: "added", Staged: "A"},
		{Path: "sp ace", Unstaged: "?"},
		{Path: "line\nbreak", Unstaged: "?"},
	}
	if st.Branch != "main" || st.Truncated || fmt.Sprint(st.Entries) != fmt.Sprint(want) {
		t.Errorf("parseStatus = %q %v\n%v\nwant %v", st.Branch, st.Truncated, st.Entries, want)
	}
	// Cut by the output limit: the partial record is dropped.
	st = parseStatus([]byte("? a\x00? b\x00? parti"), true)
	if len(st.Entries) != 2 || !st.Truncated {
		t.Errorf("cut = %+v", st)
	}
	// Malformed records are skipped.
	st = parseStatus([]byte("1 MM short\x002 R. x\x00u UU x\x00"), false)
	if len(st.Entries) != 0 {
		t.Errorf("malformed = %+v", st.Entries)
	}
	var many strings.Builder
	for i := 0; i < maxStatusEntries+3; i++ {
		fmt.Fprintf(&many, "? f%d\x00", i)
	}
	if st := parseStatus([]byte(many.String()), false); len(st.Entries) != maxStatusEntries || !st.Truncated {
		t.Errorf("many = %d %v", len(st.Entries), st.Truncated)
	}
	if s, u := statusXY("M"); s != "" || u != "" {
		t.Errorf("statusXY(bad) = %q %q", s, u)
	}
}

func TestParseUnifiedDiff(t *testing.T) {
	out := "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n" +
		"@@ -1,3 +1,3 @@ func x\n ctx\n--- removed dashes\n+++ added pluses\n \n" +
		"@@ -10 +10,2 @@\n-old\n+new\n+tail\n\\ No newline at end of file\n"
	hunks, binary := parseUnifiedDiff([]byte(out))
	if binary || len(hunks) != 2 {
		t.Fatalf("hunks = %+v binary=%v", hunks, binary)
	}
	h := hunks[0]
	want := []diffLine{
		{Kind: "ctx", Old: 1, New: 1, Text: "ctx"},
		{Kind: "del", Old: 2, Text: "-- removed dashes"},
		{Kind: "add", New: 2, Text: "++ added pluses"},
		{Kind: "ctx", Old: 3, New: 3, Text: ""},
	}
	if h.Header != "@@ -1,3 +1,3 @@ func x" || fmt.Sprint(h.Lines) != fmt.Sprint(want) {
		t.Errorf("hunk 0 = %+v", h)
	}
	want = []diffLine{
		{Kind: "del", Old: 10, Text: "old"},
		{Kind: "add", New: 10, Text: "new"},
		{Kind: "add", New: 11, Text: "tail", NoNewline: true},
	}
	if fmt.Sprint(hunks[1].Lines) != fmt.Sprint(want) {
		t.Errorf("hunk 1 = %+v", hunks[1].Lines)
	}
	if _, binary := parseUnifiedDiff([]byte("diff --git a/x b/x\nBinary files a/x and b/x differ\n")); !binary {
		t.Error("binary not detected")
	}
	// A cut last line is dropped; a bad header starts no hunk.
	hunks, _ = parseUnifiedDiff([]byte("@@ -1,2 +1,2 @@\n-a\n+b\n-cu"))
	if len(hunks) != 1 || len(hunks[0].Lines) != 2 {
		t.Errorf("cut = %+v", hunks)
	}
	if hunks, _ = parseUnifiedDiff([]byte("@@ -x +1 @@\n+a\n@@ -1,y +1 @@\n@@ -1 +z @@\n@@ bad\n")); len(hunks) != 0 {
		t.Errorf("bad headers = %+v", hunks)
	}
}

func TestWholeFileHunk(t *testing.T) {
	if h := wholeFileHunk(""); len(h) != 0 {
		t.Errorf("empty = %+v", h)
	}
	h := wholeFileHunk("a\nb\n")
	if len(h) != 1 || h[0].Header != "@@ -0,0 +1,2 @@" || len(h[0].Lines) != 2 || h[0].Lines[1].NoNewline || h[0].Lines[1].New != 2 {
		t.Errorf("a,b = %+v", h)
	}
	if h := wholeFileHunk("x"); !h[0].Lines[0].NoNewline {
		t.Errorf("no newline = %+v", h)
	}
}

// gitFixture is a repo behind the files routes.
type gitFixture struct {
	repo string
	h    http.Handler
}

func newGitFixture(t *testing.T) *gitFixture {
	t.Helper()
	requireGit(t)
	repo := newTestRepo(t)
	return &gitFixture{repo: repo, h: newTestHandler(t, &filesFakeMux{dir: repo, files: true})}
}

func (gx *gitFixture) get(t *testing.T, route string, q url.Values) (int, map[string]any) {
	t.Helper()
	rec := serve(gx.h, apiRequest("GET", "/api/mux/panes/0/files/"+route+"?"+q.Encode(), ""))
	return rec.Code, decodeBody(t, rec)
}

// changes returns the entries by path, after the status cache expired.
func (gx *gitFixture) changes(t *testing.T) (map[string]any, map[string]map[string]any) {
	t.Helper()
	time.Sleep(filesRootTTL)
	code, body := gx.get(t, "changes", nil)
	if code != 200 {
		t.Fatalf("changes = %d %v", code, body)
	}
	byPath := map[string]map[string]any{}
	for _, e := range body["entries"].([]any) {
		m := e.(map[string]any)
		byPath[m["path"].(string)] = m
	}
	return body, byPath
}

func diffLines(body map[string]any) []string {
	var out []string
	hunks, _ := body["hunks"].([]any)
	for _, h := range hunks {
		for _, l := range h.(map[string]any)["lines"].([]any) {
			m := l.(map[string]any)
			out = append(out, m["kind"].(string)+":"+m["text"].(string))
		}
	}
	return out
}

func TestFilesChangesAndDiff(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	writeFile(t, filepath.Join(r, "keep.txt"), "k\n")
	writeFile(t, filepath.Join(r, "del.txt"), "d\n")
	writeFile(t, filepath.Join(r, "old.txt"), "same content for rename\n")
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "more")

	writeFile(t, filepath.Join(r, "a.txt"), "one\nstaged\n")
	gitT(t, r, "add", "a.txt")
	writeFile(t, filepath.Join(r, "a.txt"), "one\nstaged\nworktree\n")
	os.Remove(filepath.Join(r, "del.txt"))
	gitT(t, r, "mv", "old.txt", "new name.txt")
	writeFile(t, filepath.Join(r, "dir", "untracked.md"), "u1\nu2")

	body, by := gx.changes(t)
	if body["isRepo"] != true || body["branch"] != "main" || body["root"] != r {
		t.Errorf("changes header = %v", body)
	}
	check := func(path, staged, unstaged string) {
		t.Helper()
		e := by[path]
		if e == nil || e["staged"] != staged || e["unstaged"] != unstaged {
			t.Errorf("%s = %v, want %q/%q", path, e, staged, unstaged)
		}
	}
	check("a.txt", "M", "M")
	check("del.txt", "", "D")
	check("new name.txt", "R", "")
	check("dir/untracked.md", "", "?")
	if by["new name.txt"]["orig"] != "old.txt" {
		t.Errorf("rename orig = %v", by["new name.txt"])
	}
	if _, ok := by["keep.txt"]; ok {
		t.Error("unchanged file listed")
	}

	code, d := gx.get(t, "diff", url.Values{"path": {"a.txt"}, "staged": {"1"}})
	if code != 200 || strings.Join(diffLines(d), ",") != "ctx:one,add:staged" {
		t.Errorf("staged a.txt = %d %v", code, diffLines(d))
	}
	code, d = gx.get(t, "diff", url.Values{"path": {"a.txt"}})
	if code != 200 || strings.Join(diffLines(d), ",") != "ctx:one,ctx:staged,add:worktree" {
		t.Errorf("unstaged a.txt = %d %v", code, diffLines(d))
	}
	code, d = gx.get(t, "diff", url.Values{"path": {"del.txt"}})
	if code != 200 || strings.Join(diffLines(d), ",") != "del:d" {
		t.Errorf("deleted = %d %v", code, diffLines(d))
	}
	code, d = gx.get(t, "diff", url.Values{"path": {"new name.txt"}, "orig": {"old.txt"}, "staged": {"1"}})
	if code != 200 || len(diffLines(d)) != 0 || d["path"] != "new name.txt" {
		t.Errorf("pure rename = %d %v", code, d)
	}
	code, d = gx.get(t, "diff", url.Values{"path": {"dir/untracked.md"}})
	if code != 200 || strings.Join(diffLines(d), ",") != "add:u1,add:u2" {
		t.Errorf("untracked = %d %v", code, d)
	}

	// Only what git status lists, on the side it lists it.
	for name, q := range map[string]url.Values{
		"unchanged":        {"path": {"keep.txt"}},
		"unstaged rename":  {"path": {"new name.txt"}, "orig": {"old.txt"}},
		"staged untracked": {"path": {"dir/untracked.md"}, "staged": {"1"}},
		"wrong orig":       {"path": {"new name.txt"}, "orig": {"keep.txt"}, "staged": {"1"}},
		"option injection": {"path": {"--output=" + filepath.Join(r, "pwned")}},
		"outside root":     {"path": {"../x"}},
		"pathspec magic":   {"path": {":(glob)*"}},
	} {
		if code, body := gx.get(t, "diff", q); code != http.StatusNotFound {
			t.Errorf("%s = %d %v, want 404", name, code, body)
		}
	}
	if _, err := os.Stat(filepath.Join(r, "pwned")); err == nil {
		t.Error("--output path was written")
	}
}

func TestFilesDiffSensitiveRename(t *testing.T) {
	gx := newGitFixture(t)
	shared := "A=1\nB=2\nC=3\nD=4\nE=5\n"
	writeFile(t, filepath.Join(gx.repo, ".env"), shared+"TOKEN=secret\n")
	gitT(t, gx.repo, "add", ".")
	gitT(t, gx.repo, "commit", "-q", "-m", "env")
	gitT(t, gx.repo, "mv", ".env", "plain.txt")
	writeFile(t, filepath.Join(gx.repo, "plain.txt"), shared+"TOKEN=changed\n")
	gitT(t, gx.repo, "add", ".")
	_, by := gx.changes(t)
	if e := by["plain.txt"]; e == nil || e["sensitive"] != true || e["orig"] != ".env" {
		t.Fatalf("renamed .env = %v", by)
	}
	q := url.Values{"path": {"plain.txt"}, "orig": {".env"}, "staged": {"1"}}
	rec := serve(gx.h, apiRequest("GET", "/api/mux/panes/0/files/diff?"+q.Encode(), ""))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "TOKEN") || !strings.Contains(rec.Body.String(), `"sensitive":true`) {
		t.Errorf("without reveal = %d %s", rec.Code, rec.Body.String())
	}
	q.Set("reveal", "1")
	if code, d := gx.get(t, "diff", q); code != 200 || !strings.Contains(strings.Join(diffLines(d), ","), "del:TOKEN=secret") {
		t.Errorf("with reveal = %d %v", code, diffLines(d))
	}
}

func TestFilesDiffConflictBinaryTruncated(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	gitT(t, r, "checkout", "-q", "-b", "other")
	writeFile(t, filepath.Join(r, "a.txt"), "theirs\n")
	gitT(t, r, "commit", "-q", "-am", "theirs")
	gitT(t, r, "checkout", "-q", "main")
	writeFile(t, filepath.Join(r, "a.txt"), "ours\n")
	gitT(t, r, "commit", "-q", "-am", "ours")
	exec.Command("git", "-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "other").Run()

	writeFile(t, filepath.Join(r, "bin.dat"), "\x00\x01\x02")
	big := strings.Repeat("a line of a big file\n", (maxDiffOutput/20)+100)
	writeFile(t, filepath.Join(r, "big.txt"), big)
	gitT(t, r, "add", "bin.dat", "big.txt")

	_, by := gx.changes(t)
	if e := by["a.txt"]; e == nil || e["conflict"] != true {
		t.Fatalf("conflict = %v", by)
	}
	code, d := gx.get(t, "diff", url.Values{"path": {"a.txt"}})
	if code != 200 || d["conflict"] != true || !strings.Contains(strings.Join(diffLines(d), ","), "add:<<<<<<<") {
		t.Errorf("conflict diff = %d %v", code, d)
	}
	if code, d = gx.get(t, "diff", url.Values{"path": {"bin.dat"}, "staged": {"1"}}); code != 200 || d["binary"] != true {
		t.Errorf("binary = %d %v", code, d)
	}
	code, d = gx.get(t, "diff", url.Values{"path": {"big.txt"}, "staged": {"1"}})
	if code != 200 || d["truncated"] != true || len(diffLines(d)) == 0 {
		t.Errorf("big = %d truncated=%v lines=%d", code, d["truncated"], len(diffLines(d)))
	}
	// Untracked files that cannot be shown whole.
	writeFile(t, filepath.Join(r, "u.bin"), "\x00x")
	if err := os.WriteFile(filepath.Join(r, "u.log"), make([]byte, maxPreviewSize+1), 0o644); err != nil {
		t.Fatal(err)
	}
	gx.changes(t)
	if _, d = gx.get(t, "diff", url.Values{"path": {"u.bin"}}); d["binary"] != true {
		t.Errorf("untracked binary = %v", d)
	}
	if _, d = gx.get(t, "diff", url.Values{"path": {"u.log"}}); d["reason"] != "too-large" {
		t.Errorf("untracked large = %v", d)
	}
}

// git skips special files when it looks for untracked ones, so a FIFO never
// reaches the diff route (where it would be read whole, as not-regular).
func TestFilesUntrackedFIFONotListed(t *testing.T) {
	if _, err := exec.LookPath("mkfifo"); err != nil || runtime.GOOS == "windows" {
		t.Skip("needs mkfifo")
	}
	gx := newGitFixture(t)
	if err := exec.Command("mkfifo", filepath.Join(gx.repo, "pipe")).Run(); err != nil {
		t.Fatal(err)
	}
	if _, by := gx.changes(t); by["pipe"] != nil {
		t.Errorf("FIFO listed: %v", by["pipe"])
	}
	if code, _ := gx.get(t, "diff", url.Values{"path": {"pipe"}}); code != http.StatusNotFound {
		t.Errorf("diff of a FIFO = %d, want 404", code)
	}
}

func TestFilesChangesEmptyRepoAndPlainDir(t *testing.T) {
	requireGit(t)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	gitT(t, dir, "init", "-q")
	writeFile(t, filepath.Join(dir, "first.txt"), "1\n")
	gitT(t, dir, "add", ".")
	gx := &gitFixture{repo: dir, h: newTestHandler(t, &filesFakeMux{dir: dir, files: true})}
	_, by := gx.changes(t)
	if by["first.txt"]["staged"] != "A" {
		t.Errorf("unborn branch = %v", by)
	}
	if code, d := gx.get(t, "diff", url.Values{"path": {"first.txt"}, "staged": {"1"}}); code != 200 || strings.Join(diffLines(d), ",") != "add:1" {
		t.Errorf("diff on unborn branch = %d %v", code, d)
	}

	plain, _ := filepath.EvalSymlinks(t.TempDir())
	px := &gitFixture{repo: plain, h: newTestHandler(t, &filesFakeMux{dir: plain, files: true})}
	code, body := px.get(t, "changes", nil)
	if code != 200 || body["isRepo"] != false || len(body["entries"].([]any)) != 0 {
		t.Errorf("plain dir changes = %d %v", code, body)
	}
	if code, _ := px.get(t, "diff", url.Values{"path": {"x"}}); code != http.StatusNotFound {
		t.Errorf("plain dir diff = %d", code)
	}
}

// diff.external, a textconv driver and a clean filter in the repo config:
// changes and diff through the routes run none of them.
func TestFilesGitRoutesDoNotRunRepoPrograms(t *testing.T) {
	requireUnixShell(t)
	gx := newGitFixture(t)
	r := gx.repo
	writeFile(t, filepath.Join(r, ".gitattributes"), "*.txt diff=conv filter=evil\n")
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "attrs")
	marker := filepath.Join(t.TempDir(), "ran")
	evil := writeScript(t, "touch "+marker+"; cat")
	gitT(t, r, "config", "diff.external", evil)
	gitT(t, r, "config", "diff.conv.textconv", evil)
	gitT(t, r, "config", "diff.conv.command", evil)
	gitT(t, r, "config", "filter.evil.clean", evil)
	writeFile(t, filepath.Join(r, "a.txt"), "changed\n")
	later := time.Now().Add(time.Minute)
	os.Chtimes(filepath.Join(r, "a.txt"), later, later)

	_, by := gx.changes(t)
	if by["a.txt"] == nil {
		t.Fatalf("a.txt not listed: %v", by)
	}
	if code, d := gx.get(t, "diff", url.Values{"path": {"a.txt"}}); code != 200 || !strings.Contains(strings.Join(diffLines(d), ","), "add:changed") {
		t.Errorf("diff = %d %v", code, d)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a program from the repo config ran")
	}
}

// A file whose stat changed but whose contents match the index makes git
// diff refresh the index, which runs the repo's post-index-change hook.
// Through the routes, no hook runs; the same diff without the overrides does.
func TestFilesGitRoutesDoNotRunRepoHooks(t *testing.T) {
	requireUnixShell(t)
	gx := newGitFixture(t)
	r := gx.repo
	marker := filepath.Join(t.TempDir(), "ran")
	gitDir := strings.TrimSpace(gitT(t, r, "rev-parse", "--absolute-git-dir"))
	hook := filepath.Join(gitDir, "hooks", "post-index-change")
	os.MkdirAll(filepath.Dir(hook), 0o755)
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ntouch "+marker+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	a := filepath.Join(r, "a.txt")
	writeFile(t, a, "two\n")
	if _, by := gx.changes(t); by["a.txt"] == nil {
		t.Fatalf("a.txt not listed: %v", by)
	}
	// Back to the index contents with a new mtime, while the listing that
	// still shows a.txt is cached: only its stat differs now.
	writeFile(t, a, "one\n")
	later := time.Now().Add(time.Minute)
	os.Chtimes(a, later, later)

	gx.get(t, "diff", url.Values{"path": {"a.txt"}})
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a repo hook ran")
	}
	cmd := exec.Command("git", "--no-pager", "diff")
	cmd.Dir = r
	cmd.Run()
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("control: a plain git diff did not run the hook, so the test proves nothing")
	}
}

// A git directory inside the root that is not named .git (git init
// --separate-git-dir) is never served: its config can hold a remote's token.
func TestFilesSeparateGitDirDenied(t *testing.T) {
	requireGit(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gitT(t, root, "init", "-q", "--separate-git-dir="+filepath.Join(root, "meta"))
	gitT(t, root, "config", "remote.origin.url", "https://token@example.com/x")
	writeFile(t, filepath.Join(root, "a.txt"), "one\n")
	h := newTestHandler(t, &filesFakeMux{dir: root, files: true})
	for _, route := range []string{"content?path=meta/config", "tree?path=meta", "tree?path=meta/refs"} {
		rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/"+route, ""))
		if rec.Code != http.StatusForbidden || strings.Contains(rec.Body.String(), "token@") {
			t.Errorf("%s = %d %s", route, rec.Code, rec.Body.String())
		}
	}
	if rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/content?path=a.txt", "")); rec.Code != http.StatusOK {
		t.Errorf("a.txt = %d %s", rec.Code, rec.Body.String())
	}
}

// An untracked symlink to a sensitive file is flagged in the list, and its
// diff (the file read whole) needs reveal=1.
func TestFilesDiffSensitiveSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	gx := newGitFixture(t)
	writeFile(t, filepath.Join(gx.repo, ".env"), "TOKEN=topsecret\n")
	if err := os.Symlink(".env", filepath.Join(gx.repo, "notes.txt")); err != nil {
		t.Fatal(err)
	}
	_, by := gx.changes(t)
	if e := by["notes.txt"]; e == nil || e["sensitive"] != true {
		t.Fatalf("notes.txt -> .env = %v", by["notes.txt"])
	}
	rec := serve(gx.h, apiRequest("GET", "/api/mux/panes/0/files/diff?path=notes.txt", ""))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "topsecret") || !strings.Contains(rec.Body.String(), `"sensitive":true`) {
		t.Errorf("diff without reveal = %d %s", rec.Code, rec.Body.String())
	}
}

// A partial clone whose promisor remote runs core.sshCommand: a diff that
// needs a missing blob would fetch it lazily. Through the routes, nothing
// runs; the same diff without the overrides does run it.
func TestFilesGitRoutesDoNotLazyFetch(t *testing.T) {
	requireUnixShell(t)
	gx := newGitFixture(t)
	r := gx.repo
	oid := strings.TrimSpace(gitT(t, r, "rev-parse", "HEAD:a.txt"))
	gitDir := strings.TrimSpace(gitT(t, r, "rev-parse", "--absolute-git-dir"))
	if err := os.Remove(filepath.Join(gitDir, "objects", oid[:2], oid[2:])); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "ran")
	evil := writeScript(t, "touch "+marker+"; exit 1")
	for _, kv := range [][2]string{
		{"core.repositoryformatversion", "1"}, {"extensions.partialClone", "origin"},
		{"remote.origin.url", "ssh://h/x"}, {"remote.origin.promisor", "true"}, {"core.sshCommand", evil},
	} {
		gitT(t, r, "config", kv[0], kv[1])
	}
	writeFile(t, filepath.Join(r, "a.txt"), "two\n")

	gx.changes(t)
	gx.get(t, "diff", url.Values{"path": {"a.txt"}})
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("lazy fetch ran the repo's core.sshCommand")
	}
	cmd := exec.Command("git", "--no-pager", "diff", "--", "a.txt")
	cmd.Dir = r
	cmd.Run()
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("control: a plain git diff did not lazy fetch, so the test proves nothing")
	}
}

func TestFilesDiffDenied(t *testing.T) {
	gx := newGitFixture(t)
	deny := filepath.Join(gx.repo, "cfg")
	writeFile(t, filepath.Join(deny, "secret"), "k\n")
	cfg := testConfig(t)
	cfg.FilesDenyDirs = []string{deny}
	h, _, err := buildServer(cfg, &filesFakeMux{dir: gx.repo, files: true})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(filesRootTTL)
	rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/diff?path=cfg/secret&reveal=1", ""))
	if rec.Code != http.StatusForbidden {
		t.Errorf("denied untracked = %d %s", rec.Code, rec.Body.String())
	}
	f := &filesAPI{deny: []string{deny}}
	if !f.deniedPath(gx.repo, "cfg/secret") || !f.deniedPath(gx.repo, "../x") || f.deniedPath(gx.repo, "a.txt") {
		t.Error("deniedPath")
	}
}

func TestFilesChangesGitFailure(t *testing.T) {
	requireUnixShell(t)
	gx := newGitFixture(t)
	f := registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: gx.repo, files: true}, hostAllowlist{}, nil)
	f.git.bin = writeScript(t, "exit 1")
	if _, err := f.status(t.Context(), filesRoot{Root: gx.repo, IsRepo: true}); err == nil {
		t.Error("failing git status: no error")
	}
	if _, err := f.diff(t.Context(), filesRoot{Root: gx.repo, IsRepo: true}, "a.txt", "", false, false); err == nil {
		t.Error("diff with failing status: no error")
	}
}
