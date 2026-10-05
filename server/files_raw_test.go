package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"log"
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

// colorImage encodes a small image of one color in the given format.
func colorImage(t *testing.T, format string, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 3, 2))
	for x := 0; x < 3; x++ {
		for y := 0; y < 2; y++ {
			img.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	var err error
	switch format {
	case "png":
		err = png.Encode(&b, img)
	case "jpeg":
		err = jpeg.Encode(&b, img, nil)
	case "gif":
		err = gif.Encode(&b, img, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// pngHeader is the start of a PNG of w×h pixels: enough for DecodeConfig
// without encoding all of them.
func pngHeader(w, h uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8], ihdr[9] = 8, 0 // 8-bit grayscale
	chunk := append([]byte("IHDR"), ihdr...)
	var out bytes.Buffer
	out.WriteString("\x89PNG\r\n\x1a\n")
	binary.Write(&out, binary.BigEndian, uint32(len(ihdr)))
	out.Write(chunk)
	binary.Write(&out, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return out.Bytes()
}

const lfsPointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a\nsize 12345\n"

func rawGet(h http.Handler, q url.Values) *httptest.ResponseRecorder {
	return serve(h, apiRequest("GET", "/api/mux/panes/0/files/raw?"+q.Encode(), ""))
}

// rawCode returns the status and the JSON code of an error response.
func rawCode(t *testing.T, rec *httptest.ResponseRecorder) (int, string) {
	t.Helper()
	if rec.Code == http.StatusOK {
		return rec.Code, ""
	}
	code, _ := decodeBody(t, rec)["code"].(string)
	return rec.Code, code
}

func TestImageTypeOf(t *testing.T) {
	for head, want := range map[string]string{
		string(colorImage(t, "png", color.White)): "image/png",
		"GIF89a":                           "image/gif",
		string(testImage(t, "image/webp")): "image/webp",
	} {
		if mt, ok := imageTypeOf([]byte(head)); !ok || mt != want {
			t.Errorf("imageTypeOf(%q) = %q, %v", head[:6], mt, ok)
		}
	}
	for _, head := range []string{"", "hello", "<svg xmlns='http://www.w3.org/2000/svg'/>", "%PDF-1.4"} {
		if mt, ok := imageTypeOf([]byte(head)); ok {
			t.Errorf("imageTypeOf(%q) = %q, want not an image", head, mt)
		}
	}
}

func TestIsSVG(t *testing.T) {
	for _, s := range []string{
		"<svg xmlns='http://www.w3.org/2000/svg'/>",
		"<svg>",
		"<svg/>",
		"\uFEFF  <svg\n>",
		"<?xml version='1.0'?>\n<!-- made by hand -->\n<svg width='1'>",
		"<?xml version='1.0'?><?xml-stylesheet href='a.css'?><svg>",
		"<!DOCTYPE svg PUBLIC '-//W3C//DTD SVG 1.1//EN' 'x.dtd'>\n<svg>",
		"<!DOCTYPE svg [ <!ENTITY a 'b>c'> ]>\n<svg>",
		"<svg>caf\xc3", // cut inside the last character
	} {
		if !isSVG([]byte(s)) {
			t.Errorf("isSVG(%q) = false", s)
		}
	}
	for _, s := range []string{
		"", "<svg", "<svgx>", "<html><svg>", "hello <svg>", "<!-- open", "<?xml",
		"<!DOCTYPE svg [ <!ENTITY a 'b'>", "<!DOCTYPE svg", "caf\xe9 <svg>", "<svg>\xff\xfe",
		"<!doctype svg><svg>",
	} {
		if isSVG([]byte(s)) {
			t.Errorf("isSVG(%q) = true", s)
		}
	}
}

// failingSeeker fails a read or a seek.
type failingSeeker struct {
	r       io.Reader
	readErr bool
}

func (f *failingSeeker) Read(p []byte) (int, error) {
	if f.readErr {
		return 0, errors.New("disk on fire")
	}
	return f.r.Read(p)
}
func (f *failingSeeker) Seek(int64, int) (int64, error) { return 0, errors.New("cannot seek") }

func TestCheckImage(t *testing.T) {
	big := pngHeader(8000, 6000)
	for name, c := range map[string]struct {
		path, data string
		want       string
		err        error
	}{
		"png":            {"a.png", string(colorImage(t, "png", color.White)), "image/png", nil},
		"jpeg":           {"a.jpg", string(colorImage(t, "jpeg", color.White)), "image/jpeg", nil},
		"gif":            {"a.gif", string(colorImage(t, "gif", color.White)), "image/gif", nil},
		"webp":           {"a.webp", string(testImage(t, "image/webp")), "image/webp", nil},
		"svg":            {"A.SVG", "<svg/>", svgType, nil},
		"png named svg":  {"a.svg", string(colorImage(t, "png", color.White)), "", errNotImage},
		"svg named png":  {"a.png", "<svg/>", "", errNotImage},
		"html named svg": {"a.svg", "<html><svg/></html>", "", errNotImage},
		"text":           {"a.png", "hello", "", errNotImage},
		"empty":          {"a.png", "", "", errNotImage},
		"corrupt png":    {"a.png", "\x89PNG\r\n\x1a\n\x00\x00\x00", "", errNotImage},
		"lfs pointer":    {"a.png", lfsPointer, "", errLFSPointer},
		"too many px":    {"a.png", string(big), "", errTooManyPixels},
		"40 MP exactly":  {"a.png", string(pngHeader(8000, 5000)), "image/png", nil},
	} {
		r := bytes.NewReader([]byte(c.data))
		got, err := checkImage(c.path, r)
		if got != c.want || !errors.Is(err, c.err) {
			t.Errorf("%s = %q, %v, want %q, %v", name, got, err, c.want, c.err)
		}
		if err == nil && r.Len() != len(c.data) {
			t.Errorf("%s: left at %d, want the start", name, len(c.data)-r.Len())
		}
	}
	png := colorImage(t, "png", color.White)
	if _, err := checkImage("a.png", &failingSeeker{readErr: true}); err == nil || err.Error() != "disk on fire" {
		t.Errorf("read error = %v", err)
	}
	if _, err := checkImage("a.png", &failingSeeker{r: bytes.NewReader(png)}); err == nil || err.Error() != "cannot seek" {
		t.Errorf("seek error = %v", err)
	}
}

func TestWriteImageShortRead(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)
	rec := httptest.NewRecorder()
	writeImage(rec, "image/png", 10, strings.NewReader("abc"))
	if rec.Body.String() != "abc" || rec.Header().Get("Content-Length") != "10" {
		t.Errorf("short read = %q %v", rec.Body.String(), rec.Header())
	}
	if !strings.Contains(logs.String(), "files raw: sending image/png image: EOF") {
		t.Errorf("log = %q", logs.String())
	}
}

func TestFilesRawWorktree(t *testing.T) {
	fx := newFilesFixture(t)
	imgs := map[string][]byte{
		"img/a.png":   colorImage(t, "png", color.White),
		"img/a.jpg":   colorImage(t, "jpeg", color.White),
		"img/a.gif":   colorImage(t, "gif", color.White),
		"img/a.webp":  testImage(t, "image/webp"),
		"secrets.png": colorImage(t, "png", color.Black),
	}
	for p, b := range imgs {
		writeFile(t, filepath.Join(fx.root, p), string(b))
	}
	for p, want := range map[string]string{"img/a.png": "image/png", "img/a.jpg": "image/jpeg", "img/a.gif": "image/gif", "img/a.webp": "image/webp"} {
		rec := rawGet(fx.h, url.Values{"path": {p}, "root": {fx.root}})
		h := rec.Header()
		if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), imgs[p]) || h.Get("Content-Type") != want {
			t.Errorf("%s = %d %q", p, rec.Code, h.Get("Content-Type"))
			continue
		}
		if h.Get("Cross-Origin-Resource-Policy") != "same-origin" || h.Get("Content-Disposition") != "inline" ||
			h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Cache-Control") != "no-store" ||
			len(h.Values("Content-Security-Policy")) != 1 {
			t.Errorf("%s headers = %v", p, h)
		}
	}

	// SVG: served as an image only with the .svg name, with a sandbox policy
	// of its own and as an attachment.
	svg := "<?xml version='1.0'?>\n<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"
	writeFile(t, filepath.Join(fx.root, "logo.svg"), svg)
	rec := rawGet(fx.h, url.Values{"path": {"logo.svg"}})
	csp := rec.Header().Values("Content-Security-Policy")
	if rec.Code != 200 || rec.Body.String() != svg || rec.Header().Get("Content-Type") != svgType ||
		rec.Header().Get("Content-Disposition") != "attachment" || len(csp) != 2 || csp[1] != svgPolicy ||
		!strings.Contains(csp[0], "script-src 'self'") {
		t.Errorf("svg = %d %v", rec.Code, rec.Header())
	}

	writeFile(t, filepath.Join(fx.root, "html.svg"), "<html><script>alert(1)</script></html>")
	writeFile(t, filepath.Join(fx.root, "svg.txt"), "<svg/>")
	writeFile(t, filepath.Join(fx.root, "svg.png"), "<svg/>")
	writeFile(t, filepath.Join(fx.root, "fake.png"), "\x89PNG\r\n\x1a\n\x00\x00\x00")
	writeFile(t, filepath.Join(fx.root, "lfs.png"), lfsPointer)
	writeFile(t, filepath.Join(fx.root, "huge.png"), string(pngHeader(8000, 6000)))
	big, err := os.Create(filepath.Join(fx.root, "big.png"))
	if err != nil {
		t.Fatal(err)
	}
	big.Truncate(maxImageSize + 1) // sparse: refused by its size, never read
	big.Close()

	for name, c := range map[string]struct {
		q    url.Values
		code int
		key  string
	}{
		"text":                {url.Values{"path": {"a.txt"}}, 415, "not_image"},
		"html named svg":      {url.Values{"path": {"html.svg"}}, 415, "not_image"},
		"svg named txt":       {url.Values{"path": {"svg.txt"}}, 415, "not_image"},
		"svg named png":       {url.Values{"path": {"svg.png"}}, 415, "not_image"},
		"fake png":            {url.Values{"path": {"fake.png"}}, 415, "not_image"},
		"directory":           {url.Values{"path": {"img"}}, 415, "not_image"},
		"lfs pointer":         {url.Values{"path": {"lfs.png"}}, 415, "lfs_pointer"},
		"too large":           {url.Values{"path": {"big.png"}}, 413, "too_large"},
		"too many pixels":     {url.Values{"path": {"huge.png"}}, 413, "too_many_pixels"},
		"git dir":             {url.Values{"path": {".git/config"}}, 403, ""},
		"deny dir":            {url.Values{"path": {"cfg/secret"}, "reveal": {"1"}}, 403, ""},
		"sensitive":           {url.Values{"path": {"secrets.png"}}, 403, "sensitive"},
		"sensitive revealed":  {url.Values{"path": {"secrets.png"}, "reveal": {"1"}}, 200, ""},
		"sensitive missing":   {url.Values{"path": {"secrets.jpg"}}, 404, ""},
		"missing":             {url.Values{"path": {"nope.png"}}, 404, ""},
		"climbs":              {url.Values{"path": {"../outside/passwd"}}, 400, ""},
		"bad side":            {url.Values{"path": {"img/a.png"}, "side": {"x"}}, 400, ""},
		"root changed":        {url.Values{"path": {"img/a.png"}, "root": {"/elsewhere"}}, 409, ""},
		"side outside a repo": {url.Values{"path": {"img/a.png"}, "side": {"new"}}, 404, ""},
	} {
		code, key := rawCode(t, rawGet(fx.h, c.q))
		if code != c.code || key != c.key {
			t.Errorf("%s = %d %q, want %d %q", name, code, key, c.code, c.key)
		}
	}
	if runtime.GOOS != "windows" {
		os.Symlink("../outside/passwd", filepath.Join(fx.root, "out.png"))
		if code, _ := rawCode(t, rawGet(fx.h, url.Values{"path": {"out.png"}})); code != 400 {
			t.Errorf("symlink out of the root = %d", code)
		}
	}
	if _, err := exec.LookPath("mkfifo"); err == nil && runtime.GOOS != "windows" {
		exec.Command("mkfifo", filepath.Join(fx.root, "pipe.png")).Run()
		done := make(chan int, 1)
		go func() { done <- rawGet(fx.h, url.Values{"path": {"pipe.png"}}).Code }()
		select {
		case code := <-done:
			if code != 415 {
				t.Errorf("fifo = %d", code)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("raw of a FIFO hung")
		}
	}
}

func TestFilesRawGuards(t *testing.T) {
	fx := newFilesFixture(t)
	writeFile(t, filepath.Join(fx.root, "a.png"), string(colorImage(t, "png", color.White)))
	path := "/api/mux/panes/0/files/raw?path=a.png"
	if rec := serve(fx.h, apiRequest("POST", path, "{}")); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
	req := apiRequest("GET", path, "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(fx.h, req); rec.Code != http.StatusForbidden || rec.Header().Get("Content-Type") == "image/png" {
		t.Errorf("cross-site = %d", rec.Code)
	}
}

// Every slot taken: 429 busy at once, and the slot is given back after.
func TestFilesRawBusy(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.png"), string(colorImage(t, "png", color.White)))
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: dir, files: true}, hostAllowlist{}, nil)
	for i := 0; i < rawMaxRunning; i++ {
		f.rawSlots <- struct{}{}
	}
	if code, key := rawCode(t, rawGet(mux, url.Values{"path": {"a.png"}})); code != 429 || key != "busy" {
		t.Errorf("busy = %d %q", code, key)
	}
	<-f.rawSlots
	if rec := rawGet(mux, url.Values{"path": {"a.png"}}); rec.Code != 200 {
		t.Errorf("free slot = %d", rec.Code)
	}
	if len(f.rawSlots) != rawMaxRunning-1 {
		t.Errorf("slots held = %d, want %d", len(f.rawSlots), rawMaxRunning-1)
	}
}

