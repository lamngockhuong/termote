package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A 1x1 lossless WebP; the standard library has no WebP encoder.
const tinyWebP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="

func testImage(t *testing.T, mediaType string) []byte {
	t.Helper()
	img := image.NewPaletted(image.Rect(0, 0, 4, 4), color.Palette{color.Black, color.White})
	var b bytes.Buffer
	var err error
	switch mediaType {
	case "image/png":
		err = png.Encode(&b, img)
	case "image/jpeg":
		err = jpeg.Encode(&b, img, nil)
	case "image/gif":
		err = gif.Encode(&b, img, nil)
	case "image/webp":
		var raw []byte
		raw, err = base64.StdEncoding.DecodeString(tinyWebP)
		b.Write(raw)
	}
	if err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func newTestUploadStore(t *testing.T) *uploadStore {
	t.Helper()
	s, err := newUploadStore(filepath.Join(t.TempDir(), "uploads"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// uploadHandler is the full server with an upload dir.
func uploadHandler(t *testing.T) (http.Handler, string) {
	t.Helper()
	cfg := testConfig(t)
	cfg.UploadDir = filepath.Join(t.TempDir(), "uploads")
	h, err := newServeHandler(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	return h, cfg.UploadDir
}

func uploadRequest(body []byte, contentType string) *http.Request {
	req := apiRequest("POST", "/api/mux/uploads", string(body))
	req.Header.Set("Content-Type", contentType)
	return req
}

var savedNameRe = regexp.MustCompile(`^[0-9a-f]{32}\.(png|jpg|gif|webp)$`)

func TestUploadSavesEachImageType(t *testing.T) {
	for mt, ext := range uploadExts {
		t.Run(mt, func(t *testing.T) {
			h, dir := uploadHandler(t)
			rec := serve(h, uploadRequest(testImage(t, mt), mt))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
			}
			body := decodeBody(t, rec)
			id, _ := body["id"].(string)
			path, _ := body["path"].(string)
			if !uploadIDRe.MatchString(id) {
				t.Errorf("id = %q", id)
			}
			if filepath.Dir(path) != dir || !savedNameRe.MatchString(filepath.Base(path)) || filepath.Ext(path) != "."+ext {
				t.Errorf("path = %q, want %s/<32 hex>.%s", path, dir, ext)
			}
			if body["insert"] != path {
				t.Errorf("insert = %v, want the path", body["insert"])
			}
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, testImage(t, mt)) {
				t.Errorf("saved file differs: %v", err)
			}
			if runtime.GOOS != "windows" {
				if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
					t.Errorf("file mode = %v, want 0600", fi.Mode().Perm())
				}
				if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
					t.Errorf("dir mode = %v, want 0700", fi.Mode().Perm())
				}
			}
		})
	}
}

func TestUploadRejects(t *testing.T) {
	pngBytes := testImage(t, "image/png")
	tooLarge := append(append([]byte{}, pngBytes...), make([]byte, uploadMaxFile)...)
	tests := []struct {
		name     string
		body     []byte
		ct       string
		mutate   func(*http.Request)
		wantCode int
		wantErr  string // the JSON code; "" when the guard answers
	}{
		{"declared png, bytes jpeg", testImage(t, "image/jpeg"), "image/png", nil, 415, "unsupported_image"},
		{"text named as png", []byte("hello, not an image"), "image/png", nil, 415, "unsupported_image"},
		{"empty body", nil, "image/png", nil, 415, "unsupported_image"},
		{"over 10 MB", tooLarge, "image/png", nil, 413, "too_large"},
		{"multipart", pngBytes, "multipart/form-data; boundary=x", nil, 415, "unsupported_image"},
		{"text/plain", pngBytes, "text/plain", nil, 415, "unsupported_image"},
		{"svg", []byte("<svg/>"), "image/svg+xml", nil, 415, "unsupported_image"},
		{"cross-site", pngBytes, "image/png", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403, ""},
		{"foreign origin", pngBytes, "image/png", func(r *http.Request) { r.Header.Set("Origin", "https://evil.com") }, 403, ""},
		{"no credentials", pngBytes, "image/png", func(r *http.Request) { r.Header.Del("Authorization") }, 401, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, dir := uploadHandler(t)
			req := uploadRequest(tt.body, tt.ct)
			if tt.mutate != nil {
				tt.mutate(req)
			}
			rec := serve(h, req)
			if rec.Code != tt.wantCode {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.wantCode, rec.Body.String())
			}
			if tt.wantErr != "" {
				if got := decodeBody(t, rec)["code"]; got != tt.wantErr {
					t.Errorf("code = %v, want %s", got, tt.wantErr)
				}
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 0 {
				t.Errorf("dir holds %d files after a refused upload", len(entries))
			}
		})
	}
}

