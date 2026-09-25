//go:build !windows

package main

import (
	"fmt"
	"net"
	"os"
)

// helperServeHerdr runs the real server on the herdr backend, against the
// fake herdr socket of the parent test and with this binary as the herdr CLI.
func helperServeHerdr() {
	herdrBin, _ = os.Executable()
	os.Setenv(helperEnv, "herdr-observe")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Println("ERR", err)
		os.Exit(1)
	}
	ctx, stop := signalContext()
	defer stop()
	m, _ := newHerdrMux(ctx, os.Getenv(herdrSocketEnv))
	fmt.Printf("ADDR=%s\n", ln.Addr())
	cfg := serveConfig{PWADir: os.TempDir(), TTYDUrl: "http://127.0.0.1:1", NoAuth: true, MuxBackend: "herdr", HerdrAllowNoAuth: true}
	if err := runServer(ctx, cfg, m, ln); err != nil {
		fmt.Println("ERR", err)
		os.Exit(1)
	}
}
