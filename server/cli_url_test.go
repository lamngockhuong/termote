package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// serveHealth answers /api/mux/health with body (status 200) for the admin
// password pass, 401 otherwise, and returns the port.
func serveHealth(t *testing.T, pass, body string) (int, *httptest.Server) {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != adminUser || p != pass {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, body)
	}))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return ln.Addr().(*net.TCPAddr).Port, srv
}

const herdrHealth = `{"status":"ok","version":"1.0.0","backend":"herdr","pid":4242}`

func TestAccessURLs(t *testing.T) {
	tc := newTestCLI(t, "linux")
	cases := []struct {
		saved          *savedConfig
		primary, tsURL string
		lan            int
	}{
		{nil, "http://localhost:7680", "", 0},
		{&savedConfig{}, "http://localhost:7680", "", 0},
		{&savedConfig{LAN: true}, "http://192.168.1.20:7680", "", 2},
		{&savedConfig{LAN: true, Tailscale: "box.ts.net"}, "https://box.ts.net", "https://box.ts.net", 2},
		{&savedConfig{Tailscale: "box.ts.net:8443"}, "https://box.ts.net:8443", "https://box.ts.net:8443", 0},
	}
	for i, c := range cases {
		u := tc.accessURLs(c.saved, 7680)
		if u.primary() != c.primary || u.Tailscale != c.tsURL || len(u.LAN) != c.lan || u.Local != "http://localhost:7680" {
			t.Errorf("case %d: %+v primary %q", i, u, u.primary())
		}
	}
}

