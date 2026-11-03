package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

// hcGeneration is the herdr-core protocol generation this client speaks: a
// core of another generation may have broken what this code relies on.
const hcGeneration = 1

// hcMinVersion is the oldest hc this backend was tested with: it reports
// size changes to observers (resize_notifications).
const hcMinVersion = "0.1.16"

// hcMaxEventLine bounds one line of the events channel: a `missed`
// notification carries a whole snapshot.
const hcMaxEventLine = hcFrameMaxPayload

// hcEventStall is how long the events channel may stay silent: the core sends
// a heartbeat every 15 s when no event is queued.
const hcEventStall = 45 * time.Second

var (
	// errHcLost: the connection to the core ended (hc connect exited, the
	// core stopped). Streams wait for a new one; it is not the end of a
	// terminal.
	errHcLost = errors.New("hc connection lost")
	// errHcUnsupported: the core speaks another protocol generation.
	errHcUnsupported = errors.New("hc speaks another protocol generation than termote (1); update termote or hc")
	// errHcTooOld: the core is older than hcMinVersion.
	errHcTooOld = errors.New("hc is older than " + hcMinVersion + "; run hc update")
	// errHcAddress: a terminal address that is not a local id (t7): a name,
	// another machine's terminal (m/t7) or garbage never reaches the core.
	errHcAddress = errors.New("not a local hc terminal id")
)

// hcRPCError is a JSON-RPC error from the core. Its text is logged only,
// never returned to a client.
type hcRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Kind string `json:"kind"`
		Hint string `json:"hint"`
	} `json:"data"`
}

func (e *hcRPCError) Error() string {
	return fmt.Sprintf("hc %s: %s", e.Data.Kind, e.Message)
}

// hcErrorKind is the stable kind of an hc error (not_found, conflict,
// unavailable, ...), or "".
func hcErrorKind(err error) string {
	var re *hcRPCError
	if errors.As(err, &re) {
		return re.Data.Kind
	}
	return ""
}

// hcIDSymbols are the digits of an hc terminal id after its t: base 30
// without vowels (herdr-core terminals.rs, SYMBOLS and id_shaped).
const hcIDSymbols = "0123456789bcdfghjkmnpqrstvwxyz"

// validHcAddress reports whether s is the id of a terminal on this machine:
// t, a digit 1-9, then id symbols. Names and machine/t7 addresses are not.
func validHcAddress(s string) bool {
	if len(s) < 2 || len(s) > 16 || s[0] != 't' || s[1] < '1' || s[1] > '9' {
		return false
	}
	for i := 2; i < len(s); i++ {
		if !strings.ContainsRune(hcIDSymbols, rune(s[i])) {
			return false
		}
	}
	return true
}

// hcParams is one allowed call: the method comes from the params' type, so
// only the methods and fields declared below can be sent. Each type checks
// its own fields before anything is written to the core.
type hcParams interface {
	hcMethod() string
	hcCheck() error
}

func checkHcTerminal(t string) error {
	if !validHcAddress(t) {
		return errHcAddress
	}
	return nil
}

type hcStatusParams struct{}

func (hcStatusParams) hcMethod() string { return "server.status" }
func (hcStatusParams) hcCheck() error   { return nil }

// hcListParams lists live terminals of every machine; the caller keeps only
// this machine's.
type hcListParams struct{}

func (hcListParams) hcMethod() string { return "terminal.list" }
func (hcListParams) hcCheck() error   { return nil }

type hcGetParams struct {
	Terminal string `json:"terminal"`
}

func (hcGetParams) hcMethod() string { return "terminal.get" }
func (p hcGetParams) hcCheck() error { return checkHcTerminal(p.Terminal) }

type hcKillParams struct {
	Terminal string `json:"terminal"`
}

func (hcKillParams) hcMethod() string { return "terminal.kill" }
func (p hcKillParams) hcCheck() error { return checkHcTerminal(p.Terminal) }

type hcReadParams struct {
	Terminal string `json:"terminal"`
	Lines    int    `json:"lines"`
}

