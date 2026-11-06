package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// stubCloudflareProbe makes every probe find r and counts them.
func stubCloudflareProbe(t *testing.T, r accessResult) *atomic.Int32 {
	t.Helper()
	var n atomic.Int32
	prev := cloudflareProbe
	cloudflareProbe = func(context.Context, string) accessResult {
		n.Add(1)
		return r
	}
	t.Cleanup(func() { cloudflareProbe = prev })
	return &n
}

func TestProxyFlagsStart(t *testing.T) {
	tc := newTestCLI(t, "linux")
	o, set, err := tc.parseStartArgs([]string{"--cloudflare", "Term.Example.com"})
	if err != nil || !set["cloudflare"] {
		t.Fatalf("parse: %+v %v", o, err)
	}
	mergeSaved(&o, set, &savedConfig{Cloudflare: "old.example.com", ProxyClientHeader: "X-Real-Ip"})
	if err := o.proxy.validate(false); err != nil {
		t.Fatal(err)
	}
	if o.proxy.cloudflare != "term.example.com" || o.proxy.proxyHeader != "X-Real-Ip" || o.proxy.header() != "X-Real-Ip" {
		t.Fatalf("given and saved: %+v", o.proxy)
	}

	// Saved values are kept; --no-* drops them; the header defaults to
	// CF-Connecting-IP with a Cloudflare hostname.
	o, set, _ = tc.parseStartArgs([]string{"--no-proxy-client-header"})
	mergeSaved(&o, set, &savedConfig{Cloudflare: "term.example.com", ProxyClientHeader: "X-Real-Ip"})
	if o.proxy.cloudflare != "term.example.com" || o.proxy.proxyHeader != "" || o.proxy.header() != cloudflareClientHeader {
		t.Fatalf("--no-proxy-client-header: %+v", o.proxy)
	}
	o, set, _ = tc.parseStartArgs([]string{"--no-cloudflare"})
	mergeSaved(&o, set, &savedConfig{Cloudflare: "term.example.com"})
	if o.proxy.cloudflare != "" || o.proxy.header() != "" {
		t.Fatalf("--no-cloudflare: %+v", o.proxy)
	}
	o, set, _ = tc.parseStartArgs([]string{"--proxy-client-header", "x-forwarded-for"})
	mergeSaved(&o, set, nil)
	if err := o.proxy.validate(false); err != nil || o.proxy.header() != "X-Forwarded-For" || o.proxy.cloudflare != "" {
		t.Fatalf("--proxy-client-header alone: %+v %v", o.proxy, err)
	}

	for _, bad := range [][]string{
		{"--cloudflare", "a.example.com", "--no-cloudflare"},
		{"--proxy-client-header", "X-Real-IP", "--no-proxy-client-header"},
	} {
		if _, _, err := tc.parseStartArgs(bad); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
	for _, bad := range []proxyFlags{
		{cloudflare: "https://term.example.com"},
		{cloudflare: "term.example.com:443"},
		{cloudflare: "localhost"},
		{cloudflare: "term.example.com/x"},
		{cloudflare: "-x.example.com"},
		{proxyHeader: "Host"},
		{proxyHeader: "X Real"},
	} {
		if err := bad.validate(false); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
	p := proxyFlags{cloudflare: "term.example.com"}
	if err := p.validate(true); err == nil || !strings.Contains(err.Error(), "--no-auth") {
		t.Errorf("--cloudflare with --no-auth: %v", err)
	}
}

// start refuses --cloudflare with auth off, also when --no-auth is the saved
// value, before touching the service.
func TestStartRefusesCloudflareWithoutAuth(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.procs = func() ([]procInfo, error) { t.Fatal("services touched"); return nil, nil }
	if code := tc.main([]string{"start", "--cloudflare", "term.example.com", "--no-auth"}); code != 2 {
		t.Fatalf("flags: code %d %s", code, tc.stderr.String())
	}
	tc.saveConfig(savedConfig{Port: 7680, NoAuth: true, Mux: "tmux"})
	tc.stderr.Reset()
	if code := tc.main([]string{"start", "--cloudflare", "term.example.com"}); code != 2 || !strings.Contains(tc.stderr.String(), "--no-auth") {
		t.Fatalf("saved --no-auth: code %d %s", code, tc.stderr.String())
	}
	if cfg, _ := tc.loadConfig(); cfg.Cloudflare != "" {
		t.Fatalf("refused hostname saved: %+v", cfg)
	}
}

func TestCloudflareConfigRoundTrip(t *testing.T) {
	for _, goos := range []string{"linux", "windows"} {
		t.Run(goos, func(t *testing.T) {
			if goos == "windows" {
				fakeDPAPI(t)
			}
			tc := newTestCLI(t, goos)
			want := savedConfig{Port: 7680, Password: "p", Cloudflare: "term.example.com", ProxyClientHeader: "X-Real-Ip",
				Container: &containerConfig{Port: 7681, Cloudflare: "c.example.com", ProxyClientHeader: "X-Forwarded-For"}}
			if err := tc.saveConfig(want); err != nil {
				t.Fatal(err)
			}
			got, err := tc.loadConfig()
			if err != nil || got.Cloudflare != want.Cloudflare || got.ProxyClientHeader != want.ProxyClientHeader ||
				got.Container == nil || got.Container.Cloudflare != "c.example.com" || got.Container.ProxyClientHeader != "X-Forwarded-For" {
				t.Fatalf("loaded %+v %+v %v", got, got.Container, err)
			}
			// Unset, nothing is written.
			if err := tc.saveConfig(savedConfig{Port: 7680, Password: "p"}); err != nil {
				t.Fatal(err)
			}
			if raw, _ := os.ReadFile(tc.configFile()); strings.Contains(string(raw), "CLOUDFLARE") || strings.Contains(string(raw), "Cloudflare") || strings.Contains(string(raw), "PROXY_CLIENT") {
				t.Errorf("unset values written:\n%s", raw)
			}
		})
	}
	if _, err := formatUnixConfig(savedConfig{Cloudflare: "a\"b"}, "k"); err == nil {
		t.Error("a quote in the hostname was saved")
	}
}

// The native server allows the hostname as a Host and reads the client
// header over loopback only.
func TestServeConfigCloudflare(t *testing.T) {
	cfg := serveConfigFromSaved(savedConfig{Password: "p", Cloudflare: "Term.Example.com", AllowHosts: []string{"box.lan"}}, 7680)
	if cfg.AllowedHosts != "term.example.com,box.lan" || cfg.Cloudflare != "Term.Example.com" ||
		cfg.ProxyClientHeader != cloudflareClientHeader || cfg.ProxyClientAnySource {
		t.Fatalf("%+v", cfg)
	}
	cfg = serveConfigFromSaved(savedConfig{Password: "p", Cloudflare: "term.example.com", ProxyClientHeader: "x-forwarded-for"}, 7680)
	if cfg.ProxyClientHeader != "X-Forwarded-For" {
		t.Fatalf("explicit header: %q", cfg.ProxyClientHeader)
	}
	if cfg := serveConfigFromSaved(savedConfig{Password: "p"}, 7680); cfg.ProxyClientHeader != "" || cfg.AllowedHosts != "" {
		t.Fatalf("without: %+v", cfg)
	}
}

func TestContainerUpCloudflare(t *testing.T) {
	probes := stubCloudflareProbe(t, accessResult{State: accessOff})
	cc := newContainerCLI(t)
	cc.saveConfig(savedConfig{Port: 7690, Password: "shared-pass"})
	port := freePort(t)
	if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(port), "--cloudflare", "term.example.com"}); code != 0 {
		t.Fatalf("up: code %d\n%s%s", code, cc.stdout.String(), cc.stderr.String())
	}
	args := strings.Join(cc.runArgs, " ")
	if cc.runEnv["TERMOTE_PROXY_CLIENT_HEADER"] != cloudflareClientHeader || !strings.Contains(args, "-e TERMOTE_PROXY_CLIENT_HEADER") ||
		strings.Contains(args, "TERMOTE_PROXY_CLIENT_HEADER=") || !strings.Contains(cc.runEnv["TERMOTE_ALLOWED_HOSTS"], "term.example.com") {
		t.Fatalf("env %v args %s", cc.runEnv, args)
	}
	if cfg, _ := cc.loadConfig(); cfg.Container.Cloudflare != "term.example.com" || cfg.Cloudflare != "" {
		t.Fatalf("saved %+v %+v", cfg, cfg.Container)
	}
	out := cc.stdout.String()
	for _, want := range []string{"Cloudflare: https://term.example.com", "Cloudflare Access is OFF for term.example.com"} {
		if !strings.Contains(out, want) {
			t.Errorf("output misses %q:\n%s", want, out)
		}
	}
	if probes.Load() != 1 {
		t.Errorf("probed %d times", probes.Load())
	}

	// Without the header nothing is passed.
	cc.srv.Close()
	cc.srv = nil
	if code := cc.main([]string{"container", "up", "--no-cloudflare"}); code != 0 {
		t.Fatalf("--no-cloudflare: %s", cc.stderr.String())
	}
	if _, ok := cc.runEnv["TERMOTE_PROXY_CLIENT_HEADER"]; ok || strings.Contains(strings.Join(cc.runArgs, " "), "TERMOTE_PROXY_CLIENT_HEADER") {
		t.Fatalf("header passed without one: %v", cc.runEnv)
	}

	// --lan with a client header is refused: LAN machines come in through
	// the gateway like the proxy does.
	for _, extra := range [][]string{{"--cloudflare", "term.example.com"}, {"--proxy-client-header", "X-Real-IP"}} {
		cc.runArgs = nil
		cc.stderr.Reset()
		if code := cc.main(append([]string{"container", "up", "--lan"}, extra...)); code != 2 || cc.runArgs != nil ||
			!strings.Contains(cc.stderr.String(), "127.0.0.1") {
			t.Fatalf("--lan %v: code %d ran %v\n%s", extra, code, cc.runArgs, cc.stderr.String())
		}
	}
	cc.stderr.Reset()
	if code := cc.main([]string{"container", "up", "--cloudflare", "term.example.com", "--no-auth"}); code != 2 {
		t.Fatalf("--no-auth: code %d", code)
	}
}

