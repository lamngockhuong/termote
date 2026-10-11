//go:build !windows

package main

import (
	"encoding/json"
	"html"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// linkServer answers health as a running server and the sign-in link route
// with linkStatus and linkBody, counting the link requests. Listener checks
// are passed (the server is this process).
func linkServer(t *testing.T, linkStatus int, linkBody string) (int, *atomic.Int32) {
	t.Helper()
	hits := new(atomic.Int32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/mux/health":
			w.Write([]byte(`{"status":"ok","version":"1.0.0","backend":"tmux","pid":1}`))
		case loginLinksRoute:
			hits.Add(1)
			w.WriteHeader(linkStatus)
			w.Write([]byte(linkBody))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	old := listenerOwnerOf
	listenerOwnerOf = func(int) listenerOwner { return listenerTrustedOwner }
	t.Cleanup(func() { listenerOwnerOf = old })
	return srv.Listener.Addr().(*net.TCPAddr).Port, hits
}

func tokenBody(token string) string {
	b, _ := json.Marshal(map[string]any{"token": token, "expiresIn": 30})
	return string(b)
}

// loginFiles lists the sign-in link files in dir.
func loginFiles(dir string) []string {
	m, _ := filepath.Glob(filepath.Join(dir, "login-*.html"))
	return m
}

// A link the CLI cannot read is refused before any token is asked for, and
// url --open falls back to the plain link with the reason.
func TestLoginLinkFileBadLinkURL(t *testing.T) {
	tc, dir := socketCLI(t)
	port, hits := linkServer(t, http.StatusOK, tokenBody(strings.Repeat("a", 32)))
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	for _, bad := range []string{"/#/s/main/0", "http://", "http://[::1", "http://a b\x7f/"} {
		info := linkInfo{report: statusReport{Port: port, Auth: true}, url: bad}
		if _, err := tc.loginLinkFile(info); err == nil || !strings.Contains(err.Error(), "cannot read the link") {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if hits.Load() != 0 || len(loginFiles(dir)) != 0 {
		t.Errorf("token asked for or file written for a bad link: hits %d", hits.Load())
	}
	tc.runner.paths["xdg-open"] = true
	unsigned, err := tc.openApp(linkInfo{report: statusReport{Port: port, Auth: true}, url: "/x"})
	if err != nil || !strings.Contains(unsigned, "cannot read the link") || !tc.runner.called("xdg-open /x") {
		t.Errorf("openApp: %q %v %v", unsigned, err, tc.runner.calls)
	}
}

// A server answering a token that is not 32 to 128 lowercase hex digits:
// nothing is written, and the link is not opened signed in.
func TestLoginLinkFileRefusesMalformedToken(t *testing.T) {
	for _, tok := range []string{"", "zz", strings.Repeat("a", 31), strings.Repeat("a", 129), strings.ToUpper(strings.Repeat("ab", 16)), "0123456789abcdef/../x" + strings.Repeat("0", 16)} {
		tc, dir := socketCLI(t)
		port, _ := linkServer(t, http.StatusOK, tokenBody(tok))
		tc.saveConfig(savedConfig{Port: port, Password: "secret"})
		info := linkInfo{report: statusReport{Port: port, Auth: true}, url: "http://127.0.0.1:" + strconv.Itoa(port) + "/"}
		if _, err := tc.loginLinkFile(info); err == nil || !strings.Contains(err.Error(), "unexpected sign-in link token") {
			t.Errorf("token %q: %v", tok, err)
		}
		if files := loginFiles(dir); len(files) != 0 {
			t.Errorf("token %q: file written %v", tok, files)
		}
	}
}

// The server's refusals reach the user as a reason, and the plain link
// opens. Each case is a different answer of the route.
func TestLoginLinkFileServerRefusals(t *testing.T) {
	for _, tc0 := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"older server", http.StatusNotFound, "404 page not found", "cannot make sign-in links"},
		{"no auth", http.StatusNotImplemented, `{"error":"x","code":"unsupported"}`, "--no-auth"},
		{"wrong password", http.StatusUnauthorized, "", "did not accept the saved password"},
		{"session refused", http.StatusForbidden, `{"error":"Only the CLI can make a sign-in link","code":"full_needs_password"}`, "the server refused: Only the CLI can make a sign-in link"},
	} {
		tc, dir := socketCLI(t)
		port, hits := linkServer(t, tc0.status, tc0.body)
		tc.saveConfig(savedConfig{Port: port, Password: "secret"})
		tc.runner.paths["xdg-open"] = true
		info := linkInfo{report: statusReport{Port: port, Auth: true}, url: "http://127.0.0.1:" + strconv.Itoa(port) + "/#/s/main/0"}
		unsigned, err := tc.openApp(info)
		if err != nil || !strings.Contains(unsigned, tc0.want) || !tc.runner.called("xdg-open "+info.url) {
			t.Errorf("%s: unsigned %q, err %v, calls %v", tc0.name, unsigned, err, tc.runner.calls)
		}
		if hits.Load() != 1 || len(loginFiles(dir)) != 0 {
			t.Errorf("%s: hits %d, files %v", tc0.name, hits.Load(), loginFiles(dir))
		}
	}
}

// The state dir cannot be made: the failure is the reason, no token is
// minted, and the plain link opens.
func TestLoginLinkFileSocketDirFails(t *testing.T) {
	tc := newTestCLI(t, "linux")
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	tc.env["XDG_STATE_HOME"] = blocker
	port, hits := linkServer(t, http.StatusOK, tokenBody(strings.Repeat("a", 32)))
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	tc.runner.paths["xdg-open"] = true
	info := linkInfo{report: statusReport{Port: port, Auth: true}, url: "http://127.0.0.1:" + strconv.Itoa(port) + "/"}
	if _, err := tc.loginLinkFile(info); err == nil {
		t.Fatal("state dir that is a file accepted")
	}
	unsigned, err := tc.openApp(info)
	if err != nil || unsigned == "" || hits.Load() != 0 || !tc.runner.called("xdg-open "+info.url) {
		t.Errorf("openApp: %q %v hits %d calls %v", unsigned, err, hits.Load(), tc.runner.calls)
	}
}

var hashInput = regexp.MustCompile(`name="hash" value="([^"]*)"`)
var actionInput = regexp.MustCompile(`action="([^"]*)"`)

// The deep link survives the file: the CLI writes its escapes and the view
// unchanged, and the form posts them to the server's loopback address.
func TestLoginLinkFileKeepsDeepLinkEscapes(t *testing.T) {
	tc, dir := socketCLI(t)
	port, _ := linkServer(t, http.StatusOK, tokenBody(strings.Repeat("c", 32)))
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	link := "http://localhost:" + strconv.Itoa(port) + "/#/s/w1/w1%3At1/w1%3Ap2?view=chat"
	path, err := tc.loginLinkFile(linkInfo{report: statusReport{Port: port, Auth: true}, url: link})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != dir {
		t.Errorf("file in %s, want %s", filepath.Dir(path), dir)
	}
	page, _ := os.ReadFile(path)
	m := hashInput.FindSubmatch(page)
	a := actionInput.FindSubmatch(page)
	if m == nil || a == nil {
		t.Fatalf("file form:\n%s", page)
	}
	if got := html.UnescapeString(string(m[1])); got != "#/s/w1/w1%3At1/w1%3Ap2?view=chat" {
		t.Errorf("hash in file %q", got)
	}
	// localhost is posted to 127.0.0.1, never to ::1 another user could hold.
	if got := html.UnescapeString(string(a[1])); got != "http://127.0.0.1:"+strconv.Itoa(port)+"/login/link" {
		t.Errorf("action %q", got)
	}
}

// The file's hash, posted as its form does, comes back as the browser's
// refresh; a Herdr-style link selects its session in the app.
func TestSignInFileHashToRefresh(t *testing.T) {
	tc, dir := socketCLI(t)
	port := startSocketServer(t, dir)
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	tc.runner.paths["xdg-open"] = true
	args := []string{"--open", "--group", "w1", "--tab", "w1:t1", "--pane", "w1:p2", "--view", "chat"}
	if err := tc.cmdURL(args); err != nil {
		t.Fatal(err)
	}
	var opened string
	for _, call := range tc.runner.calls {
		if rest, ok := strings.CutPrefix(call, "xdg-open "); ok {
			opened = rest
		}
	}
	page, err := os.ReadFile(opened)
	if err != nil {
		t.Fatalf("opened %q: %v", opened, err)
	}
	tok := regexp.MustCompile(`name="t" value="([0-9a-f]+)"`).FindSubmatch(page)
	hash := html.UnescapeString(string(hashInput.FindSubmatch(page)[1]))
	if tok == nil || hash != "#/s/w1/w1%3At1/w1%3Ap2?view=chat" {
		t.Fatalf("file: token %v hash %q", tok != nil, hash)
	}
	rec := postLinkHTTP(t, port, string(tok[1]), hash)
	if rec.StatusCode != http.StatusOK {
		t.Fatalf("redeem: %d", rec.StatusCode)
	}
	want := `content="0;url=/#/s/w1/w1%3At1/w1%3Ap2?view=chat"`
	if !strings.Contains(rec.Body, want) {
		t.Errorf("refresh does not keep the link:\n%s", rec.Body)
	}
}

type httpAnswer struct {
	StatusCode int
	Body       string
	Cookies    []*http.Cookie
}

// postLinkHTTP posts the file's form to the real server as a file:// page.
func postLinkHTTP(t *testing.T, port int, token, hash string) httpAnswer {
	t.Helper()
	form := url.Values{"t": {token}, "hash": {hash}}.Encode()
	req, _ := http.NewRequest("POST", "http://localhost:"+strconv.Itoa(port)+loginLinkPath, strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "null")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return httpAnswer{StatusCode: resp.StatusCode, Body: string(body), Cookies: resp.Cookies()}
}

// url --open prints the link alone on stdout, with no warning when signed in.
func TestURLOpenStdoutIsLinkOnly(t *testing.T) {
	tc, dir := socketCLI(t)
	port := startSocketServer(t, dir)
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	tc.runner.paths["xdg-open"] = true
	if err := tc.cmdURL([]string{"--open", "--group", "main", "--tab", "0"}); err != nil {
		t.Fatal(err)
	}
	want := "http://127.0.0.1:" + strconv.Itoa(port) + "/#/s/main/0\n"
	if tc.stdout.String() != want {
		t.Errorf("stdout %q, want %q", tc.stdout.String(), want)
	}
	if strings.Contains(tc.stderr.String(), "WARN") {
		t.Errorf("warning on a signed-in open: %s", tc.stderr.String())
	}
}

// --copy and --qr keep the plain link: no token is asked for.
func TestURLCopyAndQRNeverMintToken(t *testing.T) {
	tc, _ := socketCLI(t)
	port, hits := linkServer(t, http.StatusOK, tokenBody(strings.Repeat("d", 32)))
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	tc.runner.paths["xclip"] = true
	if err := tc.cmdURL([]string{"--group", "main", "--tab", "0", "--copy", "--qr"}); err != nil {
		t.Fatal(err)
	}
	link := "http://127.0.0.1:" + strconv.Itoa(port) + "/#/s/main/0"
	if !strings.HasPrefix(tc.stdout.String(), link+"\n") || !strings.ContainsAny(tc.stdout.String(), "█▀▄") {
		t.Errorf("stdout: %q", tc.stdout.String())
	}
	if len(tc.runner.inputs) == 0 || tc.runner.inputs[0] != link {
		t.Errorf("clipboard %v, want %q", tc.runner.inputs, link)
	}
	if hits.Load() != 0 {
		t.Errorf("token minted by --copy/--qr: %d", hits.Load())
	}
}

// The panel's open key without sign-in says so, and opens the plain link.
func TestPanelOpenWithoutSignIn(t *testing.T) {
	tc, _ := socketCLI(t)
	port, hits := linkServer(t, http.StatusNotFound, "404 page not found")
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	tc.runner.paths["xdg-open"] = true
	panelKeys(tc, "o")
	if code := tc.main([]string{"panel"}); code != 0 {
		t.Fatalf("code %d", code)
	}
	plain := "http://127.0.0.1:" + strconv.Itoa(port) + "/"
	if !tc.runner.called("xdg-open " + plain) {
		t.Errorf("plain link not opened: %v", tc.runner.calls)
	}
	if out := tc.stdout.String(); !strings.Contains(out, "without signing in: the running server cannot make sign-in links") {
		t.Errorf("panel does not say it is unsigned:\n%s", out)
	}
	if hits.Load() != 1 {
		t.Errorf("link requests: %d", hits.Load())
	}
}

// The panel's open key on a signed-in server opens a sign-in file with no
// unsigned note.
func TestPanelOpenSignedIn(t *testing.T) {
	tc, dir := socketCLI(t)
	port := startSocketServer(t, dir)
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	tc.runner.paths["xdg-open"] = true
	panelKeys(tc, "o")
	if code := tc.main([]string{"panel"}); code != 0 {
		t.Fatalf("code %d", code)
	}
	if !regexp.MustCompile(`xdg-open \S*/run/login-[0-9a-f]{16}\.html`).MatchString(strings.Join(tc.runner.calls, "\n")) {
		t.Errorf("no sign-in file opened: %v", tc.runner.calls)
	}
	if out := tc.stdout.String(); strings.Contains(out, "without signing in") || !strings.Contains(out, "Opened the link in the browser") {
		t.Errorf("panel message:\n%s", out)
	}
}

func TestLinkPostHost(t *testing.T) {
	for in, want := range map[string]string{
		"http://localhost:7680/":            "127.0.0.1:7680",
		"http://LocalHost:7680/":            "127.0.0.1:7680",
		"http://localhost/":                 "127.0.0.1",
		"http://192.168.1.5:7680/":          "192.168.1.5:7680",
		"https://box.tail1234.ts.net/":      "box.tail1234.ts.net",
		"https://box.tail1234.ts.net:8443/": "box.tail1234.ts.net:8443",
	} {
		u, _ := url.Parse(in)
		if got := linkPostHost(u); got != want {
			t.Errorf("linkPostHost(%s) = %q, want %q", in, got, want)
		}
	}
}
