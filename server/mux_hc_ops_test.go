package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// hcSim is a fake core with a terminal table: run, get, kill, read and
// attach act on it and emit the events the real core would.
type hcSim struct {
	t    *testing.T
	m    *hcMux
	core *fakeHcCore

	mu      sync.Mutex
	terms   map[string]map[string]any
	next    int
	seq     uint64
	events  uint32 // the subscription's channel
	attachs []hcSimAttach
	reads   map[string]any // terminal.read reply, or {"error": kind}
	killErr map[string]string
	// labelErr makes terminal.label fail with this kind.
	labelErr string
}

// hcSimAttach is one terminal.attach the core took.
type hcSimAttach struct {
	Terminal string
	Observe  bool
	Resize   bool
	Resumed  bool
	Cols     int
	Rows     int
	Channel  uint32
}

// newHcSim starts a mux on a fake core holding a tab of two panes (t1, t2;
// t3 a sub-agent of t1) and a tab of one (t4) in space sp1, plus t5, a
// terminal of another app (no labels).
func newHcSim(t *testing.T) *hcSim {
	t.Helper()
	s := &hcSim{t: t, terms: map[string]map[string]any{}, next: 10, reads: map[string]any{}, killErr: map[string]string{}}
	add := func(addr, space, tab string, parent string) {
		labels := map[string]string{}
		if space != "" {
			labels[hcLabelSpace], labels[hcLabelTab] = space, tab
		}
		rec := map[string]any{"address": addr, "labels": labels, "state": "live", "cols": 80, "rows": 24,
			"cwd": "/w/" + addr, "pid": 1000 + len(s.terms), "argv": []string{"zsh"}, "created_ms": len(s.terms)}
		if parent != "" {
			rec["parent"] = parent
		}
		s.terms[addr] = rec
	}
	add("t1", "sp1", "tb1", "")
	add("t2", "sp1", "tb1", "")
	add("t3", "", "", "t1")
	add("t4", "sp1", "tb2", "")
	add("t5", "", "", "")
	s.terms["t1"]["foreground"] = map[string]any{"pid": 1000, "name": "zsh", "cwd": "/w/live", "argv": []string{"zsh"}}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s.m = newHcMux(ctx, "/usr/bin/hc", nil)
	s.m.client.running = func(context.Context, []string) bool { return true }
	s.m.retryWait = 20 * time.Millisecond
	s.m.client.connect = func(context.Context, string, []string) (*hcConn, error) {
		core, c := startFakeHc(t, s.handlers)
		s.mu.Lock()
		s.core = core
		s.mu.Unlock()
		return c, nil
	}
	if _, err := s.m.Snapshot(ctx5s(t)); err != nil {
		t.Fatal(err)
	}
	return s
}

