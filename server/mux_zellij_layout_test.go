package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

// zellijPanesJSON is a list-panes -j reply: terminal panes 0 and 1 of tab 0,
// the ids in fullscreen flagged so.
func zellijPanesJSON(fullscreen ...int) string {
	var panes []map[string]any
	for _, n := range []int{0, 1} {
		panes = append(panes, map[string]any{"id": n, "is_plugin": false, "tab_id": 0, "pane_cwd": "/w",
			"is_fullscreen": len(fullscreen) > 0 && (fullscreen[0] == n || len(fullscreen) > 1 && fullscreen[1] == n)})
	}
	b, _ := json.Marshal(panes)
	return "0\n" + string(b) + "\n"
}

// zellijOnlyPane0 is a list-panes -j reply without terminal pane 1.
const zellijOnlyPane0 = "0\n[{\"id\":0,\"is_plugin\":false,\"tab_id\":0}]\n"

func TestZellijPaneLayoutCap(t *testing.T) {
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion})
	if c := newTestZellijMux().Caps(); !c.PaneLayout || c.PaneStream {
		t.Errorf("0.45.1: paneLayout %v, paneStream %v (the stream shows the tab)", c.PaneLayout, c.PaneStream)
	}
	useFakeZellij(t, map[string]string{"--version": "0\nzellij 0.45.0\n"})
	m := newTestZellijMux()
	if m.Caps().PaneLayout {
		t.Error("paneLayout on 0.45.0")
	}
	ctx := context.Background()
	_, split := m.SplitPane(ctx, "zbWFpbg:p0", SplitRight, "")
	for op, err := range map[string]error{
		"split": split, "zoom": m.ZoomPane(ctx, "zbWFpbg:p0", ZoomOn),
		"swap": m.SwapPane(ctx, "zbWFpbg:p0", SwapNext), "resize": m.ResizePane(ctx, "zbWFpbg:p0", ResizeUp, 1),
	} {
		if !errors.Is(err, errPaneLayoutUnsupported) {
			t.Errorf("%s on 0.45.0 = %v", op, err)
		}
	}
}

