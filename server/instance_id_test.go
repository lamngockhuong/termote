package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadInstanceIDKeepsOne(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	id := loadInstanceID(dir)
	if !instanceIDRe.MatchString(id) {
		t.Fatalf("id = %q, want 16 hex digits", id)
	}
	if again := loadInstanceID(dir); again != id {
		t.Fatalf("second read = %q, want %q", again, id)
	}
	fi, err := os.Stat(filepath.Join(dir, instanceFile))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", fi.Mode().Perm())
	}
}

func TestLoadInstanceIDReplacesCorrupt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, instanceFile)
	if err := os.WriteFile(path, []byte("not an id"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A crash's leftover part is removed.
	part := filepath.Join(dir, ".instance-0123456789abcdef.part")
	if err := os.WriteFile(part, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	id := loadInstanceID(dir)
	if !instanceIDRe.MatchString(id) {
		t.Fatalf("id = %q", id)
	}
	data, _ := os.ReadFile(path)
	if string(data) != id+"\n" {
		t.Fatalf("file = %q, want %q", data, id+"\n")
	}
	if _, err := os.Stat(part); !os.IsNotExist(err) {
		t.Fatalf("part left: %v", err)
	}
}

func TestLoadInstanceIDWithoutDir(t *testing.T) {
	a, b := loadInstanceID(""), loadInstanceID("")
	if !instanceIDRe.MatchString(a) || a == b {
		t.Fatalf("ids = %q, %q: want two different random ids", a, b)
	}
}

func TestLoadInstanceIDUnreadable(t *testing.T) {
	dir := t.TempDir()
	// A directory where the file should be: not a regular file, never
	// replaced, but the server still gets an id.
	if err := os.Mkdir(filepath.Join(dir, instanceFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if id := loadInstanceID(dir); !instanceIDRe.MatchString(id) {
		t.Fatalf("id = %q", id)
	}
	// A dir that cannot be made.
	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if id := loadInstanceID(filepath.Join(file, "sub")); !instanceIDRe.MatchString(id) {
		t.Fatalf("id = %q", id)
	}
}

func TestLoadInstanceIDUnwritable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a dir the user cannot write")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	a, b := loadInstanceID(dir), loadInstanceID(dir)
	if !instanceIDRe.MatchString(a) || a == b {
		t.Fatalf("ids = %q, %q: want a new one each time", a, b)
	}
}

func TestSnapshotHasInstanceID(t *testing.T) {
	dir := t.TempDir()
	cfg := serveConfig{NoAuth: true, InstanceDir: dir}
	h, _, _, err := buildServer(cfg, &filesFakeMux{dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/mux/snapshot", nil)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var snap Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatal(err)
	}
	if want := loadInstanceID(dir); snap.InstanceID != want {
		t.Fatalf("instanceId = %q, want %q", snap.InstanceID, want)
	}
}
