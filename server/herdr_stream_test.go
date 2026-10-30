package main

import (
	"cmp"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// useFakeControl is useFakeObserve plus the directory where a test creates
// the flag files of the fake control (helperHerdrControl).
func useFakeControl(t *testing.T) (pids func() []int, flag func(name string)) {
	t.Helper()
	pids = useFakeObserve(t, false)
	dir := t.TempDir()
	t.Setenv(controlFlagDirEnv, dir)
	flag = func(name string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return pids, flag
}

// nextChange takes the next size frame and acknowledges it, skipping layout
// frames.
func nextChange(t *testing.T, ts TermStream) sizeChange {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case c := <-ts.(sizeReporter).Sizes():
			close(c.sent)
			if !c.Layout {
				return c
			}
		case <-timeout:
			t.Fatal("no size announced")
			return sizeChange{}
		}
	}
}

// noChange fails if a size frame arrives within a short while. Layout frames
// are skipped.
func noChange(t *testing.T, ts TermStream, why string) {
	t.Helper()
	timeout := time.After(300 * time.Millisecond)
	for {
		select {
		case c := <-ts.(sizeReporter).Sizes():
			close(c.sent)
			if !c.Layout {
				t.Fatalf("unexpected size frame %+v: %s", c, why)
			}
		case <-timeout:
			return
		}
	}
}

// nextLayout waits for a layout frame, failing on a size frame first.
func nextLayout(t *testing.T, ts TermStream) {
	t.Helper()
	select {
	case c := <-ts.(sizeReporter).Sizes():
		close(c.sent)
		if !c.Layout {
			t.Fatalf("size frame %+v, want a layout frame", c)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no layout frame")
	}
}

// resizePane makes wR:p3 width x height in the snapshot and reports it, as the
// desktop resizing the pane does.
func resizePane(f *fakeHerdr, width, height int) {
	f.mu.Lock()
	rect := f.snapshot["layouts"].([]any)[0].(map[string]any)["panes"].([]any)[0].(map[string]any)["rect"].(map[string]any)
	rect["width"], rect["height"] = width, height
	f.mu.Unlock()
	f.emitLayout("wR:p3", width, height)
}

func TestHerdrStreamDriveLifecycle(t *testing.T) {
	pids, flag := useFakeControl(t)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "wR:p3", Size{Cols: 60, Rows: 20})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	if c := nextChange(t, ts); c.Size != (Size{Cols: 108, Rows: 36}) || c.Driving || c.Reason != "" {
		t.Fatalf("first frame %+v, want observe at 108x36", c)
	}
	out := newOutputReader(ts)
	out.waitFor(t, `OBSERVE wR:p3 108x36`)

	// Drive: control at the client's size, the observer gone.
	ts.(sizeDriver).Drive(true)
	if c := nextChange(t, ts); c.Size != (Size{Cols: 60, Rows: 20}) || !c.Driving {
		t.Fatalf("frame %+v, want driving at 60x20", c)
	}
	out.waitFor(t, `CONTROL wR:p3 60x20`)
	waitDead(t, pids()[0], "observer replaced by control")

	// A client resize goes to control's stdin: no restart, no size frame.
	ts.Resize(Size{Cols: 70, Rows: 25})
	out.waitFor(t, `CONTROL wR:p3 70x25`)
	// The desktop resizing the pane does not restart control either.
	resizePane(f, 90, 30)
	noChange(t, ts, "desktop resize while driving")
	if n := len(pids()); n != 2 {
		t.Fatalf("%d processes, want observe then one control", n)
	}

	// Give the size back: observe at the desktop's new size.
	ts.(sizeDriver).Drive(false)
	if c := nextChange(t, ts); c.Size != (Size{Cols: 90, Rows: 30}) || c.Driving || c.Reason != "" {
		t.Fatalf("frame %+v, want observe at 90x30", c)
	}
	out.waitFor(t, `OBSERVE wR:p3 90x30`)
	waitDead(t, pids()[1], "control after drive off")

	// Drive again, and another device takes over: observe, stream alive.
	ts.(sizeDriver).Drive(true)
	if c := nextChange(t, ts); c.Size != (Size{Cols: 70, Rows: 25}) || !c.Driving {
		t.Fatalf("frame %+v, want driving at the latest client size", c)
	}
	out.waitFor(t, `CONTROL wR:p3 70x25`)
	flag(controlTakenOverFlag)
	if c := nextChange(t, ts); c.Driving || c.Reason != driveTakenOver || c.Size != (Size{Cols: 90, Rows: 30}) {
		t.Fatalf("frame %+v, want observe with reason taken-over", c)
	}
	out.waitFor(t, `OBSERVE wR:p3 90x30`)
	select {
	case <-ts.Done():
		t.Fatal("stream ended after a takeover")
	default:
	}

	ts.Close()
	for _, pid := range pids() {
		waitDead(t, pid, "herdr process")
	}
}

