package main

import (
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// passwordServer serves path requests on 127.0.0.1: 200 with body to a
// request with the password "secret" (or to any, when open), else 401. It
// records every path asked and whether any request carried a password.
type passwordServer struct {
	port int
	mu   sync.Mutex
	auth bool
	path []string
}

func newPasswordServer(t *testing.T, open bool, body string) *passwordServer {
	t.Helper()
	s := &passwordServer{}
	s.port = listen(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pass, ok := r.BasicAuth()
		s.mu.Lock()
		s.auth = s.auth || ok
		s.path = append(s.path, r.URL.Path)
		s.mu.Unlock()
		if !open && pass != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(body))
	}))
	return s
}

func (s *passwordServer) gotPassword() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.auth
}

func (s *passwordServer) paths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.path...)
}

// noLocalSocket makes the local socket unreachable, as with a server from
// before it or a pipe that did not answer, and trusts every TCP listener: the
// password then stays home on Windows for no other reason than the OS.
func noLocalSocket(t *testing.T) {
	t.Helper()
	fakeDPAPI(t)
	oldDial, oldOwner := dialLocalServer, listenerOwnerOf
	t.Cleanup(func() { dialLocalServer, listenerOwnerOf = oldDial, oldOwner })
	dialLocalServer = func(string, int) (net.Conn, error) { return nil, errors.New("no local socket") }
	listenerOwnerOf = func(int) listenerOwner { return listenerTrustedOwner }
}

// On Windows the native server gets the saved password over its local
// socket only: status reports a server that asks for it over TCP, and one
// running without sign-in still answers there.
func TestNativeWindowsStatusSendsNoPasswordOverTCP(t *testing.T) {
	noLocalSocket(t)
	srv := newPasswordServer(t, false, `{"status":"ok","version":"1.0.0"}`)
	tc := newTestCLI(t, "windows")
	tc.saveConfig(savedConfig{Port: srv.port, Password: "secret"})
	if code := tc.main([]string{"status"}); code == 0 || !strings.Contains(tc.stdout.String(), pipeOnlyMsg) {
		t.Errorf("status: code %d\n%s", code, tc.stdout.String())
	}
	if r := tc.statusReport(&savedConfig{Port: srv.port, Password: "secret"}, srv.port); r.Running || r.Status != "pipe only" {
		t.Errorf("report = %+v", r)
	}
	if srv.gotPassword() {
		t.Fatal("the password went over TCP on Windows")
	}

	open := newPasswordServer(t, true, `{"status":"ok","version":"1.0.0"}`)
	if h, code, via := tc.fetchHealthVia(open.port, "admin", "secret"); code != http.StatusOK || h.Version != "1.0.0" || via != transportTCP {
		t.Errorf("server without sign-in: %d %+v %s", code, h, via)
	}
	if open.gotPassword() {
		t.Error("the password went over TCP to a server without sign-in")
	}

	if _, code, _ := tc.fetchHealthVia(deadPort(t), "admin", "secret"); code != 0 {
		t.Errorf("nothing listening: code %d, want 0", code)
	}

	// Elsewhere the listener check decides, and the password goes.
	lx := newTestCLI(t, "linux")
	if _, code, _ := lx.fetchHealthVia(srv.port, "admin", "secret"); code != http.StatusOK || !srv.gotPassword() {
		t.Errorf("linux: code %d, password sent %v", code, srv.gotPassword())
	}
}

// The health wait of start, restart and update gives up on a native server
// that wants the password over TCP on Windows.
func TestWindowsHealthWaitNative(t *testing.T) {
	noLocalSocket(t)
	srv := newPasswordServer(t, false, `{"status":"ok","version":"1.0.0"}`)
	tc := newTestCLI(t, "windows")
	err := tc.waitForServer(srv.port, "admin", "secret", "1.0.0", 300*time.Millisecond, nil)
	if err == nil || !strings.Contains(err.Error(), pipeOnlyMsg) || srv.gotPassword() {
		t.Fatalf("native: %v, password sent %v", err, srv.gotPassword())
	}
}

