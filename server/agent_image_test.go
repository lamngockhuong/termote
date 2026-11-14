package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func testPNG(t *testing.T, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, c)
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// imageRow is a Claude Code user row with text and the given image blocks.
func imageRow(uuid string, blocks ...string) string {
	content := append([]string{`{"type":"text","text":"[Image #1] look"}`}, blocks...)
	return fmt.Sprintf(`{"type":"user","uuid":%q,"timestamp":"2026-11-14T00:00:00Z","message":{"role":"user","content":[%s]}}`+"\n",
		uuid, strings.Join(content, ","))
}

func imageBlock(mediaType string, data []byte) string {
	return fmt.Sprintf(`{"type":"image","source":{"type":"base64","media_type":%q,"data":%q}}`, mediaType, base64.StdEncoding.EncodeToString(data))
}

func getTranscriptRes(t *testing.T, mux http.Handler) transcriptResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/transcript", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("transcript = %d %s", rec.Code, rec.Body)
	}
	var res transcriptResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func imageRefs(res transcriptResponse) []string {
	var refs []string
	for _, e := range res.Entries {
		for _, p := range e.Parts {
			if p.Kind == "image" {
				refs = append(refs, p.Image)
			}
		}
	}
	return refs
}

func getImage(mux http.Handler, src string, edit func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/mux/panes/p1/agent/image?src="+url.QueryEscape(src), nil)
	if edit != nil {
		edit(req)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestAgentImageServesTranscriptImages(t *testing.T) {
	red, blue := testPNG(t, color.RGBA{255, 0, 0, 255}), testPNG(t, color.RGBA{0, 0, 255, 255})
	dir := t.TempDir()
	// A row longer than the transcript reader's line buffer still lists
	// its images: the reader clips the base64, the route reads it whole.
	big := bytes.Repeat([]byte{0}, agentMaxLine)
	big = append(append([]byte{}, red...), big...)
	writeTranscript(t, dir, testSessionID,
		imageRow("u1", imageBlock("image/png", red), imageBlock("image/png", blue))+
			imageRow("u2", imageBlock("image/png", big)))
	mux, _ := subagentsServer(t, claudeSession(dir))

	refs := imageRefs(getTranscriptRes(t, mux))
	if len(refs) != 3 || refs[0] == "" || refs[1] == "" || refs[2] == "" {
		t.Fatalf("refs = %q", refs)
	}
	for i, want := range [][]byte{red, blue, big} {
		rec := getImage(mux, refs[i], nil)
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), want) {
			t.Fatalf("image %d = %d (%d bytes)", i, rec.Code, rec.Body.Len())
		}
		h := rec.Header()
		if h.Get("Content-Type") != "image/png" || h.Get("X-Content-Type-Options") != "nosniff" ||
			!strings.Contains(h.Get("Content-Security-Policy"), "sandbox") || !strings.HasPrefix(h.Get("Cache-Control"), "private") {
			t.Errorf("image %d headers = %v", i, h)
		}
	}

	// A view-only client sees the conversation, its images included.
	rec := getImage(mux, refs[0], func(r *http.Request) {
		*r = *r.WithContext(withAuth(r.Context(), authInfo{Kind: authDevice, Role: roleView, DeviceID: "d"}))
	})
	if rec.Code != http.StatusOK {
		t.Errorf("view-only = %d", rec.Code)
	}
	if rec := getImage(mux, refs[0], func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site = %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/mux/panes/p1/agent/image?src="+url.QueryEscape(refs[0]), nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d", rec.Code)
	}
}