func TestCloudflareURLs(t *testing.T) {
	tc := newTestCLI(t, "linux")
	u := tc.accessURLs(&savedConfig{LAN: true, Cloudflare: "term.example.com"}, 7680)
	if u.Cloudflare != "https://term.example.com" || u.primary() != "https://term.example.com" {
		t.Fatalf("%+v primary %q", u, u.primary())
	}
	// Tailscale stays first.
	if u := tc.accessURLs(&savedConfig{Tailscale: "box.ts.net", Cloudflare: "term.example.com"}, 7680); u.primary() != "https://box.ts.net" {
		t.Fatalf("primary %q", u.primary())
	}
}

func TestStatusCloudflare(t *testing.T) {
	probes := stubCloudflareProbe(t, accessResult{State: accessOn})
	tc := newTestCLI(t, "linux")
	port, _ := serveHealth(t, "p", herdrHealth)
	tc.saveConfig(savedConfig{Port: port, Password: "p", Cloudflare: "term.example.com"})

	if code := tc.main([]string{"status", "--json"}); code != 0 {
		t.Fatalf("code %d %s", code, tc.stderr.String())
	}
	var r statusReport
	if err := json.Unmarshal(tc.stdout.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if r.Cloudflare != "term.example.com" || r.CloudflareAccess != "on" || r.URLs.Cloudflare != "https://term.example.com" {
		t.Fatalf("report %+v", r)
	}

	tc.stdout.Reset()
	stubCloudflareProbe(t, accessResult{State: accessOff})
	if code := tc.main([]string{"status"}); code != 0 {
		t.Fatalf("status: %d", code)
	}
	out := tc.stdout.String()
	for _, want := range []string{"Cloudflare: https://term.example.com (Access: off)", "Client header: CF-Connecting-IP", "Cloudflare Access is OFF"} {
		if !strings.Contains(out, want) {
			t.Errorf("status misses %q:\n%s", want, out)
		}
	}

	// No hostname: no probe, an empty field.
	tc.saveConfig(savedConfig{Port: port, Password: "p"})
	tc.stdout.Reset()
	before := probes.Load()
	tc.main([]string{"status", "--json"})
	r = statusReport{}
	json.Unmarshal(tc.stdout.Bytes(), &r)
	if r.Cloudflare != "" || r.CloudflareAccess != "" || !strings.Contains(tc.stdout.String(), `"cloudflareAccess": ""`) || probes.Load() != before {
		t.Fatalf("without a hostname: %+v", r)
	}
}

// The panel probes once when it opens, not at every redraw.
func TestPanelCloudflare(t *testing.T) {
	probes := stubCloudflareProbe(t, accessResult{State: accessOff})
	tc := newTestCLI(t, "linux")
	port, _ := serveHealth(t, "p", herdrHealth)
	tc.saveConfig(savedConfig{Port: port, Password: "p", Cloudflare: "term.example.com"})
	panelKeys(tc, "zzq")
	if code := tc.main([]string{"panel"}); code != 0 {
		t.Fatalf("code %d", code)
	}
	out := tc.stdout.String()
	for _, want := range []string{"https://term.example.com/", "Cloudflare: https://term.example.com (Access: off)", "Cloudflare Access is OFF"} {
		if !strings.Contains(out, want) {
			t.Errorf("panel misses %q:\n%s", want, out)
		}
	}
	if n := probes.Load(); n != 1 {
		t.Errorf("probed %d times", n)
	}
}

func TestWarnExposureCloudflare(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.warnExposure(startOptions{proxy: proxyFlags{cloudflare: "term.example.com"}})
	if out := tc.stdout.String(); !strings.Contains(out, "term.example.com is on the Internet") {
		t.Fatalf("%q", out)
	}
}

func TestReportCloudflareAccess(t *testing.T) {
	for _, tt := range []struct {
		r    accessResult
		want string
	}{
		{accessResult{State: accessOn}, "Cloudflare Access is on for h.example.com"},
		{accessResult{State: accessOff}, "Cloudflare Access is OFF for h.example.com"},
		{accessResult{accessUnknown, "HTTP 530"}, "Could not tell whether Cloudflare Access is on for h.example.com (HTTP 530)"},
	} {
		stubCloudflareProbe(t, tt.r)
		tc := newTestCLI(t, "linux")
		if got := tc.reportCloudflareAccess("h.example.com"); got != tt.r {
			t.Errorf("returned %+v", got)
		}
		if out := tc.stdout.String() + tc.stderr.String(); !strings.Contains(out, tt.want) {
			t.Errorf("%+v: %q", tt.r, out)
		}
	}
}

func TestClassifyAccess(t *testing.T) {
	resp := func(code int, header ...string) *http.Response {
		r := &http.Response{StatusCode: code, Header: http.Header{}, Request: httptest.NewRequest("GET", "https://term.example.com/api/mux/health", nil)}
		for i := 0; i+1 < len(header); i += 2 {
			r.Header.Add(header[i], header[i+1])
		}
		return r
	}
	for _, tt := range []struct {
		name string
		resp *http.Response
		want accessState
	}{
		{"Access sign-in", resp(302, "Location", "https://team.cloudflareaccess.com/cdn-cgi/access/login/term.example.com?kid=x"), accessOn},
		{"Access sign-in 303", resp(303, "Location", "/cdn-cgi/access/login/term.example.com"), accessOn},
		{"redirect elsewhere", resp(302, "Location", "https://example.com/login"), accessUnknown},
		{"redirect without location", resp(302), accessUnknown},
		{"Termote Basic", resp(401, "Www-Authenticate", `Basic realm="Terminal Access"`), accessOff},
		{"Access OAuth", resp(401, "Www-Authenticate", `Bearer resource_metadata="https://term.example.com/.well-known/cloudflare-access-protected-resource/"`), accessOn},
		{"other 401", resp(401, "Www-Authenticate", `Basic realm="other"`), accessUnknown},
		{"401 without challenge", resp(401), accessUnknown},
		{"open", resp(200), accessOff},
		{"blocked by policy", resp(403), accessUnknown},
		{"tunnel down", resp(530), accessUnknown},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyAccess(tt.resp); got.State != tt.want || (got.State == accessUnknown) == (got.Reason == "") {
				t.Errorf("got %+v, want %s", got, tt.want)
			}
		})
	}
}

