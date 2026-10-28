package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// uploadFixture is a root behind the files routes alone (no writeGuard, no
// auth): a.pdf, sub/, cfg/ (a deny dir), .ssh/ (sensitive) and a file named
// file.
type uploadFixture struct {
	root string
	f    *filesAPI
	mux  *http.ServeMux
}

func newUploadFixture(t *testing.T) *uploadFixture {
	t.Helper()
	root := filepath.Join(plainDir(t), "root")
	writeFile(t, filepath.Join(root, "a.pdf"), "mine")
	writeFile(t, filepath.Join(root, "file"), "x")
	writeFile(t, filepath.Join(root, ".git", "config"), "[core]\n")
	mkdir(t, filepath.Join(root, "sub"))
	mkdir(t, filepath.Join(root, "cfg"))
	mkdir(t, filepath.Join(root, ".ssh"))
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: root, files: true}, parseAllowedHosts("", false), []string{filepath.Join(root, "cfg")})
	return &uploadFixture{root: root, f: f, mux: mux}
}

// uploadQuery is the query of an upload of name into dir.
func uploadQuery(dir, name string, kv ...string) url.Values {
	q := url.Values{"dir": {dir}, "name": {name}}
	for i := 0; i+1 < len(kv); i += 2 {
		q.Set(kv[i], kv[i+1])
	}
	return q
}

// fileUploadRequest is a POST of body to files/upload under root (left out
// when ""), as the PWA sends it.
func fileUploadRequest(root string, q url.Values, body io.Reader) *http.Request {
	if root != "" {
		q.Set("root", root)
	}
	req := apiRequest("POST", "/api/mux/panes/0/files/upload?"+q.Encode(), "")
	req.Body = io.NopCloser(body)
	req.ContentLength = -1
	if b, ok := body.(*bytes.Reader); ok {
		req.ContentLength = int64(b.Len())
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	if q.Get("check") == "1" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func (fx *uploadFixture) upload(t *testing.T, q url.Values, body []byte) (int, map[string]any) {
	t.Helper()
	rec := serve(fx.mux, fileUploadRequest(fx.root, q, bytes.NewReader(body)))
	return rec.Code, decodeBody(t, rec)
}

// noTemps fails when an upload's temporary file is left in dir.
func noTemps(t *testing.T, dir string) {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), uploadTempPrefix) {
			t.Errorf("temporary file left: %s", e.Name())
		}
	}
}

func TestFilesUploadWritesBytes(t *testing.T) {
	fx := newUploadFixture(t)
	logs := captureLog(t)
	var data []byte
	for b := 0; b < 256; b++ {
		data = append(data, byte(b))
	}
	data = append(data, 0, 0xff, 0xfe) // NUL, invalid UTF-8
	for dir, want := range map[string]string{".": "doc.pdf", "sub": "sub/doc.pdf"} {
		code, body := fx.upload(t, uploadQuery(dir, "doc.pdf"), data)
		if code != http.StatusCreated || body["root"] != fx.root || body["path"] != want || len(body) != 2 {
			t.Fatalf("%s = %d %v", dir, code, body)
		}
		if got, _ := os.ReadFile(filepath.Join(fx.root, want)); !bytes.Equal(got, data) {
			t.Errorf("%s: file holds %d bytes, want %d", dir, len(got), len(data))
		}
		noTemps(t, filepath.Join(fx.root, dir))
	}
	// Empty is a file too, of any type
	if code, body := fx.upload(t, uploadQuery(".", "empty"), nil); code != http.StatusCreated || body["path"] != "empty" {
		t.Errorf("empty = %d %v", code, body)
	}
	if !strings.Contains(logs.String(), `audit: upload path="sub/doc.pdf" size="259" by="none" via="none"`) {
		t.Errorf("audit line missing:\n%s", logs)
	}
	// Signed in: who sent it
	req := fileUploadRequest(fx.root, uploadQuery(".", "by.txt"), bytes.NewReader([]byte("x")))
	req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, Role: roleFull, DeviceID: "d2"}))
	if rec := serve(fx.mux, req); rec.Code != http.StatusCreated {
		t.Fatalf("device = %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(logs.String(), `audit: upload path="by.txt" size="1" by="device:d2" via="device"`) {
		t.Errorf("device audit line missing:\n%s", logs)
	}
}

