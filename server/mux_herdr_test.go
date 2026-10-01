package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeHerdr is a herdr server on a temporary Unix socket (a named pipe on
// Windows, see listenHerdrTest). Replies follow the
// shapes recorded from herdr 0.9.1 (protocol 22).
type fakeHerdr struct {
	t       *testing.T
	path    string
	ln      net.Listener
	stopped atomic.Bool // close was called; the accept loop ends

	mu        sync.Mutex
	snapshot  map[string]any // session.snapshot result.snapshot
	protocol  int
	calls     map[string]int
	params    map[string][]json.RawMessage
	texts     []string
	inFlight  int
	maxFlight int
	sendDelay bool
	hang      bool
	snapDelay time.Duration // session.snapshot replies this late, with the state from before
	failCode  string        // next tab.* or pane.close call fails with this error code
	subs      []net.Conn
	scroll    int // pane.get offset_from_bottom; pane.scroll sets it, clamped to scrollMax
	scrollMax int
	agent     string         // pane.get agent
	paneExtra map[string]any // more pane.get fields (agent_session, agent_status)
	readText  string         // pane.read text
}

func fakeSocketPath(t *testing.T) string {
	t.Helper()
	// Unix socket paths are limited to ~104 bytes; t.TempDir can be longer.
	dir, err := os.MkdirTemp("", "herdr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "herdr.sock")
}

func newFakeHerdr(t *testing.T) *fakeHerdr {
	t.Helper()
	f := &fakeHerdr{t: t, protocol: herdrProtocol, calls: map[string]int{}, params: map[string][]json.RawMessage{}}
	f.snapshot = loadHerdrFixture(t)
	f.listen(fakeSocketPath(t))
	return f
}

func loadHerdrFixture(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile("testdata/herdr-snapshot.json")
	if err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Result struct {
			Snapshot map[string]any `json:"snapshot"`
		} `json:"result"`
	}
	if err := json.Unmarshal(b, &reply); err != nil {
		t.Fatal(err)
	}
	return reply.Result.Snapshot
}

func (f *fakeHerdr) listen(path string) {
	ln := listenHerdrTest(f.t, path)
	f.path, f.ln = path, ln
	f.t.Cleanup(f.close)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				// A named pipe can fail one accept (a client that left while
				// connecting) without the listener being closed.
				if f.stopped.Load() {
					return
				}
				time.Sleep(10 * time.Millisecond)
				continue
			}
			go f.handle(c)
		}
	}()
}

func (f *fakeHerdr) close() {
	f.stopped.Store(true)
	f.ln.Close()
	f.mu.Lock()
	for _, c := range f.subs {
		c.Close()
	}
	f.subs = nil
	f.mu.Unlock()
}

func (f *fakeHerdr) handle(c net.Conn) {
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil {
		c.Close()
		return
	}
	var req struct {
		ID     string          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(line, &req); err != nil {
		c.Close()
		return
	}
	f.mu.Lock()
	f.calls[req.Method]++
	f.params[req.Method] = append(f.params[req.Method], req.Params)
	hang, failCode := f.hang, f.failCode
	if strings.HasPrefix(req.Method, "tab.") || req.Method == "pane.close" {
		f.failCode = ""
	}
	f.mu.Unlock()

	reply := func(result any) {
		b, _ := json.Marshal(map[string]any{"id": req.ID, "result": result})
		c.Write(append(b, '\n'))
		c.Close()
	}
	fail := func(code string) {
		b, _ := json.Marshal(map[string]any{"id": req.ID, "error": map[string]string{"code": code, "message": code}})
		c.Write(append(b, '\n'))
		c.Close()
	}
	var p map[string]any
	json.Unmarshal(req.Params, &p)

	switch req.Method {
	case "ping":
		f.mu.Lock()
		proto := f.protocol
		f.mu.Unlock()
		reply(map[string]any{"type": "pong", "version": "0.9.1", "protocol": proto})
	case "session.snapshot":
		if hang {
			time.Sleep(2 * time.Second)
			c.Close()
			return
		}
		f.mu.Lock()
		snap, _ := json.Marshal(f.snapshot)
		delay := f.snapDelay
		f.mu.Unlock()
		time.Sleep(delay)
		reply(map[string]any{"type": "session_snapshot", "snapshot": json.RawMessage(snap)})
	case "events.subscribe":
		b, _ := json.Marshal(map[string]any{"id": req.ID, "result": map[string]string{"type": "subscription_started"}})
		c.Write(append(b, '\n'))
		f.mu.Lock()
		f.subs = append(f.subs, c)
		f.mu.Unlock()
	case "tab.create", "tab.rename", "tab.close", "pane.close":
		if failCode != "" {
			fail(failCode)
			return
		}
		if req.Method == "tab.close" || req.Method == "pane.close" {
			reply(map[string]string{"type": "ok"})
			return
		}
		reply(map[string]any{"type": "tab_created", "tab": map[string]any{"tab_id": "wR:tNEW", "workspace_id": "wR"}})
	case "pane.get", "pane.scroll":
		f.mu.Lock()
		if req.Method == "pane.scroll" {
			f.scroll = max(0, min(int(p["offset_from_bottom"].(float64)), f.scrollMax))
		}
		scroll := map[string]int{"offset_from_bottom": f.scroll, "max_offset_from_bottom": f.scrollMax, "viewport_rows": 41}
		agent := f.agent
		pane := map[string]any{"pane_id": p["pane_id"], "scroll": scroll}
		for k, v := range f.paneExtra {
			pane[k] = v
		}
		f.mu.Unlock()
		if agent != "" {
			pane["agent"] = agent
		}
		reply(map[string]any{"type": "pane_info", "pane": pane})
	case "pane.read":
		f.mu.Lock()
		text := f.readText
		f.mu.Unlock()
		reply(map[string]any{"type": "pane_read", "read": map[string]any{"pane_id": p["pane_id"], "text": text, "revision": 0}})
	case "pane.send_text":
		f.mu.Lock()
		f.inFlight++
		f.maxFlight = max(f.maxFlight, f.inFlight)
		delay := f.sendDelay
		f.mu.Unlock()
		if delay {
			time.Sleep(time.Duration(rand.Intn(1500)) * time.Microsecond)
		}
		f.mu.Lock()
		f.inFlight--
		f.texts = append(f.texts, p["text"].(string))
		f.mu.Unlock()
		reply(map[string]string{"type": "ok"})
	default:
		fail("unknown_method")
	}
}

// emit sends one event line to every open subscription.
func (f *fakeHerdr) emit(event string, data map[string]any) {
	data["type"] = event
	b, _ := json.Marshal(map[string]any{"event": event, "data": data})
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.subs {
		c.Write(append(b, '\n'))
	}
}

// emitLayout reports pane's rect as width x height, as layout_updated does.
func (f *fakeHerdr) emitLayout(pane string, width, height int) {
	f.emit("layout_updated", map[string]any{"layout": map[string]any{
		"tab_id": "wR:t3",
		"panes":  []any{map[string]any{"pane_id": pane, "rect": map[string]int{"x": 0, "y": 0, "width": width, "height": height}}},
	}})
}

func (f *fakeHerdr) count(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[method]
}

func (f *fakeHerdr) lastParams(t *testing.T, method string) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	ps := f.params[method]
	if len(ps) == 0 {
		t.Fatalf("%s never called", method)
	}
	var p map[string]any
	json.Unmarshal(ps[len(ps)-1], &p)
	return p
}

