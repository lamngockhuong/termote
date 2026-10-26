package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// testZip is a zip holding one entry, as an .xlsx or .docx starts.
func testZip(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	w, err := zw.Create("[Content_Types].xml")
	if err != nil {
		t.Fatal(err)
	}
	w.Write([]byte("<Types/>"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

const testPDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"

func documentGet(h http.Handler, q url.Values) *httptest.ResponseRecorder {
	return serve(h, apiRequest("GET", "/api/mux/panes/0/files/document?"+q.Encode(), ""))
}

func TestDocumentKind(t *testing.T) {
	for in, want := range map[string]string{"a.pdf": "pdf", "B.PDF": "pdf", "c.Xlsx": "xlsx", "d.docx": "docx", "e.xls": "", "f.doc": "", "pdf": ""} {
		got, ok := documentKind(in)
		if got != want || ok != (want != "") {
			t.Errorf("%s = %q %v", in, got, ok)
		}
	}
}

func TestCheckDocument(t *testing.T) {
	for name, c := range map[string]struct {
		kind, head string
		want       error
	}{
		"pdf":               {"pdf", testPDF, nil},
		"pdf after junk":    {"pdf", "\x00\x01junk%PDF-1.7", nil},
		"not pdf":           {"pdf", "hello", errNotDocument},
		"zip":               {"xlsx", "PK\x03\x04rest", nil},
		"empty zip":         {"docx", "PK\x05\x06", errNotDocument},
		"text named docx":   {"docx", "hello", errNotDocument},
		"ole":               {"xlsx", string(oleMagic) + "rest", errDocumentEncrypted},
		"ole named pdf":     {"pdf", string(oleMagic), errNotDocument},
		"lfs pointer":       {"pdf", lfsPointer, errLFSPointer},
		"lfs pointer zip":   {"docx", lfsPointer, errLFSPointer},
		"empty":             {"pdf", "", errNotDocument},
		"empty office file": {"xlsx", "", errNotDocument},
	} {
		if err := checkDocument(c.kind, []byte(c.head)); !errors.Is(err, c.want) && err != c.want {
			t.Errorf("%s = %v, want %v", name, err, c.want)
		}
	}
}

func TestFilesDocumentWorktree(t *testing.T) {
	fx := newFilesFixture(t)
	logs := captureLog(t)
	zipped := testZip(t)
	docs := map[string]string{
		"docs/spec.pdf":   testPDF,
		"docs/cases.xlsx": string(zipped),
		"docs/memo.DOCX":  string(zipped),
	}
	for p, b := range docs {
		writeFile(t, filepath.Join(fx.root, filepath.FromSlash(p)), b)
	}
	for p, b := range docs {
		rec := documentGet(fx.h, url.Values{"path": {p}, "root": {fx.root}})
		h := rec.Header()
		if rec.Code != 200 || rec.Body.String() != b {
			t.Errorf("%s = %d (%d bytes)", p, rec.Code, rec.Body.Len())
			continue
		}
		csp := h.Values("Content-Security-Policy")
		if h.Get("Content-Type") != "application/octet-stream" || h.Get("Content-Disposition") != "attachment; filename*=UTF-8''"+filepath.Base(p) ||
			h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Cache-Control") != "no-store" ||
			h.Get("Cross-Origin-Resource-Policy") != "same-origin" || len(csp) != 2 || csp[1] != downloadPolicy {
			t.Errorf("%s headers = %v", p, h)
		}
	}
	if n := strings.Count(logs.String(), "audit: document"); n != 3 {
		t.Errorf("audit lines = %d:\n%s", n, logs)
	}
	if !strings.Contains(logs.String(), `audit: document path="docs/spec.pdf" size="`) {
		t.Errorf("audit line:\n%s", logs)
	}

	writeFile(t, filepath.Join(fx.root, "fake.pdf"), "hello")
	writeFile(t, filepath.Join(fx.root, "fake.xlsx"), testPDF)
	writeFile(t, filepath.Join(fx.root, "locked.xlsx"), string(oleMagic)+"rest")
	writeFile(t, filepath.Join(fx.root, "lfs.pdf"), lfsPointer)
	writeFile(t, filepath.Join(fx.root, "secrets.pdf"), testPDF)
	writeFile(t, filepath.Join(fx.root, "old.xls"), string(oleMagic))
	os.MkdirAll(filepath.Join(fx.root, "dir.pdf"), 0o755)
	big, err := os.Create(filepath.Join(fx.root, "big.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	big.Truncate(maxDocumentSize + 1) // sparse: refused by its size, never read
	big.Close()

	for name, c := range map[string]struct {
		q    url.Values
		code int
		key  string
	}{
		"fake pdf":           {url.Values{"path": {"fake.pdf"}}, 415, "not_document"},
		"pdf named xlsx":     {url.Values{"path": {"fake.xlsx"}}, 415, "not_document"},
		"encrypted":          {url.Values{"path": {"locked.xlsx"}}, 415, "encrypted"},
		"other extension":    {url.Values{"path": {"old.xls"}}, 415, "not_document"},
		"text":               {url.Values{"path": {"a.txt"}}, 415, "not_document"},
		"directory":          {url.Values{"path": {"dir.pdf"}}, 415, "not_document"},
		"lfs pointer":        {url.Values{"path": {"lfs.pdf"}}, 415, "lfs_pointer"},
		"too large":          {url.Values{"path": {"big.pdf"}}, 413, "too_large"},
		"git dir":            {url.Values{"path": {".git/x.pdf"}}, 403, ""},
		"deny dir":           {url.Values{"path": {"cfg/x.pdf"}, "reveal": {"1"}}, 403, ""},
		"sensitive":          {url.Values{"path": {"secrets.pdf"}}, 403, "sensitive"},
		"sensitive revealed": {url.Values{"path": {"secrets.pdf"}, "reveal": {"1"}}, 200, ""},
		"sensitive missing":  {url.Values{"path": {"secrets.docx"}}, 404, ""},
		"missing":            {url.Values{"path": {"nope.pdf"}}, 404, ""},
		"climbs":             {url.Values{"path": {"../outside/x.pdf"}}, 400, ""},
		"side":               {url.Values{"path": {"docs/spec.pdf"}, "side": {"new"}}, 400, ""},
		"root changed":       {url.Values{"path": {"docs/spec.pdf"}, "root": {"/elsewhere"}}, 409, ""},
	} {
		code, key := rawCode(t, documentGet(fx.h, c.q))
		if code != c.code || key != c.key {
			t.Errorf("%s = %d %q, want %d %q", name, code, key, c.code, c.key)
		}
	}

	// 413 carries the size, so the client can say how large the file is.
	body := decodeBody(t, documentGet(fx.h, url.Values{"path": {"big.pdf"}}))
	if body["size"] != float64(maxDocumentSize+1) || body["error"] != errDocumentTooLarge.msg {
		t.Errorf("too large body = %v", body)
	}

	if runtime.GOOS != "windows" {
		writeFile(t, filepath.Join(fx.outside, "x.pdf"), testPDF)
		os.Symlink("../outside/x.pdf", filepath.Join(fx.root, "out.pdf"))
		if code, _ := rawCode(t, documentGet(fx.h, url.Values{"path": {"out.pdf"}})); code != 400 {
			t.Errorf("symlink out of the root = %d", code)
		}
	}
	if _, err := exec.LookPath("mkfifo"); err == nil && runtime.GOOS != "windows" {
		exec.Command("mkfifo", filepath.Join(fx.root, "pipe.pdf")).Run()
		done := make(chan int, 1)
		go func() { done <- documentGet(fx.h, url.Values{"path": {"pipe.pdf"}}).Code }()
		select {
		case code := <-done:
			if code != 415 {
				t.Errorf("fifo = %d", code)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("document of a FIFO hung")
		}
	}
}

// A read that fails after the open is an internal error: logged, never sent.
func TestCheckDocumentFileReadError(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.pdf")
	writeFile(t, p, testPDF)
	fh, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	fh.Close() // Stat and Read now fail
	if _, err := checkDocumentFile(dir, "a.pdf", "pdf", false, fh); !errors.Is(err, errNotDocument) {
		t.Errorf("closed file = %v", err)
	}
}

func TestFilesDocumentGuards(t *testing.T) {
	fx := newFilesFixture(t)
	writeFile(t, filepath.Join(fx.root, "a.pdf"), testPDF)
	path := "/api/mux/panes/0/files/document?path=a.pdf"
	if rec := serve(fx.h, apiRequest("POST", path, "{}")); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
	req := apiRequest("GET", path, "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(fx.h, req); rec.Code != http.StatusForbidden || rec.Body.String() == testPDF {
		t.Errorf("cross-site = %d", rec.Code)
	}
}

// Every slot taken: 429 busy with a neutral message, the slot given back.
func TestFilesDocumentBusy(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.pdf"), testPDF)
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: dir, files: true}, hostAllowlist{}, nil)
	for i := 0; i < rawMaxRunning; i++ {
		f.rawSlots <- struct{}{}
	}
	rec := documentGet(mux, url.Values{"path": {"a.pdf"}})
	if code, key := rawCode(t, rec); code != 429 || key != "busy" || strings.Contains(rec.Body.String(), "image") {
		t.Errorf("busy = %d %q %s", code, key, rec.Body)
	}
	<-f.rawSlots
	if rec := documentGet(mux, url.Values{"path": {"a.pdf"}}); rec.Code != 200 {
		t.Errorf("free slot = %d", rec.Code)
	}
	if len(f.rawSlots) != rawMaxRunning-1 {
		t.Errorf("slots held = %d, want %d", len(f.rawSlots), rawMaxRunning-1)
	}
}

// A view-only client previews a tracked document, audited; an ignored one
// stays hidden.
func TestViewOnlyFilesDocument(t *testing.T) {
	repo, _ := viewOnlyRepo(t)
	writeFile(t, filepath.Join(repo, "spec.pdf"), testPDF)
	writeFile(t, filepath.Join(repo, "gen", "out.pdf"), testPDF)
	_, h := viewFilesFixture(t, repo)
	logs := captureLog(t)
	const base = "/api/mux/panes/0/files/document?path="
	if rec := serve(h, viewRequest("GET", base+"spec.pdf", "")); rec.Code != http.StatusOK || rec.Body.String() != testPDF {
		t.Errorf("view spec.pdf = %d %s", rec.Code, rec.Body)
	}
	if !strings.Contains(logs.String(), `audit: document path="spec.pdf"`) {
		t.Errorf("view audit:\n%s", logs)
	}
	// A sensitive file stays hidden from it: reveal=1 is refused
	if code, key := rawCode(t, serve(h, viewRequest("GET", base+"spec.pdf&reveal=1", ""))); code != 403 || key != "view_only" {
		t.Errorf("view reveal = %d %q", code, key)
	}
	if rec := serve(h, viewRequest("GET", base+"gen/out.pdf", "")); rec.Code != http.StatusNotFound {
		t.Errorf("view ignored = %d", rec.Code)
	}
	if rec := serve(h, fullRequest(base+"gen/out.pdf")); rec.Code != http.StatusOK {
		t.Errorf("full ignored = %d", rec.Code)
	}
}
