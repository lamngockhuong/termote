package main

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

func scriptHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}

func TestInlineScriptHashes(t *testing.T) {
	theme := "\n      (function() { document.documentElement.classList.add('dark') })();\n    "
	page := `<head><script>` + theme + `</script>` +
		`<script type="module" crossorigin src="/assets/index.js"></script></head>`
	got := inlineScriptHashes(fstest.MapFS{"index.html": {Data: []byte(page)}})
	// Only the script without attributes, hashed byte for byte.
	if len(got) != 1 || got[0] != scriptHash(theme) {
		t.Errorf("hashes = %v, want [%s]", got, scriptHash(theme))
	}
	// Several scripts; CRLF line ends hash as the browser sees them, LF.
	crlf := "<script>a()\r\nb()</script><script>c()\rd()</script>"
	if got := inlineScriptHashes(fstest.MapFS{"index.html": {Data: []byte(crlf)}}); len(got) != 2 || got[0] != scriptHash("a()\nb()") || got[1] != scriptHash("c()\nd()") {
		t.Errorf("CRLF hashes = %v", got)
	}
	if got := inlineScriptHashes(fstest.MapFS{}); got != nil {
		t.Errorf("no index.html: %v", got)
	}
}

func TestContentSecurityPolicy(t *testing.T) {
	csp := contentSecurityPolicy([]string{"'sha256-x'"}, "box.local:7680")
	for _, want := range []string{
		"default-src 'self'",
		"script-src 'self' 'sha256-x';",
		"style-src 'self' 'unsafe-inline'",
		// blob: is an image the page fetched itself (files/raw); data: a
		// thumbnail drawn on a canvas.
		"img-src 'self' data: blob:;",
		"connect-src 'self' ws://box.local:7680 wss://box.local:7680 https://api.github.com;",
		"worker-src 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("policy lacks %q: %s", want, csp)
		}
	}
	// The server, not the page, talks to push services.
	for host := range pushHosts {
		if strings.Contains(csp, host) {
			t.Errorf("policy names the push service %s: %s", host, csp)
		}
	}
	// A Host that cannot be a source adds none, and never reaches the header.
	for _, host := range []string{"localhost:7680;sandbox", "[fe80::1]:7680", "a b", "box:port"} {
		if got := contentSecurityPolicy(nil, host); strings.Contains(got, "ws://") || strings.Contains(got, "sandbox") {
			t.Errorf("Host %q: %s", host, got)
		}
	}
	if got := contentSecurityPolicy(nil, ""); !strings.Contains(got, "script-src 'self';") || !strings.Contains(got, "connect-src 'self' https://api.github.com;") {
		t.Errorf("no scripts, no host: %s", got)
	}
}

// Every response the server answers for an allowed Host carries the
// headers: the app page (with its inline script's hash), a 401, an API reply.
func TestServeSecurityHeaders(t *testing.T) {
	cfg := testConfig(t)
	theme := "document.documentElement.classList.add('dark')"
	if err := os.WriteFile(cfg.PWADir+"/index.html", []byte("<script>"+theme+"</script>"), 0o644); err != nil {
		t.Fatal(err)
	}
	h, err := newServeHandler(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	for path, auth := range map[string]bool{"/": true, "/some/route": true, "/api/mux/health": true, "/sw.js": false, "/private": false} {
		req := httptest.NewRequest("GET", "http://localhost:7680"+path, nil)
		req.Host = "localhost:7680"
		if auth {
			req.SetBasicAuth(cfg.User, cfg.Pass)
		}
		rec := serve(h, req)
		hd := rec.Header()
		csp := hd.Get("Content-Security-Policy")
		if !strings.Contains(csp, "script-src 'self' "+scriptHash(theme)+";") || !strings.Contains(csp, "ws://localhost:7680") {
			t.Errorf("GET %s (%d): Content-Security-Policy = %q", path, rec.Code, csp)
		}
		if hd.Get("X-Content-Type-Options") != "nosniff" || hd.Get("Referrer-Policy") != "no-referrer" || hd.Get("X-Frame-Options") != "DENY" {
			t.Errorf("GET %s (%d): headers = %v", path, rec.Code, hd)
		}
	}
	// A Host off the allowlist is refused before the policy would name it.
	req := httptest.NewRequest("GET", "http://evil.example/", nil)
	req.Host = "evil.example"
	if rec := serve(h, req); rec.Code != http.StatusForbidden || strings.Contains(rec.Header().Get("Content-Security-Policy"), "evil.example") {
		t.Errorf("foreign Host = %d %q", rec.Code, rec.Header().Get("Content-Security-Policy"))
	}
}
