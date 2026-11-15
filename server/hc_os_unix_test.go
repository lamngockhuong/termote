//go:build !windows

package main

import (
	"net"
	"testing"
)

// hcTestListenPipe: named pipes are Windows only.
func hcTestListenPipe(t *testing.T, _ string) net.Listener {
	t.Fatal("no named pipes here")
	return nil
}
