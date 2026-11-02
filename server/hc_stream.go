package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"time"
)

// hcRetryWait is how long a stream waits before attaching again when the
// core did not take the attach (the terminal is restarting, the core is
// gone), unless the state changes first.
var hcRetryWait = time.Second

// hcLayoutSettle is how long the tab's layout must stay before clients are
// told to read it again: dragging a split on the desktop resizes it many
// times a second.
var hcLayoutSettle = 150 * time.Millisecond

// changes is closed at the next change of the state (bump).
func (m *hcMux) changes() <-chan struct{} {
	m.chgMu.Lock()
	defer m.chgMu.Unlock()
	return m.chg
}

// bump tells every stream the state changed.
func (m *hcMux) bump() {
	m.chgMu.Lock()
	close(m.chg)
	m.chg = make(chan struct{})
	m.chgMu.Unlock()
}

// Attach streams paneID to a full client. It attaches as a viewer that can
// type, at the terminal's own size: the core lets the viewer that typed last
// set the size, so a client typing never resizes the desktop's pane. Only
// while the client drives the size (Drive) does the terminal take the
// client's.
func (m *hcMux) Attach(ctx context.Context, paneID string, client Size) (TermStream, error) {
	return m.attach(ctx, paneID, client, false)
}

// CanView: an observer can never type or resize, on every core.
func (*hcMux) CanView(context.Context) bool { return true }

// AttachView streams paneID as an observer, which the core lets neither type
// nor resize.
func (m *hcMux) AttachView(ctx context.Context, paneID string, client Size) (TermStream, error) {
	return m.attach(ctx, paneID, client, true)
}

func (m *hcMux) attach(ctx context.Context, paneID string, client Size, view bool) (TermStream, error) {
	t, err := m.requirePane(ctx, paneID)
	if err != nil {
		return nil, err
	}
	pane := hcSize(t)
	if client.Cols <= 0 || client.Rows <= 0 {
		client = pane
	}
	pr, pw := io.Pipe()
	s := &hcStream{
		m: m, pane: paneID, view: view, pr: pr, pw: pw,
		clientSize: make(chan Size, 1), wantDrive: make(chan bool, 1),
		sizes: make(chan sizeChange), ready: make(chan struct{}),
		stop: make(chan struct{}), done: make(chan struct{}),
	}
	go s.run(pane, client)
	return s, nil
}

// hcSize is a terminal's size, never below one cell.
func hcSize(t hcTerminal) Size { return Size{Cols: clampDim(t.Cols), Rows: clampDim(t.Rows)} }

// hcStream is one attach at a time on a pane, attached again inside the same
// stream when the core loses it for a while (the core restarts, a kept
// terminal waits for its new shell): only the terminal exiting or being
// killed ends the stream.
type hcStream struct {
	m    *hcMux
	pane string
	view bool

	pr *io.PipeReader
	pw *io.PipeWriter

	clientSize chan Size
	wantDrive  chan bool
	sizes      chan sizeChange

	// The attach in use, for Write.
	mu      sync.Mutex
	ch      *hcChannel
	sent    Size   // the size this viewer last told the core
	drive   bool   // the client drives the size
	pending []byte // input typed while no attach is in use
	visible bool   // counted as a viewer of the pane (SetVisible)
	ended   bool   // run returned: no longer counted

	ready     chan struct{}
	readyOnce sync.Once
	stop      chan struct{}
	stopOnce  sync.Once
	done      chan struct{}
	code      int
}

func (s *hcStream) Read(p []byte) (int, error) { return s.pr.Read(p) }

