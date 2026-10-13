package main

import (
	"context"
	"errors"
	"io"
	"log"
	"strings"
	"sync"
	"time"
)

// Termote's own Zellij clients. A full stream is one `zellij attach` client in
// a PTY, as tmux; input for a pane (typed keys, a Chat message) goes through
// such a client too, never through argv, where every local user could read
// it. A pane with no stream gets a hidden client for the write, kept a short
// while for the next one.
//
// A new client lands on another client's tab. Zellij gives no way to attach
// to a chosen pane from the CLI, and its CLI actions that need a client act
// on the client that last sent a keystroke. So the client is positioned in
// three steps, under its session's slot: a keystroke that reaches no pane
// (zellijNoopKey) makes it that client, `focus-pane-id` moves it, and every
// other client is checked to be where it was. A user typing on another
// client in the few milliseconds between the keystroke and the action can
// still be moved: that is detected, the other client is moved back, and the
// attach fails with 503 busy. Then `switch-mode locked` puts this client
// (only) in locked mode, so the PWA's Ctrl combos reach the pane instead of
// Zellij's own modes.

// zellijNoopKey is Ctrl+Alt+Shift+Pause in the kitty keyboard protocol.
// Zellij's client always tries kitty parsing first and sends it as a key
// (which marks the client as the last active one); it is bound to nothing,
// and Zellij writes nothing to a pane that is not in kitty keyboard mode for
// a key with several modifiers. A pane in that mode receives it as an
// unbound Ctrl+Alt+Shift+Pause.
const zellijNoopKey = "\x1b[57362;8u"

const (
	// zellijSlotWait bounds the wait for a session's positioning slot (a
	// client start holds it for about a second or two).
	zellijSlotWait = 3 * time.Second
	// zellijClientWait bounds the wait for a new client to be listed.
	zellijClientWait = 2 * time.Second
	// zellijPositionTries bounds the positioning attempts of one client.
	zellijPositionTries = 5
	// zellijConfirmFresh is how long a client's confirmed pane is trusted
	// before a write checks it again.
	zellijConfirmFresh = time.Second
	// zellijHiddenIdle is how long a hidden client stays after its last write.
	zellijHiddenIdle = 5 * time.Second
	// zellijHiddenSettle lets a hidden client's client process read what was
	// written to its PTY before the client can be closed.
	zellijHiddenSettle = 300 * time.Millisecond
	// zellijMaxBuffered caps a client's output kept while nothing reads it.
	zellijMaxBuffered = 8 << 20
)

// errZellijClientExited: the client ended before it was listed.
var errZellijClientExited = errors.New("zellij client exited")

// zellijAttachTries bounds the attempts to start one client.
const zellijAttachTries = 4

// errZellijBusy refuses an attach or a write that could not get a positioned
// client; the PWA retries.
var errZellijBusy = &codedError{code: "busy", msg: "zellij is busy, try again", status: 503}

// zellijAttachOptions follow the session name on every client Termote
// starts. They are also what isZellijStreamCmdline matches, so the reaper
// never takes a user's own `zellij attach` for an orphan.
// (`--default-mode locked` is not one of them: Zellij then drops every key
// of the client until its mode is switched; switch-mode locks it instead.)
var zellijAttachOptions = []string{"options", "--show-startup-tips", "false", "--show-release-notes", "false"}

// zellijAttachArgv attaches a client to session. The name is passable
// (zellijPassableName): it never starts with '-' and is not a subcommand.
func zellijAttachArgv(session string) []string {
	return append([]string{zellijBin, "attach", session}, zellijAttachOptions...)
}

// zellijSubscribeArgv streams one pane's renders (the view-only stream).
func zellijSubscribeArgv(session string, n int) []string {
	return []string{zellijBin, "--session", session, "subscribe", "--pane-id", zellijTerminal(n), "--ansi", "-f", "json"}
}

// isZellijStreamCmdline matches the command line of zellijAttachArgv or
// zellijSubscribeArgv, for reapOrphanTerminals.
func isZellijStreamCmdline(cmdline string) bool {
	if rest, ok := strings.CutPrefix(cmdline, zellijBin+" attach "); ok {
		return strings.HasSuffix(rest, " "+strings.Join(zellijAttachOptions, " ")) &&
			len(rest) > len(strings.Join(zellijAttachOptions, " "))+1
	}
	if rest, ok := strings.CutPrefix(cmdline, zellijBin+" --session "); ok {
		name, tail, ok := strings.Cut(rest, " subscribe --pane-id terminal_")
		num, flags, ok2 := strings.Cut(tail, " ")
		return ok && ok2 && name != "" && zellijNumRe.MatchString(num) && flags == "--ansi -f json"
	}
	return false
}

