package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Environment of the fake `herdr terminal session observe|control`.
const (
	herdrSocketEnv    = "TERMOTE_TEST_HERDR_SOCKET"   // serve-herdr: fake server socket
	observePIDFileEnv = "TERMOTE_TEST_OBSERVE_PIDS"   // appends its pid here
	observeCloseEnv   = "TERMOTE_TEST_OBSERVE_CLOSE"  // reports the pane closed
	observeNoTermEnv  = "TERMOTE_TEST_OBSERVE_NOTERM" // ignores SIGTERM
	// Directory where a test creates flag files while control runs; the
	// environment stays the same for the server's whole life, files do not.
	controlFlagDirEnv = "TERMOTE_TEST_CONTROL_FLAGS"
)

// Flag files control looks for in controlFlagDirEnv.
const (
	controlTakenOverFlag = "taken-over" // report a takeover and exit
	controlFailFlag      = "fail"       // exit 1 with an unknown reason
	controlNoStdinFlag   = "no-stdin"   // at start: never read stdin
)

// helperHerdrObserve stands in for `herdr terminal session observe <pane>
// --cols W --rows H` and `... control <pane> --takeover --cols W --rows H`:
// it prints one full frame naming its mode, pane and size, then observe
// either reports the pane closed or waits to be killed, and control follows
// its stdin (see helperHerdrControl). It records its pid only once SIGTERM is
// ignored, if asked to.
func helperHerdrObserve() {
	if os.Getenv(observeNoTermEnv) != "" {
		signal.Ignore(syscall.SIGTERM)
	}
	args := os.Args[1:]
	if f, err := os.OpenFile(os.Getenv(observePIDFileEnv), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		fmt.Fprintf(f, "%d\n", os.Getpid())
		f.Close()
	}
	var mode, pane, cols, rows string
	if len(args) > 4 {
		mode, pane = args[2], args[3]
	}
	for i := 4; i+1 < len(args); i++ {
		switch args[i] {
		case "--cols":
			cols = args[i+1]
		case "--rows":
			rows = args[i+1]
		}
	}
	enc := json.NewEncoder(os.Stdout)
	frame := func(cols, rows string) {
		enc.Encode(map[string]any{
			"type": "terminal.frame", "encoding": "ansi", "full": true, "seq": 1,
			"bytes": []byte(fmt.Sprintf("\x1b[2J\x1b[1;1H%s %s %sx%s\r\n", strings.ToUpper(mode), pane, cols, rows)),
		})
	}
	frame(cols, rows)
	if mode == "control" {
		helperHerdrControl(enc, frame)
	}
	if os.Getenv(observeCloseEnv) != "" {
		enc.Encode(map[string]any{"type": "terminal.closed", "reason": "pane closed"})
		os.Exit(0)
	}
	time.Sleep(5 * time.Minute)
}

// helperHerdrControl prints a frame at each terminal.resize read from stdin
// and exits "detached" when stdin closes, as herdr does. Flag files make it
// report a takeover or fail.
func helperHerdrControl(enc *json.Encoder, frame func(cols, rows string)) {
	dir := os.Getenv(controlFlagDirEnv)
	flag := func(name string) bool {
		_, err := os.Stat(filepath.Join(dir, name))
		return dir != "" && err == nil
	}
	var mu sync.Mutex
	closed := func(reason string, code int) {
		mu.Lock()
		enc.Encode(map[string]any{"type": "terminal.closed", "reason": reason})
		os.Exit(code)
	}
	if !flag(controlNoStdinFlag) {
		go func() {
			dec := json.NewDecoder(os.Stdin)
			for {
				var msg struct {
					Type string `json:"type"`
					Cols int    `json:"cols"`
					Rows int    `json:"rows"`
				}
				if dec.Decode(&msg) != nil {
					closed("detached", 0)
				}
				if msg.Type == "terminal.resize" {
					mu.Lock()
					frame(strconv.Itoa(msg.Cols), strconv.Itoa(msg.Rows))
					mu.Unlock()
				}
			}
		}()
	}
	for {
		switch {
		case flag(controlTakenOverFlag):
			closed("terminal attach taken over", 0)
		case flag(controlFailFlag):
			closed("something new", 1)
		}
		time.Sleep(20 * time.Millisecond)
	}
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
