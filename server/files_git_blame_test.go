package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// blameOf reads files/blame for path with the hash of its bytes on disk.
func (gx *gitFixture) blameOf(t *testing.T, path string, q url.Values) (int, map[string]any) {
	t.Helper()
	if q == nil {
		q = url.Values{}
	}
	q.Set("path", path)
	if !q.Has("hash") {
		b, _ := os.ReadFile(filepath.Join(gx.repo, filepath.FromSlash(path)))
		q.Set("hash", hashHex(b))
	}
	return gx.get(t, "blame", q)
}

// blameRuns renders ranges and uncommitted runs as "start+count:author" in
// line order ("-" for not committed).
func blameRuns(t *testing.T, body map[string]any) string {
	t.Helper()
	var res blameResponse
	b, _ := json.Marshal(body)
	if err := json.Unmarshal(b, &res); err != nil {
		t.Fatal(err)
	}
	runs := map[int]string{}
	for _, r := range res.Ranges {
		runs[r.Start] = fmt.Sprintf("%d+%d:%s", r.Start, r.Count, res.Commits[r.Commit].Author)
	}
	for _, r := range res.Uncommitted {
		runs[r.Start] = fmt.Sprintf("%d+%d:-", r.Start, r.Count)
	}
	var out []string
	for i := 1; i <= res.Lines; i++ {
		if s, ok := runs[i]; ok {
			out = append(out, s)
		}
	}
	return strings.Join(out, ",")
}

func gitAs(t *testing.T, dir, name string, args ...string) {
	t.Helper()
	gitT(t, dir, append([]string{"-c", "user.name=" + name, "-c", "user.email=" + strings.ToLower(name) + "@x"}, args...)...)
}

func TestFilesBlame(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	writeFile(t, filepath.Join(r, "f.txt"), "a\nb\nc\nd\n")
	gitT(t, r, "add", ".")
	gitAs(t, r, "Alice", "commit", "-q", "-m", "first\n\nbody")
	writeFile(t, filepath.Join(r, "f.txt"), "a\nB\nC\nd\n")
	gitAs(t, r, "Bob", "commit", "-q", "-am", "second")
	// Not committed: a changed line and one more without a final newline
	writeFile(t, filepath.Join(r, "f.txt"), "a\nB\nx\nd\ntail")

	code, body := gx.blameOf(t, "f.txt", nil)
	if code != 200 {
		t.Fatalf("blame = %d %v", code, body)
	}
	if got := blameRuns(t, body); got != "1+1:Alice,2+1:Bob,3+1:-,4+1:Alice,5+1:-" {
		t.Errorf("runs = %s", got)
	}
	if body["lines"] != 5.0 || body["path"] != "f.txt" || body["root"] != r {
		t.Errorf("body = %v", body)
	}
	commits := body["commits"].(map[string]any)
	if len(commits) != 2 {
		t.Errorf("commits = %v", commits)
	}
	for h, c := range commits {
		m := c.(map[string]any)
		if !commitHashRe.MatchString(h) || m["time"].(float64) < 1 || m["email"] != nil {
			t.Errorf("commit %s = %v", h, m)
		}
		if m["author"] == "Alice" && m["summary"] != "first" {
			t.Errorf("summary = %v", m["summary"])
		}
	}
	// No line text, no e-mail in the answer
	rec := serve(gx.h, apiRequest("GET", "/api/mux/panes/0/files/blame?"+url.Values{"path": {"f.txt"}, "hash": {hashHex([]byte("a\nB\nx\nd\ntail"))}}.Encode(), ""))
	if s := rec.Body.String(); strings.Contains(s, "tail") || strings.Contains(s, "@x") {
		t.Errorf("leaks = %s", s)
	}

	// Committed as is: adjacent runs of a commit merge
	writeFile(t, filepath.Join(r, "g.txt"), "1\n2\n3\n")
	gitT(t, r, "add", ".")
	gitAs(t, r, "Carol", "commit", "-q", "-m", "g")
	if _, body := gx.blameOf(t, "g.txt", nil); blameRuns(t, body) != "1+3:Carol" {
		t.Errorf("merged = %s", blameRuns(t, body))
	}
	// An empty committed file
	writeFile(t, filepath.Join(r, "empty.txt"), "")
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "empty")
	if code, body := gx.blameOf(t, "empty.txt", nil); code != 200 || body["lines"] != 0.0 {
		t.Errorf("empty = %d %v", code, body)
	}
	// A symlink inside the root: the target's history
	if err := os.Symlink("g.txt", filepath.Join(r, "link.txt")); err == nil {
		if _, body := gx.blameOf(t, "link.txt", nil); blameRuns(t, body) != "1+3:Carol" || body["path"] != "link.txt" {
			t.Errorf("link = %v", body)
		}
	}
}