func (hcReadParams) hcMethod() string { return "terminal.read" }
func (p hcReadParams) hcCheck() error {
	if p.Lines < 0 {
		return errors.New("hc read: negative lines")
	}
	return checkHcTerminal(p.Terminal)
}

// hcLabelParams sets herdr.seen, the only label termote writes on a
// terminal it did not start (herdr-app docs/labels.md).
type hcLabelParams struct {
	Terminal string
	Seen     uint64
}

func (hcLabelParams) hcMethod() string { return "terminal.label" }
func (p hcLabelParams) hcCheck() error { return checkHcTerminal(p.Terminal) }
func (p hcLabelParams) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{
		"terminal": p.Terminal,
		"labels":   map[string]string{hcLabelSeen: strconv.FormatUint(p.Seen, 10)},
	})
}

// The labels of herdr-app's convention (herdr-app defaults/AGENTS.md,
// docs/labels.md).
const (
	hcLabelSpace = "herdr.space"
	hcLabelTab   = "herdr.tab"
	hcLabelSeen  = "herdr.seen"
)

// hcMaxLabelValue bounds a herdr.space or herdr.tab value termote passes on.
const hcMaxLabelValue = 128

// hcRunParams starts this machine's shell (no argv, line, env, template or
// machine: the core runs the shell herdr-app's tabs run) in cwd, kept, with
// herdr-app's space and tab labels so herdr-app shows it.
type hcRunParams struct {
	Cwd   string
	Space string
	Tab   string
}

func (hcRunParams) hcMethod() string { return "terminal.run" }
func (p hcRunParams) hcCheck() error {
	for _, v := range []string{p.Space, p.Tab} {
		if v == "" || len(v) > hcMaxLabelValue || !utf8.ValidString(v) || strings.ContainsFunc(v, hcUnsafeRune) {
			return errors.New("hc run: bad space or tab label")
		}
	}
	if p.Cwd != "" && !isAbsAnyOS(p.Cwd) {
		return errors.New("hc run: cwd is not absolute")
	}
	return nil
}
func (p hcRunParams) MarshalJSON() ([]byte, error) {
	params := map[string]any{
		"keep":   true,
		"labels": map[string]string{hcLabelSpace: p.Space, hcLabelTab: p.Tab, hcLabelSeen: "0"},
	}
	if p.Cwd != "" {
		params["cwd"] = p.Cwd
	}
	return json.Marshal(params)
}

// hcAttachParams attaches a viewer. Observe: it never types or resizes.
type hcAttachParams struct {
	Terminal            string `json:"terminal"`
	Cols                int    `json:"cols"`
	Rows                int    `json:"rows"`
	Observe             bool   `json:"observe"`
	ResizeNotifications bool   `json:"resize_notifications"`
	// Resumed: attached again after the stream was lost.
	Resumed bool `json:"resumed"`
}

func (hcAttachParams) hcMethod() string { return "terminal.attach" }
func (p hcAttachParams) hcCheck() error {
	if p.Cols < 1 || p.Rows < 1 || p.Cols > 0xffff || p.Rows > 0xffff {
		return errors.New("hc attach: bad size")
	}
	return checkHcTerminal(p.Terminal)
}

// hcSubscribeParams subscribes to every event, unfiltered: doc events reach
// unfiltered subscribers only.
type hcSubscribeParams struct{}

func (hcSubscribeParams) hcMethod() string { return "events.subscribe" }
func (hcSubscribeParams) hcCheck() error   { return nil }

// hcAppDoc is the document herdr-app keeps its layout in. termote reads it,
// and writes back only the names and order of spaces and tabs (mux_hc_doc.go).
const hcAppDoc = "herdr-app"

// hcDocMaxValue is the core's limit on a document's serialized value.
const hcDocMaxValue = 1 << 20

// hcDocGetParams reads herdr-app's document on this machine.
type hcDocGetParams struct{}

func (hcDocGetParams) hcMethod() string { return "doc.get" }
func (hcDocGetParams) hcCheck() error   { return nil }
func (hcDocGetParams) MarshalJSON() ([]byte, error) {
	return []byte(`{"name":"` + hcAppDoc + `"}`), nil
}

