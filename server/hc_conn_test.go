package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHcFrameCodec(t *testing.T) {
	for _, n := range []int{0, 1, 4096, hcFrameMaxPayload} {
		payload := bytes.Repeat([]byte{'x'}, n)
		f, err := readHcFrame(bytes.NewReader(encodeHcFrame(7, hcKindData, payload)))
		if err != nil || f.channel != 7 || f.kind != hcKindData || len(f.payload) != n {
			t.Fatalf("%d bytes: %+v %v", n, f.channel, err)
		}
	}
	over := encodeHcFrame(1, hcKindData, nil)
	over[5], over[6], over[7], over[8] = 0x01, 0x00, 0x00, 0x01 // 16 MiB + 1
	if _, err := readHcFrame(bytes.NewReader(over)); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized frame: %v", err)
	}
	cut := encodeHcFrame(1, hcKindData, []byte("hello"))
	if _, err := readHcFrame(bytes.NewReader(cut[:len(cut)-2])); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("cut payload: %v", err)
	}
	if _, err := readHcFrame(bytes.NewReader(nil)); !errors.Is(err, io.EOF) {
		t.Fatalf("clean end: %v", err)
	}
	if c, r, ok := parseHcSize(hcSizePayload(80, 24)); !ok || c != 80 || r != 24 {
		t.Fatalf("size round trip: %d %d %v", c, r, ok)
	}
	if c, r, _ := parseHcSize(hcSizePayload(70000, -1)); c != 0xffff || r != 0 {
		t.Fatalf("size clamp: %d %d", c, r)
	}
	if _, _, ok := parseHcSize([]byte{1, 2, 3}); ok {
		t.Fatal("short RESIZE accepted")
	}
}

func TestHcHelloRefusals(t *testing.T) {
	for _, tc := range []struct {
		name  string
		edit  func(h map[string]any)
		check func(error) bool
	}{
		{"generation 2", func(h map[string]any) { h["generation"] = 2 }, func(e error) bool { return errors.Is(e, errHcUnsupported) }},
		{"too old", func(h map[string]any) { h["version"] = "0.1.15" }, func(e error) bool { return errors.Is(e, errHcTooOld) }},
		{"bad version", func(h map[string]any) { h["version"] = "dev" }, func(e error) bool { return errors.Is(e, errHcTooOld) }},
		{"no attach", func(h map[string]any) { h["features"] = []string{"events"} }, func(e error) bool { return strings.Contains(e.Error(), "attach") }},
		{"no events", func(h map[string]any) { h["features"] = []string{"attach"} }, func(e error) bool { return strings.Contains(e.Error(), "events") }},
		{"not framed", func(h map[string]any) { h["framed"] = false }, func(e error) bool { return strings.Contains(e.Error(), "framed") }},
		{"connect error", func(h map[string]any) {
			h["error"] = map[string]any{"kind": "unavailable", "message": "cannot start core"}
		}, func(e error) bool { return hcErrorKind(e) == "unavailable" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cr, cw := io.Pipe()
			sr, sw := io.Pipe()
			defer cr.Close()
			defer sw.Close()
			f := newFakeHcCore(t, cr, sw)
			tc.edit(f.hello)
			go f.serve()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err := newHcConn(ctx, cw, sr, nil)
			if err == nil || !tc.check(err) {
				t.Fatalf("err = %v", err)
			}
		})
	}
	// A newer patch release is fine.
	cr, cw := io.Pipe()
	sr, sw := io.Pipe()
	defer cr.Close()
	defer sw.Close()
	f := newFakeHcCore(t, cr, sw)
	f.hello["version"] = "0.2.0"
	go f.serve()
	c, err := newHcConn(context.Background(), cw, sr, nil)
	if err != nil {
		t.Fatal(err)
	}
	c.close()
	var hello struct {
		Generation int  `json:"generation"`
		Framed     bool `json:"framed"`
	}
	json.Unmarshal(f.callsOf("hello")[0].Params, &hello)
	if hello.Generation != 1 || !hello.Framed {
		t.Fatalf("hello params %+v", hello)
	}
}