// Write types p on the attach in use. Typing makes this viewer the one that
// sets the size, so the terminal's own size is sent first when it changed
// since (the desktop resized it). Input that comes while the stream attaches
// (at open, or again after a loss) waits for the attach, up to
// hcMaxQueuedInput; past it the stream fails.
func (s *hcStream) Write(p []byte) (int, error) {
	if s.view {
		return len(p), nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ch == nil {
		if len(s.pending)+len(p) > hcMaxQueuedInput {
			return 0, errors.New("hc input queue full")
		}
		s.pending = append(s.pending, p...)
		return len(p), nil
	}
	s.typeLocked(p)
	return len(p), nil
}

// typeLocked sends p on the attach in use; guarded by mu.
func (s *hcStream) typeLocked(p []byte) {
	if t, ok := s.m.state.terminal(s.pane); ok && !s.drive {
		if size := hcSize(t); size != s.sent {
			s.ch.send(hcKindResize, hcSizePayload(size.Cols, size.Rows))
			s.sent = size
		}
	}
	for b := p; len(b) > 0; {
		n := min(len(b), hcInputChunk)
		if err := s.ch.send(hcKindData, b[:n]); err != nil {
			// The attach is gone: the rest waits for the next one.
			s.ch = nil
			if len(s.pending)+len(b) <= hcMaxQueuedInput {
				s.pending = append(s.pending, b...)
			}
			return
		}
		b = b[n:]
	}
}

// Resize records the client's size; it reaches the terminal only while the
// client drives the size.
func (s *hcStream) Resize(size Size) error {
	putLatest(s.clientSize, size)
	return nil
}

// Drive asks to take the terminal's size (on) or to give it back.
func (s *hcStream) Drive(on bool) {
	if !s.view {
		putLatest(s.wantDrive, on)
	}
}

func (s *hcStream) Sizes() <-chan sizeChange {
	s.readyOnce.Do(func() { close(s.ready) })
	return s.sizes
}
func (s *hcStream) Done() <-chan struct{} { return s.done }
func (s *hcStream) ExitCode() int         { return s.code }

// Close detaches. The terminal keeps running: it is the core's.
func (s *hcStream) Close() error {
	s.stopOnce.Do(func() {
		close(s.stop)
		s.pw.CloseWithError(io.EOF)
	})
	<-s.done
	return nil
}

func (s *hcStream) announce(c sizeChange) bool {
	sent := make(chan struct{})
	c.sent = sent
	select {
	case s.sizes <- c:
	case <-s.stop:
		return false
	}
	select {
	case <-sent:
		return true
	case <-s.stop:
		return false
	}
}

// setCh records the attach in use (nil while attaching again) and types
// what waited for it.
func (s *hcStream) setCh(ch *hcChannel, sent Size) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ch, s.sent = ch, sent
	if ch != nil && len(s.pending) > 0 {
		p := s.pending
		s.pending = nil
		s.typeLocked(p)
	}
}

// sleep waits d, a state change or the end of the stream; false at the end.
func (s *hcStream) sleep(d time.Duration) bool {
	select {
	case <-time.After(d):
	case <-s.m.changes():
	case <-s.stop:
		return false
	}
	return true
}

// hcPump is what the frame reader of one attach reports.
type hcPump struct {
	size *Size         // a RESIZE from the core (observers)
	ack  chan struct{} // closed once the size is announced
	err  error         // the attach ended
}

// run attaches until the terminal ends or the stream is closed.
func (s *hcStream) run(pane, client Size) {
	defer close(s.done)
	defer s.pw.Close()
	defer s.endVisible()
	select {
	case <-s.ready:
	case <-s.stop:
		return
	}
	want := false
	resumed := false
	for {
		t, ok := s.m.state.terminal(s.pane)
		if !ok || t.State != "live" {
			// Gone or finished: the stream is over.
			return
		}
		pane = hcSize(t)
		ch, err := s.attachOnce(t, pane, client, want, resumed)
		if err != nil {
			if hcErrorKind(err) == "not_found" {
				return
			}
			if !s.sleep(hcRetryWait) {
				return
			}
			continue
		}
		resumed = true
		end := s.follow(ch, &pane, &client, &want)
		ch.close()
		s.setCh(nil, Size{})
		var closed *hcClosed
		switch {
		case end == nil:
			return // closed by the client
		case errors.As(end, &closed) && closed.final():
			if closed.ExitCode != nil {
				s.code = *closed.ExitCode
			}
			return
		default:
			// Lost for a while: attach again once the core can take it.
			if !s.sleep(hcRetryWait) {
				return
			}
		}
	}
}

