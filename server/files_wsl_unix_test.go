//go:build !windows

package main

import (
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
	} {
		if got := windowsReadsAsIs(p); got != want {
			t.Errorf("windowsReadsAsIs(%q) = %v, want %v", p, got, want)
		}
	}
}

// A file Windows runs as a program opens only once the user said to run
// it; any other file, and a folder whatever its name, opens as before.
func TestFilesOpenWindowsRunsProgram(t *testing.T) {
	fx, calls := newOpenFixture(t)
	logs := captureLog(t)
	full := &authInfo{Kind: authSession, Role: roleFull}
	runs := []string{
		"probe.cmd", "probe.BAT", "x.js", "x.lnk", "x.ps1", "x.hta", "x.url",
		"x.appref-ms", "x.settingcontent-ms", "help.CHM", "x.msix", "x.appinstaller",
		"x.diagcab", "x.library-ms", "x.searchconnector-ms", "x.xll", "x.sct", "x.jnlp",
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
	fx.write(t, "page.html", "x")
	fx.write(t, "tool.cmd/inside.txt", "x")
	fx.write(t, "cmd", "x")
	for _, name := range []string{"page.html", "tool.cmd", "cmd"} {
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
