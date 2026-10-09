package main

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// installedCLI is a release install of 1.0.0 running from its versions dir,
// with a config, a log and an uploaded image.
func installedCLI(t *testing.T, goos string) *testCLI {
	t.Helper()
	tc := newTestCLI(t, goos)
	tc.exe = tc.versionBinary("1.0.0")
	writeFile(t, tc.exe, "bin")
	tc.setPointer("current", "1.0.0")
	tc.ensureWindowsLauncher()
	writeFile(t, tc.configFile(), "{}")
	writeFile(t, filepath.Join(tc.stateDir(), "termote.log"), "log")
	writeFile(t, filepath.Join(tc.uploadsDir(), "0123.png"), "png")
	writeFile(t, filepath.Join(tc.trashDir(), strings.Repeat("a", 32)), "deleted")
	return tc
}

func TestUninstallRemovesUploadsKeepsConfig(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		t.Run(goos, func(t *testing.T) {
			tc := installedCLI(t, goos)
			if code := tc.main([]string{"uninstall"}); code != 0 {
				t.Fatal(tc.stderr.String())
			}
			if isDir(tc.uploadsDir()) || isDir(tc.versionsDir()) {
				t.Fatal("uploads or the install stayed")
			}
			if !fileExists(tc.configFile()) || !fileExists(filepath.Join(tc.stateDir(), "termote.log")) {
				t.Fatal("config or logs removed without --purge")
			}
			// The deleted files are the user's: kept, and said where.
			if !fileExists(filepath.Join(tc.trashDir(), strings.Repeat("a", 32))) {
				t.Fatal("trash removed without --purge")
			}
			out := tc.stdout.String()
			if !strings.Contains(out, "Removed the uploaded images") || !strings.Contains(out, "Kept the config") ||
				!strings.Contains(out, "Kept the files deleted from the Files view in "+tc.trashDir()) {
				t.Fatalf("output:\n%s", out)
			}
			// Without a trash, the empty cache/termote dir goes with the
			// store (on Windows it is the install root, which keeps the
			// logs).
			os.RemoveAll(tc.trashDir())
			tc.stdout.Reset()
			writeFile(t, filepath.Join(tc.uploadsDir(), "0123.png"), "png")
			tc.main([]string{"uninstall"})
			if goos != "windows" && isDir(filepath.Dir(tc.uploadsDir())) {
				t.Fatal("empty termote cache dir stayed")
			}
			if strings.Contains(tc.stdout.String(), "Kept the files deleted") {
				t.Fatalf("output without a trash:\n%s", tc.stdout.String())
			}
		})
	}
}

func TestUploadsDirFollowsUserCacheDir(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if got, want := tc.uploadsDir(), filepath.Join(tc.home, ".cache", "termote", "uploads"); got != want {
		t.Fatalf("default %s, want %s", got, want)
	}
	xdg := filepath.Join(tc.home, "xdg-cache") // absolute on the host, Windows included
	tc.env["XDG_CACHE_HOME"] = xdg
	if got := tc.uploadsDir(); got != filepath.Join(xdg, "termote", "uploads") {
		t.Fatalf("XDG %s", got)
	}
	mac := newTestCLI(t, "darwin")
	if got := mac.uploadsDir(); got != filepath.Join(mac.home, "Library", "Caches", "termote", "uploads") {
		t.Fatalf("darwin %s", got)
	}
	win := newTestCLI(t, "windows")
	if got := win.uploadsDir(); got != filepath.Join(win.dataDir(), "uploads") {
		t.Fatalf("windows %s, want inside %s", got, win.dataDir())
	}
}

func TestUninstallPurge(t *testing.T) {
	for _, goos := range []string{"linux", "windows"} {
		t.Run(goos, func(t *testing.T) {
			tc := installedCLI(t, goos)
			if code := tc.main([]string{"uninstall", "--purge"}); code != 0 {
				t.Fatal(tc.stderr.String())
			}
			for _, dir := range []string{tc.configDir(), tc.stateDir(), tc.dataDir(), tc.uploadsDir(), tc.trashDir()} {
				if isDir(dir) {
					t.Errorf("%s stayed", dir)
				}
			}
			if strings.Contains(tc.stdout.String(), "Kept the config") {
				t.Fatalf("output:\n%s", tc.stdout.String())
			}
		})
	}
}