// newTestHerdrMux connects to f and waits until the event subscription is up.
func newTestHerdrMux(t *testing.T, f *fakeHerdr) *herdrMux {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m, err := newHerdrMux(ctx, f.path)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "herdr subscription", func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.connected
	})
	return m
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestHerdrRPC(t *testing.T) {
	f := newFakeHerdr(t)
	c := &herdrRPC{socket: f.path}

	p, err := c.ping(context.Background())
	if err != nil || p.Protocol != herdrProtocol || p.Version != "0.9.1" {
		t.Fatalf("ping = %+v, %v", p, err)
	}

	var he *herdrError
	if err := c.call(context.Background(), "no.such.method", nil, nil); !errors.As(err, &he) || he.Code != "unknown_method" {
		t.Errorf("unknown method error = %v, want herdrError unknown_method", err)
	}

	f.hang = true
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := c.call(ctx, "session.snapshot", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("hung call error = %v, want deadline exceeded", err)
	}
	if d := time.Since(start); d > time.Second {
		t.Errorf("hung call took %s", d)
	}

	missing := &herdrRPC{socket: filepath.Join(filepath.Dir(f.path), "missing.sock")}
	if _, err := missing.ping(context.Background()); err == nil {
		t.Error("ping on a missing socket should fail")
	}

	// A request over herdr's limit is refused before it is sent.
	big := strings.Repeat("a", herdrMaxRequest)
	if err := c.call(context.Background(), "pane.send_text", map[string]string{"text": big}, nil); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("oversized request error = %v", err)
	}
}

func TestHerdrReadError(t *testing.T) {
	ctx := context.Background()
	if err := herdrReadError(ctx, "ping", os.ErrDeadlineExceeded); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("socket deadline: %v, want context.DeadlineExceeded", err)
	}
	if err := herdrReadError(ctx, "ping", io.EOF); !errors.Is(err, io.EOF) || errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("EOF: %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := herdrReadError(canceled, "ping", io.EOF); !errors.Is(err, context.Canceled) {
		t.Errorf("canceled: %v, want context.Canceled", err)
	}
}

func TestReadHerdrReplyRejectsBadLines(t *testing.T) {
	for _, line := range []string{"not json\n", `{"id":"1"}` + "\n", ""} {
		if _, err := readHerdrReply(bufio.NewReader(strings.NewReader(line))); err == nil {
			t.Errorf("readHerdrReply(%q) should fail", line)
		}
	}
}

func TestMapHerdrSnapshot(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	snap, err := m.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Groups) != 2 || snap.Groups[0].ID != "wR" || snap.Groups[1].ID != "w13" {
		t.Fatalf("groups = %+v, want wR then w13 (herdr number order)", snap.Groups)
	}
	wr := snap.Groups[0]
	if wr.Name != "project-a" {
		t.Errorf("group name = %q", wr.Name)
	}
	var ids []string
	for _, tab := range wr.Tabs {
		ids = append(ids, tab.ID)
		if tab.Active != (tab.ID == "wR:tK") {
			t.Errorf("tab %s active = %v; active_tab_id is wR:tK", tab.ID, tab.Active)
		}
	}
	if got := strings.Join(ids, ","); got != "wR:t3,wR:tK,wR:tP,wR:tV" {
		t.Errorf("tab order = %s", got)
	}
	shell := wr.Tabs[0].Panes[0]
	if shell.Agent != nil || shell.Title != "user@host:~/project-a" || !shell.Active {
		t.Errorf("shell pane = %+v", shell)
	}
	agent := wr.Tabs[1].Panes[0].Agent
	if agent == nil || agent.Name != "claude" || agent.Status != "idle" {
		t.Errorf("agent pane = %+v", agent)
	}

	// Split tab: panes ordered left to right, active one from the layout.
	split := snap.Groups[1].Tabs[0]
	if len(split.Panes) != 2 || split.Panes[0].ID != "w13:p1" || split.Panes[1].ID != "w13:pC" {
		t.Fatalf("split panes = %+v", split.Panes)
	}
	if split.Panes[0].Active || !split.Panes[1].Active {
		t.Errorf("split active = %v,%v; focused_pane_id is w13:pC", split.Panes[0].Active, split.Panes[1].Active)
	}

	v, _ := m.view(context.Background())
	if v.sizes["w13:p1"] != (Size{Cols: 42, Rows: 36}) || v.sizes["wR:p3"] != (Size{Cols: 108, Rows: 36}) {
		t.Errorf("sizes = %v", v.sizes)
	}
}

