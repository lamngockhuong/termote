//go:build windows

package main

import (
	"net"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

// listenHerdrTest listens where herdr would: the named pipe of path.
func listenHerdrTest(t *testing.T, path string) net.Listener {
	t.Helper()
	ln, err := winio.ListenPipe(herdrPipeName(path), nil)
	if err != nil {
		t.Fatal(err)
	}
	return retryCloseListener{ln}
}

// retryCloseListener repeats Close until go-winio's listener has stopped.
// That listener loses a close request that arrives while an Accept is
// connecting, when the connect then ends in an error other than a closed
// handle (makeConnectedServerPipe in go-winio's pipe.go): its routine loops
// again, the pipe stays open and Close waits forever. A second request, sent
// once the fake server's accept loop is waiting again, is taken. Only the
// test's fake server listens; termote itself only dials.
type retryCloseListener struct{ net.Listener }

func (l retryCloseListener) Close() error {
	done := make(chan error, 1)
	go func() { done <- l.Listener.Close() }()
	for {
		select {
		case err := <-done:
			return err
		case <-time.After(500 * time.Millisecond):
			// The first Close still waits and returns once this one is taken.
			go l.Listener.Close()
		}
	}
}