func TestZellijZoomPane(t *testing.T) {
	ctx := context.Background()
	id := zellijPaneID("main", 1)
	for _, tc := range []struct {
		mode   ZoomMode
		before []int // fullscreen panes before
		after  []int
		zooms  []string // toggle-fullscreen targets, in order
	}{
		{ZoomToggle, nil, []int{1}, []string{"terminal_1"}},
		{ZoomToggle, []int{1}, nil, []string{"terminal_1"}},
		{ZoomOn, []int{1}, []int{1}, nil},
		{ZoomOff, nil, nil, nil},
		{ZoomOff, []int{1}, nil, []string{"terminal_1"}},
		// Another pane fills the tab: put back first.
		{ZoomOn, []int{0}, []int{1}, []string{"terminal_0", "terminal_1"}},
	} {
		// The listing: the pane, then (zooming) the tab's other panes,
		// then the pane again to confirm.
		confirm := "list-panes.2"
		if len(tc.after) > 0 {
			confirm = "list-panes.3"
		}
		log := useFakeZellij(t, map[string]string{"--version": fakeZellijVersion,
			"list-panes": zellijPanesJSON(tc.before...), confirm: zellijPanesJSON(tc.after...)})
		m := newTestZellijMux()
		if err := m.ZoomPane(ctx, id, tc.mode); err != nil {
			t.Errorf("%s from %v: %v", tc.mode, tc.before, err)
			continue
		}
		var got []string
		for _, line := range strings.Split(log(), "\n") {
			if i := strings.Index(line, "toggle-fullscreen --pane-id "); i >= 0 {
				got = append(got, line[i+len("toggle-fullscreen --pane-id "):])
			}
		}
		if strings.Join(got, ",") != strings.Join(tc.zooms, ",") {
			t.Errorf("%s from %v: toggled %v, want %v", tc.mode, tc.before, got, tc.zooms)
		}
	}

	// The tab's only pane: nothing to fill, so nothing toggled and no error.
	log := useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijOnlyPane0})
	if err := newTestZellijMux().ZoomPane(ctx, zellijPaneID("main", 0), ZoomToggle); err != nil {
		t.Errorf("zoom of the only pane = %v", err)
	}
	if strings.Contains(log(), "toggle-fullscreen") {
		t.Errorf("only pane toggled: %q", log())
	}
	// The listing still shows the old state just after the toggle, then
	// catches up: done, toggled once.
	log = useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON(),
		"list-panes.5": zellijPanesJSON(1)})
	if err := newTestZellijMux().ZoomPane(ctx, id, ZoomOn); err != nil {
		t.Errorf("zoom confirmed late = %v", err)
	}
	if n := strings.Count(log(), "toggle-fullscreen"); n != 1 {
		t.Errorf("toggled %d times", n)
	}
	// The request ends while the listing has not caught up: its error.
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
	short, cancel := context.WithTimeout(ctx, 2*zellijZoomPoll)
	defer cancel()
	if err := newTestZellijMux().ZoomPane(short, id, ZoomOn); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("zoom past the request's end = %v", err)
	}
	// Still not fullscreen after the toggle: busy, never toggled again.
	log = useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
	if err := newTestZellijMux().ZoomPane(ctx, id, ZoomOn); !errors.Is(err, errZellijBusy) {
		t.Errorf("zoom not confirmed = %v", err)
	}
	if n := strings.Count(log(), "toggle-fullscreen"); n != 1 {
		t.Errorf("toggled %d times", n)
	}
	// A failed toggle with the pane gone, or still there.
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON(),
		"list-panes.3": zellijOnlyPane0, "toggle-fullscreen": "1\n"})
	if err := newTestZellijMux().ZoomPane(ctx, id, ZoomOn); !errors.Is(err, errUnknownPane) {
		t.Errorf("zoom of a pane gone = %v", err)
	}
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON(), "toggle-fullscreen": "1\n"})
	if err := newTestZellijMux().ZoomPane(ctx, id, ZoomOn); err == nil || errors.Is(err, errUnknownPane) {
		t.Errorf("zoom failing = %v", err)
	}
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON(0), "list-panes.2": "1\n"})
	if err := newTestZellijMux().ZoomPane(ctx, id, ZoomOn); err == nil {
		t.Error("zoom with an unreadable listing succeeded")
	}
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON(), "list-panes.3": zellijOnlyPane0})
	if err := newTestZellijMux().ZoomPane(ctx, id, ZoomOn); !errors.Is(err, errUnknownPane) {
		t.Errorf("zoom of a pane gone after the toggle = %v", err)
	}
	// Putting back another fullscreen pane failing: this one is not zoomed.
	log = useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON(0),
		"toggle-fullscreen": "1\n"})
	if err := newTestZellijMux().ZoomPane(ctx, id, ZoomOn); err == nil || strings.Contains(log(), "terminal_1") {
		t.Errorf("zoom past a failed put back = %v, argv %q", err, log())
	}
	over := map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON(0)}
	for i := 2; i < 14; i++ {
		over[fmt.Sprintf("list-panes.%d", i)] = "1\n"
	}
	useFakeZellij(t, over)
	if err := newTestZellijMux().ZoomPane(ctx, id, ZoomOn); err == nil {
		t.Error("zoom without the tab's panes succeeded")
	}
}

func TestZellijSwapAndResizePane(t *testing.T) {
	ctx := context.Background()
	id := zellijPaneID("main", 1)
	for dir, action := range map[SwapDir]string{SwapNext: "move-pane", SwapPrev: "move-pane-backwards"} {
		log := useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
		if err := newTestZellijMux().SwapPane(ctx, id, dir); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(log(), "action "+action+" --pane-id terminal_1\n") {
			t.Errorf("%s argv = %q", dir, log())
		}
	}
	for amount, rounds := range map[int]int{1: 1, 5: 1, 6: 2, 12: 3, 50: zellijResizeRounds} {
		log := useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
		if err := newTestZellijMux().ResizePane(ctx, id, ResizeLeft, amount); err != nil {
			t.Fatal(err)
		}
		if n := strings.Count(log(), "action resize increase left --pane-id terminal_1\n"); n != rounds {
			t.Errorf("amount %d: %d rounds, want %d", amount, n, rounds)
		}
	}
	// A round failing stops the rest.
	log := useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON(), "resize.2": "1\n"})
	if err := newTestZellijMux().ResizePane(ctx, id, ResizeUp, 20); err == nil {
		t.Error("a failed round went unreported")
	}
	if n := strings.Count(log(), "action resize "); n != 2 {
		t.Errorf("%d rounds after a failure", n)
	}
	// The session's slot held by another positioning: the pane is found,
	// then the wait for the slot ends with the request, nothing resized.
	log = useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
	m := newTestZellijMux()
	m.sessionSlot("main") <- struct{}{}
	short, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if err := m.ResizePane(short, id, ResizeUp, 1); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("resize without the session's slot = %v", err)
	}
	if strings.Contains(log(), "action resize ") {
		t.Errorf("resized without the session's slot: %q", log())
	}
}

