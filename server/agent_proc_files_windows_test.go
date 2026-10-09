package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const testRolloutName = "rollout-2026-10-09T10-00-00-" + testCodexID + ".jsonl"

// openOwn creates a file and opens it in this process with flag (O_CREATE
// would add write access).
func openOwn(t *testing.T, path string, flag int) *os.File {
	t.Helper()
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, flag, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// waitHandleCache waits out writeHandles, so the next procWriteFiles reads
// the handles opened since.
func waitHandleCache() { time.Sleep(1100 * time.Millisecond) }

func isRollout(name string) bool { return codexRolloutRe.MatchString(name) }

func TestSysHandleEntrySize(t *testing.T) {
	if n := unsafe.Sizeof(sysHandleEntry{}); unsafe.Sizeof(uintptr(0)) == 8 && n != 40 {
		t.Errorf("sysHandleEntry is %d bytes, want 40", n)
	}
}

func TestProcWriteFilesOwnHandles(t *testing.T) {
	dir := t.TempDir()
	appendOnly := filepath.Join(dir, testRolloutName)
	readWrite := filepath.Join(dir, "rollout-2026-10-09T10-00-01-"+"0199a6f2-0000-7000-8000-000000000001.jsonl")
	readOnly := filepath.Join(dir, "rollout-2026-10-09T10-00-02-"+"0199a6f2-0000-7000-8000-000000000002.jsonl")
	other := filepath.Join(dir, "notes.txt")
	openOwn(t, appendOnly, os.O_APPEND|os.O_WRONLY)
	openOwn(t, readWrite, os.O_RDWR)
	openOwn(t, other, os.O_RDWR)
	openOwn(t, readOnly, os.O_RDONLY)
	waitHandleCache()

	got := map[string]string{}
	for _, f := range procWriteFiles(os.Getpid(), isRollout) {
		got[f.path] = f.id
	}
	for _, p := range []string{appendOnly, readWrite} {
		real, _ := filepath.EvalSymlinks(p)
		id, ok := got[real]
		if !ok {
			t.Errorf("%s not listed: %v", filepath.Base(p), got)
			continue
		}
		if want := rolloutIdentity(real, nil, nil); id == "" || id != want {
			t.Errorf("%s: id %q, rolloutIdentity %q", filepath.Base(p), id, want)
		}
	}
	for _, p := range []string{readOnly, other} {
		real, _ := filepath.EvalSymlinks(p)
		if _, ok := got[real]; ok {
			t.Errorf("%s listed", filepath.Base(p))
		}
	}
}

func TestRolloutIdentityThroughOpenFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), testRolloutName)
	os.WriteFile(p, []byte("{}\n"), 0o600)
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	byPath, byFile := rolloutIdentity(p, nil, nil), rolloutIdentity(p, f, nil)
	if byPath == "" || byPath != byFile {
		t.Errorf("path %q, open file %q", byPath, byFile)
	}
	q := p + ".2"
	os.WriteFile(q, []byte("{}\n"), 0o600)
	if rolloutIdentity(q, nil, nil) == byPath {
		t.Error("two files share an identity")
	}
	if rolloutIdentity(p+".gone", nil, nil) != "" || rolloutIdentity(`\\host\share\x`, nil, nil) != "" {
		t.Error("identity of a missing or UNC path")
	}
}

func TestProcWriteFilesClosesHandles(t *testing.T) {
	openOwn(t, filepath.Join(t.TempDir(), testRolloutName), os.O_APPEND|os.O_WRONLY)
	waitHandleCache()
	count := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetProcessHandleCount")
	handles := func() uint32 {
		var n uint32
		count.Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&n)))
		return n
	}
	procWriteFiles(os.Getpid(), isRollout) // warm the cache and the type index
	before := handles()
	for range 200 {
		procWriteFiles(os.Getpid(), isRollout)
	}
	// A leak adds a handle or more per listing; the runtime's own threads
	// and timers add a few.
	if after := handles(); after >= before+50 {
		t.Errorf("handles %d → %d after 200 listings", before, after)
	}
}

func TestProcWriteFilesNoProcess(t *testing.T) {
	for _, pid := range []int{-1, 0, 1 << 30} {
		if got := procWriteFiles(pid, isRollout); got != nil {
			t.Errorf("pid %d: %v", pid, got)
		}
	}
}

func TestWinDrivePath(t *testing.T) {
	for in, want := range map[string]string{
		`\\?\C:\Users\u\.codex\x.jsonl`: `C:\Users\u\.codex\x.jsonl`,
		`d:\x`:                          `d:\x`,
		`\\?\UNC\host\share\x`:          "",
		`\\.\pipe\x`:                    "",
		`\\?\Volume{0}\x`:               "",
		`\\?\1:\x`:                      "",
		`C:`:                            "",
	} {
		got, ok := winDrivePath(in)
		if got != want || ok != (want != "") {
			t.Errorf("%q = %q, %v", in, got, ok)
		}
	}
}
