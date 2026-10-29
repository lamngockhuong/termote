package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
)

// inlineScriptRe matches an inline script without attributes: the theme
// script in index.html, which runs before the app to avoid a theme flash.
var inlineScriptRe = regexp.MustCompile(`(?s)<script>(.*?)</script>`)

// inlineScriptHashes returns the CSP source of each inline script in the
// served page name ('sha256-…'), so the policy allows exactly those scripts
// and no other inline code. The page is read once: a changed page
// (TERMOTE_PWA_DIR) needs a restart.
func inlineScriptHashes(files fs.FS, name string) []string {
	b, err := fs.ReadFile(files, name)
	if err != nil {
		return nil
	}
	var out []string
	for _, m := range inlineScriptRe.FindAllSubmatch(b, -1) {
		// The browser hashes the script with its line ends turned to LF: a
		// page checked out with CRLF (Windows) still matches.
		script := bytes.ReplaceAll(bytes.ReplaceAll(m[1], []byte("\r\n"), []byte("\n")), []byte("\r"), []byte("\n"))
		sum := sha256.Sum256(script)
		out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	return out
}

// policyHostRe is a Host a CSP source can name: a name or IPv4 address with
// an optional port. An IPv6 literal cannot be one, and nothing else (";",
// a space) may reach the header.
var policyHostRe = regexp.MustCompile(`^[A-Za-z0-9.-]+(:[0-9]+)?$`)

// contentSecurityPolicy is the policy for a request to host (already on the
// Host allowlist). The stream WebSocket is named by its scheme and host as
// well as by 'self', which older browsers do not match against ws:/wss:.
// Styles allow inline: xterm.js and React set style attributes, and xterm.js
// adds style elements. api.github.com is the update check.
func contentSecurityPolicy(scripts []string, host string) string {
	connect := "'self' https://api.github.com"
	if policyHostRe.MatchString(host) {
		connect = "'self' ws://" + host + " wss://" + host + " https://api.github.com"
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src " + strings.Join(append([]string{"'self'"}, scripts...), " "),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"connect-src " + connect,
		"worker-src 'self'",
		"manifest-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}, "; ")
}

// mermaidSandboxGlob names the page the PWA frames with
// sandbox="allow-scripts" to draw Mermaid diagrams: one inline script holding
// Pele, run in a worker from a blob: URL, named by its content
// (pwa/vite.config.ts).
const mermaidSandboxGlob = "assets/mermaid-sandbox-*.html"

// mermaidSandboxScripts returns the inline script hashes of each Mermaid
// sandbox page served, by its URL path.
func mermaidSandboxScripts(files fs.FS) map[string][]string {
	names, _ := fs.Glob(files, mermaidSandboxGlob)
	out := map[string][]string{}
	for _, name := range names {
		out["/"+name] = inlineScriptHashes(files, name)
	}
	return out
}

// sandboxPolicy is the Mermaid sandbox page's policy: its own inline script
// by hash and a blob: worker, nothing loaded or sent, framed only by a page
// of this origin, and sandboxed (an opaque origin) even when it is opened
// on its own, so a flaw in Pele a diagram exploits sends no cookie and reads
// nothing of the app.
func sandboxPolicy(scripts []string) string {
	script := "'none'"
	if len(scripts) > 0 {
		script = strings.Join(scripts, " ")
	}
	return strings.Join([]string{
		"default-src 'none'",
		"script-src " + script,
		"worker-src blob:",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'self'",
		"sandbox allow-scripts",
	}, "; ")
}

// securityHeaders sets the Content-Security-Policy on every response (the
// app page, the service worker and the highlighter worker each take theirs
// from their own response), with nosniff, no referrer and no framing; the
// Mermaid sandbox page gets its own policy and may be framed by this origin.
func securityHeaders(files fs.FS, next http.Handler) http.Handler {
	scripts := inlineScriptHashes(files, "index.html")
	sandboxes := mermaidSandboxScripts(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		if sandboxScripts, ok := sandboxes[r.URL.Path]; ok {
			h.Set("Content-Security-Policy", sandboxPolicy(sandboxScripts))
			h.Set("X-Frame-Options", "SAMEORIGIN")
		} else {
			h.Set("Content-Security-Policy", contentSecurityPolicy(scripts, r.Host))
			h.Set("X-Frame-Options", "DENY")
		}
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// permissionsPolicy turns off the device features the app never uses, so a
// script that ever ran in a Termote page could not ask for them. Clipboard
// access stays allowed: paste and copy on select read and write it.
const permissionsPolicy = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), display-capture=()"

// isolationHeaders sets the headers that do not depend on the Host on every
// response, a refusal of hostGuard included, so it wraps hostGuard: no other
// site keeps a reference to a Termote window it opened (COOP), reads any
// response as a resource of its own (CORP), or reaches a device feature
// through a Termote page.
func isolationHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", permissionsPolicy)
		next.ServeHTTP(w, r)
	})
}