func (s *hcSim) handlers(core *fakeHcCore) {
	core.handle("events.subscribe", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
		ch := core.openChannel()
		s.mu.Lock()
		s.events = ch
		var list []any
		for a := range s.terms {
			list = append(list, s.recLocked(a))
		}
		seq := s.seq
		s.mu.Unlock()
		core.reply(id, map[string]any{"seq": seq, "terminals": list, "channel": ch})
	})
	core.result("doc.get", map[string]any{"value": nil, "version": 0})
	core.handle("terminal.run", func(core *fakeHcCore, id uint64, params json.RawMessage) {
		var p struct {
			Cwd    string            `json:"cwd"`
			Labels map[string]string `json:"labels"`
		}
		json.Unmarshal(params, &p)
		s.mu.Lock()
		s.next++
		addr := fmt.Sprintf("t%d", s.next)
		s.terms[addr] = map[string]any{"address": addr, "labels": p.Labels, "state": "live", "cols": 100, "rows": 30,
			"cwd": p.Cwd, "pid": 2000 + s.next, "created_ms": 100 + s.next}
		rec := s.recLocked(addr)
		s.mu.Unlock()
		core.reply(id, rec)
		// The created event comes later: the snapshot must not wait for it.
	})
	core.handle("terminal.get", func(core *fakeHcCore, id uint64, params json.RawMessage) {
		var p struct{ Terminal string }
		json.Unmarshal(params, &p)
		rec := s.rec(p.Terminal)
		if rec == nil {
			core.replyError(id, "not_found", "no terminal "+p.Terminal)
			return
		}
		core.reply(id, rec)
	})
	core.handle("terminal.kill", func(core *fakeHcCore, id uint64, params json.RawMessage) {
		var p struct{ Terminal string }
		json.Unmarshal(params, &p)
		s.mu.Lock()
		kind := s.killErr[p.Terminal]
		if r := s.terms[p.Terminal]; r != nil && kind == "" {
			r["state"] = "finished"
		}
		rec := s.recLocked(p.Terminal)
		s.mu.Unlock()
		if kind != "" {
			core.replyError(id, kind, "cannot kill")
			return
		}
		if rec == nil {
			core.replyError(id, "not_found", "no terminal")
			return
		}
		core.reply(id, rec)
		s.emit(p.Terminal, "finished", map[string]any{"reason": "killed", "exit_code": nil})
		s.closeAttachs(p.Terminal, "killed", nil)
	})
	core.handle("terminal.label", func(core *fakeHcCore, id uint64, params json.RawMessage) {
		var p struct {
			Terminal string
			Labels   map[string]string
		}
		json.Unmarshal(params, &p)
		s.mu.Lock()
		kind := s.labelErr
		r := s.terms[p.Terminal]
		var labels map[string]string
		if r != nil && kind == "" {
			labels = map[string]string{}
			for k, v := range r["labels"].(map[string]string) {
				labels[k] = v
			}
			for k, v := range p.Labels {
				labels[k] = v
			}
			r["labels"] = labels
		}
		rec := s.recLocked(p.Terminal)
		s.mu.Unlock()
		if kind != "" || rec == nil {
			core.replyError(id, cmp.Or(kind, "not_found"), "cannot label")
			return
		}
		core.reply(id, rec)
		s.emit(p.Terminal, "labels", map[string]any{"labels": labels})
	})
	core.handle("terminal.read", func(core *fakeHcCore, id uint64, params json.RawMessage) {
		var p struct{ Terminal string }
		json.Unmarshal(params, &p)
		s.mu.Lock()
		r := s.reads[p.Terminal]
		s.mu.Unlock()
		if e, ok := r.(map[string]any)["error"]; ok {
			core.replyError(id, e.(string), "read failed")
			return
		}
		core.reply(id, r)
	})
	core.handle("terminal.attach", func(core *fakeHcCore, id uint64, params json.RawMessage) {
		var p struct {
			Terminal            string
			Observe             bool
			ResizeNotifications bool `json:"resize_notifications"`
			Resumed             bool
			Cols, Rows          int
		}
		json.Unmarshal(params, &p)
		rec := s.rec(p.Terminal)
		if rec == nil || rec["state"] != "live" {
			core.replyError(id, "not_found", "no terminal")
			return
		}
		if rec["lost"] == true {
			core.replyError(id, "unavailable", "lost, waiting for its new shell")
			return
		}
		ch := core.openChannel()
		s.mu.Lock()
		s.attachs = append(s.attachs, hcSimAttach{p.Terminal, p.Observe, p.ResizeNotifications, p.Resumed, p.Cols, p.Rows, ch})
		s.mu.Unlock()
		core.reply(id, map[string]any{"channel": ch, "resize_notifications": p.ResizeNotifications, "terminal": rec})
		paint := "\x18\x1b[!p\x1b[?1049l\x1b[H\x1b[2J\x1b[3g\x1b[9G\x1bH\x1b[Hscreen of " + p.Terminal +
			" \x1b[0m\x1b[2mhint\x1b[0m\r\nrow2\x1b]7;file://h/w\x1b\\\x1b[2;5H\x1b[?9001l\x1b]7501;state=idle\x1b\\"
		core.send(ch, []byte(paint))
	})
}

// rec is a copy of addr's record, nil when there is none.
func (s *hcSim) rec(addr string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recLocked(addr)
}

func (s *hcSim) recLocked(addr string) map[string]any {
	r := s.terms[addr]
	if r == nil {
		return nil
	}
	c := make(map[string]any, len(r))
	for k, v := range r {
		c[k] = v
	}
	return c
}

// emit sends one event on the subscription.
func (s *hcSim) emit(addr, typ string, data any) {
	s.mu.Lock()
	s.seq++
	seq, ch, core := s.seq, s.events, s.core
	s.mu.Unlock()
	core.event(ch, "event", map[string]any{"seq": seq, "type": typ, "terminal": addr, "data": data})
}

// setSize changes a terminal's size and emits its event.
func (s *hcSim) setSize(addr string, cols, rows int) {
	s.mu.Lock()
	s.terms[addr]["cols"], s.terms[addr]["rows"] = cols, rows
	s.mu.Unlock()
	s.emit(addr, "size", map[string]any{"cols": cols, "rows": rows})
	waitFor(s.t, func() bool { t, _ := s.m.state.terminal(addr); return t.Cols == cols && t.Rows == rows })
}

// closeAttachs closes the attach channels of addr with reason.
func (s *hcSim) closeAttachs(addr, reason string, code *int) {
	s.mu.Lock()
	var chans []uint32
	for _, a := range s.attachs {
		if a.Terminal == addr {
			chans = append(chans, a.Channel)
		}
	}
	core := s.core
	s.mu.Unlock()
	for _, ch := range chans {
		core.frame(ch, hcKindClose, mustJSON(map[string]any{"reason": reason, "exit_code": code}))
	}
}

func (s *hcSim) attachList() []hcSimAttach {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]hcSimAttach(nil), s.attachs...)
}

func (s *hcSim) runCalls() []map[string]any {
	var out []map[string]any
	for _, c := range s.core.callsOf("terminal.run") {
		var p map[string]any
		json.Unmarshal(c.Params, &p)
		out = append(out, p)
	}
	return out
}

func (s *hcSim) killed() []string {
	var out []string
	for _, c := range s.core.callsOf("terminal.kill") {
		var p struct{ Terminal string }
		json.Unmarshal(c.Params, &p)
		out = append(out, p.Terminal)
	}
	return out
}

