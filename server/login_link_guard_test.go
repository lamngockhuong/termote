package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// A listener of another user on the port (::1 beside the server on
// 127.0.0.1) would receive the token the browser posts: no file is written,
// and the plain link opens with the reason.
func TestURLOpenRefusesForeignListener(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.env["XDG_STATE_HOME"] = t.TempDir()
	tc.saveConfig(savedConfig{Port: 7680, Password: "secret"})
	tc.runner.paths["xdg-open"] = true
	old := listenerOwnerOf
	listenerOwnerOf = func(int) listenerOwner { return listenerOtherOwner }
	t.Cleanup(func() { listenerOwnerOf = old })
	called := false
	oldDial := dialLocalServer
	dialLocalServer = func(string, int) (net.Conn, error) { called = true; return nil, os.ErrNotExist }
	t.Cleanup(func() { dialLocalServer = oldDial })

	info := linkInfo{report: statusReport{Port: 7680, Auth: true}, url: "http://localhost:7680/"}
	unsigned, err := tc.openApp(info)
	if err != nil || unsigned != untrustedListenerMsg || !tc.runner.called("xdg-open http://localhost:7680/") {
		t.Fatalf("foreign listener: %q %v %v", unsigned, err, tc.runner.calls)
	}
	if called {
		t.Error("a token was asked for")
	}
	if entries, _ := os.ReadDir(tc.localSocketDir()); len(entries) != 0 {
		t.Errorf("files written: %v", entries)
	}
}

// A signed-in browser coming back to /login/link (Back from the app) goes to
// the app, not to an "expired" sign-in form.
func TestLoginLinkGetWithSession(t *testing.T) {
	h, _ := newSigninServer(t, false)
	c := signIn(t, h, "Browser")
	req := httptest.NewRequest("GET", loginLinkPath, nil)
	req.Host = "localhost:7680"
	req.AddCookie(c)
	if rec := serve(h, req); rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/" {
		t.Errorf("GET with a session: %d %q", rec.Code, rec.Header().Get("Location"))
	}
}

// The E2E spec writes the CLI's file by hand: it must post the same fields
// as the file the CLI writes, or it would pass while the CLI fails.
func TestLoginFileFieldsMatchE2E(t *testing.T) {
	var b strings.Builder
	loginFilePage.Execute(&b, struct{ Action, Token, Hash string }{"http://localhost:1/login/link", "ab", "#/s/a/b"})
	spec, err := os.ReadFile("../pwa/e2e/login-link.spec.ts")
	if err != nil {
		t.Skipf("no E2E spec here: %v", err)
	}
	re := regexp.MustCompile(`<(form|input)[^>]*>`)
	tags := func(s string) []string {
		var out []string
		for _, m := range re.FindAllString(s, -1) {
			m = regexp.MustCompile(`(value|action)="[^"]*"`).ReplaceAllString(m, `$1=""`)
			out = append(out, m)
		}
		slices.Sort(out)
		return out
	}
	if got, want := tags(string(spec)), tags(b.String()); !slices.Equal(got, want) {
		t.Errorf("E2E form %v, CLI file %v", got, want)
	}
}
