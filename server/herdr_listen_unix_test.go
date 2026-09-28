//go:build !windows

package main

import (
	"net"
	"testing"
)

// listenHerdrTest listens where herdr would: a Unix socket at path.
func listenHerdrTest(t *testing.T, path string) net.Listener {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	return ln
}
