//go:build !windows

package main

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"testing"
)

// The herdr socket is kept only when this user (or root) serves it: one
// another user made first is refused as a herdr pipe served by someone else,
// which never starts herdr.
func TestDialHerdrChecksTheServerUser(t *testing.T) {
	path := filepath.Join(shortTempDir(t), "h.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	conn, err := dialHerdr(context.Background(), path)
	if err != nil {
		t.Fatalf("own socket: %v", err)
	}
	conn.Close()
	old := localPeerUID
	t.Cleanup(func() { localPeerUID = old })
	localPeerUID = func(*net.UnixConn) (int, error) { return 4242, nil }
	var pe *herdrPipeUserError
	if _, err := dialHerdr(context.Background(), path); !errors.As(err, &pe) || herdrNotListening(err) {
		t.Errorf("another user's socket = %v", err)
	}
}