func TestUninstallPurgeKeepsConfigOfAnotherInstall(t *testing.T) {
	tc := newTestCLI(t, "linux")
	writeFile(t, tc.versionBinary("1.0.0"), "ELF")
	writeFile(t, tc.configFile(), "{}")
	tc.exe = "/src/termote/server/termote-dev"
	if code := tc.main([]string{"uninstall", "--purge"}); code != 0 {
		t.Fatal(tc.stderr.String())
	}
	if !fileExists(tc.configFile()) || !strings.Contains(tc.stdout.String(), "still uses them") {
		t.Fatalf("purge from a checkout dropped the install's config:\n%s", tc.stdout.String())
	}

	// Without an install elsewhere, --purge from a checkout removes them.
	tc = newTestCLI(t, "linux")
	writeFile(t, tc.configFile(), "{}")
	tc.exe = "/src/termote/server/termote-dev"
	tc.main([]string{"uninstall", "--purge"})
	if isDir(tc.configDir()) {
		t.Fatal("config stayed")
	}
}

func TestUninstallRejectsArguments(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if code := tc.main([]string{"uninstall", "now"}); code != 2 || !strings.Contains(tc.stderr.String(), "--purge") {
		t.Fatalf("code %d: %s", code, tc.stderr.String())
	}
	if code := tc.main([]string{"uninstall", "--bogus"}); code != 2 {
		t.Fatalf("unknown flag: code %d", code)
	}
}

func TestMenuUninstallAsksAboutPurge(t *testing.T) {
	for _, answer := range []string{"y", "n"} {
		tc := installedCLI(t, "linux")
		tc.interactive = true
		tc.in = bufio.NewReader(strings.NewReader("11\n" + answer + "\n"))
		if code := tc.main([]string{"menu"}); code != 0 {
			t.Fatal(tc.stderr.String())
		}
		if fileExists(tc.configFile()) != (answer == "n") {
			t.Fatalf("answer %s: config kept %v", answer, fileExists(tc.configFile()))
		}
	}
}

// A path Windows keeps locked goes through a detached PowerShell; without
// one the user is told to delete it by hand.
func TestRemoveLater(t *testing.T) {
	tc := newTestCLI(t, "windows")
	var scripts []string
	tc.startHidden = func(s string) error { scripts = append(scripts, s); return nil }
	tc.removeLater(nil)
	if len(scripts) != 0 {
		t.Fatal("nothing left, yet a cleanup started")
	}
	locked := filepath.Join(tc.versionsDir(), "1.0.0")
	tc.removeLater([]string{locked})
	if len(scripts) != 1 || !strings.Contains(scripts[0], psQuote(locked)) || !strings.Contains(tc.stdout.String(), "removed once the command exits") {
		t.Fatalf("scripts %q, output:\n%s", scripts, tc.stdout.String())
	}

	tc.startHidden = func(string) error { return errors.New("no powershell") }
	tc.removeLater([]string{locked})
	if !strings.Contains(tc.stdout.String(), "delete it once this command has exited") {
		t.Fatalf("no fallback warning:\n%s", tc.stdout.String())
	}

	// Elsewhere a running binary can be deleted: never a late cleanup.
	unix := newTestCLI(t, "linux")
	unix.startHidden = func(string) error { t.Fatal("started on linux"); return nil }
	unix.removeLater([]string{"/x"})
}

func TestRemoveLaterScript(t *testing.T) {
	s := removeLaterScript(4242, []string{`C:\Users\o'neil\AppData\Local\termote\versions`}, `C:\Users\o'neil\AppData\Local\termote`)
	for _, want := range []string{
		"Wait-Process -Id 4242",
		`@('C:\Users\o''neil\AppData\Local\termote\versions')`,
		`$root = 'C:\Users\o''neil\AppData\Local\termote'`,
		"Remove-Item -LiteralPath $_ -Recurse -Force",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("script misses %q:\n%s", want, s)
		}
	}
}

// lockIn keeps file's directory from being removed until the test ends: an
// open handle on Windows (as the running binary holds it), a read-only
// directory elsewhere.
func lockIn(t *testing.T, file string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		f, err := os.Open(file)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { f.Close() })
		return
	}
	if os.Geteuid() == 0 {
		t.Skip("root deletes from a read-only dir")
	}
	dir := filepath.Dir(file)
	os.Chmod(dir, 0o500)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
}

