package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// Environment of the fake `herdr terminal session observe`.
const (
	herdrSocketEnv    = "TERMOTE_TEST_HERDR_SOCKET"  // serve-herdr: fake server socket
	observePIDFileEnv = "TERMOTE_TEST_OBSERVE_PIDS"  // appends its pid here
	observeCloseEnv   = "TERMOTE_TEST_OBSERVE_CLOSE" // reports the pane closed
)

// helperHerdrObserve stands in for `herdr terminal session observe <pane>
// --cols W --rows H`: it prints one full frame naming its arguments, then
// either reports the pane closed or waits to be killed.
func helperHerdrObserve() {
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