func TestFilesBlameRefusals(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	writeFile(t, filepath.Join(r, "new.txt"), "n\n")
	for name, tc := range map[string]struct {
		path string
		q    url.Values
		code int
		err  string
	}{
		"untracked": {"new.txt", nil, 404, "not_tracked"},
		"changed":   {"a.txt", url.Values{"hash": {hashHex([]byte("other"))}}, 409, "file_changed"},
		"no hash":   {"a.txt", url.Values{"hash": {""}}, 400, ""},
		"missing":   {"gone.txt", url.Values{"hash": {"x"}}, 404, ""},
		"git dir":   {".git/config", nil, 403, ""},
		"climbs":    {"../x", url.Values{"hash": {"x"}}, 400, ""},
		"root":      {"", url.Values{"hash": {"x"}}, 404, ""},
		"dot":       {".", url.Values{"hash": {"x"}}, 404, ""},
	} {
		code, body := gx.blameOf(t, tc.path, tc.q)
		if code != tc.code || tc.err != "" && body["code"] != tc.err {
			t.Errorf("%s = %d %v, want %d %s", name, code, body, tc.code, tc.err)
		}
		if s := fmt.Sprint(body); strings.Contains(s, "fatal") || strings.Contains(s, "HEAD:") {
			t.Errorf("%s leaks git text: %s", name, s)
		}
	}
	// A directory under the root is no file to blame
	os.Mkdir(filepath.Join(r, "dir"), 0o755)
	if code, _ := gx.blameOf(t, "dir", url.Values{"hash": {"x"}}); code != 404 {
		t.Errorf("dir = %d", code)
	}
	// Too large: refused before anything is hashed or run
	big := strings.Repeat("x\n", maxPreviewSize/2+1)
	writeFile(t, filepath.Join(r, "big.txt"), big)
	if code, body := gx.blameOf(t, "big.txt", nil); code != 413 || body["code"] != "too_large" {
		t.Errorf("big = %d %v", code, body)
	}

	// Not a repo
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	writeFile(t, filepath.Join(dir, "a.txt"), "a\n")
	plain := &gitFixture{repo: dir, h: newTestHandler(t, &filesFakeMux{dir: dir, files: true})}
	if code, body := plain.blameOf(t, "a.txt", nil); code != 404 || body["code"] != "not_repo" {
		t.Errorf("not a repo = %d %v", code, body)
	}
	// Unborn HEAD
	unborn, _ := filepath.EvalSymlinks(t.TempDir())
	gitT(t, unborn, "init", "-q")
	writeFile(t, filepath.Join(unborn, "a.txt"), "a\n")
	ux := &gitFixture{repo: unborn, h: newTestHandler(t, &filesFakeMux{dir: unborn, files: true})}
	if code, body := ux.blameOf(t, "a.txt", nil); code != 404 || body["code"] != "not_tracked" {
		t.Errorf("unborn = %d %v", code, body)
	}
}

// The encoding the client decodes with does not matter: git counts the
// lines of the bytes, which the client compares with the lines it shows.
func TestFilesBlameUTF16(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	utf16 := []byte{0xFF, 0xFE, 'a', 0, '\n', 0, 'b', 0, '\n', 0}
	if err := os.WriteFile(filepath.Join(r, "u.txt"), utf16, 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "utf16")
	code, body := gx.blameOf(t, "u.txt", nil)
	if code != 200 || body["lines"] != 3.0 {
		t.Errorf("utf16 = %d %v", code, body)
	}
}