func TestImageVersion(t *testing.T) {
	type v struct {
		spec, name string
		worktree   bool
		ok         bool
	}
	for _, c := range []struct {
		name   string
		e      changeEntry
		staged bool
		side   string
		want   v
	}{
		{".M old", changeEntry{Path: "a.png", Unstaged: "M"}, false, "old", v{":0:a.png", "a.png", false, true}},
		{".M new", changeEntry{Path: "a.png", Unstaged: "M"}, false, "new", v{"", "a.png", true, true}},
		{"M. old", changeEntry{Path: "a.png", Staged: "M"}, true, "old", v{"HEAD:a.png", "a.png", false, true}},
		{"M. new", changeEntry{Path: "a.png", Staged: "M"}, true, "new", v{":0:a.png", "a.png", false, true}},
		{"? old", changeEntry{Path: "a.png", Unstaged: "?"}, false, "old", v{}},
		{".A old", changeEntry{Path: "a.png", Unstaged: "A"}, false, "old", v{}},
		{"conflict old", changeEntry{Path: "a.png", Conflict: true}, false, "old", v{}},
		{"conflict new", changeEntry{Path: "a.png", Conflict: true}, false, "new", v{"", "a.png", true, true}},
		{".D new", changeEntry{Path: "a.png", Unstaged: "D"}, false, "new", v{"", "a.png", true, false}},
		{".D old", changeEntry{Path: "a.png", Unstaged: "D"}, false, "old", v{":0:a.png", "a.png", false, true}},
		{"A. old", changeEntry{Path: "a.png", Staged: "A"}, true, "old", v{}},
		{"D. new", changeEntry{Path: "a.png", Staged: "D"}, true, "new", v{":0:a.png", "a.png", false, false}},
		{"R. old", changeEntry{Path: "b.png", Orig: "a.png", Staged: "R"}, true, "old", v{"HEAD:a.png", "a.png", false, true}},
		{"RM unstaged old", changeEntry{Path: "b.png", Orig: "a.png", Staged: "R", Unstaged: "M"}, false, "old", v{":0:b.png", "b.png", false, true}},
		{".R old", changeEntry{Path: "b.png", Orig: "a.png", Unstaged: "R"}, false, "old", v{":0:a.png", "a.png", false, true}},
		{".C old", changeEntry{Path: "b.png", Orig: "a.png", Unstaged: "C"}, false, "old", v{":0:a.png", "a.png", false, true}},
		{"stage-like name", changeEntry{Path: "0:a.png", Unstaged: "M"}, false, "old", v{":0:0:a.png", "0:a.png", false, true}},
	} {
		spec, name, wt, ok := imageVersion(c.e, c.staged, c.side)
		if got := (v{spec, name, wt, ok}); got != c.want && (ok || c.want.ok) {
			t.Errorf("%s = %+v, want %+v", c.name, got, c.want)
		}
	}
}

