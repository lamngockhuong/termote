//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// serveSocketJSON answers every request on the local socket for port in dir
// with status and body.
func serveSocketJSON(t *testing.T, dir string, port, status int, body string) *[]string {
	t.Helper()
	ln, cleanup, err := openLocalSocket(dir, strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close(); cleanup() })
	return &paths
}

// status asks the running server over the local socket; the CLI is told
// to reload after an add or remove.
func TestMachineStatusFromServer(t *testing.T) {
	tc, dir := socketCLI(t)
	tc.saveConfig(savedConfig{Port: 7680, Password: "secret"})
	paths := serveSocketJSON(t, dir, 7680, 200, `{"machines":[{"id":"0123456789abcdef","label":"Box","status":"online"}]}`)
	views, err := tc.machineStatuses()
	if err != nil || len(views) != 1 || views[0].Status != "online" {
		t.Errorf("statuses from the server: %+v %v", views, err)
	}
	tc.reloadMachines()
	if got := strings.Join(*paths, ","); got != "GET /api/mux/machines,POST /api/mux/machines/reload" {
		t.Errorf("requests: %s", got)
	}

	tc2, dir2 := socketCLI(t)
	tc2.saveConfig(savedConfig{Port: 7681, Password: "secret"})
	serveSocketJSON(t, dir2, 7681, 200, `{}`)
	if views, err := tc2.machineStatuses(); err != nil || views == nil || len(views) != 0 {
		t.Errorf("empty answer: %+v %v", views, err)
	}
}

// A forwarded stream that cannot be registered is refused before anything
// reaches the machine.
func TestServeForwardedStreamRefusals(t *testing.T) {
	hub := newStreamHub(1)
	hub.alive = func(string) bool { return false }
	rec := httptest.NewRecorder()
	serveForwardedStream(rec, httptest.NewRequest("GET", "/", nil), nil, hub, authInfo{Kind: authDevice, DeviceID: "d", Role: roleFull})
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("revoked device: %d", rec.Code)
	}
	hub.alive = nil
	held, _ := hub.addFor(func(error) {}, roleFull, "", "")
	rec = httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req = req.WithContext(withAuth(req.Context(), authInfo{Kind: authDevice, DeviceID: "v", Role: roleView}))
	serveForwardedStream(rec, req, nil, hub, authInfo{Kind: authDevice, DeviceID: "v", Role: roleView})
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("too many viewers: %d", rec.Code)
	}
	hub.remove(held)
	hub.shutdown(context.Background())
	rec = httptest.NewRecorder()
	serveForwardedStream(rec, httptest.NewRequest("GET", "/", nil), nil, hub, authInfo{})
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("shutting down: %d", rec.Code)
	}
}

// The recheck tick closes a forwarded stream whose device went away
// without this server's revoke (another process wrote the store).
func TestForwardedStreamRecheck(t *testing.T) {
	dir, port := bridgeTestServer(t)
	cfg := testConfig(t)
	cfg.DevicesDir = t.TempDir() + "/devices"
	cfg.MachineBridges = "Remote=" + strconv.Itoa(port) + "@" + dir
	h, hub, _, agent, err := buildServerWith(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	// Set before anything reads it, restored after the server is gone
	old := forwardedStreamRecheck
	forwardedStreamRecheck = 20 * time.Millisecond
	t.Cleanup(func() { forwardedStreamRecheck = old })
	var gone atomic.Bool
	hub.linked[0].alive = func(string) bool { return !gone.Load() }
	t.Cleanup(func() { hub.shutdown(context.Background()); agent.machines.stop() })
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	full := pairDevice(t, h, "full")
	base := "/api/machines/" + agent.machines.all()[0].rec.ID + "/mux/"
	tok := decodeBody(t, serve(h, asDevice("GET", base+"stream-token", "", full)))["token"].(string)
	hdr := http.Header{}
	hdr.Set("Cookie", full.Name+"="+full.Value)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+base+"stream?pane=0&token="+tok, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer ws.CloseNow()
	gone.Store(true)
	for {
		if _, _, err := ws.Read(ctx); err != nil {
			if ctx.Err() != nil {
				t.Fatal("the recheck never closed the stream")
			}
			return
		}
	}
}

func TestMachineJanitorTicks(t *testing.T) {
	old := machineJanitorEvery
	machineJanitorEvery = 10 * time.Millisecond
	t.Cleanup(func() { machineJanitorEvery = old })
	path := t.TempDir() + "/m.json"
	saveMachines(path, []machineRecord{testMachine("0123456789abcdef", "A", "a")})
	d := &fakeDialer{t: t, v: apiVersion}
	mm := newMachineManager(path, d)
	l := mm.link("0123456789abcdef")
	l.mu.Lock()
	l.lastUsed = time.Now().Add(-machineIdleStop - time.Second)
	l.mu.Unlock()
	deadline := time.Now().Add(2 * time.Second)
	for {
		d.mu.Lock()
		n := len(d.idled)
		d.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the janitor never idled the machine")
		}
		time.Sleep(10 * time.Millisecond)
	}
	mm.stop()
}