func TestFilesBlameSensitiveDeniedAndViewOnly(t *testing.T) {
	gx := newGitFixture(t)
	deny := filepath.Join(gx.repo, "cfg")
	writeFile(t, filepath.Join(gx.repo, ".env"), "TOKEN=secret\n")
	writeFile(t, filepath.Join(deny, "secret"), "k\n")
	writeFile(t, filepath.Join(gx.repo, ".gitignore"), "ignored.txt\n")
	writeFile(t, filepath.Join(gx.repo, "ignored.txt"), "i\n")
	gitT(t, gx.repo, "add", ".")
	gitT(t, gx.repo, "commit", "-q", "-m", "env")
	cfg := testConfig(t)
	cfg.FilesDenyDirs = []string{deny}
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: gx.repo, files: true})
	if err != nil {
		t.Fatal(err)
	}
	gx.h = h

	if code, body := gx.blameOf(t, "cfg/secret", nil); code != http.StatusForbidden {
		t.Errorf("denied = %d %v", code, body)
	}
	code, body := gx.blameOf(t, ".env", nil)
	if code != 200 || body["sensitive"] != true || body["ranges"] != nil {
		t.Errorf("sensitive = %d %v", code, body)
	}
	// Not revealed: no answer tells whether a guessed hash matches
	if code, body := gx.blameOf(t, ".env", url.Values{"hash": {"x"}}); code != 200 || body["sensitive"] != true {
		t.Errorf("sensitive, wrong hash = %d %v", code, body)
	}
	if code, body := gx.blameOf(t, ".env", url.Values{"reveal": {"1"}}); code != 200 || body["lines"] != 1.0 {
		t.Errorf("revealed = %d %v", code, body)
	}

	_, vh := viewFilesFixture(t, gx.repo)
	const base = "/api/mux/panes/0/files/blame?"
	view := func(p string, extra url.Values) int {
		b, _ := os.ReadFile(filepath.Join(gx.repo, p))
		q := url.Values{"path": {p}, "hash": {hashHex(b)}}
		for k, v := range extra {
			q[k] = v
		}
		return serve(vh, viewRequest("GET", base+q.Encode(), "")).Code
	}
	if code := view("a.txt", nil); code != 200 {
		t.Errorf("view tracked = %d", code)
	}
	if code := view("ignored.txt", nil); code != 404 {
		t.Errorf("view ignored = %d", code)
	}
	if code := view(".env", url.Values{"reveal": {"1"}}); code != http.StatusForbidden {
		t.Errorf("view reveal = %d", code)
	}
}

// A textconv driver and a clean filter in the repo config never run, and an
// ignore-revs file the config names but that is missing breaks nothing.
func TestFilesBlameDoesNotRunRepoPrograms(t *testing.T) {
	requireUnixShell(t)
	gx := newGitFixture(t)
	r := gx.repo
	writeFile(t, filepath.Join(r, ".gitattributes"), "*.txt diff=conv filter=evil\n")
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "attrs")
	marker := filepath.Join(t.TempDir(), "ran")
	evil := writeScript(t, "touch "+marker+"; cat")
	gitT(t, r, "config", "diff.conv.textconv", evil)
	gitT(t, r, "config", "filter.evil.clean", evil)
	gitT(t, r, "config", "filter.evil.process", evil)
	gitT(t, r, "config", "blame.ignoreRevsFile", ".missing-revs")
	writeFile(t, filepath.Join(r, "a.txt"), "one\nchanged\n")

	code, body := gx.blameOf(t, "a.txt", nil)
	if code != 200 || blameRuns(t, body) != "1+1:t,2+1:-" {
		t.Errorf("blame = %d %v", code, body)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a program from the repo config ran")
	}
}

