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
		if !strings.Contains(body, `<div class="brand"><svg class="mark"`) || !strings.Contains(body, brandOwlPath) {
			t.Errorf("%s: no mark beside the name", name)
		}
		// Both pages stay script-free (they load before any sign-in)
		if strings.Contains(body, "<script") {
			t.Errorf("%s: has a script", name)
		}
	}
}
