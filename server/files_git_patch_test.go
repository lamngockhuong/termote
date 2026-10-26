package main

import (
	"bytes"
	"errors"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestQuoteC(t *testing.T) {
	for _, s := range []string{"a/x.txt", "a/new name.txt", `a/q"t\b.txt`, "a/ä.txt", "a/tab\there\n", "a/\x7f"} {
		q := quoteC(s)
		if !strings.HasPrefix(q, `"`) || strings.ContainsAny(q[1:len(q)-1], "\t\n\x7fä") {
			t.Errorf("quoteC(%q) = %s", s, q)
		}
		if u, ok := unquoteC(q); !ok || u != s {
			t.Errorf("unquoteC(quoteC(%q)) = %q %v", s, u, ok)
		}
	}
	if q := quoteC("a/ä"); q != `"a/\303\244"` {
		t.Errorf("octal = %s", q)
	}
	if u, ok := unquoteC(`"\a\b\f\n\r\t\v"`); !ok || u != "\a\b\f\n\r\t\v" {
		t.Errorf("named escapes = %q %v", u, ok)
	}
	for _, bad := range []string{``, `"`, `"x`, `x"`, `"\"`, `"\9xx"`, `"\30"`} {
		if _, ok := unquoteC(bad); ok {
			t.Errorf("unquoteC(%s) ok", bad)
		}
	}
}

func TestDiffName(t *testing.T) {
	for in, want := range map[string]string{
		"a/x.txt":                  "a/x.txt",
		"a/new name.txt\t":         "a/new name.txt",
		`"a/\303\244.txt"`:         "a/ä.txt",
		`"a/q\"t.txt"`:             `a/q"t.txt`,
		`"a/broken\9.txt"`:         "",
		"/dev/null":                "/dev/null",
		`"a/tab\there.txt"` + "\t": "a/tab\there.txt",
	} {
		if got := diffName(in); got != want {
			t.Errorf("diffName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHunkPatch(t *testing.T) {
	head := []string{"diff --git a/x y b/x y", "index 1..2 100644", "--- a/x y\t", "+++ b/x y\t"}
	raw := "@@ -1 +1 @@\n-a\n+b\n"
	if !hunkHeadOK(head, "x y") {
		t.Error("plain change refused")
	}
	want := "diff --git \"a/x y\" \"b/x y\"\n--- \"a/x y\"\n+++ \"b/x y\"\n" + raw
	if p := hunkPatch(raw, "x y"); string(p) != want {
		t.Errorf("patch = %q", p)
	}
	// A hunk without its last line break still ends with one.
	if p := hunkPatch(strings.TrimSuffix(raw, "\n"), "x y"); !strings.HasSuffix(string(p), "+b\n") {
		t.Errorf("no final newline = %q", p)
	}
	for name, c := range map[string]struct {
		head []string
		path string
	}{
		"other file":    {head, "x"},
		"noprefix":      {[]string{"diff --git x y x y", "--- x y", "+++ x y"}, "x y"},
		"mode change":   {append([]string{"old mode 100644", "new mode 100755"}, head...), "x y"},
		"rename":        {[]string{"diff --git a/o b/n", "similarity index 90%", "rename from o", "rename to n", "--- a/o", "+++ b/n"}, "n"},
		"bad quoting":   {[]string{`--- "a/x\9"`, `+++ "b/x\9"`}, "x"},
		"missing names": {[]string{"diff --git a/x b/x"}, "x"},
	} {
		if hunkHeadOK(c.head, c.path) {
			t.Errorf("%s allowed", name)
		}
	}
	if hunkID("a") == hunkID("b") || len(hunkID("a")) != 64 {
		t.Error("hunkID does not tell hunks apart")
	}
}

// hunkOf parses the one hunk of a diff fragment.
func hunkOf(t *testing.T, text string) diffHunk {
	t.Helper()
	hunks, _, _ := parseUnifiedDiff([]byte(text))
	if len(hunks) != 1 {
		t.Fatalf("hunks of %q = %d", text, len(hunks))
	}
	return hunks[0]
}

func TestReverseHunk(t *testing.T) {
	for _, c := range []struct {
		name, cur, diff, want string
		stale                 bool
	}{
		{name: "middle", cur: "a\nB\nc\n", diff: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n", want: "a\nb\nc\n"},
		{name: "start", cur: "new\na\n", diff: "@@ -1 +1,2 @@\n+new\n a\n", want: "a\n"},
		{name: "end added", cur: "a\nb\n", diff: "@@ -1 +1,2 @@\n a\n+b\n", want: "a\n"},
		{name: "autocrlf", cur: "a\r\nB\r\nc\r\n", diff: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n", want: "a\r\nb\r\nc\r\n"},
		{name: "crlf in index", cur: "a\r\nB\r\n", diff: "@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n", want: "a\r\nb\r\n"},
		{name: "mixed eol", cur: "a\r\nB\n", diff: "@@ -1,2 +1,2 @@\n a\n-b\n+B\n", stale: true},
		{name: "nul", cur: "a\x00\n", diff: "@@ -1 +1 @@\n-b\n+a\x00\n", stale: true},
		{name: "added no newline", cur: "a\nb", diff: "@@ -1 +1,2 @@\n a\n+b\n\\ No newline at end of file\n", want: "a\n"},
		{name: "removed no newline", cur: "a\nb\n", diff: "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n", want: "a\nb"},
		{name: "both no newline", cur: "a\nB", diff: "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n", want: "a\nb"},
		{name: "emptied", cur: "", diff: "@@ -1,2 +0,0 @@\n-a\n-b\n", want: "a\nb\n"},
		{name: "all removed", cur: "a\nb\n", diff: "@@ -0,0 +1,2 @@\n+a\n+b\n", want: ""},
		{name: "removed at end", cur: "a\n", diff: "@@ -1,2 +1 @@\n a\n-b\n", want: "a\nb\n"},
		{name: "line differs", cur: "a\nX\nc\n", diff: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n", stale: true},
		{name: "past the end", cur: "a\n", diff: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n", stale: true},
		{name: "newline now there", cur: "a\nb\n", diff: "@@ -1 +1,2 @@\n a\n+b\n\\ No newline at end of file\n", stale: true},
		{name: "newline now gone", cur: "a\nb", diff: "@@ -1 +1,2 @@\n a\n+b\n", stale: true},
		{name: "no newline not at end", cur: "a\nb\nc\n", diff: "@@ -1,2 +1,2 @@\n a\n-x\n\\ No newline at end of file\n+b\n", stale: true},
		{name: "removed after unterminated", cur: "a", diff: "@@ -2 +1,0 @@\n-b\n", stale: true},
	} {
		got, err := reverseHunk([]byte(c.cur), hunkOf(t, c.diff))
		if c.stale {
			if !errors.Is(err, errStaleHunk) {
				t.Errorf("%s: err = %v, got %q", c.name, err, got)
			}
			continue
		}
		if err != nil || string(got) != c.want {
			t.Errorf("%s = %q, %v; want %q", c.name, got, err, c.want)
		}
		if bytes.Contains(got, []byte("\r\r\n")) {
			t.Errorf("%s wrote \\r\\r\\n", c.name)
		}
	}
	if _, err := reverseHunk([]byte("a\n"), diffHunk{Header: "@@ bad"}); !errors.Is(err, errStaleHunk) {
		t.Errorf("bad header = %v", err)
	}
	// A hunk whose lines disagree with its header.
	if _, err := reverseHunk([]byte("a\n"), diffHunk{Header: "@@ -1 +1,2 @@", Lines: []diffLine{{Kind: "ctx", Text: "a"}}}); !errors.Is(err, errStaleHunk) {
		t.Errorf("short hunk = %v", err)
	}
}

// patchFixture is a repo behind a filesAPI called directly.
type patchFixture struct {
	repo string
	f    *filesAPI
}

func newPatchFixture(t *testing.T) *patchFixture {
	t.Helper()
	requireGit(t)
	repo := newTestRepo(t)
	f := registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: repo, files: true}, hostAllowlist{}, nil)
	return &patchFixture{repo: repo, f: f}
}

func (px *patchFixture) diff(t *testing.T, path, orig string, staged bool) diffResponse {
	t.Helper()
	px.f.forgetRoot(px.repo)
	res, err := px.f.diff(t.Context(), filesRoot{Root: px.repo, IsRepo: true}, path, orig, staged, true)
	if err != nil {
		t.Fatalf("diff %s: %v", path, err)
	}
	return res
}

// TestReverseHunkMatchesGitApply undoes each hunk in Go and with git apply -R
// on the same worktree, for each way a file's line breaks reach the diff.
func TestReverseHunkMatchesGitApply(t *testing.T) {
	px := newPatchFixture(t)
	r := px.repo
	lf := "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\nlast"
	worktree := "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\nlast\nmore\n"
	for _, c := range []struct {
		name, config, index, work string
	}{
		{"lf", "", lf, worktree},
		{"autocrlf", "true", lf, strings.ReplaceAll(worktree, "\n", "\r\n")},
		{"crlf in index", "false", strings.ReplaceAll(lf, "\n", "\r\n"), strings.ReplaceAll(worktree, "\n", "\r\n")},
	} {
		t.Run(c.name, func(t *testing.T) {
			if c.config != "" {
				gitT(t, r, "config", "core.autocrlf", c.config)
			}
			name := strings.ReplaceAll(c.name, " ", "-") + ".txt"
			p := filepath.Join(r, name)
			writeFile(t, p, c.index)
			gitT(t, r, "add", name)
			gitT(t, r, "commit", "-q", "-m", c.name)
			writeFile(t, p, c.work)
			d := px.diff(t, name, "", false)
			if len(d.Hunks) != 2 {
				t.Fatalf("hunks = %+v", d.Hunks)
			}
			for _, h := range d.Hunks {
				if h.ID == "" {
					t.Fatalf("hunk without id: %+v", h)
				}
				got, err := reverseHunk([]byte(c.work), h)
				if err != nil {
					t.Fatalf("reverseHunk %s: %v", h.Header, err)
				}
				patch := hunkPatch(h.raw, name)
				cmd := exec.Command("git", "-C", r, "apply", "-R", "-p1", "-")
				cmd.Stdin = bytes.NewReader(patch)
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("git apply -R: %v\n%s\n%s", err, out, patch)
				}
				want, _ := os.ReadFile(p)
				writeFile(t, p, c.work)
				if !bytes.Equal(got, want) {
					t.Errorf("%s: Go %q\ngit %q", h.Header, got, want)
				}
				if bytes.Contains(got, []byte("\r\r\n")) {
					t.Errorf("%s wrote \\r\\r\\n", h.Header)
				}
			}
		})
	}
}

func TestDiffHunkIDs(t *testing.T) {
	px := newPatchFixture(t)
	r := px.repo
	// The user's diff.noprefix does not reach the patch's names.
	writeFile(t, filepath.Join(os.Getenv("HOME"), ".gitconfig"), "[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n")
	writeFile(t, filepath.Join(r, "old.txt"), "same content for a rename\n")
	writeFile(t, filepath.Join(r, "bin.dat"), "\x00a")
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "more")

	writeFile(t, filepath.Join(r, "a.txt"), "one\ntwo\n")
	d := px.diff(t, "a.txt", "", false)
	if len(d.Hunks) != 1 || d.Hunks[0].ID == "" || d.head[2] != "--- a/a.txt" {
		t.Errorf("modified = %+v head %q", d.Hunks, d.head)
	}
	if d.WorktreeHash != diskHash(t, filepath.Join(r, "a.txt")) {
		t.Errorf("worktreeHash = %q", d.WorktreeHash)
	}
	gitT(t, r, "add", "a.txt")
	if d := px.diff(t, "a.txt", "", true); len(d.Hunks) != 1 || d.Hunks[0].ID == "" || d.WorktreeHash != "" {
		t.Errorf("staged = %+v %q", d.Hunks, d.WorktreeHash)
	}

	gitT(t, r, "mv", "old.txt", "new.txt")
	writeFile(t, filepath.Join(r, "bin.dat"), "\x00b")
	for name, d := range map[string]diffResponse{
		"rename": px.diff(t, "new.txt", "old.txt", true),
		"binary": px.diff(t, "bin.dat", "", false),
	} {
		for _, h := range d.Hunks {
			if h.ID != "" {
				t.Errorf("%s hunk has an id", name)
			}
		}
	}
	big := strings.Repeat("a line of a big file\n", (maxDiffOutput/20)+100)
	writeFile(t, filepath.Join(r, "big.txt"), big)
	gitT(t, r, "add", "big.txt")
	if d := px.diff(t, "big.txt", "", true); !d.Truncated || len(d.Hunks) == 0 || d.Hunks[0].ID != "" {
		t.Errorf("truncated = %v %d", d.Truncated, len(d.Hunks))
	}
	writeFile(t, filepath.Join(r, "big.txt"), big+"more\n")
	if d := px.diff(t, "big.txt", "", false); d.WorktreeHash != "" {
		t.Errorf("hash of a file past the limit = %q", d.WorktreeHash)
	}

	if runtime.GOOS != "windows" {
		gitT(t, r, "commit", "-q", "-m", "x")
		writeFile(t, filepath.Join(r, "a.txt"), "one\ntwo\nthree\n")
		os.Chmod(filepath.Join(r, "a.txt"), 0o755)
		if d := px.diff(t, "a.txt", "", false); len(d.Hunks) != 1 || d.Hunks[0].ID != "" {
			t.Errorf("mode change = %+v", d.Hunks)
		}
	}
}

func TestWorktreeHash(t *testing.T) {
	dir := plainDir(t)
	writeFile(t, filepath.Join(dir, "a"), "x")
	os.Mkdir(filepath.Join(dir, "d"), 0o755)
	if h := worktreeHash(dir, "a"); h != hashHex([]byte("x")) {
		t.Errorf("file = %q", h)
	}
	for _, rel := range []string{"missing", "d"} {
		if h := worktreeHash(dir, rel); h != "" {
			t.Errorf("%s = %q", rel, h)
		}
	}
	if h := worktreeHash(filepath.Join(dir, "gone"), "a"); h != "" {
		t.Errorf("missing root = %q", h)
	}
}

func TestHunksApply(t *testing.T) {
	m := func(letter, from, to string) bool {
		return hunksApply(&changeEntry{Unstaged: letter, modeIndex: from, modeWorktree: to}, false)
	}
	if !m("M", "100644", "100644") || !m("M", "100755", "100755") {
		t.Error("plain change refused")
	}
	if m("M", "100644", "100755") || m("M", "120000", "120000") || m("D", "100644", "000000") || m("T", "100644", "120000") {
		t.Error("mode change, symlink, delete or type change allowed")
	}
	if hunksApply(&changeEntry{Staged: "M", Orig: "o", modeHead: "100644", modeIndex: "100644"}, true) {
		t.Error("entry with a source allowed")
	}
	if !hunksApply(&changeEntry{Staged: "M", modeHead: "100644", modeIndex: "100644"}, true) {
		t.Error("staged change refused")
	}
}

func TestDiffResponseJSON(t *testing.T) {
	// head and raw stay on the server.
	gx := newGitFixture(t)
	writeFile(t, filepath.Join(gx.repo, "a.txt"), "two\n")
	gx.changes(t)
	code, d := gx.get(t, "diff", url.Values{"path": {"a.txt"}})
	h := d["hunks"].([]any)[0].(map[string]any)
	if code != 200 || h["id"] == nil || h["raw"] != nil || d["head"] != nil || d["worktreeHash"] == nil {
		t.Errorf("diff = %d %v", code, d)
	}
}