func TestHcRequirePaneAndErrors(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	for id, want := range map[string]error{"t0": inputError("invalid pane id"), "box/t1": inputError("invalid pane id"),
		"t99": errUnknownPane, "t5": errUnknownPane, "t3": errUnknownPane} {
		if _, err := s.m.requirePane(ctx, id); !errors.Is(err, want) && err != want {
			t.Errorf("%s: %v", id, err)
		}
	}
	if _, err := s.m.requirePane(ctx, "t1"); err != nil {
		t.Fatal(err)
	}
	re := &hcRPCError{}
	for kind, want := range map[string]error{"not_found": errUnknownPane, "unavailable": errHcRestarting} {
		re.Data.Kind = kind
		if hcError(re) != want {
			t.Errorf("%s: %v", kind, hcError(re))
		}
	}
	re.Data.Kind = "conflict"
	if hcError(re) != error(re) || hcError(nil) != nil || hcError(errHcLost) != errHcUnavailable {
		t.Error("mapping")
	}
	caps := s.m.Caps()
	if !caps.ClientSideSelect || !caps.PaneStream || !caps.PaneLayout || !caps.Groups || !caps.Files || caps.Scroll ||
		caps.RenamePane || caps.RenameTab || caps.ReorderTabs || caps.Worktrees || s.m.Name() != "hc" {
		t.Fatalf("caps %+v", caps)
	}
}

var hcIDRe = regexp.MustCompile(`^(sp|tb)[0-9a-f]{32}$`)

func TestHcNewTabGroupAndSplit(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	tab, err := s.m.NewTab(ctx, "sp1", "ignored name")
	if err != nil || !hcIDRe.MatchString(tab) || !strings.HasPrefix(tab, "tb") {
		t.Fatalf("new tab %q %v", tab, err)
	}
	// Shown at once, before the created event.
	snap, _ := s.m.Snapshot(ctx)
	if g := snap.Groups[0]; len(g.Tabs) != 3 || g.Tabs[2].ID != tab {
		t.Fatalf("tabs %+v", g.Tabs)
	}
	run := s.runCalls()[0]
	want := map[string]any{"cwd": "/w/live", "keep": true,
		"labels": map[string]any{hcLabelSpace: "sp1", hcLabelTab: tab, hcLabelSeen: "0"}}
	if fmt.Sprint(run) != fmt.Sprint(want) {
		t.Fatalf("run %v", run)
	}
	if _, err := s.m.NewTab(ctx, "sp9", ""); err != errUnknownGroup {
		t.Fatalf("unknown group: %v", err)
	}

	g, err := s.m.NewGroup(ctx, "ignored", "/home/u/proj")
	if err != nil || !hcIDRe.MatchString(g) || !strings.HasPrefix(g, "sp") {
		t.Fatalf("new group %q %v", g, err)
	}
	snap, _ = s.m.Snapshot(ctx)
	if last := snap.Groups[len(snap.Groups)-1]; last.ID != g || last.Name != "proj" {
		t.Fatalf("group %+v", last)
	}
	if s.runCalls()[1]["cwd"] != "/home/u/proj" {
		t.Fatalf("group cwd %v", s.runCalls()[1])
	}

	pane, err := s.m.SplitPane(ctx, "t2", SplitDown, "")
	if err != nil || !validHcAddress(pane) {
		t.Fatalf("split %q %v", pane, err)
	}
	split := s.runCalls()[2]
	if l := split["labels"].(map[string]any); l[hcLabelSpace] != "sp1" || l[hcLabelTab] != "tb1" || split["cwd"] != "/w/t2" {
		t.Fatalf("split %v", split)
	}
	if _, err := s.m.SplitPane(ctx, "t3", SplitRight, ""); err != errUnknownPane {
		t.Fatalf("split of a hidden terminal: %v", err)
	}
	// A relative cwd never reaches the core.
	s.m.SplitPane(ctx, "t2", SplitRight, "rel")
	if _, ok := s.runCalls()[3]["cwd"]; ok {
		t.Fatalf("relative cwd sent: %v", s.runCalls()[3])
	}
	for _, c := range s.core.callsOf("terminal.run") {
		if strings.Contains(string(c.Params), "argv") || strings.Contains(string(c.Params), "env") {
			t.Fatalf("run carries argv or env: %s", c.Params)
		}
	}
}

