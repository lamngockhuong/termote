package main

import (
	"net"
	"net/netip"
	"testing"
)

// benchConns opens n loopback connections so the socket tables hold about
// 2n rows, and returns the client and server ends of the last one.
func benchConns(b *testing.B, n int) (netip.AddrPort, netip.AddrPort) {
	b.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { ln.Close() })
	var client, server netip.AddrPort
	for range n {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			b.Skipf("after a few connections: %v", err)
		}
		s, err := ln.Accept()
		if err != nil {
			b.Fatal(err)
		}
		b.Cleanup(func() { c.Close(); s.Close() })
		client, _ = connAddrPort(s.RemoteAddr())
		server, _ = connAddrPort(s.LocalAddr())
	}
	return client, server
}

// About 4 000 rows (WSL has 4 096 ephemeral ports): sock_diag looks one socket up, /proc lists them all.
func BenchmarkPeerOwnerSockDiag(b *testing.B) {
	client, server := benchConns(b, 2000)
	b.ResetTimer()
	for b.Loop() {
		if _, err := sockDiagOwner(client, server); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPeerOwnerProcNet(b *testing.B) {
	client, server := benchConns(b, 2000)
	b.ResetTimer()
	for b.Loop() {
		if _, err := procNetOwner(client, server); err != nil {
			b.Fatal(err)
		}
	}
}