// A file read through a link into another work tree is blamed there.
func TestFilesBlameLinkedWorktree(t *testing.T) {
	fx := newLinkedFixture(t)
	gitRun(t, fx.main, "add", "-A")
	gitRun(t, fx.main, "commit", "-q", "-m", "plans")
	b, _ := os.ReadFile(filepath.Join(fx.main, "plans", "plan.md"))
	q := url.Values{"path": {"plan.md"}, "hash": {hashHex(b)}}
	code, body := fx.get(t, fullRequest("/api/mux/panes/0/files/blame?"+q.Encode()))
	if code != 200 || body["lines"] != 1.0 || len(body["ranges"].([]any)) != 1 || body["path"] != "plan.md" {
		t.Errorf("linked = %d %v", code, body)
	}
	// Not into the main checkout's git dir
	q = url.Values{"path": {"config.md"}, "hash": {"x"}}
	if code, _ := fx.get(t, fullRequest("/api/mux/panes/0/files/blame?"+q.Encode())); code == 200 {
		t.Errorf("config.md = %d", code)
	}
}

// Trusted at the root (safe.directory): trusted in the other work tree too.
func TestFilesBlameLinkedSafeDir(t *testing.T) {
	fx := newLinkedFixture(t)
	gitRun(t, fx.main, "add", "-A")
	gitRun(t, fx.main, "commit", "-q", "-m", "plans")
	f := &filesAPI{git: newGitRunner(), roots: newRootResolver(newGitRunner())}
	root := filesRoot{Root: fx.wt, IsRepo: true, SafeDir: fx.wt, GitDir: filepath.Join(fx.main, ".git", "worktrees", "wt")}
	b, _ := os.ReadFile(filepath.Join(fx.main, "plans", "plan.md"))
	res, err := f.blame(t.Context(), root, "plan.md", hashHex(b), false, true)
	if br, ok := res.(*blameResponse); err != nil || !ok || br.Lines != 1 {
		t.Errorf("blame = %v %v", res, err)
	}
}

// git failing for a file HEAD holds is an internal error, never not_tracked.
func TestFilesBlameGitFailure(t *testing.T) {
	requireGit(t)
	repo := newTestRepo(t)
	g := newGitRunner()
	g.bin = writeFailingGit(t)
	f := &filesAPI{git: g, roots: newRootResolver(g)}
	b, _ := os.ReadFile(filepath.Join(repo, "a.txt"))
	_, err := f.blame(t.Context(), filesRoot{Root: repo, IsRepo: true}, "a.txt", hashHex(b), false, false)
	var ce *codedError
	if err == nil || errors.As(err, &ce) {
		t.Errorf("err = %v", err)
	}
	// Timed out: the runner's error
	g.timeout = time.Nanosecond
	g.bin = "git"
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	if _, err := f.blame(ctx, filesRoot{Root: repo, IsRepo: true}, "a.txt", hashHex(b), false, false); !errors.Is(err, errGitTimeout) {
		t.Errorf("timeout = %v", err)
	}
}

// Output past the cap, or output git should never print, is no answer.
func TestFilesBlameOutputCutOrBad(t *testing.T) {
	requireUnixShell(t)
	requireGit(t)
	repo := newTestRepo(t)
	g := newGitRunner()
	f := &filesAPI{git: g, roots: newRootResolver(g)}
	b, _ := os.ReadFile(filepath.Join(repo, "a.txt"))
	root := filesRoot{Root: repo, IsRepo: true}
	defer func(n int64) { maxBlameOutput = n }(maxBlameOutput)
	maxBlameOutput = 10
	if _, err := f.blame(t.Context(), root, "a.txt", hashHex(b), false, false); err != errBlameTooLarge {
		t.Errorf("cut = %v", err)
	}
	maxBlameOutput = 1 << 20
	g.bin = writeScript(t, `for a; do [ "$a" = blame ] && { echo garbage; exit 0; }; done; exec git "$@"`)
	if _, err := f.blame(t.Context(), root, "a.txt", hashHex(b), false, false); err == nil || err == errBlameTooLarge {
		t.Errorf("bad output = %v", err)
	}
	// The root is gone
	if _, err := f.blame(t.Context(), filesRoot{Root: filepath.Join(repo, "gone"), IsRepo: true}, "a.txt", "x", false, false); err == nil {
		t.Error("gone root: no error")
	}
}

