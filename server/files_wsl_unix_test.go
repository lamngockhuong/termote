//go:build !windows

package main

import (
	"fmt"
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
	if err := os.Symlink("nowhere", filepath.Join(fx.root, "n", "dangling")); err != nil {
		t.Fatal(err)
	}
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
		"a.jsx": true, "a.hs": true, "a.mp4": true, "a.mp3": true, "a.mkv": true, "a.png": false, "a.ts": false,
	} {
		if got := windowsMayRun(name); got != want {
			t.Errorf("windowsMayRun(%q) = %v", name, got)
		}
	}
}
