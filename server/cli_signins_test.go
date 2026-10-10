package main

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// signins, signins revoke <id> and signins revoke --all against a real
// server: the CLI's own requests make no session, the list shows the
// browsers, and a revoke signs them out.
func TestSigninsCLI(t *testing.T) {
	h, _ := newSigninServer(t, false)
	port := listen(t, h)
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})

	code, out, errOut := runDevCLI(tc, "signins")
	if code != 0 || !strings.Contains(out, "None.") {
		t.Fatalf("empty list: %d\n%s%s", code, out, errOut)
	}
	a := signIn(t, h, "Firefox \x1b[2J on Linux")
	b := signIn(t, h, "Safari")
	code, out, errOut = runDevCLI(tc, "signins")
	if code != 0 || strings.Contains(out, "\x1b") || !strings.Contains(out, "Firefox [2J on Linux") || !strings.Contains(out, "192.0.2.9") || !strings.Contains(out, "form") {
		t.Fatalf("list: %d\n%s%s", code, out, errOut)
	}
	if strings.Contains(out, a.Value) || strings.Contains(out, b.Value) {
		t.Fatal("list prints a session token")
	}
	var bID string
	for _, v := range listSignins(t, h, asDevice("GET", "/api/mux/signins", "", a)) {
		if v.UserAgent == "Safari" {
			bID = v.ID
		}
	}
	code, out, errOut = runDevCLI(tc, "signins", "revoke", bID)
	if code != 0 || !strings.Contains(out+errOut, "Signed out browser "+bID) || !strings.Contains(out+errOut, "termote start --fresh") {
		t.Fatalf("revoke: %d\n%s%s", code, out, errOut)
	}
	if signedInCode(h, b) != http.StatusUnauthorized || signedInCode(h, a) != http.StatusOK {
		t.Error("revoke signed out the wrong browser")
	}
	if code, _, errOut = runDevCLI(tc, "signins", "revoke", bID); code != 1 || !strings.Contains(errOut, "no browser is signed in with this id") {
		t.Errorf("revoke again: %d %q", code, errOut)
	}
	code, out, errOut = runDevCLI(tc, "signins", "revoke", "--all")
	if code != 0 || !strings.Contains(out+errOut, "Signed out 1 browser:") {
		t.Fatalf("revoke --all: %d\n%s%s", code, out, errOut)
	}
	if signedInCode(h, a) != http.StatusUnauthorized {
		t.Error("revoke --all left a browser signed in")
	}
	// Every CLI call above signed in with Basic auth and made no session.
	if list := listSignins(t, h, apiRequest("GET", "/api/mux/signins", "")); len(list) != 0 {
		t.Errorf("the CLI made sessions: %+v", list)
	}
}

func TestSigninsCLIErrors(t *testing.T) {
	body, status := "", http.StatusOK
	var asked bool
	port := listen(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = true
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: port, Password: "secret", NoAuth: true})
	if code, _, errOut := runDevCLI(tc, "signins"); code != 1 || !strings.Contains(errOut, "--no-auth") || asked {
		t.Errorf("no auth: %d %q, asked %v", code, errOut, asked)
	}
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	for _, c := range []struct {
		status int
		body   string
		args   []string
		want   string
	}{
		{501, `{"error":"x","code":"unsupported"}`, []string{"signins"}, "--no-auth"},
		{404, "404 page not found", []string{"signins"}, "cannot list sign-ins; update it"},
		{200, `{"sessions":[{"id":"../x"}]}`, []string{"signins"}, "malformed"},
		{403, `{"error":"Only a password sign-in or the CLI can sign a browser out","code":"full_needs_password"}`, []string{"signins", "revoke", "--all"}, "the server refused: Only a password"},
		{404, `{"error":"no such sign-in","code":"unknown_session"}`, []string{"signins", "revoke", "0123456789abcdef"}, "no browser is signed in with this id"},
	} {
		status, body = c.status, c.body
		if code, _, errOut := runDevCLI(tc, c.args...); code != 1 || !strings.Contains(errOut, c.want) {
			t.Errorf("%v %d: exit %d %q", c.args, c.status, code, errOut)
		}
	}
}

func TestSigninsUsage(t *testing.T) {
	tc := newTestCLI(t, "linux")
	for _, args := range [][]string{
		{"signins", "list"},
		{"signins", "--all"},
		{"signins", "revoke"},
		{"signins", "revoke", "a", "b"},
		{"signins", "revoke", "0123456789abcdef", "--all"},
		{"signins", "revoke", ".."},
		{"signins", "--bogus"},
	} {
		if code, _, _ := runDevCLI(tc, args...); code != 2 {
			t.Errorf("%v: exit %d, want 2", args, code)
		}
	}
}