// attachOnce attaches at the terminal's size, or the client's while it
// drives, and tells the client the size.
func (s *hcStream) attachOnce(t hcTerminal, pane, client Size, driving, resumed bool) (*hcChannel, error) {
	ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
	defer cancel()
	go func() {
		select {
		case <-s.stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	conn, err := s.m.conn(ctx)
	if err != nil {
		return nil, err
	}
	size := pane
	if driving {
		size = client
	}
	ch, err := attachHc(ctx, conn, hcAttachParams{
		Terminal: t.Address, Cols: size.Cols, Rows: size.Rows,
		Observe: s.view, ResizeNotifications: s.view, Resumed: resumed,
	})
	if err != nil {
		return nil, err
	}
	if driving {
		ch.send(hcKindResize, hcSizePayload(size.Cols, size.Rows))
	}
	s.mu.Lock()
	s.drive = driving
	s.mu.Unlock()
	s.setCh(ch, size)
	if !s.announce(sizeChange{Size: size, Driving: driving}) {
		ch.close()
		return nil, errHcLost
	}
	return ch, nil
}

// follow copies the attach's output to the client and follows the
// terminal's size, the client's and its drive requests, until the attach
// ends (its error) or the stream is closed (nil).
func (s *hcStream) follow(ch *hcChannel, pane, client *Size, want *bool) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The reader writes output in order. A RESIZE from the core (an
	// observer's) is told to the client before the output that follows it:
	// the reader waits until follow has announced it.
	pump := make(chan hcPump)
	report := func(p hcPump) bool {
		select {
		case pump <- p:
			return true
		case <-ctx.Done():
			return false
		}
	}
	go func() {
		for {
			f, err := ch.next(ctx)
			if err != nil {
				report(hcPump{err: err})
				return
			}
			switch f.kind {
			case hcKindData:
				if _, err := s.pw.Write(f.payload); err != nil {
					report(hcPump{})
					return
				}
			case hcKindResize:
				if cols, rows, ok := parseHcSize(f.payload); ok {
					ack := make(chan struct{})
					size := Size{Cols: clampDim(cols), Rows: clampDim(rows)}
					if !report(hcPump{size: &size, ack: ack}) {
						return
					}
					select {
					case <-ack:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()
	before := *pane // the terminal's size when the client took it over
	layout := s.layoutKey()
	var layoutSettle <-chan time.Time
	for {
		changes := s.m.changes()
		select {
		case <-s.stop:
			return nil
		case p := <-pump:
			if p.size == nil {
				if p.err == nil {
					return nil // the client side closed
				}
				return p.err
			}
			if *p.size != *pane && !*want {
				*pane = *p.size
				if !s.announce(sizeChange{Size: *pane}) {
					return nil
				}
			}
			close(p.ack)
		case <-changes:
			t, ok := s.m.state.terminal(s.pane)
			if !ok || t.State != "live" {
				return &hcClosed{Reason: "exited"}
			}
			if size := hcSize(t); size != *pane && !*want {
				*pane = size
				if !s.announce(sizeChange{Size: size}) {
					return nil
				}
			}
			if k := s.layoutKey(); k != layout {
				layout = k
				layoutSettle = time.After(hcLayoutSettle)
			}
		case <-layoutSettle:
			layoutSettle = nil
			if !s.announce(sizeChange{Layout: true}) {
				return nil
			}
		case next := <-s.clientSize:
			*client = next
			if *want {
				s.resize(ch, next)
			}
		case on := <-s.wantDrive:
			if on == *want {
				continue
			}
			*want = on
			s.mu.Lock()
			s.drive = on
			s.mu.Unlock()
			if on {
				// The latest client size, without waiting for one.
				select {
				case *client = <-s.clientSize:
				default:
				}
			}
			size := *client
			if on {
				before = *pane
			} else {
				// Give the terminal back the size it had.
				size = before
				*pane = before
			}
			s.resize(ch, size)
			if !s.announce(sizeChange{Size: size, Driving: on}) {
				return nil
			}
		}
	}
}

// resize tells the core this viewer's size.
func (s *hcStream) resize(ch *hcChannel, size Size) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch.send(hcKindResize, hcSizePayload(size.Cols, size.Rows))
	s.sent = size
}

// layoutKey changes when what the tab's layout is built from does: the
// sizes of the terminals of the pane's tab, and herdr-app's document.
func (s *hcStream) layoutKey() string {
	in := s.m.state.input()
	t := in.terminals[s.pane]
	if t == nil {
		return ""
	}
	tab := hcTabOf(t)
	var parts []string
	for a, o := range in.terminals {
		if hcTabOf(o) == tab && hcShown(o) {
			parts = append(parts, fmt.Sprintf("%s=%dx%d", a, o.Cols, o.Rows))
		}
	}
	slices.Sort(parts)
	return strings.Join(parts, ";") + fmt.Sprintf("|%d", s.m.state.docVersion())
}