// An image in every status the Changes view shows: each side serves the
// version the plan's table names, or no_version.
func TestFilesRawVersions(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	img := func(n uint8) string { return string(colorImage(t, "png", color.RGBA{n, n, n, 255})) }
	for _, p := range []string{"m.png", "s.png", "mm.png", "sd.png", "ud.png", "o.png", "o2.png", "0:a.png", "1:a.png", "a.png", "lfs.png"} {
		writeFile(t, filepath.Join(r, p), img(1)+p)
	}
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "images")

	writeFile(t, filepath.Join(r, "m.png"), img(2))               // .M
	writeFile(t, filepath.Join(r, "s.png"), img(2))               // M.
	gitT(t, r, "add", "s.png")                                    //
	writeFile(t, filepath.Join(r, "mm.png"), img(2))              // MM
	gitT(t, r, "add", "mm.png")                                   //
	writeFile(t, filepath.Join(r, "mm.png"), img(3))              //
	writeFile(t, filepath.Join(r, "u.png"), img(4))               // ?
	writeFile(t, filepath.Join(r, "added.png"), img(5))           // A.
	gitT(t, r, "add", "added.png")                                //
	writeFile(t, filepath.Join(r, "ita.png"), img(6))             // .A
	gitT(t, r, "add", "-N", "ita.png")                            //
	gitT(t, r, "rm", "-q", "sd.png")                              // D.
	os.Remove(filepath.Join(r, "ud.png"))                         // .D
	gitT(t, r, "mv", "o.png", "r.png")                            // R.
	gitT(t, r, "mv", "o2.png", "r2.png")                          // RM
	writeFile(t, filepath.Join(r, "r2.png"), img(7))              //
	writeFile(t, filepath.Join(r, "0:a.png"), img(8))             // .M, next to a.png
	writeFile(t, filepath.Join(r, "a.png"), img(9))               // .M
	writeFile(t, filepath.Join(r, "1:a.png"), img(11))            // .M
	writeFile(t, filepath.Join(r, "lfs.png"), lfsPointer)         // M. holding a pointer
	gitT(t, r, "add", "lfs.png")                                  //
	writeFile(t, filepath.Join(r, "notes.txt"), "not an image\n") // ?
	writeFile(t, filepath.Join(r, "secrets.png"), img(10))        // ? sensitive
	_, by := gx.changes(t)
	if e := by["r.png"]; e == nil || e["orig"] != "o.png" || e["staged"] != "R" {
		t.Fatalf("rename = %v", by)
	}

	for _, c := range []struct {
		name, path, orig string
		staged           bool
		side             string
		want             string // bytes, or the error code
	}{
		{".M old", "m.png", "", false, "old", img(1) + "m.png"},
		{".M new", "m.png", "", false, "new", img(2)},
		{"M. old", "s.png", "", true, "old", img(1) + "s.png"},
		{"M. new", "s.png", "", true, "new", img(2)},
		{"MM staged old", "mm.png", "", true, "old", img(1) + "mm.png"},
		{"MM staged new", "mm.png", "", true, "new", img(2)},
		{"MM unstaged old", "mm.png", "", false, "old", img(2)},
		{"MM unstaged new", "mm.png", "", false, "new", img(3)},
		{"? old", "u.png", "", false, "old", "no_version"},
		{"? new", "u.png", "", false, "new", img(4)},
		{"A. old", "added.png", "", true, "old", "no_version"},
		{"A. new", "added.png", "", true, "new", img(5)},
		{".A old", "ita.png", "", false, "old", "no_version"},
		{".A new", "ita.png", "", false, "new", img(6)},
		{"D. old", "sd.png", "", true, "old", img(1) + "sd.png"},
		{"D. new", "sd.png", "", true, "new", "no_version"},
		{".D old", "ud.png", "", false, "old", img(1) + "ud.png"},
		{".D new", "ud.png", "", false, "new", "no_version"},
		{"R. old", "r.png", "o.png", true, "old", img(1) + "o.png"},
		{"R. new", "r.png", "o.png", true, "new", img(1) + "o.png"},
		{"RM staged old", "r2.png", "o2.png", true, "old", img(1) + "o2.png"},
		{"RM unstaged old", "r2.png", "o2.png", false, "old", img(1) + "o2.png"},
		{"RM unstaged new", "r2.png", "o2.png", false, "new", img(7)},
		{"stage-like name", "0:a.png", "", false, "old", img(1) + "0:a.png"},
		{"stage-like name new", "0:a.png", "", false, "new", img(8)},
		{"stage 1 name", "1:a.png", "", false, "old", img(1) + "1:a.png"},
		{"lfs pointer", "lfs.png", "", true, "new", "lfs_pointer"},
		{"not an image", "notes.txt", "", false, "new", "not_image"},
		{"sensitive", "secrets.png", "", false, "new", "sensitive"},
		{"not listed", "keep.png", "", false, "old", "not changed"},
		{"wrong side", "m.png", "", true, "old", "not changed"},
	} {
		q := url.Values{"path": {c.path}, "side": {c.side}}
		if c.orig != "" {
			q.Set("orig", c.orig)
		}
		if c.staged {
			q.Set("staged", "1")
		}
		rec := rawGet(gx.h, q)
		if rec.Code == 200 {
			if rec.Body.String() != c.want {
				t.Errorf("%s = %d bytes, want %q", c.name, rec.Body.Len(), c.want[:min(len(c.want), 20)])
			}
			continue
		}
		body := decodeBody(t, rec)
		if body["code"] != c.want && body["error"] != c.want {
			t.Errorf("%s = %d %v, want %q", c.name, rec.Code, body, c.want)
		}
	}
	// reveal=1 shows a sensitive one.
	if rec := rawGet(gx.h, url.Values{"path": {"secrets.png"}, "side": {"new"}, "reveal": {"1"}}); rec.Code != 200 || rec.Body.String() != img(10) {
		t.Errorf("sensitive revealed = %d", rec.Code)
	}
}

