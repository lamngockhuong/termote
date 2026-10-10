package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// listen serves h on 127.0.0.1 and returns the port.
func listen(t *testing.T, h http.Handler) int {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return ln.Addr().(*net.TCPAddr).Port
}

var pairCodeRe = regexp.MustCompile(`Code: ([0-9A-Z]{5}-[0-9A-Z]{5})`)

// runDevCLI runs args and returns the exit code with stdout and stderr.
func runDevCLI(tc *testCLI, args ...string) (int, string, string) {
	tc.stdout.Reset()
	tc.stderr.Reset()
	code := tc.main(args)
	return code, tc.stdout.String(), tc.stderr.String()
}

// pair, devices and devices revoke against a real server: the code pairs a
// device on /pair, the list shows it and a revoke ends it.
func TestPairAndDevices(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	port := listen(t, h)
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})

	code, out, errOut := runDevCLI(tc, "devices")
	if code != 0 || !strings.Contains(out, "None. Pair one") {
		t.Fatalf("empty list: %d\n%s%s", code, out, errOut)
	}
	code, out, errOut = runDevCLI(tc, "pair")
	m := pairCodeRe.FindStringSubmatch(out)
	if code != 0 || m == nil || !strings.Contains(out, "view only") {
		t.Fatalf("pair: %d\n%s%s", code, out, errOut)
	}
	// The link is the one `termote url` gives, never the server's 127.0.0.1.
	link := fmt.Sprintf("http://localhost:%d/pair?code=%s", port, m[1])
	if !strings.Contains(out, link) || !strings.Contains(out, "█") {
		t.Errorf("pair output lacks %s or a QR code:\n%s", link, out)
	}
	if rec := postPair(h, url.Values{"code": {m[1]}, "name": {"Phone"}}, nil); deviceCookieOf(rec) == nil {
		t.Fatalf("the code did not pair: %d %s", rec.Code, rec.Body)
	}

	if code, out, _ = runDevCLI(tc, "pair", "--role", "full", "--name", "Laptop"); code != 0 || !strings.Contains(out, "full access") {
		t.Fatalf("pair --role full: %d\n%s", code, out)
	}
	m = pairCodeRe.FindStringSubmatch(out)
	if rec := postPair(h, url.Values{"code": {m[1]}}, nil); deviceCookieOf(rec) == nil {
		t.Fatalf("the full code did not pair: %d %s", rec.Code, rec.Body)
	}

	code, out, _ = runDevCLI(tc, "devices")
	if code != 0 || !strings.Contains(out, "Phone") || !strings.Contains(out, "Laptop") || !strings.Contains(out, "full access") {
		t.Fatalf("list: %d\n%s", code, out)
	}
	id := regexp.MustCompile(`(?m)^\s+([0-9a-f]{16})\s+Phone\s+view only`).FindStringSubmatch(out)
	if id == nil {
		t.Fatalf("no row for Phone:\n%s", out)
	}
	if code, out, errOut = runDevCLI(tc, "devices", "revoke", id[1]); code != 0 || !strings.Contains(out, "Revoked device "+id[1]) {
		t.Fatalf("revoke: %d\n%s%s", code, out, errOut)
	}
	if code, _, errOut = runDevCLI(tc, "devices", "revoke", id[1]); code != 1 || !strings.Contains(errOut, "no paired device has this id") {
		t.Errorf("revoke again: %d %s", code, errOut)
	}
	if _, out, _ = runDevCLI(tc, "devices"); strings.Contains(out, "Phone") || !strings.Contains(out, "Laptop") {
		t.Errorf("list after revoke:\n%s", out)
	}
}