// Zoom and swap wait for the session's slot, as split and resize do: a
// client positioned meanwhile would focus another pane of the zoomed tab
// (ending the zoom) or put back a client the zoom moved, and move-pane in a
// zoomed tab moves nothing. Nothing is listed or run before the slot.
func TestZellijZoomAndSwapWaitForTheSlot(t *testing.T) {
	id := zellijPaneID("main", 1)
	for name, run := range map[string]func(*zellijMux, context.Context) error{
		"zoom": func(m *zellijMux, ctx context.Context) error { return m.ZoomPane(ctx, id, ZoomToggle) },
		"swap": func(m *zellijMux, ctx context.Context) error { return m.SwapPane(ctx, id, SwapNext) },
	} {
		log := useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
		m := newTestZellijMux()
		m.sessionSlot("main") <- struct{}{}
		short, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		err := run(m, short)
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("%s without the session's slot = %v", name, err)
		}
		if strings.Contains(log(), "list-panes") || strings.Contains(log(), "toggle-fullscreen") || strings.Contains(log(), "move-pane") {
			t.Errorf("%s ran without the session's slot: %q", name, log())
		}
		// Released, it runs and gives the slot back
		<-m.sessionSlot("main")
		if err := run(m, context.Background()); err != nil && !errors.Is(err, errZellijBusy) {
			t.Errorf("%s with the slot free = %v", name, err)
		}
		select {
		case m.sessionSlot("main") <- struct{}{}:
		default:
			t.Errorf("%s kept the session's slot", name)
		}
	}
}

func TestZellijPaneLayoutRefusals(t *testing.T) {
	ctx := context.Background()
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
	m := newTestZellijMux()
	for op, err := range map[string]error{
		"swap of a bad id":       m.SwapPane(ctx, "x", SwapNext),
		"swap of a missing pane": m.SwapPane(ctx, zellijPaneID("main", 9), SwapNext),
		"resize of a bad id":     m.ResizePane(ctx, "x", ResizeUp, 1),
		"zoom of a missing pane": m.ZoomPane(ctx, zellijPaneID("main", 9), ZoomOn),
	} {
		if !paneMissing(err) {
			t.Errorf("%s = %v", op, err)
		}
	}
	// Zellij 0.45.1 ignores new-pane --cwd: another directory than the
	// pane's is refused before anything runs.
	log := useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
	if _, err := newTestZellijMux().SplitPane(ctx, zellijPaneID("main", 1), SplitRight, "/elsewhere"); !errors.Is(err, errPaneLayoutUnsupported) {
		t.Errorf("split with another cwd = %v", err)
	}
	if strings.Contains(log(), "new-pane") {
		t.Errorf("new-pane ran: %q", log())
	}
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": zellijPanesJSON()})
	if _, err := newTestZellijMux().SplitPane(ctx, zellijPaneID("main", 9), SplitRight, ""); !errors.Is(err, errUnknownPane) {
		t.Errorf("split of a missing pane = %v", err)
	}
}