// pair, devices and signins against the native server on Windows never use
// what TCP answers: a stopped server reads as not running, any other answer
// as the pipe that did not answer, and only health is asked, without the
// password.
func TestNativeWindowsDeviceCommandsSendNoPasswordOverTCP(t *testing.T) {
	noLocalSocket(t)
	srv := newPasswordServer(t, true, `{"devices":[]}`)
	tc := newTestCLI(t, "windows")
	tc.saveConfig(savedConfig{Port: srv.port, Password: "secret"})
	for _, args := range [][]string{{"devices"}, {"signins"}, {"pair"}} {
		if code, _, errOut := runDevCLI(tc, args...); code != 1 || !strings.Contains(errOut, pipeOnlyMsg) {
			t.Errorf("%v: %d %q", args, code, errOut)
		}
	}
	for _, p := range srv.paths() {
		if p != "/api/mux/health" {
			t.Errorf("asked %s over TCP", p)
		}
	}
	if srv.gotPassword() {
		t.Error("the password went over TCP on Windows")
	}
	tc.saveConfig(savedConfig{Port: deadPort(t), Password: "secret"})
	if code, _, errOut := runDevCLI(tc, "devices"); code != 1 || !strings.Contains(errOut, "not running") {
		t.Errorf("stopped server: %d %q", code, errOut)
	}
}

// Asked without the password, a listener of another user is still not
// believed: the server reads as not running, the panel offers no link and
// no start, and the sign-in link is not asked for.
func TestNativeWindowsForeignListenerNotBelieved(t *testing.T) {
	noLocalSocket(t)
	srv := newPasswordServer(t, true, `{"status":"ok","version":"1.0.0"}`)
	listenerOwnerOf = func(int) listenerOwner { return listenerOtherOwner }
	tc := newTestCLI(t, "windows")
	tc.saveConfig(savedConfig{Port: srv.port, Password: "secret"})
	if r := tc.statusReport(&savedConfig{Port: srv.port, Password: "secret"}, srv.port); r.Running || r.Status != "untrusted listener" {
		t.Errorf("report = %+v", r)
	}
	panelKeys(tc, "ocs \x03")
	if code := tc.main([]string{"panel"}); code != 0 {
		t.Fatalf("panel code %d", code)
	}
	if out := tc.stdout.String(); !strings.Contains(out, untrustedListenerMsg) || strings.Contains(out, "s start") {
		t.Errorf("panel:\n%s", out)
	}
	for _, call := range tc.runner.calls {
		if !strings.HasPrefix(call, "schtasks /Query ") {
			t.Errorf("panel ran %q", call)
		}
	}
	if srv.gotPassword() {
		t.Error("the password went over TCP on Windows")
	}
}

// A native server that asks for the password over TCP: the panel says the
// pipe did not answer and offers no start, which would fail on the busy port.
func TestNativeWindowsPanelPipeOnly(t *testing.T) {
	noLocalSocket(t)
	srv := newPasswordServer(t, false, `{"status":"ok","version":"1.0.0"}`)
	tc := newTestCLI(t, "windows")
	tc.saveConfig(savedConfig{Port: srv.port, Password: "secret"})
	panelKeys(tc, "s \x03")
	tc.main([]string{"panel"})
	if out := tc.stdout.String(); !strings.Contains(out, pipeOnlyMsg) || strings.Contains(out, "s start") {
		t.Errorf("panel:\n%s", out)
	}
}

