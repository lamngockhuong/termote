package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// downloadFixture is a root behind the files routes with a deny dir (cfg)
// and a dir a write never touches (data).
type downloadFixture struct {
	root string
	f    *filesAPI
	mux  *http.ServeMux
}

func newDownloadFixture(t *testing.T) *downloadFixture {
	t.Helper()
	root := filepath.Join(plainDir(t), "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: root, files: true}, hostAllowlist{}, []string{filepath.Join(root, "cfg")})
	f.writeDeny = filesDenyDirs(filepath.Join(root, "data"))
	return &downloadFixture{root: root, f: f, mux: mux}
}

func (fx *downloadFixture) write(t *testing.T, rel, text string) {
	t.Helper()
	writeFile(t, filepath.Join(fx.root, filepath.FromSlash(rel)), text)
}

// get downloads with the query q, signed in as a (none when nil).
func (fx *downloadFixture) get(q url.Values, a *authInfo) *httptest.ResponseRecorder {
	req := apiRequest("GET", "/api/mux/panes/0/files/download?"+q.Encode(), "")
	if a != nil {
		req = req.WithContext(withAuth(req.Context(), *a))
	}
	return serve(fx.mux, req)
}

func TestFilesDownloadSendsBytes(t *testing.T) {
	fx := newDownloadFixture(t)
	logs := captureLog(t)
	var all []byte
	for i := 0; i < 3; i++ {
		for b := 0; b < 256; b++ {
			all = append(all, byte(b))
		}
	}
	all = append(all, 0xff, 0xfe, 0x00, 0xc3) // invalid UTF-8, NUL
	for _, p := range []string{"dir/sub/f.bin", "a.html", "a.svg"} {
		fx.write(t, p, string(all))
		rec := fx.get(url.Values{"path": {p}, "root": {fx.root}}, &authInfo{Kind: authSession, Role: roleFull})
		h := rec.Header()
		if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), all) {
			t.Fatalf("%s = %d (%d bytes)", p, rec.Code, rec.Body.Len())
		}
		csp := h.Values("Content-Security-Policy")
		if h.Get("Content-Type") != "application/octet-stream" || h.Get("Content-Length") != "772" ||
			h.Get("Content-Disposition") != "attachment; filename*=UTF-8''"+filepath.Base(p) ||
			h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Cache-Control") != "no-store" ||
			h.Get("Cross-Origin-Resource-Policy") != "same-origin" || len(csp) != 1 || csp[0] != downloadPolicy {
			t.Errorf("%s headers = %v", p, h)
		}
	}
	if n := strings.Count(logs.String(), "audit: download"); n != 3 {
		t.Errorf("audit lines = %d:\n%s", n, logs)
	}
	if !strings.Contains(logs.String(), `audit: download path="dir/sub/f.bin" size="772" by="password" via="session"`) {
		t.Errorf("audit line:\n%s", logs)
	}
}

func TestFilesDownloadName(t *testing.T) {
	for in, want := range map[string]string{
		"a b%.txt":         "a%20b%25.txt",
		"tên.txt":          "t%C3%AAn.txt",
		"evil\u202Etxt.sh": "eviltxt.sh",
		"zero\u200Bw.txt":  "zerow.txt",
		"ctl\x01\x7f.bin":  "ctl.bin",
		"a;b=c'd\"(e).txt": "a%3Bb%3Dc%27d%22%28e%29.txt",
		"\u200B":           "download",
	} {
		if got := rfc5987Escape(downloadName(in)); got != want {
			t.Errorf("%q = %q, want %q", in, got, want)
		}
	}
	fx := newDownloadFixture(t)
	captureLog(t)
	fx.write(t, "my\u202Efile;x.txt", "x")
	rec := fx.get(url.Values{"path": {"my\u202Efile;x.txt"}}, nil)
	if got := rec.Header().Get("Content-Disposition"); rec.Code != 200 || got != "attachment; filename*=UTF-8''myfile%3Bx.txt" {
		t.Errorf("disposition = %d %q", rec.Code, got)
	}
}

func TestFilesDownloadCheck(t *testing.T) {
	fx := newDownloadFixture(t)
	logs := captureLog(t)
	fx.write(t, "dir/f.bin", "12345")
	rec := fx.get(url.Values{"path": {"dir/f.bin"}, "check": {"1"}}, nil)
	body := decodeBody(t, rec)
	if rec.Code != 200 || body["root"] != fx.root || body["path"] != "dir/f.bin" || body["size"] != 5.0 ||
		rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("check = %d %v", rec.Code, body)
	}
	if strings.Contains(logs.String(), "audit:") {
		t.Errorf("check=1 audited:\n%s", logs)
	}
	if len(fx.f.rawSlots) != 0 {
		t.Errorf("slots held = %d", len(fx.f.rawSlots))
	}
}