func TestFilesUploadCheck(t *testing.T) {
	fx := newUploadFixture(t)
	// The name the upload would get, nothing made, no slot taken
	for name, want := range map[string]string{"new.pdf": "new.pdf", "a.pdf": "a (2).pdf"} {
		rec := serve(fx.mux, fileUploadRequest(fx.root, uploadQuery(".", name, "check", "1"), strings.NewReader("{}")))
		body := decodeBody(t, rec)
		if rec.Code != http.StatusOK || body["path"] != want || body["root"] != fx.root || rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("check %s = %d %v", name, rec.Code, body)
		}
	}
	if len(fx.f.uploadSlots) != 0 {
		t.Error("the check took the slot")
	}
	notExist(t, filepath.Join(fx.root, "new.pdf"))
	notExist(t, filepath.Join(fx.root, "a (2).pdf"))
	// Another upload holds the slot: busy, so the client waits before
	// sending a body the server would refuse unread
	fx.f.uploadSlots <- struct{}{}
	rec := serve(fx.mux, fileUploadRequest(fx.root, uploadQuery(".", "new.pdf", "check", "1"), strings.NewReader("{}")))
	if code, key := rawCode(t, rec); code != 429 || key != "upload_busy" {
		t.Errorf("check while busy = %d %q", code, key)
	}
	// A file refused anyway is told so at once
	rec = serve(fx.mux, fileUploadRequest(fx.root, uploadQuery("cfg", "new.pdf", "check", "1"), strings.NewReader("{}")))
	if code, key := rawCode(t, rec); code != 403 || key != "not_allowed" {
		t.Errorf("refused check while busy = %d %q", code, key)
	}
	<-fx.f.uploadSlots
	if readText(t, filepath.Join(fx.root, "a.pdf")) != "mine" {
		t.Error("the check touched a.pdf")
	}
	// The refusals the upload would give
	for q, want := range map[*url.Values]string{
		ptr(uploadQuery(".ssh", "k.txt", "check", "1")): "sensitive",
		ptr(uploadQuery("cfg", "k.txt", "check", "1")):  "not_allowed",
		ptr(uploadQuery("nope", "k.txt", "check", "1")): "not_found",
		ptr(uploadQuery("file", "k.txt", "check", "1")): "not_directory",
	} {
		rec := serve(fx.mux, fileUploadRequest(fx.root, *q, strings.NewReader("{}")))
		if _, code := rawCode(t, rec); code != want {
			t.Errorf("check %v = %d %q, want %q", *q, rec.Code, code, want)
		}
	}
	// A sensitive one shown on purpose
	rec = serve(fx.mux, fileUploadRequest(fx.root, uploadQuery(".ssh", "k.txt", "check", "1", "reveal", "1"), strings.NewReader("{}")))
	if rec.Code != http.StatusOK || decodeBody(t, rec)["path"] != ".ssh/k.txt" {
		t.Errorf("revealed check = %d %s", rec.Code, rec.Body.String())
	}
}

func ptr[T any](v T) *T { return &v }