func TestFilesRawVersionChecks(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	png := string(colorImage(t, "png", color.White))
	writeFile(t, filepath.Join(r, ".env.png"), png)
	gitT(t, r, "add", "-f", ".")
	gitT(t, r, "commit", "-q", "-m", "x")
	if runtime.GOOS != "windows" {
		writeFile(t, filepath.Join(r, "line\nbreak.png"), png)
		gitT(t, r, "add", "line\nbreak.png")
		gitT(t, r, "commit", "-q", "-m", "y")
		writeFile(t, filepath.Join(r, "line\nbreak.png"), png+"x")
		// cat-file would drop the '\r' and read cr.png
		writeFile(t, filepath.Join(r, "cr.png"), png)
		writeFile(t, filepath.Join(r, "cr.png\r"), png)
		gitT(t, r, "add", "cr.png", "cr.png\r")
		gitT(t, r, "commit", "-q", "-m", "cr")
		writeFile(t, filepath.Join(r, "cr.png\r"), png+"x")
	}
	gitT(t, r, "mv", ".env.png", "plain.png")
	gx.changes(t)

	// A rename whose source is sensitive asks first.
	q := url.Values{"path": {"plain.png"}, "orig": {".env.png"}, "staged": {"1"}, "side": {"old"}}
	if code, key := rawCode(t, rawGet(gx.h, q)); code != 403 || key != "sensitive" {
		t.Errorf("sensitive orig = %d %q", code, key)
	}
	q.Set("reveal", "1")
	if rec := rawGet(gx.h, q); rec.Code != 200 || rec.Body.String() != png {
		t.Errorf("sensitive orig revealed = %d", rec.Code)
	}
	if runtime.GOOS != "windows" {
		q = url.Values{"path": {"line\nbreak.png"}, "side": {"old"}}
		if code, _ := rawCode(t, rawGet(gx.h, q)); code != 400 {
			t.Errorf("newline = %d", code)
		}
		q = url.Values{"path": {"cr.png\r"}, "side": {"old"}}
		if code, _ := rawCode(t, rawGet(gx.h, q)); code != 400 {
			t.Errorf("carriage return = %d", code)
		}
	}
	q = url.Values{"path": {"../x.png"}, "side": {"old"}}
	if code, _ := rawCode(t, rawGet(gx.h, q)); code != 400 {
		t.Errorf("outside = %d", code)
	}
}