func TestStatusJSON(t *testing.T) {
	tc := newTestCLI(t, "linux")
	port, srv := serveHealth(t, "p", herdrHealth)
	tc.saveConfig(savedConfig{Port: port, LAN: true, Tailscale: "box.ts.net", Password: "p"})

	if code := tc.main([]string{"status", "--json"}); code != 0 {
		t.Fatalf("code %d\n%s%s", code, tc.stdout.String(), tc.stderr.String())
	}
	if strings.Contains(tc.stdout.String(), `"p"`) {
		t.Fatalf("password in the output:\n%s", tc.stdout.String())
	}
	var r statusReport
	if err := json.Unmarshal(tc.stdout.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	want := statusReport{Running: true, Status: "ok", Version: "1.0.0", Backend: "herdr", PID: 4242, Port: port, LAN: true, Auth: true}
	if r.Running != want.Running || r.Status != want.Status || r.Version != want.Version || r.Backend != want.Backend ||
		r.PID != want.PID || r.Port != port || !r.LAN || !r.Auth || r.URLs.Tailscale != "https://box.ts.net" || len(r.URLs.LAN) != 2 {
		t.Fatalf("report %+v", r)
	}

	tc.testSupervisors = []supervisor{&fakeService{c: tc.cli}}
	tc.stdout.Reset()
	tc.main([]string{"status", "--json"})
	if r = (statusReport{}); json.Unmarshal(tc.stdout.Bytes(), &r) != nil || r.Supervisor != "fake" {
		t.Fatalf("supervisor %+v", r)
	}
	tc.testSupervisors = nil

	// A wrong password: running, unauthorized, no details.
	tc.saveConfig(savedConfig{Port: port, NoAuth: true, Password: "x"})
	tc.stdout.Reset()
	if code := tc.main([]string{"status", "--json"}); code != 0 {
		t.Fatalf("unauthorized code %d", code)
	}
	r = statusReport{}
	json.Unmarshal(tc.stdout.Bytes(), &r)
	if !r.Running || r.Status != "unauthorized" || r.Auth || r.Backend != "" {
		t.Fatalf("unauthorized report %+v", r)
	}

	srv.Close()
	tc.stdout.Reset()
	if code := tc.main([]string{"status", "--json"}); code != 1 {
		t.Fatalf("stopped code %d", code)
	}
	r = statusReport{}
	json.Unmarshal(tc.stdout.Bytes(), &r)
	if r.Running || r.Status != "not running" || r.URLs.LAN == nil {
		t.Fatalf("stopped report %+v\n%s", r, tc.stdout.String())
	}
}

func TestStatusReportHTTPError(t *testing.T) {
	tc := newTestCLI(t, "linux")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	if r := tc.statusReport(nil, port); r.Running || r.Status != "http 502" {
		t.Fatalf("report %+v", r)
	}
}

func TestEncodeURIComponentAndHash(t *testing.T) {
	// Same results as JavaScript's encodeURIComponent.
	for in, want := range map[string]string{
		"w1:t1": "w1%3At1", "a b/c": "a%20b%2Fc", "-_.!~*'()": "-_.!~*'()", "é": "%C3%A9", "x?y#z&": "x%3Fy%23z%26",
	} {
		if got := encodeURIComponent(in); got != want {
			t.Errorf("encodeURIComponent(%q) = %q, want %q", in, got, want)
		}
	}
	for l, want := range map[deepLink]string{
		{group: "w1", tab: "w1:t1"}:                              "#/s/w1/w1%3At1",
		{group: "w1", tab: "w1:t1", pane: "w1:p2"}:               "#/s/w1/w1%3At1/w1%3Ap2",
		{group: "w1", tab: "w1:t1", pane: "w1:p2", view: "chat"}: "#/s/w1/w1%3At1/w1%3Ap2?view=chat",
		{group: "main", tab: "0", view: "terminal"}:              "#/s/main/0",
		{group: "w1", tab: "w1:t1", view: "fi les"}:              "#/s/w1/w1%3At1?view=fi%20les",
	} {
		if got := l.hash(); got != want {
			t.Errorf("%+v: %q, want %q", l, got, want)
		}
	}
}

func TestHerdrContext(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if _, err := tc.herdrContext(); err == nil {
		t.Fatal("no context accepted")
	}
	// An action: the variables alone.
	tc.env["HERDR_WORKSPACE_ID"], tc.env["HERDR_TAB_ID"], tc.env["HERDR_PANE_ID"] = "w1", "w1:t1", "w1:p1"
	if l, err := tc.herdrContext(); err != nil || l != (deepLink{group: "w1", tab: "w1:t1", pane: "w1:p1"}) {
		t.Fatalf("env: %+v %v", l, err)
	}
	// The context JSON wins over variables a shell inherited from its pane.
	tc.env["HERDR_PLUGIN_CONTEXT_JSON"] = `{"workspace_id":"w2","tab_id":"w2:t1","focused_pane_id":"w2:p3","workspace_label":"x"}`
	if l, _ := tc.herdrContext(); l != (deepLink{group: "w2", tab: "w2:t1", pane: "w2:p3"}) {
		t.Fatalf("json: %+v", l)
	}
	// Malformed or incomplete JSON falls back to the variables.
	for _, raw := range []string{"{", `{"workspace_id":"w2"}`} {
		tc.env["HERDR_PLUGIN_CONTEXT_JSON"] = raw
		if l, _ := tc.herdrContext(); l.group != "w1" {
			t.Fatalf("%s: %+v", raw, l)
		}
	}
	// A popup: JSON only, no pane focused is fine.
	tc.env = map[string]string{"HERDR_PLUGIN_CONTEXT_JSON": `{"workspace_id":"w2","tab_id":"w2:t1"}`}
	if l, err := tc.herdrContext(); err != nil || l != (deepLink{group: "w2", tab: "w2:t1"}) {
		t.Fatalf("popup: %+v %v", l, err)
	}
}

func TestURLCommand(t *testing.T) {
	tc := newTestCLI(t, "linux")
	port, srv := serveHealth(t, "p", herdrHealth)
	tc.saveConfig(savedConfig{Port: port, Tailscale: "box.ts.net", Password: "p"})
	run := func(args ...string) (int, string) {
		tc.stdout.Reset()
		tc.stderr.Reset()
		code := tc.main(append([]string{"url"}, args...))
		return code, tc.stdout.String()
	}

	if code, out := run(); code != 0 || out != "https://box.ts.net/\n" {
		t.Fatalf("base: %d %q", code, out)
	}
	if code, out := run("--group", "w1", "--tab", "w1:t1", "--view", "files"); code != 0 || out != "https://box.ts.net/#/s/w1/w1%3At1?view=files\n" {
		t.Fatalf("group/tab: %d %q", code, out)
	}
	tc.env["HERDR_PLUGIN_CONTEXT_JSON"] = `{"workspace_id":"w2","tab_id":"w2:t1","focused_pane_id":"w2:p3"}`
	if code, out := run("--herdr", "--view", "chat"); code != 0 || out != "https://box.ts.net/#/s/w2/w2%3At1/w2%3Ap3?view=chat\n" {
		t.Fatalf("herdr: %d %q %s", code, out, tc.stderr.String())
	}
	code, out := run("--herdr", "--qr")
	if lines := strings.Split(strings.TrimSpace(out), "\n"); code != 0 || len(lines) < 10 || !strings.Contains(out, "█") {
		t.Fatalf("qr: %d\n%s", code, out)
	}

	for _, bad := range [][]string{
		{"--group", "w1"}, {"--tab", "t"}, {"--pane", "p"}, {"--group", "w", "--pane", "p"},
		{"--herdr", "--group", "w"}, {"extra"}, {"--bogus"},
	} {
		if code, _ := run(bad...); code != 2 {
			t.Errorf("%v: code %d", bad, code)
		}
	}
	delete(tc.env, "HERDR_PLUGIN_CONTEXT_JSON")
	if code, _ := run("--herdr"); code != 2 || !strings.Contains(tc.stderr.String(), "no Herdr workspace") {
		t.Fatalf("no context: %d %s", code, tc.stderr.String())
	}

	srv.Close()
	if code, _ := run(); code != 1 || !strings.Contains(tc.stderr.String(), "not running") {
		t.Fatalf("stopped: %d %s", code, tc.stderr.String())
	}
}

func TestURLOnTmuxBackend(t *testing.T) {
	tc := newTestCLI(t, "linux")
	port, _ := serveHealth(t, "p", `{"status":"ok","version":"1.0.0","backend":"tmux","pid":1}`)
	tc.saveConfig(savedConfig{Port: port, Password: "p"})
	tc.env["HERDR_PLUGIN_CONTEXT_JSON"] = `{"workspace_id":"w2","tab_id":"w2:t1"}`
	if code := tc.main([]string{"url", "--herdr"}); code != 0 || tc.stdout.String() != fmt.Sprintf("http://localhost:%d/\n", port) ||
		!strings.Contains(tc.stderr.String(), "tmux backend") {
		t.Fatalf("code %d out %q err %q", code, tc.stdout.String(), tc.stderr.String())
	}
	// Explicit ids are tmux's own, so they still select.
	tc.stdout.Reset()
	if tc.main([]string{"url", "--group", "main", "--tab", "1"}); !strings.HasSuffix(tc.stdout.String(), "/#/s/main/1\n") {
		t.Fatalf("tmux link %q", tc.stdout.String())
	}
}

func TestURLOpenAndCopy(t *testing.T) {
	tc := newTestCLI(t, "linux")
	port, _ := serveHealth(t, "p", herdrHealth)
	tc.saveConfig(savedConfig{Port: port, Password: "p"})
	base := fmt.Sprintf("http://localhost:%d/", port)

	tc.runner.paths["xdg-open"], tc.runner.paths["xclip"] = true, true
	tc.runner.outputs["xdg-open "+base] = ""
	if code := tc.main([]string{"url", "--open", "--copy"}); code != 0 {
		t.Fatalf("code %d %s", code, tc.stderr.String())
	}
	if !tc.runner.called("xclip -selection clipboard") || tc.runner.inputs[0] != base || !tc.runner.called("xdg-open "+base) ||
		!strings.Contains(tc.stderr.String(), "Copied the link (xclip)") {
		t.Fatalf("calls %v inputs %v out %s", tc.runner.calls, tc.runner.inputs, tc.stdout.String())
	}

	tc.runner.fail["xdg-open "+base] = true
	tc.stderr.Reset()
	if code := tc.main([]string{"url", "--open"}); code != 1 || !strings.Contains(tc.stderr.String(), "xdg-open could not open") {
		t.Fatalf("opener failing: %d %s", code, tc.stderr.String())
	}
	tc.runner.paths = map[string]bool{}
	if code := tc.main([]string{"url", "--copy"}); code != 1 || !strings.Contains(tc.stderr.String(), "no clipboard command") {
		t.Fatalf("no clipboard: %d %s", code, tc.stderr.String())
	}
}

func TestOpenURLPerOS(t *testing.T) {
	for goos, want := range map[string]string{
		"darwin":  "open http://x/",
		"windows": "rundll32 url.dll,FileProtocolHandler http://x/",
		"linux":   "wslview http://x/",
	} {
		tc := newTestCLI(t, goos)
		name := strings.Fields(want)[0]
		tc.runner.paths[name] = true
		tc.runner.outputs[want] = ""
		if err := tc.openURL("http://x/"); err != nil || !tc.runner.called(want) {
			t.Errorf("%s: %v %v", goos, err, tc.runner.calls)
		}
	}
	tc := newTestCLI(t, "linux")
	if err := tc.openURL("http://x/"); err == nil || !strings.Contains(err.Error(), "xdg-open") {
		t.Fatalf("no opener: %v", err)
	}
}

func TestCopyTextOrder(t *testing.T) {
	cases := []struct {
		goos      string
		available []string
		fail      []string
		via       string
	}{
		{"darwin", []string{"pbcopy"}, nil, "pbcopy"},
		{"windows", []string{"clip"}, nil, "clip"},
		{"linux", []string{"wl-copy", "xclip"}, nil, "wl-copy"},
		// wl-copy without Wayland fails: the next command is tried.
		{"linux", []string{"wl-copy", "xsel"}, []string{"wl-copy"}, "xsel"},
		{"linux", []string{"clip.exe"}, nil, "clip.exe"},
	}
	for _, c := range cases {
		tc := newTestCLI(t, c.goos)
		for _, a := range c.available {
			tc.runner.paths[a] = true
		}
		for _, f := range c.fail {
			tc.runner.fail[f] = true
		}
		if via, err := tc.copyText("hi"); err != nil || via != c.via {
			t.Errorf("%+v: %q %v", c, via, err)
		}
	}
	// Nothing works: OSC 52 when stdout is a terminal.
	tc := newTestCLI(t, "linux")
	tc.runner.paths["xclip"] = true
	tc.runner.fail["xclip -selection clipboard"] = true
	if _, err := tc.copyText("hi"); err == nil {
		t.Fatal("copied without a way to")
	}
	tc.outTTY = true
	if via, err := tc.copyText("hi"); err != nil || via != "through the terminal" || tc.stdout.String() != "\033]52;c;aGk=\a" {
		t.Fatalf("osc52: %q %v %q", via, err, tc.stdout.String())
	}
}

func TestQRText(t *testing.T) {
	a, b := qrText("https://box.ts.net/#/s/w1/w1%3At1"), qrText("https://box.ts.net/#/s/w1/w1%3At1")
	if a == "" || a != b {
		t.Fatal("QR not stable")
	}
	lines := strings.Split(strings.TrimSuffix(a, "\n"), "\n")
	width := len([]rune(lines[0]))
	for _, l := range lines {
		if len([]rune(l)) != width {
			t.Fatalf("ragged QR line %q", l)
		}
	}
	// Two modules per line: height is about half the width.
	if len(lines) != (width+1)/2 {
		t.Fatalf("%d lines for width %d", len(lines), width)
	}
	if qrText(strings.Repeat("x", 5000)) != "" {
		t.Fatal("oversized text encoded")
	}
}

func TestWithoutHerdrPaneEnv(t *testing.T) {
	got := withoutHerdrPaneEnv([]string{"PATH=/bin", "HERDR_ENV=1", "HERDR_PANE_ID=w1:p1", "HERDR_PLUGIN_ID=x", "HERDR_SOCKET_PATH=/s", "HOME=/h"})
	if strings.Join(got, " ") != "PATH=/bin HERDR_SOCKET_PATH=/s HOME=/h" {
		t.Fatalf("%v", got)
	}
}

var errKeysDone = errors.New("no more keys")

func TestOpenURLFallsBackToNextOpener(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.runner.paths["xdg-open"], tc.runner.paths["wslview"] = true, true
	tc.runner.fail["xdg-open http://x/"] = true
	if err := tc.openURL("http://x/"); err != nil || !tc.runner.called("wslview http://x/") {
		t.Fatalf("%v %v", err, tc.runner.calls)
	}
}

func TestStatusJSONFixedFields(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: freePort(t), Tailscale: "box.ts.net:8443", Password: "p"})
	tc.main([]string{"status", "--json"})
	var m map[string]any
	if err := json.Unmarshal(tc.stdout.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"running", "status", "version", "backend", "pid", "port", "lan", "auth", "tailscale", "urls", "supervisor"} {
		if _, ok := m[k]; !ok {
			t.Errorf("field %q missing when stopped", k)
		}
	}
	if m["tailscale"] != "box.ts.net:8443" {
		t.Fatalf("tailscale %v", m["tailscale"])
	}
}

func TestAccessInfoHidesPasswordInHerdrPlugin(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.env["HERDR_PLUGIN_ID"] = "lamngockhuong.termote"
	tc.showAccessInfo(startOptions{port: 7680, mux: "herdr"}, "S3cret-pass", false)
	if out := tc.stdout.String(); strings.Contains(out, "S3cret-pass") || !strings.Contains(out, "termote show-password") {
		t.Fatalf("plugin output:\n%s", out)
	}
	delete(tc.env, "HERDR_PLUGIN_ID")
	tc.stdout.Reset()
	tc.showAccessInfo(startOptions{port: 7680, mux: "herdr"}, "S3cret-pass", false)
	if !strings.Contains(tc.stdout.String(), "S3cret-pass") {
		t.Fatal("terminal output lost the new password")
	}
}
