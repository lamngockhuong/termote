package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Limits for /api/mux/stream. They bound what one authenticated client can make
// the server hold open.
const (
	maxStreamMessage   = 64 * 1024        // largest client → server message
	maxStreams         = 8                // concurrent streams, server-wide
	streamWriteTimeout = 10 * time.Second // a client that cannot take a frame this long is dropped
	streamPingEvery    = 15 * time.Second
	streamPongTimeout  = 15 * time.Second // with streamPingEvery: no pong within 30s closes the stream
	streamDrainWait    = 500 * time.Millisecond
	// closeEvicted is sent to a stream pushed out by a newer one. It is an
	// application code, not 1013 "try again later", so clients know not to
	// reconnect automatically and evict the other device in turn.
	closeEvicted    websocket.StatusCode = 4001
	maxTermDim                           = 500
	defaultTermCols                      = 80
	defaultTermRows                      = 24
	// processKillWait is how long a closed stream's process gets to exit on its
	// own before it is killed.
	processKillWait = 5 * time.Second
)

// Size is a terminal size in character cells.
type Size struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

// clampDim keeps a requested dimension inside [1, maxTermDim].
func clampDim(v int) int {
	return min(max(v, 1), maxTermDim)
}

// TermStream is a running terminal attached to one pane.
type TermStream interface {
	// Read returns terminal output; it fails once the terminal is gone.
	Read(p []byte) (int, error)
	// Write sends raw input bytes to the terminal.
	Write(p []byte) (int, error)
	Resize(Size) error
	// Done is closed when the terminal process has exited.
	Done() <-chan struct{}
	// ExitCode is valid after Done is closed.
	ExitCode() int
	// Close ends the terminal and waits until its whole process tree is gone.
	Close() error
}

// sizeReporter is implemented by streams whose size the backend fixes (herdr
// observes a pane at its desktop size). Client resizes are ignored; instead
// every size is sent to the client as a size frame. The stream waits for sent
// to be closed before producing output at that size, so the frame always
// arrives first.
type sizeReporter interface {
	Sizes() <-chan sizeChange
}

// sizeChange is one size frame. Driving tells whether the client now drives
// the size (sizeDriver); Reason says why it stopped when it did not ask to.
type sizeChange struct {
	Size    Size
	Driving bool
	Reason  string
	sent    chan<- struct{}
}

// sizeDriver is implemented by streams that can take over the pane size
// (herdr's control mode) when the client asks for it. While driving, client
// resizes reach the pane and size frames carry the client's size.
type sizeDriver interface {
	Drive(on bool)
}