// Control ending for a reason termote does not know, with the pane still
// there, falls back to observe instead of ending the stream.
func TestHerdrStreamControlFailsBackToObserve(t *testing.T) {
	_, flag := useFakeControl(t)
	flag(controlFailFlag)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "wR:p3", Size{Cols: 60, Rows: 20})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	ts.(sizeDriver).Drive(true) // before the first frame: drive=1
	out := newOutputReader(ts)
	if c := nextChange(t, ts); !c.Driving {
		t.Fatalf("first frame %+v, want driving", c)
	}
	if c := nextChange(t, ts); c.Driving || c.Reason != driveFailed || c.Size != (Size{Cols: 108, Rows: 36}) {
		t.Fatalf("frame %+v, want observe with reason failed", c)
	}
	out.waitFor(t, `OBSERVE wR:p3 108x36`)
}

// Control ending because the pane closed ends the stream.
func TestHerdrStreamControlPaneGone(t *testing.T) {
	_, flag := useFakeControl(t)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "wR:p3", Size{Cols: 60, Rows: 20})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	ts.(sizeDriver).Drive(true)
	nextChange(t, ts)
	out := newOutputReader(ts)
	out.waitFor(t, `CONTROL wR:p3 60x20`)

	f.mu.Lock()
	layout := f.snapshot["layouts"].([]any)[0].(map[string]any)
	layout["panes"] = layout["panes"].([]any)[1:]
	f.mu.Unlock()
	f.emit("pane_updated", map[string]any{})
	flag(controlFailFlag)
	select {
	case <-ts.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not end when the pane went away")
	}
}

// drive=1 at open starts control directly: no observer is ever spawned.
func TestHerdrStreamDriveAtOpen(t *testing.T) {
	pids, _ := useFakeControl(t)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "wR:p3", Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	// A drive request and a resize right behind it: both count.
	ts.(sizeDriver).Drive(true)
	ts.Resize(Size{Cols: 50, Rows: 15})
	if c := nextChange(t, ts); !c.Driving || c.Size != (Size{Cols: 50, Rows: 15}) {
		t.Fatalf("first frame %+v, want driving at 50x15", c)
	}
	out := newOutputReader(ts)
	out.waitFor(t, `CONTROL wR:p3 50x15`)
	if n := len(pids()); n != 1 {
		t.Errorf("%d processes, want only control", n)
	}
}

// A burst of drive requests spawns at most one process per minDriveSwitch.
func TestHerdrStreamDriveRateLimit(t *testing.T) {
	pids, _ := useFakeControl(t)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "wR:p3", Size{Cols: 60, Rows: 20})
	if err != nil {
		t.Fatal(err)
	}
	defer ts.Close()
	go func() {
		for c := range ts.(sizeReporter).Sizes() {
			close(c.sent)
		}
	}()
	out := newOutputReader(ts)
	out.waitFor(t, `OBSERVE`)
	start := time.Now()
	for i := 0; i < 1000; i++ {
		ts.(sizeDriver).Drive(i%2 == 0)
		time.Sleep(time.Millisecond)
	}
	// Settle on driving.
	ts.(sizeDriver).Drive(true)
	out.waitFor(t, `CONTROL wR:p3 60x20`)
	elapsed := time.Since(start)
	if max := int(elapsed/minDriveSwitch) + 2; len(pids()) > max {
		t.Errorf("%d processes in %v, want at most %d", len(pids()), elapsed, max)
	}
}