func TestFilesDownloadRefusals(t *testing.T) {
	fx := newDownloadFixture(t)
	logs := captureLog(t)
	fx.write(t, ".env", "TOKEN=x\n")
	fx.write(t, "cfg/secret", "key\n")
	fx.write(t, "data/current", "v\n")
	fx.write(t, ".git/config", "[core]\n")
	fx.write(t, "sub/a.txt", "a\n")
	big, err := os.Create(filepath.Join(fx.root, "big.bin"))
	if err != nil {
		t.Fatal(err)
	}
	big.Truncate(maxDownloadSize + 1) // sparse: refused by its size, never read
	big.Close()
	fx.write(t, "edge.bin", "")
	if err := os.Truncate(filepath.Join(fx.root, "edge.bin"), maxDownloadSize); err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		q    url.Values
		code int
		key  string
	}{
		"sensitive":          {url.Values{"path": {".env"}}, 403, "sensitive"},
		"sensitive missing":  {url.Values{"path": {"id_rsa"}}, 404, ""},
		"missing":            {url.Values{"path": {"nope.bin"}}, 404, ""},
		"missing parent":     {url.Values{"path": {"nope/a.bin"}}, 404, ""},
		"deny dir":           {url.Values{"path": {"cfg/secret"}, "reveal": {"1"}}, 403, "not_allowed"},
		"write deny dir":     {url.Values{"path": {"data/current"}}, 403, "not_allowed"},
		"git dir":            {url.Values{"path": {".git/config"}}, 403, "not_allowed"},
		"directory":          {url.Values{"path": {"sub"}}, 400, "not_file"},
		"root":               {url.Values{"path": {""}}, 400, "not_file"},
		"too large":          {url.Values{"path": {"big.bin"}}, 413, "too_large"},
		"too large checked":  {url.Values{"path": {"big.bin"}, "check": {"1"}}, 413, "too_large"},
		"climbs":             {url.Values{"path": {"../x"}}, 400, ""},
		"root changed":       {url.Values{"path": {"sub/a.txt"}, "root": {"/elsewhere"}}, 409, ""},
		"sensitive revealed": {url.Values{"path": {".env"}, "reveal": {"1"}, "check": {"1"}}, 200, ""},
		"at the cap":         {url.Values{"path": {"edge.bin"}, "check": {"1"}}, 200, ""},
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink("sub", filepath.Join(fx.root, "in")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("sub/a.txt", filepath.Join(fx.root, "link.txt")); err != nil {
			t.Fatal(err)
		}
		cases["symlinked parent"] = struct {
			q    url.Values
			code int
			key  string
		}{url.Values{"path": {"in/a.txt"}}, 403, "symlink"}
		cases["symlinked file"] = struct {
			q    url.Values
			code int
			key  string
		}{url.Values{"path": {"link.txt"}}, 403, "symlink"}
	}
	for name, c := range cases {
		rec := fx.get(c.q, nil)
		code, key := rawCode(t, rec)
		if code != c.code || key != c.key {
			t.Errorf("%s = %d %q, want %d %q", name, code, key, c.code, c.key)
		}
		if code != 200 && rec.Header().Get("Content-Type") != "application/json" {
			t.Errorf("%s: Content-Type %q", name, rec.Header().Get("Content-Type"))
		}
		if csp := rec.Header().Values("Content-Security-Policy"); len(csp) != 1 || csp[0] != downloadPolicy {
			t.Errorf("%s: CSP %v", name, csp)
		}
	}
	if rec := fx.get(url.Values{"path": {"root"}, "root": {"/elsewhere"}}, nil); !strings.Contains(rec.Body.String(), `"root":"`+jsonEscape(fx.root)) {
		t.Errorf("root changed body = %s", rec.Body)
	}
	if strings.Contains(logs.String(), "audit:") {
		t.Errorf("a refusal audited:\n%s", logs)
	}
	if rec := fx.get(url.Values{"path": {".env"}, "reveal": {"1"}}, nil); rec.Code != 200 || rec.Body.String() != "TOKEN=x\n" {
		t.Errorf("revealed = %d %q", rec.Code, rec.Body)
	}
}

func jsonEscape(s string) string {
	b, _ := json.Marshal(s)
	return string(b[1 : len(b)-1])
}