func TestFilesUploadRenames(t *testing.T) {
	fx := newUploadFixture(t)
	writeFile(t, filepath.Join(fx.root, ".env"), "TOKEN=x\n")
	writeFile(t, filepath.Join(fx.root, ".config.json"), "{}")
	writeFile(t, filepath.Join(fx.root, "a.tar.gz"), "gz")
	for name, want := range map[string]string{
		"a.pdf":        "a (2).pdf",
		".config.json": ".config (2).json",
		"a.tar.gz":     "a.tar (2).gz",
	} {
		if code, body := fx.upload(t, uploadQuery(".", name), []byte("new")); code != http.StatusCreated || body["path"] != want {
			t.Errorf("%s = %d %v", name, code, body)
		}
	}
	if readText(t, filepath.Join(fx.root, "a.pdf")) != "mine" {
		t.Error("a.pdf was replaced")
	}
	// Again: the next number
	if code, body := fx.upload(t, uploadQuery(".", "a.pdf"), []byte("3")); code != http.StatusCreated || body["path"] != "a (3).pdf" {
		t.Errorf("third = %d %v", code, body)
	}
	// A sensitive name needs reveal, then gets a number of its own
	if code, body := fx.upload(t, uploadQuery(".", ".env"), []byte("T=2")); code != http.StatusForbidden || body["code"] != "sensitive" {
		t.Errorf(".env = %d %v", code, body)
	}
	if code, body := fx.upload(t, uploadQuery(".", ".env", "reveal", "1"), []byte("T=2")); code != http.StatusCreated || body["path"] != ".env (2)" {
		t.Errorf(".env revealed = %d %v", code, body)
	}
	// A long name taken: the number still fits in 255 bytes
	long := strings.Repeat("a", 249) + ".pdf"
	writeFile(t, filepath.Join(fx.root, long), "x")
	code, body := fx.upload(t, uploadQuery(".", long), []byte("y"))
	want := strings.Repeat("a", 247) + " (2).pdf"
	if code != http.StatusCreated || body["path"] != want || len(want) != createMaxName {
		t.Errorf("long = %d %v", code, body)
	}
	// Every number taken
	writeFile(t, filepath.Join(fx.root, "b.txt"), "")
	for i := 2; i <= uploadMaxSuffix; i++ {
		writeFile(t, filepath.Join(fx.root, "b ("+strconv.Itoa(i)+").txt"), "")
	}
	if code, body := fx.upload(t, uploadQuery(".", "b.txt"), []byte("z")); code != http.StatusConflict || body["code"] != "exists" {
		t.Errorf("all taken = %d %v", code, body)
	}
	// An extension that leaves no room for a number: none fits
	wide := "a." + strings.Repeat("x", 253)
	writeFile(t, filepath.Join(fx.root, wide), "")
	if code, body := fx.upload(t, uploadQuery(".", wide), []byte("z")); code != http.StatusConflict || body["code"] != "exists" {
		t.Errorf("wide = %d %v", code, body)
	}
	noTemps(t, fx.root)
}

func TestUploadCandidate(t *testing.T) {
	for _, tc := range []struct {
		name string
		n    int
		want string
	}{
		{"a.pdf", 1, "a.pdf"},
		{"a.pdf", 2, "a (2).pdf"},
		{"a", 12, "a (12)"},
		{".env", 2, ".env (2)"},
		{".config.json", 3, ".config (3).json"},
		{"a.tar.gz", 2, "a.tar (2).gz"},
		// Cut on a rune: "é" is two bytes and never split
		{strings.Repeat("é", 125) + ".pdf", 2, strings.Repeat("é", 123) + " (2).pdf"},
		{"a." + strings.Repeat("x", 253), 2, " (2)." + strings.Repeat("x", 253)},
	} {
		if got := uploadCandidate(tc.name, tc.n); got != tc.want {
			t.Errorf("%q %d = %q, want %q", tc.name, tc.n, got, tc.want)
		}
	}
}

