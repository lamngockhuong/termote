package main

import (
	"bytes"
	"errors"
	"image"
	"image/color/palette"
	"image/gif"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// pastedName is the name an image pasted at fixedImageTime gets
const pastedName = "pasted-20261027-090507"

// fixedImageTime names pasted images for one moment, until the test ends.
func fixedImageTime(t *testing.T) {
	t.Helper()
	imageNow = func() time.Time { return time.Date(2026, 10, 27, 9, 5, 7, 0, time.Local) }
	t.Cleanup(func() { imageNow = time.Now })
}

func imageRequest(root string, q url.Values, body io.Reader, contentType string) *http.Request {
	if q == nil {
		q = url.Values{}
	}
	if root != "" {
		q.Set("root", root)
	}
	req := apiRequest("POST", "/api/mux/panes/0/files/image?"+q.Encode(), "")
	req.Body = io.NopCloser(body)
	req.ContentLength = -1
	if b, ok := body.(*bytes.Reader); ok {
		req.ContentLength = int64(b.Len())
	}
	req.Header.Set("Content-Type", contentType)
	return req
}

// pasteImage sends a PNG into dir through fx's server.
func (fx *filesFixture) pasteImage(t *testing.T, q url.Values, body []byte, contentType string) (int, map[string]any) {
	t.Helper()
	rec := serve(fx.h, imageRequest(fx.root, q, bytes.NewReader(body), contentType))
	return rec.Code, decodeBody(t, rec)
}

func dirQuery(dir string) url.Values { return url.Values{"dir": {dir}} }

func TestFilesImageEachType(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	for _, mt := range []string{"image/png", "image/jpeg", "image/gif", "image/webp"} {
		img := testImage(t, mt)
		code, body := fx.pasteImage(t, dirQuery("."), img, mt)
		want := pastedName + "." + uploadExts[mt]
		if code != http.StatusCreated || body["root"] != fx.root || body["path"] != want || len(body) != 2 {
			t.Fatalf("%s = %d %v", mt, code, body)
		}
		if got, _ := os.ReadFile(filepath.Join(fx.root, want)); !bytes.Equal(got, img) {
			t.Errorf("%s: file holds %d bytes, want %d", mt, len(got), len(img))
		}
	}
}

func TestFilesImageWhere(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	img := testImage(t, "image/png")
	// Next to the Markdown file, in its directory
	if code, body := fx.pasteImage(t, dirQuery("sub"), img, "image/png"); code != http.StatusCreated || body["path"] != "sub/"+pastedName+".png" {
		t.Fatalf("sub = %d %v", code, body)
	}
	// In its assets/ directory, once there is one
	if err := os.Mkdir(filepath.Join(fx.root, "sub", "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if code, body := fx.pasteImage(t, dirQuery("sub"), img, "image/png"); code != http.StatusCreated || body["path"] != "sub/assets/"+pastedName+".png" {
		t.Fatalf("assets = %d %v", code, body)
	}
	// An assets file is no directory: next to the Markdown file again
	writeFile(t, filepath.Join(fx.root, "assets"), "x")
	if code, body := fx.pasteImage(t, dirQuery("."), img, "image/png"); code != http.StatusCreated || body["path"] != pastedName+".png" {
		t.Fatalf("assets file = %d %v", code, body)
	}
	// A directory that is not there is made by nobody
	if code, body := fx.pasteImage(t, dirQuery("nope"), img, "image/png"); code != http.StatusNotFound || body["code"] != "not_found" {
		t.Errorf("missing dir = %d %v", code, body)
	}
	notExist(t, filepath.Join(fx.root, "nope"))
}

func TestFilesImageNeverReplaces(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	img := testImage(t, "image/png")
	writeFile(t, filepath.Join(fx.root, pastedName+".png"), "mine")
	code, body := fx.pasteImage(t, dirQuery("."), img, "image/png")
	if code != http.StatusCreated || body["path"] != pastedName+"-2.png" {
		t.Fatalf("taken = %d %v", code, body)
	}
	if readText(t, filepath.Join(fx.root, pastedName+".png")) != "mine" {
		t.Error("the file there was replaced")
	}
	for i := 3; i <= imageMaxSuffix; i++ {
		writeFile(t, filepath.Join(fx.root, pastedName+"-"+strconv.Itoa(i)+".png"), "")
	}
	if code, body := fx.pasteImage(t, dirQuery("."), img, "image/png"); code != http.StatusConflict || body["code"] != "exists" {
		t.Errorf("all taken = %d %v", code, body)
	}
}

func TestFilesImageRejects(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	png := testImage(t, "image/png")
	cases := map[string]struct {
		q          url.Values
		body       []byte
		ct         string
		code       int
		key        string
		noFileHere string
	}{
		"another type than said":   {dirQuery("."), testImage(t, "image/jpeg"), "image/png", 415, "unsupported_image", "."},
		"empty":                    {dirQuery("."), nil, "image/png", 415, "unsupported_image", "."},
		"not an image":             {dirQuery("."), []byte("hello"), "image/png", 415, "unsupported_image", "."},
		"a broken PNG":             {dirQuery("."), pngHeader(4, 4)[:20], "image/png", 415, "unsupported_image", "."},
		"over 40 megapixels":       {dirQuery("."), pngHeader(8000, 6000), "image/png", 413, "too_many_pixels", "."},
		"multipart":                {dirQuery("."), png, "multipart/form-data; boundary=x", 415, "unsupported_image", "."},
		"bmp":                      {dirQuery("."), png, "image/bmp", 415, "unsupported_image", "."},
		"svg":                      {dirQuery("."), []byte("<svg/>"), "image/svg+xml", 415, "unsupported_image", "."},
		"text":                     {dirQuery("."), png, "text/plain", 415, "unsupported_image", "."},
		"no type":                  {dirQuery("."), png, "", 415, "unsupported_image", "."},
		"no dir":                   {nil, png, "image/png", 400, "invalid_name", "."},
		"up":                       {dirQuery(".."), png, "image/png", 400, "invalid_name", "."},
		"absolute":                 {dirQuery("/etc"), png, "image/png", 400, "invalid_name", "."},
		"doubled slash":            {dirQuery("sub//x"), png, "image/png", 400, "invalid_name", "."},
		"backslash":                {dirQuery(`sub\x`), png, "image/png", 400, "invalid_name", "."},
		"out and back":             {dirQuery("sub/../.."), png, "image/png", 400, "invalid_name", "."},
		"the git dir":              {dirQuery(".git"), png, "image/png", 403, "not_allowed", ".git"},
		"a deny dir":               {dirQuery("cfg"), png, "image/png", 403, "not_allowed", "cfg"},
		"sensitive without reveal": {dirQuery(".ssh"), png, "image/png", 403, "sensitive", ".ssh"},
	}
	if err := os.Mkdir(filepath.Join(fx.root, ".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, tc := range cases {
		rec := serve(fx.h, imageRequest(fx.root, tc.q, bytes.NewReader(tc.body), tc.ct))
		if code, key := rawCode(t, rec); code != tc.code || key != tc.key {
			t.Errorf("%s = %d %q, want %d %q", name, code, key, tc.code, tc.key)
		}
		notExist(t, filepath.Join(fx.root, tc.noFileHere, pastedName+".png"))
	}
	// Shown on purpose: written there
	q := dirQuery(".ssh")
	q.Set("reveal", "1")
	if code, body := fx.pasteImage(t, q, png, "image/png"); code != http.StatusCreated || body["path"] != ".ssh/"+pastedName+".png" {
		t.Errorf("revealed = %d %v", code, body)
	}
}

func TestFilesImageRootAndGuards(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	png := testImage(t, "image/png")
	// The root is required, and must still be the pane's
	for root, want := range map[string]int{"": 400, "/elsewhere": 409} {
		req := imageRequest("", dirQuery("."), bytes.NewReader(png), "image/png")
		if root != "" {
			req = imageRequest(root, dirQuery("."), bytes.NewReader(png), "image/png")
		}
		if rec := serve(fx.h, req); rec.Code != want {
			t.Errorf("root %q = %d %s", root, rec.Code, rec.Body.String())
		}
	}
	// Another site, and another method
	cross := imageRequest(fx.root, dirQuery("."), bytes.NewReader(png), "image/png")
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(fx.h, cross); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
	get := imageRequest(fx.root, dirQuery("."), bytes.NewReader(nil), "image/png")
	get.Method = http.MethodPut
	if rec := serve(fx.h, get); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("PUT = %d", rec.Code)
	}
	notExist(t, filepath.Join(fx.root, pastedName+".png"))
	// Without writeGuard in front, the handler still refuses another site
	mux := http.NewServeMux()
	registerFilesRoutes(mux, &filesFakeMux{dir: fx.root, files: true}, hostAllowlist{}, nil)
	cross = imageRequest(fx.root, dirQuery("."), bytes.NewReader(png), "image/png")
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(mux, cross); rec.Code != http.StatusForbidden {
		t.Errorf("route cross-site = %d", rec.Code)
	}
	notExist(t, filepath.Join(fx.root, pastedName+".png"))
}

// noisyGIF is a GIF of random pixels, far longer than the first bytes a
// type is read from
func noisyGIF(t *testing.T) []byte {
	t.Helper()
	img := image.NewPaletted(image.Rect(0, 0, 200, 200), palette.Plan9)
	r := rand.New(rand.NewPCG(1, 2))
	for i := range img.Pix {
		img.Pix[i] = uint8(r.IntN(len(palette.Plan9)))
	}
	var b bytes.Buffer
	if err := gif.Encode(&b, img, nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// failAfter gives its bytes, then fails, and tells whether it was read
type failAfter struct {
	r    io.Reader
	err  error
	read bool
}

func (f *failAfter) Read(p []byte) (int, error) {
	f.read = true
	n, err := f.r.Read(p)
	if err == io.EOF {
		return n, f.err
	}
	return n, err
}

func TestFilesImageTooLarge(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	// Said too large: refused unread
	body := &failAfter{r: bytes.NewReader(testImage(t, "image/png")), err: io.EOF}
	req := imageRequest(fx.root, dirQuery("."), body, "image/png")
	req.ContentLength = uploadMaxFile + 1
	if code, key := rawCode(t, serve(fx.h, req)); code != 413 || key != "too_large" || body.read {
		t.Errorf("Content-Length = %d %q, read %v", code, key, body.read)
	}
	// Not said, found too large as it is written: nothing left
	big := append(testImage(t, "image/png"), make([]byte, uploadMaxFile)...)
	req = imageRequest(fx.root, dirQuery("."), io.MultiReader(bytes.NewReader(big)), "image/png")
	if code, key := rawCode(t, serve(fx.h, req)); code != 413 || key != "too_large" {
		t.Errorf("long body = %d %q", code, key)
	}
	notExist(t, filepath.Join(fx.root, pastedName+".png"))
}

func TestFilesImageBodyFails(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	cut := errors.New("connection reset")
	for _, tc := range []struct {
		name, mt string
		body     []byte
	}{
		// In the first bytes, before anything is made
		{"head", "image/png", testImage(t, "image/png")[:100]},
		// After the checks, while the rest is written
		{"rest", "image/png", append(testImage(t, "image/png"), make([]byte, 4096)...)},
		// While a GIF's frames are counted, past its first bytes
		{"frames", "image/gif", noisyGIF(t)[:2000]},
		// While a JPEG's header is read, past its first bytes: a long APP1
		{"header", "image/jpeg", append([]byte{0xff, 0xd8, 0xff, 0xe1, 0x10, 0x00}, make([]byte, 994)...)},
	} {
		body := &failAfter{r: bytes.NewReader(tc.body), err: cut}
		rec := serve(fx.h, imageRequest(fx.root, dirQuery("."), body, tc.mt))
		if rec.Code < 400 {
			t.Errorf("%s = %d", tc.name, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "connection reset") {
			t.Errorf("%s: the error's text reached the client: %s", tc.name, rec.Body.String())
		}
		notExist(t, filepath.Join(fx.root, pastedName+"."+uploadExts[tc.mt]))
	}
}

// once fails one read, then ends, as an HTTP body cut short does: the error
// is not there to see again
type once struct {
	r      io.Reader
	failed bool
}

func (o *once) Read(p []byte) (int, error) {
	n, err := o.r.Read(p)
	if err == io.EOF && !o.failed {
		o.failed = true
		return n, io.ErrUnexpectedEOF
	}
	return n, err
}

// A GIF cut short while its frames are counted, the error seen once (the
// count takes it for the file's end): still refused, nothing left
func TestFilesImageCutOnce(t *testing.T) {
	fixedImageTime(t)
	fx := newFilesFixture(t)
	body := &once{r: bytes.NewReader(noisyGIF(t)[:2000])}
	rec := serve(fx.h, imageRequest(fx.root, dirQuery("."), body, "image/gif"))
	if rec.Code < 400 {
		t.Errorf("cut GIF = %d %s", rec.Code, rec.Body.String())
	}
	notExist(t, filepath.Join(fx.root, pastedName+".gif"))
}

func TestWriteErrorKeepsTheFirst(t *testing.T) {
	w := &writeError{w: failWriter{}}
	_, first := w.Write([]byte("a"))
	if first == nil {
		t.Fatal("the write went through")
	}
	w.w = io.Discard
	w.Write([]byte("b"))
	if w.err != first {
		t.Errorf("kept %v, want the first error", w.err)
	}
	ok := &writeError{w: io.Discard}
	ok.Write([]byte("c"))
	if ok.err != nil {
		t.Errorf("a write that went through kept %v", ok.err)
	}
}

func TestFilesImageBusy(t *testing.T) {
	fixedImageTime(t)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	mux := http.NewServeMux()
	f := registerFilesRoutes(mux, &filesFakeMux{dir: dir, files: true}, hostAllowlist{}, nil)
	for i := 0; i < writeMaxRunning; i++ {
		f.writeSlots <- struct{}{}
	}
	body := &failAfter{r: bytes.NewReader(testImage(t, "image/png")), err: io.EOF}
	req := imageRequest(dir, dirQuery("."), body, "image/png")
	req.Header.Del("Origin")
	if code, key := rawCode(t, serve(mux, req)); code != 429 || key != "busy" || body.read {
		t.Errorf("busy = %d %q, read %v", code, key, body.read)
	}
	<-f.writeSlots
	req = imageRequest(dir, dirQuery("."), bytes.NewReader(testImage(t, "image/png")), "image/png")
	req.Header.Del("Origin")
	if rec := serve(mux, req); rec.Code != http.StatusCreated {
		t.Errorf("free slot = %d %s", rec.Code, rec.Body.String())
	}
	if len(f.writeSlots) != writeMaxRunning-1 {
		t.Errorf("slots held = %d", len(f.writeSlots))
	}
}

func TestIsFilesImagePath(t *testing.T) {
	for p, want := range map[string]bool{
		"/api/mux/panes/%1/files/image":      true,
		"/api/mux/panes/0/files/image":       true,
		"/api/mux/panes/0/files/image/":      false,
		"/api/mux/panes/0/files/images":      false,
		"/api/mux/panes/a/b/files/image":     false,
		"/x/api/mux/panes/0/files/image":     false,
		"/api/mux/panes//files/image":        false,
		"/api/mux/panes/0/files/image?x=1":   false,
		"/api/mux/panes/0/files/content":     false,
		"/api/mux/panes/0/files/image\n":     false,
		"/api/mux/panes/0/files/image/extra": false,
	} {
		if got := isFilesImagePath(p); got != want {
			t.Errorf("%q = %v, want %v", p, got, want)
		}
	}
}

// writeGuard takes an image body on files/image only: the save route still
// wants JSON, and says so without an upload's code
func TestWriteGuardImageOnFilesImageOnly(t *testing.T) {
	fx := newFilesFixture(t)
	req := apiRequest("PUT", "/api/mux/panes/0/files/content?root="+url.QueryEscape(fx.root), "\x89PNG")
	req.Header.Set("Content-Type", "image/png")
	rec := serve(fx.h, req)
	if rec.Code != http.StatusUnsupportedMediaType || strings.Contains(rec.Body.String(), "unsupported_image") {
		t.Errorf("content with an image = %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = imageRequest(fx.root, dirQuery("."), bytes.NewReader(nil), "image/png")
	req.URL.Path += "/"
	fx.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType || strings.Contains(rec.Body.String(), "unsupported_image") {
		t.Errorf("image/ = %d %s", rec.Code, rec.Body.String())
	}
}

// A root gone from the disk since the request found it: nothing opened
func TestFilesImageRootGone(t *testing.T) {
	f := &filesAPI{}
	gone := filepath.Join(t.TempDir(), "gone")
	if _, _, _, err := f.openImage(filesRoot{Root: gone}, ".", "png", false); err == nil {
		t.Error("opened an image under a root that is not there")
	}
}