func TestHcClose(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	if err := s.m.ClosePane(ctx, "t4"); err != errLastPane {
		t.Fatalf("last pane: %v", err)
	}
	// t1's sub-agent t3 goes with it.
	if err := s.m.ClosePane(ctx, "t1"); err != nil {
		t.Fatal(err)
	}
	if got := s.killed(); fmt.Sprint(got) != "[t3 t1]" {
		t.Fatalf("killed %v", got)
	}
	waitFor(t, func() bool { _, err := s.m.requirePane(ctx, "t1"); return err == errUnknownPane })

	// A terminal moved to another tab since the snapshot is left alone.
	s.mu.Lock()
	s.terms["t2"]["labels"] = map[string]string{hcLabelSpace: "sp1", hcLabelTab: "tbX"}
	s.mu.Unlock()
	if err := s.m.CloseTab(ctx, "tb1", "tb1"); err != errTabChanged {
		t.Fatalf("moved: %v", err)
	}
	if err := s.m.CloseTab(ctx, "tb1", "other"); err != errTabChanged {
		t.Fatalf("key: %v", err)
	}
	if err := s.m.CloseTab(ctx, "tbNone", ""); err != errTabChanged {
		t.Fatalf("unknown tab: %v", err)
	}
	if err := s.m.CloseTab(ctx, "tb2", ""); err != nil {
		t.Fatal(err)
	}
	// A kill the core refuses fails the close; one already gone does not.
	s.mu.Lock()
	s.terms["t2"]["labels"] = map[string]string{hcLabelSpace: "sp1", hcLabelTab: "tb1"}
	s.killErr["t2"] = "conflict"
	s.mu.Unlock()
	if err := s.m.CloseGroup(ctx, "sp1"); hcErrorKind(err) != "conflict" {
		t.Fatalf("refused kill: %v", err)
	}
	s.mu.Lock()
	s.killErr["t2"] = "not_found"
	s.mu.Unlock()
	if err := s.m.CloseGroup(ctx, "sp1"); err != nil {
		t.Fatal(err)
	}
	if err := s.m.CloseGroup(ctx, "spNone"); err != errUnknownGroup {
		t.Fatalf("unknown group: %v", err)
	}
}

func TestHcUnsupportedAndSelect(t *testing.T) {
	m := &hcMux{}
	ctx := context.Background()
	for _, err := range []error{
		m.RenamePane(ctx, "", ""), m.Scroll(ctx, "", 1),
	} {
		if err != errUnsupported {
			t.Errorf("%v", err)
		}
	}
	for _, err := range []error{m.ZoomPane(ctx, "", ZoomOn), m.SwapPane(ctx, "", SwapNext), m.ResizePane(ctx, "", ResizeLeft, 1)} {
		if err != errPaneLayoutUnsupported {
			t.Errorf("%v", err)
		}
	}
	if m.SelectTab(ctx, "x") != nil {
		t.Error("select")
	}
}

func TestHcReadText(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	s.mu.Lock()
	s.reads["t1"] = map[string]any{"text": strings.Repeat("l\n", 30), "how": "history", "complete": true}
	s.reads["t2"] = map[string]any{"text": "short\n", "how": "screen", "complete": true}
	s.reads["t4"] = map[string]any{"error": "unavailable"}
	s.mu.Unlock()
	var b bytes.Buffer
	more, err := s.m.ReadText(ctx, "t1", 5, &b)
	if err != nil || !more || strings.HasSuffix(b.String(), "\n") {
		t.Fatalf("%v %v %q", more, err, b.String())
	}
	b.Reset()
	if more, err := s.m.ReadText(ctx, "t2", 5, &b); err != nil || more || b.String() != "short" {
		t.Fatalf("%v %v %q", more, err, b.String())
	}
	if _, err := s.m.ReadText(ctx, "t4", 5, &b); err != errHcRestarting {
		t.Fatalf("restarting: %v", err)
	}
	if text, err := s.m.ReadTaskText(ctx, "t2", 5); err != nil || text != "short" {
		t.Fatalf("%q %v", text, err)
	}
}

// Keys go through an attach of their own that can type, at the terminal's
// size, in order; a size the desktop changed meanwhile is sent before them.
func TestHcSendKeys(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	for _, k := range []string{"a", "b", "c"} {
		if err := s.m.SendKeys(ctx, "t2", k); err != nil {
			t.Fatal(err)
		}
	}
	at := s.attachList()
	if len(at) != 1 || at[0].Observe || at[0].Terminal != "t2" || at[0].Cols != 80 || at[0].Rows != 24 {
		t.Fatalf("attach %+v", at)
	}
	frames := s.core.waitFrames(at[0].Channel, 3)
	if string(frames[0].payload)+string(frames[1].payload)+string(frames[2].payload) != "abc" {
		t.Fatalf("frames %+v", frames)
	}
	s.setSize("t2", 120, 40)
	s.m.SendKeys(ctx, "t2", "d")
	frames = s.core.waitFrames(at[0].Channel, 5)
	if c, r, _ := parseHcSize(frames[3].payload); frames[3].kind != hcKindResize || c != 120 || r != 40 || string(frames[4].payload) != "d" {
		t.Fatalf("frames %+v", frames[3:])
	}
	// Paste and agent keys take the same path.
	s.m.Paste(ctx, "t2", "hi")
	s.m.SendKeySequence(ctx, "t2", []string{"Enter"})
	s.m.Interrupt(ctx, "t2")
	s.m.TypeLine(ctx, "t2", "make")
	frames = s.core.waitFrames(at[0].Channel, 9)
	var got string
	for _, f := range frames[5:9] {
		got += string(f.payload)
	}
	if got != pasteStart+"hi"+pasteEnd+agentKeys["Enter"]+agentKeys["C-c"]+"make\r" {
		t.Fatalf("typed %q", got)
	}
	if err := s.m.SendKeySequence(ctx, "t2", []string{"rm -rf"}); err == nil {
		t.Fatal("unknown key accepted")
	}
	if err := s.m.SendKeys(ctx, "t5", "x"); err != errUnknownPane {
		t.Fatalf("hidden terminal: %v", err)
	}
	// An attach the core ended is replaced at the next input.
	s.closeAttachs("t2", "server_stop", nil)
	waitFor(t, func() bool {
		s.m.SendKeys(ctx, "t2", "e")
		return len(s.attachList()) == 2
	})
	// A full queue is refused.
	in := s.m.input("t9")
	in.mu.Lock()
	in.pending = make([]byte, hcMaxQueuedInput)
	in.running = true
	in.mu.Unlock()
	if _, err := in.enqueue([]byte("x")); err == nil {
		t.Fatal("queue past its limit")
	}
}