// hcDocSetParams writes herdr-app's document on this machine, only over the
// version it was read at (the core refuses a stale write with kind conflict).
// Value is the whole document as read, with only a name or an order changed.
type hcDocSetParams struct {
	Version uint64
	Value   json.RawMessage
}

func (hcDocSetParams) hcMethod() string { return "doc.set" }
func (p hcDocSetParams) hcCheck() error {
	v := bytes.TrimSpace(p.Value)
	if p.Version == 0 || len(v) == 0 || v[0] != '{' || len(v) > hcDocMaxValue || !json.Valid(v) {
		return errors.New("hc doc.set: bad document or version")
	}
	return nil
}
func (p hcDocSetParams) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"name": hcAppDoc, "version": p.Version, "value": p.Value})
}

// hcUnsafeRune is a control or format character (C0, C1, bidi, zero-width).
func hcUnsafeRune(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) }

// hcTerminal is the part of an hc Terminal record termote uses. Its argv
// and environment are never decoded: they can hold secrets and are never
// shown.
type hcTerminal struct {
	Address string            `json:"address"`
	Labels  map[string]string `json:"labels"`
	Cwd     string            `json:"cwd"`
	State   string            `json:"state"`
	Reason  *string           `json:"reason"`
	Keep    bool              `json:"keep"`
	Parent  *string           `json:"parent"`
	// Pid is the terminal's program (its shell): the Chat view finds an
	// agent under it. Never shown.
	Pid        *int          `json:"pid"`
	Cols       int           `json:"cols"`
	Rows       int           `json:"rows"`
	Title      string        `json:"title"`
	Turn       uint64        `json:"turn"`
	Status     *hcStatus     `json:"status"`
	StatusMs   *int64        `json:"status_ms"`
	Foreground *hcForeground `json:"foreground"`
	CreatedMs  int64         `json:"created_ms"`
}

// hcStatus is a terminal's OSC 7501 root record, as its program reported it.
type hcStatus struct {
	App   string `json:"app"`
	State string `json:"state"`
}

// hcForeground is what runs in a terminal now (its argv is not decoded).
type hcForeground struct {
	Pid  int    `json:"pid"`
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
}

// isAbsAnyOS reports whether p is absolute on Unix or Windows: the core may
// run on either, and a relative cwd would resolve against the core's.
func isAbsAnyOS(p string) bool {
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\\`) {
		return true
	}
	return len(p) >= 3 && p[1] == ':' && (p[2] == '\\' || p[2] == '/') &&
		(p[0]|0x20 >= 'a' && p[0]|0x20 <= 'z')
}

// hcHello is what the core answers to hello.
type hcHello struct {
	Generation int      `json:"generation"`
	Version    string   `json:"version"`
	Framed     bool     `json:"framed"`
	Features   []string `json:"features"`
	Core       struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"core"`
}

// checkHcHello refuses a core this client cannot talk to.
func checkHcHello(h hcHello) error {
	if h.Generation != hcGeneration {
		return fmt.Errorf("%w (core generation %d)", errHcUnsupported, h.Generation)
	}
	if !h.Framed {
		return errors.New("hc did not switch to framed mode")
	}
	for _, f := range []string{"attach", "events"} {
		if !slicesContains(h.Features, f) {
			return fmt.Errorf("hc lacks the %q feature", f)
		}
	}
	if !validHcVersion(h.Version) || compareVersions(h.Version, hcMinVersion) < 0 {
		return fmt.Errorf("%w (core %q)", errHcTooOld, h.Version)
	}
	return nil
}

// validHcVersion reports whether v is X.Y.Z with an optional -pre part.
func validHcVersion(v string) bool {
	core, _, _ := strings.Cut(v, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if _, err := strconv.Atoi(p); err != nil {
			return false
		}
	}
	return true
}

func slicesContains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