func TestFilesDownloadViewOnlyAndGuards(t *testing.T) {
	fx := newDownloadFixture(t)
	captureLog(t)
	fx.write(t, "a.bin", "x")
	view := &authInfo{Kind: authDevice, Role: roleView, DeviceID: "d1"}
	for _, q := range []url.Values{{"path": {"a.bin"}}, {"path": {"a.bin"}, "check": {"1"}}} {
		if code, key := rawCode(t, fx.get(q, view)); code != 403 || key != "view_only" {
			t.Errorf("view-only %v = %d %q", q, code, key)
		}
	}
	logs := captureLog(t)
	if rec := fx.get(url.Values{"path": {"a.bin"}}, &authInfo{Kind: authDevice, Role: roleFull, DeviceID: "d2"}); rec.Code != 200 {
		t.Errorf("full device = %d", rec.Code)
	}
	if !strings.Contains(logs.String(), `by="device:d2" via="device"`) {
		t.Errorf("device audit:\n%s", logs)
	}
	path := "/api/mux/panes/0/files/download?path=a.bin"
	if rec := serve(fx.mux, apiRequest("POST", path, "{}")); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
	req := apiRequest("GET", path, "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(fx.mux, req); rec.Code != http.StatusForbidden || rec.Body.String() == "x" {
		t.Errorf("cross-site = %d", rec.Code)
	}
}

// Every slot taken: 429 busy for a download and for check=1; a free slot
// works and is given back.
func TestFilesDownloadBusy(t *testing.T) {
	fx := newDownloadFixture(t)
	captureLog(t)
	fx.write(t, "a.bin", "x")
	for i := 0; i < rawMaxRunning; i++ {
		fx.f.rawSlots <- struct{}{}
	}
	for _, q := range []url.Values{{"path": {"a.bin"}}, {"path": {"a.bin"}, "check": {"1"}}} {
		if code, key := rawCode(t, fx.get(q, nil)); code != 429 || key != "busy" {
			t.Errorf("busy %v = %d %q", q, code, key)
		}
	}
	<-fx.f.rawSlots
	if rec := fx.get(url.Values{"path": {"a.bin"}}, nil); rec.Code != 200 {
		t.Errorf("free slot = %d", rec.Code)
	}
	if len(fx.f.rawSlots) != rawMaxRunning-1 {
		t.Errorf("slots held = %d, want %d", len(fx.f.rawSlots), rawMaxRunning-1)
	}
}

// A file that grows after its checks sends only the size checked.
func TestFilesDownloadGrows(t *testing.T) {
	fx := newDownloadFixture(t)
	captureLog(t)
	fx.write(t, "log.txt", "first\n")
	old := downloadBeforeCopy
	downloadBeforeCopy = func(*os.File) {
		fh, err := os.OpenFile(filepath.Join(fx.root, "log.txt"), os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Error(err)
			return
		}
		fh.WriteString("second\n")
		fh.Close()
	}
	defer func() { downloadBeforeCopy = old }()
	rec := fx.get(url.Values{"path": {"log.txt"}}, nil)
	if rec.Code != 200 || rec.Body.String() != "first\n" || rec.Header().Get("Content-Length") != "6" {
		t.Errorf("grown = %d %q", rec.Code, rec.Body)
	}
}

func TestWriteDownloadShortRead(t *testing.T) {
	logs := captureLog(t)
	rec := httptest.NewRecorder()
	writeDownload(rec, "a.bin", 10, strings.NewReader("abc"))
	if rec.Body.String() != "abc" || rec.Header().Get("Content-Length") != "10" {
		t.Errorf("short read = %q %v", rec.Body.String(), rec.Header())
	}
	if !strings.Contains(logs.String(), "files download: sending 3 of 10 bytes: EOF") {
		t.Errorf("log = %q", logs.String())
	}
}

// A client that stops reading is dropped once a chunk waits past the idle
// timeout, and its slot is given back.
func TestFilesDownloadSlowClient(t *testing.T) {
	fx := newDownloadFixture(t)
	captureLog(t)
	big, err := os.Create(filepath.Join(fx.root, "big.bin"))
	if err != nil {
		t.Fatal(err)
	}
	big.Truncate(64 << 20) // far more than the socket buffers hold
	big.Close()
	old := downloadIdleTimeout
	downloadIdleTimeout = 200 * time.Millisecond
	defer func() { downloadIdleTimeout = old }()
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		fx.mux.ServeHTTP(w, r)
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/mux/panes/0/files/download?path=big.bin", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if _, err := io.CopyN(io.Discard, res.Body, 1024); err != nil || res.StatusCode != 200 {
		t.Fatalf("first bytes: %d %v", res.StatusCode, err)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("handler still sending to a client that stopped reading")
	}
	if len(fx.f.rawSlots) != 0 {
		t.Errorf("slots held = %d", len(fx.f.rawSlots))
	}
}