// Remove warns, and keeps going, when the key cannot be removed there or
// the host key forgotten; a Windows machine's key is left to the user.
func TestMachineRemoveWarnings(t *testing.T) {
	tc := machineCLI(t, "", nil)
	saveMachines(tc.machinesFile(), []machineRecord{testMachine("0123456789abcdef", "Box", "box")})
	os.MkdirAll(tc.machineSSHDir(), 0o700)
	os.WriteFile(tc.machineSSHPaths().Key+".pub", []byte("ssh-ed25519 AAAAtest c\n"), 0o644)
	os.WriteFile(tc.machineSSHPaths().KnownHosts, []byte("x"), 0o600)
	tc.run = failingInteract{tc.runner}
	tc.runner.onOutput = nil
	if err := tc.cmdMachine([]string{"remove", "Box", "--yes"}); err != nil {
		t.Fatal(err)
	}
	out := tc.stdout.String()
	if !strings.Contains(out, "could not be removed from box") || !strings.Contains(out, "host key stays") {
		t.Errorf("warnings:\n%s", out)
	}
	w := testMachine("1123456789abcdef", "Win", "win")
	w.RemoteOS, w.RemoteExe, w.SocketDir = "windows", "C:/t/termote.exe", ""
	saveMachines(tc.machinesFile(), []machineRecord{w})
	tc.runner.calls = nil
	if err := tc.cmdMachine([]string{"remove", "Win", "--yes"}); err != nil {
		t.Fatal(err)
	}
	if tc.runner.called("ssh -o StrictHostKeyChecking=ask") {
		t.Error("a Windows machine's key was removed over ssh")
	}
}

// add refuses past maxMachines, and reports a failed install.
func TestMachineAddLimits(t *testing.T) {
	tc := machineCLI(t, "", nil)
	var list []machineRecord
	for i := 0; i < maxMachines; i++ {
		list = append(list, testMachine(fmt.Sprintf("%016x", i), fmt.Sprintf("M%d", i), fmt.Sprintf("m%d", i)))
	}
	saveMachines(tc.machinesFile(), list)
	if err := tc.cmdMachine([]string{"add", "box", "--yes"}); err == nil || !strings.Contains(err.Error(), "at most") {
		t.Errorf("past the limit: %v", err)
	}
	tc = machineCLI(t, "", nil)
	inner := tc.runner
	tc.run = installFails{inner}
	if err := tc.cmdMachine([]string{"add", "box", "--yes"}); err == nil || !strings.Contains(err.Error(), "installing the key") {
		t.Errorf("failed install: %v", err)
	}
	tc = machineCLI(t, "", nil)
	tc.runner.paths["ssh"] = false
	if err := tc.cmdMachine([]string{"add", "box"}); err == nil {
		t.Error("added without ssh")
	}
	tc = machineCLI(t, "", nil)
	tc.run = failingInteract{tc.runner}
	if err := tc.cmdMachine([]string{"add", "box", "--remote-exe", "/t", "--yes"}); err == nil || !strings.Contains(err.Error(), "ssh box failed") {
		t.Errorf("TOFU failing: %v", err)
	}
	writeFile(t, tc.machinesFile(), "{")
	if err := tc.cmdMachine([]string{"add", "box"}); err == nil {
		t.Error("added over a broken store")
	}
	if err := tc.cmdMachine([]string{"list"}); err == nil {
		t.Error("listed a broken store")
	}
	if err := tc.cmdMachine([]string{"remove", "x"}); err == nil {
		t.Error("removed from a broken store")
	}
	if _, err := tc.machineStatuses(); err == nil {
		t.Error("statuses of a broken store")
	}
}

// installFails fails the install session only.
type installFails struct{ *fakeRunner }

func (f installFails) Interact(input, name string, args ...string) ([]byte, error) {
	if strings.HasPrefix(input, "command=") {
		return nil, errors.New("exit status 1")
	}
	return f.fakeRunner.Interact(input, name, args...)
}

