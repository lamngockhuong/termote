package main

import (
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"
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

// A flood of lookups through the /proc tables (netlink blocked) while about
// 4 000 sockets are open: how long the owner's own lookup takes, against
// peerLookupTimeout (worst-ms, timeouts). "per-lookup" reads the tables for
// each lookup, as before they were shared.
func BenchmarkPeerLookupFloodProcNet(b *testing.B) {
	client, server := benchConns(b, 2000)
	perLookup := func(c, s netip.AddrPort) (string, error) {
		if uid, found, _ := readProcNet().owner(c, s); found {
			return uid, nil
		}
		return "", errPeerNotFound
	}
	for _, bc := range []struct {
		name  string
		owner func(netip.AddrPort, netip.AddrPort) (string, error)
	}{{"shared", procNetOwner}, {"per-lookup", perLookup}} {
		b.Run(bc.name, func(b *testing.B) {
			check := newTestPeerCheck(bc.owner)
			stop := make(chan struct{})
			var wg sync.WaitGroup
			for range 64 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for {
						select {
						case <-stop:
							return
						default:
							check.lookup(client, server)
						}
					}
				}()
			}
			var worst time.Duration
			timeouts := 0
			for b.Loop() {
				start := time.Now()
				if _, err := check.lookup(client, server); err != nil {
					timeouts++
				}
				worst = max(worst, time.Since(start))
			}
			close(stop)
			wg.Wait()
			b.ReportMetric(float64(worst.Milliseconds()), "worst-ms")
			b.ReportMetric(float64(timeouts), "timeouts")
		})
	}
}