type hcRPCReply struct {
	ID     *uint64         `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *hcRPCError     `json:"error"`
}

// hcConn is one framed connection to the core through an `hc connect`
// child: JSON-RPC on channel 0, attach and events on their own channels.
type hcConn struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	hello hcHello

	wmu sync.Mutex // one frame at a time on stdin

	nextID atomic.Uint64

	mu      sync.Mutex
	pending map[uint64]chan hcRPCReply
	chans   map[uint32]*hcChannel
	// early holds frames of a channel whose reply (attach, subscribe) has
	// not been handled yet: the core may send them first.
	early map[uint32][]hcFrame
	// closing: channels this side closed, until the core's empty CLOSE.
	closing map[uint32]struct{}
	err     error

	done   chan struct{} // closed when the connection ended
	exited chan struct{} // closed once hc connect has exited (nil without one)
}

// hcConnectStart starts `bin connect` with env and switches it to framed
// mode. The child's stderr is logged only.
var hcConnectStart = startHcConnect

func startHcConnect(ctx context.Context, bin string, env []string) (*hcConn, error) {
	cmd := exec.Command(bin, "connect")
	cmd.Env = env
	cmd.SysProcAttr = hcConnectSysProcAttr()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go logHcStderr(stderr)
	c, err := newHcConn(ctx, stdin, stdout, cmd)
	if err != nil {
		stdin.Close()
		cmd.Process.Kill()
		cmd.Wait()
		return nil, err
	}
	return c, nil
}

// logHcStderr logs what hc connect prints on stderr, a bounded line at a time.
func logHcStderr(r io.Reader) {
	br := bufio.NewReaderSize(r, 4096)
	for {
		line, err := readHerdrLine(br, 64*1024)
		if len(line) > 0 {
			log.Printf("hc connect: %s", truncateBytes(line, 512))
		}
		if err != nil && !errors.Is(err, errHerdrLineTooLong) {
			return
		}
	}
}

func truncateBytes(b []byte, n int) string {
	if len(b) > n {
		b = b[:n]
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(string(b), "?"))
}

// newHcConn says hello in plain mode, asking for framed mode, then serves
// the framed connection. cmd may be nil (tests).
func newHcConn(ctx context.Context, stdin io.WriteCloser, stdout io.Reader, cmd *exec.Cmd) (*hcConn, error) {
	br := bufio.NewReaderSize(stdout, 64*1024)
	hello, err := hcPlainHello(ctx, stdin, br)
	if err != nil {
		return nil, err
	}
	c := &hcConn{
		cmd: cmd, stdin: stdin, hello: hello,
		pending: map[uint64]chan hcRPCReply{},
		chans:   map[uint32]*hcChannel{},
		early:   map[uint32][]hcFrame{},
		closing: map[uint32]struct{}{},
		done:    make(chan struct{}),
	}
	if cmd != nil {
		c.exited = make(chan struct{})
	}
	go c.readLoop(br)
	return c, nil
}

// hcPlainHello sends hello {generation, framed} and reads its one-line reply.
func hcPlainHello(ctx context.Context, w io.Writer, br *bufio.Reader) (hcHello, error) {
	req := `{"jsonrpc":"2.0","id":0,"method":"hello","params":{"generation":1,"framed":true}}` + "\n"
	type result struct {
		line []byte
		err  error
	}
	got := make(chan result, 1)
	go func() {
		if _, err := io.WriteString(w, req); err != nil {
			got <- result{err: err}
			return
		}
		line, err := readHerdrLine(br, 1<<20)
		got <- result{line, err}
	}()
	var r result
	select {
	case r = <-got:
	case <-ctx.Done():
		return hcHello{}, fmt.Errorf("hc hello: %w", ctx.Err())
	}
	if r.err != nil {
		return hcHello{}, fmt.Errorf("hc hello: %w", r.err)
	}
	// hc connect prints {"error":{kind,message,hint}} when it cannot reach
	// or start the core.
	var reply struct {
		Result *hcHello `json:"result"`
		Error  *struct {
			Kind    string `json:"kind"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(r.line, &reply); err != nil {
		return hcHello{}, fmt.Errorf("hc hello: decode reply: %w", err)
	}
	if reply.Error != nil {
		re := &hcRPCError{Message: reply.Error.Message}
		re.Data.Kind = reply.Error.Kind
		return hcHello{}, re
	}
	if reply.Result == nil {
		return hcHello{}, errors.New("hc hello: no result")
	}
	if err := checkHcHello(*reply.Result); err != nil {
		return hcHello{}, err
	}
	return *reply.Result, nil
}

