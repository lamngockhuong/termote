package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"sync"
	"time"
)

// hcDocRetry is how long after a document read the next one may run: reads
// asked for meanwhile are folded into it.
var hcDocRetry = 250 * time.Millisecond

// hcTopCacheMax bounds the folders whose git checkout is kept.
const hcTopCacheMax = 256

// hcMux is the herdr-core backend (--mux hc): termote is one more client of
// the core herdr-app talks to. It shows the spaces, tabs and panes herdr-app
// shows, from herdr-app's document (read only) and the terminals' labels.
type hcMux struct {
	client *hcClient
	state  *hcState
	home   string
	roots  *rootResolver
	// docRetry is hcDocRetry, read once.
	docRetry time.Duration

	// live is the connection whose events the state follows, nil while
	// none does; synced is closed when it changes.
	mu     sync.Mutex
	live   *hcConn
	synced chan struct{}

	// The document read in progress, and whether another was asked for.
	docMu      sync.Mutex
	docRunning bool
	docAgain   bool

	chgMu sync.Mutex
	chg   chan struct{} // closed at each change of the state (bump)

	inputsMu sync.Mutex
	inputs   map[string]*hcInput // each pane's input writer
	// inputIdle is hcInputIdle, read once.
	inputIdle time.Duration

	topMu   sync.Mutex
	tops    map[string]string // folder → its git checkout ("" outside one)
	topBusy map[string]bool
}

// newHcMux makes the backend for hc at bin, with env for hc connect, and
// follows the core until ctx ends.
func newHcMux(ctx context.Context, bin string, env []string) *hcMux {
	home, _ := os.UserHomeDir()
	m := &hcMux{
		client:    newHcClient(bin, env),
		state:     newHcState(),
		home:      home,
		roots:     newRootResolver(newGitRunner()),
		docRetry:  hcDocRetry,
		synced:    make(chan struct{}),
		tops:      map[string]string{},
		topBusy:   map[string]bool{},
		inputs:    map[string]*hcInput{},
		inputIdle: hcInputIdle,
		chg:       make(chan struct{}),
	}
	go m.follow(ctx)
	return m
}

func (m *hcMux) Name() string { return "hc" }

// setLive records which connection the state follows.
func (m *hcMux) setLive(c *hcConn) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.live == c {
		return
	}
	m.live = c
	close(m.synced)
	m.synced = make(chan struct{})
	defer m.bump()
}

// liveConn is the connection the state follows now, and a channel closed
// when that changes.
func (m *hcMux) liveConn() (*hcConn, <-chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.live, m.synced
}

// follow keeps the state in step with the core: on each connection it
// subscribes, takes the snapshot and the document, then applies events. A
// stalled or closed subscription is taken again on the same connection.
func (m *hcMux) follow(ctx context.Context) {
	for ctx.Err() == nil {
		conn, changed := m.client.current()
		if conn == nil {
			m.setLive(nil)
			select {
			case <-changed:
			case <-ctx.Done():
			}
			continue
		}
		err := m.followConn(ctx, conn)
		m.setLive(nil)
		if ctx.Err() != nil {
			break
		}
		if conn.alive() {
			log.Printf("hc events: %v; subscribing again", err)
			select {
			case <-time.After(time.Second):
			case <-ctx.Done():
			}
		}
	}
	m.client.close()
}

func (m *hcMux) followConn(ctx context.Context, conn *hcConn) error {
	sub, err := conn.subscribeEvents(ctx)
	if err != nil {
		return err
	}
	m.state.reset(sub.Seq, sub.Terminals)
	// Subscribe first, then read: a change in between arrives as an event.
	m.readDoc(ctx, conn, true)
	m.setLive(conn)
	return sub.run(ctx, func(l hcEventLine) {
		switch l.Method {
		case "event":
			var ev hcEvent
			if json.Unmarshal(l.Params, &ev) != nil {
				return
			}
			if v, ok := m.state.apply(ev); ok && v > m.state.docVersion() {
				m.readDoc(ctx, conn, false)
			}
			m.bump()
		case "missed":
			var ms hcMissed
			if json.Unmarshal(l.Params, &ms) == nil {
				m.state.reset(ms.Seq, ms.Terminals)
				m.readDoc(ctx, conn, false)
				m.bump()
			}
		}
	})
}