// save refuses a declared type it does not take, whatever the bytes.
func TestUploadSaveUnknownType(t *testing.T) {
	s := newTestUploadStore(t)
	_, err := s.save(bytes.NewReader(testImage(t, "image/png")), "image/bmp")
	if !errors.Is(err, errUploadUnsupported) || err.Error() != errUploadUnsupported.msg {
		t.Errorf("save as image/bmp = %v", err)
	}
}

func TestUploadWrongMethod(t *testing.T) {
	h, _ := uploadHandler(t)
	rec := serve(h, apiRequest("GET", "/api/mux/uploads", ""))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d, want 405", rec.Code)
	}
}

// Without an upload dir the route answers 503 and the snapshot says so.
func TestUploadsUnavailable(t *testing.T) {
	h := newTestHandler(t, &fakeMux{})
	rec := serve(h, uploadRequest(testImage(t, "image/png"), "image/png"))
	if rec.Code != http.StatusServiceUnavailable || decodeBody(t, rec)["code"] != "uploads_unavailable" {
		t.Errorf("upload without a dir = %d %s", rec.Code, rec.Body.String())
	}
	if caps := snapshotCaps(t, h); caps["uploads"] != false {
		t.Errorf("caps.uploads = %v, want false", caps["uploads"])
	}
	withDir, _ := uploadHandler(t)
	if caps := snapshotCaps(t, withDir); caps["uploads"] != true {
		t.Errorf("caps.uploads = %v, want true", caps["uploads"])
	}
}

func snapshotCaps(t *testing.T, h http.Handler) map[string]any {
	t.Helper()
	rec := serve(h, apiRequest("GET", "/api/mux/snapshot", ""))
	caps, _ := decodeBody(t, rec)["caps"].(map[string]any)
	return caps
}

// An unusable dir disables uploads; the rest of the server runs.
func TestUploadDirUnusable(t *testing.T) {
	cfg := testConfig(t)
	file := filepath.Join(t.TempDir(), "file")
	os.WriteFile(file, nil, 0o600)
	cfg.UploadDir = file
	h, err := newServeHandler(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	if caps := snapshotCaps(t, h); caps["uploads"] != false {
		t.Errorf("caps.uploads = %v with a file as the dir", caps["uploads"])
	}
}

func TestNewUploadStoreRefuses(t *testing.T) {
	base := t.TempDir()
	file := filepath.Join(base, "file")
	os.WriteFile(file, nil, 0o600)
	real := filepath.Join(base, "real")
	os.Mkdir(real, 0o700)
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink: %v", err)
	}
	for name, dir := range map[string]string{
		"empty":       "",
		"a file":      file,
		"under file":  filepath.Join(file, "uploads"),
		"symlink dir": link,
	} {
		if s, err := newUploadStore(dir); err == nil || s != nil {
			t.Errorf("%s: newUploadStore(%q) succeeded", name, dir)
		}
	}
}

// A dir another user owns is refused (the root dir, unless running as root).
func TestNewUploadStoreRefusesForeignOwner(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a dir owned by another user")
	}
	if s, err := newUploadStore("/"); err == nil || s != nil {
		t.Error("newUploadStore(/) succeeded")
	}
}