// A real Zellij: a split runs on the pane asked for and leaves the user's
// client where it is; zoom, swap and resize change what the listing says.
func TestZellijRealPaneLayout(t *testing.T) {
	m := realZellij(t)
	ctx := t.Context()
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	g := zellijGroupNamed(t, snap, "main")
	first := g.Tabs[0].Panes[0].ID
	userClient(t, "main")
	clients, _ := zellijClients(ctx, "main")
	if len(clients) != 1 {
		t.Fatalf("clients = %v", clients)
	}
	var userID, userPane string
	for id, p := range clients {
		userID, userPane = id, p
	}
	_, n, _ := parseZellijPaneID(first)
	src, err := zellijFindPane(ctx, "main", n)
	if err != nil {
		t.Fatal(err)
	}

	second, err := m.SplitPane(ctx, first, SplitRight, "")
	if err != nil {
		t.Fatal(err)
	}
	if again, _ := zellijClients(ctx, "main"); again[userID] != userPane {
		t.Errorf("user's client moved to %s", again[userID])
	}
	_, n2, _ := parseZellijPaneID(second)
	p2, err := zellijFindPane(ctx, "main", n2)
	if err != nil || p2.TabID != src.TabID {
		t.Fatalf("new pane %s = %+v %v", second, p2, err)
	}
	waitUntil(t, "the new pane's shell in the first pane's directory", func() bool {
		pid, ok := zellijPaneShell("main", n2, true)
		if !ok {
			return false
		}
		cwd, _ := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid))
		return cwd == src.Cwd
	})
	if _, err := m.SplitPane(ctx, first, SplitDown, src.Cwd); err != nil {
		t.Errorf("split in the pane's own directory = %v", err)
	}

	cols := func(id string) int {
		_, n, _ := parseZellijPaneID(id)
		p, _ := zellijFindPane(ctx, "main", n)
		return p.ContentCols
	}
	w := cols(second)
	if err := m.ResizePane(ctx, second, ResizeLeft, 5); err != nil {
		t.Fatal(err)
	}
	if cols(second) <= w {
		t.Errorf("resize: %d columns, was %d", cols(second), w)
	}

	if err := m.SwapPane(ctx, second, SwapNext); err != nil {
		t.Fatal(err)
	}
	if err := m.SwapPane(ctx, second, SwapPrev); err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if err := m.ZoomPane(ctx, second, ZoomOn); err != nil {
			t.Fatal(err)
		}
	}
	if p, _ := zellijFindPane(ctx, "main", n2); !p.IsFullscreen {
		t.Error("zoom on left the pane small")
	}
	if err := m.ZoomPane(ctx, first, ZoomToggle); err != nil {
		t.Fatal(err)
	}
	if p, _ := zellijFindPane(ctx, "main", n); !p.IsFullscreen {
		t.Error("zooming another pane did not fill the tab with it")
	}
	if err := m.ZoomPane(ctx, first, ZoomOff); err != nil {
		t.Fatal(err)
	}
	if p, _ := zellijFindPane(ctx, "main", n); p.IsFullscreen {
		t.Error("zoom off left the pane fullscreen")
	}
}

// keyTerm is a client's PTY that takes every write (failing with err when
// set) and never ends.
type keyTerm struct {
	err error
	// ok writes succeed before err applies (0: every write fails)
	ok, n int
	done  chan struct{}
}

func (k *keyTerm) Read([]byte) (int, error) { <-k.done; return 0, io.EOF }
func (k *keyTerm) Write(p []byte) (int, error) {
	k.n++
	if k.err != nil && k.n > k.ok {
		return 0, k.err
	}
	return len(p), nil
}
func (k *keyTerm) Resize(Size) error     { return nil }
func (k *keyTerm) Done() <-chan struct{} { return k.done }
func (k *keyTerm) ExitCode() int         { return 0 }
func (k *keyTerm) Close() error          { return nil }

// splitPanes is a list-panes -j reply of terminal panes, each "id:tab".
func splitPanes(panes ...string) string {
	var list []map[string]any
	for _, p := range panes {
		var id, tab int
		fmt.Sscanf(p, "%d:%d", &id, &tab)
		list = append(list, map[string]any{"id": id, "is_plugin": false, "tab_id": tab, "pane_cwd": "/w"})
	}
	b, _ := json.Marshal(list)
	return "0\n" + string(b) + "\n"
}

// clientsOn is a list-clients reply: the user's client 1, and Termote's
// hidden client 2 on terminal_hidden.
func clientsOn(user, hidden string) string {
	return "0\nCLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 " + user + " zsh\n2 " + hidden + " -\n"
}

// splitMux is a Zellij backend whose session main has the hidden client 2,
// its PTY term.
func splitMux(term *keyTerm) *zellijMux {
	m := newTestZellijMux()
	c := &zellijClient{m: m, session: "main", id: "2", term: term, hidden: true, out: newZellijOutput()}
	m.clients["main"] = []*zellijClient{c}
	return m
}

