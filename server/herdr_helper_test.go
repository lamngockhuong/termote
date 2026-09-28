package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Environment of the fake `herdr terminal session observe`.
const (
	herdrSocketEnv    = "TERMOTE_TEST_HERDR_SOCKET"   // serve-herdr: fake server socket
	observePIDFileEnv = "TERMOTE_TEST_OBSERVE_PIDS"   // appends its pid here
	observeCloseEnv   = "TERMOTE_TEST_OBSERVE_CLOSE"  // reports the pane closed
	observeNoTermEnv  = "TERMOTE_TEST_OBSERVE_NOTERM" // ignores SIGTERM
)

// helperHerdrObserve stands in for `herdr terminal session observe <pane>
// --cols W --rows H`: it prints one full frame naming its arguments, then
// either reports the pane closed or waits to be killed. It records its pid
// only once SIGTERM is ignored, if asked to.
func helperHerdrObserve() {
	if os.Getenv(observeNoTermEnv) != "" {
		signal.Ignore(syscall.SIGTERM)
	}
	args := os.Args[1:]
	if f, err := os.OpenFile(os.Getenv(observePIDFileEnv), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		fmt.Fprintf(f, "%d\n", os.Getpid())
		f.Close()
	}
	var pane, cols, rows string
	if len(args) == 8 {
		pane, cols, rows = args[3], args[5], args[7]
	}
	enc := json.NewEncoder(os.Stdout)
	enc.Encode(map[string]any{
		"type": "terminal.frame", "encoding": "ansi", "full": true, "seq": 1,
		"bytes": []byte(fmt.Sprintf("\x1b[2J\x1b[1;1HOBSERVE %s %sx%s\r\n", pane, cols, rows)),
	})
	if os.Getenv(observeCloseEnv) != "" {
		enc.Encode(map[string]any{"type": "terminal.closed", "reason": "pane closed"})
		os.Exit(0)
	}
	time.Sleep(5 * time.Minute)
}

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
	cfg := serveConfig{PWADir: os.TempDir(), NoAuth: true, MuxBackend: "herdr", HerdrAllowNoAuth: true}
	if err := runServer(ctx, cfg, m, ln); err != nil {
		fmt.Println("ERR", err)
		os.Exit(1)
	}
}
