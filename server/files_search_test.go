package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"regexp/syntax"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// search runs a files/search on fx.
func (fx *findFixture) search(t *testing.T, q url.Values) (int, map[string]any) {
	t.Helper()
	rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/0/files/search?"+q.Encode(), ""))
	return rec.Code, decodeBody(t, rec)
}

// searchOK runs a search that must succeed.
func (fx *findFixture) searchOK(t *testing.T, q url.Values) searchResponse {
	t.Helper()
	rec := serve(fx.h, apiRequest("GET", "/api/mux/panes/0/files/search?"+q.Encode(), ""))
	return decodeSearch(t, rec.Code, rec.Body.Bytes())
}

func decodeSearch(t *testing.T, code int, body []byte) searchResponse {
	t.Helper()
	var res searchResponse
	if code != http.StatusOK || json.Unmarshal(body, &res) != nil {
		t.Fatalf("search = %d %s", code, body)
	}
	return res
}

// searchPaths are the paths of a response, in its order.
func searchPaths(res searchResponse) []string {
	var out []string
	for _, f := range res.Files {
		out = append(out, f.Path)
	}
	return out
}

func TestSearchRegexp(t *testing.T) {
	for _, c := range []struct {
		q                string
		regex, cas, word bool
		yes, no          []string
	}{
		{"foo", false, false, false, []string{"a FOO b", "food"}, []string{"fo o"}},
		{"Foo", false, true, false, []string{"Foo"}, []string{"foo"}},
		{"foo", false, false, true, []string{"x foo y", "foo"}, []string{"food", "_foo"}},
		// \b only on a side that ends in a word character.
		{"foo(", false, false, true, []string{"x foo( y", "foo(("}, []string{"xfoo("}},
		{"(foo", false, false, true, []string{"((foo y"}, []string{"(food"}},
		{"-e foo", false, false, false, []string{"run -e foo"}, []string{"-e"}},
		{"--help", false, false, false, []string{"cmd --help"}, []string{"-help"}},
		{"a.c", false, false, false, []string{"a.c"}, []string{"abc"}},
		{" lead", false, false, false, []string{"x lead"}, []string{"xlead"}},
		{"ne+dle", true, false, false, []string{"neeedle"}, []string{"ne+dle"}},
		{"a|b", true, false, true, []string{"x a y", "b"}, []string{"ab"}},
	} {
		re, err := searchRegexp(c.q, c.regex, c.cas, c.word)
		if err != nil {
			t.Fatalf("%q: %v", c.q, err)
		}
		for _, s := range c.yes {
			if !re.MatchString(s) {
				t.Errorf("%q (%+v) misses %q", c.q, c, s)
			}
		}
		for _, s := range c.no {
			if re.MatchString(s) {
				t.Errorf("%q (%+v) matches %q", c.q, c, s)
			}
		}
	}
	// Invalid alone, whatever wrapping would make of it; too large a
	// program; invalid UTF-8.
	for _, c := range []struct {
		q           string
		regex, word bool
	}{
		{"a)|(b", true, true}, {"a)|(b", true, false}, {"(", true, false}, {`\`, true, false},
		{`(?i)[\pL\pN]{1000}Z`, true, false}, {"a{1001}", true, false}, {"\xff", false, false},
	} {
		if _, err := searchRegexp(c.q, c.regex, false, c.word); err != errSearchInvalidRegex {
			t.Errorf("%q: %v", c.q, err)
		}
	}
	// A regex that can match empty text is refused, wrapped or not.
	for _, q := range []string{"a*", "x*|foo", "^", `\b`, "(?:)", "a{0,3}", "(a|)", `^$`, "(a?)+"} {
		for _, word := range []bool{false, true} {
			if _, err := searchRegexp(q, true, false, word); err != errSearchEmptyMatch {
				t.Errorf("%q word=%v: %v", q, word, err)
			}
		}
	}
	for _, q := range []string{"a+", "^a", `\bfoo\b`, "a{1,3}", "(a|b)c?", "[^x]", ".", `a\z`} {
		if _, err := searchRegexp(q, true, false, false); err != nil {
			t.Errorf("%q: %v", q, err)
		}
	}
	if matchesEmpty(&syntax.Regexp{Op: syntax.OpNoMatch}) || !matchesEmpty(&syntax.Regexp{Op: syntax.OpLiteral}) {
		t.Error("no match, empty literal")
	}
	// \Q without \E is wrapped as what it parsed to.
	re, err := searchRegexp(`\Qa.b`, true, false, true)
	if err != nil || !re.MatchString("x a.b y") || re.MatchString("xa.b") || re.MatchString("a-b") {
		t.Errorf(`\Q word = %v`, err)
	}
}

func TestParseSearchQuery(t *testing.T) {
	in, err := parseSearchQuery(url.Values{
		"q": {"  x  "}, "files": {"*.go", "src/"}, "skip": {"*_test.go"}, "exclude": {"dist", "vendor"}, "fresh": {"1"},
	})
	if err != nil || !in.fresh || len(in.files) != 2 || len(in.skip) != 1 || in.find.excludeKey != "dist\x00vendor" {
		t.Fatalf("parse = %+v, %v", in, err)
	}
	// Not trimmed: the spaces are searched.
	if !in.re.MatchString("a  x  b") || in.re.MatchString("a x b") {
		t.Error("q trimmed")
	}
	for _, c := range []struct {
		v    url.Values
		want error
	}{
		{url.Values{}, errFindQueryRequired},
		{url.Values{"q": {strings.Repeat("x", findMaxQuery+1)}}, errFindQueryTooLong},
		{url.Values{"q": {"x"}, "exclude": {"a/b"}}, errFindInvalidExclude},
		{url.Values{"q": {"x"}, "files": {"["}}, errSearchInvalidGlob},
		{url.Values{"q": {"x"}, "skip": {"a//b"}}, errSearchInvalidGlob},
		{url.Values{"q": {"("}, "regex": {"1"}}, errSearchInvalidRegex},
	} {
		if _, err := parseSearchQuery(c.v); err != c.want {
			t.Errorf("%v: %v, want %v", c.v, err, c.want)
		}
	}
	if in, err := parseSearchQuery(url.Values{"q": {"("}}); err != nil || !in.re.MatchString("f(") {
		t.Errorf("literal ( = %v", err)
	}
}

func TestSearchLines(t *testing.T) {
	ctx := context.Background()
	re := regexp.MustCompile("foo")
	m, more, cut, stopped := searchLines(ctx, re, []byte("a\r\nfoo bar\r\nx\nfoo"))
	if len(m) != 2 || more != 0 || cut || stopped || m[0].Line != 2 || m[0].Text != "foo bar" || m[1].Line != 4 || m[1].Text != "foo" {
		t.Errorf("lines = %+v", m)
	}
	// Ranges count UTF-16 units: é is one, 😀 two.
	m, _, _, _ = searchLines(ctx, re, []byte("é😀foo foo"))
	if !slices.Equal(m[0].Ranges, [][2]int{{3, 6}, {7, 10}}) || m[0].Col != 0 {
		t.Errorf("utf16 = %+v", m[0])
	}
	if m, _, _, _ := searchLines(ctx, regexp.MustCompile("a+"), []byte("baaa")); len(m) != 1 || !slices.Equal(m[0].Ranges, [][2]int{{1, 4}}) {
		t.Errorf("a+ = %+v", m)
	}
	if m, _, _, _ := searchLines(ctx, re, nil); len(m) != 0 {
		t.Errorf("empty file = %+v", m)
	}

	// A long line: a window around its first match.
	line := strings.Repeat("x", 300) + "foo" + strings.Repeat("y", 100)
	m, _, _, _ = searchLines(ctx, re, []byte(line))
	if m[0].Col != 163 || len([]rune(m[0].Text)) != searchLineWindow || !slices.Equal(m[0].Ranges, [][2]int{{137, 140}}) {
		t.Errorf("window = col %d len %d %v", m[0].Col, len(m[0].Text), m[0].Ranges)
	}
	// A cut line: matches past the window dropped, and one across its end
	// is not looked for without the text after it.
	line = "foo" + strings.Repeat("x", 235) + "foofoo" + strings.Repeat("y", 300) + "foo"
	m, _, _, _ = searchLines(ctx, regexp.MustCompile("foo|xfoof"), []byte(line))
	if m[0].Col != 0 || !slices.Equal(m[0].Ranges, [][2]int{{0, 3}}) {
		t.Errorf("cut window = col %d %v", m[0].Col, m[0].Ranges)
	}
	// A first match longer than the window is clipped to it.
	line = strings.Repeat("a", 300) + strings.Repeat("b", 250)
	m, _, _, _ = searchLines(ctx, regexp.MustCompile("b+"), []byte(line))
	if m[0].Col != 260 || !slices.Equal(m[0].Ranges, [][2]int{{40, 240}}) {
		t.Errorf("clip = col %d %v", m[0].Col, m[0].Ranges)
	}
	// Other matches of a cut line are found in the window after the first.
	line = strings.Repeat("x", 300) + "foo foo" + strings.Repeat("y", 100)
	m, _, _, _ = searchLines(ctx, re, []byte(line))
	if !slices.Equal(m[0].Ranges, [][2]int{{133, 136}, {137, 140}}) {
		t.Errorf("cut, two = %v", m[0].Ranges)
	}
	// A window near the end of a long line starts earlier to stay full.
	line = "😀" + strings.Repeat("x", 299) + "foo"
	m, _, _, _ = searchLines(ctx, re, []byte(line))
	if m[0].Col != 2+(300-1-searchLineWindow+3) || !slices.Equal(m[0].Ranges, [][2]int{{searchLineWindow - 3, searchLineWindow}}) {
		t.Errorf("end window = col %d %v", m[0].Col, m[0].Ranges)
	}

	// Past searchMaxLine the line is cut, on a rune boundary.
	setFindHook(t, &searchMaxLine, 10)
	m, _, cut, _ = searchLines(ctx, re, []byte("aaaaaaaaa€foo\nfoo\n"))
	if !cut || len(m) != 1 || m[0].Line != 2 {
		t.Errorf("cut = %v %+v", cut, m)
	}
	m, _, cut, _ = searchLines(ctx, regexp.MustCompile("a€"), []byte("aaaaaaaaa€"))
	if !cut || len(m) != 0 {
		t.Errorf("cut rune = %v %+v", cut, m)
	}
	setFindHook(t, &searchMaxLine, 16<<10)

	// Per file: the first searchMaxPerFile lines, and how many more.
	setFindHook(t, &searchMaxPerFile, 2)
	m, more, _, _ = searchLines(ctx, re, []byte(strings.Repeat("foo\nbar\n", 5)))
	if len(m) != 2 || more != 3 || m[1].Line != 3 {
		t.Errorf("per file = %+v more %d", m, more)
	}
	done, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, _, stopped := searchLines(done, re, []byte("foo\n")); !stopped {
		t.Error("cancelled scan not stopped")
	}
}

func TestFilesSearchRepo(t *testing.T) {
	requireGit(t)
	r := newTestRepo(t)
	writeFile(t, filepath.Join(r, ".gitignore"), "build/\n")
	writeFile(t, filepath.Join(r, "src", "b.go"), "package src\n// needle one\nx\n")
	writeFile(t, filepath.Join(r, "Z.txt"), "needle\n")
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "files")
	writeFile(t, filepath.Join(r, "notes.txt"), "untracked needle\n")
	writeFile(t, filepath.Join(r, "build", "out.txt"), "ignored needle\n")
	writeFile(t, filepath.Join(r, ".env"), "TOKEN=needle\n")
	writeFile(t, filepath.Join(r, "bin.dat"), "needle\x00\n")
	writeFile(t, filepath.Join(r, "big.txt"), "needle\n"+strings.Repeat("x", maxPreviewSize))
	writeFile(t, filepath.Join(r, "latin1.txt"), "needle \xe9\n")
	writeFile(t, filepath.Join(r, "cfg", "secret.txt"), "deny needle\n")
	outside := plainDir(t)
	writeFile(t, filepath.Join(outside, "o.txt"), "outside needle\n")
	if runtime.GOOS != "windows" {
		for link, to := range map[string]string{"link_deny": "cfg/secret.txt", "link_out": filepath.Join(outside, "o.txt"), "link_ok": "Z.txt"} {
			if err := os.Symlink(to, filepath.Join(r, link)); err != nil {
				t.Fatal(err)
			}
		}
	}
	fx := newFindFixture(t, r, filepath.Join(r, "cfg"))
	res := fx.searchOK(t, url.Values{"q": {"needle"}})
	want := []string{"Z.txt", "notes.txt", "src/b.go"}
	if runtime.GOOS != "windows" {
		want = []string{"Z.txt", "link_ok", "notes.txt", "src/b.go"}
	}
	if !slices.Equal(searchPaths(res), want) {
		t.Errorf("paths = %q\nwant %q", searchPaths(res), want)
	}
	if res.Root != r || !res.IsRepo || res.Truncated || res.Incomplete {
		t.Errorf("header = %+v", res)
	}
	if res.Skipped != (searchSkipped{Sensitive: 1, Binary: 2, TooLarge: 1}) {
		t.Errorf("skipped = %+v", res.Skipped)
	}
	b := res.Files[len(res.Files)-1]
	if len(b.Matches) != 1 || b.Matches[0].Line != 2 || b.Matches[0].Text != "// needle one" || !slices.Equal(b.Matches[0].Ranges, [][2]int{{3, 9}}) {
		t.Errorf("src/b.go = %+v", b)
	}

	// Options.
	for _, c := range []struct {
		q    url.Values
		want []string
	}{
		{url.Values{"q": {"NEEDLE"}}, want},
		{url.Values{"q": {"NEEDLE"}, "case": {"1"}}, nil},
		{url.Values{"q": {"needl"}, "word": {"1"}}, nil},
		{url.Values{"q": {"untracked needle"}, "word": {"1"}}, []string{"notes.txt"}},
		{url.Values{"q": {"^needle$"}, "regex": {"1"}}, []string{"Z.txt", "link_ok"}},
		{url.Values{"q": {"needle"}, "files": {"*.go"}}, []string{"src/b.go"}},
		{url.Values{"q": {"needle"}, "files": {"src/"}, "skip": {"*.go"}}, nil},
		{url.Values{"q": {"needle"}, "skip": {"*.txt", "link_*"}}, []string{"src/b.go"}},
	} {
		w := c.want
		if runtime.GOOS == "windows" {
			w = slices.DeleteFunc(slices.Clone(w), func(p string) bool { return strings.HasPrefix(p, "link_") })
		}
		if got := searchPaths(fx.searchOK(t, c.q)); !slices.Equal(got, w) {
			t.Errorf("%v = %q, want %q", c.q, got, w)
		}
	}

	// A query starting with '-' is text.
	writeFile(t, filepath.Join(r, "src", "b.go"), "run --help\n")
	if got := searchPaths(fx.searchOK(t, url.Values{"q": {"--help"}})); !slices.Equal(got, []string{"src/b.go"}) {
		t.Errorf("--help = %q", got)
	}

	code, body := fx.search(t, url.Values{"q": {"x*"}, "regex": {"1"}})
	if code != http.StatusBadRequest || body["code"] != "empty_match" {
		t.Errorf("empty match = %d %v", code, body)
	}
	code, body = fx.search(t, url.Values{"q": {"a)|(b"}, "regex": {"1"}})
	if code != http.StatusBadRequest || body["code"] != "invalid_regex" || body["error"] != errSearchInvalidRegex.msg {
		t.Errorf("invalid regex = %d %v", code, body)
	}
}

// Outside a repo the list is find's walk: an excluded name is never read,
// and the list is the one find built with the same names.
func TestFilesSearchOutsideRepo(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, "a.txt"), "needle\n")
	writeFile(t, filepath.Join(root, nodeModules, "m.js"), "needle\n")
	writeFile(t, filepath.Join(root, ".git", "config"), "needle\n")
	ageTree(t, root)
	fx := newFindFixture(t, root)
	var mu sync.Mutex
	builds := 0
	setFindHook(t, &findBeforeBuild, func(string) {
		mu.Lock()
		builds++
		mu.Unlock()
	})
	neverReads(t, nodeModules)
	fx.findOK(t, url.Values{"q": {"a"}, "exclude": {nodeModules}})
	res := fx.searchOK(t, url.Values{"q": {"needle"}, "exclude": {nodeModules}})
	if !slices.Equal(searchPaths(res), []string{"a.txt"}) || res.IsRepo {
		t.Errorf("paths = %q", searchPaths(res))
	}
	mu.Lock()
	defer mu.Unlock()
	if builds != 1 {
		t.Errorf("list built %d times, want 1", builds)
	}
}

// A root holding the home dir: dot-paths are never read, and counted.
func TestFilesSearchHome(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, ".bash_history"), "export TOKEN=needle\n")
	writeFile(t, filepath.Join(root, ".config", "x", "y.txt"), "needle\n")
	writeFile(t, filepath.Join(root, "a.txt"), "needle\n")
	fx := newFindFixture(t, root)
	t.Setenv("HOME", root)
	t.Setenv("USERPROFILE", root)
	hidden := 2
	if runtime.GOOS != "windows" {
		// A link of an ordinary name to a dot-file is not read either
		if err := os.Symlink(".bash_history", filepath.Join(root, "notes")); err != nil {
			t.Fatal(err)
		}
		hidden = 3
	}
	res := fx.searchOK(t, url.Values{"q": {"needle"}})
	if !slices.Equal(searchPaths(res), []string{"a.txt"}) || res.Skipped.Hidden != hidden {
		t.Errorf("home = %q %+v", searchPaths(res), res.Skipped)
	}
	elsewhere := plainDir(t)
	t.Setenv("HOME", elsewhere)
	t.Setenv("USERPROFILE", elsewhere)
	if res := fx.searchOK(t, url.Values{"q": {"needle"}, "fresh": {"1"}}); len(res.Files) != hidden+1 || res.Skipped.Hidden != 0 {
		t.Errorf("not home = %q %+v", searchPaths(res), res.Skipped)
	}
}

func TestFilesSearchCaps(t *testing.T) {
	root := plainDir(t)
	for _, n := range []string{"a.txt", "b.txt", "c.txt"} {
		writeFile(t, filepath.Join(root, n), "hit\nhit\nhit\n")
	}
	fx := newFindFixture(t, root)
	setFindHook(t, &searchMaxPerFile, 2)
	setFindHook(t, &searchMaxMatches, 5)
	res := fx.searchOK(t, url.Values{"q": {"hit"}})
	if !res.Truncated || res.Incomplete || len(res.Files) != 3 || res.Files[0].More != 1 || len(res.Files[2].Matches) != 1 {
		t.Errorf("caps = %+v", res)
	}
	// Exactly at the cap: not truncated.
	setFindHook(t, &searchMaxMatches, 6)
	if res := fx.searchOK(t, url.Values{"q": {"hit"}}); res.Truncated || len(res.Files) != 3 {
		t.Errorf("at the cap = %+v", res)
	}
	// The cap reached before a file that also matches.
	setFindHook(t, &searchMaxMatches, 4)
	if res := fx.searchOK(t, url.Values{"q": {"hit"}}); !res.Truncated || len(res.Files) != 2 {
		t.Errorf("cap between files = %+v", res)
	}
	setFindHook(t, &searchMaxMatches, 2000)
	// Byte budget: spent by the first files read, at most one per worker.
	many := plainDir(t)
	for i := range searchWorkers + 2 {
		writeFile(t, filepath.Join(many, strings.Repeat("f", i+1)), "hit\n")
	}
	setFindHook(t, &searchMaxBytes, 1)
	if res := newFindFixture(t, many).searchOK(t, url.Values{"q": {"hit"}}); !res.Incomplete || len(res.Files) > searchWorkers {
		t.Errorf("bytes = %+v", res)
	}
	setFindHook(t, &searchMaxBytes, 256<<20)
	// Time budget.
	setFindHook(t, &searchTimeout, 0)
	if res := fx.searchOK(t, url.Values{"q": {"hit"}}); !res.Incomplete || len(res.Files) != 0 {
		t.Errorf("time = %+v", res)
	}
	setFindHook(t, &searchTimeout, 5*time.Second)
	// A list cut short.
	setFindHook(t, &findMaxPaths, 1)
	if res := fx.searchOK(t, url.Values{"q": {"hit"}, "fresh": {"1"}}); !res.Incomplete || len(res.Files) != 1 {
		t.Errorf("list cut = %+v", res)
	}
}

// A heavy regex on long lines stops at the time budget.
func TestFilesSearchWorstCaseRegex(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, "a.txt"), strings.Repeat(strings.Repeat("a", 16<<10-1)+"\n", 63))
	fx := newFindFixture(t, root)
	setFindHook(t, &searchTimeout, 200*time.Millisecond)
	start := time.Now()
	res := fx.searchOK(t, url.Values{"q": {`(?i)[\pL\pN]{150}Z`}, "regex": {"1"}})
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("took %v", d)
	}
	if len(res.Files) != 0 {
		t.Errorf("worst case = %+v", res)
	}
}

// A pattern matching a long line many times, or a long literal without
// case on lines it almost matches, stops at the time budget.
func TestFilesSearchWorstCaseMatches(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, "a.txt"), strings.Repeat(strings.Repeat("a", 16<<10-1)+"\n", 63))
	fx := newFindFixture(t, root)
	setFindHook(t, &searchTimeout, 200*time.Millisecond)
	for _, q := range []url.Values{
		{"q": {"a.*b|a"}, "regex": {"1"}},
		{"q": {"(?:a.*b|a.*c|a.*d|a.*e|a.*f|a.*g|a.*h|a.*i)|a"}, "regex": {"1"}},
		{"q": {strings.Repeat("a", 255) + "b"}},
	} {
		start := time.Now()
		fx.searchOK(t, q)
		if d := time.Since(start); d > 2*time.Second {
			t.Errorf("%v took %v", q, d)
		}
	}
}

// The scan's deadline is kept short of the request's, and one already past
// answers what was found with incomplete set.
func TestFilesSearchDeadline(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, "a.txt"), "hit\n")
	f := &filesAPI{}
	req := &filesRequest{ctx: context.Background(), root: filesRoot{Root: root}}
	list := findList{entries: []findEntry{newFindEntry("a.txt", false)}}
	in, _ := parseSearchQuery(url.Values{"q": {"hit"}})
	res, wait, err := f.searchList(context.Background(), time.Now().Add(-time.Second), req, list, in)
	wait()
	if err != nil || !res.Incomplete || len(res.Files) != 0 {
		t.Errorf("past deadline = %+v %v", res, err)
	}
	res, wait, err = f.searchList(context.Background(), time.Now().Add(time.Minute), req, list, in)
	wait()
	if err != nil || res.Incomplete || len(res.Files) != 1 {
		t.Errorf("in time = %+v %v", res, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	d, _ := ctx.Deadline()
	if got := searchDeadline(ctx, time.Now()); !got.Equal(d.Add(-searchDeadlineMargin)) {
		t.Errorf("deadline = %v, want %v", got, d.Add(-searchDeadlineMargin))
	}
	now := time.Now()
	if got := searchDeadline(context.Background(), now); !got.Equal(now.Add(searchTimeout)) {
		t.Errorf("no request deadline = %v", got)
	}
	if _, _, err := f.searchList(context.Background(), now, &filesRequest{root: filesRoot{Root: filepath.Join(root, "gone")}}, list, in); err == nil {
		t.Error("missing root: no error")
	}
}

// A client that leaves gets nothing, and no worker outlives the request.
func TestFilesSearchClientLeaves(t *testing.T) {
	root := plainDir(t)
	for _, n := range []string{"a.txt", "b.txt", "c.txt", "d.txt", "e.txt"} {
		writeFile(t, filepath.Join(root, n), "hit\n")
	}
	fx := newFindFixture(t, root)
	fx.searchOK(t, url.Values{"q": {"hit"}}) // builds the list
	base := runtime.NumGoroutine()
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	setFindHook(t, &searchBeforeFile, func(string) {
		once.Do(func() { close(entered) })
		<-release
	})
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan string)
	go func() {
		req := apiRequest("GET", "/api/mux/panes/0/files/search?q=hit", "").WithContext(ctx)
		got <- serve(fx.h, req).Body.String()
	}()
	<-entered
	cancel()
	close(release)
	if body := <-got; body != "" {
		t.Errorf("body = %q", body)
	}
	for i := 0; runtime.NumGoroutine() > base; i++ {
		if i == 200 {
			t.Fatalf("goroutines = %d, want %d", runtime.NumGoroutine(), base)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestFilesSearchBusyAndGuards(t *testing.T) {
	root := plainDir(t)
	writeFile(t, filepath.Join(root, "a.txt"), "hit\n")
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: root, files: true}, hostAllowlist{}, nil)
	for range searchMaxRunning {
		f.searchSlots <- struct{}{}
	}
	rec := serve(mux, apiRequest("GET", "/api/mux/panes/0/files/search?q=hit", ""))
	if rec.Code != http.StatusTooManyRequests || decodeBody(t, rec)["code"] != "busy" {
		t.Errorf("busy = %d %s", rec.Code, rec.Body)
	}
	<-f.searchSlots
	if rec := serve(mux, apiRequest("GET", "/api/mux/panes/0/files/search?q=hit", "")); rec.Code != http.StatusOK {
		t.Errorf("one slot free = %d %s", rec.Code, rec.Body)
	}

	fx := newFindFixture(t, root)
	for _, c := range []struct {
		name string
		req  *http.Request
		want int
		code string
	}{
		{"post", apiRequest("POST", "/api/mux/panes/0/files/search?q=a", "{}"), http.StatusMethodNotAllowed, ""},
		{"no q", apiRequest("GET", "/api/mux/panes/0/files/search", ""), http.StatusBadRequest, ""},
		{"bad glob", apiRequest("GET", "/api/mux/panes/0/files/search?q=a&files=%5B", ""), http.StatusBadRequest, "invalid_glob"},
		{"bad exclude", apiRequest("GET", "/api/mux/panes/0/files/search?q=a&exclude=a/b", ""), http.StatusBadRequest, "invalid_exclude"},
		{"root moved", apiRequest("GET", "/api/mux/panes/0/files/search?q=a&root=/elsewhere", ""), http.StatusConflict, ""},
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
	cross := apiRequest("GET", "/api/mux/panes/0/files/search?q=a", "")
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(fx.h, cross); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
}

// A git failure while the list is built is an error, never an empty result.
func TestFilesSearchListFails(t *testing.T) {
	requireUnixShell(t)
	requireGit(t)
	r := newTestRepo(t)
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: r, files: true}, hostAllowlist{}, nil)
	f.git.bin = writeScript(t, `case "$*" in *" -co "*) exit 1;; esac; exec git "$@"`)
	if rec := serve(mux, apiRequest("GET", "/api/mux/panes/0/files/search?q=a", "")); rec.Code != http.StatusInternalServerError {
		t.Errorf("list fails = %d %s", rec.Code, rec.Body)
	}
}
