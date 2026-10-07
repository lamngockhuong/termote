package main

import (
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// The errors a full disk, a full quota and write-protected media give.
var (
	errDiskFull      error = windows.ERROR_DISK_FULL
	errQuotaFull     error = windows.ERROR_DISK_QUOTA_EXCEEDED
	errReadOnlyMount error = windows.ERROR_WRITE_PROTECT
)

func TestIsStorageFullHandle(t *testing.T) {
	if !isStorageFull(&fs.PathError{Op: "write", Path: "x", Err: windows.ERROR_HANDLE_DISK_FULL}) {
		t.Error("ERROR_HANDLE_DISK_FULL is a full disk")
	}
}

func TestFilesCreateWindowsNames(t *testing.T) {
	fx := newFilesFixture(t)
	for _, p := range []string{"a<b", "a>b", "a:b", `a"b`, "a|b", "a?b", "a*b", "x.md:stream", `C:\x`, "NUL", `docs\`, `a\\b`} {
		code, got := fx.create(t, fx.root, map[string]any{"path": p})
		if code != http.StatusBadRequest || got["code"] != "invalid_name" {
			t.Errorf("%q = %d %v", p, code, got)
		}
	}
	// '\' separates directories.
	if code, got := fx.create(t, fx.root, map[string]any{"path": `w\v.md`}); code != http.StatusCreated || got["path"] != "w/v.md" {
		t.Errorf(`w\v.md = %d %v`, code, got)
	}
	// And the name taken is reported with '/', as a create reports it.
	if code, got := fx.create(t, fx.root, map[string]any{"path": `w\v.md`}); code != http.StatusConflict || got["path"] != "w/v.md" {
		t.Errorf(`w\v.md again = %d %v`, code, got)
	}
}

// A deny dir reached by its 8.3 short name is only recognised once it is
// opened: nothing is made inside it.
func TestFilesCreateShortName(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(base, "root")
	data := filepath.Join(root, "termote-data")
	writeFile(t, filepath.Join(data, "current"), "1.0.0\n")
	short := shortName(t, data)
	if short == "" {
		t.Skip("8.3 names are off on this volume")
	}
	cfg := testConfig(t)
	cfg.FilesWriteDenyDirs = []string{data}
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	fx := &filesFixture{root: root, h: h}
	for _, rel := range []string{short + "/x.md", short + "/new/x.md"} {
		code, got := fx.create(t, root, map[string]any{"path": rel})
		if code != http.StatusForbidden || got["code"] != "not_allowed" {
			t.Errorf("%s = %d %v", rel, code, got)
		}
	}
	notExist(t, filepath.Join(data, "x.md"))
	notExist(t, filepath.Join(data, "new"))
}

// shortName is the 8.3 name of the last component of p, or "" without one.
func shortName(t *testing.T, p string) string {
	t.Helper()
	long, err := windows.UTF16PtrFromString(p)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]uint16, windows.MAX_PATH)
	n, err := windows.GetShortPathName(long, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 {
		return ""
	}
	s := filepath.Base(windows.UTF16ToString(buf[:n]))
	if s == filepath.Base(p) {
		return ""
	}
	return s
}

// A junction on the path is never walked through, wherever it leads: inside
// the root, out of it, or into termote's own data or upload dir. Go reports
// a junction as irregular, neither a symlink nor a directory: 403 symlink.
func TestFilesCreateJunction(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(base, "root")
	inner := filepath.Join(root, "inner")
	outside := filepath.Join(base, "outside")
	data := filepath.Join(base, "data")
	uploads := filepath.Join(base, "uploads")
	for _, d := range []string{inner, outside, data, uploads} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cfg := testConfig(t)
	cfg.FilesWriteDenyDirs = []string{data}
	cfg.UploadDir = uploads
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: root, files: true})
	if err != nil {
		t.Fatal(err)
	}
	fx := &filesFixture{root: root, h: h}
	for name, target := range map[string]string{"j-inner": inner, "j-out": outside, "j-data": data, "j-up": uploads} {
		junction(t, filepath.Join(root, name), target)
		for _, rel := range []string{name + "/x.md", name + "/new/x.md"} {
			code, got := fx.create(t, root, map[string]any{"path": rel})
			if code != http.StatusForbidden || got["code"] != "symlink" {
				t.Errorf("%s = %d %v", rel, code, got)
			}
		}
		notExist(t, filepath.Join(target, "x.md"))
		notExist(t, filepath.Join(target, "new"))
	}
}

// junction makes link a junction to the directory target, or skips the test
// when this system cannot make one.
func junction(t *testing.T, link, target string) {
	t.Helper()
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("mklink /J: %v %s", err, out)
	}
}