// The saved container's port is not the native server's: status and the
// device commands still send the password there, to a trusted listener.
func TestWindowsContainerKeepsPasswordOverTCP(t *testing.T) {
	noLocalSocket(t)
	srv := newPasswordServer(t, false, `{"status":"ok","version":"1.0.0","devices":[]}`)
	tc := newTestCLI(t, "windows")
	tc.saveConfig(savedConfig{Password: "secret", Container: &containerConfig{Port: srv.port}})
	if r := tc.statusReport(&savedConfig{Port: srv.port, Password: "secret"}, srv.port); !r.Running || r.Version != "1.0.0" {
		t.Errorf("container status report = %+v", r)
	}
	if code, _, errOut := runDevCLI(tc, "devices"); code != 0 {
		t.Errorf("devices against the container: %d %q", code, errOut)
	}
	if !srv.gotPassword() {
		t.Error("the container did not get the password")
	}
}

// container up on Windows waits for the container's server with the
// password, over TCP.
func TestWindowsContainerUpSendsPassword(t *testing.T) {
	noLocalSocket(t)
	cc := newContainerCLI(t)
	cc.goos = "windows"
	cc.needPass = "shared-pass"
	cc.saveConfig(savedConfig{Password: "shared-pass"})
	if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(freePort(t))}); code != 0 {
		t.Fatalf("up: %d\n%s%s", code, cc.stdout.String(), cc.stderr.String())
	}
}

// Native and container saved on one port: once a native server is
// registered the port is the native server's, and the password stays home.
func TestWindowsSharedPortWithNativeServiceIsPipeOnly(t *testing.T) {
	noLocalSocket(t)
	srv := newPasswordServer(t, false, `{"status":"ok","version":"1.0.0"}`)
	tc := newTestCLI(t, "windows")
	tc.saveConfig(savedConfig{Port: srv.port, Password: "secret", Container: &containerConfig{Port: srv.port}})
	tc.runner.outputs["schtasks /Query /TN Termote"] = "Termote"
	if r := tc.statusReport(&savedConfig{Port: srv.port, Password: "secret"}, srv.port); r.Running || r.Status != "pipe only" {
		t.Errorf("report = %+v", r)
	}
	if srv.gotPassword() {
		t.Error("the password went over TCP to the native server")
	}
}

// Native and container saved on one port, no native server registered or
// running: the port is the container's only while the runtime reports the
// container running. A runtime that does not answer, or none at all, keeps
// the password home, as does schtasks failing (the fake knows no command).
func TestWindowsSharedPortIsContainersOnlyWhileItRuns(t *testing.T) {
	const ps = "docker ps --filter name=^termote$ --filter status=running --format {{.Names}}"
	for _, tt := range []struct {
		name      string
		runtime   bool
		ps        string
		container bool
	}{
		{name: "no runtime"},
		{name: "runtime does not answer", runtime: true},
		{name: "container stopped", runtime: true, ps: ""},
		{name: "container running", runtime: true, ps: "termote\n", container: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			noLocalSocket(t)
			srv := newPasswordServer(t, false, `{"status":"ok","version":"1.0.0"}`)
			tc := newTestCLI(t, "windows")
			tc.saveConfig(savedConfig{Port: srv.port, Password: "secret", Container: &containerConfig{Port: srv.port}})
			if tt.runtime {
				tc.runner.paths["docker"] = true
				if tt.name != "runtime does not answer" {
					tc.runner.outputs[ps] = tt.ps
				}
			}
			if got := tc.pipeOnly(srv.port); got == tt.container {
				t.Errorf("pipeOnly = %v", got)
			}
			r := tc.statusReport(&savedConfig{Port: srv.port, Password: "secret"}, srv.port)
			if srv.gotPassword() != tt.container {
				t.Errorf("password over TCP = %v, report %+v", srv.gotPassword(), r)
			}
		})
	}
}

