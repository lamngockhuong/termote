package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
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

// makeZip is a release zip whose entries sit under top/.
func makeZip(t *testing.T, top string, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(top + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	zw.Close()
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

// fakeReleases serves the tag list and release assets like GitHub does.
type fakeReleases struct {
	tags   []string
	assets map[string][]byte // "v1.0.1/termote-1.0.1-linux-amd64.tar.gz" -> body
	goos   string            // platform whose archives publish makes
}

// updateGOOS is the install layout the update tests use: the host's own
// (symlinks on Unix, current.txt and zips on Windows). TEST_UPDATE_GOOS
// forces one, to run the Windows layout on another OS too.
func updateGOOS() string {
	if v := os.Getenv("TEST_UPDATE_GOOS"); v != "" {
		return v
	}
	if runtime.GOOS == "windows" {
		return "windows"
	}
	return "linux"
}

func (g *fakeReleases) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/repos/"+updateRepo+"/tags" {
		var parts []string
		for _, t := range g.tags {
			parts = append(parts, fmt.Sprintf(`{"name":%q}`, t))
		}
		fmt.Fprint(w, "["+strings.Join(parts, ",")+"]")
		return
	}
	if rest, ok := strings.CutPrefix(r.URL.Path, "/"+updateRepo+"/releases/download/"); ok {
		if b, ok := g.assets[rest]; ok {
			w.Write(b)
			return
		}
	}
	http.NotFound(w, r)
}

// publish adds a release archive for version and, unless sum is "none", its
// .sha256 file ("bad" writes a wrong digest).
func (g *fakeReleases) publish(t *testing.T, version, sum string) {
	name := "termote-" + version + "-linux-amd64.tar.gz"
	body := makeTarball(t, version, map[string]string{"bin/termote": "ELF " + version, "LICENSE": "MIT"})
	if g.goos == "windows" {
		name = "termote-" + version + "-windows-amd64.zip"
		body = makeZip(t, "termote-"+version+"-windows-amd64", map[string]string{"bin/termote.exe": "ELF " + version, "LICENSE": "MIT"})
	}
	g.assets["v"+version+"/"+name] = body
	switch sum {
	case "none":
		delete(g.assets, "v"+version+"/"+name+".sha256")
	case "bad":
		g.assets["v"+version+"/"+name+".sha256"] = []byte(strings.Repeat("0", 64) + "  " + name + "\n")
	default:
		g.assets["v"+version+"/"+name+".sha256"] = []byte(sha(body) + "  " + name + "\n")
	}
}

// fakeService stands in for systemd: Start serves /api/mux/health on port,
// reporting the version current points at, unless that version is broken.
type fakeService struct {
	c      *cli
	port   int
	broken map[string]string // version -> "dead" (never answers) | "wrong" (reports another version)
	users  map[string]string // version -> the only user it lets in with "pw" (none: no auth)
	srv    *http.Server
	calls  []string
}

func (f *fakeService) Name() string                            { return "fake" }
func (f *fakeService) Available() bool                         { return true }
func (f *fakeService) Installed() bool                         { return true }
func (f *fakeService) AutoStart() bool                         { return true }
func (f *fakeService) Install(string, map[string]string) error { return nil }
func (f *fakeService) Uninstall() error                        { return nil }
func (f *fakeService) Status() (bool, int, error)              { return f.srv != nil, 1, nil }
func (f *fakeService) Stop() error {
	f.calls = append(f.calls, "stop")
	if f.srv != nil {
		f.srv.Close()
		f.srv = nil
	}
	return nil
}

func (f *fakeService) Start() error {
	v := f.c.currentVersion()
	f.calls = append(f.calls, "start "+v)
	if f.broken[v] == "dead" {
		return nil
	}
	reported := v
	if f.broken[v] == "wrong" {
		reported = "0.0.1"
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(f.port))
	if err != nil {
		return err
	}
	user := f.users[v]
	f.srv = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, _ := r.BasicAuth(); user != "" && (u != user || p != "pw") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprintf(w, `{"status":"ok","version":%q}`, reported)
	})}
	go f.srv.Serve(ln)
	return nil
}

