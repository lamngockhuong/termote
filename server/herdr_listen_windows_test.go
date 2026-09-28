//go:build windows

package main

import (
	"net"
	"testing"

	"github.com/Microsoft/go-winio"
)

// listenHerdrTest listens where herdr would: the named pipe of path.
func listenHerdrTest(t *testing.T, path string) net.Listener {
	t.Helper()
	ln, err := winio.ListenPipe(herdrPipeName(path), nil)
	if err != nil {
		t.Fatal(err)
	}
	return ln
}