func TestValidUploadName(t *testing.T) {
	for _, name := range []string{
		"a.pdf", ".env", "tên file.pdf", "COM", "COM0", "LPT0.txt", "COM10", "COMX.txt", "console.txt", "nullable.go",
		"-x", "a b", strings.Repeat("a", createMaxName),
	} {
		if !validUploadName(name) {
			t.Errorf("%q refused", name)
		}
	}
	for _, name := range []string{
		"", ".", "..", "a/b", `a\b.pdf`, `\x`, "a.", "a ", "a\x00b", "a\nb",
		"NUL", "nul.txt", "CON.txt", "con .txt", "COM1", "lpt9.log", "COM¹", "LPT³.x", "CONIN$", "conout$.txt", "PRN", "AUX.c",
		"x‮fdp.exe", "​.pdf", "a⁦b", "\xff.pdf", "�.pdf",
		uploadTempPrefix + "0123456789abcdef", editTempPrefix + "0123456789abcdef", renameTempPrefix + "0123456789abcdef",
		strings.Repeat("a", createMaxName+1),
	} {
		if validUploadName(name) {
			t.Errorf("%q accepted", name)
		}
	}
}

func TestFilesUploadRejects(t *testing.T) {
	fx := newUploadFixture(t)
	view := &authInfo{Kind: authDevice, Role: roleView, DeviceID: "v"}
	cases := map[string]struct {
		q     url.Values
		root  string
		auth  *authInfo
		code  int
		key   string
		where string
	}{
		"no root":             {uploadQuery(".", "n.txt"), "-", nil, 400, "", "n.txt"},
		"root moved":          {uploadQuery(".", "n.txt"), "/elsewhere", nil, 409, "", "n.txt"},
		"no dir":              {url.Values{"name": {"n.txt"}}, "", nil, 400, "invalid_name", "n.txt"},
		"dir up":              {uploadQuery("..", "n.txt"), "", nil, 400, "invalid_name", "../n.txt"},
		"dir backslash":       {uploadQuery(`sub\x`, "n.txt"), "", nil, 400, "invalid_name", "sub/n.txt"},
		"no name":             {url.Values{"dir": {"."}}, "", nil, 400, "invalid_name", ""},
		"name with a slash":   {uploadQuery(".", "sub/n.txt"), "", nil, 400, "invalid_name", "sub/n.txt"},
		"device name":         {uploadQuery(".", "NUL"), "", nil, 400, "invalid_name", ""}, // Windows answers any path named NUL
		"temp name":           {uploadQuery(".", uploadTempPrefix+"0123456789abcdef"), "", nil, 400, "invalid_name", uploadTempPrefix + "0123456789abcdef"},
		"view-only":           {uploadQuery(".", "n.txt"), "", view, 403, "view_only", "n.txt"},
		"git dir":             {uploadQuery(".git", "n.txt"), "", nil, 403, "not_allowed", ".git/n.txt"},
		"deny dir":            {uploadQuery("cfg", "n.txt"), "", nil, 403, "not_allowed", "cfg/n.txt"},
		"named as a deny dir": {uploadQuery(".", "cfg"), "", nil, 403, "not_allowed", ""},
		"sensitive dir":       {uploadQuery(".ssh", "n.txt"), "", nil, 403, "sensitive", ".ssh/n.txt"},
		"sensitive name":      {uploadQuery(".", "id_rsa"), "", nil, 403, "sensitive", "id_rsa"},
		"missing dir":         {uploadQuery("nope", "n.txt"), "", nil, 404, "not_found", "nope"},
		"dir is a file":       {uploadQuery("file", "n.txt"), "", nil, 409, "not_directory", ""},
		"unknown place":       {uploadQuery(".", "n.txt", "place", "0123456789abcdef"), "", nil, 404, "unknown_place", "n.txt"},
	}
	for name, tc := range cases {
		root := fx.root
		switch tc.root {
		case "-":
			root = ""
		case "":
		default:
			root = tc.root
		}
		req := fileUploadRequest(root, tc.q, bytes.NewReader([]byte("data")))
		if tc.auth != nil {
			req = req.WithContext(withAuth(req.Context(), *tc.auth))
		}
		rec := serve(fx.mux, req)
		code, key := rawCode(t, rec)
		if code != tc.code || (tc.key != "" && key != tc.key) {
			t.Errorf("%s = %d %q, want %d %q (%s)", name, code, key, tc.code, tc.key, rec.Body.String())
		}
		if tc.where != "" && tc.where != "nope" {
			notExist(t, filepath.Join(fx.root, filepath.FromSlash(tc.where)))
		}
	}
	notExist(t, filepath.Join(fx.root, "nope"))
	noTemps(t, fx.root)
	// Another method, and another site
	req := fileUploadRequest(fx.root, uploadQuery(".", "n.txt"), bytes.NewReader(nil))
	req.Method = http.MethodGet
	if rec := serve(fx.mux, req); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", rec.Code)
	}
	req = fileUploadRequest(fx.root, uploadQuery(".", "n.txt"), bytes.NewReader(nil))
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(fx.mux, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
	notExist(t, filepath.Join(fx.root, "n.txt"))
}

