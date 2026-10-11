package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// The CLI side of a sign-in link (login_link.go): the token goes into a 0600
// file in the CLI's own 0700 dir, and only that file's path reaches the
// opener's and the browser's argv.

// loginFileMaxAge is how long a sign-in link file is kept: its token is dead
// after loginLinkTTL anyway, so one left behind holds nothing usable.
const loginFileMaxAge = 2 * time.Minute

// loginFileName matches the sign-in link files, and nothing else is swept.
var loginFileName = regexp.MustCompile(`^login-[0-9a-f]{16}\.html$`)

// loginTokenRE is what a token from the server must look like before it is
// written into the file.
var loginTokenRE = regexp.MustCompile(`^[0-9a-f]{32,128}$`)

var loginLinkCallErrs = callErrs{
	noAuth:      "the server runs with --no-auth",
	unsupported: "the server runs with --no-auth",
	oldServer:   "the running server cannot make sign-in links; update it (termote update, or for the container: termote container up)",
}

// loginFilePage POSTs the token to the server as soon as it loads; the button
// is there for a browser that blocks scripts on file:// pages.
var loginFilePage = template.Must(template.New("login-file").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Termote</title>
</head>
<body>
<form method="post" action="{{.Action}}">
<input type="hidden" name="t" value="{{.Token}}">
<input type="hidden" name="hash" value="{{.Hash}}">
<p>Signing in to Termote... <button type="submit">Continue</button></p>
</form>
<script>document.forms[0].submit()</script>
</body>
</html>
`))

// openApp opens info's link in the browser, signed in when the server has
// sign-in on: through a sign-in link file, else (no saved password, an
// older server) the plain link, with unsigned saying why.
func (c *cli) openApp(info linkInfo) (unsigned string, err error) {
	path, err := c.loginLinkFile(info)
	if err != nil {
		if !errors.Is(err, errNoSignIn) {
			unsigned = err.Error()
		}
		return unsigned, c.openURL(info.url)
	}
	if err := c.openURL(path); err != nil {
		os.Remove(path)
		return "", err
	}
	return "", nil
}

// errNoSignIn: the server runs without sign-in, so the plain link opens it.
var errNoSignIn = errors.New("sign-in is off")

// loginLinkFile asks the server for a sign-in link token and writes the file
// that redeems it on info's link, returning the file's path.
func (c *cli) loginLinkFile(info linkInfo) (string, error) {
	if !info.report.Auth {
		return "", errNoSignIn
	}
	saved, _ := c.loadConfig()
	t := deviceTarget{port: info.report.Port, user: saved.authUser()}
	if saved != nil {
		t.pass = saved.Password
	}
	u, err := url.Parse(info.url)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("cannot read the link %q", info.url)
	}
	// The browser posts the token to the link's address, over TCP, which
	// the CLI may not have used at all (the local socket): a listener of
	// another user on the port (on ::1, say, where "localhost" resolves
	// first, beside the server on 127.0.0.1) would receive it.
	if listenerOwnerOf(info.report.Port) == listenerOtherOwner {
		return "", errors.New(untrustedListenerMsg)
	}
	dir := c.localSocketDir()
	if err := ensureSocketDir(dir); err != nil {
		return "", err
	}
	sweepLoginFiles(dir)
	var res struct {
		Token string `json:"token"`
	}
	if err := c.serverCall(t, http.MethodPost, loginLinksRoute, struct{}{}, &res, loginLinkCallErrs); err != nil {
		return "", err
	}
	if !loginTokenRE.MatchString(res.Token) {
		return "", errors.New("unexpected sign-in link token from the server")
	}
	hash := ""
	if f := u.EscapedFragment(); f != "" {
		hash = safeLinkHash("#" + f)
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "login-"+hex.EncodeToString(b)+".html")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	data := struct{ Action, Token, Hash string }{
		Action: u.Scheme + "://" + u.Host + loginLinkPath, Token: res.Token, Hash: hash,
	}
	if err := loginFilePage.Execute(f, data); err != nil {
		f.Close()
		os.Remove(path)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

// sweepLoginFiles removes the sign-in link files in dir older than
// loginFileMaxAge: the CLI runs it before writing one, serve when it starts.
func sweepLoginFiles(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !loginFileName.MatchString(e.Name()) || !e.Type().IsRegular() {
			continue
		}
		fi, err := e.Info()
		if err != nil || time.Since(fi.ModTime()) < loginFileMaxAge {
			continue
		}
		os.Remove(filepath.Join(dir, e.Name()))
	}
}
