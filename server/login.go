package main

import (
	"html/template"
	"mime"
	"net/http"
	"net/url"
	"strings"
)

// loginPath serves a sign-in form and takes its POST. An iOS home-screen web
// app never shows the Basic auth prompt, it renders the 401 body instead, and
// keeps cookies apart from Safari: without a form, such an app could not log
// in again once its session ended (24h, or a server restart).
const loginPath = "/login"

// logoutPath ends the session of the cookie it carries, on the server too:
// clearing the cookie in the browser alone would leave a copied one valid
// for the rest of its 24 hours. A JSON write under /api/, so writeGuard
// refuses it from another site.
const logoutPath = "/api/mux/logout"

// maxLoginBody bounds the form POST: a username, a password and a path.
const maxLoginBody = 8 << 10

var loginPage = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#09090b">
<title>Termote — Sign in</title>
<style>
  :root { color-scheme: dark; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
    background: #09090b; color: #fafafa;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  form { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 12px; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: #a1a1aa; }
  input {
    font: inherit; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #3f3f46; background: #18181b; color: #fafafa;
  }
  input:focus { outline: 2px solid #71717a; outline-offset: 1px; }
  button {
    font: inherit; font-weight: 600; margin-top: 4px; padding: 10px 12px; border: 0;
    border-radius: 8px; background: #fafafa; color: #09090b;
  }
  .error { margin: 0; padding: 8px 12px; border-radius: 8px; background: #450a0a; color: #fecaca; font-size: 14px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Termote</h1>
  {{if .Error}}<p class="error" role="alert">{{.Error}}</p>{{end}}
  <label>Username
    <input name="username" value="{{.Username}}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required{{if not .Username}} autofocus{{end}}>
  </label>
  <label>Password
    <input name="password" type="password" autocomplete="current-password" required{{if .Username}} autofocus{{end}}>
  </label>
  <input type="hidden" name="next" value="{{.Next}}">
  <button type="submit">Sign in</button>
</form>
</body>
</html>
`))

// loginForm is what the sign-in page shows: where to go back to, an optional
// error line, and the username of a failed attempt so only the password is
// typed again (the password is never sent back).
type loginForm struct{ Next, Error, Username string }

// writeLoginPage answers with the sign-in form and status code.
func writeLoginPage(w http.ResponseWriter, code int, f loginForm) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(code)
	_ = loginPage.Execute(w, f)
}

// isNavigation reports whether r loads a page (the 401 body is then shown to
// a person) rather than a fetch from the PWA or a script.
func isNavigation(r *http.Request) bool {
	if r.Method != http.MethodGet || strings.HasPrefix(r.URL.Path, "/api/") {
		return false
	}
	if mode := r.Header.Get("Sec-Fetch-Mode"); mode != "" {
		return mode == "navigate"
	}
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

// safeNext returns p when it is a path on this server to go back to after
// signing in, else "/": never another host ("//evil", "/\evil"), a scheme,
// or the sign-in page itself.
func safeNext(p string) string {
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.ContainsAny(p, "\\\x00\r\n\t") {
		return "/"
	}
	u, err := url.Parse(p)
	if err != nil || u.Scheme != "" || u.Host != "" || u.Path == loginPath {
		return "/"
	}
	return p
}

// isCrossSiteLogin reports a form POST that another site made: browsers
// send Sec-Fetch-Site on it; one without the header (an old browser, curl)
// passes, as a script on another page cannot omit it.
func isCrossSiteLogin(r *http.Request) bool {
	site := r.Header.Get("Sec-Fetch-Site")
	return site != "" && site != "same-origin" && site != "none"
}

// foreignLoginOrigin reports a form POST another site made in a browser too
// old to send Sec-Fetch-Site (Safari before 16.4), which still sends Origin.
// "null" passes: a browser following the Fetch spec sends it on this page's
// own form, under the no-referrer policy every response carries.
func foreignLoginOrigin(allowed hostAllowlist, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || origin == "null" {
		return false
	}
	u, err := url.Parse(origin)
	return err != nil || u.Host == "" || !allowed.allows(r, u.Host)
}

// isFormPost reports a urlencoded POST body, the only one the form sends.
func isFormPost(r *http.Request) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && mt == "application/x-www-form-urlencoded"
}