// With only a container set up, the commands talk to it, on its port, and
// the link names its address.
func TestDevicesTargetContainer(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	port := listen(t, h)
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: 1, Password: "secret", Container: &containerConfig{Port: port, LAN: true}})
	code, out, errOut := runDevCLI(tc, "pair")
	if code != 0 || !strings.Contains(out, fmt.Sprintf("http://192.168.1.20:%d/pair?code=", port)) {
		t.Fatalf("pair on the container: %d\n%s%s", code, out, errOut)
	}
	// A container without auth cannot pair: nothing is asked.
	tc.saveConfig(savedConfig{Port: 1, Password: "secret", Container: &containerConfig{Port: port, NoAuth: true}})
	if code, _, errOut = runDevCLI(tc, "devices"); code != 1 || !strings.Contains(errOut, "runs with --no-auth") {
		t.Errorf("container without auth: %d %s", code, errOut)
	}
}

// Every way the server can fail to answer has its own message, and the
// password is never sent to a listener that cannot be trusted.
func TestDevicesErrors(t *testing.T) {
	answer := func(status int, body string) int {
		return listen(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			fmt.Fprint(w, body)
		}))
	}
	free := func() int {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		p := ln.Addr().(*net.TCPAddr).Port
		ln.Close()
		return p
	}
	cases := []struct {
		name string
		port int
		pass string
		want string
	}{
		{"not running", free(), "secret", "termote is not running on port"},
		{"wrong password", answer(401, ""), "secret", "did not accept the saved password"},
		{"no auth", answer(501, `{"error":"x","code":"unsupported"}`), "secret", "needs sign-in and a usable state dir"},
		{"older server", answer(404, "404 page not found"), "secret", "cannot pair devices; update it"},
		{"redirect", answer(301, ""), "secret", "the server answered HTTP 301"},
		{"no code", answer(200, `{"code":"\u001b[2J"}`), "secret", "no pairing code"},
		{"refused", answer(409, `{"error":"too many pairing codes waiting","code":"too_many_codes"}`), "secret", "the server refused: too many pairing codes waiting"},
		{"other status", answer(502, ""), "secret", "the server answered HTTP 502"},
		{"bad answer", answer(200, "not json"), "secret", "unexpected answer from the server"},
	}
	for _, c := range cases {
		tc := newTestCLI(t, "linux")
		tc.saveConfig(savedConfig{Port: c.port, Password: c.pass})
		if code, _, errOut := runDevCLI(tc, "pair"); code != 1 || !strings.Contains(errOut, c.want) {
			t.Errorf("%s: %d %q", c.name, code, errOut)
		}
	}

	var gotAuth bool
	port := listen(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _, gotAuth = r.BasicAuth()
		fmt.Fprint(w, `{"devices":[]}`)
	}))
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	old := listenerOwnerOf
	t.Cleanup(func() { listenerOwnerOf = old })
	listenerOwnerOf = func(int) listenerOwner { return listenerOtherOwner }
	if code, _, errOut := runDevCLI(tc, "devices"); code != 1 || !strings.Contains(errOut, untrustedListenerMsg) || gotAuth {
		t.Errorf("untrusted listener: %d %q, password sent %v", code, errOut, gotAuth)
	}
	listenerOwnerOf = func(int) listenerOwner { return listenerNoneSeen }
	if code, _, errOut := runDevCLI(tc, "devices", "revoke", "0123456789abcdef"); code != 1 || !strings.Contains(errOut, unverifiedListenerMsg) || gotAuth {
		t.Errorf("unverified listener: %d %q, password sent %v", code, errOut, gotAuth)
	}
}

func TestDevicesUsage(t *testing.T) {
	tc := newTestCLI(t, "linux")
	for _, args := range [][]string{
		{"pair", "--role", "admin"},
		{"pair", "--name", " spaced "},
		{"pair", "phone"},
		{"pair", "--bogus"},
		{"devices", "rename", "x"},
		{"devices", "revoke"},
		{"devices", "revoke", "a", "b"},
		{"devices", "revoke", ".."},
		{"devices", "--bogus"},
		{"pair", "--expires", "5m"},
		{"pair", "--expires", "0d"},
		{"pair", "--expires", "401d"},
		{"pair", "--expires", "forever"},
	} {
		if code, _, _ := runDevCLI(tc, args...); code != 2 {
			t.Errorf("%v: exit %d, want 2", args, code)
		}
	}
}