// git failing, or a root that is gone, is an error before anything is sent.
func TestFilesRawFailures(t *testing.T) {
	requireUnixShell(t)
	gx := newGitFixture(t)
	writeFile(t, filepath.Join(gx.repo, "a.png"), string(colorImage(t, "png", color.White)))
	gitT(t, gx.repo, "add", "a.png")
	f := registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: gx.repo, files: true}, hostAllowlist{}, nil)
	root := filesRoot{Root: gx.repo, IsRepo: true}
	rec := httptest.NewRecorder()
	if err := f.serveImageVersion(rec, t.Context(), root, "a.png", "", true, "new", false); err != nil || rec.Code != 200 {
		t.Fatalf("staged new = %d, %v", rec.Code, err)
	}
	// The status is cached; cat-file now fails.
	f.git.bin = writeScript(t, "exit 1")
	if err := f.serveImageVersion(httptest.NewRecorder(), t.Context(), root, "a.png", "", true, "new", false); err == nil {
		t.Error("failing cat-file: no error")
	}
	f.statuses = newTTLCache[gitStatus](filesRootTTL)
	if err := f.serveImageVersion(httptest.NewRecorder(), t.Context(), root, "a.png", "", true, "new", false); err == nil {
		t.Error("failing status: no error")
	}
	gone := filesRoot{Root: filepath.Join(t.TempDir(), "gone")}
	if err := f.serveWorktreeImage(httptest.NewRecorder(), gone, "a.png", false); err == nil {
		t.Error("root gone: no error")
	}
}