func TestHcInputClosesWhenIdle(t *testing.T) {
	s := newHcSim(t)
	s.m.inputIdle = 30 * time.Millisecond
	if err := s.m.SendKeys(ctx5s(t), "t2", "a"); err != nil {
		t.Fatal(err)
	}
	ch := s.attachList()[0].Channel
	frames := s.core.waitFrames(ch, 2)
	if frames[1].kind != hcKindClose {
		t.Fatalf("frames %+v", frames)
	}
	in := s.m.input("t2")
	in.mu.Lock()
	running := in.running
	in.mu.Unlock()
	if running {
		t.Fatal("writer still running")
	}
}

func TestHcCaptureAndAgentViews(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	screen, err := s.m.Capture(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(screen, "screen of t1") || strings.Contains(screen, "9001") || strings.Contains(screen, "2J") {
		t.Fatalf("screen %q", screen)
	}
	lines := parseScreen(screen)
	if len(lines) != 2 || lines[0].text != "screen of t1 hint" || lines[0].solid != "screen of t1" || lines[1].text != "row2" {
		t.Fatalf("parsed %+v", lines)
	}
	if at := s.attachList(); len(at) != 1 || !at[0].Observe {
		t.Fatalf("capture attach %+v", at)
	}
	frames := s.core.waitFrames(s.attachList()[0].Channel, 1)
	if frames[len(frames)-1].kind != hcKindClose {
		t.Fatal("capture left its attach open")
	}
	if got := hcScreenOf([]byte("no clear")); got != "no clear" {
		t.Fatalf("%q", got)
	}

	dir, key, err := s.m.PaneDir(ctx, "t1")
	if err != nil || dir != "/w/live" || key != "t1" {
		t.Fatalf("dir %q %q %v", dir, key, err)
	}
	if dir, _, _ := s.m.PaneDir(ctx, "t2"); dir != "/w/t2" {
		t.Fatalf("dir %q", dir)
	}
	// No agent runs under these test pids: no session, no error.
	for _, fresh := range []bool{false, true} {
		sess, ok, err := s.m.agentSession(ctx, "t1", fresh)
		if err != nil || ok || sess.Target != "t1" {
			t.Fatalf("%+v %v %v", sess, ok, err)
		}
	}
	if _, _, err := s.m.AgentSession(ctx, "t5"); err != errUnknownPane {
		t.Fatalf("hidden: %v", err)
	}
	s.m.AgentSessionNow(ctx, "t2")

	// The shell waits at its prompt when it is the foreground program.
	_, pid, idle, err := s.m.IdleShell(ctx, "t1")
	if err != nil || !idle || pid != 1000 {
		t.Fatalf("idle %v pid %d %v", idle, pid, err)
	}
	// The shell's pid is known even when it is not idle.
	if _, pid, idle, _ := s.m.IdleShell(ctx, "t2"); idle || pid != 1001 {
		t.Fatalf("no foreground reported: idle %v pid %d", idle, pid)
	}
	if _, _, _, err := s.m.IdleShell(ctx, "t99"); err != errTaskTargetGone {
		t.Fatalf("gone: %v", err)
	}
	tt, err := s.m.NewTaskTab(ctx, "sp1", "build", "/w/task")
	if err != nil || !validHcAddress(tt.PaneID) || tt.Target != tt.PaneID || !strings.HasPrefix(tt.TabID, "tb") {
		t.Fatalf("task tab %+v %v", tt, err)
	}
	if s.runCalls()[0]["cwd"] != "/w/task" {
		t.Fatalf("task cwd %v", s.runCalls()[0])
	}
	if _, err := s.m.NewTaskTab(ctx, "spX", "", "/w"); err != errUnknownGroup {
		t.Fatalf("unknown group: %v", err)
	}
}

// The snapshot route of a full client starts the core through hc.
func TestHcSnapshotRouteStarts(t *testing.T) {
	var _ startingSnapshotter = (*hcMux)(nil)
	var _ startingSnapshotter = (*herdrMux)(nil)
	if http.StatusServiceUnavailable != errHcUnavailable.status {
		t.Fatal("unavailable is not 503")
	}
	_ = io.EOF
}

// A new terminal starts where the group's first pane works, else in the
// space's folder from herdr-app's document, else at home.
func TestHcFolderFor(t *testing.T) {
	m := &hcMux{state: newHcState(), home: "/home/u"}
	rel := *hcTerm("t1", "sp1", "tb1", 80, 24, 0)
	rel.Cwd = "relative"
	m.state.reset(1, []hcTerminal{rel})
	g := Group{ID: "sp1", Tabs: []Tab{{Panes: []Pane{{ID: "t1"}}}}}
	if got := m.folderFor(g); got != "/home/u" {
		t.Fatalf("no folder: %q", got)
	}
	m.state.setDoc(1, &hcDoc{Spaces: []hcDocSpace{{ID: "sp0", Folder: "/x"}, {ID: "sp1", Folder: "/home/u/proj"}}}, false)
	if got := m.folderFor(g); got != "/home/u/proj" {
		t.Fatalf("document folder: %q", got)
	}
	if got := m.folderFor(Group{ID: "sp1"}); got != "/home/u/proj" {
		t.Fatalf("no pane: %q", got)
	}
	live := rel
	live.Foreground = &hcForeground{Cwd: "/home/u/proj/sub"}
	m.state.upsert(live)
	if got := m.folderFor(g); got != "/home/u/proj/sub" {
		t.Fatalf("live folder: %q", got)
	}
}

// A terminal with a space but no tab label has a tab of its own: splitting
// it opens a new tab, closing it checks it still has no tab label.
func TestHcLoneTab(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	s.mu.Lock()
	s.terms["t5"]["labels"] = map[string]string{hcLabelSpace: "sp1"}
	rec := s.recLocked("t5")
	s.mu.Unlock()
	s.emit("t5", "labels", map[string]any{"labels": rec["labels"]})
	waitFor(t, func() bool { _, err := s.m.requirePane(ctx, "t5"); return err == nil })
	snap, _ := s.m.Snapshot(ctx)
	if tabs := snap.Groups[0].Tabs; len(tabs) != 3 || tabs[2].ID != "tb-t5" {
		t.Fatalf("tabs %+v", tabs)
	}
	if _, err := s.m.SplitPane(ctx, "t5", SplitRight, ""); err != nil {
		t.Fatal(err)
	}
	l := s.runCalls()[0]["labels"].(map[string]any)
	if tab := l[hcLabelTab].(string); !hcIDRe.MatchString(tab) || l[hcLabelSpace] != "sp1" {
		t.Fatalf("split labels %v", l)
	}
	if err := s.m.CloseTab(ctx, "tb-t5", ""); err != nil {
		t.Fatal(err)
	}
	if got := s.killed(); fmt.Sprint(got) != "[t5]" {
		t.Fatalf("killed %v", got)
	}
}

// A writer that stopped is forgotten.
func TestHcInputForgottenWhenIdle(t *testing.T) {
	s := newHcSim(t)
	s.m.inputIdle = 20 * time.Millisecond
	s.m.SendKeys(ctx5s(t), "t2", "a")
	waitFor(t, func() bool {
		s.m.inputsMu.Lock()
		defer s.m.inputsMu.Unlock()
		return len(s.m.inputs) == 0
	})
}

// newHcMuxDown is an hcMux whose core does not run: every read fails at once.
func newHcMuxDown(t *testing.T) *hcMux {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := newHcMux(ctx, "/usr/bin/hc", nil)
	m.client.running = func(context.Context, []string) bool { return false }
	return m
}

// dropHcClient leaves the mux following its connection while the client no
// longer holds one (the moment between a loss and the follower noticing it),
// and the core does not run: a call that needs a connection now fails.
func dropHcClient(s *hcSim) {
	s.m.client.running = func(context.Context, []string) bool { return false }
	s.m.client.set(nil)
}

// editHcTerm changes the state's record of addr, as an event would, without
// the core.
func editHcTerm(t *testing.T, s *hcSim, addr string, edit func(h *hcTerminal)) {
	t.Helper()
	h, ok := s.m.state.terminal(addr)
	if !ok {
		t.Fatalf("no terminal %s", addr)
	}
	edit(&h)
	s.m.state.upsert(h)
}

// attachTo makes terminal.attach open a channel, reply, then run feed on it.
func attachTo(core *fakeHcCore, feed func(core *fakeHcCore, ch uint32)) {
	core.handle("terminal.attach", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
		ch := core.openChannel()
		core.reply(id, map[string]any{"channel": ch})
		feed(core, ch)
	})
}