// alive reports whether the connection still runs.
func (c *hcConn) alive() bool {
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}

// Done is closed when the connection ends.
func (c *hcConn) Done() <-chan struct{} { return c.done }

// close ends the connection and the hc connect child.
func (c *hcConn) close() { c.fail(errHcLost) }

func (c *hcConn) fail(err error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = err
	pending, chans := c.pending, c.chans
	c.pending, c.chans, c.early = map[uint64]chan hcRPCReply{}, map[uint32]*hcChannel{}, map[uint32][]hcFrame{}
	c.mu.Unlock()
	close(c.done)
	c.stdin.Close()
	for _, ch := range pending {
		close(ch)
	}
	for _, ch := range chans {
		ch.lose()
	}
	if c.cmd != nil {
		go func() {
			// Closing stdin ends hc connect; a child that hangs is killed.
			t := time.AfterFunc(2*time.Second, func() { c.cmd.Process.Kill() })
			c.cmd.Wait()
			t.Stop()
			if c.exited != nil {
				close(c.exited)
			}
		}()
	}
}

// write sends one frame.
func (c *hcConn) write(channel uint32, kind byte, payload []byte) error {
	if !c.alive() {
		return errHcLost
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if _, err := c.stdin.Write(encodeHcFrame(channel, kind, payload)); err != nil {
		c.fail(errHcLost)
		return errHcLost
	}
	return nil
}

// call sends one allowed request and decodes its result into out (if not
// nil). Nothing is written when the params fail their check.
func (c *hcConn) call(ctx context.Context, p hcParams, out any) error {
	if err := p.hcCheck(); err != nil {
		return err
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, muxTimeout)
		defer cancel()
	}
	params, err := json.Marshal(p)
	if err != nil {
		return err
	}
	id := c.nextID.Add(1)
	msg, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": p.hcMethod(), "params": json.RawMessage(params),
	})
	if err != nil {
		return err
	}
	if len(msg) > hcFrameMaxPayload {
		return fmt.Errorf("hc %s: request too large", p.hcMethod())
	}
	reply := make(chan hcRPCReply, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return errHcLost
	}
	c.pending[id] = reply
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()
	if err := c.write(0, hcKindData, msg); err != nil {
		return err
	}
	select {
	case r, ok := <-reply:
		if !ok {
			return errHcLost
		}
		if r.Error != nil {
			return r.Error
		}
		if out != nil {
			if err := json.Unmarshal(r.Result, out); err != nil {
				return fmt.Errorf("hc %s: decode result: %w", p.hcMethod(), err)
			}
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// readLoop dispatches frames until the connection ends.
func (c *hcConn) readLoop(r io.Reader) {
	for {
		f, err := readHcFrame(r)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.ErrClosedPipe) {
				log.Printf("hc connection: %v", err)
			}
			c.fail(errHcLost)
			return
		}
		if f.channel == 0 {
			c.handleControl(f)
			continue
		}
		if err := c.route(f); err != nil {
			log.Printf("hc connection: %v", err)
			c.fail(errHcLost)
			return
		}
	}
}

// handleControl delivers a reply on channel 0. Notifications (no id) are
// not expected in framed mode: events have their own channel.
func (c *hcConn) handleControl(f hcFrame) {
	if f.kind != hcKindData {
		return
	}
	var r hcRPCReply
	if json.Unmarshal(f.payload, &r) != nil || r.ID == nil {
		return
	}
	c.mu.Lock()
	ch := c.pending[*r.ID]
	delete(c.pending, *r.ID)
	c.mu.Unlock()
	if ch != nil {
		ch <- r
		return
	}
	// Nobody waits any more (the call timed out): a channel the reply
	// opened (attach, subscribe) is closed, so neither its frames nor the
	// core's viewer outlive it.
	var opened struct {
		Channel uint32 `json:"channel"`
	}
	if r.Error == nil && json.Unmarshal(r.Result, &opened) == nil && opened.Channel != 0 {
		c.mu.Lock()
		delete(c.early, opened.Channel)
		c.closing[opened.Channel] = struct{}{}
		c.mu.Unlock()
		c.write(opened.Channel, hcKindClose, nil)
	}
}

