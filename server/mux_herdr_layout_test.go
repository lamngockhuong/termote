package main

import (
	"context"
	"errors"
	"testing"
)

func TestHerdrPaneLayoutCaps(t *testing.T) {
	for _, c := range []struct {
		v, goos string
		want    bool
	}{
		{"0.9.3", "linux", true},
		{"0.9.5", "darwin", true},
		{"0.9.2", "linux", false},
		{"0.9.3", "windows", false},
		{"", "linux", false},
	} {
		if got := herdrCanPaneLayout(c.v, c.goos); got != c.want {
			t.Errorf("herdrCanPaneLayout(%q, %q) = %v", c.v, c.goos, got)
		}
	}
}

// newLayoutHerdr is a Herdr with the layout methods, on an OS that offers
// them.
func newLayoutHerdr(t *testing.T, version string) (*fakeHerdr, *herdrMux) {
	t.Helper()
	goos := herdrStartGOOS
	herdrStartGOOS = "linux"
	t.Cleanup(func() { herdrStartGOOS = goos })
	f := newFakeHerdr(t)
	f.version = version
	m := newTestHerdrMux(t, f)
	return f, m
}

func TestHerdrPaneLayout(t *testing.T) {
	f, m := newLayoutHerdr(t, "0.9.3")
	ctx := context.Background()
	if !m.Caps().PaneLayout {
		t.Fatal("caps.paneLayout off on 0.9.3")
	}

	// Split: never moves the focus; the pane's own directory without cwd.
	id, err := m.SplitPane(ctx, "w13:p1", SplitRight, "")
	if err != nil || id != "w13:pNEW" {
		t.Fatalf("SplitPane = %q %v", id, err)
	}
	p := f.lastParams(t, "pane.split")
	if p["target_pane_id"] != "w13:p1" || p["direction"] != "right" || p["focus"] != false || p["cwd"] != nil {
		t.Errorf("pane.split params = %v", p)
	}
	if _, err := m.SplitPane(ctx, "w13:p1", SplitDown, "/srv/x"); err != nil {
		t.Fatal(err)
	}
	if p := f.lastParams(t, "pane.split"); p["direction"] != "down" || p["cwd"] != "/srv/x" {
		t.Errorf("pane.split params = %v", p)
	}

	if err := m.ZoomPane(ctx, "w13:pC", ZoomToggle); err != nil {
		t.Fatal(err)
	}
	if p := f.lastParams(t, "pane.zoom"); p["pane_id"] != "w13:pC" || p["mode"] != "toggle" {
		t.Errorf("pane.zoom params = %v", p)
	}

	// Swap: with the next or previous pane of the tab, in the strip's order.
	if err := m.SwapPane(ctx, "w13:p1", SwapNext); err != nil {
		t.Fatal(err)
	}
	if p := f.lastParams(t, "pane.swap"); p["source_pane_id"] != "w13:p1" || p["target_pane_id"] != "w13:pC" {
		t.Errorf("pane.swap params = %v", p)
	}
	if err := m.SwapPane(ctx, "w13:pC", SwapPrev); err != nil {
		t.Fatal(err)
	}
	if p := f.lastParams(t, "pane.swap"); p["source_pane_id"] != "w13:pC" || p["target_pane_id"] != "w13:p1" {
		t.Errorf("pane.swap params = %v", p)
	}
	f.mu.Lock()
	swaps := f.calls["pane.swap"]
	f.mu.Unlock()
	if err := m.SwapPane(ctx, "w13:p1", SwapPrev); !errors.Is(err, errNoNeighbor) {
		t.Errorf("swap of the first pane before it = %v", err)
	}
	if err := m.SwapPane(ctx, "w13:pA", SwapNext); !errors.Is(err, errNoNeighbor) {
		t.Errorf("swap in a one-pane tab = %v", err)
	}
	f.mu.Lock()
	if f.calls["pane.swap"] != swaps {
		t.Error("pane.swap sent without a neighbour")
	}
	f.mu.Unlock()

	// Resize: cells as a share of the tab's width or height.
	if err := m.ResizePane(ctx, "w13:p1", ResizeLeft, 6); err != nil {
		t.Fatal(err)
	}
	if p := f.lastParams(t, "pane.layout"); p["tab_id"] != "w13:t1" {
		t.Errorf("pane.layout params = %v", p)
	}
	if p := f.lastParams(t, "pane.resize"); p["pane_id"] != "w13:p1" || p["direction"] != "left" || p["amount"] != 0.05 {
		t.Errorf("pane.resize params = %v", p)
	}
	if err := m.ResizePane(ctx, "w13:p1", ResizeDown, 50); err != nil {
		t.Fatal(err)
	}
	if p := f.lastParams(t, "pane.resize"); p["direction"] != "down" || p["amount"] != 1.0 {
		t.Errorf("pane.resize params = %v, want the whole height at most", p)
	}
	f.mu.Lock()
	f.layoutReply = map[string]any{"pane.layout": map[string]any{"layout": map[string]any{"area": map[string]any{"width": 0}}}}
	f.mu.Unlock()
	if err := m.ResizePane(ctx, "w13:p1", ResizeLeft, 1); err == nil || errors.Is(err, errUnknownPane) {
		t.Errorf("resize of an empty area = %v", err)
	}
}

