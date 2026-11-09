//go:build !windows

package main

import (
	"path/filepath"
	"syscall"
	"testing"
)

// A FIFO is neither a file nor a folder, and a name with a quote would end
// explorer.exe's argument early: neither is run.
func TestFilesOpenWindowsRefusesOddEntries(t *testing.T) {
	fx, calls := newOpenFixture(t)
	if err := syscall.Mkfifo(filepath.Join(fx.root, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	fx.write(t, `say"hi".html`, "x")
	full := &authInfo{Kind: authSession, Role: roleFull}
	for _, p := range []string{"pipe", `say"hi".html`} {
		res := fx.open(openWindowsRequest{Path: p}, full)
		if res.StatusCode != 400 || errorCode(t, res) != "not_file" {
			t.Errorf("%s = %d", p, res.StatusCode)
		}
	}
	if len(*calls) != 0 {
		t.Errorf("ran %q", *calls)
	}
}