// What cannot be deleted (Windows: the running binary) is returned for the
// late cleanup instead of failing the uninstall.
func TestUninstallHandsLockedPathsToRemoveLater(t *testing.T) {
	tc := installedCLI(t, "windows")
	lockIn(t, tc.exe)
	var script string
	tc.startHidden = func(s string) error { script = s; return nil }
	if code := tc.main([]string{"uninstall"}); code != 0 {
		t.Fatal(tc.stderr.String())
	}
	if !strings.Contains(script, psQuote(tc.versionsDir())) || strings.Contains(tc.stdout.String(), "Removed the install") {
		t.Fatalf("script %q, output:\n%s", script, tc.stdout.String())
	}
}

func TestPurgeDataReturnsLockedDirs(t *testing.T) {
	tc := newTestCLI(t, "linux")
	log := filepath.Join(tc.stateDir(), "termote.log")
	writeFile(t, log, "log")
	lockIn(t, log)
	if left := tc.purgeData(); len(left) != 1 || left[0] != tc.stateDir() {
		t.Fatalf("left %v", left)
	}
}

func TestTrashDirFollowsUserCacheDir(t *testing.T) {
	tc := newTestCLI(t, "darwin")
	if got, want := tc.trashDir(), filepath.Join(tc.home, "Library", "Caches", "termote", "trash"); got != want {
		t.Fatalf("darwin %s, want %s", got, want)
	}
	win := newTestCLI(t, "windows")
	if got := win.trashDir(); filepath.Dir(got) != win.dataDir() {
		t.Fatalf("windows %s, want inside %s", got, win.dataDir())
	}
}

func TestRemoveTrashReturnsLockedStore(t *testing.T) {
	tc := newTestCLI(t, "linux")
	f := filepath.Join(tc.trashDir(), strings.Repeat("b", 32))
	writeFile(t, f, "x")
	lockIn(t, f)
	if left := tc.removeTrash(); len(left) != 1 || left[0] != tc.trashDir() {
		t.Fatalf("left %v", left)
	}
}

func TestRemoveUploadsReturnsLockedStore(t *testing.T) {
	tc := newTestCLI(t, "linux")
	img := filepath.Join(tc.uploadsDir(), "a.png")
	writeFile(t, img, "png")
	lockIn(t, img)
	if left := tc.removeUploads(); len(left) != 1 || left[0] != tc.uploadsDir() {
		t.Fatalf("left %v", left)
	}
}

// The launcher leaves the batch before running the exe, so cmd.exe never
// reads the file again after uninstall deleted it, and the exe's exit code
// is the last one on the line.
func TestWindowsLauncherExitsAfterTheExe(t *testing.T) {
	lines := strings.Split(strings.TrimSuffix(windowsLauncher, "\r\n"), "\r\n")
	if last := lines[len(lines)-1]; !strings.HasPrefix(last, `(goto) 2>nul & "`) || !strings.HasSuffix(last, `termote.exe" %*`) {
		t.Fatalf("last line %q", last)
	}
}

func TestEncodePowerShell(t *testing.T) {
	// "a'" as UTF-16LE is 61 00 27 00.
	if got := encodePowerShell("a'"); got != "YQAnAA==" {
		t.Fatalf("got %s", got)
	}
}

// --purge removes the container's state volume (paired devices, push), and
// says how to free one still in use.
func TestUninstallPurgeRemovesStateVolume(t *testing.T) {
	tc := installedCLI(t, "linux")
	vol := containerStateVolume()
	tc.runner.paths["podman"] = true
	tc.runner.outputs["podman volume inspect "+vol] = "[]"
	tc.runner.outputs["podman volume rm "+vol] = vol
	if code := tc.main([]string{"uninstall", "--purge"}); code != 0 {
		t.Fatal(tc.stderr.String())
	}
	if !tc.runner.called("podman volume rm " + vol) {
		t.Errorf("volume not removed: %v", tc.runner.calls)
	}

	tc = installedCLI(t, "linux")
	tc.runner.paths["podman"] = true
	tc.runner.outputs["podman volume inspect "+vol] = "[]"
	tc.main([]string{"uninstall", "--purge"})
	if !strings.Contains(tc.stderr.String()+tc.stdout.String(), "termote container down") {
		t.Errorf("no hint for a volume in use:\n%s%s", tc.stdout.String(), tc.stderr.String())
	}

	tc = installedCLI(t, "linux")
	tc.runner.paths["podman"] = true
	tc.main([]string{"uninstall"})
	if tc.runner.called("podman volume rm " + vol) {
		t.Error("volume removed without --purge")
	}
}