func TestAgentImageRefusesForgedOrStaleRefs(t *testing.T) {
	png := testPNG(t, color.Black)
	dir := t.TempDir()
	p := writeTranscript(t, dir, testSessionID, imageRow("u1", imageBlock("image/png", png)))
	mux, _ := subagentsServer(t, claudeSession(dir))
	refs := imageRefs(getTranscriptRes(t, mux))
	if len(refs) != 1 {
		t.Fatalf("refs = %q", refs)
	}
	ref, ok := decodeImageRef(refs[0])
	if !ok {
		t.Fatal("ref does not decode")
	}

	// A cursor is signed with the same key but never passes for an image.
	cursor := encodeCursor(agentCursor{Session: ref.Session, Offset: ref.Offset, File: ref.File})
	unsigned := base64.RawURLEncoding.EncodeToString([]byte(`{"s":"`+ref.Session+`","f":"`+ref.File+`","o":0,"n":0}`)) + ".AAAA"
	for name, src := range map[string]string{
		"empty":          "",
		"junk":           "nope",
		"cursor":         cursor,
		"unsigned":       unsigned,
		"other session":  encodeImageRef(agentImageRef{Session: "00000000-0000-4000-8000-000000000000", File: ref.File, N: 0}),
		"other file":     encodeImageRef(agentImageRef{Session: ref.Session, File: "other", N: 0}),
		"not line start": encodeImageRef(agentImageRef{Session: ref.Session, File: ref.File, Offset: 5, N: 0}),
		"past end":       encodeImageRef(agentImageRef{Session: ref.Session, File: ref.File, Offset: 1 << 30, N: 0}),
		"no such image":  encodeImageRef(agentImageRef{Session: ref.Session, File: ref.File, N: 1}),
	} {
		if rec := getImage(mux, src, nil); rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"not_found"`) {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body)
		}
	}

	// The transcript replaced by another file of the same name (written
	// before the rename, so it cannot reuse the old inode)
	if err := os.WriteFile(p+".new", []byte(imageRow("u1", imageBlock("image/png", png))), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(p+".new", p); err != nil {
		t.Fatal(err)
	}
	if rec := getImage(mux, refs[0], nil); rec.Code != http.StatusNotFound && fileIdentityKnown() {
		t.Errorf("replaced file = %d", rec.Code)
	}
}

// fileIdentityKnown: the platform names a file by device and inode, so a
// file replaced under the same name is another one.
func fileIdentityKnown() bool {
	fi, err := os.Stat(os.TempDir())
	return err == nil && fileIdentity(fi) != ""
}

func TestClaudeImageAcceptsOnlyRealImages(t *testing.T) {
	png := testPNG(t, color.White)
	html := []byte("<html><script>alert(1)</script></html>")
	for name, tc := range map[string]struct {
		line string
		n    int
		ok   bool
	}{
		"png":                   {imageRow("u", imageBlock("image/png", png)), 0, true},
		"no media type":         {imageRow("u", `{"type":"image","source":{"type":"base64","data":"`+base64.StdEncoding.EncodeToString(png)+`"}}`), 0, true},
		"html as png":           {imageRow("u", imageBlock("image/png", html)), 0, false},
		"png named jpeg":        {imageRow("u", imageBlock("image/jpeg", png)), 0, false},
		"svg":                   {imageRow("u", imageBlock("image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))), 0, false},
		"url source":            {imageRow("u", `{"type":"image","source":{"type":"url","url":"http://example.com/a.png"}}`), 0, false},
		"bad base64":            {imageRow("u", `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"!!"}}`), 0, false},
		"second of one":         {imageRow("u", imageBlock("image/png", png)), 1, false},
		"string content":        {`{"type":"user","message":{"role":"user","content":"hi"}}`, 0, false},
		"not json":              {"{", 0, false},
		"image after non-image": {imageRow("u", `{"type":"text","text":"x"}`, imageBlock("image/png", png)), 0, true},
	} {
		mt, data, ok := claudeJournal{}.Image([]byte(tc.line), tc.n)
		if ok != tc.ok || (ok && (mt != "image/png" || !bytes.Equal(data, png))) {
			t.Errorf("%s = %q %d bytes %v", name, mt, len(data), ok)
		}
	}
}