// Control that stops reading its stdin does not hang Close, however many
// resizes the client sent.
func TestHerdrStreamCloseWithStuckControl(t *testing.T) {
	pids, flag := useFakeControl(t)
	flag(controlNoStdinFlag)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ts, err := m.Attach(context.Background(), "wR:p3", Size{Cols: 60, Rows: 20})
	if err != nil {
		t.Fatal(err)
	}
	ts.(sizeDriver).Drive(true)
	nextChange(t, ts)
	out := newOutputReader(ts)
	out.waitFor(t, `CONTROL wR:p3 60x20`)
	for i := 0; i < 20000; i++ {
		if err := ts.Resize(Size{Cols: 40 + i%100, Rows: 20}); err != nil {
			t.Fatal(err)
		}
	}
	closed := make(chan struct{})
	go func() { ts.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3*processKillWait + time.Second):
		t.Fatal("Close hung on a control that stopped reading")
	}
	for _, pid := range pids() {
		waitDead(t, pid, "control")
	}
}

// Closing the stream right after asking to switch leaves no process behind.
func TestHerdrStreamCloseWhileSwitching(t *testing.T) {
	pids, _ := useFakeControl(t)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	for i := 0; i < 3; i++ {
		ts, err := m.Attach(context.Background(), "wR:p3", Size{Cols: 60, Rows: 20})
		if err != nil {
			t.Fatal(err)
		}
		nextChange(t, ts)
		ts.(sizeDriver).Drive(true)
		time.Sleep(time.Duration(i) * minDriveSwitch / 2)
		ts.Close()
	}
	for _, pid := range pids() {
		waitDead(t, pid, "herdr process")
	}
}

// TestHerdrStreamDriveOverWebSocket: drive=1 and the drive message reach the
// stream, and every size frame carries driving.
func TestHerdrStreamDriveOverWebSocket(t *testing.T) {
	useFakeControl(t)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	h, _, _, err := buildServer(testConfig(t), m)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	hdr := authHeader()
	hdr.Set("Origin", srv.URL)
	c, _, err := dialStream(t, srv.URL, "token="+fetchToken(t, srv.URL, true)+"&pane=wR:p3&cols=60&rows=20&drive=1", hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	sizeFrame := func() map[string]any {
		t.Helper()
		for {
			typ, data, err := readFrame(t, c)
			if err != nil {
				t.Fatal(err)
			}
			if typ != websocket.MessageText {
				continue
			}
			var ctl map[string]any
			json.Unmarshal(data, &ctl)
			if ctl["type"] == "size" {
				return ctl
			}
		}
	}
	if ctl := sizeFrame(); ctl["driving"] != true || ctl["cols"] != 60.0 {
		t.Fatalf("first size frame %v, want driving at 60x20", ctl)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// A drive message without on is ignored.
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"drive"}`))
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"drive","on":false}`))
	ctl := sizeFrame()
	if v, ok := ctl["driving"]; !ok || v != false || ctl["cols"] != 108.0 {
		t.Fatalf("size frame %v, want driving:false at 108x36", ctl)
	}
	if _, ok := ctl["reason"]; ok {
		t.Errorf("size frame %v has a reason the client asked for", ctl)
	}
}

func TestHerdrCapsDriveSize(t *testing.T) {
	m := &herdrMux{}
	if !m.Caps().DriveSize {
		t.Error("herdr does not offer DriveSize")
	}
	if (tmuxMux{}).Caps().DriveSize {
		t.Error("tmux offers DriveSize")
	}
	b, _ := json.Marshal(Caps{})
	if !strings.Contains(string(b), `"driveSize":false`) {
		t.Errorf("caps JSON %s lacks driveSize", b)
	}
}