func TestMapHerdrSnapshotUnknownStatus(t *testing.T) {
	var s herdrSnapshot
	json.Unmarshal([]byte(`{
		"workspaces":[{"workspace_id":"w1","number":1,"label":"a","active_tab_id":"w1:t1"}],
		"tabs":[{"tab_id":"w1:t1","workspace_id":"w1","number":1,"label":"t"}],
		"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","agent":"codex","agent_status":"thinking_hard"},
		         {"pane_id":"w1:p2","tab_id":"w1:t1","agent":"claude","agent_status":"blocked"}],
		"layouts":[]}`), &s)
	v := mapHerdrSnapshot(s)
	panes := v.snap.Groups[0].Tabs[0].Panes
	if panes[0].Agent.Status != "unknown" || panes[1].Agent.Status != "blocked" {
		t.Errorf("statuses = %s, %s", panes[0].Agent.Status, panes[1].Agent.Status)
	}
}

func TestHerdrSnapshotCache(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	m.Snapshot(ctx)
	base := f.count("session.snapshot")
	for i := 0; i < 5; i++ {
		m.Snapshot(ctx)
	}
	if n := f.count("session.snapshot") - base; n != 0 {
		t.Errorf("cached snapshot refetched %d times", n)
	}

	// An agent status change marks the cache stale; the next request sees it.
	f.mu.Lock()
	f.snapshot["panes"].([]any)[1].(map[string]any)["agent_status"] = "working"
	f.mu.Unlock()
	f.emit("pane_agent_status_changed", map[string]any{"pane_id": "wR:p1V", "agent_status": "working"})
	waitUntil(t, "cache invalidation", func() bool {
		snap, _ := m.Snapshot(ctx)
		return snap.Groups[0].Tabs[1].Panes[0].Agent.Status == "working"
	})

	// Without a live subscription the cache is bypassed.
	f.close()
	waitUntil(t, "subscription drop", func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return !m.connected
	})
	if _, err := m.Snapshot(ctx); err == nil {
		t.Error("snapshot with herdr gone should fail, not serve the cache")
	}
}

func TestHerdrSubscribesAgentStatusPerPane(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	subs := func() map[string]bool {
		p := f.lastParams(t, "events.subscribe")
		panes := map[string]bool{}
		types := map[string]bool{}
		for _, s := range p["subscriptions"].([]any) {
			s := s.(map[string]any)
			types[s["type"].(string)] = true
			if s["type"] == "pane.agent_status_changed" {
				panes[s["pane_id"].(string)] = true
			}
		}
		for _, want := range []string{"tab.created", "pane.closed", "layout.updated", "pane.agent_detected"} {
			if !types[want] {
				t.Errorf("not subscribed to %s", want)
			}
		}
		return panes
	}
	if got := subs(); len(got) != 7 || !got["w13:pC"] {
		t.Fatalf("agent_status_changed panes = %v, want all 7", got)
	}

	// A new pane shows up in the next snapshot and triggers a resubscription.
	f.mu.Lock()
	f.snapshot["panes"] = append(f.snapshot["panes"].([]any), map[string]any{"pane_id": "wR:pNEW", "tab_id": "wR:t3", "agent_status": "unknown"})
	layouts := f.snapshot["layouts"].([]any)
	l := layouts[0].(map[string]any)
	l["panes"] = append(l["panes"].([]any), map[string]any{"pane_id": "wR:pNEW", "rect": map[string]int{"x": 0, "y": 20, "width": 108, "height": 16}})
	f.mu.Unlock()
	f.emit("pane_created", map[string]any{})
	// Poll like the PWA: the event reaches the cache asynchronously.
	waitUntil(t, "resubscription", func() bool {
		m.Snapshot(context.Background())
		return f.count("events.subscribe") >= 2 && subs()["wR:pNEW"]
	})
}

func TestHerdrReconnectsWhenSocketAppears(t *testing.T) {
	path := fakeSocketPath(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m, _ := newHerdrMux(ctx, path)
	if err := m.Health(ctx); err == nil {
		t.Error("health without herdr should be degraded")
	}
	if _, err := m.Snapshot(ctx); err == nil {
		t.Error("snapshot without herdr should fail")
	}
	f := &fakeHerdr{t: t, protocol: herdrProtocol, calls: map[string]int{}, params: map[string][]json.RawMessage{}, snapshot: loadHerdrFixture(t)}
	f.listen(path)
	waitUntil(t, "reconnect", func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.connected
	})
	if err := m.Health(ctx); err != nil {
		t.Errorf("health after herdr started: %v", err)
	}
}

func TestHerdrReachable(t *testing.T) {
	f := newFakeHerdr(t)
	t.Setenv("HERDR_SOCKET_PATH", f.path)
	if !herdrReachable() {
		t.Error("herdr not reachable while listening")
	}
	f.close()
	if herdrReachable() {
		t.Error("herdr reachable after it stopped listening")
	}
}

