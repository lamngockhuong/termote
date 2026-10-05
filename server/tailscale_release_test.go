package main

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTailscale stands in for the tailscale CLI: it keeps the https:8443
// mapping in mapped, set by `serve --bg` and cleared by `off`.
type fakeTailscale struct {
	mu     sync.Mutex
	mapped string
	calls  []string
	fail   bool
}

func (f *fakeTailscale) run(_ context.Context, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, strings.Join(args, " "))
	if f.fail {
		return nil, errors.New("tailscaled is not running")
	}
	switch {
	case args[1] == "status":
		if f.mapped == "" {
			return []byte(`{}`), nil
		}
		return []byte(`{"Web":{"box.ts.net:8443":{"Handlers":{"/":{"Proxy":"` + f.mapped + `"}}}}}`), nil
	case args[1] == "--bg":
		f.mapped = args[3]
	case args[len(args)-1] == "off":
		f.mapped = ""
	}
	return nil, nil
}

func (f *fakeTailscale) state() (string, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.mapped, strings.Join(f.calls, "|")
}

func useFakeTailscale(t *testing.T, f *fakeTailscale) {
	old := tailscaleRun
	tailscaleRun = f.run
	t.Cleanup(func() { tailscaleRun = old })
}

// While the server runs, Tailscale proxies to it; once it stops, the mapping
// is gone, so the HTTPS name never leads to a port it no longer holds.
func TestServeAndPublishRemovesTheMappingOnStop(t *testing.T) {
	f := &fakeTailscale{}
	useFakeTailscale(t, f)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	cfg := testConfig(t)
	cfg.Tailscale = "box.ts.net:8443"
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveAndPublish(ctx, cfg, &fakeMux{}, ln) }()
	deadline := time.Now().Add(5 * time.Second)
	for mapped, _ := f.state(); mapped != localTarget(port); mapped, _ = f.state() {
		if time.Now().After(deadline) {
			t.Fatal("never published")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if mapped, calls := f.state(); mapped != "" || !strings.HasSuffix(calls, "serve --https=8443 off") {
		t.Errorf("after stop: mapped %q, calls %s", mapped, calls)
	}
}

// Only a mapping that still proxies to this server goes: one taken over by
// something else (the container, a service of the user) stays, and a
// tailscale that cannot answer leaves things as they are.
func TestReleaseTailscale(t *testing.T) {
	f := &fakeTailscale{mapped: localTarget(7681)}
	useFakeTailscale(t, f)
	releaseTailscale("box.ts.net:8443", 7680)
	if mapped, calls := f.state(); mapped != localTarget(7681) || strings.Contains(calls, "off") {
		t.Errorf("another server's mapping: %q, %s", mapped, calls)
	}
	f.mapped = localTarget(7680)
	releaseTailscale("box.ts.net:8443", 7680)
	if mapped, _ := f.state(); mapped != "" {
		t.Errorf("own mapping left: %q", mapped)
	}
	f.calls, f.mapped, f.fail = nil, localTarget(7680), true
	releaseTailscale("box.ts.net:8443", 7680)
	if _, calls := f.state(); calls != "serve status --json" {
		t.Errorf("tailscale down: %s", calls)
	}
	f.fail = false
	f.calls = nil
	releaseTailscale("", 7680)
	if _, calls := f.state(); calls != "" {
		t.Errorf("no --tailscale: %s", calls)
	}
}

// --lan without lingering: warned, since the port is free while the user is
// logged out. Lingering on, no --lan, or another supervisor: nothing.
func TestLanLingerWarning(t *testing.T) {
	tc := newSystemdCLI(t)
	tc.env["USER"] = "u"
	sup := &systemdSupervisor{c: tc.cli}
	tc.runner.outputs["loginctl show-user u -p Linger --value"] = "no\n"
	tc.lanLingerWarning(false, 7680, sup)
	tc.lanLingerWarning(true, 7680, &launchdSupervisor{c: tc.cli})
	if tc.stderr.Len() != 0 || tc.stdout.Len() != 0 {
		t.Fatalf("warned without --lan or systemd: %s%s", tc.stdout.String(), tc.stderr.String())
	}
	tc.lanLingerWarning(true, 7680, sup)
	if out := tc.stdout.String() + tc.stderr.String(); !strings.Contains(out, "port 7680 is free") || !strings.Contains(out, "loginctl enable-linger u") {
		t.Fatalf("no warning: %q", out)
	}
	tc.stdout.Reset()
	tc.stderr.Reset()
	tc.runner.outputs["loginctl show-user u -p Linger --value"] = "yes\n"
	tc.lanLingerWarning(true, 7680, sup)
	if tc.stderr.Len() != 0 || tc.stdout.Len() != 0 {
		t.Fatalf("warned with lingering on: %s%s", tc.stdout.String(), tc.stderr.String())
	}
}

// Without --tailscale, nothing is asked of tailscale at all.
func TestServeAndPublishWithoutTailscale(t *testing.T) {
	f := &fakeTailscale{}
	useFakeTailscale(t, f)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := serveAndPublish(ctx, testConfig(t), &fakeMux{}, ln); err != nil {
		t.Fatal(err)
	}
	if _, calls := f.state(); calls != "" {
		t.Errorf("tailscale called: %s", calls)
	}
}

// An `off` that fails is logged and leaves the mapping as it is.
func TestReleaseTailscaleOffFails(t *testing.T) {
	var calls []string
	old := tailscaleRun
	t.Cleanup(func() { tailscaleRun = old })
	tailscaleRun = func(_ context.Context, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))
		if args[1] == "status" {
			return []byte(`{"Web":{"box.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7680"}}}}}`), nil
		}
		return nil, errors.New("access denied")
	}
	releaseTailscale("box.ts.net:8443", 7680)
	if strings.Join(calls, "|") != "serve status --json|serve --https=8443 off" {
		t.Fatalf("calls %v", calls)
	}
}
