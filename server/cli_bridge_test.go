package main

import (
	"bufio"
	"errors"
	"net"
	"strings"
	"testing"
)

// bridge refuses what the forced command never passes, and fails with a
// line on stderr, writing nothing to stdout, when there is nothing to join.
func TestCmdBridgeErrors(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if err := tc.cmdBridge([]string{"extra"}); err == nil {
		t.Error("a positional argument was taken")
	}
	if err := tc.cmdBridge([]string{"--socket-dir", "relative"}); err == nil {
		t.Error("a relative socket dir was taken")
	}
	if err := tc.cmdBridge([]string{"--bogus"}); err == nil {
		t.Error("an unknown flag was taken")
	}
	err := tc.cmdBridge(nil)
	if err == nil || !strings.Contains(err.Error(), "no native termote here") {
		t.Errorf("without a saved config: %v", err)
	}
	tc.saveConfig(savedConfig{Port: 7680, Password: "secret"})
	old := dialBridgeServer
	t.Cleanup(func() { dialBridgeServer = old })
	var gotDir string
	var gotPort int
	dialBridgeServer = func(dir string, port int) (net.Conn, error) {
		gotDir, gotPort = dir, port
		return nil, errors.New("no socket")
	}
	err = tc.cmdBridge([]string{"--socket-dir", "/fixed/run"})
	if err == nil || !strings.Contains(err.Error(), "not running here") {
		t.Errorf("without a server: %v", err)
	}
	if gotDir != "/fixed/run" || gotPort != 7680 {
		t.Errorf("dialled %q:%d, want the fixed dir and the saved port", gotDir, gotPort)
	}
	if err := tc.cmdBridge(nil); err == nil || gotDir != tc.localSocketDir() {
		t.Errorf("default socket dir: %q (%v)", gotDir, err)
	}
	if tc.stdout.Len() != 0 {
		t.Errorf("bridge wrote to stdout on failure: %q", tc.stdout)
	}
}

// The greeting comes first, then every byte both ways; the bridge ends when
// the server side closes.
func TestCmdBridgeJoinsBothWays(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: 7680, Password: "secret"})
	server, serverEnd := net.Pipe()
	old := dialBridgeServer
	t.Cleanup(func() { dialBridgeServer = old })
	dialBridgeServer = func(string, int) (net.Conn, error) { return serverEnd, nil }

	in, inW := net.Pipe()
	outR, out := net.Pipe()
	tc.in = bufio.NewReader(in)
	tc.out = out
	done := make(chan error, 1)
	go func() { done <- tc.cmdBridge(nil) }()

	rd := bufio.NewReader(outR)
	line, err := rd.ReadString('\n')
	if err != nil || line != bridgeGreeting+"1.0.0\n" {
		t.Fatalf("greeting %q, %v", line, err)
	}
	go inW.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := server.Read(buf); err != nil || string(buf) != "ping" {
		t.Fatalf("stdin to the server: %q %v", buf, err)
	}
	go server.Write([]byte("pong"))
	if _, err := rd.Read(buf); err != nil || string(buf) != "pong" {
		t.Fatalf("server to stdout: %q %v", buf, err)
	}
	server.Close()
	if err := <-done; err != nil {
		t.Errorf("bridge ended with %v", err)
	}
}

// A greeting that cannot be written (the SSH session already gone) ends the
// bridge with the error.
func TestCmdBridgeGreetingWriteFails(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.saveConfig(savedConfig{Port: 7680, Password: "secret"})
	_, serverEnd := net.Pipe()
	old := dialBridgeServer
	t.Cleanup(func() { dialBridgeServer = old })
	dialBridgeServer = func(string, int) (net.Conn, error) { return serverEnd, nil }
	outR, out := net.Pipe()
	outR.Close()
	tc.out = out
	if err := tc.cmdBridge(nil); err == nil {
		t.Error("a failed greeting write was ignored")
	}
}

// A saved config that cannot be read is reported, not taken for none.
func TestCmdBridgeUnreadableConfig(t *testing.T) {
	tc := newTestCLI(t, "linux")
	writeFile(t, tc.configFile(), "port=\"x")
	if err := tc.cmdBridge(nil); err == nil || strings.Contains(err.Error(), "no native termote") {
		t.Errorf("unreadable config: %v", err)
	}
}