// refuseAttach makes terminal.attach answer with an error of kind.
func refuseAttach(core *fakeHcCore, kind string) {
	core.handle("terminal.attach", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
		core.replyError(id, kind, "refused")
	})
}

// Operations on a core that does not run fail with the unavailable error.
func TestHcOpsWhenTheCoreDoesNotRun(t *testing.T) {
	down := newHcMuxDown(t)
	ctx := ctx5s(t)
	if _, err := down.NewTab(ctx, "sp1", ""); err != errHcUnavailable {
		t.Errorf("NewTab: %v", err)
	}
	if _, err := down.NewGroup(ctx, "", "/w"); err != errHcUnavailable {
		t.Errorf("NewGroup: %v", err)
	}
	if err := down.CloseTab(ctx, "tb1", ""); err != errHcUnavailable {
		t.Errorf("CloseTab: %v", err)
	}
	if err := down.CloseGroup(ctx, "sp1"); err != errHcUnavailable {
		t.Errorf("CloseGroup: %v", err)
	}
}

// Operations that need a connection the client no longer holds fail with the
// unavailable error, after the snapshot they start from was read.
func TestHcOpsWithoutTheClientsConnection(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	dropHcClient(s)
	if _, err := s.m.NewTab(ctx, "sp1", ""); err != errHcUnavailable {
		t.Errorf("NewTab: %v", err)
	}
	if _, err := s.m.NewGroup(ctx, "", "/w"); err != errHcUnavailable {
		t.Errorf("NewGroup: %v", err)
	}
	if err := s.m.ClosePane(ctx, "t1"); err != errHcUnavailable {
		t.Errorf("ClosePane: %v", err)
	}
	if err := s.m.CloseTab(ctx, "tb2", ""); err != errHcUnavailable {
		t.Errorf("CloseTab: %v", err)
	}
	if err := s.m.CloseGroup(ctx, "sp1"); err != errHcUnavailable {
		t.Errorf("CloseGroup: %v", err)
	}
	if _, err := s.m.ReadText(ctx, "t1", 5, io.Discard); err != errHcUnavailable {
		t.Errorf("ReadText: %v", err)
	}
	if got := s.killed(); len(got) != 0 {
		t.Errorf("killed without a connection: %v", got)
	}
}

