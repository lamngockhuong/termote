//go:build !windows

package main

import (
	"os"
	"testing"

	"github.com/creack/pty"
)

func TestReadKeyRaw(t *testing.T) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		t.Skip("no pty:", err)
	}
	defer ptmx.Close()
	defer tty.Close()
	// Keys arrive one at a time, without Enter.
	ptmx.Write([]byte("ox"))
	for _, want := range []byte("ox") {
		if got, err := readKeyRaw(tty); err != nil || got != want {
			t.Fatalf("readKeyRaw = %q, %v; want %q", got, err, want)
		}
	}
	// The terminal is back in line mode afterwards.
	if !isTerminal(tty) {
		t.Fatal("tty lost")
	}
	f, _ := os.CreateTemp(t.TempDir(), "notty")
	defer f.Close()
	if _, err := readKeyRaw(f); err == nil {
		t.Fatal("read a key from a file")
	}
}

func TestExecRunnerRunQuiet(t *testing.T) {
	if err := (execRunner{}).RunQuiet("hi", "sh", "-c", `test "$(cat)" = hi`); err != nil {
		t.Fatal(err)
	}
	if err := (execRunner{}).RunQuiet("no", "sh", "-c", `test "$(cat)" = hi`); err == nil {
		t.Fatal("wrong input accepted")
	}
}