// streamControl is a text frame. Client → server: resize, drive. Server →
// client: exit, error, size.
type streamControl struct {
	Type    string `json:"type"`
	Cols    int    `json:"cols,omitempty"`
	Rows    int    `json:"rows,omitempty"`
	Code    *int   `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	// On is the drive request; a drive message without it is ignored.
	On *bool `json:"on,omitempty"`
	// Driving is set on every size frame, so false is sent too.
	Driving *bool `json:"driving,omitempty"`
	// Reason is "taken-over" or "failed" when driving stopped without the
	// client asking.
	Reason string `json:"reason,omitempty"`
}

// errStreamEvicted, errServerShutdown and errDeviceRevoked end a stream from
// outside; errTooManyViewers refuses a view-only stream.
var (
	errStreamEvicted  = errors.New("closed: too many open streams")
	errServerShutdown = errors.New("server shutting down")
	errDeviceRevoked  = errors.New("closed: device revoked")
	errTooManyViewers = errors.New("too many viewers")
)

// maxViewStreamsPerDevice caps the open streams of one view-only device.
const maxViewStreamsPerDevice = 2

// streamHub tracks open streams so the oldest can be evicted when the limit is
// hit and every stream can be closed on shutdown.
type streamHub struct {
	mu      sync.Mutex
	max     int
	streams []*hubEntry // oldest first
	closing bool
	wg      sync.WaitGroup
	// alive reports whether a paired device still exists; nil when none
	// can be revoked. add asks it under mu, and a revoke marks the device
	// gone before closeDevice takes mu, so a stream that was opening while
	// its device was revoked is closed either way.
	alive func(deviceID string) bool
	// onShutdown runs once shutdown has closed every stream (it writes what
	// the device store holds in memory).
	onShutdown func()
}

type hubEntry struct {
	cancel   context.CancelCauseFunc
	role     role
	deviceID string
}

func newStreamHub(max int) *streamHub {
	return &streamHub{max: max}
}

// add registers a stream of a client of role r (deviceID: its paired
// device, if any), evicting what the limits require: a view-only device's
// oldest stream past maxViewStreamsPerDevice, then, past the server-wide
// limit, the oldest view-only stream, else (for a full client only) the
// oldest stream. A view-only stream never pushes out a full one: with no
// view-only stream to evict it gets errTooManyViewers. It also fails once
// shutdown has started (errServerShutdown) and for a revoked device
// (errDeviceRevoked).
func (h *streamHub) add(cancel context.CancelCauseFunc, r role, deviceID string) (*hubEntry, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return nil, errServerShutdown
	}
	if deviceID != "" && h.alive != nil && !h.alive(deviceID) {
		return nil, errDeviceRevoked
	}
	if r == roleView && deviceID != "" {
		mine := 0
		for _, s := range h.streams {
			if s.deviceID == deviceID {
				mine++
			}
		}
		if mine >= maxViewStreamsPerDevice {
			h.evict(slices.IndexFunc(h.streams, func(s *hubEntry) bool { return s.deviceID == deviceID }))
		}
	}
	for len(h.streams) >= h.max {
		i := slices.IndexFunc(h.streams, func(s *hubEntry) bool { return s.role == roleView })
		if i < 0 {
			if r == roleView {
				return nil, errTooManyViewers
			}
			i = 0
		}
		h.evict(i)
	}
	e := &hubEntry{cancel: cancel, role: r, deviceID: deviceID}
	h.streams = append(h.streams, e)
	h.wg.Add(1)
	return e, nil
}

// evict ends stream i; h.mu is held.
func (h *streamHub) evict(i int) {
	h.streams[i].cancel(errStreamEvicted)
	h.streams = append(h.streams[:i], h.streams[i+1:]...)
}

// closeDevice ends every stream of deviceID (a revoked device). Each stays
// in the hub until its cleanup removes it.
func (h *streamHub) closeDevice(deviceID string) {
	if deviceID == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.streams {
		if s.deviceID == deviceID {
			s.cancel(errDeviceRevoked)
		}
	}
}

// remove unregisters a stream after its cleanup has finished.
func (h *streamHub) remove(e *hubEntry) {
	h.mu.Lock()
	for i, s := range h.streams {
		if s == e {
			h.streams = append(h.streams[:i], h.streams[i+1:]...)
			break
		}
	}
	h.mu.Unlock()
	h.wg.Done()
}

// shutdown closes every stream and waits for their processes to exit, or for
// ctx to expire.
func (h *streamHub) shutdown(ctx context.Context) error {
	h.mu.Lock()
	h.closing = true
	for _, s := range h.streams {
		s.cancel(errServerShutdown)
	}
	h.mu.Unlock()
	done := make(chan struct{})
	go func() { h.wg.Wait(); close(done) }()
	if h.onShutdown != nil {
		defer h.onShutdown()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// registerStreamRoutes mounts the terminal WebSocket.
func registerStreamRoutes(mux *http.ServeMux, m Mux, tokens *tokenStore, allowed hostAllowlist, hub *streamHub) {
	mux.HandleFunc("/api/mux/stream", func(w http.ResponseWriter, r *http.Request) {
		handleStream(w, r, m, tokens, allowed, hub)
	})
}

// handleStream upgrades to a WebSocket and pipes it to a terminal on the
// requested pane. Auth and the Host allowlist are enforced by the middleware.
// The token travels in the query; nothing here logs the URL.
func handleStream(w http.ResponseWriter, r *http.Request, m Mux, tokens *tokenStore, allowed hostAllowlist, hub *streamHub) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if !isWebSocket(r) {
		jsonError(w, "websocket upgrade required", http.StatusBadRequest)
		return
	}
	// Browsers always send Origin on a WebSocket handshake. Clients that are
	// not browsers (websocat) may omit it and still need auth and a token.
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		jsonError(w, "cross-site request rejected", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || !allowed.allows(r, u.Host) {
			jsonError(w, "origin not allowed", http.StatusForbidden)
			return
		}
	}
	q := r.URL.Query()
	grant, ok := tokens.consume(q.Get("token"))
	if !ok {
		jsonError(w, "invalid or expired stream token", http.StatusUnauthorized)
		return
	}
	// The token's grant, and the request's own: either one view-only makes
	// the stream view-only.
	view := grant.role == roleView || isViewOnly(r)
	deviceID := grant.deviceID
	if a, ok := authFrom(r.Context()); ok && a.DeviceID != "" {
		deviceID = a.DeviceID
	}
	var va viewAttacher
	if view {
		// Checked before anything runs: a backend that cannot attach a
		// client that changes nothing is refused, never given a normal one.
		var ok bool
		cctx, ccancel := context.WithTimeout(r.Context(), muxTimeout)
		va, ok = m.(viewAttacher)
		ok = ok && va.CanView(cctx)
		ccancel()
		if !ok {
			jsonErrorCode(w, "unsupported", "view-only streams are not supported by this backend", http.StatusNotImplemented)
			return
		}
	}
	pane := q.Get("pane")
	if pane == "" {
		jsonError(w, "pane is required", http.StatusBadRequest)
		return
	}
	size := Size{Cols: queryDim(q, "cols", defaultTermCols), Rows: queryDim(q, "rows", defaultTermRows)}

	ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
	read := m.Snapshot
	if view {
		read = func(ctx context.Context) (Snapshot, error) { return viewSnapshot(ctx, m) }
	}
	snap, err := read(ctx)
	cancel()
	if err != nil {
		muxError(w, m, "stream snapshot", err)
		return
	}
	if !snapshotHasPane(snap, pane) {
		jsonError(w, "unknown pane", http.StatusBadRequest)
		return
	}
	// Where selecting a tab is the backend's (tmux), a view-only client
	// watches the current window: attaching to another would switch it for
	// every client. A switch between this check and the attach only shows
	// it the window switched to.
	if view && !m.Caps().ClientSideSelect && !snapshotPaneActive(snap, pane) {
		writeViewOnly(w)
		return
	}

	// Origin was checked above against the allowlist, which is stricter than
	// the library's own same-host comparison.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		log.Printf("stream accept: %v", err)
		return
	}
	conn.SetReadLimit(maxStreamMessage)

	sctx, scancel := context.WithCancelCause(context.Background())
	streamRole := roleFull
	if view {
		streamRole = roleView
	}
	entry, err := hub.add(scancel, streamRole, deviceID)
	if err != nil {
		scancel(err)
		switch {
		case errors.Is(err, errTooManyViewers):
			sendControl(conn, streamControl{Type: "error", Message: "too many viewers"})
			go conn.Close(websocket.StatusTryAgainLater, "too many viewers")
		case errors.Is(err, errDeviceRevoked):
			go conn.Close(websocket.StatusPolicyViolation, "device revoked")
		default:
			go conn.Close(websocket.StatusGoingAway, "server shutting down")
		}
		return
	}
	defer hub.remove(entry)
	defer scancel(nil)

	actx, acancel := context.WithTimeout(sctx, muxTimeout)
	var ts TermStream
	if view {
		ts, err = va.AttachView(actx, pane, size)
	} else {
		ts, err = m.Attach(actx, pane, size)
	}
	acancel()
	if err != nil {
		log.Printf("%s attach %q: %v", m.Name(), pane, err)
		sendControl(conn, streamControl{Type: "error", Message: "failed to open terminal"})
		go conn.Close(websocket.StatusInternalError, "attach failed")
		return
	}
	// drive=1 opens the stream already driving the size, so a reconnect does
	// not start at the desktop size only to switch at once.
	if sd, ok := ts.(sizeDriver); ok && !view && q.Get("drive") == "1" {
		sd.Drive(true)
	}
	runStream(sctx, scancel, conn, ts, view)
}

// viewAttacher is a backend that can attach a client that changes nothing:
// no input reaches the pane (the stream also drops it), and neither the
// current window nor any size changes.
type viewAttacher interface {
	// CanView reports whether AttachView works here.
	CanView(ctx context.Context) bool
	// AttachView attaches to paneID read-only; size is only the client's
	// own terminal size.
	AttachView(ctx context.Context, paneID string, size Size) (TermStream, error)
}

// viewSnapshot reads m's panes for a view-only client: without making
// anything (tmux's default session) where the snapshot would.
func viewSnapshot(ctx context.Context, m Mux) (Snapshot, error) {
	if m.Caps().ClientSideSelect {
		// Herdr's snapshot makes nothing, and its peek leaves out the
		// worktree branches.
		return m.Snapshot(ctx)
	}
	return peekSnapshot(ctx, m)
}

// snapshotPaneActive reports whether pane is in its group's active tab.
func snapshotPaneActive(s Snapshot, pane string) bool {
	for _, g := range s.Groups {
		for _, t := range g.Tabs {
			for _, p := range t.Panes {
				if p.ID == pane {
					return t.Active
				}
			}
		}
	}
	return false
}

// runStream pumps bytes both ways until the terminal exits, the client goes
// away, or the stream is cancelled; then it tears everything down.
//
// ctx only signals the end. Reads and writes on conn use their own contexts:
// the library closes the connection when an operation's context is cancelled,
// which would drop the final exit or error frame.
//
// The closing handshake waits for the client's reply for up to 5s, so it runs
// in the background: the hub only tracks terminal processes, and those are
// gone by then.
//
// A view-only stream (readOnly) drops every input frame, resize and drive:
// nothing it sends reaches the pane or its size.
func runStream(ctx context.Context, cancel context.CancelCauseFunc, conn *websocket.Conn, ts TermStream, readOnly bool) {
	outDone := make(chan struct{})
	go func() {
		defer close(outDone)
		buf := make([]byte, 32*1024)
		for {
			n, err := ts.Read(buf)
			if n > 0 {
				if werr := writeFrame(conn, websocket.MessageBinary, buf[:n]); werr != nil {
					cancel(werr)
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// Ends when the connection closes.
	go func() {
		for {
			typ, data, err := conn.Read(context.Background())
			if err != nil {
				cancel(err)
				return
			}
			if readOnly {
				continue
			}
			if typ == websocket.MessageBinary {
				if _, err := ts.Write(data); err != nil {
					cancel(err)
					return
				}
				continue
			}
			var msg streamControl
			if json.Unmarshal(data, &msg) != nil {
				continue
			}
			switch {
			// A resize without a size is ignored rather than clamped to 1x1.
			case msg.Type == "resize" && msg.Cols > 0 && msg.Rows > 0:
				if err := ts.Resize(Size{Cols: clampDim(msg.Cols), Rows: clampDim(msg.Rows)}); err != nil {
					log.Printf("stream resize: %v", err)
				}
			case msg.Type == "drive" && msg.On != nil:
				if sd, ok := ts.(sizeDriver); ok {
					sd.Drive(*msg.On)
				}
			}
		}
	}()

	if sr, ok := ts.(sizeReporter); ok {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case c, ok := <-sr.Sizes():
					if !ok {
						return
					}
					driving := c.Driving
					sendControl(conn, streamControl{Type: "size", Cols: c.Size.Cols, Rows: c.Size.Rows, Driving: &driving, Reason: c.Reason})
					close(c.sent)
				}
			}
		}()
	}

	go func() {
		t := time.NewTicker(streamPingEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, pcancel := context.WithTimeout(context.Background(), streamPongTimeout)
				err := conn.Ping(pctx)
				pcancel()
				if err != nil {
					cancel(err)
					return
				}
			}
		}
	}()

	select {
	case <-ts.Done():
		// Let the reader flush what the process printed before it exited. A
		// ConPTY keeps its output pipe open until it is closed, so wait briefly
		// and then close to release the rest.
		select {
		case <-outDone:
		case <-time.After(streamDrainWait):
		}
		closeTerm(ts)
		<-outDone
		code := ts.ExitCode()
		sendControl(conn, streamControl{Type: "exit", Code: &code})
		go conn.Close(websocket.StatusNormalClosure, "")
	case <-ctx.Done():
		closeTerm(ts)
		// The output goroutine may be stuck writing to a client that stopped
		// reading; do not hold the hub slot for the whole write timeout.
		select {
		case <-outDone:
		case <-time.After(streamDrainWait):
			conn.CloseNow()
			<-outDone
		}
		switch cause := context.Cause(ctx); {
		case errors.Is(cause, errStreamEvicted):
			sendControl(conn, streamControl{Type: "error", Message: errStreamEvicted.Error()})
			go conn.Close(closeEvicted, "too many streams")
		case errors.Is(cause, errDeviceRevoked):
			go conn.Close(websocket.StatusPolicyViolation, "device revoked")
		case errors.Is(cause, errServerShutdown):
			go conn.Close(websocket.StatusGoingAway, "server shutting down")
		default:
			// The client left, stopped answering, or broke a limit; the
			// connection is already unusable.
			if !isClientGone(cause) {
				log.Printf("stream ended: %v", cause)
			}
			conn.CloseNow()
		}
	}
}

func closeTerm(ts TermStream) {
	if err := ts.Close(); err != nil {
		log.Printf("stream close: %v", err)
	}
}

// writeFrame writes one message; a client that cannot take it within the
// write timeout is disconnected by the library.
func writeFrame(conn *websocket.Conn, typ websocket.MessageType, p []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), streamWriteTimeout)
	defer cancel()
	return conn.Write(ctx, typ, p)
}

func sendControl(conn *websocket.Conn, msg streamControl) {
	b, _ := json.Marshal(msg)
	writeFrame(conn, websocket.MessageText, b)
}

// isClientGone reports the usual ways a client ends a stream, which are not
// worth logging.
func isClientGone(err error) bool {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return true
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway, websocket.StatusNoStatusRcvd:
		return true
	}
	return false
}

// queryDim parses a size parameter, falling back to def and clamping.
func queryDim(q url.Values, key string, def int) int {
	v, err := strconv.Atoi(strings.TrimSpace(q.Get(key)))
	if err != nil {
		return def
	}
	return clampDim(v)
}

func snapshotHasPane(s Snapshot, pane string) bool {
	for _, g := range s.Groups {
		for _, t := range g.Tabs {
			for _, p := range t.Panes {
				if p.ID == pane {
					return true
				}
			}
		}
	}
	return false
}
