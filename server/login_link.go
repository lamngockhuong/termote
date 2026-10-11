package main

import (
	"html/template"
	"net/http"
	"strings"
	"time"
)

// A sign-in link lets `termote url --open` (and the panel's open key) open
// the app already signed in, so no password is typed into whatever answers
// on the port. The CLI asks for a single-use token (POST loginLinksRoute),
// writes it into a 0600 HTML file under its own 0700 dir, and opens that
// file: the file's form POSTs the token to loginLinkPath. The token is
// never in an argv, a URL, stdout or the browser's history.
//
// Only the CLI (Basic auth or the local socket) gets a token, never a
// session or a paired device: a stolen session cookie could otherwise keep
// renewing itself past its 24 hours.

const (
	loginLinksRoute = "/api/mux/login-links"
	loginLinkPath   = "/login/link"
	// loginLinkTTL is how long a token waits for its browser.
	loginLinkTTL = 30 * time.Second
	// maxLoginLinks caps the waiting tokens; the oldest goes first.
	maxLoginLinks = 5
	// maxLinkHash caps the deep link a token carries back to the app.
	maxLinkHash = 512
)

// newLoginLinkStore holds the waiting sign-in link tokens.
func newLoginLinkStore() *tokenStore {
	s := newTokenStore(loginLinkTTL, true)
	s.max = maxLoginLinks
	return s
}

// registerLoginLinkRoutes adds POST loginLinksRoute (sessions nil: sign-in is
// off, 501).
func registerLoginLinkRoutes(mux *http.ServeMux, sessions *sessionAuth) {
	mux.HandleFunc(loginLinksRoute, func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
			return
		}
		if sessions == nil {
			jsonErrorCode(w, "unsupported", "sign-in links need sign-in to be on", http.StatusNotImplemented)
			return
		}
		if a, _ := authFrom(r.Context()); !isCLI(a) {
			jsonErrorCode(w, errFullNeedsPass.code, "Only the CLI can make a sign-in link", errFullNeedsPass.status)
			return
		}
		token, err := sessions.links.generate()
		if err != nil {
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		jsonOK(w, map[string]any{"token": token, "expiresIn": int(loginLinkTTL.Seconds())})
	})
}

// isLinkHashChar reports a byte a deep link may hold: what
// encodeURIComponent leaves, its escapes, and the link's own separators.
func isLinkHashChar(ch byte) bool {
	return 'a' <= ch && ch <= 'z' || 'A' <= ch && ch <= 'Z' || '0' <= ch && ch <= '9' ||
		strings.IndexByte("-_.!~*'()%/?=&", ch) >= 0
}

// safeLinkHash returns h when it is a deep link the app can open (#, then
// only isLinkHashChar bytes, at most maxLinkHash), else "".
func safeLinkHash(h string) string {
	if len(h) < 2 || len(h) > maxLinkHash || h[0] != '#' {
		return ""
	}
	for i := 1; i < len(h); i++ {
		if !isLinkHashChar(h[i]) {
			return ""
		}
	}
	return h
}

// linkCrossSiteRejected reports a sign-in link POST another site made: the
// CLI's file is a file:// page, which browsers send as cross-site with
// Origin null; any other cross-site POST is refused. (writeGuard refuses an
// Origin off the allowlist other than null first.)
func linkCrossSiteRejected(r *http.Request) bool {
	return isCrossSiteLogin(r) && r.Header.Get("Origin") != "null"
}

// linkExpiredMsg is the sign-in form's line for a token that no longer works.
const linkExpiredMsg = "This sign-in link has expired. Sign in, or run the command again."

// linkDonePage takes the browser on to the app once the session cookie is
// set. Not a 303: that redirect would still belong to the cross-site
// navigation from the file, so the browser would not send the SameSite=Strict
// cookie just set and the app would ask for a sign-in. A refresh from this
// page is a same-site navigation. No script, so the CSP stays as it is.
var linkDonePage = template.Must(template.New("link").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url={{.}}">
<title>Termote</title>
` + brandHead + `
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #09090b; color: #fafafa; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  a { color: #fafafa; }
</style>
</head>
<body>
<p>Signed in. <a href="{{.}}">Continue</a></p>
</body>
</html>
`))

// writeLinkDonePage answers 200 with linkDonePage, going on to "/" + hash.
func writeLinkDonePage(w http.ResponseWriter, hash string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = linkDonePage.Execute(w, "/"+hash)
}