// readDoc reads herdr-app's document: wait reads it now (the first read on a
// connection); otherwise one read runs at a time in the background and those
// asked for meanwhile become one more read after it.
func (m *hcMux) readDoc(ctx context.Context, conn *hcConn, wait bool) {
	if wait {
		m.fetchDoc(ctx, conn, true)
		return
	}
	m.docMu.Lock()
	if m.docRunning {
		m.docAgain = true
		m.docMu.Unlock()
		return
	}
	m.docRunning = true
	m.docMu.Unlock()
	go func() {
		for {
			m.fetchDoc(ctx, conn, false)
			select {
			case <-time.After(m.docRetry):
			case <-ctx.Done():
			}
			m.docMu.Lock()
			if !m.docAgain || ctx.Err() != nil {
				m.docRunning = false
				m.docMu.Unlock()
				return
			}
			m.docAgain = false
			m.docMu.Unlock()
		}
	}()
}

// fetchDoc reads and parses the document outside the state's lock. One
// that does not parse is dropped (labels place the terminals), logged once
// per version.
func (m *hcMux) fetchDoc(ctx context.Context, conn *hcConn, fresh bool) {
	var res struct {
		Value   json.RawMessage `json:"value"`
		Version uint64          `json:"version"`
	}
	cctx, cancel := context.WithTimeout(ctx, muxTimeout)
	err := conn.call(cctx, hcDocGetParams{}, &res)
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("hc doc.get: %v", err)
		}
		return
	}
	doc, err := parseHcDoc(res.Value)
	if err != nil {
		m.state.mu.Lock()
		first := m.state.docBad != res.Version
		m.state.docBad = res.Version
		m.state.mu.Unlock()
		if first {
			log.Printf("hc: herdr-app document version %d not understood, placing terminals by label: %v", res.Version, err)
		}
		doc = nil
	}
	m.state.setDoc(res.Version, doc, fresh)
	m.bump()
}

// view waits until the state follows a connection, connecting when the core
// runs (mayStart: starting it, under the autostart policy).
func (m *hcMux) view(ctx context.Context, mayStart bool) error {
	for {
		live, synced := m.liveConn()
		if live != nil && live.alive() {
			return nil
		}
		if _, err := m.client.get(ctx, mayStart); err != nil {
			return err
		}
		select {
		case <-synced:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// Snapshot never starts the core: only a full client's page does
// (startingSnapshot).
func (m *hcMux) Snapshot(ctx context.Context) (Snapshot, error) { return m.snapshot(ctx, false) }

// peekSnapshot is Snapshot: reading changes nothing.
func (m *hcMux) peekSnapshot(ctx context.Context) (Snapshot, error) { return m.snapshot(ctx, false) }

// startingSnapshot is the snapshot of a full client opening the page, the
// one read that starts the core when it does not run.
func (m *hcMux) startingSnapshot(ctx context.Context) (Snapshot, error) {
	return m.snapshot(ctx, true)
}

func (m *hcMux) snapshot(ctx context.Context, mayStart bool) (Snapshot, error) {
	if err := m.view(ctx, mayStart); err != nil {
		return Snapshot{}, err
	}
	in := m.state.input()
	in.home = m.home
	in.top = m.top
	return buildHcSnapshot(in), nil
}

// top is dir's git checkout when known; an unknown one is looked up in the
// background, for a later snapshot.
func (m *hcMux) top(dir string) string {
	m.topMu.Lock()
	defer m.topMu.Unlock()
	if t, ok := m.tops[dir]; ok {
		return t
	}
	if !m.topBusy[dir] {
		m.topBusy[dir] = true
		go m.resolveTop(dir)
	}
	return ""
}

func (m *hcMux) resolveTop(dir string) {
	ctx, cancel := context.WithTimeout(context.Background(), muxTimeout)
	defer cancel()
	top := ""
	if r, err := m.roots.resolve(ctx, dir); err == nil && r.IsRepo {
		top = r.Root
	}
	m.topMu.Lock()
	defer m.topMu.Unlock()
	delete(m.topBusy, dir)
	if len(m.tops) >= hcTopCacheMax {
		clear(m.tops)
	}
	m.tops[dir] = top
}

// Health asks the core, never starting it.
func (m *hcMux) Health(ctx context.Context) error {
	conn, err := m.client.get(ctx, false)
	if err != nil {
		return err
	}
	return conn.call(ctx, hcStatusParams{}, nil)
}

// conn is the connection for an operation; the core must already run.
func (m *hcMux) conn(ctx context.Context) (*hcConn, error) {
	conn, err := m.client.get(ctx, false)
	if errors.Is(err, errHcNotRunning) {
		return nil, errHcUnavailable
	}
	return conn, err
}

// errHcUnavailable: the core does not answer (stopped, or restarting).
var errHcUnavailable = &codedError{"unavailable", "herdr-core is not running", 503}