// setupUpdate is an install of 1.0.0 (current) running under a fake
// service, with a fake GitHub offering 1.0.1.
func setupUpdate(t *testing.T) (*testCLI, *fakeReleases, *fakeService) {
	t.Helper()
	oldWait, oldStable := serverStartWait, updateStable
	serverStartWait, updateStable = 1500*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { serverStartWait, updateStable = oldWait, oldStable })

	tc := newTestCLI(t, updateGOOS())
	tc.version = "1.0.0"
	writeFile(t, tc.versionBinary("1.0.0"), "ELF 1.0.0")
	if err := tc.setPointer("current", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	tc.exe = tc.versionBinary("1.0.0")
	port := freePort(t)
	tc.saveConfig(savedConfig{Port: port, NoAuth: true, Mux: "tmux", AllowHosts: []string{"box.lan"}})

	gh := &fakeReleases{tags: []string{"v0.1.0", "v1.0.0-rc.1", "v1.0.0", "v1.0.1", "latest"}, assets: map[string][]byte{}, goos: tc.goos}
	gh.publish(t, "1.0.1", "good")
	srv := httptest.NewServer(gh)
	t.Cleanup(srv.Close)
	tc.http = srv.Client()
	tc.apiBase, tc.downloadBase = srv.URL, srv.URL

	svc := &fakeService{c: tc.cli, port: port, broken: map[string]string{}}
	tc.testSupervisors = []supervisor{svc}
	if err := svc.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Stop() })
	svc.calls = nil
	return tc, gh, svc
}

func TestUpdateInstallsNewestStableAndPrunes(t *testing.T) {
	tc, _, svc := setupUpdate(t)
	writeFile(t, tc.versionBinary("0.9.0"), "old")
	cfgBefore := mustRead(t, tc.configFile())
	if code := tc.main([]string{"update"}); code != 0 {
		t.Fatalf("code %d\n%s%s", code, tc.stdout.String(), tc.stderr.String())
	}
	if tc.currentVersion() != "1.0.1" || tc.previousVersion() != "1.0.0" {
		t.Fatalf("current %q previous %q", tc.currentVersion(), tc.previousVersion())
	}
	if b := mustRead(t, tc.versionBinary("1.0.1")); string(b) != "ELF 1.0.1" {
		t.Fatalf("new binary %q", b)
	}
	if fileExists(filepath.Join(tc.versionsDir(), "0.9.0")) || !fileExists(tc.versionBinary("1.0.0")) {
		t.Fatal("prune removed the wrong versions")
	}
	if !bytes.Equal(cfgBefore, mustRead(t, tc.configFile())) {
		t.Fatal("update changed the config")
	}
	if strings.Join(svc.calls, ",") != "stop,start 1.0.1" {
		t.Fatalf("service calls %v", svc.calls)
	}
	// The service runs current, a path update never changes.
	if tc.stableExe() != tc.currentExe() {
		t.Fatalf("stableExe %s", tc.stableExe())
	}

	// Already on the newest: nothing happens.
	tc.version = "1.0.1"
	tc.exe = tc.versionBinary("1.0.1")
	tc.stdout.Reset()
	if code := tc.main([]string{"update"}); code != 0 || !strings.Contains(tc.stdout.String(), "Already on v1.0.1") {
		t.Fatalf("no-op update: code %d\n%s", code, tc.stdout.String())
	}
}

func TestUpdateTwiceKeepsTwoVersions(t *testing.T) {
	tc, gh, svc := setupUpdate(t)
	gh.publish(t, "1.0.2", "good")
	for _, v := range []string{"1.0.1", "1.0.2"} {
		if code := tc.main([]string{"update", "--version", v}); code != 0 {
			t.Fatalf("update %s: %s", v, tc.stderr.String())
		}
	}
	entries, _ := os.ReadDir(tc.versionsDir())
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if strings.Join(names, ",") != "1.0.1,1.0.2" || tc.currentVersion() != "1.0.2" {
		t.Fatalf("versions %v current %s", names, tc.currentVersion())
	}
	if last := svc.calls[len(svc.calls)-1]; last != "start 1.0.2" {
		t.Fatalf("service runs %s", last)
	}
}

func TestUpdateRollsBack(t *testing.T) {
	for _, how := range []string{"dead", "wrong"} {
		t.Run(how, func(t *testing.T) {
			tc, _, svc := setupUpdate(t)
			svc.broken["1.0.1"] = how
			if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "rolled back to v1.0.0") {
				t.Fatalf("code %d\nstderr %s", code, tc.stderr.String())
			}
			if tc.currentVersion() != "1.0.0" {
				t.Fatalf("current %s after rollback", tc.currentVersion())
			}
			if h, code := fetchHealth(svc.port, "", ""); code != 200 || h.Version != "1.0.0" {
				t.Fatalf("old version not answering: %d %+v", code, h)
			}
			if !fileExists(tc.versionBinary("1.0.1")) {
				t.Fatal("failed version removed; it is kept for inspection")
			}
		})
	}
}