func TestFilesUploadTooLarge(t *testing.T) {
	fx := newUploadFixture(t)
	// Said too large: refused unread
	body := &failAfter{r: strings.NewReader("x"), err: io.EOF}
	req := fileUploadRequest(fx.root, uploadQuery(".", "big.bin"), body)
	req.ContentLength = maxUploadFileSize + 1
	if code, key := rawCode(t, serve(fx.mux, req)); code != 413 || key != "too_large" || body.read {
		t.Errorf("Content-Length = %d %q, read %v", code, key, body.read)
	}
	// Not said, found too large as it is written: nothing left
	old := maxUploadFileSize
	maxUploadFileSize = 1 << 10
	t.Cleanup(func() { maxUploadFileSize = old })
	req = fileUploadRequest(fx.root, uploadQuery(".", "big.bin"), io.MultiReader(bytes.NewReader(make([]byte, 1<<10+1))))
	rec := serve(fx.mux, req)
	text := rec.Body.String()
	if code, key := rawCode(t, rec); code != 413 || key != "too_large" || !strings.Contains(text, "100 MiB") {
		t.Errorf("long body = %d %q %s", code, key, text)
	}
	notExist(t, filepath.Join(fx.root, "big.bin"))
	noTemps(t, fx.root)
	// At the cap exactly: taken
	req = fileUploadRequest(fx.root, uploadQuery(".", "big.bin"), io.MultiReader(bytes.NewReader(make([]byte, 1<<10))))
	if rec := serve(fx.mux, req); rec.Code != http.StatusCreated {
		t.Errorf("at the cap = %d %s", rec.Code, rec.Body.String())
	}
}

// A body cut short: no file under the name, no temporary file, and the
// error's text never reaches the client
func TestFilesUploadBodyFails(t *testing.T) {
	fx := newUploadFixture(t)
	body := &failAfter{r: bytes.NewReader(make([]byte, 4096)), err: errors.New("connection reset")}
	rec := serve(fx.mux, fileUploadRequest(fx.root, uploadQuery(".", "cut.bin"), body))
	if rec.Code < 500 || strings.Contains(rec.Body.String(), "connection reset") {
		t.Errorf("cut = %d %s", rec.Code, rec.Body.String())
	}
	notExist(t, filepath.Join(fx.root, "cut.bin"))
	noTemps(t, fx.root)
	if len(fx.f.uploadSlots) != 0 {
		t.Error("the slot was kept")
	}
}

func TestFilesUploadBusy(t *testing.T) {
	fx := newUploadFixture(t)
	fx.f.uploadSlots <- struct{}{}
	body := &failAfter{r: strings.NewReader("x"), err: io.EOF}
	rec := serve(fx.mux, fileUploadRequest(fx.root, uploadQuery(".", "n.txt"), body))
	text := rec.Body.String()
	if code, key := rawCode(t, rec); code != 429 || key != "upload_busy" || body.read || !strings.Contains(text, "another upload") {
		t.Errorf("busy = %d %q %s, read %v", code, key, text, body.read)
	}
	<-fx.f.uploadSlots
	if code, body := fx.upload(t, uploadQuery(".", "n.txt"), []byte("x")); code != http.StatusCreated {
		t.Errorf("free = %d %v", code, body)
	}
}