// A new password removes the devices of the previous one from the disk; a
// store that cannot be opened only warns, and no store is not made.
func TestPruneDevices(t *testing.T) {
	tc := newTestCLI(t, "linux")
	dir := filepath.Join(tc.stateDir(), "devices")
	tc.pruneDevices("admin", "new")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("pruning made the store: %v", err)
	}
	old, err := newDeviceStore(dir, "admin", "old")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := old.add("Phone", roleView, deviceAddOpts{}); err != nil {
		t.Fatal(err)
	}
	tc.pruneDevices("admin", "new")
	if !strings.Contains(tc.stdout.String(), "Removed 1 paired device(s)") {
		t.Errorf("prune output:\n%s", tc.stdout)
	}
	if s, err := newDeviceStore(dir, "admin", "old"); err != nil || len(s.list()) != 0 {
		t.Errorf("the old device is still on the disk: %v", err)
	}

	tc.stdout.Reset()
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, "not a dir")
	tc.pruneDevices("admin", "new")
	if !strings.Contains(tc.stdout.String(), "Could not remove the paired devices") {
		t.Errorf("unusable store:\n%s", tc.stdout)
	}
}

// Without a password nothing is asked, so a listener whose owner was not
// checked never answers; what a server prints is cleaned first.
func TestDevicesWithoutPasswordAndCleanOutput(t *testing.T) {
	var asked bool
	body := `{"error":"bad\u001b[2J","devices":[{"id":"0123456789abcdef","name":"a\u001b[2Jb","role":"view"}]}`
	status := http.StatusOK
	port := listen(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = true
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	tc := newTestCLI(t, "linux")
	for _, cfg := range []savedConfig{{Port: port}, {Port: port, Password: "secret", NoAuth: true}} {
		tc.saveConfig(cfg)
		if code, _, errOut := runDevCLI(tc, "devices"); code != 1 || errOut == "" || asked {
			t.Errorf("%+v: %d %q, asked %v", cfg, code, errOut, asked)
		}
	}
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})
	if code, out, _ := runDevCLI(tc, "devices"); code != 0 || strings.Contains(out, "\x1b") || !strings.Contains(out, "a[2Jb") {
		t.Errorf("name not cleaned: %d %q", code, out)
	}
	status = http.StatusConflict
	if code, _, errOut := runDevCLI(tc, "devices"); code != 1 || strings.Contains(errOut, "\x1b") || !strings.Contains(errOut, "bad[2J") {
		t.Errorf("error not cleaned: %d %q", code, errOut)
	}
	status, body = http.StatusOK, `{"devices":[{"id":"0123456789abcdef","name":"a","role":"view","expired":true,"validUntil":"2026-01-01T00:00:00Z","pairedBy":"fedcba9876543210"}]}`
	if code, out, _ := runDevCLI(tc, "devices"); code != 0 || !strings.Contains(out, "expired") || !strings.Contains(out, "a removed device") {
		t.Errorf("expired device: %d %q", code, out)
	}
	status, body = http.StatusOK, `{"devices":[{"id":"../x","name":"a","role":"view"}]}`
	if code, _, errOut := runDevCLI(tc, "devices"); code != 1 || !strings.Contains(errOut, "malformed") {
		t.Errorf("bad id: %d %q", code, errOut)
	}
}