// route hands a stream frame to its channel, holds it while the channel's
// reply is on its way, or drops it for a channel this side closed.
func (c *hcConn) route(f hcFrame) error {
	c.mu.Lock()
	if ch := c.chans[f.channel]; ch != nil {
		if f.kind == hcKindClose {
			delete(c.chans, f.channel)
		}
		c.mu.Unlock()
		return ch.deliver(f)
	}
	if _, ok := c.closing[f.channel]; ok {
		if f.kind == hcKindClose {
			delete(c.closing, f.channel)
		}
		c.mu.Unlock()
		return nil
	}
	held := c.early[f.channel]
	size := 0
	for _, h := range held {
		size += len(h.payload)
	}
	// Uncredited, the core sends at most hcWindow of stream bytes.
	if size+len(f.payload) > hcWindow+hcFrameHeader*64 {
		c.mu.Unlock()
		return fmt.Errorf("hc channel %d sent past its credit before it opened", f.channel)
	}
	c.early[f.channel] = append(held, f)
	c.mu.Unlock()
	return nil
}

// openChannel registers channel id (from an attach or subscribe reply) and
// hands it the frames that came first.
func (c *hcConn) openChannel(id uint32) (*hcChannel, error) {
	ch := &hcChannel{conn: c, id: id, wake: make(chan struct{}, 1)}
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return nil, errHcLost
	}
	held := c.early[id]
	delete(c.early, id)
	ended := false
	for _, f := range held {
		ch.deliver(f)
		ended = ended || f.kind == hcKindClose
	}
	if !ended {
		c.chans[id] = ch
	}
	c.mu.Unlock()
	return ch, nil
}

// hcChannel is one stream channel (attach or events). The core sends at
// most hcWindow bytes past what this side credited; next credits each DATA
// frame as it hands it out.
type hcChannel struct {
	conn *hcConn
	id   uint32

	mu     sync.Mutex
	queue  []hcFrame // DATA and RESIZE, in order
	ended  bool      // the core sent CLOSE
	reason []byte    // its JSON reason
	lost   bool      // the connection ended
	closed bool      // this side closed it
	wake   chan struct{}
}

func (ch *hcChannel) signal() {
	select {
	case ch.wake <- struct{}{}:
	default:
	}
}

func (ch *hcChannel) deliver(f hcFrame) error {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	switch f.kind {
	case hcKindData, hcKindResize:
		if ch.closed {
			return nil
		}
		ch.queue = append(ch.queue, f)
	case hcKindClose:
		ch.ended, ch.reason = true, f.payload
	default:
		return nil
	}
	ch.signal()
	return nil
}

func (ch *hcChannel) lose() {
	ch.mu.Lock()
	ch.lost = true
	ch.mu.Unlock()
	ch.signal()
}

// hcClosed is a channel the core closed, with its JSON reason.
type hcClosed struct {
	Reason   string `json:"reason"`
	ExitCode *int   `json:"exit_code"`
}

func (e *hcClosed) Error() string { return "hc channel closed: " + e.Reason }

// final reports whether the terminal itself ended (exited or killed), not
// only this stream (core stopped or restarted, holder lost, kept terminal
// waiting for its new shell).
func (e *hcClosed) final() bool { return e.Reason == "exited" || e.Reason == "killed" }

// next returns the next DATA or RESIZE frame, crediting DATA. It fails with
// *hcClosed when the core closed the channel, errHcLost when the connection
// ended, ctx's error, or io.EOF once this side closed it.
func (ch *hcChannel) next(ctx context.Context) (hcFrame, error) {
	for {
		ch.mu.Lock()
		if len(ch.queue) > 0 {
			f := ch.queue[0]
			ch.queue[0] = hcFrame{}
			ch.queue = ch.queue[1:]
			ch.mu.Unlock()
			if f.kind == hcKindData && len(f.payload) > 0 {
				ch.conn.write(ch.id, hcKindCredit, hcU32(uint32(len(f.payload))))
			}
			return f, nil
		}
		switch {
		case ch.closed:
			ch.mu.Unlock()
			return hcFrame{}, io.EOF
		case ch.ended:
			var c hcClosed
			json.Unmarshal(ch.reason, &c)
			ch.mu.Unlock()
			return hcFrame{}, &c
		case ch.lost:
			ch.mu.Unlock()
			return hcFrame{}, errHcLost
		}
		ch.mu.Unlock()
		select {
		case <-ch.wake:
		case <-ctx.Done():
			return hcFrame{}, ctx.Err()
		}
	}
}