func TestHerdrHealthProtocolMismatch(t *testing.T) {
	f := newFakeHerdr(t)
	f.protocol = herdrProtocol + 1
	m := newTestHerdrMux(t, f)
	if err := m.Health(context.Background()); err == nil || !strings.Contains(err.Error(), "protocol") {
		t.Errorf("health = %v, want protocol mismatch", err)
	}
}

func TestHerdrTabOps(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ctx := context.Background()

	id, err := m.NewTab(ctx, "wR", "notes")
	if err != nil || id != "wR:tNEW" {
		t.Fatalf("NewTab = %q, %v", id, err)
	}
	p := f.lastParams(t, "tab.create")
	if p["workspace_id"] != "wR" || p["label"] != "notes" || p["focus"] != false {
		t.Errorf("tab.create params = %v; must not focus the desktop", p)
	}
	if _, err := m.NewTab(ctx, "", ""); err != nil {
		t.Errorf("NewTab in the focused workspace: %v", err)
	}
	if p := f.lastParams(t, "tab.create"); p["workspace_id"] != nil || p["label"] != nil {
		t.Errorf("empty group/name should be omitted, got %v", p)
	}

	if err := m.RenameTab(ctx, "wR:t3", "shell"); err != nil {
		t.Errorf("RenameTab: %v", err)
	}
	if p := f.lastParams(t, "tab.rename"); p["tab_id"] != "wR:t3" || p["label"] != "shell" {
		t.Errorf("tab.rename params = %v", p)
	}
	if err := m.CloseTab(ctx, "wR:t3"); err != nil {
		t.Errorf("CloseTab: %v", err)
	}
	if err := m.ClosePane(ctx, "wR:p3"); err != nil {
		t.Errorf("ClosePane: %v", err)
	}
	if p := f.lastParams(t, "pane.close"); p["pane_id"] != "wR:p3" {
		t.Errorf("pane.close params = %v", p)
	}

	var ie inputError
	bad := []struct {
		name string
		err  error
	}{
		{"new tab bad group", func() error { _, err := m.NewTab(ctx, "-w1", ""); return err }()},
		{"new tab unknown group", func() error { _, err := m.NewTab(ctx, "wZZ", ""); return err }()},
		{"new tab control char", func() error { _, err := m.NewTab(ctx, "wR", "a\x1bb"); return err }()},
		{"close bad id", m.CloseTab(ctx, "--help")},
		{"close pane id", m.CloseTab(ctx, "wR:p3")},
		{"close unknown", m.CloseTab(ctx, "wR:tZZ")},
		{"rename empty", m.RenameTab(ctx, "wR:t3", "")},
		{"close pane bad id", m.ClosePane(ctx, "--help")},
		{"close pane tab id", m.ClosePane(ctx, "wR:t3")},
		{"close pane unknown", m.ClosePane(ctx, "wR:pZZ")},
		{"send keys bad pane", m.SendKeys(ctx, "wR:p3 x", "a")},
		{"send keys unknown pane", m.SendKeys(ctx, "wR:pZZ", "a")},
	}
	for _, b := range bad {
		if !errors.As(b.err, &ie) {
			t.Errorf("%s: err = %v, want inputError", b.name, b.err)
		}
	}

	// The tab vanished between the snapshot check and the call.
	f.failCode = "tab_not_found"
	if err := m.CloseTab(ctx, "wR:tK"); !errors.As(err, &ie) {
		t.Errorf("tab_not_found = %v, want inputError", err)
	}
	f.failCode = "pane_not_found"
	if err := m.ClosePane(ctx, "wR:p3"); !errors.As(err, &ie) {
		t.Errorf("pane_not_found = %v, want inputError", err)
	}

	if err := m.SelectTab(ctx, "wR:t3"); !errors.Is(err, errUnsupported) {
		t.Errorf("SelectTab = %v, want errUnsupported", err)
	}
	if f.count("tab.focus") != 0 || f.count("pane.focus") != 0 {
		t.Error("herdr backend must never focus on the desktop")
	}
}

func TestHerdrIDPatterns(t *testing.T) {
	for _, id := range []string{"w1M:p1", "wR:p1V", "w13:pC"} {
		if !herdrPaneIDRe.MatchString(id) {
			t.Errorf("pane %q rejected", id)
		}
	}
	for _, id := range []string{"", "-w1:p1", "w1:p1 --takeover", "w1:t1", "w1:p1\n", "w1:p-1", "x1:p1"} {
		if herdrPaneIDRe.MatchString(id) {
			t.Errorf("pane %q accepted", id)
		}
	}
	if !herdrTabIDRe.MatchString("wR:tK") || herdrTabIDRe.MatchString("wR:pK") {
		t.Error("tab pattern")
	}
}