// An upload holds its own slot: a save, a create and an image paste all go
// through while one streams
func TestFilesUploadLeavesSaveSlots(t *testing.T) {
	fx := newUploadFixture(t)
	pr, pw := io.Pipe()
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- serve(fx.mux, fileUploadRequest(fx.root, uploadQuery(".", "slow.bin"), pr)) }()
	pw.Write([]byte("first"))
	for end := time.Now().Add(5 * time.Second); len(fx.f.uploadSlots) == 0; time.Sleep(time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("the upload never took its slot")
		}
	}
	if len(fx.f.writeSlots) != 0 {
		t.Errorf("the upload holds %d write slots", len(fx.f.writeSlots))
	}
	for i := 0; i < writeMaxRunning; i++ {
		req := apiRequest("POST", "/api/mux/panes/0/files/create?root="+url.QueryEscape(fx.root), fmt.Sprintf(`{"path":"made%d.txt"}`, i))
		req.Header.Del("Origin")
		if rec := serve(fx.mux, req); rec.Code != http.StatusCreated {
			t.Errorf("create %d during an upload = %d %s", i, rec.Code, rec.Body.String())
		}
	}
	pw.Write([]byte(" second"))
	pw.Close()
	rec := <-done
	if rec.Code != http.StatusCreated || readText(t, filepath.Join(fx.root, "slow.bin")) != "first second" {
		t.Errorf("upload = %d %s", rec.Code, rec.Body.String())
	}
}

// Only the temporary file is ever removed: a file made under the name
// while the body came stays, and the upload takes the next name
func TestFilesUploadNameTakenMeanwhile(t *testing.T) {
	fx := newUploadFixture(t)
	uploadBeforeFinish = func() { writeFile(t, filepath.Join(fx.root, "race.txt"), "theirs") }
	t.Cleanup(func() { uploadBeforeFinish = func() {} })
	code, body := fx.upload(t, uploadQuery(".", "race.txt"), []byte("ours"))
	if code != http.StatusCreated || body["path"] != "race (2).txt" {
		t.Fatalf("raced = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "race.txt")) != "theirs" || readText(t, filepath.Join(fx.root, "race (2).txt")) != "ours" {
		t.Error("the files were mixed up")
	}
	noTemps(t, fx.root)
}

// Without hard links (FAT, exFAT): the name is looked at, then the file
// renamed to it, never over another
func TestFilesUploadWithoutLinks(t *testing.T) {
	fx := newUploadFixture(t)
	old := uploadLink
	uploadLink = func(*os.Root, string, string) error { return &os.LinkError{Op: "link", Err: errors.ErrUnsupported} }
	t.Cleanup(func() { uploadLink = old })
	if code, body := fx.upload(t, uploadQuery(".", "a.pdf"), []byte("new")); code != http.StatusCreated || body["path"] != "a (2).pdf" {
		t.Fatalf("fallback = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, "a.pdf")) != "mine" || readText(t, filepath.Join(fx.root, "a (2).pdf")) != "new" {
		t.Error("the files were mixed up")
	}
	noTemps(t, fx.root)
	// Any other failure of the link: refused, only the temp removed
	uploadLink = func(*os.Root, string, string) error { return errors.New("disk on fire") }
	rec := serve(fx.mux, fileUploadRequest(fx.root, uploadQuery(".", "c.pdf"), bytes.NewReader([]byte("c"))))
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "fire") {
		t.Errorf("link failed = %d %s", rec.Code, rec.Body.String())
	}
	notExist(t, filepath.Join(fx.root, "c.pdf"))
	noTemps(t, fx.root)
}

func TestFilesUploadSweepsStaleTemps(t *testing.T) {
	fx := newUploadFixture(t)
	stale := filepath.Join(fx.root, uploadTempPrefix+"0123456789abcdef")
	fresh := filepath.Join(fx.root, uploadTempPrefix+"fedcba9876543210")
	mine := filepath.Join(fx.root, uploadTempPrefix+"notes")
	for _, p := range []string{stale, fresh, mine} {
		writeFile(t, p, "partial")
	}
	long := time.Now().Add(-uploadTempMaxAge - time.Minute)
	for _, p := range []string{stale, mine} {
		if err := os.Chtimes(p, long, long); err != nil {
			t.Fatal(err)
		}
	}
	if code, body := fx.upload(t, uploadQuery(".", "n.txt"), []byte("x")); code != http.StatusCreated {
		t.Fatalf("upload = %d %v", code, body)
	}
	notExist(t, stale)
	for _, p := range []string{fresh, mine} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s removed", filepath.Base(p))
		}
	}
	// A temporary file is sensitive, as a save's
	if !isSensitive(fresh) {
		t.Error("an upload's temporary file is not sensitive")
	}
}

