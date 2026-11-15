package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// On Windows a repository whose own config names a share is refused before
// git runs there: git opens an include, core.worktree and the rest as it
// starts. Elsewhere than Windows the temp dir is on no drive letter, so a
// Place holding it stands in for a local drive.
func TestResolveRefusesRepoConfigOffDrive(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the temp dir stands in for a drive only off Windows")
	}
	ctx := context.Background()
	repo := tempDirReal(t)
	gitInit(t, repo)
	roots := func(windows bool) *rootResolver {
		rr := newTestRoots()
		rr.windows = windows
		rr.placeDirs = []string{filepath.Dir(repo)}
		return rr
	}
	if r, err := roots(true).resolve(ctx, repo); err != nil || !r.IsRepo {
		t.Fatalf("clean repo: %+v %v", r, err)
	}
	appendFile(t, filepath.Join(repo, ".git", "config"), "[include]\n\tpath = //termote-test.invalid/s/x\n")
	if r, err := roots(true).resolve(ctx, repo); !errors.Is(err, errDirNotAvailable) {
		t.Fatalf("include off a drive: %+v %v", r, err)
	}
	if r, err := roots(false).resolve(ctx, repo); err != nil || !r.IsRepo {
		t.Fatalf("off Windows the config is not read: %+v %v", r, err)
	}
}

func TestParseGitConfig(t *testing.T) {
	e := func(section, sub, key, value string) gitConfigEntry { return gitConfigEntry{section, sub, key, value} }
	for _, c := range []struct {
		name, in string
		want     []gitConfigEntry
	}{
		{"plain", "[core]\n\tbare = false\n", []gitConfigEntry{e("core", "", "bare", "false")}},
		{"case and bare name", "[CoRe]\n  WorkTree\n", []gitConfigEntry{e("core", "", "worktree", "true")}},
		{"subsection", "[includeIf \"gitdir:C:/x/\"]\npath = a\n", []gitConfigEntry{e("includeif", "gitdir:C:/x/", "path", "a")}},
		{"subsection escapes", `[a "x\"y\\z"]` + "\nk=v\n", []gitConfigEntry{e("a", `x"y\z`, "k", "v")}},
		{"old subsection form", "[Branch.Main]\nk=v\n", []gitConfigEntry{e("branch", "main", "k", "v")}},
		{"variable on the header line", "[include] path = //h/s\n", []gitConfigEntry{e("include", "", "path", "//h/s")}},
		{"quoted with escapes", `[a]` + "\nk = \"\\\\\\\\h\\\\s\" \n", []gitConfigEntry{e("a", "", "k", `\\h\s`)}},
		{"inner blanks kept, ends trimmed", "[a]\nk =  x  y  \n", []gitConfigEntry{e("a", "", "k", "x  y")}},
		{"quoted blanks kept", "[a]\nk = \" x \"\n", []gitConfigEntry{e("a", "", "k", " x ")}},
		{"comments", "# c\n; c\n[a] ; c\nk = v # c\nj = \"v # not\" ; c\n", []gitConfigEntry{e("a", "", "k", "v"), e("a", "", "j", "v # not")}},
		{"continuation", "[a]\nk = //h/\\\ns\n", []gitConfigEntry{e("a", "", "k", "//h/s")}},
		{"CRLF and continuation", "[a]\r\nk = //h/\\\r\ns\r\n", []gitConfigEntry{e("a", "", "k", "//h/s")}},
		{"escapes", "[a]\nk = a\\tb\\nc\\bd\n", []gitConfigEntry{e("a", "", "k", "a\tb\nc\bd")}},
		{"BOM and no final newline", "\xef\xbb\xbf[a]\nk = v", []gitConfigEntry{e("a", "", "k", "v")}},
		{"empty value", "[a]\nk =\n", []gitConfigEntry{e("a", "", "k", "")}},
		{"a lone CR is a blank", "[a]\nk = a\rb\n", []gitConfigEntry{e("a", "", "k", "a b")}},
	} {
		got, err := parseGitConfig([]byte(c.in))
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %q = %+v %v, want %+v", c.name, c.in, got, err, c.want)
		}
	}
	for _, in := range []string{
		"k = v\n",         // outside a section
		"[a\nk=v\n",       // unterminated header
		"[]\n",            // empty name
		"[a_b]\n",         // bad name
		"[a \"x]\n",       // unterminated subsection
		"[a x]\n",         // subsection not quoted
		"[a \"x\" ]\n",    // junk after the subsection
		"[a]\nk = \"v\n",  // unterminated quote
		"[a]\nk = v\\q\n", // bad escape
		"[a]\nk = v\\",    // backslash at the end
		"[a]\nk_x = v\n",  // bad variable name
		"[a]\nk v = 1\n",  // blank inside a name
		"[a]\n=v\n",       // no name
		"[a]\n1k = v\n",   // name not led by a letter
	} {
		if got, err := parseGitConfig([]byte(in)); err == nil {
			t.Errorf("%q parsed as %+v", in, got)
		}
	}
}