// A health answer that is not one is incompatible; a dead connection is
// offline.
func TestCheckMachineHealthAnswers(t *testing.T) {
	a, b := net.Pipe()
	go func() {
		buf := make([]byte, 4096)
		b.Read(buf)
		b.Write([]byte("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
		b.Close()
	}()
	if err := checkMachineHealth(context.Background(), a); !errors.Is(err, errMachineIncompatible) {
		t.Errorf("500: %v", err)
	}
	dead, deadEnd := net.Pipe()
	deadEnd.Close()
	if err := checkMachineHealth(context.Background(), dead); !errors.Is(err, errMachineOffline) {
		t.Errorf("closed: %v", err)
	}
}

// remoteInstallScript and remoteExeScript run under a real sh: the
// installer gets the pinned version, a failed download fails the step, and
// termote gets its arguments with its output on stderr.
func TestRemoteScriptsRun(t *testing.T) {
	requireUnixShell(t)
	// Only the tools the scripts use: never a real curl.
	bin := t.TempDir()
	for _, tool := range []string{"sh", "mktemp", "rm", "head"} {
		p, err := exec.LookPath(tool)
		if err != nil {
			t.Skip(tool + " not found")
		}
		os.Symlink(p, filepath.Join(bin, tool))
	}
	run := func(script string, env ...string) (string, string, error) {
		cmd := exec.Command(filepath.Join(bin, "sh"), "-c", script)
		cmd.Env = append([]string{"PATH=" + bin, "HOME=" + t.TempDir()}, env...)
		var out, errOut strings.Builder
		cmd.Stdout, cmd.Stderr = &out, &errOut
		err := cmd.Run()
		return out.String(), errOut.String(), err
	}
	curl := filepath.Join(bin, "curl")
	os.WriteFile(curl, []byte("#!/bin/sh\n[ -n \"$CURL_FAIL\" ] && exit 22\n"+
		"while [ $# -gt 0 ]; do [ \"$1\" = -o ] && { shift; echo 'echo \"v=$TERMOTE_VERSION\"' > \"$1\"; }; shift; done\n"), 0o755)
	out, errOut, err := run(remoteInstallScript("1.2.3"))
	if err != nil || out != "" || !strings.Contains(errOut, "v=1.2.3") {
		t.Errorf("install: %v %q %q", err, out, errOut)
	}
	if _, errOut, err = run(remoteInstallScript("")); err != nil || !strings.Contains(errOut, "v=\n") {
		t.Errorf("install latest: %v %q", err, errOut)
	}
	if _, _, err = run(remoteInstallScript("1.2.3"), "CURL_FAIL=1"); err == nil {
		t.Error("a failed download did not fail the install")
	}
	os.Remove(curl)
	if _, errOut, err = run(remoteInstallScript("1.2.3")); err == nil || !strings.Contains(errOut, "curl is required") {
		t.Errorf("no curl: %v %q", err, errOut)
	}

	// whereamiScript finds termote in ~/.local/bin: a current one answers,
	// an old one (unknown command) gets its path and version reported.
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755)
	found := filepath.Join(home, ".local", "bin", "termote")
	whereami := func(body string) (string, error) {
		os.WriteFile(found, []byte("#!/bin/sh\n"+body+"\n"), 0o755)
		out, _, err := run(whereamiScript, "HOME="+home)
		return out, err
	}
	if out, err := whereami(`[ "$1 $2" = "machine whereami" ] && echo '{"exe":"/x"}'`); err != nil || out != "{\"exe\":\"/x\"}\n" {
		t.Errorf("current: %v %q", err, out)
	}
	out, err = whereami(`[ "$1" = version ] && { echo "Termote v2.22.0"; exit 0; }; echo "unknown command: $1" >&2; exit 2`)
	if err == nil || out != "TERMOTE-OLD\nexe="+found+"\nTermote v2.22.0\n" {
		t.Errorf("old: %v %q", err, out)
	}
	os.Remove(found)
	if out, _, err := run(whereamiScript, "HOME="+home); err == nil || out != "TERMOTE-NOT-FOUND\n" {
		t.Errorf("missing: %v %q", err, out)
	}

	exe := filepath.Join(t.TempDir(), "termote")
	os.WriteFile(exe, []byte("#!/bin/sh\necho \"args=$*\"; read -r x; echo \"stdin=$x\"\n"), 0o755)
	out, errOut, err = run(remoteExeScript(exe, "update", "--version", "1.2.3"))
	if err != nil || out != "" || errOut != "args=update --version 1.2.3\nstdin=\n" {
		t.Errorf("exe: %v %q %q", err, out, errOut)
	}
}
