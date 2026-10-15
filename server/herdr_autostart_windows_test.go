//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestHerdrResolveBinRefusesScripts(t *testing.T) {
	for _, name := range []string{"herdr.cmd", "herdr.bat"} {
		p := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(p, []byte("@echo off\r\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		if got, err := herdrResolveBin(p); err == nil {
			t.Errorf("%s resolved to %q", name, got)
		}
	}
	if herdrExeName("herdr") != "herdr.exe" || herdrExeName(`C:\x\herdr.exe`) != `C:\x\herdr.exe` {
		t.Error("herdrExeName")
	}
}

func TestHerdrAutostartWindowsHelpers(t *testing.T) {
	if !herdrStartRefused(fmt.Errorf("start: %w", windows.ERROR_ACCESS_DENIED)) || herdrStartRefused(windows.ERROR_FILE_NOT_FOUND) {
		t.Error("herdrStartRefused")
	}
	pe := &herdrPipeUserError{Err: &os.PathError{Op: "open", Err: windows.ERROR_FILE_NOT_FOUND}}
	if herdrNotListening(pe) {
		t.Error("a pipe of another user taken as no herdr")
	}
	attrs := herdrServerSysProcAttrs()
	if len(attrs) != 2 || attrs[0].CreationFlags&windows.CREATE_BREAKAWAY_FROM_JOB == 0 || attrs[1].CreationFlags&windows.CREATE_BREAKAWAY_FROM_JOB != 0 {
		t.Errorf("attrs = %+v", attrs)
	}
}