// An existing dir with loose permissions is tightened to 0700.
func TestNewUploadStoreTightensDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no mode bits")
	}
	dir := filepath.Join(t.TempDir(), "uploads")
	os.Mkdir(dir, 0o755)
	os.Chmod(dir, 0o755)
	if _, err := newUploadStore(dir); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
		t.Errorf("dir mode = %v, want 0700", fi.Mode().Perm())
	}
}

// failingReader returns its bytes, then an error.
type failingReader struct{ r io.Reader }

func (f failingReader) Read(p []byte) (int, error) {
	n, err := f.r.Read(p)
	if err == io.EOF {
		return n, errors.New("connection reset")
	}
	return n, err
}

func TestUploadFailedCopyLeavesNoPart(t *testing.T) {
	s := newTestUploadStore(t)
	body := append(testImage(t, "image/png"), make([]byte, 4096)...)
	if _, err := s.save(failingReader{bytes.NewReader(body)}, "image/png"); err == nil {
		t.Fatal("save succeeded on a failing body")
	}
	if entries, _ := os.ReadDir(s.dir); len(entries) != 0 {
		t.Errorf("dir holds %v after a failed copy", entries)
	}
	if s.reserved != 0 {
		t.Errorf("reserved = %d after the upload ended", s.reserved)
	}
	// A body failing in its first bytes is refused before any file exists.
	if _, err := s.save(failingReader{bytes.NewReader([]byte{0x89})}, "image/png"); err == nil {
		t.Error("save succeeded on a body failing in its head")
	}
}

// A store whose dir disappeared answers a generic 500.
func TestUploadWriteFailure(t *testing.T) {
	s := newTestUploadStore(t)
	os.RemoveAll(s.dir)
	rec := serve(handleUpload(s), uploadRequest(testImage(t, "image/png"), "image/png"))
	if rec.Code != http.StatusInternalServerError || decodeBody(t, rec)["code"] != "upload_failed" {
		t.Errorf("write failure = %d %s", rec.Code, rec.Body.String())
	}
}

func TestUploadBusy(t *testing.T) {
	s := newTestUploadStore(t)
	for range uploadConcurrency {
		s.sem <- struct{}{}
	}
	rec := serve(handleUpload(s), uploadRequest(testImage(t, "image/png"), "image/png"))
	if rec.Code != http.StatusTooManyRequests || decodeBody(t, rec)["code"] != "busy" {
		t.Errorf("upload past the limit = %d %s", rec.Code, rec.Body.String())
	}
	<-s.sem
	rec = serve(handleUpload(s), uploadRequest(testImage(t, "image/png"), "image/png"))
	if rec.Code != http.StatusOK {
		t.Errorf("upload once a slot is free = %d %s", rec.Code, rec.Body.String())
	}
}

func TestUploadLookup(t *testing.T) {
	s := newTestUploadStore(t)
	u, err := s.save(bytes.NewReader(testImage(t, "image/gif")), "image/gif")
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := s.lookup(u.ID); !ok || p != u.Path {
		t.Errorf("lookup(%s) = %q, %v", u.ID, p, ok)
	}
	part := strings.Repeat("a", 32)
	os.WriteFile(filepath.Join(s.dir, part+".png.part"), []byte("x"), 0o600)
	link := strings.Repeat("b", 32)
	os.Symlink(u.Path, filepath.Join(s.dir, link+".png"))
	for _, id := range []string{"", "../x", strings.ToUpper(u.ID), u.ID + ".gif", strings.Repeat("c", 32), part, link} {
		if p, ok := s.lookup(id); ok {
			t.Errorf("lookup(%q) = %q, want not found", id, p)
		}
	}
	if runtime.GOOS != "windows" {
		os.Chmod(u.Path, 0o644)
		if _, ok := s.lookup(u.ID); ok {
			t.Error("lookup found a file readable by others")
		}
	}
}