// The health checks log in with the saved username; a version from before it
// still serves admin, which counts too, with a warning, instead of rolling
// back.
func TestUpdateUsesSavedUser(t *testing.T) {
	for _, tt := range []struct{ serves, warn string }{{"bob", ""}, {adminUser, "ignores the saved username"}} {
		t.Run(tt.serves, func(t *testing.T) {
			tc, _, svc := setupUpdate(t)
			tc.saveConfig(savedConfig{Port: svc.port, Mux: "tmux", User: "bob", Password: "pw"})
			svc.users = map[string]string{"1.0.0": "bob", "1.0.1": tt.serves}
			if code := tc.main([]string{"update"}); code != 0 || tc.currentVersion() != "1.0.1" {
				t.Fatalf("code %d current %s\nstderr %s", code, tc.currentVersion(), tc.stderr.String())
			}
			if got := strings.Contains(tc.stderr.String()+tc.stdout.String(), "ignores the saved username"); got != (tt.warn != "") {
				t.Fatalf("warning shown = %v\nstdout %s\nstderr %s", got, tc.stdout.String(), tc.stderr.String())
			}
		})
	}
	// Letting in neither the saved user nor admin is a failed update.
	tc, _, svc := setupUpdate(t)
	tc.saveConfig(savedConfig{Port: svc.port, Mux: "tmux", User: "bob", Password: "pw"})
	svc.users = map[string]string{"1.0.0": "bob", "1.0.1": "carol"}
	if code := tc.main([]string{"update"}); code != 1 || tc.currentVersion() != "1.0.0" || !strings.Contains(tc.stderr.String(), "rolled back to v1.0.0") {
		t.Fatalf("code %d current %s\nstderr %s", code, tc.currentVersion(), tc.stderr.String())
	}
}

func TestUpdateRollbackAlsoFails(t *testing.T) {
	tc, _, svc := setupUpdate(t)
	svc.broken["1.0.1"], svc.broken["1.0.0"] = "dead", "dead"
	if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "Recover by hand") ||
		!strings.Contains(tc.stderr.String(), "TERMOTE_VERSION=1.0.0 sh") {
		t.Fatalf("code %d\nstderr %s", code, tc.stderr.String())
	}
	if !fileExists(tc.versionBinary("1.0.0")) || !fileExists(tc.versionBinary("1.0.1")) {
		t.Fatal("a version was removed after a failed rollback")
	}
}

func TestUpdateRefusesUnverifiedDownloads(t *testing.T) {
	for _, sum := range []string{"none", "bad"} {
		t.Run(sum, func(t *testing.T) {
			tc, gh, svc := setupUpdate(t)
			gh.publish(t, "1.0.1", sum)
			if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "unverified") && !strings.Contains(tc.stderr.String(), "mismatch") {
				t.Fatalf("code %d stderr %s", code, tc.stderr.String())
			}
			if fileExists(filepath.Join(tc.versionsDir(), "1.0.1")) || tc.currentVersion() != "1.0.0" || len(svc.calls) != 0 {
				t.Fatalf("an unverified download changed the install (calls %v)", svc.calls)
			}
			if leftovers, _ := filepath.Glob(filepath.Join(tc.dataDir(), ".*")); len(leftovers) != 0 {
				t.Fatalf("temp files left: %v", leftovers)
			}
		})
	}
}

func TestUpdateGuards(t *testing.T) {
	tc, gh, _ := setupUpdate(t)
	if code := tc.main([]string{"update", "--version", "1.0"}); code != 2 {
		t.Fatalf("invalid version: code %d", code)
	}
	tc.stderr.Reset()
	if code := tc.main([]string{"update", "--version", "9.9.9"}); code != 1 || !strings.Contains(tc.stderr.String(), "still publishing") {
		t.Fatalf("missing release: %s", tc.stderr.String())
	}
	gh.tags = []string{"v0.1.0", "v1.0.0-rc.2"}
	tc.stderr.Reset()
	if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "no 1.x release") {
		t.Fatalf("no stable release: %s", tc.stderr.String())
	}
	tc.exe = "/usr/local/bin/termote"
	tc.stderr.Reset()
	if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "install.sh") {
		t.Fatalf("not an install: %s", tc.stderr.String())
	}
	writeFile(t, filepath.Join(tc.projectDir, "pwa", "package.json"), "{}")
	tc.stderr.Reset()
	if code := tc.main([]string{"update"}); code != 1 || !strings.Contains(tc.stderr.String(), "git checkout") {
		t.Fatalf("checkout: %s", tc.stderr.String())
	}
}