func TestBlameRelPath(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	writeFile(t, filepath.Join(dir, "sub", "a.txt"), "a\n")
	if got := blameRelPath(dir, filepath.Join("sub", "a.txt")); got != "sub/a.txt" {
		t.Errorf("plain = %q", got)
	}
	if got := blameRelPath(dir, filepath.Join("sub", "missing")); got != "sub/missing" {
		t.Errorf("missing = %q", got)
	}
	if os.Symlink(filepath.Join(dir, "sub", "a.txt"), filepath.Join(dir, "in")) == nil {
		if got := blameRelPath(dir, "in"); got != "sub/a.txt" {
			t.Errorf("link in = %q", got)
		}
	}
	if os.Symlink(t.TempDir(), filepath.Join(dir, "out")) == nil {
		if got := blameRelPath(dir, "out"); got != "out" {
			t.Errorf("link out = %q", got)
		}
	}
}

// writeFailingGit is a git that blames nothing and fails, while answering
// the other commands as git does.
func writeFailingGit(t *testing.T) string {
	t.Helper()
	requireUnixShell(t)
	return writeScript(t, `for a; do [ "$a" = blame ] && exit 1; done; exec git "$@"`)
}

func TestParseBlame(t *testing.T) {
	h1, h2 := strings.Repeat("a", 40), strings.Repeat("b", 64)
	zero := strings.Repeat("0", 40)
	out := h1 + " 1 1 2\nauthor A\nauthor-mail <a@x>\nauthor-time 10\nsummary s1\nboundary\nfilename f\n" +
		zero + " 3 3 1\nauthor External file (--contents)\nsummary Version of f\nprevious " + h1 + " f\nfilename f\n" +
		h2 + " 4 4 1\nauthor B\nauthor-time 20\nsummary " + strings.Repeat("é", 400) + "\nfilename f\n" +
		h1 + " 5 5 1\nfilename f\n"
	res, err := parseBlame([]byte(out), 5)
	if err != nil {
		t.Fatal(err)
	}
	want := `[{1 2 ` + h1 + `} {4 1 ` + h2 + `} {5 1 ` + h1 + `}] [{3 1 }]`
	if got := fmt.Sprint(res.Ranges, " ", res.Uncommitted); strings.ReplaceAll(got, "  ", " ") != want {
		t.Errorf("ranges = %s, want %s", got, want)
	}
	if c := res.Commits[h1]; c.Author != "A" || c.Time != 10 || c.Summary != "s1" || len(res.Commits) != 2 {
		t.Errorf("commits = %v", res.Commits)
	}
	if s := res.Commits[h2].Summary; len(s) > maxBlameSummary || !strings.HasPrefix(s, "é") || strings.ToValidUTF8(s, "?") != s {
		t.Errorf("summary = %q", s)
	}
	for name, bad := range map[string]string{
		"header fields": h1 + " 1 1\nfilename f\n",
		"bad hash":      "xyz 1 1 1\nfilename f\n",
		"short hash":    strings.Repeat("a", 39) + " 1 1 1\nfilename f\n",
		"line zero":     h1 + " 1 0 1\nfilename f\n",
		"past the end":  h1 + " 1 2 9\nfilename f\n",
		"count zero":    h1 + " 1 1 0\nfilename f\n",
		"not a number":  h1 + " 1 x 1\nfilename f\n",
		"twice":         h1 + " 1 1 1\nfilename f\n" + h1 + " 1 1 1\nfilename f\n",
		"a line missed": h1 + " 1 1 1\nfilename f\n",
		"no filename":   h1 + " 1 1 2\nauthor A\n",
	} {
		if _, err := parseBlame([]byte(bad), 2); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	if res, err := parseBlame(nil, 0); err != nil || res.Lines != 0 || len(res.Ranges) != 0 {
		t.Errorf("empty = %v %v", res, err)
	}
}

func TestCountLinesAndTruncateRunes(t *testing.T) {
	for s, want := range map[string]int{"": 0, "a": 1, "a\n": 1, "a\nb": 2, "\n\n": 2, "a\r\nb\r\n": 2} {
		if got := countLines([]byte(s)); got != want {
			t.Errorf("countLines(%q) = %d, want %d", s, got, want)
		}
	}
	if got := truncateRunes("aé", 2); got != "a" {
		t.Errorf("truncateRunes = %q", got)
	}
	if got := truncateRunes("abc", 5); got != "abc" {
		t.Errorf("short = %q", got)
	}
}