// control ending by itself also stops its stdin writer.
func TestHerdrControlEndClosesInput(t *testing.T) {
	_, flag := useFakeControl(t)
	p, err := startHerdrStream(herdrControlArgv("wR:p3", Size{Cols: 60, Rows: 20}), true, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	flag(controlFailFlag)
	<-p.decoded
	p.wait()
	select {
	case _, ok := <-p.resizes:
		if ok {
			t.Fatal("a size left for the writer")
		}
	default:
		t.Fatal("stdin writer still waiting for sizes")
	}
	p.release() // releasing an ended control is harmless
}

// emitTabLayout reports w13:t1's two panes with the given rects (x, width;
// both full height), zoomed on focused when focused is not "".
func emitTabLayout(f *fakeHerdr, p1x, p1w, pCx, pCw int, focused string) {
	f.emit("layout_updated", map[string]any{"layout": tabLayout(p1x, p1w, pCx, pCw, focused)})
}

func tabLayout(p1x, p1w, pCx, pCw int, focused string) map[string]any {
	return map[string]any{
		"tab_id": "w13:t1", "zoomed": focused != "", "focused_pane_id": cmp.Or(focused, "w13:pC"),
		"area": map[string]int{"x": 0, "y": 0, "width": 108, "height": 36},
		"panes": []any{
			map[string]any{"pane_id": "w13:p1", "rect": map[string]int{"x": p1x, "y": 0, "width": p1w, "height": 36}},
			map[string]any{"pane_id": "w13:pC", "rect": map[string]int{"x": pCx, "y": 0, "width": pCw, "height": 36}},
		},
	}
}

// attachTab streams both panes of w13:t1 and takes their first size frames.
func attachTab(t *testing.T, m *herdrMux) (p1, pC TermStream) {
	t.Helper()
	var err error
	if p1, err = m.Attach(context.Background(), "w13:p1", Size{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p1.Close() })
	if pC, err = m.Attach(context.Background(), "w13:pC", Size{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pC.Close() })
	if s := nextSize(t, p1); s != (Size{Cols: 42, Rows: 36}) {
		t.Fatalf("w13:p1 first size %v", s)
	}
	if s := nextSize(t, pC); s != (Size{Cols: 66, Rows: 36}) {
		t.Fatalf("w13:pC first size %v", s)
	}
	return p1, pC
}

// Dragging a split border sends a size per cell: the observer restarts once,
// at the last size. A size back to the observed one restarts nothing.
func TestHerdrStreamSettlesRestart(t *testing.T) {
	pids := useFakeObserve(t, false)
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

	for w := 90; w < 100; w++ {
		f.emitLayout("wR:p3", w, 30)
	}
	// One size frame at the last size and one layout frame, which the
	// restart does not drop.
	var sizes []Size
	layouts := 0
	for done := time.After(time.Second); ; {
		select {
		case c := <-ts.(sizeReporter).Sizes():
			close(c.sent)
			if c.Layout {
				layouts++
			} else {
				sizes = append(sizes, c.Size)
			}
			continue
		case <-done:
		}
		break
	}
	if len(sizes) != 1 || sizes[0] != (Size{Cols: 99, Rows: 30}) || layouts != 1 {
		t.Fatalf("sizes %v and %d layout frames, want 99x30 and one layout frame", sizes, layouts)
	}
	out.waitFor(t, `OBSERVE wR:p3 99x30`)
	if n := len(pids()); n != 2 {
		t.Fatalf("%d observers, want one restart", n)
	}

	f.emitLayout("wR:p3", 80, 30)
	f.emitLayout("wR:p3", 99, 30)
	noChange(t, ts, "size back to the observed one")
	if n := len(pids()); n != 2 {
		t.Errorf("%d observers after a size came back, want no restart", n)
	}
}

// Two panes of the same size swapped: no size changes, yet every stream of
// the tab gets a layout frame, without restarting.
func TestHerdrStreamLayoutFrame(t *testing.T) {
	pids := useFakeObserve(t, false)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	p1, pC := attachTab(t, m)
	other, err := m.Attach(context.Background(), "wR:p3", Size{})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	nextSize(t, other)

	emitTabLayout(f, 66, 42, 0, 66, "")
	nextLayout(t, p1)
	nextLayout(t, pC)
	noChange(t, p1, "swap kept the size")
	noChange(t, pC, "swap kept the size")
	select {
	case c := <-other.(sizeReporter).Sizes():
		t.Errorf("frame %+v for a pane of another tab", c)
	case <-time.After(100 * time.Millisecond):
	}
	if n := len(pids()); n != 3 {
		t.Errorf("%d observers, want 3 and no restart", n)
	}
}

// A zoomed pane fills the area, and the zoom follows the focus to another
// pane with no layout event: tab_focused on a zoomed tab reads its layout.
func TestHerdrStreamZoomFollowsFocus(t *testing.T) {
	useFakeObserve(t, false)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	p1, pC := attachTab(t, m)
	out1, outC := newOutputReader(p1), newOutputReader(pC)
	outC.waitFor(t, `OBSERVE w13:pC 66x36`)

	emitTabLayout(f, 0, 42, 42, 66, "w13:pC")
	if s := nextSize(t, pC); s != (Size{Cols: 108, Rows: 36}) {
		t.Fatalf("zoomed pane at %v, want the 108x36 area", s)
	}
	outC.waitFor(t, `OBSERVE w13:pC 108x36`)
	noChange(t, p1, "the hidden pane keeps its rect")

	f.mu.Lock()
	f.layoutReply = map[string]any{"pane.layout": map[string]any{"type": "pane_layout", "layout": tabLayout(0, 42, 42, 66, "w13:p1")}}
	f.mu.Unlock()
	f.emit("pane_focused", map[string]any{"pane_id": "w13:p1"})
	f.emit("tab_focused", map[string]any{"tab_id": "w13:t1"})
	if s := nextSize(t, p1); s != (Size{Cols: 108, Rows: 36}) {
		t.Fatalf("newly zoomed pane at %v, want 108x36", s)
	}
	if s := nextSize(t, pC); s != (Size{Cols: 66, Rows: 36}) {
		t.Fatalf("pane zoomed before at %v, want its 66x36 rect", s)
	}
	out1.waitFor(t, `OBSERVE w13:p1 108x36`)
	if p := f.lastParams(t, "pane.layout"); p["tab_id"] != "w13:t1" {
		t.Errorf("pane.layout params %v", p)
	}

	// Unzoomed: focusing reads no layout.
	emitTabLayout(f, 0, 42, 42, 66, "")
	nextSize(t, p1)
	calls := f.count("pane.layout")
	f.emit("tab_focused", map[string]any{"tab_id": "w13:t1"})
	f.emit("tab_focused", map[string]any{"tab_id": "wR:t3"})
	time.Sleep(200 * time.Millisecond)
	if n := f.count("pane.layout"); n != calls {
		t.Errorf("pane.layout called %d times for unzoomed tabs", n-calls)
	}
}

// A zoomed tab from the snapshot counts too; a failed pane.layout is only
// logged, and a read overtaken by a newer focus change or layout event is
// dropped.
func TestHerdrRefreshLayout(t *testing.T) {
	f := newFakeHerdr(t)
	f.mu.Lock()
	f.snapshot["layouts"].([]any)[4] = tabLayout(0, 42, 42, 66, "w13:pC")
	f.mu.Unlock()
	m := newTestHerdrMux(t, f)
	m.Snapshot(context.Background())
	zoomed := func(tab string) bool {
		m.watchMu.Lock()
		defer m.watchMu.Unlock()
		return m.zoomedTabs[tab]
	}
	if !zoomed("w13:t1") || zoomed("wR:t3") {
		t.Fatalf("zoomed tabs %v, want only w13:t1", m.zoomedTabs)
	}
	if _, ok := m.zoomFocused("wR:t3"); ok {
		t.Error("an unzoomed tab asks for its layout")
	}

	f.mu.Lock()
	f.layoutFail = map[string]string{"pane.layout": "tab_not_found"}
	f.mu.Unlock()
	seq, ok := m.zoomFocused("w13:t1")
	if !ok {
		t.Fatal("a zoomed tab does not ask for its layout")
	}
	m.refreshLayout(context.Background(), "w13:t1", seq)
	if !zoomed("w13:t1") {
		t.Error("a failed pane.layout changed the zoomed tabs")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	m.refreshLayout(ctx, "w13:t1", seq) // canceled: not even logged

	// The reply lacks the tab id: it is the tab asked for.
	f.mu.Lock()
	f.layoutFail = nil
	l := tabLayout(0, 42, 42, 66, "")
	delete(l, "tab_id")
	f.layoutReply = map[string]any{"pane.layout": map[string]any{"type": "pane_layout", "layout": l}}
	f.mu.Unlock()
	older, _ := m.zoomFocused("w13:t1")
	newer, _ := m.zoomFocused("w13:t1")
	m.refreshLayout(context.Background(), "w13:t1", older)
	if !zoomed("w13:t1") {
		t.Error("a read overtaken by a newer focus change was applied")
	}
	m.refreshLayout(context.Background(), "w13:t1", newer)
	if zoomed("w13:t1") {
		t.Error("the latest read, unzoomed, left w13:t1 zoomed")
	}

	// A layout event after the focus change wins over the read.
	seq, _ = m.zoomFocused("w13:t1")
	emitTabLayout(f, 0, 42, 42, 66, "w13:pC")
	waitUntil(t, "layout event", func() bool { return zoomed("w13:t1") })
	m.refreshLayout(context.Background(), "w13:t1", seq)
	if !zoomed("w13:t1") {
		t.Error("a read older than a layout event was applied")
	}
}

// A layout frame reaches the client as {"type":"layout"}.
func TestHerdrLayoutFrameOverWebSocket(t *testing.T) {
	useFakeObserve(t, false)
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	h, _, _, err := buildServer(testConfig(t), m)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	hdr := authHeader()
	hdr.Set("Origin", srv.URL)
	c, _, err := dialStream(t, srv.URL, "token="+fetchToken(t, srv.URL, true)+"&pane=w13:p1", hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	var types []string
	for {
		typ, data, err := readFrame(t, c)
		if err != nil {
			t.Fatal(err)
		}
		if typ != websocket.MessageText {
			continue
		}
		var ctl map[string]any
		json.Unmarshal(data, &ctl)
		types = append(types, ctl["type"].(string))
		if ctl["type"] == "size" && len(types) == 1 {
			emitTabLayout(f, 66, 42, 0, 66, "")
		}
		if ctl["type"] == "layout" {
			if len(ctl) != 1 {
				t.Errorf("layout frame %s carries more than its type", data)
			}
			break
		}
	}
	if types[0] != "size" {
		t.Errorf("frames %v, want the size first", types)
	}
}

// A layout change still settling when the observer restarts reaches the
// client after the restart.
func TestHerdrStreamLayoutAcrossRestart(t *testing.T) {
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

	// The restart is due herdrRestartSettle after the first event; the
	// second one, repeating the size, makes the layout settle later.
	f.emitLayout("wR:p3", 90, 30)
	time.Sleep(herdrRestartSettle / 2)
	f.emitLayout("wR:p3", 90, 30)
	if c := nextChangeOrLayout(t, ts); c.Layout || c.Size != (Size{Cols: 90, Rows: 30}) {
		t.Fatalf("frame %+v, want the size first", c)
	}
	nextLayout(t, ts)
	out.waitFor(t, `OBSERVE wR:p3 90x30`)
}

// nextChangeOrLayout takes the next frame of either kind.
func nextChangeOrLayout(t *testing.T, ts TermStream) sizeChange {
	t.Helper()
	select {
	case c := <-ts.(sizeReporter).Sizes():
		close(c.sent)
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("no frame")
		return sizeChange{}
	}
}
