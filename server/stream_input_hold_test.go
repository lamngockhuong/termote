package main

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Keys sent as a stream opens wait until the terminal drew its first screen
// (an attach client not reading yet would drop them), then all reach it.
func TestStreamInputWaitsForFirstOutput(t *testing.T) {
	old := streamInputHold
	streamInputHold = 5 * time.Second
	t.Cleanup(func() { streamInputHold = old })
	s := newStreamServer(t)
	c := mustDial(t, s, "pane=0")
	ft := s.term(t, 0)
	ctx := context.Background()
	if err := c.Write(ctx, websocket.MessageBinary, []byte("early\r")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ft.inCh:
		t.Fatal("input reached the terminal before it drew anything")
	case <-time.After(200 * time.Millisecond):
	}
	ft.out <- []byte("$ ")
	select {
	case <-ft.inCh:
	case <-time.After(5 * time.Second):
		t.Fatal("held input never reached the terminal")
	}
	ft.mu.Lock()
	in := string(ft.in)
	ft.mu.Unlock()
	if in != "early\r" {
		t.Errorf("terminal got %q", in)
	}
}

// A terminal that never draws gets its input once the hold ends.
func TestStreamInputHoldEnds(t *testing.T) {
	old := streamInputHold
	streamInputHold = 100 * time.Millisecond
	t.Cleanup(func() { streamInputHold = old })
	s := newStreamServer(t)
	c := mustDial(t, s, "pane=0")
	ft := s.term(t, 0)
	if err := c.Write(context.Background(), websocket.MessageBinary, []byte("x")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ft.inCh:
	case <-time.After(5 * time.Second):
		t.Fatal("input of a silent terminal never went through")
	}
}