// The split runs as the hidden client: positioned on the pane (list-clients
// 1 and 2), the client listing taken (3), new-pane, then the panes and the
// clients read again (list-panes 3, list-clients 4).
func TestZellijSplitPane(t *testing.T) {
	ctx := context.Background()
	src := zellijPaneID("main", 1)
	base := func(over map[string]string) map[string]string {
		r := map[string]string{"--version": fakeZellijVersion,
			"list-panes":     splitPanes("0:0", "1:0"),
			"list-clients":   clientsOn("terminal_0", "terminal_0"),
			"list-clients.2": clientsOn("terminal_0", "terminal_1"),
			"list-clients.3": clientsOn("terminal_0", "terminal_1"),
			"list-clients.4": clientsOn("terminal_0", "terminal_2"),
			"list-panes.3":   splitPanes("0:0", "1:0", "2:0"),
			"new-pane":       "0\nterminal_2\n",
		}
		for k, v := range over {
			r[k] = v
		}
		return r
	}

	log := useFakeZellij(t, base(nil))
	term := &keyTerm{done: make(chan struct{})}
	m := splitMux(term)
	id, err := m.SplitPane(ctx, src, SplitDown, "/w")
	if err != nil || id != zellijPaneID("main", 2) {
		t.Fatalf("SplitPane = %q %v", id, err)
	}
	if !strings.Contains(log(), "action new-pane --direction down\n") || strings.Contains(log(), "close-pane") {
		t.Errorf("argv = %q", log())
	}
	if c := m.clients["main"][0]; c.pane != 2 {
		t.Errorf("hidden client noted on terminal_%d", c.pane)
	}

	// The user's client moved by the action is put back.
	log = useFakeZellij(t, base(map[string]string{
		"list-clients.4": clientsOn("terminal_2", "terminal_2"),
		"list-clients.5": clientsOn("terminal_0", "terminal_2"),
	}))
	if _, err := splitMux(&keyTerm{done: make(chan struct{})}).SplitPane(ctx, src, SplitRight, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(log(), "action focus-pane-id terminal_0\n") {
		t.Errorf("user's client not put back: %q", log())
	}
	useFakeZellij(t, base(map[string]string{
		"list-clients.4": clientsOn("terminal_2", "terminal_2"),
		"list-clients.5": clientsOn("terminal_2", "terminal_2"),
		"list-clients.6": clientsOn("terminal_2", "terminal_2"),
	}))
	if _, err := splitMux(&keyTerm{done: make(chan struct{})}).SplitPane(ctx, src, SplitRight, ""); !errors.Is(err, errZellijBusy) {
		t.Errorf("user's client left moved = %v", err)
	}

	// Two new panes in the tab: both closed, busy. One in another tab only:
	// busy, and that pane (perhaps the user's) is left alone.
	for name, c := range map[string]struct {
		after  string
		closed int
	}{
		"two panes":      {splitPanes("0:0", "1:0", "2:0", "3:0"), 2},
		"another tab":    {splitPanes("0:0", "1:0", "2:1"), 0},
		"no pane at all": {splitPanes("0:0", "1:0"), 0},
	} {
		log := useFakeZellij(t, base(map[string]string{"list-panes.3": c.after}))
		if _, err := splitMux(&keyTerm{done: make(chan struct{})}).SplitPane(ctx, src, SplitRight, ""); !errors.Is(err, errZellijBusy) {
			t.Errorf("%s = %v", name, err)
		}
		if want := c.closed; strings.Count(log(), "action close-pane") != want {
			t.Errorf("%s: closed %d panes, want %d: %q", name, strings.Count(log(), "action close-pane"), want, log())
		}
	}
	// new-pane failing with nothing made: its error, or unknown_pane when
	// the pane is gone.
	useFakeZellij(t, base(map[string]string{"new-pane": "1\n", "list-panes.3": splitPanes("0:0", "1:0")}))
	if _, err := splitMux(&keyTerm{done: make(chan struct{})}).SplitPane(ctx, src, SplitRight, ""); err == nil || errors.Is(err, errZellijBusy) {
		t.Errorf("new-pane failing = %v", err)
	}
	useFakeZellij(t, base(map[string]string{"new-pane": "1\n", "list-panes.3": splitPanes("0:0"), "list-panes.4": splitPanes("0:0")}))
	if _, err := splitMux(&keyTerm{done: make(chan struct{})}).SplitPane(ctx, src, SplitRight, ""); !errors.Is(err, errUnknownPane) {
		t.Errorf("new-pane with the pane gone = %v", err)
	}

	// A listing or the key failing on the way.
	// failFrom makes every call of key from the nth on fail (a listing
	// is read again after a failure).
	failFrom := func(key string, n int) map[string]string {
		over := map[string]string{}
		for i := n; i < n+12; i++ {
			over[fmt.Sprintf("%s.%d", key, i)] = "1\n"
		}
		return over
	}
	for name, over := range map[string]map[string]string{
		"panes before":  failFrom("list-panes", 2),
		"clients":       failFrom("list-clients", 3),
		"panes after":   failFrom("list-panes", 3),
		"clients after": failFrom("list-clients", 4),
	} {
		useFakeZellij(t, base(over))
		if _, err := splitMux(&keyTerm{done: make(chan struct{})}).SplitPane(ctx, src, SplitRight, ""); err == nil {
			t.Errorf("%s failing: split succeeded", name)
		}
	}
	// The client's PTY failing once it is positioned: no new-pane.
	log = useFakeZellij(t, base(nil))
	dead := &keyTerm{done: make(chan struct{}), err: errors.New("pty gone"), ok: 1}
	if _, err := splitMux(dead).SplitPane(ctx, src, SplitRight, ""); err == nil || strings.Contains(log(), "new-pane") {
		t.Errorf("split with a dead client = %v, argv %q", err, log())
	}
	// No hidden client, and none can attach (the fake one exits at once).
	log = useFakeZellij(t, base(nil))
	if _, err := newTestZellijMux().SplitPane(ctx, src, SplitRight, ""); err == nil || strings.Contains(log(), "new-pane") {
		t.Errorf("split without a client = %v", err)
	}
	// The hidden client never reaches the pane: closed, and no other
	// attaches.
	log = useFakeZellij(t, map[string]string{"--version": fakeZellijVersion,
		"list-panes": splitPanes("0:0", "1:0"), "list-clients": clientsOn("terminal_0", "terminal_0")})
	stuck := splitMux(&keyTerm{done: make(chan struct{})})
	if _, err := stuck.SplitPane(ctx, src, SplitRight, ""); err == nil || strings.Contains(log(), "new-pane") {
		t.Errorf("split with a client that cannot move = %v", err)
	}
	if c := stuck.clients["main"]; len(c) != 0 && !c[0].closed {
		t.Error("the stuck hidden client was kept")
	}
	// The session's slot held by another positioning.
	useFakeZellij(t, base(nil))
	busy := splitMux(&keyTerm{done: make(chan struct{})})
	busy.sessionSlot("main") <- struct{}{}
	short, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if _, err := busy.SplitPane(short, src, SplitRight, ""); err == nil {
		t.Error("split ran without the session's slot")
	}
}

// Keys for a pane no stream shows go through the hidden client; a hidden
// client that cannot be had, or whose PTY refuses the keys, is the error.
func TestZellijWriteToPaneHidden(t *testing.T) {
	ctx := context.Background()
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion, "list-panes": "1\nboom\n"})
	if err := newTestZellijMux().writeToPane(ctx, "main", 1, []byte("x")); err == nil {
		t.Error("keys sent without a hidden client")
	}
	useFakeZellij(t, map[string]string{"--version": fakeZellijVersion,
		"list-panes":     splitPanes("0:0", "1:0"),
		"list-clients":   clientsOn("terminal_0", "terminal_0"),
		"list-clients.2": clientsOn("terminal_0", "terminal_1"),
		"list-clients.3": clientsOn("terminal_0", "terminal_1"),
	})
	// The no-op key of the positioning goes through, the keys do not.
	gone := errors.New("pty gone")
	term := &keyTerm{err: gone, ok: 1, done: make(chan struct{})}
	if err := splitMux(term).writeToPane(ctx, "main", 1, []byte("x")); !errors.Is(err, gone) {
		t.Errorf("keys refused by the PTY = %v", err)
	}
}
