package main

import (
	"html/template"
	"net/http"
	"strings"
)

// pairPath serves the pairing form and takes its POST: a device signs in by
// a code a full client made, without the password. Public like loginPath; a
// home-screen app on iOS reaches it from the sign-in page's link, since a
// scanned QR code opens Safari, whose cookies the app does not share.
const pairPath = "/pair"

var pairPage = template.Must(template.New("pair").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#09090b">
<title>Termote — Pair this device</title>
<style>
  :root { color-scheme: dark; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
    background: #09090b; color: #fafafa;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  form, main { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 12px; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
  p { margin: 0; color: #a1a1aa; font-size: 14px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: #a1a1aa; }
  input {
    font: inherit; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #3f3f46; background: #18181b; color: #fafafa;
  }
  input[name=code] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.1em; text-transform: uppercase; }
  input:focus { outline: 2px solid #71717a; outline-offset: 1px; }
  button {
    font: inherit; font-weight: 600; margin-top: 4px; padding: 10px 12px; border: 0;
    border-radius: 8px; background: #fafafa; color: #09090b;
  }
  a { color: #a1a1aa; font-size: 14px; }
  .error { margin: 0; padding: 8px 12px; border-radius: 8px; background: #450a0a; color: #fecaca; font-size: 14px; }
</style>
</head>
<body>
{{if .Closed}}<main>
  <h1>Pair this device</h1>
  <p class="error" role="alert">{{.Error}}</p>
  <a href="/">Open Termote</a>
</main>{{else}}<form method="post" action="/pair">
  <h1>Pair this device</h1>
  <p>Enter the code shown by <code>termote pair</code> or by Settings on a signed-in device.</p>
  {{if .Error}}<p class="error" role="alert">{{.Error}}</p>{{end}}
  <label>Pairing code
    <input name="code" value="{{.Code}}" placeholder="XXXXX-XXXXX" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="32" required{{if not .Code}} autofocus{{end}}>
  </label>
  <label>Device name (if the code has none)
    <input name="name" value="{{.Name}}" maxlength="64" autocomplete="off">
  </label>
  <button type="submit">Pair</button>
  <a href="/login">Sign in with the password instead</a>
</form>{{end}}
</body>
</html>
`))

// pairForm is what the pairing page shows. Closed shows only the error and
// a link back (pairing unavailable, or this browser already signed in).
type pairForm struct {
	Code, Name, Error string
	Closed            bool
}

func writePairPage(w http.ResponseWriter, code int, f pairForm) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(code)
	_ = pairPage.Execute(w, f)
}

// pairPrefill keeps a code from the query only when it reads as one, so the
// page never echoes anything else back.
func pairPrefill(s string) string {
	if _, ok := normalizePairCode(s); ok {
		return strings.ToUpper(strings.TrimSpace(s))
	}
	return ""
}

// userAgentDeviceName names a device from its browser when neither the code
// nor the form gave a name: "iPhone Safari", "Android Chrome", ...
func userAgentDeviceName(ua string) string {
	var platform, browser string
	switch {
	case strings.Contains(ua, "iPhone"):
		platform = "iPhone"
	case strings.Contains(ua, "iPad"):
		platform = "iPad"
	case strings.Contains(ua, "Android"):
		platform = "Android"
	case strings.Contains(ua, "Macintosh"):
		platform = "Mac"
	case strings.Contains(ua, "Windows"):
		platform = "Windows"
	case strings.Contains(ua, "CrOS"):
		platform = "ChromeOS"
	case strings.Contains(ua, "Linux"):
		platform = "Linux"
	}
	switch {
	case strings.Contains(ua, "Edg/"):
		browser = "Edge"
	case strings.Contains(ua, "Firefox/") || strings.Contains(ua, "FxiOS/"):
		browser = "Firefox"
	case strings.Contains(ua, "Chrome/") || strings.Contains(ua, "CriOS/"):
		browser = "Chrome"
	case strings.Contains(ua, "Safari/"):
		browser = "Safari"
	}
	if name := strings.TrimSpace(platform + " " + browser); name != "" {
		return name
	}
	return "Device"
}

// pairName is the paired device's name: its maker's, else the form's, else
// one read from the browser.
func pairName(p pendingPair, form string, r *http.Request) string {
	if p.name != "" {
		return p.name
	}
	if n := cleanDeviceName(form); n != "" {
		return n
	}
	return userAgentDeviceName(r.UserAgent())
}
