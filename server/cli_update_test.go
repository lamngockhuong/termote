package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeTarball(t *testing.T, version string, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	top := "termote-v" + version + "/"
	tw.WriteHeader(&tar.Header{Name: top, Typeflag: tar.TypeDir, Mode: 0o755})
	for name, body := range files {
		mode := int64(0o644)
		if strings.HasSuffix(name, ".sh") || strings.HasPrefix(name, "termote-") {
			mode = 0o755
		}
		full := top + name
		if strings.HasPrefix(name, "../") || strings.HasPrefix(name, "/") {
			full = name // hostile entry, written as-is
		}
		if err := tw.WriteHeader(&tar.Header{Name: full, Typeflag: tar.TypeReg, Mode: mode, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestExtractTarballRejectsEscapingPaths(t *testing.T) {
	dir := t.TempDir()
	install := filepath.Join(dir, "install")
	tarball := makeTarball(t, "1.0.0", map[string]string{
		"ok.txt":           "fine",
		"../../escape.txt": "bad",
		"sub/../../up.txt": "bad",
	})
	file := filepath.Join(dir, "t.tar.gz")
	os.WriteFile(file, tarball, 0o644)
	if err := extractTarball(file, install); err != nil {
		t.Fatal(err)
	}
	if !fileExists(filepath.Join(install, "ok.txt")) {
		t.Fatal("regular file not extracted")
	}
	for _, p := range []string{filepath.Join(dir, "escape.txt"), filepath.Join(dir, "up.txt"), filepath.Join(install, "..", "up.txt")} {
		if fileExists(p) {
			t.Fatalf("%s written outside the install dir", p)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "0.1.0", 1},
		{"0.1.0", "0.1.0", 0},
		{"0.9.9", "0.10.0", -1},
		{"1.0.0-rc.1", "1.0.0", -1},
		{"1.0.0-rc.1", "0.1.5", 1},
		{"1.0.0-rc.2", "1.0.0-rc.10", -1},
		{"1.0.0-alpha", "1.0.0-beta", -1},
		{"1.0.0-1", "1.0.0-alpha", -1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCleanupReplacedBinaries(t *testing.T) {
	tc := newTestCLI(t, "windows")
	old := filepath.Join(tc.projectDir, "termote-windows-amd64.exe.old-123")
	keep := filepath.Join(tc.projectDir, "termote-windows-amd64.exe")
	writeFile(t, old, "x")
	writeFile(t, keep, "x")
	tc.cleanupReplacedBinaries()
	if fileExists(old) || !fileExists(keep) {
		t.Fatal("cleanup removed the wrong files")
	}
}

func TestStripTopDirRejectsBackslashAndEscapes(t *testing.T) {
	for _, bad := range []string{`top/..\..\x`, `top/a\b`, "top/../../x", "top/", "top"} {
		if rel, ok := stripTopDir(bad); ok && (strings.Contains(rel, "..") || strings.Contains(rel, `\`)) {
			t.Errorf("stripTopDir(%q) = %q, accepted", bad, rel)
		}
	}
	if rel, ok := stripTopDir(`top/..\..\x`); ok {
		t.Errorf("backslash entry accepted as %q", rel)
	}
	// An absolute name loses its first element and stays inside the dir,
	// like tar --strip-components=1.
	if rel, ok := stripTopDir("/etc/passwd"); !ok || rel != "passwd" {
		t.Errorf("absolute entry: %q %v", rel, ok)
	}
	if rel, ok := stripTopDir("termote-v1/scripts/termote.sh"); !ok || rel != "scripts/termote.sh" {
		t.Errorf("normal entry: %q %v", rel, ok)
	}
}

func TestUpdateGuards(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if code := tc.main([]string{"update", "--version", "1.0"}); code != 2 {
		t.Fatalf("invalid version: code %d", code)
	}
	tc.stderr.Reset()
	if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "not available in this build") {
		t.Fatalf("code %d stderr %q", code, tc.stderr.String())
	}
	writeFile(t, filepath.Join(tc.projectDir, "pwa", "package.json"), "{}")
	tc.stderr.Reset()
	if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "git checkout") {
		t.Fatalf("checkout: code %d stderr %q", code, tc.stderr.String())
	}
}