// A denied path or source never reaches git.
func TestFilesRawVersionDenied(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	png := string(colorImage(t, "png", color.White))
	writeFile(t, filepath.Join(r, "deny", "x.png"), png)
	gitT(t, r, "add", ".")
	gitT(t, r, "commit", "-q", "-m", "x")
	gitT(t, r, "mv", "deny/x.png", "out.png")
	writeFile(t, filepath.Join(r, "deny", "new.png"), png)
	cfg := testConfig(t)
	cfg.FilesDenyDirs = []string{filepath.Join(r, "deny")}
	h, _, err := buildServer(cfg, &filesFakeMux{dir: r, files: true})
	if err != nil {
		t.Fatal(err)
	}
	gx.h = h
	gx.changes(t)
	for name, q := range map[string]url.Values{
		"orig": {"path": {"out.png"}, "orig": {"deny/x.png"}, "staged": {"1"}, "side": {"old"}, "reveal": {"1"}},
		"path": {"path": {"deny/new.png"}, "side": {"new"}, "reveal": {"1"}},
	} {
		if code, _ := rawCode(t, rawGet(gx.h, q)); code != 403 {
			t.Errorf("%s = %d", name, code)
		}
	}
}

// The raw route takes no slot of status/diff and ignores their backoff.
func TestFilesRawNotHeavy(t *testing.T) {
	gx := newGitFixture(t)
	png := string(colorImage(t, "png", color.White))
	writeFile(t, filepath.Join(gx.repo, "a.png"), png)
	gitT(t, gx.repo, "add", "a.png")
	f := registerFilesRoutes(http.NewServeMux(), &filesFakeMux{dir: gx.repo, files: true}, hostAllowlist{}, nil)
	root := filesRoot{Root: gx.repo, IsRepo: true}
	for i := 0; i < gitMaxRunning; i++ {
		f.git.sem <- struct{}{}
	}
	f.git.failedAt[gx.repo] = time.Now()
	b, err := f.gitBlob(context.Background(), root, ":0:a.png")
	if err != nil || string(b) != png {
		t.Errorf("gitBlob with a full semaphore and a backoff = %d bytes, %v", len(b), err)
	}
	if _, err := f.gitBlob(context.Background(), root, "HEAD:nope.png"); !errors.Is(err, errNoVersion) {
		t.Errorf("missing = %v", err)
	}
	if _, err := f.gitBlob(context.Background(), root, "HEAD"); !errors.Is(err, errNotImage) {
		t.Errorf("commit = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.gitBlob(ctx, root, ":0:a.png"); !errors.Is(err, errGitTimeout) {
		t.Errorf("request budget gone = %v, want a timeout", err)
	}
}

// What a broken or unexpected git answers.
func TestGitBlobOutput(t *testing.T) {
	requireUnixShell(t)
	f := &filesAPI{git: newGitRunner()}
	root := filesRoot{Root: t.TempDir()}
	for out, want := range map[string]string{
		`printf 'abc'`:                   "no header",
		`printf 'abc blob\n'`:            "unexpected header",
		`printf 'abc blob x\n'`:          "unexpected header",
		`printf 'abc blob 10\nshort'`:    "5 of 10 bytes",
		`printf 'abc blob 99999999\nxx'`: errImageTooLarge.msg,
		`printf ':0:a.png ambiguous\n'`:  errNoVersion.msg,
		`echo refused >&2; exit 128`:     "exit status 128",
		`printf 'abc blob 3\nabcdef'`:    "",
	} {
		f.git.bin = writeScript(t, "cat >/dev/null; "+out)
		f.git.filters = newTTLCache[[]string](filesRootTTL)
		b, err := f.gitBlob(context.Background(), root, ":0:a.png")
		if want == "" {
			if err != nil || string(b) != "abc" {
				t.Errorf("%s = %q, %v", out, b, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s = %v, want %q", out, err, want)
		}
	}
}

func TestFindChange(t *testing.T) {
	st := gitStatus{Entries: []changeEntry{
		{Path: "a", Unstaged: "M"},
		{Path: "b", Orig: "o", Staged: "R"},
		{Path: "c", Conflict: true},
	}}
	for _, c := range []struct {
		path, orig string
		staged     bool
		found      bool
	}{
		{"a", "", false, true}, {"a", "", true, false},
		{"b", "o", true, true}, {"b", "", true, false}, {"b", "o", false, false},
		{"c", "", false, true}, {"d", "", false, false},
	} {
		if e := findChange(st, c.path, c.orig, c.staged); (e != nil) != c.found || e != nil && e.Path != c.path {
			t.Errorf("findChange(%q, %q, %v) = %v", c.path, c.orig, c.staged, e)
		}
	}
}

// Conflicted image: only the worktree version.
func TestFilesRawConflict(t *testing.T) {
	gx := newGitFixture(t)
	r := gx.repo
	img := func(n uint8) string { return string(colorImage(t, "png", color.RGBA{n, 0, 0, 255})) }
	writeFile(t, filepath.Join(r, "c.png"), img(1))
	gitT(t, r, "add", "c.png")
	gitT(t, r, "commit", "-q", "-m", "base")
	gitT(t, r, "checkout", "-q", "-b", "other")
	writeFile(t, filepath.Join(r, "c.png"), img(2))
	gitT(t, r, "commit", "-q", "-am", "theirs")
	gitT(t, r, "checkout", "-q", "main")
	writeFile(t, filepath.Join(r, "c.png"), img(3))
	gitT(t, r, "commit", "-q", "-am", "ours")
	exec.Command("git", "-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "other").Run()
	if _, by := gx.changes(t); by["c.png"] == nil || by["c.png"]["conflict"] != true {
		t.Fatalf("no conflict: %v", by)
	}
	if code, key := rawCode(t, rawGet(gx.h, url.Values{"path": {"c.png"}, "side": {"old"}})); code != 404 || key != "no_version" {
		t.Errorf("conflict old = %d %q", code, key)
	}
	if rec := rawGet(gx.h, url.Values{"path": {"c.png"}, "side": {"new"}}); rec.Code != 200 || rec.Body.String() != img(3) {
		t.Errorf("conflict new = %d", rec.Code)
	}
}
