package main

import (
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

// nextChange takes the next size frame and acknowledges it.
func nextChange(t *testing.T, ts TermStream) sizeChange {
	t.Helper()
	select {
	case c := <-ts.(sizeReporter).Sizes():
		close(c.sent)
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("no size announced")
		return sizeChange{}
	}
}

// noChange fails if a size frame arrives within a short while.
func noChange(t *testing.T, ts TermStream, why string) {
	t.Helper()
	select {
	case c := <-ts.(sizeReporter).Sizes():
		t.Fatalf("unexpected size frame %+v: %s", c, why)
	case <-time.After(300 * time.Millisecond):
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
