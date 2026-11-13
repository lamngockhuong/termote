//go:build !windows

package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// A FIFO is neither a file nor a folder: it is not run.
func TestFilesOpenWindowsRefusesOddEntries(t *testing.T) {
	fx, calls := newOpenFixture(t)
	if err := syscall.Mkfifo(filepath.Join(fx.root, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	res := fx.open(openWindowsRequest{Path: "pipe"}, &authInfo{Kind: authSession, Role: roleFull})
	if res.StatusCode != 400 || errorCode(t, res) != "not_file" {
		t.Errorf("pipe = %d", res.StatusCode)
	}
	if len(*calls) != 0 {
		t.Errorf("ran %q", *calls)
	}
}

// A Linux name Windows reads as another path is refused, the file there
// and every other check passed: a `\` climbs out of the root, explorer.exe
// opens what is before a comma, a trailing dot or space is dropped.
func TestFilesOpenWindowsRefusesWindowsNames(t *testing.T) {
	fx, calls := newOpenFixture(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	fx.write(t, "seen.txt", "x")
	for _, name := range []string{
		`..\..\outside\target.txt`, `a\b.txt`, "a,b.txt", "seen.txt,zzz", "a,b",
		"a:b.txt", "a*b.txt", "a?b.txt", `say"hi".html`, "a<b.txt", "a>b.txt", "a|b.txt",
		"a\tb.txt", "a\x01b.txt", "a\rb.txt", "a\nb.txt",
		"seen.txt.", "seen.txt ", "dir./a.txt", "dir /a.txt",
	} {
		fx.write(t, name, "x")
		res := fx.open(openWindowsRequest{Path: name, Reveal: true, Run: true}, full)
		if res.StatusCode != 400 || errorCode(t, res) != "windows_name" {
			t.Errorf("%q = %d", name, res.StatusCode)
		}
	}
	if len(*calls) != 0 {
		t.Errorf("ran %q", *calls)
	}
}

func TestWindowsReadsAsIs(t *testing.T) {
	for p, want := range map[string]bool{
		"/":                           true,
		"/home/u/.bashrc":             true,
		"/home/u/a b/x.tar.gz":        true,
		"/mnt/c/Users/LAMNGO~1.KHU/x": true,
		"/home/u/ünï/文件.txt":          true,
		"/home/u/a\x7fb":              true,
		"/home/u/a,b/x.txt":           false,
		"/home/u/proj./x.txt":         false,
		"/home/u/proj /x.txt":         false,
		`/home/u/x\y`:                 false,
		"/home/u/d\uf03a/x.txt":       false,
		"/home/u/x.txt\uf02e":         false,
		"/home/u/\uefff\uf100":        true,
	} {
		if got := windowsReadsAsIs(p); got != want {
			t.Errorf("windowsReadsAsIs(%q) = %v, want %v", p, got, want)
		}
	}
}

// A file Windows may run as a program (any extension it is not known to open
// to show) opens only once the user said to run it; a file it shows, and a
// folder whatever its name but a shell object's, opens as before.
func TestFilesOpenWindowsRunsProgram(t *testing.T) {
	fx, calls := newOpenFixture(t)
	logs := captureLog(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	runs := []string{
		"probe.cmd", "probe.BAT", "x.js", "x.lnk", "x.ps1", "x.hta", "x.url",
		"x.appref-ms", "x.settingcontent-ms", "help.CHM", "x.msix", "x.appinstaller",
		"x.diagcab", "x.library-ms", "x.searchconnector-ms", "x.xll", "x.sct", "x.jnlp",
		"build.sh", "setup.py", "x.pyw", "x.wsb", "x.theme", "disk.iso", "x.vhdx", "x.rdp",
		"x.vb\u017f", "x.unknown",
	}
	for _, name := range runs {
		fx.write(t, name, "x")
		*calls = nil
		res := fx.open(openWindowsRequest{Path: name}, full)
		if res.StatusCode != 403 || errorCode(t, res) != "runs_program" {
			t.Errorf("%s = %d", name, res.StatusCode)
		}
		if len(*calls) != 0 {
			t.Errorf("%s ran %q", name, *calls)
		}
		if res := fx.open(openWindowsRequest{Path: name, Run: true}, full); res.StatusCode != 200 {
			t.Errorf("%s run = %d", name, res.StatusCode)
		}
		if len(*calls) != 1 || !strings.HasSuffix((*calls)[0], `\`+name) {
			t.Errorf("%s run ran %q", name, *calls)
		}
	}
	if n := strings.Count(logs.String(), `run="true"`); n != len(runs) {
		t.Errorf("audit lines with run = %d:\n%s", n, logs)
	}
	fx.write(t, "page.txt", "x")
	fx.write(t, "notes.MD", "x")
	fx.write(t, "main.go", "x")
	fx.write(t, "tool.cmd/inside.txt", "x")
	fx.write(t, "cmd", "x")
	for _, name := range []string{"page.txt", "notes.MD", "main.go", "tool.cmd", "cmd"} {
		*calls = nil
		if res := fx.open(openWindowsRequest{Path: name}, full); res.StatusCode != 200 || len(*calls) != 1 {
			t.Errorf("%s = %d, ran %q", name, res.StatusCode, *calls)
		}
	}
	if n := strings.Count(logs.String(), `run="true"`); n != len(runs) {
		t.Errorf("run logged without run:\n%s", logs)
	}
	// A sensitive name still needs reveal first
	fx.write(t, "secrets.cmd", "x")
	*calls = nil
	if res := fx.open(openWindowsRequest{Path: "secrets.cmd", Run: true}, full); res.StatusCode != 403 || errorCode(t, res) != "sensitive" {
		t.Errorf("secrets.cmd = %d", res.StatusCode)
	}
	if res := fx.open(openWindowsRequest{Path: "secrets.cmd", Reveal: true}, full); res.StatusCode != 403 || errorCode(t, res) != "runs_program" {
		t.Errorf("secrets.cmd revealed = %d", res.StatusCode)
	}
	if len(*calls) != 0 {
		t.Errorf("ran %q", *calls)
	}
}

// A folder named like a shell object asks first; a folder Explorer would
// reach out of while it shows it (a shortcut or desktop.ini directly in it)
// is not opened, run or not.
func TestFilesOpenWindowsFolders(t *testing.T) {
	fx, calls := newOpenFixture(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	shell := "x.{20D04FE0-3AEA-1069-A2D8-08002B30309D}"
	fx.write(t, shell+"/a.txt", "x")
	if res := fx.open(openWindowsRequest{Path: shell}, full); res.StatusCode != 403 || errorCode(t, res) != "runs_program" {
		t.Errorf("shell folder = %d", res.StatusCode)
	}
	if res := fx.open(openWindowsRequest{Path: shell, Run: true}, full); res.StatusCode != 200 {
		t.Errorf("shell folder run = %d", res.StatusCode)
	}
	for _, name := range []string{"icon.url", "a.LNK", "x.scf", "desktop.ini", "x.library-ms"} {
		dir := "d-" + strings.ReplaceAll(name, ".", "-")
		fx.write(t, dir+"/"+name, "x")
		*calls = nil
		for _, run := range []bool{false, true} {
			res := fx.open(openWindowsRequest{Path: dir, Run: run}, full)
			if res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
				t.Errorf("%s (run %v) = %d", dir, run, res.StatusCode)
			}
		}
		if len(*calls) != 0 {
			t.Errorf("%s ran %q", dir, *calls)
		}
	}
	// The root holds d-desktop-ini, whose desktop.ini Explorer reads.
	if res := fx.open(openWindowsRequest{Path: "."}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("root over a subfolder's desktop.ini = %d", res.StatusCode)
	}
}

// Names Windows reads as a shortcut or a desktop.ini that Go's case
// folding does not, and theme files, make the folder reach too.
func TestFilesOpenWindowsFoldersOddNames(t *testing.T) {
	fx, _ := newOpenFixture(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	for i, name := range []string{"x.\u017fcf", "x.library-m\u017f", "x.l\u0131brary-ms", "x.theme", "x.themepack",
		"x.deskthemepack", "x.pif", "desktop.\u0131ni", "DESKTOP.\u0130NI"} {
		dir := fmt.Sprintf("d%d", i)
		fx.write(t, dir+"/"+name, "x")
		if res := fx.open(openWindowsRequest{Path: dir, Run: true}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
			t.Errorf("%q = %d", name, res.StatusCode)
		}
	}
	// A settings shortcut names its icon in its XML: one of its own fixture,
	// so nothing else in the root refuses the folder first.
	sc, _ := newOpenFixture(t)
	sc.write(t, "s/x.settingcontent-ms", "x")
	if res := sc.open(openWindowsRequest{Path: "s", Run: true}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("settings shortcut = %d", res.StatusCode)
	}
	plain, _ := newOpenFixture(t)
	plain.write(t, "ok/desktop.in", "x")
	plain.write(t, "ok/a.txt", "x")
	if res := plain.open(openWindowsRequest{Path: "ok"}, full); res.StatusCode != 200 {
		t.Errorf("plain folder = %d %s", res.StatusCode, errorCode(t, res))
	}
}

// A subfolder counts for its desktop.ini only, which Explorer reads to
// show it; a shortcut in it is not shown, nor is anything deeper. A link
// to a folder counts as a subfolder, and a link out of the root refuses.
func TestFilesOpenWindowsSubfolders(t *testing.T) {
	fx, _ := newOpenFixture(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	fx.write(t, "n/a/b/desktop.ini", "x")
	fx.write(t, "n/a/icon.url", "x")
	if res := fx.open(openWindowsRequest{Path: "n"}, full); res.StatusCode != 200 {
		t.Errorf("folder over nested shortcuts = %d %s", res.StatusCode, errorCode(t, res))
	}
	fx.write(t, "n/c/Desktop.INI", "x")
	if res := fx.open(openWindowsRequest{Path: "n"}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("folder over a subfolder's desktop.ini = %d", res.StatusCode)
	}

	fx.write(t, "l/a.txt", "x")
	fx.write(t, "hidden/deep/desktop.ini", "x")
	if err := os.Symlink("../hidden/deep", filepath.Join(fx.root, "l", "sub")); err != nil {
		t.Fatal(err)
	}
	if res := fx.open(openWindowsRequest{Path: "l"}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("folder over a link to a folder holding a desktop.ini = %d", res.StatusCode)
	}
	fx.write(t, "out/a.txt", "x")
	if err := os.Symlink(t.TempDir(), filepath.Join(fx.root, "out", "sub")); err != nil {
		t.Fatal(err)
	}
	if res := fx.open(openWindowsRequest{Path: "out"}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("folder over a link out of the root = %d", res.StatusCode)
	}
	// A link Linux sees as pointing at nothing may still lead somewhere for
	// Windows (an NT link to a share under /mnt/c), and an entry neither a
	// file, a folder nor a link is not one Explorer shows plainly.
	fx.write(t, "dl/a.txt", "x")
	if err := os.Symlink("nowhere", filepath.Join(fx.root, "dl", "pic.png")); err != nil {
		t.Fatal(err)
	}
	if res := fx.open(openWindowsRequest{Path: "dl"}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("folder over a link to nothing = %d", res.StatusCode)
	}
	fx.write(t, "ff/a.txt", "x")
	if err := syscall.Mkfifo(filepath.Join(fx.root, "ff", "pipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if res := fx.open(openWindowsRequest{Path: "ff"}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("folder over a named pipe = %d", res.StatusCode)
	}
}

// A folder named like a shell object (x.{CLSID}) is not shown as a folder:
// Explorer runs its handler (a Folder Shortcut resolves its target.lnk).
// One in the folder opened, beside a folder the navigation pane shows, or
// on the way to the folder opened refuses it.
func TestFilesOpenWindowsShellObjectFolders(t *testing.T) {
	fx, calls := newOpenFixture(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	const shell = "docs.{0AFACED1-E828-11D1-9187-B532F1E9575D}"
	fx.write(t, "in/"+shell+"/target.lnk", "x")
	fx.write(t, "beside/"+shell+"/target.lnk", "x")
	fx.write(t, "beside/src/a.txt", "x")
	fx.write(t, "on/"+shell+"/sub/a.txt", "x")
	for _, tc := range []struct {
		path string
		run  bool
		code string
	}{
		{"in", true, "folder_reaches"},
		{"beside/src", true, "folder_reaches"},
		{"on/" + shell + "/sub", false, "runs_program"},
		{"on/" + shell + "/sub/a.txt", false, "runs_program"},
	} {
		if res := fx.open(openWindowsRequest{Path: tc.path, Run: tc.run}, full); res.StatusCode != 403 || errorCode(t, res) != tc.code {
			t.Errorf("%s (run %v) = %d, want 403 %s", tc.path, tc.run, res.StatusCode, tc.code)
		}
	}
	if len(*calls) != 0 {
		t.Errorf("ran %q", *calls)
	}
	// Run, the shell object on the way is the one the user said to run...
	if res := fx.open(openWindowsRequest{Path: "on/" + shell + "/sub", Run: true}, full); res.StatusCode != 200 {
		t.Errorf("run through the shell object = %d %s", res.StatusCode, errorCode(t, res))
	}
	// ...unless it holds what its handler follows (a Folder Shortcut's
	// target.lnk): refused, run or not.
	fx.write(t, "via/"+shell+"/target.lnk", "x")
	fx.write(t, "via/"+shell+"/sub/a.txt", "x")
	for _, p := range []string{"via/" + shell + "/sub", "via/" + shell + "/sub/a.txt"} {
		if res := fx.open(openWindowsRequest{Path: p, Run: true}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
			t.Errorf("%s through a shell object holding a shortcut (run) = %d", p, res.StatusCode)
		}
	}
}

// The root and the folders above it count on the way too: a pane root or a
// Place named like a shell object, or one inside such a folder (an unpacked
// archive), asks for what is below it, not only for itself.
func TestShellFoldersOnWay(t *testing.T) {
	const shell = "x.{20D04FE0-3AEA-1069-A2D8-08002B30309D}"
	for _, tc := range []struct {
		root, rel string
		want      []string
	}{
		{"/home/u/repo", "a/b.txt", nil},
		{"/home/u/" + shell, "a/b.txt", []string{"/home/u/" + shell}},
		{"/home/u/" + shell, ".", []string{"/home/u/" + shell}},
		{"/home/u/" + shell + "/repo", "a", []string{"/home/u/" + shell}},
		{"/home/u/repo", "a/" + shell + "/c/d", []string{"/home/u/repo/a/" + shell}},
		{"/home/u/repo", shell, nil}, // the item itself is asked about on its own
	} {
		if got := shellFoldersOnWay(tc.root, tc.rel); fmt.Sprint(got) != fmt.Sprint(tc.want) {
			t.Errorf("shellFoldersOnWay(%q, %q) = %q, want %q", tc.root, tc.rel, got, tc.want)
		}
	}
}

// What refuses a folder refuses it as a folder on the way too, where the
// navigation pane shows it: a link to nothing beside the way. A link to a
// file inside the root does not, nor does a link to a folder inside the
// pane root that leaves the opened folder's parent.
func TestFilesOpenWindowsOnTheWayLinks(t *testing.T) {
	fx, _ := newOpenFixture(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	fx.write(t, "repo/src/a.txt", "x")
	fx.write(t, "repo/readme.txt", "x")
	if err := os.Symlink("readme.txt", filepath.Join(fx.root, "repo", "README")); err != nil {
		t.Fatal(err)
	}
	if res := fx.open(openWindowsRequest{Path: "repo/src"}, full); res.StatusCode != 200 {
		t.Errorf("beside a link to a file = %d %s", res.StatusCode, errorCode(t, res))
	}
	if res := fx.open(openWindowsRequest{Path: "repo"}, full); res.StatusCode != 200 {
		t.Errorf("over a link to a file = %d %s", res.StatusCode, errorCode(t, res))
	}
	fx.write(t, "x/deep/a.txt", "x")
	fx.write(t, "a/l/a.txt", "x")
	if err := os.Symlink("../../x/deep", filepath.Join(fx.root, "a", "l", "sub")); err != nil {
		t.Fatal(err)
	}
	if res := fx.open(openWindowsRequest{Path: "a/l"}, full); res.StatusCode != 200 {
		t.Errorf("over a link inside the pane root, out of the parent = %d %s", res.StatusCode, errorCode(t, res))
	}
	if err := os.Symlink("nowhere", filepath.Join(fx.root, "repo", "dangling")); err != nil {
		t.Fatal(err)
	}
	if res := fx.open(openWindowsRequest{Path: "repo/src"}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("beside a link to nothing on the way = %d", res.StatusCode)
	}
	// A named pipe beside the way, a link to one, and a file named like a
	// shell object refuse too.
	for i, mk := range []func(dir string) error{
		func(dir string) error { return syscall.Mkfifo(filepath.Join(dir, "pipe"), 0o600) },
		func(dir string) error {
			// the pipe in a folder of its own, so only the link is beside the way
			if err := os.MkdirAll(filepath.Join(fx.root, "pipes"), 0o755); err != nil {
				return err
			}
			if err := syscall.Mkfifo(filepath.Join(fx.root, "pipes", filepath.Base(dir)), 0o600); err != nil {
				return err
			}
			return os.Symlink(filepath.Join("..", "pipes", filepath.Base(dir)), filepath.Join(dir, "to-pipe"))
		},
		func(dir string) error {
			return os.WriteFile(filepath.Join(dir, "x.{20D04FE0-3AEA-1069-A2D8-08002B30309D}"), []byte("x"), 0o644)
		},
	} {
		top := fmt.Sprintf("w%d", i)
		fx.write(t, top+"/src/a.txt", "x")
		if err := mk(filepath.Join(fx.root, top)); err != nil {
			t.Fatal(err)
		}
		if res := fx.open(openWindowsRequest{Path: top + "/src"}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
			t.Errorf("case %d beside the way = %d", i, res.StatusCode)
		}
	}
}

// Explorer's navigation pane shows the folders on the way to the one
// opened and the folders beside each: their desktop.ini refuses it too.
func TestFilesOpenWindowsNavigationPane(t *testing.T) {
	fx, _ := newOpenFixture(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	fx.write(t, "repo/src/a/x.txt", "x")
	fx.write(t, "repo/src/b/icon.url", "x") // a shortcut beside is not shown in the pane
	if res := fx.open(openWindowsRequest{Path: "repo/src/a"}, full); res.StatusCode != 200 {
		t.Errorf("plain tree = %d %s", res.StatusCode, errorCode(t, res))
	}
	for _, ini := range []string{"repo/docs/desktop.ini", "repo/desktop.ini", "top/desktop.ini", "desktop.ini"} {
		fx.write(t, ini, "x")
		if res := fx.open(openWindowsRequest{Path: "repo/src/a"}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
			t.Errorf("%s beside the way = %d", ini, res.StatusCode)
		}
		if err := os.Remove(filepath.Join(fx.root, filepath.FromSlash(ini))); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWindowsMayRun(t *testing.T) {
	for name, want := range map[string]bool{
		"a.txt": false, "a.TXT": false, "dir/a.md": false, "Makefile": false, "a.pdf": false,
		"a.cmd": true, "a.sh": true, "a.py": true, "a.vb\u017f": true, "a.t\u00e9xt": true,
		".bashrc": true, "a.": true,
		"a.docx": true, "a.rtf": true, "a.xml": true, "a.html": true, "a.svg": true, "a.lua": true,
		"a.jl": true, "a.csv": true, "a.epub": true, "a.zip": true,
		"a.jsx": true, "a.hs": true, "a.mp4": true, "a.mp3": true, "a.mkv": true, "a.png": false, "a.ts": true, "a.mts": true, "a.tsx": false, "a.cts": false,
	} {
		if got := windowsMayRun(name); got != want {
			t.Errorf("windowsMayRun(%q) = %v", name, got)
		}
	}
}

// A shell object above the pane root that holds a shortcut refuses what is
// below it, read as a root of its own; one holding nothing it follows does
// not.
func TestShellsOnWayReachAboveRoot(t *testing.T) {
	shell := filepath.Join(t.TempDir(), "x.{0AFACED1-E828-11D1-9187-B532F1E9575D}")
	repo := filepath.Join(shell, "repo")
	if err := os.MkdirAll(filepath.Join(repo, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	rt, err := os.OpenRoot(repo)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if reaches, err := shellsOnWayReach(rt, repo, "a"); reaches || err != nil {
		t.Errorf("empty shell object above = %v, %v", reaches, err)
	}
	if err := os.WriteFile(filepath.Join(shell, "target.lnk"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if reaches, err := shellsOnWayReach(rt, repo, "a"); !reaches || err != nil {
		t.Errorf("shell object above holding a shortcut = %v, %v", reaches, err)
	}
}

// A pane root inside a shell object: opening it, or anything below it,
// asks first; with a shortcut in that shell object, it is refused even run.
func TestFilesOpenWindowsRootInShellObject(t *testing.T) {
	fx, calls := newOpenFixture(t)
	shell := filepath.Join(plainDir(t), "x.{0AFACED1-E828-11D1-9187-B532F1E9575D}")
	fx.root = filepath.Join(shell, "root")
	if err := os.MkdirAll(fx.root, 0o755); err != nil {
		t.Fatal(err)
	}
	wsl := fx.f.wsl
	fx.mux = http.NewServeMux()
	fx.f = registerFilesRoutes(fx.mux, &filesFakeMux{dir: fx.root, files: true}, hostAllowlist{}, nil)
	fx.f.wsl = wsl
	full := &authInfo{Kind: authSession, Role: roleFull}
	fx.write(t, "sub/a.txt", "x")
	for _, p := range []string{".", "sub", "sub/a.txt"} {
		if res := fx.open(openWindowsRequest{Path: p}, full); res.StatusCode != 403 || errorCode(t, res) != "runs_program" {
			t.Errorf("%s under a shell object = %d", p, res.StatusCode)
		}
		if res := fx.open(openWindowsRequest{Path: p, Run: true}, full); res.StatusCode != 200 {
			t.Errorf("%s under a shell object (run) = %d %s", p, res.StatusCode, errorCode(t, res))
		}
	}
	// A second shell object on the way, a folder between or not, is refused even run.
	fx.write(t, "e.{20D04FE0-3AEA-1069-A2D8-08002B30309D}/m/f.{20D04FE0-3AEA-1069-A2D8-08002B30309D}/c/d.txt", "x")
	if res := fx.open(openWindowsRequest{Path: "e.{20D04FE0-3AEA-1069-A2D8-08002B30309D}/m/f.{20D04FE0-3AEA-1069-A2D8-08002B30309D}/c", Run: true}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("through two shell objects a folder apart (run) = %d", res.StatusCode)
	}
	// A second shell object on the way is refused even run.
	fx.write(t, "a.{20D04FE0-3AEA-1069-A2D8-08002B30309D}/b.{20D04FE0-3AEA-1069-A2D8-08002B30309D}/c/d.txt", "x")
	if res := fx.open(openWindowsRequest{Path: "a.{20D04FE0-3AEA-1069-A2D8-08002B30309D}/b.{20D04FE0-3AEA-1069-A2D8-08002B30309D}/c", Run: true}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
		t.Errorf("through two shell objects (run) = %d", res.StatusCode)
	}
	writeFile(t, filepath.Join(shell, "target.lnk"), "x")
	*calls = nil
	for _, p := range []string{".", "sub", "sub/a.txt"} {
		if res := fx.open(openWindowsRequest{Path: p, Run: true}, full); res.StatusCode != 403 || errorCode(t, res) != "folder_reaches" {
			t.Errorf("%s under a shell object holding a shortcut (run) = %d", p, res.StatusCode)
		}
	}
	if len(*calls) != 0 {
		t.Errorf("ran %q", *calls)
	}
}