// zellijOutput keeps a client's output from its start until something reads
// it: a client whose terminal stops taking output stalls, so it is drained
// at once, and the stream pump replays it once it starts.
type zellijOutput struct {
	mu      sync.Mutex
	cond    *sync.Cond
	buf     []byte
	err     error
	discard bool
	total   int // bytes written, discarded ones included
	// onOverflow ends the client once its unread output passed the cap.
	onOverflow func()
}

func newZellijOutput() *zellijOutput {
	o := &zellijOutput{}
	o.cond = sync.NewCond(&o.mu)
	return o
}

func (o *zellijOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.total += len(p)
	o.cond.Broadcast()
	if o.discard || o.err != nil {
		return len(p), nil
	}
	if len(o.buf)+len(p) > zellijMaxBuffered {
		o.err = errors.New("zellij client output not read")
		o.buf = nil
		if o.onOverflow != nil {
			go o.onOverflow()
		}
	} else {
		o.buf = append(o.buf, p...)
	}
	o.cond.Broadcast()
	return len(p), nil
}

// zellijDrawn is how much output shows a client has drawn its first screen:
// more than its startup sequences and queries, which come before it
// connects.
const zellijDrawn = 1024

// zellijRemovalSettle is the pause between the last command and a client
// connecting (see zellijGate).
const zellijRemovalSettle = 150 * time.Millisecond

// zellijConnectWait bounds the wait for a new client's first screen.
const zellijConnectWait = 1500 * time.Millisecond

// waitDrawn waits until zellijDrawn bytes were written, the output ended,
// or max passed.
func (o *zellijOutput) waitDrawn(max time.Duration) {
	t := time.AfterFunc(max, func() {
		o.mu.Lock()
		o.cond.Broadcast()
		o.mu.Unlock()
	})
	defer t.Stop()
	deadline := time.Now().Add(max)
	o.mu.Lock()
	defer o.mu.Unlock()
	for o.total < zellijDrawn && o.err == nil && time.Now().Before(deadline) {
		o.cond.Wait()
	}
}

func (o *zellijOutput) close(err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.err == nil {
		o.err = err
	}
	o.cond.Broadcast()
}

func (o *zellijOutput) Read(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for len(o.buf) == 0 && o.err == nil {
		o.cond.Wait()
	}
	if len(o.buf) == 0 {
		return 0, o.err
	}
	n := copy(p, o.buf)
	o.buf = o.buf[n:]
	return n, nil
}

// zellijClient is one client Termote runs, positioned on terminal_N of its
// session.
type zellijClient struct {
	m       *zellijMux
	session string
	id      string // Zellij's client id
	term    TermStream
	out     *zellijOutput
	hidden  bool

	mu        sync.Mutex
	pane      int       // terminal_N it was last confirmed on
	confirmed time.Time // when
	lastUse   time.Time // hidden clients: the last write
	closed    bool

	closeOnce sync.Once
}

// zellijClientList parses `list-clients`: a header, then one client a line,
// its id and the pane it shows. A header alone is a session without
// clients.
func zellijClientList(out string) map[string]string {
	clients := map[string]string{}
	for i, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 2 {
			continue
		}
		clients[f[0]] = f[1]
	}
	return clients
}

// zellijClients lists the session's clients: id → the pane each shows.
func zellijClients(ctx context.Context, session string) (map[string]string, error) {
	out, err := zellijQuery(ctx, session, func(out []byte) bool {
		return strings.HasPrefix(strings.TrimSpace(string(out)), "CLIENT_ID")
	}, "list-clients")
	if err != nil {
		return nil, err
	}
	return zellijClientList(string(out)), nil
}

// sessionSlot returns the session's one-slot channel: every client start and
// positioning of a session runs alone.
func (m *zellijMux) sessionSlot(session string) chan struct{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.slots[session]
	if !ok {
		s = make(chan struct{}, 1)
		m.slots[session] = s
	}
	return s
}

func (m *zellijMux) lockSession(ctx context.Context, session string) (func(), error) {
	slot := m.sessionSlot(session)
	t := time.NewTimer(zellijSlotWait)
	defer t.Stop()
	select {
	case slot <- struct{}{}:
		return func() { <-slot }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.C:
		return nil, errZellijBusy
	}
}