// A run the core refuses, or answers without a local terminal, fails the
// operation that started it.
func TestHcRunFailuresReachTheCaller(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	s.core.handle("terminal.run", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
		core.replyError(id, "conflict", "no room")
	})
	if _, err := s.m.NewTab(ctx, "sp1", ""); hcErrorKind(err) != "conflict" {
		t.Errorf("NewTab: %v", err)
	}
	if _, err := s.m.NewGroup(ctx, "", "/w"); hcErrorKind(err) != "conflict" {
		t.Errorf("NewGroup: %v", err)
	}
	if _, err := s.m.SplitPane(ctx, "t2", SplitRight, ""); hcErrorKind(err) != "conflict" {
		t.Errorf("SplitPane: %v", err)
	}
	s.core.handle("terminal.run", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
		core.reply(id, map[string]any{"address": "box/t1"})
	})
	if _, err := s.m.NewTab(ctx, "sp1", ""); err == nil {
		t.Error("a reply without a local terminal was taken")
	}
}

// Closing fails when the core refuses to say what a terminal is, or refuses
// to end one of its sub-agents; a sub-agent already gone does not fail it.
func TestHcCloseFailures(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	s.core.handle("terminal.get", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
		core.replyError(id, "conflict", "busy")
	})
	if err := s.m.ClosePane(ctx, "t1"); hcErrorKind(err) != "conflict" {
		t.Errorf("get refused: %v", err)
	}

	s2 := newHcSim(t)
	s2.mu.Lock()
	s2.killErr["t3"] = "conflict"
	s2.mu.Unlock()
	if err := s2.m.ClosePane(ctx, "t1"); hcErrorKind(err) != "conflict" {
		t.Errorf("sub-agent refused: %v", err)
	}
	if got := s2.killed(); fmt.Sprint(got) != "[t3]" {
		t.Errorf("killed %v", got)
	}
}

// The sub-agents of a terminal are walked to a depth limit and no further.
func TestHcChildrenDepthLimit(t *testing.T) {
	s := newHcSim(t)
	parent := "t1"
	for i := 0; i < 20; i++ {
		addr := fmt.Sprintf("t9%02d", i)
		s.m.state.upsert(hcTerminal{Address: addr, State: "live", Parent: ptr(parent), Labels: map[string]string{}})
		parent = addr
	}
	got := s.m.children("t1")
	if !slices.Contains(got, "t916") || slices.Contains(got, "t917") {
		t.Errorf("children %v", got)
	}
}

// A tab herdr-app's document holds closes by position, without its label.
func TestHcCloseTabByDocument(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	s.m.state.setDoc(1, &hcDoc{Spaces: []hcDocSpace{{ID: "sp1", Tabs: []hcDocTab{{ID: "tb1"}}}}}, true)
	if err := s.m.CloseTab(ctx, "tb1", ""); err != nil {
		t.Fatalf("held tab: %v", err)
	}
	// A tab the document does not hold still needs its label.
	if err := s.m.CloseTab(ctx, "tb2", ""); err != nil {
		t.Fatalf("unheld tab: %v", err)
	}
	if got := s.killed(); !slices.Contains(got, "t4") {
		t.Errorf("killed %v", got)
	}
}