func TestHerdrSendKeysInOrder(t *testing.T) {
	f := newFakeHerdr(t)
	f.sendDelay = true
	m := newTestHerdrMux(t, f)

	// Stream input: queued without waiting, like keystrokes arriving from
	// the WebSocket.
	var want strings.Builder
	var last <-chan error
	for i := 0; i < 200; i++ {
		s := fmt.Sprintf("ls -la %d\r", i)
		want.WriteString(s)
		ch, err := m.writer("wR:p3").enqueue([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		last = ch
	}
	if err := <-last; err != nil {
		t.Fatal(err)
	}
	// REST send-keys waits for the ack and joins the same queue.
	if err := m.SendKeys(context.Background(), "wR:p3", "\x1b[A\x03Việt"); err != nil {
		t.Fatal(err)
	}
	want.WriteString("\x1b[A\x03Việt")

	f.mu.Lock()
	defer f.mu.Unlock()
	if got := strings.Join(f.texts, ""); got != want.String() {
		t.Errorf("herdr received input out of order:\n got %q\nwant %q", got, want.String())
	}
	if f.maxFlight != 1 {
		t.Errorf("%d send_text calls in flight at once, want 1", f.maxFlight)
	}
	if len(f.texts) >= 200 {
		t.Errorf("%d send_text calls for 201 inputs: queued input was not merged", len(f.texts))
	}
}

func TestHerdrScroll(t *testing.T) {
	f := newFakeHerdr(t)
	f.scrollMax = 30
	m := newTestHerdrMux(t, f)
	ctx := context.Background()

	for _, step := range []struct{ lines, want int }{
		{5, 5},
		{10, 15},
		{100, 30}, // clamped to the history the pane holds
		{-12, 18},
		{-100, 0}, // back at the live screen
	} {
		if err := m.Scroll(ctx, "wR:p3", step.lines); err != nil {
			t.Fatalf("Scroll(%d): %v", step.lines, err)
		}
		f.mu.Lock()
		got := f.scroll
		f.mu.Unlock()
		if got != step.want {
			t.Errorf("Scroll(%d): offset = %d, want %d", step.lines, got, step.want)
		}
	}
	// Already at the bottom, and a zero delta: nothing to set.
	calls := f.count("pane.scroll")
	if err := m.Scroll(ctx, "wR:p3", -5); err != nil {
		t.Fatal(err)
	}
	if err := m.Scroll(ctx, "wR:p3", 0); err != nil {
		t.Fatal(err)
	}
	if n := f.count("pane.scroll"); n != calls {
		t.Errorf("%d pane.scroll calls for no movement", n-calls)
	}

	var ie inputError
	if err := m.Scroll(ctx, "-bad", 1); !errors.As(err, &ie) {
		t.Errorf("Scroll(invalid id) = %v, want inputError", err)
	}
	if err := m.Scroll(ctx, "wR:nope", 1); !errors.As(err, &ie) {
		t.Errorf("Scroll(unknown pane) = %v, want inputError", err)
	}
}

func TestHerdrScrollAgentGetsWheelReports(t *testing.T) {
	f := newFakeHerdr(t)
	f.agent = "claude" // fullscreen: no history in herdr
	m := newTestHerdrMux(t, f)
	size, err := m.requirePane(context.Background(), "wR:p3")
	if err != nil {
		t.Fatal(err)
	}
	at := fmt.Sprintf(";%d;%dM", size.Cols/2, size.Rows/2)
	if err := m.Scroll(context.Background(), "wR:p3", 2); err != nil {
		t.Fatal(err)
	}
	if err := m.Scroll(context.Background(), "wR:p3", -1000); err != nil {
		t.Fatal(err)
	}
	// Back to the live screen: Claude's own jump key.
	if err := m.Scroll(context.Background(), "wR:p3", -maxScrollLines); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.agent = "codex" // no known jump key: wheel reports, capped
	f.mu.Unlock()
	if err := m.Scroll(context.Background(), "wR:p3", -maxScrollLines); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	got := strings.Join(f.texts, "")
	f.agent = "claude"
	f.mu.Unlock()
	down := strings.Repeat("\x1b[<65"+at, maxWheelEvents)
	want := strings.Repeat("\x1b[<64"+at, 2) + down + "\x1b[1;5F" + down
	if got != want {
		t.Errorf("sent %q, want %q", got, want)
	}
	if n := f.count("pane.scroll"); n != 0 {
		t.Errorf("%d pane.scroll calls for a pane without history", n)
	}

	// An agent that does leave history in herdr is scrolled there; a shell
	// without history yet gets nothing typed at its prompt.
	f.mu.Lock()
	f.scrollMax, f.texts = 30, nil
	f.mu.Unlock()
	if err := m.Scroll(context.Background(), "wR:p3", 4); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	if f.scroll != 4 {
		t.Errorf("agent with history: offset %d, want 4", f.scroll)
	}
	f.agent, f.scroll, f.scrollMax = "", 0, 0
	f.mu.Unlock()
	if err := m.Scroll(context.Background(), "wR:p3", 4); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.texts) != 0 {
		t.Errorf("typed %q into a pane without an agent", f.texts)
	}
}

func TestHerdrScrollConcurrent(t *testing.T) {
	f := newFakeHerdr(t)
	f.scrollMax = 1000
	m := newTestHerdrMux(t, f)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := m.Scroll(context.Background(), "wR:p3", 3); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.scroll != 60 {
		t.Errorf("offset = %d after 20 concurrent scrolls of 3, want 60 (an update was lost)", f.scroll)
	}
}

func TestPaneWriterQueueLimit(t *testing.T) {
	w := &paneWriter{rpc: &herdrRPC{socket: "/nonexistent"}, pane: "w1:p1", running: true}
	if _, err := w.enqueue(make([]byte, herdrMaxQueuedInput)); err != nil {
		t.Fatal(err)
	}
	if _, err := w.enqueue([]byte("x")); err == nil {
		t.Error("enqueue past the limit should fail")
	}
}

func TestSplitUTF8(t *testing.T) {
	s := []byte(strings.Repeat("aế", 10)) // ế is 3 bytes
	chunks := splitUTF8(s, 5)
	var joined []byte
	for _, c := range chunks {
		if len(c) > 5 {
			t.Errorf("chunk %q longer than 5", c)
		}
		if !strings.HasPrefix(string(c), "a") && !strings.HasPrefix(string(c), "ế") {
			t.Errorf("chunk %q splits a rune", c)
		}
		joined = append(joined, c...)
	}
	if string(joined) != string(s) {
		t.Error("chunks do not rejoin to the input")
	}
	if got := splitUTF8(nil, 5); len(got) != 0 {
		t.Errorf("splitUTF8(nil) = %v", got)
	}
	// Invalid UTF-8 still makes progress.
	if got := splitUTF8([]byte{0x80, 0x80, 0x80, 0x80}, 2); len(got) != 2 {
		t.Errorf("continuation bytes: %d chunks", len(got))
	}
}

// useFakeObserve makes the herdr CLI this test binary running
// helperHerdrObserve, and returns a function listing the observer pids.
func useFakeObserve(t *testing.T, closeAfterFrame bool) func() []int {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	old := herdrBin
	herdrBin = self
	t.Cleanup(func() { herdrBin = old })
	pidFile := filepath.Join(t.TempDir(), "pids")
	t.Setenv(helperEnv, "herdr-observe")
	t.Setenv(observePIDFileEnv, pidFile)
	if closeAfterFrame {
		t.Setenv(observeCloseEnv, "1")
	}
	return func() []int {
		b, _ := os.ReadFile(pidFile)
		var pids []int
		for _, f := range strings.Fields(string(b)) {
			pid, _ := strconv.Atoi(f)
			pids = append(pids, pid)
		}
		return pids
	}
}

// nextSize takes the next size announcement and acknowledges it.
func nextSize(t *testing.T, ts TermStream) Size {
	t.Helper()
	select {
	case c := <-ts.(sizeReporter).Sizes():
		close(c.sent)
		return c.Size
	case <-time.After(5 * time.Second):
		t.Fatal("no size announced")
		return Size{}
	}
}

func TestHerdrStreamFollowsPaneSize(t *testing.T) {
	pids := useFakeObserve(t, false)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)

	// The client's size is ignored: observe runs at the pane's 108x36.
	ts, err := m.Attach(context.Background(), "wR:p3", Size{Cols: 40, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	if s := nextSize(t, ts); s != (Size{Cols: 108, Rows: 36}) {
		t.Errorf("announced %v, want the pane's 108x36", s)
	}
	out := newOutputReader(ts)
	out.waitFor(t, `OBSERVE wR:p3 108x36`)
	if err := ts.Resize(Size{Cols: 20, Rows: 5}); err != nil {
		t.Errorf("Resize: %v", err)
	}

	// Another pane of the tab changed: the observer keeps running.
	f.emitLayout("wR:p3", 108, 36)
	select {
	case c := <-ts.(sizeReporter).Sizes():
		t.Fatalf("unexpected size %v for an unchanged pane", c.Size)
	case <-time.After(300 * time.Millisecond):
	}

	// The desktop resized the pane: restart observe at the new size.
	f.emitLayout("wR:p3", 90, 30)
	if s := nextSize(t, ts); s != (Size{Cols: 90, Rows: 30}) {
		t.Errorf("announced %v after resize, want 90x30", s)
	}
	out.waitFor(t, `OBSERVE wR:p3 90x30`)
	first := pids()[0]
	waitDead(t, first, "observer at the old size")

	ts.Close()
	for _, pid := range pids() {
		waitDead(t, pid, "observer")
	}
	m.watchMu.Lock()
	defer m.watchMu.Unlock()
	if len(m.watchers) != 0 {
		t.Errorf("size watchers left after close: %v", m.watchers)
	}
}

func TestHerdrStreamPaneClosed(t *testing.T) {
	useFakeObserve(t, true)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "w13:pC", Size{})
	if err != nil {
		t.Fatal(err)
	}
	nextSize(t, ts)
	out := newOutputReader(ts)
	out.waitFor(t, `OBSERVE w13:pC 66x36`)
	select {
	case <-ts.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not end when the pane closed")
	}
	if code := ts.ExitCode(); code != 0 {
		t.Errorf("exit code = %d, want 0", code)
	}
	ts.Close()
}

func TestHerdrStreamRejectsUnknownPane(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	var ie inputError
	for _, pane := range []string{"wR:pZZ", "--help", "wR:t3"} {
		if _, err := m.Attach(context.Background(), pane, Size{}); !errors.As(err, &ie) {
			t.Errorf("Attach(%q) = %v, want inputError", pane, err)
		}
	}
}

// TestHerdrStreamOverWebSocket runs the whole server: the size frame arrives
// before the first output, and input reaches pane.send_text.
func TestHerdrStreamOverWebSocket(t *testing.T) {
	pids := useFakeObserve(t, false)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	h, hub, err := buildServer(testConfig(t), m)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	hdr := authHeader()
	hdr.Set("Origin", srv.URL)
	c, _, err := dialStream(t, srv.URL, "token="+fetchToken(t, srv.URL, true)+"&pane="+"wR:p3", hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()

	typ, data, err := readFrame(t, c)
	if err != nil || typ != websocket.MessageText {
		t.Fatalf("first frame = %v %q %v, want the size", typ, data, err)
	}
	var ctl streamControl
	json.Unmarshal(data, &ctl)
	if ctl.Type != "size" || ctl.Cols != 108 || ctl.Rows != 36 {
		t.Errorf("size frame = %s", data)
	}
	typ, data, err = readFrame(t, c)
	if err != nil || typ != websocket.MessageBinary || !strings.Contains(string(data), "OBSERVE wR:p3 108x36") {
		t.Fatalf("second frame = %v %q %v", typ, data, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":10,"rows":5}`))
	c.Write(ctx, websocket.MessageBinary, []byte("echo hi\r"))
	waitUntil(t, "send_text", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return strings.Join(f.texts, "") == "echo hi\r"
	})

	// Server shutdown ends the observer.
	if err := hub.shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	for _, pid := range pids() {
		waitDead(t, pid, "observer")
	}
}

func TestIsHerdrStreamCmdline(t *testing.T) {
	size := Size{Cols: 80, Rows: 24}
	for _, argv := range [][]string{herdrObserveArgv("w1:p1", size), herdrControlArgv("w1:p1", size)} {
		if !isHerdrStreamCmdline(strings.Join(argv, " ")) {
			t.Errorf("%q not matched", argv)
		}
	}
	for _, cmdline := range []string{
		"vim herdr terminal session observe x",
		"vim herdr terminal session control x",
		"herdr terminal session list",
		"herdr terminal session controlx w1:p1",
	} {
		if isHerdrStreamCmdline(cmdline) {
			t.Errorf("%q matched", cmdline)
		}
	}
}

// TestHerdrStreamCloseDuringResize: the client stopped reading, the pane is
// resized, then the stream is closed. Close must not wait for the stuck
// output forever.
func TestHerdrStreamCloseDuringResize(t *testing.T) {
	useFakeObserve(t, false)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "wR:p3", Size{})
	if err != nil {
		t.Fatal(err)
	}
	nextSize(t, ts)
	// Nobody reads the output: the first frame stays stuck in the pipe.
	time.Sleep(200 * time.Millisecond)
	f.emitLayout("wR:p3", 90, 30)
	time.Sleep(200 * time.Millisecond)
	closed := make(chan struct{})
	go func() { ts.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close hung while a resize waited on unread output")
	}
}

// TestHerdrStreamResyncsSizeFromSnapshot: a resize whose layout event was
// missed is picked up by the next fresh snapshot.
func TestHerdrStreamResyncsSizeFromSnapshot(t *testing.T) {
	useFakeObserve(t, false)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "wR:p3", Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	nextSize(t, ts)
	out := newOutputReader(ts)
	out.waitFor(t, `OBSERVE wR:p3 108x36`)

	f.mu.Lock()
	rect := f.snapshot["layouts"].([]any)[0].(map[string]any)["panes"].([]any)[0].(map[string]any)["rect"].(map[string]any)
	rect["width"], rect["height"] = 120, 40
	f.mu.Unlock()
	f.emit("pane_updated", map[string]any{}) // invalidates, carries no layout
	// Poll like the PWA until a fresh snapshot carries the new size.
	var got Size
	waitUntil(t, "size from snapshot", func() bool {
		m.Snapshot(context.Background())
		select {
		case c := <-ts.(sizeReporter).Sizes():
			close(c.sent)
			got = c.Size
			return true
		case <-time.After(20 * time.Millisecond):
			return false
		}
	})
	if got != (Size{Cols: 120, Rows: 40}) {
		t.Errorf("announced %v, want 120x40 from the snapshot", got)
	}
	out.waitFor(t, `OBSERVE wR:p3 120x40`)
}

// TestHerdrResubscribeDoesNotLeak: resubscribing while events keep arriving
// leaves no goroutine behind.
func TestHerdrResubscribeDoesNotLeak(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	before := runtime.NumGoroutine()
	for i := 0; i < 10; i++ {
		n := f.count("events.subscribe")
		m.resub <- struct{}{}
		for j := 0; j < 3; j++ {
			f.emit("pane_updated", map[string]any{})
			time.Sleep(20 * time.Millisecond)
		}
		waitUntil(t, "resubscription", func() bool {
			m.mu.Lock()
			defer m.mu.Unlock()
			return f.count("events.subscribe") > n && m.connected
		})
	}
	time.Sleep(100 * time.Millisecond)
	if after := runtime.NumGoroutine(); after > before+3 {
		t.Errorf("goroutines grew from %d to %d over 10 resubscriptions", before, after)
	}
}

// TestHerdrServerStopKillsObservers stops a real server on the herdr backend
// while a stream is open; no observer may survive it. A hard kill is covered
// where Pdeathsig (Linux) or the Job Object (Windows) ends the observer; macOS
// relies on the startup reaper.
func TestHerdrServerStopKillsObservers(t *testing.T) {
	for _, hard := range stopModes() {
		name := "graceful"
		if hard {
			name = "hard kill"
		}
		t.Run(name, func(t *testing.T) {
			pids := useFakeObserve(t, false)
			f := newFakeHerdr(t)
			self, _ := os.Executable()
			srv := exec.Command(self)
			srv.Env = append(os.Environ(), helperEnv+"=serve-herdr", herdrSocketEnv+"="+f.path)
			stdout, _ := srv.StdoutPipe()
			srv.Stderr = os.Stderr
			if err := srv.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { srv.Process.Kill(); srv.Wait() })
			line, err := bufio.NewReader(stdout).ReadString('\n')
			if err != nil || !strings.HasPrefix(line, "ADDR=") {
				t.Fatalf("server did not start: %q %v", line, err)
			}
			base := "http://" + strings.TrimSpace(strings.TrimPrefix(line, "ADDR="))

			c, _, err := dialStream(t, base, "pane=wR:p3&token="+fetchToken(t, base, false), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer c.CloseNow()
			out := newOutputReader(wsReader{c})
			out.waitFor(t, `OBSERVE wR:p3 108x36`)
			observers := pids()
			if len(observers) != 1 {
				t.Fatalf("observers = %v, want 1", observers)
			}
			t.Cleanup(func() { killPID(observers[0]) })

			stopServer(t, srv.Process, hard)
			exited := make(chan struct{})
			go func() { srv.Wait(); close(exited) }()
			select {
			case <-exited:
			case <-time.After(shutdownTimeout + 5*time.Second):
				t.Fatal("server did not exit")
			}
			waitDead(t, observers[0], "observer")
		})
	}
}

// TestHerdrStaleSnapshotKeepsNewerSize: a snapshot taken before a resize, but
// answered after its layout event, must not move the stream back.
func TestHerdrStaleSnapshotKeepsNewerSize(t *testing.T) {
	useFakeObserve(t, false)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "wR:p3", Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	nextSize(t, ts)
	out := newOutputReader(ts)
	out.waitFor(t, `OBSERVE wR:p3 108x36`)

	m.invalidate()
	f.mu.Lock()
	f.snapDelay = 300 * time.Millisecond
	f.mu.Unlock()
	before := f.count("session.snapshot")
	fetched := make(chan struct{})
	go func() { m.Snapshot(context.Background()); close(fetched) }()
	waitUntil(t, "snapshot request", func() bool { return f.count("session.snapshot") > before })
	f.emitLayout("wR:p3", 90, 30)
	if s := nextSize(t, ts); s != (Size{Cols: 90, Rows: 30}) {
		t.Fatalf("announced %v, want 90x30", s)
	}
	<-fetched
	select {
	case c := <-ts.(sizeReporter).Sizes():
		close(c.sent)
		t.Errorf("stale snapshot moved the stream to %v", c.Size)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestHerdrAgentSession(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	t.Setenv("CLAUDE_CONFIG_DIR", "/cfg/claude")
	set := func(agent string, extra map[string]any) {
		f.mu.Lock()
		f.agent, f.paneExtra = agent, extra
		f.mu.Unlock()
	}
	ref := func(agent, kind, value string) map[string]any {
		return map[string]any{"agent_status": "blocked", "agent_session": map[string]any{
			"agent": agent, "kind": kind, "value": value, "source": "herdr:" + agent}}
	}

	set("claude", ref("claude", "id", testSessionID))
	s, ok, err := m.AgentSession(ctx, "wR:p3")
	if err != nil || !ok || s.ID != testSessionID || s.Status != "blocked" || s.ClaudeDir != "/cfg/claude" || s.Target != "wR:p3" {
		t.Fatalf("AgentSession = %+v, %v, %v", s, ok, err)
	}
	if p := f.lastParams(t, "pane.get"); p["pane_id"] != "wR:p3" {
		t.Errorf("pane.get params = %v", p)
	}
	for name, tc := range map[string]struct {
		agent string
		extra map[string]any
	}{
		"no agent":                  {"", nil},
		"agent without session ref": {"claude", map[string]any{}},
		"ref left by another agent": {"pi", ref("claude", "id", testSessionID)},
		"ref of another agent":      {"claude", ref("codex", "id", testSessionID)},
		"path ref":                  {"claude", ref("claude", "path", "/x.jsonl")},
		"not a uuid":                {"claude", ref("claude", "id", "../../x")},
	} {
		set(tc.agent, tc.extra)
		if _, ok, err := m.AgentSession(ctx, "wR:p3"); ok || err != nil {
			t.Errorf("%s: ok=%v err=%v", name, ok, err)
		}
	}
	set("claude", map[string]any{"agent_status": "weird", "agent_session": ref("claude", "id", testSessionID)["agent_session"]})
	if s, _, _ := m.AgentSession(ctx, "wR:p3"); s.Status != "unknown" {
		t.Errorf("unknown status = %q", s.Status)
	}
	var ie inputError
	if _, _, err := m.AgentSession(ctx, "-x"); !errors.As(err, &ie) {
		t.Errorf("bad pane id: %v", err)
	}
	if c := m.Caps(); !c.AgentChat || !c.Files {
		t.Errorf("Caps() = %+v, want AgentChat and Files", c)
	}
}

func TestHerdrAgentWriter(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	f.mu.Lock()
	f.readText = "\x1b[2mfaint\x1b[0m"
	f.mu.Unlock()
	if s, err := m.Capture(ctx, "wR:p3"); err != nil || s != "\x1b[2mfaint\x1b[0m" {
		t.Errorf("Capture = %q, %v", s, err)
	}
	if p := f.lastParams(t, "pane.read"); p["format"] != "ansi" || p["source"] != "visible" || p["pane_id"] != "wR:p3" {
		t.Errorf("pane.read params = %v", p)
	}
	if err := m.Paste(ctx, "wR:p3", "a\nb"); err != nil {
		t.Fatal(err)
	}
	if err := m.SendKeySequence(ctx, "wR:p3", []string{"2", "Enter", "Escape"}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	texts := append([]string(nil), f.texts...)
	f.mu.Unlock()
	// The paste is one input; nothing can land inside the brackets.
	if len(texts) != 2 || texts[0] != "\x1b[200~a\nb\x1b[201~" || texts[1] != "2\r\x1b" {
		t.Errorf("sent %q", texts)
	}
	var ie inputError
	for name, err := range map[string]error{
		"bad key":        m.SendKeySequence(ctx, "wR:p3", []string{"C-c"}),
		"no keys":        m.SendKeySequence(ctx, "wR:p3", nil),
		"bad pane":       m.SendKeySequence(ctx, "-x", []string{"1"}),
		"capture bad id": func() error { _, err := m.Capture(ctx, "x"); return err }(),
		"paste bad pane": m.Paste(ctx, "wR:pNOPE", "x"),
	} {
		if !errors.As(err, &ie) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, ok, err := m.AgentSessionNow(ctx, "wR:p3"); ok || err != nil {
		t.Errorf("AgentSessionNow without agent = %v %v", ok, err)
	}
}
