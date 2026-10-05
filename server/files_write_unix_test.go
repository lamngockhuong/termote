//go:build !windows

package main

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestFilesWriteNotEditable(t *testing.T) {
	fx := newFilesFixture(t)
	syscall.Mkfifo(filepath.Join(fx.root, "fifo"), 0o644)
	writeFile(t, filepath.Join(fx.root, "orig.txt"), "o\n")
	os.Link(filepath.Join(fx.root, "orig.txt"), filepath.Join(fx.root, "linked.txt"))
	writeFile(t, filepath.Join(fx.root, "mixed.txt"), "a\r\nb\n")
	writeFile(t, filepath.Join(fx.root, "cr.txt"), "a\rb\n")
	writeFile(t, filepath.Join(fx.root, "nul.txt"), strings.Repeat("x", binarySniffSize)+"\x00\n")
	for rel, reason := range map[string]string{
		"notes.txt":  "symlink",
		"out":        "symlink",
		"in/b.go":    "symlink",
		"fifo":       "not-regular",
		"linked.txt": "hardlink",
		"mixed.txt":  "mixed-eol",
		"cr.txt":     "mixed-eol",
		"nul.txt":    "nul",
	} {
		code, got := fx.put(t, fx.root, map[string]any{"path": rel, "baseHash": "x", "text": "y\n", "reveal": true})
		if code != http.StatusUnprocessableEntity || got["code"] != "not_editable" || got["reason"] != reason {
			t.Errorf("%s = %d %v", rel, code, got)
		}
		_, gotGet := fx.get(t, "content", url.Values{"path": {rel}, "reveal": {"1"}})
		if gotGet["text"] != nil && gotGet["notEditable"] != reason {
			t.Errorf("GET %s = %v, want %s", rel, gotGet, reason)
		}
	}
	if readText(t, filepath.Join(fx.root, "sub", "b.go")) != "package b\n" || readText(t, filepath.Join(fx.outside, "passwd")) != "root:x\n" {
		t.Error("written through a symlink")
	}
}

func TestFilesWritePermission(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs a non-root user")
	}
	fx := newFilesFixture(t)
	ro := filepath.Join(fx.root, "ro.txt")
	writeFile(t, ro, "r\n")
	os.Chmod(ro, 0o444)
	code, got := fx.put(t, fx.root, map[string]any{"path": "ro.txt", "baseHash": diskHash(t, ro), "text": "w\n"})
	if code != http.StatusForbidden || got["code"] != "permission" {
		t.Errorf("0444 = %d %v", code, got)
	}
	if _, g := fx.get(t, "content", url.Values{"path": {"ro.txt"}}); g["notEditable"] != "not-writable" {
		t.Errorf("GET 0444 = %v", g)
	}
	dir := filepath.Join(fx.root, "locked")
	inner := filepath.Join(dir, "f.txt")
	writeFile(t, inner, "f\n")
	os.Chmod(dir, 0o555)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	code, got = fx.put(t, fx.root, map[string]any{"path": "locked/f.txt", "baseHash": diskHash(t, inner), "text": "w\n"})
	if code != http.StatusForbidden || got["code"] != "permission" || readText(t, inner) != "f\n" {
		t.Errorf("read-only dir = %d %v", code, got)
	}
}

// A file the server cannot even read: refused before anything is written.
func TestFilesWriteUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs a non-root user")
	}
	fx := newFilesFixture(t)
	p := filepath.Join(fx.root, "locked.txt")
	writeFile(t, p, "x\n")
	os.Chmod(p, 0)
	t.Cleanup(func() { os.Chmod(p, 0o644) })
	code, got := fx.put(t, fx.root, map[string]any{"path": "locked.txt", "baseHash": "x", "text": "y\n"})
	if code != http.StatusForbidden {
		t.Errorf("unreadable = %d %v", code, got)
	}
	if _, g := fx.get(t, "content", url.Values{"path": {"locked.txt"}}); g["text"] != nil {
		t.Errorf("GET = %v", g)
	}
}
