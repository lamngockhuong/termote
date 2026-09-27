package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeGitHub serves releases/latest, a tarball and checksums.txt.
type fakeGitHub struct {
	latest    string
	tarballs  map[string][]byte // version -> tarball
	checksums map[string]string // version -> checksums.txt body; missing = 404
	hits      []string
}

func (g *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.hits = append(g.hits, r.URL.Path)
	if r.URL.Path == "/repos/"+updateRepo+"/releases/latest" {
		fmt.Fprintf(w, `{"tag_name":"v%s"}`, g.latest)
		return
	}
	prefix := "/" + updateRepo + "/releases/download/v"
	if rest, ok := strings.CutPrefix(r.URL.Path, prefix); ok {
		version, file, _ := strings.Cut(rest, "/")
		switch {
		case file == "termote-v"+version+".tar.gz" && g.tarballs[version] != nil:
			w.Write(g.tarballs[version])
			return
		case file == "checksums.txt":
			if body, ok := g.checksums[version]; ok {
				fmt.Fprint(w, body)
				return
			}
		}
	}
	http.NotFound(w, r)
}

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

// setupUpdate returns a CLI on an installed 0.1.0 with a saved config and a
// fake GitHub offering 1.0.0.
func setupUpdate(t *testing.T) (*testCLI, *fakeGitHub, *[][]string) {
	t.Helper()
	tc := newTestCLI(t, "linux")
	tc.version = "0.1.0"
	writeFile(t, filepath.Join(tc.projectDir, ".version"), "0.1.0")
	writeFile(t, filepath.Join(tc.projectDir, "scripts", "termote.sh"), "old")
	tc.saveConfig(savedConfig{Mode: "container", Port: 7700, Password: "keep-me"})

	tarball := makeTarball(t, "1.0.0", map[string]string{
		"scripts/termote.sh":  "#!/bin/bash\n# 1.0 shim\n",
		"termote-linux-amd64": "ELF-1.0",
		"pwa-dist/index.html": "<html>1.0</html>",
	})
	gh := &fakeGitHub{
		latest:    "1.0.0",
		tarballs:  map[string][]byte{"1.0.0": tarball},
		checksums: map[string]string{"1.0.0": sha(tarball) + "  termote-v1.0.0.tar.gz\nabc  termote.sh\n"},
	}
	srv := httptest.NewServer(gh)
	t.Cleanup(srv.Close)
	tc.http = srv.Client()
	tc.apiBase, tc.downloadBase = srv.URL, srv.URL
	var execs [][]string
	tc.execShim = func(path string, args []string) error {
		execs = append(execs, append([]string{path}, args...))
		return nil
	}
	return tc, gh, &execs
}

func TestUpdateInstallsLatestAndExecsNewShim(t *testing.T) {
	tc, _, execs := setupUpdate(t)
	if code := tc.main([]string{"update"}); code != 0 {
		t.Fatalf("code %d\n%s\n%s", code, tc.stdout.String(), tc.stderr.String())
	}
	if got := string(mustRead(t, filepath.Join(tc.projectDir, "scripts", "termote.sh"))); !strings.Contains(got, "1.0 shim") {
		t.Fatalf("shim not replaced: %q", got)
	}
	if got := string(mustRead(t, filepath.Join(tc.projectDir, ".version"))); got != "1.0.0" {
		t.Fatalf(".version = %q", got)
	}
	cfg, _ := tc.loadConfig()
	if cfg == nil || cfg.Password != "keep-me" || cfg.Port != 7700 {
		t.Fatalf("config not kept: %+v", cfg)
	}
	want := []string{tc.shimPath(), "install", "container"}
	if len(*execs) != 1 || strings.Join((*execs)[0], " ") != strings.Join(want, " ") {
		t.Fatalf("exec %v, want %v", *execs, want)
	}
	if !strings.Contains(tc.stdout.String(), "Checksum verified") {
		t.Fatalf("checksum not verified:\n%s", tc.stdout.String())
	}
}

func TestUpdateChecksumMismatchStopsBeforeExtract(t *testing.T) {
	tc, gh, execs := setupUpdate(t)
	gh.checksums["1.0.0"] = strings.Repeat("0", 64) + "  termote-v1.0.0.tar.gz\n"
	if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "checksum mismatch") {
		t.Fatalf("code %d stderr %q", code, tc.stderr.String())
	}
	if got := string(mustRead(t, filepath.Join(tc.projectDir, "scripts", "termote.sh"))); got != "old" {
		t.Fatal("files extracted despite a bad checksum")
	}
	if len(*execs) != 0 {
		t.Fatal("shim executed after a failed update")
	}
}