// The probe sends no credentials, no cookie, and does not follow the
// redirect to Access's sign-in page.
func TestProbeCloudflareAccess(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.URL.Path != "/api/mux/health" {
			t.Errorf("probe sent %v to %s", r.Header, r.URL.Path)
		}
		http.Redirect(w, r, "/cdn-cgi/access/login/term.example.com", http.StatusFound)
	}))
	defer srv.Close()
	prevClient, prevURL := cloudflareProbeClient, cloudflareProbeURL
	t.Cleanup(func() { cloudflareProbeClient, cloudflareProbeURL = prevClient, prevURL })
	client := srv.Client()
	client.CheckRedirect = prevClient.CheckRedirect
	client.Timeout = time.Second
	cloudflareProbeClient = client
	cloudflareProbeURL = func(string) string { return srv.URL + "/api/mux/health" }

	if got := probeCloudflareAccess(context.Background(), "term.example.com"); got.State != accessOn {
		t.Fatalf("got %+v", got)
	}
	if hits.Load() != 1 {
		t.Fatalf("redirect followed: %d requests", hits.Load())
	}
	if want := "https://term.example.com/api/mux/health"; prevURL("term.example.com") != want {
		t.Errorf("probe URL %q", prevURL("term.example.com"))
	}

	srv.Close()
	if got := probeCloudflareAccess(context.Background(), "term.example.com"); got.State != accessUnknown || got.Reason != "not reachable" {
		t.Fatalf("closed: %+v", got)
	}
	cloudflareProbeURL = func(string) string { return "://bad" }
	if got := probeCloudflareAccess(context.Background(), "x"); got.State != accessUnknown {
		t.Fatalf("bad URL: %+v", got)
	}
}

