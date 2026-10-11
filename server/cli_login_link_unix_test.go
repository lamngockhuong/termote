//go:build !windows

package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// startSocketServer runs the real server with sign-in on a free port, its
// local socket in dir, until the test ends.
func startSocketServer(t *testing.T, dir string) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	cfg := testConfig(t)
	cfg.LocalSocketDir = dir
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runServer(ctx, cfg, &fakeMux{snap: oneTabSnapshot()}, ln) }()
	t.Cleanup(func() { cancel(); <-done })
	sock := filepath.Join(dir, strconv.Itoa(port)+".sock")
	for deadline := time.Now().Add(5 * time.Second); ; {
		if _, err := os.Lstat(sock); err == nil {
			return port
		}
		if time.Now().After(deadline) {
			t.Fatal("no local socket")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// `url --open` opens a 0600 file holding the token, never the token itself;
// the file's form signs the browser in and goes on to the deep link.
func TestURLOpenSignsIn(t *testing.T) {
	tc, dir := socketCLI(t)
	port := startSocketServer(t, dir)
	if err := tc.saveConfig(savedConfig{Port: port, Password: "secret"}); err != nil {
		t.Fatal(err)
	}
	tc.runner.paths["xdg-open"] = true
	if err := tc.cmdURL([]string{"--open", "--group", "main", "--tab", "0"}); err != nil {
		t.Fatal(err)
	}
	var opened string
	for _, call := range tc.runner.calls {
		if rest, ok := strings.CutPrefix(call, "xdg-open "); ok {
			opened = rest
		}
	}
	if !regexp.MustCompile(`/run/login-[0-9a-f]{16}\.html$`).MatchString(opened) {
		t.Fatalf("opened %q, want a sign-in link file (calls %v)", opened, tc.runner.calls)
	}
	fi, err := os.Stat(opened)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v (%v), want 0600", fi.Mode().Perm(), err)
	}
	page, _ := os.ReadFile(opened)
	m := regexp.MustCompile(`name="t" value="([0-9a-f]+)"`).FindSubmatch(page)
	if m == nil {
		t.Fatalf("no token in the file:\n%s", page)
	}
	token := string(m[1])
	for name, s := range map[string]string{"argv": strings.Join(tc.runner.calls, "\n"), "stdout": tc.stdout.String(), "stderr": tc.stderr.String()} {
		if strings.Contains(s, token) {
			t.Errorf("the token is in %s", name)
		}
	}
	// localhost is posted to 127.0.0.1 (never ::1, which another user could
	// hold); the done page's relative refresh opens the app there, with the cookie.
	link := "http://127.0.0.1:" + strconv.Itoa(port)
	if !strings.Contains(string(page), `action="`+link+`/login/link"`) || !strings.Contains(string(page), `name="hash" value="#/s/main/0"`) {
		t.Errorf("file form:\n%s", page)
	}

	// The browser posts it from the file:// page.
	req, _ := http.NewRequest("POST", link+loginLinkPath, strings.NewReader(url.Values{"t": {token}, "hash": {"#/s/main/0"}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "null")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookieName {
			cookie = c
		}
	}
	if resp.StatusCode != http.StatusOK || cookie == nil {
		t.Fatalf("redeem: %d, cookie %v", resp.StatusCode, cookie)
	}
}

// Without sign-in the plain link opens, and nothing is written.
func TestURLOpenWithoutAuth(t *testing.T) {
	tc, dir := socketCLI(t)
	if err := tc.saveConfig(savedConfig{Port: 1, NoAuth: true}); err != nil {
		t.Fatal(err)
	}
	tc.runner.paths["xdg-open"] = true
	info := linkInfo{report: statusReport{Port: 1, Auth: false}, url: "http://127.0.0.1:1/"}
	unsigned, err := tc.openApp(info)
	if err != nil || unsigned != "" || !tc.runner.called("xdg-open http://127.0.0.1:1/") {
		t.Fatalf("no auth: %q %v %v", unsigned, err, tc.runner.calls)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("files written: %v", entries)
	}
}

// A server that gives no token (not running, an older one): the plain link
// opens, with the reason.
func TestURLOpenFallsBackToPlainLink(t *testing.T) {
	tc, _ := socketCLI(t)
	if err := tc.saveConfig(savedConfig{Port: 1, Password: "secret"}); err != nil {
		t.Fatal(err)
	}
	tc.runner.paths["xdg-open"] = true
	info := linkInfo{report: statusReport{Port: 1, Auth: true}, url: "http://127.0.0.1:1/#/s/main/0"}
	unsigned, err := tc.openApp(info)
	if err != nil || !strings.Contains(unsigned, "not running") || !tc.runner.called("xdg-open http://127.0.0.1:1/#/s/main/0") {
		t.Fatalf("fallback: %q %v %v", unsigned, err, tc.runner.calls)
	}
}

// An older server without the route: url --open opens the plain link and
// says it is not signed in.
func TestURLOpenOlderServer(t *testing.T) {
	tc, _ := socketCLI(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/mux/health" {
			w.Write([]byte(`{"status":"ok","version":"1.0.0"}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	old := listenerOwnerOf
	listenerOwnerOf = func(int) listenerOwner { return listenerTrustedOwner }
	t.Cleanup(func() { listenerOwnerOf = old })
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	tc.runner.paths["xdg-open"] = true
	if err := tc.cmdURL([]string{"--open"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tc.stderr.String(), "Opened the link without signing in: the running server cannot make sign-in links") {
		t.Errorf("url --open does not say it opened without signing in:\n%s", tc.stderr)
	}
	if !tc.runner.called("xdg-open http://127.0.0.1:" + strconv.Itoa(port) + "/") {
		t.Errorf("plain link not opened: %v", tc.runner.calls)
	}
}

// No opener: the file written for it goes.
func TestURLOpenFailureRemovesFile(t *testing.T) {
	tc, dir := socketCLI(t)
	port := startSocketServer(t, dir)
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	// No opener at all.
	info := linkInfo{report: statusReport{Port: port, Auth: true}, url: "http://127.0.0.1:" + strconv.Itoa(port) + "/"}
	if _, err := tc.openApp(info); err == nil {
		t.Fatal("opener failure not reported")
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "login-*.html"))
	if len(matches) != 0 {
		t.Errorf("file left after the opener failed: %v", matches)
	}
}

func TestSweepLoginFiles(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "login-0123456789abcdef.html")
	fresh := filepath.Join(dir, "login-fedcba9876543210.html")
	other := filepath.Join(dir, "login-notours.html")
	for _, p := range []string{old, fresh, other} {
		os.WriteFile(p, []byte("x"), 0o600)
	}
	past := time.Now().Add(-loginFileMaxAge - time.Minute)
	os.Chtimes(old, past, past)
	os.Chtimes(other, past, past)
	sweepLoginFiles(dir)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("an old sign-in link file stayed")
	}
	for _, p := range []string{fresh, other} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s removed: %v", filepath.Base(p), err)
		}
	}
	sweepLoginFiles(filepath.Join(dir, "missing"))
}
