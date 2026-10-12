//go:build !windows

package main

import (
	"net/url"
	"path/filepath"
	"syscall"
	"testing"
)

// A FIFO is refused by its Lstat: opening it would block until a writer came.
func TestFilesDownloadFIFO(t *testing.T) {
	fx := newDownloadFixture(t)
	captureLog(t)
	if err := syscall.Mkfifo(filepath.Join(fx.root, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, q := range []url.Values{{"path": {"pipe"}}, {"path": {"pipe"}, "check": {"1"}}} {
		if code, key := rawCode(t, fx.get(q, nil)); code != 400 || key != "not_file" {
			t.Errorf("fifo %v = %d %q", q, code, key)
		}
	}
}