// The menu asks for a Cloudflare hostname only with auth on and passes it to
// start, which checks it before anything else.
func TestMenuStartCloudflare(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.procs = func() ([]procInfo, error) { t.Fatal("services touched"); return nil, nil }
	// tmux, no LAN, auth on, no Tailscale, a Cloudflare hostname start refuses.
	tc.in = bufio.NewReader(strings.NewReader("2\nn\nn\nn\ny\nnot a host\n"))
	if err := tc.menuStart(); err == nil || !strings.Contains(err.Error(), "invalid --cloudflare") {
		t.Fatalf("hostname not passed: %v", err)
	}
	// Declined: start goes on (and stops at the missing tmux).
	tc.in = bufio.NewReader(strings.NewReader("2\nn\nn\nn\nn\n"))
	if err := tc.menuStart(); err == nil || !strings.Contains(err.Error(), "tmux not found") {
		t.Fatalf("declined: %v", err)
	}
	// Auth off: not asked, the hostname is dropped (start refuses the pair).
	tc.saveConfig(savedConfig{Port: 7680, Mux: "tmux", Cloudflare: "term.example.com", Password: "p"})
	tc.in = bufio.NewReader(strings.NewReader("2\nn\ny\nn\n"))
	if err := tc.menuStart(); err == nil || !strings.Contains(err.Error(), "tmux not found") {
		t.Fatalf("auth off: %v", err)
	}
}