// writeGuard takes a raw octet-stream body on files/upload alone, and its
// check=1 as JSON
func TestWriteGuardFilesUpload(t *testing.T) {
	fx := newFilesFixture(t)
	post := func(q url.Values, ct, origin string) *httptest.ResponseRecorder {
		req := fileUploadRequest(fx.root, q, bytes.NewReader([]byte("{}")))
		req.Header.Set("Content-Type", ct)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		return serve(fx.h, req)
	}
	if rec := post(uploadQuery(".", "ok.bin"), "application/octet-stream", ""); rec.Code != http.StatusCreated {
		t.Errorf("octet-stream = %d %s", rec.Code, rec.Body.String())
	}
	for _, ct := range []string{"text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded", "image/png", "application/json", "", "bad/;;"} {
		rec := post(uploadQuery(".", "no.bin"), ct, "")
		if code, key := rawCode(t, rec); code != http.StatusUnsupportedMediaType || key != "unsupported_type" {
			t.Errorf("%q = %d %q", ct, code, key)
		}
	}
	notExist(t, filepath.Join(fx.root, "no.bin"))
	// check=1 is JSON, like any other write
	if rec := post(uploadQuery(".", "c.bin", "check", "1"), "application/json", ""); rec.Code != http.StatusOK {
		t.Errorf("check = %d %s", rec.Code, rec.Body.String())
	}
	if rec := post(uploadQuery(".", "c.bin", "check", "1"), "application/octet-stream", ""); rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("check as octet-stream = %d", rec.Code)
	}
	if rec := post(uploadQuery(".", "x.bin"), "application/octet-stream", "http://evil.example"); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
	notExist(t, filepath.Join(fx.root, "x.bin"))
	// Only this exact path takes the body
	req := fileUploadRequest(fx.root, uploadQuery(".", "y.bin"), bytes.NewReader(nil))
	req.URL.Path += "/"
	if rec := serve(fx.h, req); rec.Code != http.StatusUnsupportedMediaType || strings.Contains(rec.Body.String(), "unsupported_type") {
		t.Errorf("upload/ = %d %s", rec.Code, rec.Body.String())
	}
	// Without a password: refused before anything
	req = fileUploadRequest(fx.root, uploadQuery(".", "z.bin"), bytes.NewReader(nil))
	req.Header.Del("Authorization")
	if rec := serve(fx.h, req); rec.Code != http.StatusUnauthorized {
		t.Errorf("no auth = %d", rec.Code)
	}
}