// gone reports whether the core closed the channel or the connection ended.
func (ch *hcChannel) gone() bool {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	return ch.ended || ch.lost
}

// send writes a frame of kind on the channel (keys as DATA, RESIZE).
func (ch *hcChannel) send(kind byte, payload []byte) error {
	return ch.conn.write(ch.id, kind, payload)
}

// close detaches: CLOSE to the core, which answers with an empty CLOSE.
func (ch *hcChannel) close() {
	ch.mu.Lock()
	if ch.closed {
		ch.mu.Unlock()
		return
	}
	ch.closed = true
	ended := ch.ended || ch.lost
	ch.queue = nil
	ch.mu.Unlock()
	ch.signal()
	if ended {
		return
	}
	c := ch.conn
	c.mu.Lock()
	if c.chans[ch.id] == ch {
		delete(c.chans, ch.id)
		c.closing[ch.id] = struct{}{}
	}
	c.mu.Unlock()
	c.write(ch.id, hcKindClose, nil)
}

// hcEventLine is one line of the events channel: an event, a heartbeat or a
// missed notification with a fresh snapshot.
type hcEventLine struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// hcSubscription is an events.subscribe on a connection.
type hcSubscription struct {
	Seq       uint64
	Terminals []hcTerminal
	ch        *hcChannel
	// stall is hcEventStall (tests shorten it).
	stall time.Duration
}

// subscribeEvents subscribes to every event. The reply's snapshot is in the
// result; lines (events, heartbeats, missed) are read with run.
func (c *hcConn) subscribeEvents(ctx context.Context) (*hcSubscription, error) {
	var res struct {
		Seq       uint64       `json:"seq"`
		Terminals []hcTerminal `json:"terminals"`
		Channel   *uint32      `json:"channel"`
	}
	if err := c.call(ctx, hcSubscribeParams{}, &res); err != nil {
		return nil, err
	}
	if res.Channel == nil || *res.Channel == 0 {
		return nil, errors.New("hc events.subscribe: no channel")
	}
	ch, err := c.openChannel(*res.Channel)
	if err != nil {
		return nil, err
	}
	return &hcSubscription{Seq: res.Seq, Terminals: res.Terminals, ch: ch, stall: hcEventStall}, nil
}

// errHcEventsStalled: no heartbeat came within hcEventStall; subscribe again.
var errHcEventsStalled = errors.New("hc events stalled")

// run calls handle for each line until ctx ends, the channel closes, the
// connection ends or nothing (not even a heartbeat) comes for hcEventStall.
// Data arrives in chunks that do not follow lines.
func (s *hcSubscription) run(ctx context.Context, handle func(hcEventLine)) error {
	defer s.ch.close()
	var buf []byte
	for {
		fctx, cancel := context.WithTimeout(ctx, s.stall)
		f, err := s.ch.next(fctx)
		stalled := fctx.Err() != nil && ctx.Err() == nil
		cancel()
		if err != nil {
			if stalled {
				return errHcEventsStalled
			}
			return err
		}
		if f.kind != hcKindData {
			continue
		}
		buf = append(buf, f.payload...)
		for {
			i := bytes.IndexByte(buf, '\n')
			if i < 0 {
				break
			}
			line := buf[:i]
			var ev hcEventLine
			if json.Unmarshal(line, &ev) == nil {
				handle(ev)
			}
			buf = buf[i+1:]
		}
		if len(buf) > hcMaxEventLine {
			return errors.New("hc events: line too long")
		}
		// Keep the backing array from growing without bound.
		if len(buf) == 0 {
			buf = nil
		}
	}
}
