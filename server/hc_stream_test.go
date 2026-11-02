package main

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

// hcSizes collects a stream's size frames as runStream would.
func hcSizes(t *testing.T, ts TermStream) <-chan sizeChange {
	out := make(chan sizeChange, 64)
	go func() {
		for c := range ts.(sizeReporter).Sizes() {
			out <- c
			close(c.sent)
		}
	}()
	return out
}

// hcNextSize is the next size frame, layout frames skipped.
func hcNextSize(t *testing.T, ch <-chan sizeChange) sizeChange {
	t.Helper()
	for {
		select {
		case c := <-ch:
			if !c.Layout {
				return c
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no size frame")
			return sizeChange{}
		}
	}
}

// hcNextLayout waits for a layout frame.
func hcNextLayout(t *testing.T, ch <-chan sizeChange) {
	t.Helper()
	for {
		select {
		case c := <-ch:
			if c.Layout {
				return
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no layout frame")
		}
	}
}

// readUntil reads the stream until its output holds want.
func hcReadUntil(t *testing.T, r io.Reader, want string) {
	t.Helper()
	done := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for !strings.Contains(b.String(), want) {
			n, err := r.Read(buf)
			b.Write(buf[:n])
			if err != nil {
				break
			}
		}
		done <- b.String()
	}()
	select {
	case got := <-done:
		if !strings.Contains(got, want) {
			t.Fatalf("output %q lacks %q", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("no %q", want)
	}
}

func (s *hcSim) lastAttach(t *testing.T, n int) hcSimAttach {
	t.Helper()
	waitFor(t, func() bool { return len(s.attachList()) >= n })
	return s.attachList()[n-1]
}

func TestHcStreamFullClient(t *testing.T) {
	old := hcLayoutSettle
	hcLayoutSettle = 10 * time.Millisecond
	defer func() { hcLayoutSettle = old }()
	s := newHcSim(t)
	ts, err := s.m.Attach(ctx5s(t), "t2", Size{Cols: 50, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	sizes := hcSizes(t, ts)
	// At the terminal's own size, as a viewer that can type.
	if c := hcNextSize(t, sizes); c.Size != (Size{80, 24}) || c.Driving {
		t.Fatalf("first size %+v", c)
	}
	a := s.lastAttach(t, 1)
	if a.Observe || a.Resize || a.Resumed || a.Cols != 80 || a.Rows != 24 {
		t.Fatalf("attach %+v", a)
	}
	hcReadUntil(t, ts, "screen of t2")

	ts.Write([]byte("ls\r"))
	frames := s.core.waitFrames(a.Channel, 1)
	if string(frames[0].payload) != "ls\r" {
		t.Fatalf("frames %+v", frames)
	}
	// The desktop resizes: the client is told; the next key sends that
	// size first, so typing keeps it.
	s.setSize("t2", 120, 40)
	if c := hcNextSize(t, sizes); c.Size != (Size{120, 40}) || c.Driving {
		t.Fatalf("resized %+v", c)
	}
	ts.Write([]byte("x"))
	frames = s.core.waitFrames(a.Channel, 3)
	if c, r, _ := parseHcSize(frames[1].payload); frames[1].kind != hcKindResize || c != 120 || r != 40 || string(frames[2].payload) != "x" {
		t.Fatalf("frames %+v", frames[1:])
	}

	// Drive: the client's size, then back to the terminal's.
	ts.Resize(Size{Cols: 90, Rows: 20})
	ts.(sizeDriver).Drive(true)
	if c := hcNextSize(t, sizes); c.Size != (Size{90, 20}) || !c.Driving {
		t.Fatalf("drive %+v", c)
	}
	ts.Resize(Size{Cols: 95, Rows: 21})
	frames = s.core.waitFrames(a.Channel, 5)
	if c, _, _ := parseHcSize(frames[3].payload); c != 90 {
		t.Fatalf("drive resize %+v", frames[3])
	}
	if c, _, _ := parseHcSize(frames[4].payload); c != 95 {
		t.Fatalf("client resize %+v", frames[4])
	}
	ts.(sizeDriver).Drive(true) // already driving: nothing
	ts.(sizeDriver).Drive(false)
	if c := hcNextSize(t, sizes); c.Size != (Size{120, 40}) || c.Driving {
		t.Fatalf("undrive %+v", c)
	}
	frames = s.core.waitFrames(a.Channel, 6)
	if c, r, _ := parseHcSize(frames[5].payload); c != 120 || r != 40 {
		t.Fatalf("given back %+v", frames[5])
	}

	// Another pane of the tab resizes: a layout frame.
	s.setSize("t1", 60, 40)
	hcNextLayout(t, sizes)

	// Lost for a while: attached again in the same stream.
	s.closeAttachs("t2", "server_stop", nil)
	if b := s.lastAttach(t, 2); !b.Resumed || b.Cols != 120 {
		t.Fatalf("again %+v", b)
	}
	hcNextSize(t, sizes)
	select {
	case <-ts.Done():
		t.Fatal("a lost attach ended the stream")
	default:
	}
	hcReadUntil(t, ts, "screen of t2")

	// The program exits: the stream ends with its code.
	code := 3
	s.closeAttachs("t2", "exited", &code)
	select {
	case <-ts.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not end")
	}
	if ts.ExitCode() != 3 {
		t.Fatalf("code %d", ts.ExitCode())
	}
}

func TestHcStreamWaitsForANewShell(t *testing.T) {
	s := newHcSim(t)
	ts, err := s.m.Attach(ctx5s(t), "t2", Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	sizes := hcSizes(t, ts)
	go io.Copy(io.Discard, ts)
	hcNextSize(t, sizes)
	s.lastAttach(t, 1)
	// Lost: the core refuses attaches until the new shell is up.
	s.mu.Lock()
	s.terms["t2"]["lost"] = true
	s.mu.Unlock()
	s.closeAttachs("t2", "signaled", nil)
	time.Sleep(100 * time.Millisecond)
	if n := len(s.attachList()); n != 1 {
		t.Fatalf("%d attaches while lost", n)
	}
	s.mu.Lock()
	delete(s.terms["t2"], "lost")
	s.mu.Unlock()
	s.emit("t2", "restarted", s.rec("t2"))
	if b := s.lastAttach(t, 2); !b.Resumed {
		t.Fatalf("again %+v", b)
	}
	// Killed: over, code 0; the terminal is gone from the state.
	s.m.ClosePane(ctx5s(t), "t1")
	if err := s.m.kill(ctx5s(t), mustConn(t, s.m), "t2", "sp1", ptr("tb1")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ts.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not end")
	}
	if ts.ExitCode() != 0 {
		t.Fatalf("code %d", ts.ExitCode())
	}
}

func mustConn(t *testing.T, m *hcMux) *hcConn {
	c, err := m.conn(ctx5s(t))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestHcStreamViewOnly(t *testing.T) {
	s := newHcSim(t)
	if !s.m.CanView(ctx5s(t)) {
		t.Fatal("cannot view")
	}
	ts, err := s.m.AttachView(ctx5s(t), "t4", Size{Cols: 40, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	sizes := hcSizes(t, ts)
	if c := hcNextSize(t, sizes); c.Size != (Size{80, 24}) {
		t.Fatalf("size %+v", c)
	}
	a := s.lastAttach(t, 1)
	if !a.Observe || !a.Resize {
		t.Fatalf("attach %+v", a)
	}
	hcReadUntil(t, ts, "screen of t4")
	// Nothing an observer sends could change the terminal.
	ts.Write([]byte("rm -rf /\r"))
	ts.(sizeDriver).Drive(true)
	ts.Resize(Size{Cols: 10, Rows: 5})
	// The core announces the terminal's new grid to an observer.
	s.core.frame(a.Channel, hcKindResize, hcSizePayload(100, 30))
	if c := hcNextSize(t, sizes); c.Size != (Size{100, 30}) || c.Driving {
		t.Fatalf("resize %+v", c)
	}
	ts.Close()
	frames := s.core.waitFrames(a.Channel, 1)
	if len(frames) != 1 || frames[0].kind != hcKindClose {
		t.Fatalf("an observer sent %+v", frames)
	}
	if _, err := s.m.Attach(ctx5s(t), "t5", Size{}); err != errUnknownPane {
		t.Fatalf("hidden: %v", err)
	}
}

// A stream closed before it ever started attaches nothing.
func TestHcStreamClosedEarly(t *testing.T) {
	s := newHcSim(t)
	ts, err := s.m.Attach(context.Background(), "t2", Size{})
	if err != nil {
		t.Fatal(err)
	}
	ts.Close()
	if n := len(s.attachList()); n != 0 {
		t.Fatalf("%d attaches", n)
	}
}

// Keys typed before the attach is up are typed once it is, in order.
func TestHcStreamQueuesEarlyInput(t *testing.T) {
	s := newHcSim(t)
	ts, err := s.m.Attach(ctx5s(t), "t2", Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	ts.Write([]byte("early "))
	ts.Write([]byte("keys\r"))
	if _, err := ts.Write(make([]byte, hcMaxQueuedInput)); err == nil {
		t.Fatal("queue past its limit")
	}
	sizes := hcSizes(t, ts)
	go io.Copy(io.Discard, ts)
	hcNextSize(t, sizes)
	a := s.lastAttach(t, 1)
	frames := s.core.waitFrames(a.Channel, 1)
	if len(frames) != 1 || string(frames[0].payload) != "early keys\r" {
		t.Fatalf("frames %+v", frames)
	}
}

// An observer is told the terminal's new size before the output after it.
func TestHcStreamResizeBeforeOutput(t *testing.T) {
	s := newHcSim(t)
	ts, err := s.m.AttachView(ctx5s(t), "t4", Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	sizes := hcSizes(t, ts)
	hcNextSize(t, sizes)
	a := s.lastAttach(t, 1)
	hcReadUntil(t, ts, "screen of t4")
	s.core.frame(a.Channel, hcKindResize, hcSizePayload(70, 20))
	s.core.send(a.Channel, []byte("after the resize"))
	hcReadUntil(t, ts, "after the resize")
	select {
	case c := <-sizes:
		if c.Size != (Size{70, 20}) {
			t.Fatalf("size %+v", c)
		}
	default:
		t.Fatal("output before its size")
	}
}

// Keys typed as the attach is lost wait for the next one.
func TestHcStreamRequeuesOnLoss(t *testing.T) {
	s := newHcSim(t)
	ts, err := s.m.Attach(ctx5s(t), "t2", Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	sizes := hcSizes(t, ts)
	go io.Copy(io.Discard, ts)
	hcNextSize(t, sizes)
	s.lastAttach(t, 1)
	st := ts.(*hcStream)
	st.mu.Lock()
	st.ch.conn.close() // the connection drops under the stream
	st.mu.Unlock()
	ts.Write([]byte("kept\r"))
	waitFor(t, func() bool { return len(s.attachList()) >= 2 })
	b := s.lastAttach(t, 2)
	frames := s.core.waitFrames(b.Channel, 1)
	if string(frames[0].payload) != "kept\r" {
		t.Fatalf("frames %+v", frames)
	}
}