func TestParseValidity(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"never": 0, "1h": time.Hour, "12h": 12 * time.Hour, "7d": 7 * 24 * time.Hour,
		"2w": 14 * 24 * time.Hour, "30d": 30 * 24 * time.Hour, "400d": maxDeviceValidity,
	} {
		if got, err := parseValidity(in); err != nil || got != want {
			t.Errorf("%s: %v %v", in, got, err)
		}
	}
	for _, in := range []string{"", "0h", "59m", "401d", "58w", "7", "d", "7D", "1.5d", "-1d", "9999999d", "213505d", "30501w", "999999h", "401d"} {
		if _, err := parseValidity(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
	for secs, want := range map[int64]string{0: "never expires", 3600: "valid for 1 hour once used", 7200: "valid for 2 hours once used",
		86400: "valid for 1 day once used", 30 * 86400: "valid for 30 days once used", 7000: "valid for 2 hours once used"} {
		if got := validityLabel(secs); got != want {
			t.Errorf("validityLabel(%d) = %q", secs, got)
		}
	}
	for d, want := range map[deviceView]string{
		{PairedBy: "password"}: "not by a device",
		{PairedBy: "unknown"}:  "unknown",
		{PairedBy: "0123456789abcdef", PairedByName: "Lap\x1btop"}: "Laptop",
		{PairedBy: "0123456789abcdef"}:                             "a removed device",
	} {
		if got := pairedByLabel(d); got != want {
			t.Errorf("pairedByLabel(%+v) = %q", d, got)
		}
	}
}

// pair --expires reaches the server and is shown; the list shows the limit
// and the origin; a revoke names the devices it took too and, for a full
// device, says to change the password.
func TestPairExpiresAndCascade(t *testing.T) {
	h, _, _, _ := newDeviceServer(t)
	port := listen(t, h)
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: port, Password: "secret"})

	code, out, errOut := runDevCLI(tc, "pair")
	if code != 0 || !strings.Contains(out, "valid for 30 days once used") {
		t.Fatalf("default: %d\n%s%s", code, out, errOut)
	}
	postPair(h, url.Values{"code": {pairCodeRe.FindStringSubmatch(out)[1]}, "name": {"Month"}}, nil)
	if code, out, _ = runDevCLI(tc, "pair", "--expires", "never", "--role", "full", "--name", "Laptop"); code != 0 || !strings.Contains(out, "never expires") {
		t.Fatalf("never: %d\n%s", code, out)
	}
	postPair(h, url.Values{"code": {pairCodeRe.FindStringSubmatch(out)[1]}}, nil)
	// A full device with a limit pairs a phone, which the revoke takes too.
	if code, out, _ = runDevCLI(tc, "pair", "--expires", "7d", "--role", "full", "--name", "Tablet"); code != 0 || !strings.Contains(out, "valid for 7 days once used") {
		t.Fatalf("7d: %d\n%s", code, out)
	}
	tabletCookie := deviceCookieOf(postPair(h, url.Values{"code": {pairCodeRe.FindStringSubmatch(out)[1]}}, nil))
	child := pairWith(t, h, asDevice("POST", "/api/mux/devices/pair", `{"role":"view","name":"Phone","validFor":3600}`, tabletCookie))
	tablet := deviceIDOf(t, h, "Tablet")

	code, out, _ = runDevCLI(tc, "devices")
	for _, want := range []string{"VALID UNTIL", "PAIRED BY", "never", "not by a device", "Tablet"} {
		if code != 0 || !strings.Contains(out, want) {
			t.Errorf("list lacks %q:\n%s", want, out)
		}
	}
	if !regexp.MustCompile(`Phone .* Tablet`).MatchString(out) {
		t.Errorf("Phone's origin not shown:\n%s", out)
	}
	code, out, errOut = runDevCLI(tc, "devices", "revoke", tablet)
	if code != 0 || !strings.Contains(out, "Also revoked, as it paired them: ") || !strings.Contains(out, "(Phone)") || !strings.Contains(out, "termote start --fresh") {
		t.Errorf("revoke a full device with a child: %d\n%s%s", code, out, errOut)
	}
	if c, _ := snapshotRole(t, h, child); c != http.StatusUnauthorized {
		t.Errorf("child after the cascade: %d", c)
	}
	month := deviceIDOf(t, h, "Month")
	if code, out, _ = runDevCLI(tc, "devices", "revoke", month); code != 0 || strings.Contains(out, "Also revoked") || strings.Contains(out, "--fresh") {
		t.Errorf("revoke a view device: %d\n%s", code, out)
	}
}