func TestIsFilesUploadPath(t *testing.T) {
	for p, want := range map[string]bool{
		"/api/mux/panes/%1/files/upload":     true,
		"/api/mux/panes/0/files/upload":      true,
		"/api/mux/panes/0/files/upload/":     false,
		"/api/mux/panes/0/files/uploads":     false,
		"/api/mux/panes/a/b/files/upload":    false,
		"/x/api/mux/panes/0/files/upload":    false,
		"/api/mux/panes//files/upload":       false,
		"/api/mux/panes/0/files/image":       false,
		"/api/mux/uploads":                   false,
		"/api/mux/panes/0/files/upload\n":    false,
		"/api/mux/panes/0/files/upload/more": false,
	} {
		if got := isFilesUploadPath(p); got != want {
			t.Errorf("%q = %v, want %v", p, got, want)
		}
	}
}

// A client that stops sending is dropped after uploadIdleTimeout over a
// real connection: 408, the slot free again, nothing left
func TestFilesUploadIdleTimeout(t *testing.T) {
	fx := newUploadFixture(t)
	old := uploadIdleTimeout
	uploadIdleTimeout = 200 * time.Millisecond
	t.Cleanup(func() { uploadIdleTimeout = old })
	srv := httptest.NewServer(fx.mux)
	defer srv.Close()
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	q := uploadQuery(".", "stall.bin", "root", fx.root)
	fmt.Fprintf(conn, "POST /api/mux/panes/0/files/upload?%s HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000\r\n\r\npartial", q.Encode())
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusRequestTimeout || !strings.Contains(string(b), `"timeout"`) {
		t.Errorf("stalled = %d %s", resp.StatusCode, b)
	}
	if len(fx.f.uploadSlots) != 0 {
		t.Error("the slot was kept")
	}
	notExist(t, filepath.Join(fx.root, "stall.bin"))
	noTemps(t, fx.root)
}

// fakeFile fails its write or its sync with err
type fakeFile struct {
	writeErr, syncErr error
}

func (f *fakeFile) Write(p []byte) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return len(p), nil
}

func (f *fakeFile) Sync() error { return f.syncErr }

func TestStreamNewFile(t *testing.T) {
	disk := errors.New("disk")
	body := errors.New("body")
	mapped := errors.New("mapped")
	bodyErr := func(err error) error {
		if err == body {
			return mapped
		}
		return err
	}
	// The disk first: a write that fails is the disk's, whatever the body
	if _, err := streamNewFile(&fakeFile{writeErr: disk}, strings.NewReader("x"), bodyErr); err != disk {
		t.Errorf("write = %v", err)
	}
	if _, err := streamNewFile(&fakeFile{}, &failAfter{r: strings.NewReader("x"), err: body}, bodyErr); err != mapped {
		t.Errorf("body = %v", err)
	}
	if _, err := streamNewFile(&fakeFile{syncErr: disk}, strings.NewReader("x"), bodyErr); err != disk {
		t.Errorf("sync = %v", err)
	}
	if n, err := streamNewFile(&fakeFile{}, strings.NewReader("abc"), bodyErr); n != 3 || err != nil {
		t.Errorf("ok = %d %v", n, err)
	}
}

// A root gone from the disk since the request found it, and a directory
// that fails its look: nothing opened, nothing placed
func TestFilesUploadRootGone(t *testing.T) {
	f := &filesAPI{writeLocks: &writeLocks{locks: map[string]*sync.Mutex{}}}
	gone := filepath.Join(t.TempDir(), "gone")
	if _, err := f.checkUpload(filesRoot{Root: gone}, ".", "a", false); err == nil {
		t.Error("checked an upload under a root that is not there")
	}
	if _, _, err := f.writeUpload(filesRoot{Root: gone}, ".", "a", strings.NewReader(""), false); err == nil {
		t.Error("wrote an upload under a root that is not there")
	}
	rt, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rt.Close()
	if err := freeName(rt)("a"); err == nil || errors.Is(err, fs.ErrExist) {
		t.Errorf("closed dir = %v", err)
	}
}