// startClient attaches a new client to session in a PTY of size and
// positions it on terminal_n. The caller holds the session's slot.
func (m *zellijMux) startClient(ctx context.Context, session string, n int, size Size, hidden bool) (*zellijClient, error) {
	for try := 0; ; try++ {
		c, err := m.attachClient(ctx, session, n, size, hidden)
		if err == nil {
			return c, nil
		}
		// Zellij now and then drops a client right after it attaches.
		if !errors.Is(err, errZellijClientExited) || try+1 >= zellijAttachTries {
			return nil, err
		}
		log.Printf("zellij: a client of %q was dropped as it attached, attaching again", session)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// attachClient is one attempt of startClient.
func (m *zellijMux) attachClient(ctx context.Context, session string, n int, size Size, hidden bool) (*zellijClient, error) {
	before, err := m.clientsAfterDepartures(ctx, session)
	if err != nil {
		return nil, err
	}
	zellijGate.Lock()
	// A command that just ended may still have its second removal queued in
	// the server.
	time.Sleep(zellijRemovalSettle)
	term, err := startTerminal(zellijAttachArgv(session), size)
	if err != nil {
		zellijGate.Unlock()
		return nil, err
	}
	out := newZellijOutput()
	out.discard = hidden
	c := &zellijClient{m: m, session: session, term: term, out: out, hidden: hidden, pane: -1}
	out.onOverflow = c.close
	go func() {
		_, err := io.Copy(out, term)
		if err == nil {
			err = io.EOF
		}
		out.close(err)
	}()
	out.waitDrawn(zellijConnectWait)
	zellijGate.Unlock()
	fail := func(err error) (*zellijClient, error) {
		c.close()
		return nil, err
	}
	if c.id, err = waitNewZellijClient(ctx, session, before, term.Done()); err != nil {
		return fail(err)
	}
	if err := c.position(ctx, n); err != nil {
		return fail(err)
	}
	if err := c.lock(ctx); err != nil {
		return fail(err)
	}
	m.addClient(c)
	go func() {
		<-c.term.Done()
		c.close()
	}()
	if hidden {
		c.mu.Lock()
		c.lastUse = time.Now()
		c.mu.Unlock()
		go c.closeWhenIdle()
	}
	return c, nil
}

// zellijDepartWait bounds the wait for clients Termote closed to leave the
// session's listing.
const zellijDepartWait = time.Second

// clientsAfterDepartures lists the session's clients once every client
// Termote closed there is gone from the listing (or zellijDepartWait has
// passed). Zellij reuses client ids: a client attached while the server
// still removes a closed one can get its id and be removed in its place.
func (m *zellijMux) clientsAfterDepartures(ctx context.Context, session string) (map[string]string, error) {
	deadline := time.Now().Add(zellijDepartWait)
	for {
		clients, err := zellijClients(ctx, session)
		if err != nil {
			return nil, err
		}
		m.mu.Lock()
		waiting := false
		for id, at := range m.departed[session] {
			if _, listed := clients[id]; !listed || time.Since(at) > zellijDepartWait {
				delete(m.departed[session], id)
				continue
			}
			waiting = true
		}
		m.mu.Unlock()
		if !waiting || time.Now().After(deadline) {
			return clients, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// waitNewZellijClient waits for the one client that was not in before.
func waitNewZellijClient(ctx context.Context, session string, before map[string]string, exited <-chan struct{}) (string, error) {
	deadline := time.Now().Add(zellijClientWait)
	for {
		now, err := zellijClients(ctx, session)
		if err != nil && !errors.Is(err, errZellijEmpty) {
			return "", err
		}
		var added []string
		for id := range now {
			if _, ok := before[id]; !ok {
				added = append(added, id)
			}
		}
		switch {
		case len(added) == 1:
			return added[0], nil
		case len(added) > 1:
			// Another client attached meanwhile: which is ours is unknown.
			return "", errZellijBusy
		}
		if time.Now().After(deadline) {
			return "", errZellijBusy
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-exited:
			return "", errZellijClientExited
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// position moves the client to terminal_n (see the top of this file). The
// caller holds the session's slot.
func (c *zellijClient) position(ctx context.Context, n int) error {
	target := zellijTerminal(n)
	for try := 0; try < zellijPositionTries; try++ {
		// Even a client listed on the target gets the key and the action:
		// the key makes it the last active client, which the switch-mode
		// that follows a new client's positioning needs as well.
		before, err := zellijClients(ctx, c.session)
		if err != nil {
			return err
		}
		if _, ok := before[c.id]; !ok {
			return errZellijClientExited
		}
		// The action follows at once: starting the CLI takes longer than the
		// client takes to pass the key on, and every millisecond between
		// the two is one where a user's keystroke would take the action.
		if _, err := c.term.Write([]byte(zellijNoopKey)); err != nil {
			return err
		}
		// "already focused" is the target client on the pane already. A
		// failed action is tried again by the next attempt.
		if _, err := zellijAction(ctx, c.session, "focus-pane-id", target); err != nil &&
			!zellijFailedWith(err, "is already focused") && ctx.Err() != nil {
			return err
		}
		after, err := zellijClients(ctx, c.session)
		if err != nil {
			return err
		}
		// Checked on success too: this client may have been on the target
		// already while a user's keystroke made the action move theirs.
		// (Focusing a tiled pane also hides the tab's floating panes for
		// everyone: a client that was on one of them counts as moved and is
		// put back, which shows them again.)
		var moved []string
		for id, pane := range before {
			if id != c.id && after[id] != "" && after[id] != pane {
				moved = append(moved, id)
			}
		}
		if len(moved) > 0 {
			// Another client typed between the keystroke and the action, so
			// the action moved it. It is still the last active client: put
			// it back, then try again.
			if err := restoreZellijClients(ctx, c.session, moved, before); err != nil {
				return err
			}
			continue
		}
		if after[c.id] == target {
			c.setPane(n)
			return nil
		}
	}
	return errZellijBusy
}

// lock puts the client in Zellij's locked mode. switch-mode acts on the
// last client that sent a key, so the no-op key goes right before it, with
// no other command in between.
func (c *zellijClient) lock(ctx context.Context) error {
	var err error
	for try := 0; try < 3; try++ {
		if _, err = c.term.Write([]byte(zellijNoopKey)); err != nil {
			return err
		}
		if _, err = zellijAction(ctx, c.session, "switch-mode", "locked"); err == nil || ctx.Err() != nil {
			return err
		}
	}
	return err
}

// restoreZellijClients moves each client in moved back to its pane in
// before, through the "last client" rule that moved it, and checks it
// arrived. A client that could not be put back fails the positioning.
func restoreZellijClients(ctx context.Context, session string, moved []string, before map[string]string) error {
	for attempt := 0; attempt < 2; attempt++ {
		for _, id := range moved {
			log.Printf("zellij: positioning moved client %s, moving it back", id)
			if _, err := zellijAction(ctx, session, "focus-pane-id", before[id]); err != nil &&
				!zellijFailedWith(err, "is already focused") && ctx.Err() != nil {
				return err
			}
		}
		now, err := zellijClients(ctx, session)
		if err != nil {
			return err
		}
		var still []string
		for _, id := range moved {
			if p, ok := now[id]; ok && p != before[id] {
				still = append(still, id)
			}
		}
		if len(still) == 0 {
			return nil
		}
		moved = still
	}
	log.Printf("zellij: could not move clients %v back after positioning", moved)
	return errZellijBusy
}

func (c *zellijClient) setPane(n int) {
	c.mu.Lock()
	c.pane, c.confirmed = n, time.Now()
	c.mu.Unlock()
}

// close ends the client and forgets it.
func (c *zellijClient) close() {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		c.mu.Unlock()
		c.m.removeClient(c)
		c.term.Close()
		if c.id != "" {
			c.m.mu.Lock()
			if c.m.departed[c.session] == nil {
				c.m.departed[c.session] = map[string]time.Time{}
			}
			c.m.departed[c.session][c.id] = time.Now()
			c.m.mu.Unlock()
		}
		c.out.close(io.EOF)
	})
}

func (m *zellijMux) addClient(c *zellijClient) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clients[c.session] = append(m.clients[c.session], c)
}

func (m *zellijMux) removeClient(c *zellijClient) {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := m.clients[c.session]
	for i, x := range list {
		if x == c {
			m.clients[c.session] = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	if len(m.clients[c.session]) == 0 {
		delete(m.clients, c.session)
	}
}

func (m *zellijMux) sessionClients(session string) []*zellijClient {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]*zellijClient(nil), m.clients[session]...)
}

// writeToPane writes p (keys, or a bracketed paste) through a Termote client
// on terminal_n: a stream's client already there, else the session's hidden
// client moved there, else a new hidden one. A client's pane is checked
// again when it was confirmed more than zellijConfirmFresh ago.
func (m *zellijMux) writeToPane(ctx context.Context, session string, n int, p []byte) error {
	return zellijTransient(m.writeToPaneOnce(ctx, session, n, p))
}

// zellijTransient answers a failure Zellij may not repeat (a client or
// command dropped, a listing that stayed empty) as 503 busy, which the PWA
// retries.
func zellijTransient(err error) error {
	if errors.Is(err, errZellijClientExited) || errors.Is(err, errZellijEmpty) || errors.Is(err, errZellijNoSession) {
		return errZellijBusy
	}
	return err
}

func (m *zellijMux) writeToPaneOnce(ctx context.Context, session string, n int, p []byte) error {
	unlock, err := m.lockSession(ctx, session)
	if err != nil {
		return err
	}
	defer unlock()
	clients := m.sessionClients(session)
	var listed map[string]string
	for _, c := range clients {
		c.mu.Lock()
		pane, fresh, closed := c.pane, time.Since(c.confirmed) < zellijConfirmFresh, c.closed
		c.mu.Unlock()
		if closed {
			continue
		}
		if !fresh || pane != n {
			if listed == nil {
				if listed, err = zellijClients(ctx, session); err != nil {
					return err
				}
			}
			if listed[c.id] != zellijTerminal(n) {
				continue
			}
			c.setPane(n)
		}
		return c.write(p)
	}
	var hidden *zellijClient
	for _, c := range clients {
		c.mu.Lock()
		usable := c.hidden && !c.closed
		if usable {
			// Picked: the idle close must not take it while it is used.
			c.lastUse = time.Now()
		}
		c.mu.Unlock()
		if usable {
			hidden = c
			break
		}
	}
	if hidden != nil {
		if err := hidden.position(ctx, n); err != nil {
			hidden.close()
			hidden = nil
		}
	}
	if hidden == nil {
		size, err := m.tabSize(ctx, session, n)
		if err != nil {
			return err
		}
		if hidden, err = m.startClient(ctx, session, n, size, true); err != nil {
			return err
		}
	}
	if err := hidden.write(p); err != nil {
		return err
	}
	// The client reads its PTY on its own schedule; give it time before an
	// idle close can drop what it has not read yet.
	time.Sleep(zellijHiddenSettle)
	return nil
}

// write sends p to the client's PTY.
func (c *zellijClient) write(p []byte) error {
	if _, err := c.term.Write(p); err != nil {
		return err
	}
	if c.hidden {
		c.mu.Lock()
		c.lastUse = time.Now()
		c.mu.Unlock()
	}
	return nil
}

// closeWhenIdle closes a hidden client zellijHiddenIdle after its last write.
func (c *zellijClient) closeWhenIdle() {
	for {
		c.mu.Lock()
		wait := zellijHiddenIdle - time.Since(c.lastUse)
		closed := c.closed
		c.mu.Unlock()
		if closed {
			return
		}
		if wait <= 0 {
			c.close()
			return
		}
		select {
		case <-c.term.Done():
			return
		case <-time.After(wait):
		}
	}
}

// zellijClientStream is a full stream: the client's PTY, its output read from
// the buffer that has kept it since the client started.
type zellijClientStream struct{ c *zellijClient }

func (s zellijClientStream) Read(p []byte) (int, error)  { return s.c.out.Read(p) }
func (s zellijClientStream) Write(p []byte) (int, error) { return s.c.term.Write(p) }
func (s zellijClientStream) Resize(sz Size) error        { return s.c.term.Resize(sz) }
func (s zellijClientStream) Done() <-chan struct{}       { return s.c.term.Done() }
func (s zellijClientStream) ExitCode() int               { return s.c.term.ExitCode() }
func (s zellijClientStream) Close() error {
	s.c.close()
	return nil
}

// checkDrift closes every stream client of session no longer on its pane
// (a click on another pane or tab in the stream): the PWA reconnects to the
// pane it shows. clients is the session's `list-clients`.
func (m *zellijMux) checkDrift(session string, clients map[string]string) {
	for _, c := range m.sessionClients(session) {
		c.mu.Lock()
		pane := c.pane
		c.mu.Unlock()
		if c.hidden {
			continue
		}
		if got, ok := clients[c.id]; ok && got != zellijTerminal(pane) {
			log.Printf("zellij: stream client %s left %s, closing it", c.id, zellijTerminal(pane))
			go c.close()
		}
	}
}