// fakeRepo writes files (slash paths relative to a new temp dir, "" for a
// directory) and returns the dir.
func fakeRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := tempDirReal(t)
	for p, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(p))
		if strings.HasSuffix(p, "/") {
			if err := os.MkdirAll(full, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// gitDirFiles is a git directory under prefix that git takes as one.
func gitDirFiles(prefix, config string) map[string]string {
	return map[string]string{
		prefix + "HEAD": "ref: refs/heads/main\n", prefix + "objects/": "", prefix + "refs/": "", prefix + "config": config,
	}
}

func withFiles(m map[string]string, more ...string) map[string]string {
	for i := 0; i+1 < len(more); i += 2 {
		m[more[i]] = more[i+1]
	}
	return m
}

// Every file of a repository that names a path git opens is read as text,
// and one off a drive letter refuses the repository; the test itself does
// not depend on the OS, only where resolve calls it.
func TestRepoConfigRefused(t *testing.T) {
	const g = ".git/"
	cfg := func(s string) map[string]string { return gitDirFiles(g, "[core]\n\tbare = false\n"+s) }
	for _, c := range []struct {
		name    string
		files   map[string]string
		at      string // slash path under the repo, default its top
		refused bool
	}{
		{"clean", cfg(""), "", false},
		{"no repository", map[string]string{"a.txt": "x"}, "", false},
		{"include //", cfg("[include]\n\tpath = //h/s/x\n"), "", true},
		{"include \\\\ quoted", cfg("[include]\n\tpath = \"\\\\\\\\h\\\\s\\\\x\"\n"), "", true},
		{"include \\\\ plain", cfg("[include]\n\tpath = \\\\\\\\h\\\\s\n"), "", true},
		{"include optional", cfg("[include]\n\tpath = :(optional)//h/s/x\n"), "", true},
		{"includeIf", cfg("[includeIf \"gitdir:C:/r/\"]\n\tpath = //h/s/x\n"), "", true},
		{"includeIf onbranch, mixed case", cfg("[IncludeIf \"onbranch:main\"]\n\tPath = //h/s/x\n"), "", true},
		{"core.worktree", cfg("[core]\n\tworktree = //h/s\n"), "", true},
		{"core.excludesFile", cfg("[core]\n\texcludesFile = //h/s/ignore\n"), "", true},
		{"core.attributesFile", cfg("[CORE]\n\tATTRIBUTESFILE = //h/s/attr\n"), "", true},
		{"header line variable", cfg("[core] worktree = //h/s\n"), "", true},
		{"continued value", cfg("[core]\n\tworktree = //h/\\\ns\n"), "", true},
		{"device path", cfg("[core]\n\tworktree = //./pipe/x\n"), "", true},
		{"UNC long form", cfg("[core]\n\tworktree = //?/UNC/h/s\n"), "", true},
		{"drive in the long form", cfg("[core]\n\tworktree = //?/C:/r\n"), "", false},
		{"drive path", cfg("[core]\n\tworktree = C:/r\n\texcludesFile = ~/ignore\n[include]\n\tpath = %(prefix)/etc/x\n"), "", false},
		{"in a comment", cfg("# [include] path = //h/s\n; path = //h/s\n"), "", false},
		{"other keys", cfg("[remote \"o\"]\n\turl = //h/s\n[include \"x\"]\n\tpath = //h/s\n"), "", false},
		{"unparseable", cfg("[core\n"), "", true},
		{"local include", withFiles(cfg("[include]\n\tpath = ../more.cfg\n"), "more.cfg", "[include]\n\tpath = //h/s\n"), "", true},
		{"local include, clean", withFiles(cfg("[include]\n\tpath = ../more.cfg\n"), "more.cfg", "[a]\n\tk = v\n"), "", false},
		{"missing include", cfg("[include]\n\tpath = nowhere.cfg\n"), "", false},
		{"unparseable include", withFiles(cfg("[include]\n\tpath = ../more.cfg\n"), "more.cfg", "junk\n"), "", true},
		{"include loop", cfg("[include]\n\tpath = config\n"), "", true},
		{"config.worktree", withFiles(cfg(""), g+"config.worktree", "[core]\n\tworktree = //h/s\n"), "", true},
		{"from a subdirectory", withFiles(cfg("[include]\n\tpath = //h/s\n"), "a/b/", ""), "a/b", true},
		{"a decoy HEAD on the way up", withFiles(cfg("[include]\n\tpath = //h/s\n"), "a/HEAD", "x"), "a", true},
		{"gitfile off a drive", map[string]string{".git": "gitdir: //h/s/r\n"}, "", true},
		{"gitfile to a local git dir", withFiles(gitDirFiles("store/", "[include]\n\tpath = //h/s\n"), ".git", "gitdir: store\n"), "", true},
		{"gitfile to a clean git dir", withFiles(gitDirFiles("store/", ""), ".git", "gitdir: store\n"), "", false},
		{"commondir off a drive", withFiles(cfg(""), g+"commondir", "//h/s/common\n"), "", true},
		{"no HEAD: config never read", map[string]string{g + "config": "junk\n", g + "objects/": ""}, "", false},
		{"no HEAD: commondir still checked", map[string]string{g + "config": "junk\n", g + "commondir": "//h/s/c\n"}, "", true},
		{"commondir config", withFiles(gitDirFiles("main/", "[include]\n\tpath = //h/s\n"),
			".git", "gitdir: main/worktrees/w\n", "main/worktrees/w/HEAD", "ref: refs/heads/w\n",
			"main/worktrees/w/commondir", "../..\n"), "", true},
		{"alternates off a drive", withFiles(cfg(""), g+"objects/info/alternates", "C:/ok/objects\n//h/s/objects\n"), "", true},
		{"alternates quoted", withFiles(cfg(""), g+"objects/info/alternates", "\"\\\\\\\\h\\\\s\"\n"), "", true},
		{"alternates local", withFiles(cfg(""), g+"objects/info/alternates", "# note\n../../other/objects\n", "other/objects/info/alternates", "//h/s\n"), "", true},
		{"alternates clean", withFiles(cfg(""), g+"objects/info/alternates", "../../other/objects\n", "other/objects/", ""), "", false},
		{"linked worktree gitdir", withFiles(cfg(""), g+"worktrees/w/gitdir", "//h/s/w/.git\n"), "", true},
		{"linked worktree clean", withFiles(cfg(""), g+"worktrees/w/gitdir", "C:/w/.git\n"), "", false},
		{"inside a Place", cfg("[include]\n\tpath = //nas/share/x.cfg\n"), "", false},
		{"bare beside an empty .git", map[string]string{g: "", "HEAD": "ref: refs/heads/main\n", "objects/": "", "refs/": "",
			"config": "[include]\n\tpath = //h/s\n"}, "", true},
		{"bare beside a .git without HEAD", map[string]string{g + "objects/": "", "HEAD": "ref: refs/heads/main\n", "objects/": "",
			"refs/": "", "config": "[core]\n\tworktree = //h/s\n"}, "", true},
		{"include %(prefix) then a share", cfg("[include]\n\tpath = %(prefix)///h/s/x\n"), "", true},
		{"include %(prefix) then a share, backslashes", cfg("[include]\n\tpath = \"%(prefix)/\\\\\\\\h\\\\s\"\n"), "", true},
		{"mailmap.file", cfg("[mailmap]\n\tfile = //h/s/m\n"), "", true},
		{"diff.orderFile", cfg("[diff]\n\torderFile = //h/s/o\n"), "", true},
		{"NT path, backslashes", cfg("[core]\n\tworktree = \"\\\\??\\\\UNC\\\\h\\\\s\"\n"), "", true},
		{"NT path, slashes", cfg("[core]\n\tworktree = /??/UNC/h/s\n"), "", true},
		{"NT path to a drive", cfg("[core]\n\tworktree = /??/C:/r\n"), "", false},
		{"gitfile to an NT path", map[string]string{".git": "gitdir: /??/UNC/h/s/r\n"}, "", true},
		{"gitfile with ~ is literal", withFiles(gitDirFiles("~/g/", "[include]\n\tpath = //h/s\n"), ".git", "gitdir: ~/g\n"), "", true},
		{"gitfile with %(prefix) is literal", withFiles(gitDirFiles("%(prefix)/g/", "[include]\n\tpath = //h/s\n"), ".git", "gitdir: %(prefix)/g\n"), "", true},
		{"commondir with ~ is literal", withFiles(cfg(""), g+"commondir", "~/c\n", g+"~/c/config", "[include]\n\tpath = //h/s\n"), "", true},
		{"linked worktree's own gitfile off a drive", withFiles(cfg(""), g+"worktrees/w/gitdir", "../../../wt/.git\n",
			"wt/.git", "gitdir: //h/s/x\n"), "", true},
		{"linked worktree's own gitfile, clean", withFiles(cfg(""), g+"worktrees/w/gitdir", "../../../wt/.git\n",
			"wt/.git", "gitdir: ../.git/worktrees/w\n"), "", false},
	} {
		dir := fakeRepo(t, c.files)
		rr := newTestRoots()
		rr.placeDirs = []string{"//nas/share"}
		err := rr.repoConfigRefused(filepath.Join(dir, filepath.FromSlash(c.at)))
		if (err != nil) != c.refused {
			t.Errorf("%s: err = %v, want refused %v", c.name, err, c.refused)
		}
	}
}

// A file included through ~/ is the user's home, read like any local
// include: one there that names a share refuses the repository.
func TestRepoConfigRefusedHomeInclude(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	writeFile(t, filepath.Join(home, "inc.cfg"), "[include]\n\tpath = //h/s/x\n")
	dir := fakeRepo(t, gitDirFiles(".git/", "[include]\n\tpath = ~/inc.cfg\n"))
	if err := newTestRoots().repoConfigRefused(dir); err == nil {
		t.Error("an include under ~ naming a share passed")
	}
	writeFile(t, filepath.Join(home, "inc.cfg"), "[a]\n\tk = v\n")
	if err := newTestRoots().repoConfigRefused(dir); err != nil {
		t.Errorf("a clean include under ~: %v", err)
	}
	other := fakeRepo(t, gitDirFiles(".git/", "[include]\n\tpath = ~someone/x.cfg\n"))
	if err := newTestRoots().repoConfigRefused(other); err != nil {
		t.Errorf("another user's home is not read: %v", err)
	}
}

// worktreeOf takes the last core.worktree of the file, the one git uses,
// and none from a file it includes, which git does not read for it: a
// config repeating the key or its includes adds one base at most.
func TestWorktreeOf(t *testing.T) {
	dir := fakeRepo(t, withFiles(gitDirFiles(".git/", strings.Repeat("[core]\n\tworktree = ../a\n", 1000)+
		"[core]\n\tworktree = ../b\n"+strings.Repeat("[include]\n\tpath = ../inc.cfg\n", 1000)),
		"inc.cfg", "[core]\n\tworktree = ../c\n"))
	g := filepath.Join(dir, ".git")
	rr := newTestRoots()
	if got, want := rr.worktreeOf(filepath.Join(g, "config"), g), filepath.Join(dir, "b"); got != want {
		t.Errorf("worktreeOf = %q, want %q", got, want)
	}
	only := fakeRepo(t, withFiles(gitDirFiles(".git/", "[include]\n\tpath = ../inc.cfg\n"), "inc.cfg", "[core]\n\tworktree = ../c\n"))
	og := filepath.Join(only, ".git")
	if got := rr.worktreeOf(filepath.Join(og, "config"), og); got != "" {
		t.Errorf("core.worktree from an include = %q, want none", got)
	}
}

// A gitfile in a directory on a drive naming a git dir off one is refused
// before anything resolves it; on a share (a Place) its own share passes.
func TestGitfileOffDrive(t *testing.T) {
	gitEntryPlaces.Store([]string{"//nas/place"})
	t.Cleanup(func() { gitEntryPlaces.Store([]string(nil)) })
	for _, c := range []struct {
		top, target string
		off         bool
	}{
		{`C:\r\wt`, `C:\r\.git\worktrees\w`, false},
		{`C:\r\wt`, `\\h\s\x`, true},
		{`C:\r\wt`, `//h/s/x`, true},
		{`C:\r\wt`, `\\?\UNC\h\s\x`, true},
		{`C:\r\wt`, `\??\UNC\h\s\x`, true},
		{`C:\r\wt`, `\\.\pipe\x`, true},
		{`C:\r\wt`, `\\?\C:\r\.git`, false},
		{`C:\r\wt`, `\??\C:\r\.git`, false},
		{`\\nas\s\wt`, `\\nas\s\r\.git`, false},
		{`C:\r\wt`, `//nas/place/r/.git`, false},
	} {
		if got := gitfileOffDrive(c.top, c.target); got != c.off {
			t.Errorf("gitfileOffDrive(%q, %q) = %v, want %v", c.top, c.target, got, c.off)
		}
	}
	gitEntryPlaces.Store([]string(nil))
	if !gitfileOffDrive(`C:\r\wt`, `//nas/place/r/.git`) {
		t.Error("a share that is no Place passed")
	}
}

// On Windows the repository's core.excludesFile and core.attributesFile
// are never opened by the git termote runs: its status lists a file such an
// excludes file would hide.
func TestGitIgnoresRepoExcludesFile(t *testing.T) {
	repo := tempDirReal(t)
	gitInit(t, repo)
	ignore := filepath.Join(tempDirReal(t), "ignore")
	if err := os.WriteFile(ignore, []byte("hidden.txt\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "hidden.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitT(t, repo, "config", "core.excludesFile", ignore)
	gitT(t, repo, "config", "core.attributesFile", ignore)
	g := newGitRunner()
	g.windows = true
	out, _, err := g.output(context.Background(), gitCall{root: repo, limit: 1 << 20}, gitStatusArgs...)
	if err != nil || !strings.Contains(string(out), "? hidden.txt") {
		t.Fatalf("status = %q %v", out, err)
	}
}
