package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"sync"
	"testing"
	"time"
)

// fakeHcCall is one request the fake core received.
type fakeHcCall struct {
	Method string
	Params json.RawMessage
}

// fakeHcHandler answers one request; it writes its own reply (reply or
// replyError), so it can send stream frames before or after it.
type fakeHcHandler func(f *fakeHcCore, id uint64, params json.RawMessage)

// fakeHcCore is herdr-core's side of a framed connection, in process: it
// answers hello in plain mode, then JSON-RPC on channel 0 with handlers,
// keeps each stream's credit as the real core does (wire.rs) and records
// what the client sent.
type fakeHcCore struct {
	t     *testing.T
	in    *bufio.Reader // what the client writes
	out   io.Writer     // what the client reads
	hello map[string]any

	wmu sync.Mutex

	mu       sync.Mutex
	cond     *sync.Cond
	handlers map[string]fakeHcHandler
	calls    []fakeHcCall
	credit   map[uint32]int       // bytes the core may still send per channel
	frames   map[uint32][]hcFrame // frames the client sent per channel (not CREDIT)
	nextChan uint32
	closed   bool
}

func newFakeHcHello() map[string]any {
	return map[string]any{
		"generation": 1, "version": "0.1.16", "framed": true,
		"features": []string{"framed", "attach", "events", "status", "shell"},
		"core":     map[string]any{"id": "c0ffee", "name": "box"},
	}
}

// startFakeHc connects a client to a new fake core through pipes.
func startFakeHc(t *testing.T, setup func(f *fakeHcCore)) (*fakeHcCore, *hcConn) {
	t.Helper()
	cr, cw := io.Pipe() // client → core
	sr, sw := io.Pipe() // core → client
	f := newFakeHcCore(t, cr, sw)
	if setup != nil {
		setup(f)
	}
	go f.serve()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := newHcConn(ctx, cw, sr, nil)
	if err != nil {
		t.Fatalf("newHcConn: %v", err)
	}
	t.Cleanup(func() {
		c.close()
		sw.Close()
		cr.Close()
	})
	return f, c
}

func newFakeHcCore(t *testing.T, in io.Reader, out io.Writer) *fakeHcCore {
	f := &fakeHcCore{
		t: t, in: bufio.NewReader(in), out: out, hello: newFakeHcHello(),
		handlers: map[string]fakeHcHandler{},
		credit:   map[uint32]int{},
		frames:   map[uint32][]hcFrame{},
	}
	f.cond = sync.NewCond(&f.mu)
	return f
}

func (f *fakeHcCore) handle(method string, h fakeHcHandler) {
	f.mu.Lock()
	f.handlers[method] = h
	f.mu.Unlock()
}

// result answers method with a fixed result.
func (f *fakeHcCore) result(method string, result any) {
	f.handle(method, func(f *fakeHcCore, id uint64, _ json.RawMessage) { f.reply(id, result) })
}