// Herdr answers a swap it did not do with a reason, in a successful reply.
func TestHerdrSwapReasons(t *testing.T) {
	f, m := newLayoutHerdr(t, "0.9.5")
	ctx := context.Background()
	for reason, want := range map[string]error{
		"not_found":   errUnknownPane,
		"cross_tab":   errUnknownPane,
		"no_neighbor": errNoNeighbor,
		"same_pane":   nil,
		"":            nil,
	} {
		f.mu.Lock()
		f.layoutReply = map[string]any{"pane.swap": map[string]any{"swap": map[string]any{"changed": false, "reason": reason}}}
		f.mu.Unlock()
		if err := m.SwapPane(ctx, "w13:p1", SwapNext); !errors.Is(err, want) {
			t.Errorf("reason %q: %v, want %v", reason, err, want)
		}
	}
}

func TestHerdrPaneLayoutErrors(t *testing.T) {
	ctx := context.Background()
	calls := map[string]func(m *herdrMux, pane string) error{
		"split":  func(m *herdrMux, pane string) error { _, err := m.SplitPane(ctx, pane, SplitRight, ""); return err },
		"zoom":   func(m *herdrMux, pane string) error { return m.ZoomPane(ctx, pane, ZoomOn) },
		"swap":   func(m *herdrMux, pane string) error { return m.SwapPane(ctx, pane, SwapNext) },
		"resize": func(m *herdrMux, pane string) error { return m.ResizePane(ctx, pane, ResizeUp, 1) },
	}
	method := map[string]string{"split": "pane.split", "zoom": "pane.zoom", "swap": "pane.swap", "resize": "pane.resize"}

	// An older Herdr has none of them, and nothing reaches it.
	f, old := newLayoutHerdr(t, "0.9.2")
	if old.Caps().PaneLayout {
		t.Error("caps.paneLayout on 0.9.2")
	}
	for name, call := range calls {
		if err := call(old, "w13:p1"); !errors.Is(err, errPaneLayoutUnsupported) {
			t.Errorf("%s on 0.9.2 = %v", name, err)
		}
	}
	f.mu.Lock()
	for _, mth := range method {
		if f.calls[mth] != 0 {
			t.Errorf("%s sent to 0.9.2", mth)
		}
	}
	f.mu.Unlock()

	f, m := newLayoutHerdr(t, "0.9.3")
	for name, call := range calls {
		if err := call(m, "wR:pZZ"); !errors.Is(err, errUnknownPane) {
			t.Errorf("%s of an unknown pane = %v", name, err)
		}
		if err := call(m, "--help"); !paneMissing(err) {
			t.Errorf("%s of a bad id = %v", name, err)
		}
		for code, want := range map[string]error{
			"pane_not_found": errUnknownPane,
			"tab_not_found":  errUnknownPane,
			"unknown_method": errPaneLayoutUnsupported,
			"internal_error": nil,
		} {
			f.mu.Lock()
			f.layoutFail = map[string]string{method[name]: code}
			f.mu.Unlock()
			err := call(m, "w13:p1")
			if want == nil {
				var he *herdrError
				if !errors.As(err, &he) || he.Code != code {
					t.Errorf("%s failing with %s = %v", name, code, err)
				}
				continue
			}
			if !errors.Is(err, want) {
				t.Errorf("%s failing with %s = %v, want %v", name, code, err, want)
			}
		}
	}
	// A Herdr that names the method as unknown in an invalid request.
	f.mu.Lock()
	f.layoutFail = map[string]string{"pane.zoom": "invalid_request"}
	f.layoutMessage = "unknown variant `pane.zoom`"
	f.mu.Unlock()
	if err := m.ZoomPane(ctx, "w13:p1", ZoomOn); !errors.Is(err, errPaneLayoutUnsupported) {
		t.Errorf("invalid_request naming the method = %v", err)
	}
	f.mu.Lock()
	f.layoutFail = map[string]string{"pane.layout": "tab_not_found"}
	f.mu.Unlock()
	if err := m.ResizePane(ctx, "w13:p1", ResizeUp, 1); !errors.Is(err, errUnknownPane) {
		t.Errorf("resize of a tab gone = %v", err)
	}
	f.mu.Lock()
	f.layoutFail = nil
	f.layoutReply = map[string]any{"pane.split": map[string]any{"pane": map[string]any{"pane_id": "--x"}}}
	f.mu.Unlock()
	if _, err := m.SplitPane(ctx, "w13:p1", SplitRight, ""); err == nil {
		t.Error("split took a reply without a pane id")
	}
	// A view that cannot be read fails the action before any call.
	m.invalidate()
	done, cancel := context.WithCancel(ctx)
	cancel()
	if err := m.ZoomPane(done, "w13:p1", ZoomOn); err == nil || paneMissing(err) {
		t.Errorf("zoom without a view = %v", err)
	}
	if err := herdrLayoutError(errors.New("lost")); err == nil || err.Error() != "lost" {
		t.Errorf("herdrLayoutError(non-herdr) = %v", err)
	}
}
