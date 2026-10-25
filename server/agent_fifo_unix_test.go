//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// returnsSoon fails the test when f has not returned within two seconds: a
// read of a FIFO that blocks never would.
func returnsSoon(t *testing.T, f func() bool) bool {
	t.Helper()
	done := make(chan bool, 1)
	go func() { done <- f() }()
	select {
	case got := <-done:
		return got
	case <-time.After(2 * time.Second):
		t.Fatal("blocked on a FIFO")
		return false
	}
}

// mkfifo makes a FIFO at dir/name, its read end kept from blocking by a
// writer held open (closed at cleanup) when withWriter is set.
func mkfifo(t *testing.T, dir, name string, withWriter bool) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := syscall.Mkfifo(p, 0o600); err != nil {
		t.Fatal(err)
	}
	if withWriter {
		w, err := os.OpenFile(p, os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { w.Close() })
	}
	return p
}

// A rollout replaced by a FIFO after the Stat that found it: the read must
// not wait for data that never comes.
func TestCodexUserThreadFIFO(t *testing.T) {
	p := mkfifo(t, t.TempDir(), "rollout.jsonl", true)
	if returnsSoon(t, func() bool { return codexUserThread(p, testCodexID, "") }) {
		t.Error("FIFO accepted")
	}
}

// A command file replaced by a FIFO after its Lstat: opening it must not
// wait for a writer.
func TestReadCommandHeadFIFO(t *testing.T) {
	dir := t.TempDir()
	mkfifo(t, dir, "cmd.md", false)
	rt, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	checked := writeTestFile(t, dir, "real.md")
	if returnsSoon(t, func() bool { _, ok := readCommandHead(rt, "cmd.md", checked); return ok }) {
		t.Error("FIFO read")
	}
}

// writeTestFile writes a command file and returns what Lstat saw of it.
func writeTestFile(t *testing.T, dir, name string) os.FileInfo {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("# hi\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	return fi
}

// A command file swapped for a symlink to another file after its Lstat:
// the file opened is not the one checked, and is not read.
func TestReadCommandHeadSwapped(t *testing.T) {
	dir := t.TempDir()
	checked := writeTestFile(t, dir, "cmd.md")
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("SECRET=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "cmd.md"), filepath.Join(dir, "cmd.old")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".env", filepath.Join(dir, "cmd.md")); err != nil {
		t.Fatal(err)
	}
	rt, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if m, ok := readCommandHead(rt, "cmd.md", checked); ok {
		t.Errorf("swapped file read: %+v", m)
	}
	// Not swapped: read.
	writeTestFile(t, dir, "ok.md")
	ok, _ := os.Lstat(filepath.Join(dir, "ok.md"))
	if b, read := readCommandHead(rt, "ok.md", ok); !read || parseCommandMeta(b).description != "hi" {
		t.Errorf("ok.md = %q, %v", b, read)
	}
}

// A rollout replaced by another regular file after it was found: its
// identity differs, and it is not read.
func TestCodexUserThreadReplaced(t *testing.T) {
	home := t.TempDir()
	meta := `{"type":"session_meta","payload":{"id":"` + testCodexID + `","thread_source":"user"}}` + "\n"
	p := writeRollout(t, home, testCodexID, meta)
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if !codexUserThread(p, testCodexID, fileIdentity(fi)) {
		t.Fatal("same file refused")
	}
	// Kept under another name, so the new file cannot reuse its inode.
	if err := os.Rename(p, p+".old"); err != nil {
		t.Fatal(err)
	}
	writeRollout(t, home, testCodexID, meta)
	if codexUserThread(p, testCodexID, fileIdentity(fi)) {
		t.Error("replaced file accepted")
	}
}

// A Codex config.toml or plugin manifest that is a FIFO: neither read waits
// for a writer.
func TestCodexPluginFilesFIFO(t *testing.T) {
	home := t.TempDir()
	mkfifo(t, home, "config.toml", false)
	if returnsSoon(t, func() bool { return len(codexEnabledPlugins(readCodexConfig(home))) != 0 }) {
		t.Error("FIFO config accepted")
	}
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".codex-plugin"), 0o755)
	mkfifo(t, filepath.Join(dir, ".codex-plugin"), "plugin.json", false)
	if returnsSoon(t, func() bool { _, ok := codexPluginManifest(dir, nil); return ok }) {
		t.Error("FIFO manifest accepted")
	}
}

// A dir that is listed (a plugin's version dir parent, a skill dir) replaced
// by a FIFO: the open does not wait for a writer either.
func TestCommandDirsFIFO(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, "config.toml"), "[plugins.\"a@m\"]\n[plugins.\"b@m\"]\n")
	os.MkdirAll(filepath.Join(home, "plugins/cache/m"), 0o755)
	mkfifo(t, filepath.Join(home, "plugins/cache/m"), "a", false)
	dir := filepath.Join(home, "plugins/cache/m/b/1.0.0")
	writeFile(t, filepath.Join(dir, ".codex-plugin/plugin.json"), `{"name":"b"}`)
	mkfifo(t, dir, "skills", false)
	mkfifo(t, home, "skills", false)
	if returnsSoon(t, func() bool { return len(listCodexSkills(filesRoot{}, home, "", nil).Commands) != 0 }) {
		t.Error("a FIFO was listed")
	}
}

// A FIFO deep in a skill dir, in place of a dir, a SKILL.md or a namespace
// manifest, never holds a walk.
func TestWalkCodexSkillsFIFO(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "a/b/c"), 0o755)
	mkfifo(t, filepath.Join(dir, "a/b/c"), "d", false)
	os.MkdirAll(filepath.Join(dir, "a/s"), 0o755)
	mkfifo(t, filepath.Join(dir, "a/s"), "SKILL.md", false)
	os.MkdirAll(filepath.Join(dir, "a/p/.codex-plugin"), 0o755)
	mkfifo(t, filepath.Join(dir, "a/p/.codex-plugin"), "plugin.json", false)
	writeFile(t, filepath.Join(dir, "a/p/ok/SKILL.md"), skill("ok", "x"))
	got := ""
	if returnsSoon(t, func() bool { got = walkNames(dir, ".", codexWalkOpts{recursive: true}); return true }); got != "ok" {
		t.Errorf("skills = %q", got)
	}
}