func TestDescribeAccess(t *testing.T) {
	for r, want := range map[accessResult]string{
		{State: accessOn}:                "on",
		{State: accessOff}:               "off",
		{accessUnknown, "not reachable"}: "unknown, not reachable",
		{State: accessUnknown}:           "unknown",
	} {
		if got := describeAccess(r); got != want {
			t.Errorf("%+v: %q, want %q", r, got, want)
		}
	}
}

// On Windows a LAN port forward left from an earlier container up --lan is
// removed before the container is replaced; while it cannot be, a client
// header (trusted from any source in the container) is refused.
func TestWindowsContainerUpRemovesLANForward(t *testing.T) {
	stubCloudflareProbe(t, accessResult{State: accessOn})
	for _, tt := range []struct {
		name     string
		fail     bool
		args     []string
		wantCode int
	}{
		{"removed", false, []string{"--cloudflare", "term.example.com"}, 0},
		{"stays with a header", true, []string{"--cloudflare", "term.example.com"}, 1},
		{"stays without a header", true, nil, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			noLocalSocket(t)
			cc := newContainerCLI(t)
			cc.goos = "windows"
			port := freePort(t)
			cc.saveConfig(savedConfig{Password: "p", Container: &containerConfig{LAN: true, Port: port}})
			remove := "powershell -NoProfile -Command Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','" +
				encodePowerShell(portProxyScript(port, false)) + "'"
			cc.runner.fail[remove] = tt.fail
			code := cc.main(append([]string{"container", "up", "--lan=false"}, tt.args...))
			if code != tt.wantCode || !cc.runner.called(remove) {
				t.Fatalf("code %d, calls %v\n%s%s", code, cc.runner.calls, cc.stdout.String(), cc.stderr.String())
			}
			if tt.wantCode != 0 {
				if cc.runArgs != nil || !strings.Contains(cc.stderr.String(), "netsh interface portproxy delete") {
					t.Fatalf("container replaced (%v) or no hint:\n%s", cc.runArgs, cc.stderr.String())
				}
				return
			}
			if tt.fail && !strings.Contains(cc.stdout.String()+cc.stderr.String(), "Could not remove the LAN port forwarding") {
				t.Errorf("failure not reported:\n%s%s", cc.stdout.String(), cc.stderr.String())
			}
		})
	}
}
