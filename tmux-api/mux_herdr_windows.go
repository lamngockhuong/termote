//go:build windows

package main

import (
	"context"
	"errors"
)

// newHerdrMux fails on Windows: herdr has no Windows build with an equivalent
// socket.
func newHerdrMux(context.Context, string) (Mux, error) {
	return nil, errors.New("TERMOTE_MUX=herdr is not supported on Windows")
}

func herdrSocketPath() string { return "" }

func isHerdrObserveCmdline(string) bool { return false }