func TestUpdateWithoutChecksumsWarnsAndContinues(t *testing.T) {
	tc, gh, _ := setupUpdate(t)
	delete(gh.checksums, "1.0.0")
	if code := tc.main([]string{"update"}); code != 0 || !strings.Contains(tc.stdout.String(), "skipping verification") {
		t.Fatalf("code %d out %q", code, tc.stdout.String())
	}
}

func TestUpdateGuards(t *testing.T) {
	t.Run("already on target", func(t *testing.T) {
		tc, gh, _ := setupUpdate(t)
		tc.version = "1.0.0"
		if code := tc.main([]string{"update"}); code != 0 || !strings.Contains(tc.stdout.String(), "Already on v1.0.0") {
			t.Fatalf("code %d out %q", code, tc.stdout.String())
		}
		for _, h := range gh.hits {
			if strings.Contains(h, "download") {
				t.Fatal("downloaded while already up to date")
			}
		}
	})
	t.Run("force reinstalls", func(t *testing.T) {
		tc, _, execs := setupUpdate(t)
		tc.version = "1.0.0"
		if code := tc.main([]string{"update", "--force"}); code != 0 || len(*execs) != 1 {
			t.Fatalf("code %d execs %v", code, *execs)
		}
	})
	t.Run("checkout refused", func(t *testing.T) {
		tc, _, _ := setupUpdate(t)
		writeFile(t, filepath.Join(tc.projectDir, "pwa", "package.json"), "{}")
		if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "git checkout") {
			t.Fatalf("code %d stderr %q", code, tc.stderr.String())
		}
	})
	t.Run("invalid version", func(t *testing.T) {
		tc, _, _ := setupUpdate(t)
		if code := tc.main([]string{"update", "--version", "1.0"}); code != 2 {
			t.Fatalf("code %d", code)
		}
	})
	t.Run("no saved config", func(t *testing.T) {
		tc, _, _ := setupUpdate(t)
		os.Remove(tc.configFile())
		if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "no saved config") {
			t.Fatalf("code %d stderr %q", code, tc.stderr.String())
		}
	})
	t.Run("missing release", func(t *testing.T) {
		tc, _, _ := setupUpdate(t)
		if code := tc.main([]string{"update", "--version", "9.9.9"}); code != 1 || !strings.Contains(tc.stderr.String(), "download failed") {
			t.Fatalf("code %d stderr %q", code, tc.stderr.String())
		}
	})
}

func TestUpdatePinnedPrereleaseAndDowngrade(t *testing.T) {
	tc, gh, execs := setupUpdate(t)
	rc := makeTarball(t, "1.0.0-rc.1", map[string]string{"scripts/termote.sh": "rc"})
	gh.tarballs["1.0.0-rc.1"] = rc
	gh.checksums["1.0.0-rc.1"] = sha(rc) + "  termote-v1.0.0-rc.1.tar.gz\n"
	if code := tc.main([]string{"update", "--version", "v1.0.0-rc.1"}); code != 0 || len(*execs) != 1 {
		t.Fatalf("rc: code %d stderr %q", code, tc.stderr.String())
	}
	if strings.Contains(tc.stdout.String(), "Downgrading") {
		t.Fatal("0.1.0 -> 1.0.0-rc.1 reported as a downgrade")
	}

	tc.version = "1.0.0"
	tc.stdout.Reset()
	tc.main([]string{"update", "--version", "1.0.0-rc.1"})
	if !strings.Contains(tc.stdout.String(), "Downgrading from v1.0.0 to v1.0.0-rc.1") {
		t.Fatalf("downgrade not warned:\n%s", tc.stdout.String())
	}
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

func TestUpdateKeepsServicesRunningWhenDownloadFails(t *testing.T) {
	tc, _, _ := setupUpdate(t)
	stopped := false
	tc.procs = func() ([]procInfo, error) { stopped = true; return nil, nil }
	if code := tc.main([]string{"update", "--version", "9.9.9"}); code != 1 {
		t.Fatalf("code %d", code)
	}
	if stopped {
		t.Fatal("services stopped before the download succeeded")
	}
}
