package main

import (
	"strconv"
	"strings"
	"testing"
)

// The bridge is a pipe of its own beside the CLI's, named after the port
// with -bridge, open to the current user only, and a second server on the
// port cannot take its name.
func TestBridgePipe(t *testing.T) {
	const port = 47914
	name := bridgeSocketName(strconv.Itoa(port))
	pipe, err := localPipeName(name)
	if err != nil || !strings.HasSuffix(pipe, "-47914-bridge") || len(pipe) > 256 {
		t.Fatalf("bridge pipe name %q, %v", pipe, err)
	}
	ln, cleanup, err := openLocalSocket("", name)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	defer ln.Close()
	if _, _, err := openLocalSocket("", name); err == nil {
		t.Error("a second bridge pipe of the same name was created")
	}
	go func() {
		if c, err := ln.Accept(); err == nil {
			c.Close()
		}
	}()
	c, err := dialBridgeServer("", port)
	if err != nil {
		t.Fatalf("own bridge pipe: %v", err)
	}
	c.Close()
}