// serve runs the connection: hello, then frames until the client leaves.
func (f *fakeHcCore) serve() {
	defer func() {
		f.mu.Lock()
		f.closed = true
		f.cond.Broadcast()
		f.mu.Unlock()
	}()
	line, err := f.in.ReadBytes('\n')
	if err != nil {
		return
	}
	var req struct {
		ID     uint64          `json:"id"`
		Params json.RawMessage `json:"params"`
	}
	json.Unmarshal(line, &req)
	f.mu.Lock()
	f.calls = append(f.calls, fakeHcCall{"hello", req.Params})
	hello := f.hello
	f.mu.Unlock()
	if e, ok := hello["error"]; ok {
		f.writeRaw(mustJSON(map[string]any{"error": e}))
		return
	}
	f.writeRaw(mustJSON(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": hello}))
	for {
		fr, err := readHcFrame(f.in)
		if err != nil {
			return
		}
		if fr.channel == 0 {
			var r struct {
				ID     uint64          `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if json.Unmarshal(fr.payload, &r) != nil {
				continue
			}
			f.mu.Lock()
			f.calls = append(f.calls, fakeHcCall{r.Method, r.Params})
			h := f.handlers[r.Method]
			f.mu.Unlock()
			if h == nil {
				f.replyError(r.ID, "not_found", "no such method")
				continue
			}
			go h(f, r.ID, r.Params)
			continue
		}
		f.mu.Lock()
		if fr.kind == hcKindCredit && len(fr.payload) == 4 {
			f.credit[fr.channel] += int(binary.LittleEndian.Uint32(fr.payload))
		} else {
			f.frames[fr.channel] = append(f.frames[fr.channel], fr)
		}
		f.cond.Broadcast()
		f.mu.Unlock()
	}
}

func (f *fakeHcCore) writeRaw(line []byte) {
	f.wmu.Lock()
	defer f.wmu.Unlock()
	f.out.Write(append(line, '\n'))
}

func (f *fakeHcCore) frame(channel uint32, kind byte, payload []byte) {
	f.wmu.Lock()
	defer f.wmu.Unlock()
	f.out.Write(encodeHcFrame(channel, kind, payload))
}

func (f *fakeHcCore) reply(id uint64, result any) {
	f.frame(0, hcKindData, mustJSON(map[string]any{"jsonrpc": "2.0", "id": id, "result": result}))
}

func (f *fakeHcCore) replyError(id uint64, kind, msg string) {
	f.frame(0, hcKindData, mustJSON(map[string]any{"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": -32000, "message": msg, "data": map[string]any{"kind": kind, "hint": "h"}}}))
}

// openChannel allocates a stream channel with the starting window.
func (f *fakeHcCore) openChannel() uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextChan++
	f.credit[f.nextChan] = hcWindow
	return f.nextChan
}

// send writes b on channel as DATA in 16 KiB chunks, waiting for credit
// like the core. It returns false if the client left.
func (f *fakeHcCore) send(channel uint32, b []byte) bool {
	for len(b) > 0 {
		f.mu.Lock()
		for f.credit[channel] == 0 && !f.closed {
			f.cond.Wait()
		}
		if f.closed {
			f.mu.Unlock()
			return false
		}
		n := min(len(b), f.credit[channel], 16*1024)
		f.credit[channel] -= n
		f.mu.Unlock()
		f.frame(channel, hcKindData, b[:n])
		b = b[n:]
	}
	return true
}

// closeChannel ends a stream with a reason.
func (f *fakeHcCore) closeChannel(channel uint32, reason string) {
	f.frame(channel, hcKindClose, mustJSON(map[string]any{"reason": reason, "exit_code": 0}))
}

// event writes one event line on an events channel.
func (f *fakeHcCore) event(channel uint32, method string, params any) {
	f.send(channel, append(mustJSON(map[string]any{"jsonrpc": "2.0", "method": method, "params": params}), '\n'))
}

// waitFrames waits until the client sent at least n frames on channel.
func (f *fakeHcCore) waitFrames(channel uint32, n int) []hcFrame {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	f.mu.Lock()
	defer f.mu.Unlock()
	for len(f.frames[channel]) < n {
		if time.Now().After(deadline) {
			f.t.Fatalf("channel %d: %d frames, want %d", channel, len(f.frames[channel]), n)
		}
		f.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
		f.mu.Lock()
	}
	return append([]hcFrame(nil), f.frames[channel]...)
}

func (f *fakeHcCore) callsOf(method string) []fakeHcCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeHcCall
	for _, c := range f.calls {
		if c.Method == method {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeHcCore) allCalls() []fakeHcCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeHcCall(nil), f.calls...)
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// Environment of the fake `hc connect` child (helperHcConnect).
const (
	hcFakeEnvFile = "TERMOTE_TEST_HC_ENV"  // writes its environment here
	hcFakeMode    = "TERMOTE_TEST_HC_MODE" // "error": prints an error, exits
	hcFakeArgs    = "TERMOTE_TEST_HC_ARGS" // writes its arguments here
)

// helperHcConnect stands in for `hc connect`: it records its arguments and
// environment, writes a line on stderr, then serves a fake core on
// stdin/stdout that answers server.status.
func helperHcConnect() {
	if p := os.Getenv(hcFakeArgs); p != "" {
		os.WriteFile(p, mustJSON(os.Args[1:]), 0o600)
	}
	if p := os.Getenv(hcFakeEnvFile); p != "" {
		os.WriteFile(p, mustJSON(os.Environ()), 0o600)
	}
	os.Stderr.WriteString("fake hc connect \x1b[31mstarted\n")
	if os.Getenv(hcFakeMode) == "error" {
		os.Stdout.WriteString(`{"error":{"kind":"unavailable","message":"cannot start core","hint":"h"}}` + "\n")
		os.Exit(1)
	}
	f := newFakeHcCore(nil, os.Stdin, os.Stdout)
	f.result("server.status", map[string]any{"version": "0.1.16", "pid": 1})
	f.serve()
	os.Exit(0)
}