func TestNewestStable(t *testing.T) {
	for want, tags := range map[string][]string{
		"1.0.10": {"v1.0.9", "v1.0.10", "v1.0.2", "v2.0.0-rc.1", "v0.9.9"},
		"":       {"v0.1.0", "v1.0.0-rc.1", "latest", "1.2.3"},
		"2.0.0":  {"v1.9.9", "v2.0.0"},
	} {
		if got := newestStable(tags); got != want {
			t.Errorf("newestStable(%v) = %q, want %q", tags, got, want)
		}
	}
}

func TestInstallVersionFromZip(t *testing.T) {
	tc := newTestCLI(t, "windows")
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range map[string]string{"termote-1.0.1-windows-amd64/bin/termote.exe": "MZ", "termote-1.0.1-windows-amd64/LICENSE": "MIT", "../evil": "x"} {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()
	archive := filepath.Join(t.TempDir(), tc.releaseAsset("1.0.1"))
	os.WriteFile(archive, buf.Bytes(), 0o644)
	if !strings.HasSuffix(archive, "termote-1.0.1-windows-amd64.zip") {
		t.Fatalf("asset name %s", archive)
	}
	if err := tc.installVersion(archive, "1.0.1"); err != nil {
		t.Fatal(err)
	}
	if b := mustRead(t, tc.versionBinary("1.0.1")); string(b) != "MZ" {
		t.Fatalf("binary %q", b)
	}
	if err := tc.switchCurrent("1.0.1"); err != nil || tc.currentVersion() != "1.0.1" {
		t.Fatalf("switch: %v %q", err, tc.currentVersion())
	}
	if b := mustRead(t, tc.currentExe()); string(b) != windowsLauncher {
		t.Fatal("launcher not written")
	}
}

func TestRollbackKeepsPreviousAndForceReinstalls(t *testing.T) {
	tc, gh, svc := setupUpdate(t)
	writeFile(t, tc.versionBinary("0.9.9"), "ELF 0.9.9")
	tc.setPointer("previous", "0.9.9")
	svc.broken["1.0.1"] = "dead"
	tc.main([]string{"update"})
	if tc.currentVersion() != "1.0.0" || tc.previousVersion() != "0.9.9" {
		t.Fatalf("after rollback current %q previous %q", tc.currentVersion(), tc.previousVersion())
	}

	// --force on the running version lays it down again (a damaged copy).
	gh.publish(t, "1.0.0", "good")
	writeFile(t, tc.versionBinary("1.0.0"), "damaged")
	tc.stderr.Reset()
	if code := tc.main([]string{"update", "--version", "1.0.0", "--force"}); code != 0 {
		t.Fatalf("force: %s", tc.stderr.String())
	}
	if b := mustRead(t, tc.versionBinary("1.0.0")); string(b) != "ELF 1.0.0" {
		t.Fatalf("not reinstalled: %q", b)
	}
}

func TestUninstallKeepsStateAndOthersInstalls(t *testing.T) {
	win := newTestCLI(t, "windows")
	win.exe = win.versionBinary("1.0.0")
	writeFile(t, win.exe, "MZ")
	win.setPointer("current", "1.0.0")
	win.ensureWindowsLauncher()
	writeFile(t, filepath.Join(win.stateDir(), "termote.log"), "log")
	if code := win.main([]string{"uninstall"}); code != 0 {
		t.Fatal(win.stderr.String())
	}
	if !fileExists(filepath.Join(win.stateDir(), "termote.log")) || fileExists(win.pointerPath("current")) || isDir(win.versionsDir()) {
		t.Fatal("uninstall removed the logs or kept the install")
	}

	// From a checkout, an install elsewhere is left alone.
	tc := newTestCLI(t, "linux")
	writeFile(t, tc.versionBinary("1.0.0"), "ELF")
	tc.exe = "/src/termote/server/termote-dev"
	tc.main([]string{"uninstall"})
	if !fileExists(tc.versionBinary("1.0.0")) || !strings.Contains(tc.stdout.String(), "left alone") {
		t.Fatalf("checkout uninstall touched the install:\n%s", tc.stdout.String())
	}
}