// writeAged writes a file of size bytes whose mtime is age ago.
func writeAged(t *testing.T, s *uploadStore, name string, size int, age time.Duration) string {
	t.Helper()
	p := filepath.Join(s.dir, name)
	if err := os.WriteFile(p, make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
	mod := s.now().Add(-age)
	os.Chtimes(p, mod, mod)
	return p
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func TestUploadSweep(t *testing.T) {
	s := newTestUploadStore(t)
	now := time.Now()
	s.now = func() time.Time { return now }
	s.maxTotal = 300
	h := func(c string) string { return strings.Repeat(c, 32) }
	expired := writeAged(t, s, h("1")+".png", 10, 8*24*time.Hour)
	oldest := writeAged(t, s, h("2")+".jpg", 100, 3*time.Hour)
	older := writeAged(t, s, h("3")+".gif", 100, 2*time.Hour)
	recent := writeAged(t, s, h("4")+".webp", 100, 30*time.Minute)
	stalePart := writeAged(t, s, h("5")+".png.part", 10, 2*time.Hour)
	livePart := writeAged(t, s, h("6")+".png.part", 10, time.Minute)
	foreign := writeAged(t, s, "notes.txt", 10, 30*24*time.Hour)
	foreignPNG := writeAged(t, s, "photo.png", 10, 30*24*time.Hour)
	// A symlink named like an upload is not the store's: never followed or removed.
	link := filepath.Join(s.dir, h("7")+".png")
	os.Symlink(foreign, link)

	s.mu.Lock()
	used := s.sweepLocked(150)
	s.mu.Unlock()

	// 300 used + 150 needed: the two oldest go; the 30-minute file stays.
	if used != 100 {
		t.Errorf("used = %d, want 100", used)
	}
	for _, p := range []string{expired, oldest, older, stalePart} {
		if exists(p) {
			t.Errorf("%s survived the sweep", filepath.Base(p))
		}
	}
	for _, p := range []string{recent, livePart, foreign, foreignPNG, link} {
		if !exists(p) {
			t.Errorf("%s was deleted", filepath.Base(p))
		}
	}
}

// When only files under an hour old fill the quota, the upload is refused
// instead of evicting them.
func TestUploadStorageFull(t *testing.T) {
	s := newTestUploadStore(t)
	s.maxFile = 100
	s.maxTotal = 150
	writeAged(t, s, strings.Repeat("a", 32)+".png", 100, time.Minute)
	rec := serve(handleUpload(s), uploadRequest(testImage(t, "image/png"), "image/png"))
	if rec.Code != http.StatusInsufficientStorage || decodeBody(t, rec)["code"] != "storage_full" {
		t.Errorf("full store = %d %s", rec.Code, rec.Body.String())
	}
	// A running upload's reservation counts too.
	s.maxTotal = 250
	if err := s.reserve(); err != nil {
		t.Fatal(err)
	}
	if err := s.reserve(); !errors.Is(err, errUploadStorageFull) {
		t.Errorf("second reservation = %v, want storage full", err)
	}
	s.release()
	if s.reserved != 0 {
		t.Errorf("reserved = %d", s.reserved)
	}
}

// Files the sweep cannot delete are logged and still counted.
func TestUploadSweepRemoveFails(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a dir the server user cannot write")
	}
	s := newTestUploadStore(t)
	s.maxTotal = 10
	old := writeAged(t, s, strings.Repeat("a", 32)+".png", 100, 2*time.Hour)
	writeAged(t, s, strings.Repeat("b", 32)+".png", 1, 8*24*time.Hour)
	os.Chmod(s.dir, 0o500)
	t.Cleanup(func() { os.Chmod(s.dir, 0o700) })
	s.mu.Lock()
	used := s.sweepLocked(0)
	s.mu.Unlock()
	if used != 100 || !exists(old) {
		t.Errorf("used = %d, old file kept = %v", used, exists(old))
	}
}

func TestUploadSweepUnreadableDir(t *testing.T) {
	s := newTestUploadStore(t)
	os.RemoveAll(s.dir)
	s.mu.Lock()
	defer s.mu.Unlock()
	if used := s.sweepLocked(0); used != 0 {
		t.Errorf("used = %d", used)
	}
}

func TestPasteablePath(t *testing.T) {
	for in, want := range map[string]string{
		"/home/u/.cache/termote/uploads/a.png":          "/home/u/.cache/termote/uploads/a.png",
		`C:\Users\Jane Doe\AppData\Local\termote\a.png`: `"C:\Users\Jane Doe\AppData\Local\termote\a.png"`,
		"/tmp/tab\there.png":                            "\"/tmp/tab\there.png\"",
	} {
		if got := pasteablePath(in); got != want {
			t.Errorf("pasteablePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUploadDirFromCache(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("XDG_CACHE_HOME is read on Linux")
	}
	t.Setenv("XDG_CACHE_HOME", "/srv/cache")
	if got := uploadDir(); got != "/srv/cache/termote/uploads" {
		t.Errorf("uploadDir() = %q", got)
	}
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("HOME", "")
	if got := uploadDir(); got != "" {
		t.Errorf("uploadDir() without a cache dir = %q, want empty", got)
	}
}

// A client without the password keeps the 60s deadline (here 300ms) on the
// upload route: only an authenticated upload with a slot reads for minutes.
func TestUploadReadDeadline(t *testing.T) {
	oldReq, oldUp := requestReadTimeout, uploadReadTimeout
	requestReadTimeout, uploadReadTimeout = 300*time.Millisecond, 10*time.Second
	t.Cleanup(func() { requestReadTimeout, uploadReadTimeout = oldReq, oldUp })
	h, _ := uploadHandler(t)
	srv := httptest.NewServer(h)
	defer srv.Close()
	img := testImage(t, "image/png")
	send := func(auth bool, pause time.Duration) string {
		conn, err := net.Dial("tcp", srv.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		hdr := ""
		if auth {
			hdr = "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("admin:secret")) + "\r\n"
		}
		fmt.Fprintf(conn, "POST /api/mux/uploads HTTP/1.1\r\nHost: %s\r\nContent-Type: image/png\r\n%sContent-Length: %d\r\nConnection: close\r\n\r\n", srv.Listener.Addr(), hdr, len(img))
		conn.Write(img[:20])
		time.Sleep(pause)
		conn.Write(img[20:])
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		out, err := io.ReadAll(conn)
		if err != nil {
			t.Fatalf("connection still open: %v (read %q)", err, out)
		}
		return string(out)
	}
	if out := send(true, 600*time.Millisecond); !strings.HasPrefix(out, "HTTP/1.1 200") {
		t.Errorf("authenticated slow upload = %q", out)
	}
	// Without credentials: the body never completes, the 60s deadline cuts it.
	start := time.Now()
	if out := send(false, 2*time.Second); !strings.Contains(out, "401") {
		t.Errorf("unauthenticated upload = %q", out)
	}
	if d := time.Since(start); d > 4*time.Second {
		t.Errorf("unauthenticated upload held %v", d)
	}
}

// A body of unknown length (chunked) is cut at the cap while it is read.
func TestUploadChunkedTooLarge(t *testing.T) {
	s := newTestUploadStore(t)
	body := append(testImage(t, "image/png"), make([]byte, uploadMaxFile)...)
	req := uploadRequest(body, "image/png")
	req.ContentLength = -1
	rec := serve(handleUpload(s), req)
	if rec.Code != http.StatusRequestEntityTooLarge || decodeBody(t, rec)["code"] != "too_large" {
		t.Errorf("chunked too large = %d %s", rec.Code, rec.Body.String())
	}
	if entries, _ := os.ReadDir(s.dir); len(entries) != 0 {
		t.Errorf("dir holds %v after a refused upload", entries)
	}
}

// A body announced larger than the cap is refused before it is read.
func TestUploadDeclaredTooLarge(t *testing.T) {
	s := newTestUploadStore(t)
	req := uploadRequest(testImage(t, "image/png"), "image/png")
	req.ContentLength = uploadMaxFile + 1
	rec := serve(handleUpload(s), req)
	if rec.Code != http.StatusRequestEntityTooLarge || decodeBody(t, rec)["code"] != "too_large" {
		t.Errorf("declared too large = %d %s", rec.Code, rec.Body.String())
	}
}