func TestHcHelloTimesOut(t *testing.T) {
	cr, cw := io.Pipe()
	sr, sw := io.Pipe()
	defer sw.Close()
	go io.Copy(io.Discard, cr) // reads hello, never answers
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := newHcConn(ctx, cw, sr, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}

func TestHcCallsRunSideBySide(t *testing.T) {
	f, c := startFakeHc(t, func(f *fakeHcCore) {
		f.handle("terminal.get", func(f *fakeHcCore, id uint64, params json.RawMessage) {
			var p struct{ Terminal string }
			json.Unmarshal(params, &p)
			time.Sleep(time.Duration(rand.Intn(20)) * time.Millisecond)
			f.reply(id, map[string]any{"address": p.Terminal, "labels": map[string]string{}})
		})
	})
	var wg sync.WaitGroup
	var bad atomic.Int32
	for i := 1; i <= 30; i++ {
		wg.Add(1)
		go func(addr string) {
			defer wg.Done()
			var got hcTerminal
			if err := c.call(context.Background(), hcGetParams{addr}, &got); err != nil || got.Address != addr {
				bad.Add(1)
			}
		}(fmt.Sprintf("t%d", i%9+1))
	}
	wg.Wait()
	if bad.Load() != 0 || len(f.callsOf("terminal.get")) != 30 {
		t.Fatalf("%d wrong replies, %d calls", bad.Load(), len(f.callsOf("terminal.get")))
	}
}

func TestHcRPCErrorKeepsKind(t *testing.T) {
	_, c := startFakeHc(t, func(f *fakeHcCore) {
		f.handle("terminal.kill", func(f *fakeHcCore, id uint64, _ json.RawMessage) { f.replyError(id, "not_found", "no terminal t9") })
	})
	err := c.call(context.Background(), hcKillParams{"t9"}, nil)
	if hcErrorKind(err) != "not_found" || !strings.Contains(err.Error(), "no terminal t9") {
		t.Fatalf("err = %v", err)
	}
	if hcErrorKind(errors.New("x")) != "" {
		t.Fatal("kind of a plain error")
	}
	// A method the fake does not know is answered not_found too.
	if err := c.call(context.Background(), hcStatusParams{}, nil); hcErrorKind(err) != "not_found" {
		t.Fatalf("err = %v", err)
	}
}

func TestHcCallTimesOut(t *testing.T) {
	_, c := startFakeHc(t, func(f *fakeHcCore) {
		f.handle("server.status", func(*fakeHcCore, uint64, json.RawMessage) {})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := c.call(ctx, hcStatusParams{}, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	c.mu.Lock()
	n := len(c.pending)
	c.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d pending calls left", n)
	}
}

func TestHcAddressCheck(t *testing.T) {
	for _, good := range []string{"t1", "t7", "t1b", "t9zzzz", "t10"} {
		if !validHcAddress(good) {
			t.Errorf("%q refused", good)
		}
	}
	for _, bad := range []string{"", "t", "t0", "t01", "T7", "m/t7", "box/t7", "reviewer", "t7/", "t7a", "t7 ", "t1" + strings.Repeat("z", 20), "t7\n"} {
		if validHcAddress(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

// Every refused call fails before anything is written to the core.
func TestHcRefusedCallsNeverReachTheCore(t *testing.T) {
	f, c := startFakeHc(t, nil)
	refused := []hcParams{
		hcGetParams{"m/t7"}, hcGetParams{"reviewer"}, hcKillParams{"t0"}, hcKillParams{"box/t1"},
		hcReadParams{"t7", -1}, hcReadParams{"name", 10}, hcLabelParams{Terminal: "x/t7", Seen: 1},
		hcAttachParams{Terminal: "t7", Cols: 0, Rows: 24}, hcAttachParams{Terminal: "t7", Cols: 80, Rows: 70000},
		hcAttachParams{Terminal: "rohan/t7", Cols: 80, Rows: 24},
		hcRunParams{Space: "", Tab: "tb1"}, hcRunParams{Space: "sp1", Tab: "tb\x1b[31m"},
		hcRunParams{Space: "sp1", Tab: "tb\u202e"}, hcRunParams{Space: strings.Repeat("s", 129), Tab: "tb"},
		hcRunParams{Space: "sp", Tab: "tb", Cwd: "relative/dir"}, hcRunParams{Space: "sp", Tab: "tb\xff"},
	}
	for _, p := range refused {
		if err := c.call(context.Background(), p, nil); err == nil {
			t.Errorf("%T %+v accepted", p, p)
		}
	}
	if calls := f.allCalls(); len(calls) != 1 { // hello only
		t.Fatalf("calls reached the core: %+v", calls)
	}
}

// The params types are the allowlist: only these methods exist, and the
// free-form ones (labels, run) marshal only the fields termote may send.
func TestHcAllowlist(t *testing.T) {
	allowed := map[string]bool{
		"server.status": true, "terminal.list": true, "terminal.get": true, "terminal.run": true,
		"terminal.kill": true, "terminal.label": true, "terminal.read": true, "terminal.attach": true,
		"events.subscribe": true, "doc.get": true, "doc.set": true,
	}
	for _, p := range []hcParams{hcStatusParams{}, hcListParams{}, hcGetParams{}, hcRunParams{}, hcKillParams{},
		hcLabelParams{}, hcReadParams{}, hcAttachParams{}, hcSubscribeParams{}, hcDocGetParams{},
		hcDocSetParams{}} {
		if !allowed[p.hcMethod()] {
			t.Errorf("%T calls %s", p, p.hcMethod())
		}
		p.hcCheck() // the zero value: no panic
	}
	got := map[string]any{}
	json.Unmarshal(mustJSON(hcLabelParams{Terminal: "t7", Seen: 12}), &got)
	if !reflect.DeepEqual(got, map[string]any{"terminal": "t7", "labels": map[string]any{"herdr.seen": "12"}}) {
		t.Errorf("label params %v", got)
	}
	got = map[string]any{}
	json.Unmarshal(mustJSON(hcRunParams{Cwd: "/home/u/p", Space: "sp1", Tab: "tb1"}), &got)
	want := map[string]any{"cwd": "/home/u/p", "keep": true,
		"labels": map[string]any{"herdr.space": "sp1", "herdr.tab": "tb1", "herdr.seen": "0"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("run params %v", got)
	}
	got = map[string]any{}
	json.Unmarshal(mustJSON(hcRunParams{Space: "sp1", Tab: "tb1"}), &got)
	if _, ok := got["cwd"]; ok {
		t.Errorf("empty cwd sent: %v", got)
	}
	if string(mustJSON(hcDocGetParams{})) != `{"name":"herdr-app"}` {
		t.Error("doc.get reads another document")
	}
	for _, p := range []string{`C:\Users\u`, `c:/x`, `\\server\share`, "/"} {
		if !isAbsAnyOS(p) {
			t.Errorf("%q not absolute", p)
		}
	}
	for _, p := range []string{"", "x", "C:", "C:x", "1:/x", "~/x"} {
		if isAbsAnyOS(p) {
			t.Errorf("%q absolute", p)
		}
	}
}

// subscribeFake makes events.subscribe open a channel; before, if set,
// writes frames on it ahead of the reply.
func subscribeFake(f *fakeHcCore, ready chan<- uint32, before func(f *fakeHcCore, ch uint32)) {
	f.handle("events.subscribe", func(f *fakeHcCore, id uint64, _ json.RawMessage) {
		ch := f.openChannel()
		if before != nil {
			before(f, ch)
		}
		f.reply(id, map[string]any{"seq": 5, "terminals": []any{map[string]any{"address": "t1", "labels": map[string]string{}, "argv": []string{"secret"}}}, "channel": ch})
		ready <- ch
	})
}

func TestHcEventsPastTheWindowAndCutLines(t *testing.T) {
	ready := make(chan uint32, 1)
	f, c := startFakeHc(t, func(f *fakeHcCore) {
		subscribeFake(f, ready, func(f *fakeHcCore, ch uint32) {
			// Ahead of the reply, and a line cut across two frames.
			f.frame(ch, hcKindData, []byte(`{"jsonrpc":"2.0","method":"event","params":{"seq":6,"type":"ti`))
			f.frame(ch, hcKindData, []byte(`tle","terminal":"t1","data":{"title":"a"}}}`+"\n"))
		})
	})
	sub, err := c.subscribeEvents(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sub.Seq != 5 || len(sub.Terminals) != 1 || sub.Terminals[0].Address != "t1" {
		t.Fatalf("snapshot %+v", sub)
	}
	ch := <-ready
	const n = 2000 // ~1 MiB of lines, four windows
	pad := strings.Repeat("x", 500)
	go func() {
		for i := 0; i < n; i++ {
			f.event(ch, "event", map[string]any{"seq": 7 + i, "type": "title", "terminal": "t1", "data": map[string]any{"title": pad}})
		}
		f.event(ch, "heartbeat", map[string]any{"seq": 7 + n})
	}()
	var events, seqs atomic.Int64
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- sub.run(ctx, func(l hcEventLine) {
			var p struct{ Seq int64 }
			json.Unmarshal(l.Params, &p)
			if l.Method == "event" {
				if events.Add(1) == 1 && p.Seq != 6 {
					t.Errorf("first event seq %d", p.Seq)
				}
			}
			if l.Method == "heartbeat" {
				seqs.Store(p.Seq)
				cancel()
			}
		})
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("stalled after %d events", events.Load())
	}
	if events.Load() != n+1 || seqs.Load() != 7+n {
		t.Fatalf("%d events, heartbeat %d", events.Load(), seqs.Load())
	}
	// run closed the channel: the core was told.
	frames := f.waitFrames(ch, 1)
	if frames[len(frames)-1].kind != hcKindClose {
		t.Fatalf("last frame kind %d", frames[len(frames)-1].kind)
	}
}

func TestHcEventsStallAndEnd(t *testing.T) {
	ready := make(chan uint32, 1)
	f, c := startFakeHc(t, func(f *fakeHcCore) { subscribeFake(f, ready, nil) })
	sub, err := c.subscribeEvents(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	<-ready
	sub.stall = 50 * time.Millisecond
	if err := sub.run(context.Background(), func(hcEventLine) {}); !errors.Is(err, errHcEventsStalled) {
		t.Fatalf("silent channel: %v", err)
	}
	// A channel the core closes ends run with its reason.
	sub, _ = c.subscribeEvents(context.Background())
	ch := <-ready
	f.closeChannel(ch, "server_stop")
	var closed *hcClosed
	if err := sub.run(context.Background(), func(hcEventLine) {}); !errors.As(err, &closed) || closed.final() {
		t.Fatalf("closed channel: %v", err)
	}
	// So does a lost connection.
	sub, _ = c.subscribeEvents(context.Background())
	<-ready
	go func() { time.Sleep(20 * time.Millisecond); c.close() }()
	if err := sub.run(context.Background(), func(hcEventLine) {}); !errors.Is(err, errHcLost) {
		t.Fatalf("lost: %v", err)
	}
	if _, err := c.subscribeEvents(context.Background()); !errors.Is(err, errHcLost) {
		t.Fatalf("subscribe on a lost connection: %v", err)
	}
}

// attachFake makes terminal.attach open a channel and hand it to the test.
func attachFake(f *fakeHcCore, ready chan<- uint32) {
	f.handle("terminal.attach", func(f *fakeHcCore, id uint64, _ json.RawMessage) {
		ch := f.openChannel()
		f.reply(id, map[string]any{"channel": ch, "resize_notifications": true, "terminal": map[string]any{"address": "t7"}})
		ready <- ch
	})
}

func hcAttachChannel(t *testing.T, c *hcConn) *hcChannel {
	t.Helper()
	var res struct{ Channel uint32 }
	if err := c.call(context.Background(), hcAttachParams{Terminal: "t7", Cols: 80, Rows: 24}, &res); err != nil {
		t.Fatal(err)
	}
	ch, err := c.openChannel(res.Channel)
	if err != nil {
		t.Fatal(err)
	}
	return ch
}

func TestHcChannelCloseReasons(t *testing.T) {
	for _, tc := range []struct {
		reason string
		final  bool
	}{{"exited", true}, {"killed", true}, {"signaled", false}, {"holder_lost", false}, {"server_stop", false}, {"stopped_by_restart", false}} {
		t.Run(tc.reason, func(t *testing.T) {
			ready := make(chan uint32, 1)
			f, c := startFakeHc(t, func(f *fakeHcCore) { attachFake(f, ready) })
			ch := hcAttachChannel(t, c)
			id := <-ready
			f.send(id, []byte("paint"))
			f.frame(id, hcKindResize, hcSizePayload(100, 30))
			f.closeChannel(id, tc.reason)
			fr, err := ch.next(context.Background())
			if err != nil || string(fr.payload) != "paint" {
				t.Fatalf("first frame %q %v", fr.payload, err)
			}
			fr, _ = ch.next(context.Background())
			if cols, rows, _ := parseHcSize(fr.payload); fr.kind != hcKindResize || cols != 100 || rows != 30 {
				t.Fatalf("resize frame %+v", fr)
			}
			var closed *hcClosed
			if _, err := ch.next(context.Background()); !errors.As(err, &closed) || closed.final() != tc.final ||
				!strings.Contains(err.Error(), tc.reason) {
				t.Fatalf("close: %v", err)
			}
			// The DATA was credited: the window is whole again.
			waitFor(t, func() bool {
				f.mu.Lock()
				defer f.mu.Unlock()
				return f.credit[id] == hcWindow
			})
		})
	}
}

func TestHcChannelLostAndDetached(t *testing.T) {
	ready := make(chan uint32, 1)
	f, c := startFakeHc(t, func(f *fakeHcCore) { attachFake(f, ready) })
	ch := hcAttachChannel(t, c)
	id := <-ready
	// Keys and a resize go out on the channel.
	if err := ch.send(hcKindData, []byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	ch.send(hcKindResize, hcSizePayload(90, 20))
	frames := f.waitFrames(id, 2)
	if string(frames[0].payload) != "ls\r" || frames[1].kind != hcKindResize {
		t.Fatalf("frames %+v", frames)
	}
	// Detaching sends CLOSE; what the core still sends is dropped, not held.
	ch.close()
	ch.close()
	frames = f.waitFrames(id, 3)
	if frames[2].kind != hcKindClose || len(frames) != 3 {
		t.Fatalf("frames after close %+v", frames)
	}
	f.frame(id, hcKindData, []byte("late"))
	f.frame(id, hcKindClose, nil)
	if _, err := ch.next(context.Background()); !errors.Is(err, io.EOF) {
		t.Fatalf("next after close: %v", err)
	}
	ch2 := hcAttachChannel(t, c)
	<-ready
	waitFor(t, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		_, closing := c.closing[id]
		return !closing && len(c.early) == 0
	})
	// A context ends a wait.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := ch2.next(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("next: %v", err)
	}
	c.close()
	if _, err := ch2.next(context.Background()); !errors.Is(err, errHcLost) {
		t.Fatalf("lost: %v", err)
	}
	if err := ch2.send(hcKindData, []byte("x")); !errors.Is(err, errHcLost) {
		t.Fatalf("send on lost: %v", err)
	}
	if err := c.call(context.Background(), hcStatusParams{}, nil); !errors.Is(err, errHcLost) {
		t.Fatalf("call on lost: %v", err)
	}
	if _, err := c.openChannel(9); !errors.Is(err, errHcLost) {
		t.Fatalf("open on lost: %v", err)
	}
}

func TestHcProtocolViolationsEndTheConnection(t *testing.T) {
	t.Run("oversized frame", func(t *testing.T) {
		f, c := startFakeHc(t, nil)
		h := encodeHcFrame(3, hcKindData, nil)
		h[8] = 0x02 // 32 MiB
		f.wmu.Lock()
		f.out.Write(h)
		f.wmu.Unlock()
		waitFor(t, func() bool { return !c.alive() })
	})
	t.Run("uncredited flood before open", func(t *testing.T) {
		f, c := startFakeHc(t, nil)
		chunk := bytes.Repeat([]byte{'a'}, 16*1024)
		// The client stops reading once it fails: write from aside.
		go func() {
			for i := 0; i < hcWindow/len(chunk)+2; i++ {
				f.frame(4, hcKindData, chunk)
			}
		}()
		waitFor(t, func() bool { return !c.alive() })
	})
	t.Run("garbage on channel 0 is ignored", func(t *testing.T) {
		f, c := startFakeHc(t, func(f *fakeHcCore) { f.result("server.status", map[string]any{}) })
		f.frame(0, hcKindData, []byte("not json"))
		f.frame(0, hcKindCredit, hcU32(1))
		f.frame(0, hcKindData, []byte(`{"jsonrpc":"2.0","method":"note"}`))
		if err := c.call(context.Background(), hcStatusParams{}, nil); err != nil {
			t.Fatal(err)
		}
	})
}

// A channel closed by the core before its reply was handled is opened
// already ended.
func TestHcChannelEndedBeforeOpen(t *testing.T) {
	ready := make(chan uint32, 1)
	_, c := startFakeHc(t, func(f *fakeHcCore) {
		f.handle("terminal.attach", func(f *fakeHcCore, id uint64, _ json.RawMessage) {
			ch := f.openChannel()
			f.send(ch, []byte("last screen"))
			f.closeChannel(ch, "exited")
			f.reply(id, map[string]any{"channel": ch})
			ready <- ch
		})
	})
	var res struct{ Channel uint32 }
	c.call(context.Background(), hcAttachParams{Terminal: "t7", Cols: 80, Rows: 24}, &res)
	<-ready
	time.Sleep(20 * time.Millisecond) // the CLOSE frame is read after the reply
	ch, err := c.openChannel(res.Channel)
	if err != nil {
		t.Fatal(err)
	}
	if fr, err := ch.next(context.Background()); err != nil || string(fr.payload) != "last screen" {
		t.Fatalf("%q %v", fr.payload, err)
	}
	var closed *hcClosed
	if _, err := ch.next(context.Background()); !errors.As(err, &closed) || !closed.final() {
		t.Fatalf("close: %v", err)
	}
	c.mu.Lock()
	_, registered := c.chans[res.Channel]
	c.mu.Unlock()
	if registered {
		t.Fatal("an ended channel stays registered")
	}
}

func TestHcStderrIsLoggedSafely(t *testing.T) {
	if got := truncateBytes([]byte("a\x1b[31mb\xff"+strings.Repeat("c", 600)), 10); got != "a [31mb?cc" {
		t.Fatalf("%q", got)
	}
}

// A call that timed out leaves no channel behind: the late reply's channel
// is closed and its frames dropped.
func TestHcLateReplyClosesItsChannel(t *testing.T) {
	release := make(chan struct{})
	opened := make(chan uint32, 1)
	f, c := startFakeHc(t, func(f *fakeHcCore) {
		f.handle("terminal.attach", func(f *fakeHcCore, id uint64, _ json.RawMessage) {
			<-release
			ch := f.openChannel()
			f.send(ch, []byte("paint"))
			f.reply(id, map[string]any{"channel": ch})
			opened <- ch
		})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := c.call(ctx, hcAttachParams{Terminal: "t7", Cols: 80, Rows: 24}, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	close(release)
	ch := <-opened
	frames := f.waitFrames(ch, 1)
	if frames[0].kind != hcKindClose {
		t.Fatalf("frames %+v", frames)
	}
	f.frame(ch, hcKindData, []byte("more"))
	f.frame(ch, hcKindClose, nil)
	waitFor(t, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		_, closing := c.closing[ch]
		return len(c.early) == 0 && !closing
	})
}
