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
// served index.html ('sha256-…'), so the policy allows exactly those scripts
// and no other inline code. The page is read once: a changed index.html
// (TERMOTE_PWA_DIR) needs a restart.
func inlineScriptHashes(files fs.FS) []string {
	b, err := fs.ReadFile(files, "index.html")
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

// securityHeaders sets the Content-Security-Policy on every response (the
// app page, the service worker and the highlighter worker each take theirs
// from their own response), with nosniff, no referrer and no framing.
func securityHeaders(files fs.FS, next http.Handler) http.Handler {
	scripts := inlineScriptHashes(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy(scripts, r.Host))
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}
