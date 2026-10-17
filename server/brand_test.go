package main

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The inline symbol must stay the brand source's, not drift into a redraw.
func TestBrandOwlPathMatchesSource(t *testing.T) {
	src, err := os.ReadFile("../assets/branding/termote/logo/symbol-knockout.svg")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(` d="([^"]+)"`).FindSubmatch(src)
	if m == nil || string(m[1]) != brandOwlPath {
		t.Fatalf("brandOwlPath differs from symbol-knockout.svg")
	}
}

func TestBrandOnServerPages(t *testing.T) {
	pages := map[string]func(http.ResponseWriter){
		"login":         func(w http.ResponseWriter) { writeLoginPage(w, 401, loginForm{Next: "/"}) },
		"pair":          func(w http.ResponseWriter) { writePairPage(w, 200, pairForm{}) },
		"pair (closed)": func(w http.ResponseWriter) { writePairPage(w, 409, pairForm{Closed: true, Error: "x"}) },
	}
	favicon := regexp.MustCompile(`<link rel="icon" type="image/svg\+xml" href="data:image/svg\+xml;base64,([A-Za-z0-9+/=]+)">`)
	for name, write := range pages {
		rec := httptest.NewRecorder()
		write(rec)
		body := rec.Body.String()
		m := favicon.FindStringSubmatch(body)
		if m == nil {
			t.Errorf("%s: no inline favicon", name)
			continue
		}
		svg, err := base64.StdEncoding.DecodeString(m[1])
		if err != nil || !strings.Contains(string(svg), brandOwlPath) {
			t.Errorf("%s: favicon is not the owl: %v", name, err)
		}
		if !strings.Contains(body, `<div class="brand"><svg class="mark"`) || !strings.Contains(body, brandMark) {
			t.Errorf("%s: no mark beside the name", name)
		}
		// One mask per page, so its fixed id stays unique
		if n := strings.Count(body, `id="owl-eyes-mask"`); n != 1 {
			t.Errorf("%s: %d eye masks, want 1", name, n)
		}
		if !strings.Contains(body, "prefers-reduced-motion") {
			t.Errorf("%s: the blink ignores reduced motion", name)
		}
		// Both pages stay script-free (they load before any sign-in)
		if strings.Contains(body, "<script") {
			t.Errorf("%s: has a script", name)
		}
	}
}

// The blinking mark is the source path cut in two, not a redraw: the face
// with the beak keeps the outline, the eyes go through the mask.
func TestBrandMarkSplitsTheSource(t *testing.T) {
	parts := strings.SplitAfter(brandOwlPath, "Z")
	if len(parts) != 5 || parts[4] != "" {
		t.Fatalf("brandOwlPath has %d subpaths, want face, two eyes and the beak", len(parts)-1)
	}
	if brandOwlFace != parts[0]+parts[3] || brandOwlEyes != parts[1]+parts[2] {
		t.Fatalf("face %q, eyes %q", brandOwlFace, brandOwlEyes)
	}
	for _, want := range []string{
		`<path class="owl-eyes" fill="#000" d="` + brandOwlEyes + `"/>`,
		`d="` + brandOwlFace + `" mask="url(#owl-eyes-mask)"`,
	} {
		if !strings.Contains(brandMark, want) {
			t.Errorf("brandMark lacks %s", want)
		}
	}
}