// Keys that cannot be queued, or whose attach fails, fail the operation.
func TestHcInputFailures(t *testing.T) {
	ctx := ctx5s(t)

	// The queue is full.
	s := newHcSim(t)
	in := s.m.input("t2")
	in.mu.Lock()
	in.pending, in.running = make([]byte, hcMaxQueuedInput), true
	in.mu.Unlock()
	if err := s.m.SendKeys(ctx, "t2", "x"); err == nil {
		t.Error("keys past the queue limit accepted")
	}

	// The attach is refused.
	s2 := newHcSim(t)
	refuseAttach(s2.core, "not_found")
	if err := s2.m.SendKeys(ctx, "t2", "x"); err != errUnknownPane {
		t.Errorf("refused attach: %v", err)
	}

	// The attach answers without a channel.
	s3 := newHcSim(t)
	s3.core.handle("terminal.attach", func(core *fakeHcCore, id uint64, _ json.RawMessage) { core.reply(id, map[string]any{}) })
	if _, err := attachHc(ctx, mustConn(t, s3.m), hcAttachParams{Terminal: "t2", Cols: 80, Rows: 24}); err == nil {
		t.Error("an attach without a channel was taken")
	}

	// The caller gives up before the attach is answered.
	s4 := newHcSim(t)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	s4.core.handle("terminal.attach", func(*fakeHcCore, uint64, json.RawMessage) { <-release })
	short, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := s4.m.SendKeys(short, "t2", "x"); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("abandoned keys: %v", err)
	}

	// A pane that is gone, or a connection the client no longer holds.
	s5 := newHcSim(t)
	if _, _, err := s5.m.input("t99").write(nil, [2]int{80, 24}, []byte("x")); err != errUnknownPane {
		t.Errorf("gone pane: %v", err)
	}
	dropHcClient(s5)
	if _, _, err := s5.m.input("t2").write(nil, [2]int{80, 24}, []byte("x")); err != errHcUnavailable {
		t.Errorf("no connection: %v", err)
	}
}

// Keys on an attach whose connection ended are not sent on it: the attach
// is made again on the connection the mux now holds.
func TestHcInputOnADeadConnection(t *testing.T) {
	// The size is sent first, and that fails.
	s := newHcSim(t)
	old := mustConn(t, s.m)
	ch := &hcChannel{conn: old, id: 77, wake: make(chan struct{}, 1)}
	old.close()
	if _, _, err := s.m.input("t2").write(ch, [2]int{30, 10}, []byte("x")); err != errHcUnavailable {
		t.Errorf("size on a dead connection: %v", err)
	}

	// The keys themselves fail.
	s2 := newHcSim(t)
	old2 := mustConn(t, s2.m)
	ch2 := &hcChannel{conn: old2, id: 78, wake: make(chan struct{}, 1)}
	old2.close()
	if _, _, err := s2.m.input("t2").write(ch2, [2]int{80, 24}, []byte("x")); err != errHcUnavailable {
		t.Errorf("keys on a dead connection: %v", err)
	}
}

// Keys queued just as the writer's idle timer ends are written, not dropped.
func TestHcInputQueuedAtIdle(t *testing.T) {
	s := newHcSim(t)
	s.m.inputIdle = 300 * time.Millisecond
	if err := s.m.SendKeys(ctx5s(t), "t2", "a"); err != nil {
		t.Fatal(err)
	}
	ch := s.attachList()[0].Channel
	s.core.waitFrames(ch, 1)
	in := s.m.input("t2")
	in.mu.Lock()
	in.pending = append(in.pending, 'b')
	in.mu.Unlock()
	frames := s.core.waitFrames(ch, 2)
	if string(frames[1].payload) != "b" {
		t.Fatalf("frames %+v", frames)
	}
}

// A write that outlasts the idle timer still ends with the timer drained.
func TestHcInputWriteOutlastsItsIdleTimer(t *testing.T) {
	s := newHcSim(t)
	s.m.inputIdle = time.Millisecond
	opened := make(chan uint32, 1)
	s.core.handle("terminal.attach", func(core *fakeHcCore, id uint64, _ json.RawMessage) {
		time.Sleep(30 * time.Millisecond) // the core answers after the idle timer ended
		ch := core.openChannel()
		core.reply(id, map[string]any{"channel": ch})
		opened <- ch
	})
	if err := s.m.SendKeys(ctx5s(t), "t2", "a"); err != nil {
		t.Fatal(err)
	}
	frames := s.core.waitFrames(<-opened, 1)
	if string(frames[0].payload) != "a" {
		t.Fatalf("frames %+v", frames)
	}
}

// Closing or reading a pane that is gone fails before the core is asked.
func TestHcGonePaneCloseAndRead(t *testing.T) {
	s := newHcSim(t)
	ctx := ctx5s(t)
	if err := s.m.ClosePane(ctx, "t99"); err != errUnknownPane {
		t.Errorf("ClosePane: %v", err)
	}
	if _, err := s.m.ReadText(ctx, "t99", 5, io.Discard); err != errUnknownPane {
		t.Errorf("ReadText: %v", err)
	}
	if n := len(s.killed()); n != 0 {
		t.Errorf("killed %d for a gone pane", n)
	}
}