// The sign-in link of the native server on Windows is not asked for over
// TCP: only health is probed, without the password.
func TestNativeWindowsLoginLinkNotAskedOverTCP(t *testing.T) {
	noLocalSocket(t)
	srv := newPasswordServer(t, true, `{"token":"x"}`)
	tc := newTestCLI(t, "windows")
	tc.env["LOCALAPPDATA"] = t.TempDir()
	tc.saveConfig(savedConfig{Port: srv.port, Password: "secret"})
	info := linkInfo{report: statusReport{Port: srv.port, Auth: true, Running: true}, url: "http://127.0.0.1:" + strconv.Itoa(srv.port) + "/"}
	if _, err := tc.loginLinkFile(info); err == nil || err.Error() != pipeOnlyMsg {
		t.Errorf("login link: %v", err)
	}
	for _, p := range srv.paths() {
		if p != "/api/mux/health" {
			t.Errorf("asked %s over TCP", p)
		}
	}
	if srv.gotPassword() {
		t.Error("the password went over TCP on Windows")
	}
}

// container up on Windows waits for the container's server with the
// password even while a native server is registered: the container's port
// is not the native server's.
func TestWindowsContainerUpWithNativeServiceSendsPassword(t *testing.T) {
	noLocalSocket(t)
	cc := newContainerCLI(t)
	cc.goos = "windows"
	cc.needPass = "shared-pass"
	cc.runner.outputs["schtasks /Query /TN Termote"] = "Termote"
	cc.saveConfig(savedConfig{Port: deadPort(t), Password: "shared-pass"})
	if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(freePort(t))}); code != 0 {
		t.Fatalf("up: %d\n%s%s", code, cc.stdout.String(), cc.stderr.String())
	}
}

// container status follows the same rule as the native commands: on the
// port of a registered native server the password stays home, and on the
// container's own port it goes, to a trusted listener.
func TestWindowsContainerStatus(t *testing.T) {
	noLocalSocket(t)
	srv := newPasswordServer(t, false, `{"status":"ok","version":"1.0.0"}`)
	cc := newContainerCLI(t)
	cc.goos = "windows"
	cc.runner.outputs["docker ps -a --filter name=^termote$ --format {{.Status}}\t{{.Image}}"] = "Up 1 minute\ttermote:1.0.0"
	cc.runner.outputs["schtasks /Query /TN Termote"] = "Termote"
	cc.saveConfig(savedConfig{Port: srv.port, Password: "secret", Container: &containerConfig{Port: srv.port}})
	if code := cc.main([]string{"container", "status"}); code != 1 || !strings.Contains(cc.stdout.String(), sharedPortMsg) {
		t.Errorf("shared port: code %d\n%s", code, cc.stdout.String())
	}
	if srv.gotPassword() {
		t.Fatal("the password went over TCP to the native server's port")
	}

	cc.stdout.Reset()
	cc.saveConfig(savedConfig{Port: deadPort(t), Password: "secret", Container: &containerConfig{Port: srv.port}})
	if code := cc.main([]string{"container", "status"}); code != 0 || !srv.gotPassword() {
		t.Errorf("container's own port: code %d, password sent %v\n%s", code, srv.gotPassword(), cc.stdout.String())
	}
}

// container up on Windows refuses the port of the registered native
// server, where the container's server would never get the password.
func TestWindowsContainerUpRefusesNativeServicePort(t *testing.T) {
	noLocalSocket(t)
	cc := newContainerCLI(t)
	cc.goos = "windows"
	cc.runner.outputs["schtasks /Query /TN Termote"] = "Termote"
	port := freePort(t)
	cc.saveConfig(savedConfig{Port: port, Password: "shared-pass"})
	if code := cc.main([]string{"container", "up", "--port", strconv.Itoa(port)}); code != 2 || !strings.Contains(cc.stderr.String(), "registered native server's") {
		t.Fatalf("up: %d\n%s%s", code, cc.stdout.String(), cc.stderr.String())
	}
	if cc.runArgs != nil {
		t.Errorf("the container ran: %v", cc.runArgs)
	}
	if saved, _ := cc.loadConfig(); saved.Container != nil {
		t.Errorf("container settings saved: %+v", saved.Container)
	}
}
