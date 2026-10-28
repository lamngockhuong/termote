package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// paneReply is resolveTmuxPane's display-message reply for %7 in window 1 of
// a window with panes panes, zoomed and active as given.
func paneReply(panes, zoomed, active string) fakeTmuxReply {
	return fakeTmuxReply{out: "$0:1:%7:" + panes + ":" + zoomed + ":" + active + ":main\n"}
}

func TestTmuxPaneLayoutCap(t *testing.T) {
	useFakeTmuxScript(t, map[string]fakeTmuxReply{})
	if c := (tmuxMux{}).Caps(); !c.PaneLayout || c.PaneStream {
		t.Errorf("tmux: paneLayout %v, paneStream %v (the stream shows the window)", c.PaneLayout, c.PaneStream)
	}
	usePsmux(t, true)
	if (tmuxMux{}).Caps().PaneLayout {
		t.Error("psmux: paneLayout on")
	}
}

func TestTmuxSplitPane(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		dir     SplitDir
		cwd     string
		flag, c string
	}{
		{SplitRight, "", "-h", "#{pane_current_path}"},
		{SplitDown, "/srv/a #{x}", "-v", "/srv/a ##{x}"},
	} {
		args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("2", "0", "1"), "split-window": {out: "%12\n"}})
		id, err := (tmuxMux{}).SplitPane(ctx, "%7", tc.dir, tc.cwd)
		if err != nil || id != "%12" {
			t.Fatalf("SplitPane(%s) = %q %v", tc.dir, id, err)
		}
		lines := strings.Split(strings.TrimSpace(args()), "\n")
		want := "split-window -d " + tc.flag + " -t %7 -c " + tc.c + " -P -F #{pane_id}"
		if len(lines) != 2 || lines[1] != want {
			t.Errorf("argv = %q, want %q", lines, want)
		}
	}
	// A tab id splits its window's active pane, by the %N tmux names.
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("1", "0", "1"), "split-window": {out: "%12\n"}})
	if _, err := (tmuxMux{}).SplitPane(ctx, "1", SplitRight, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(args(), "split-window -d -h -t %7 ") {
		t.Errorf("argv = %q", args())
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("1", "0", "1"), "split-window": {out: "oops\n"}})
	if _, err := (tmuxMux{}).SplitPane(ctx, "%7", SplitRight, ""); err == nil {
		t.Error("split took a reply without a pane id")
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("1", "0", "1"),
		"split-window": {stderr: "can't find pane: %7", code: 1}})
	if _, err := (tmuxMux{}).SplitPane(ctx, "%7", SplitRight, ""); !errors.Is(err, errUnknownPane) {
		t.Errorf("split of a pane gone = %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("1", "0", "1"),
		"split-window": {stderr: "no space for new pane", code: 1}})
	if _, err := (tmuxMux{}).SplitPane(ctx, "%7", SplitRight, ""); !errors.Is(err, errNoRoom) {
		t.Errorf("split of a window too small = %v", err)
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("1", "0", "1"),
		"split-window": {stderr: "server exited", code: 1}})
	if _, err := (tmuxMux{}).SplitPane(ctx, "%7", SplitRight, ""); err == nil || errors.Is(err, errUnknownPane) || errors.Is(err, errNoRoom) {
		t.Errorf("split failure = %v", err)
	}
}

func TestTmuxZoomPane(t *testing.T) {
	ctx := context.Background()
	zoom := "resize-pane -Z -t %7"
	for _, tc := range []struct {
		mode           ZoomMode
		zoomed, active string
		zooms          int
	}{
		{ZoomToggle, "0", "0", 1}, // zoom
		{ZoomToggle, "1", "1", 1}, // unzoom
		{ZoomToggle, "1", "0", 2}, // another pane zoomed: unzoom, then zoom this one
		{ZoomOn, "0", "1", 1},
		{ZoomOn, "1", "1", 0}, // zoomed already
		{ZoomOn, "1", "0", 2},
		{ZoomOff, "1", "1", 1},
		{ZoomOff, "0", "1", 0}, // not zoomed
		{ZoomOff, "1", "0", 0}, // another pane zoomed: this one is not
	} {
		args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("2", tc.zoomed, tc.active)})
		if err := (tmuxMux{}).ZoomPane(ctx, "%7", tc.mode); err != nil {
			t.Fatal(err)
		}
		if n := strings.Count(args(), zoom); n != tc.zooms {
			t.Errorf("%s zoomed=%s active=%s: %d zooms, want %d (%q)", tc.mode, tc.zoomed, tc.active, n, tc.zooms, args())
		}
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("2", "1", "0"),
		"resize-pane": {stderr: "can't find pane: %7", code: 1}})
	if err := (tmuxMux{}).ZoomPane(ctx, "%7", ZoomOn); !errors.Is(err, errUnknownPane) {
		t.Errorf("zoom of a pane gone = %v", err)
	}
}

func TestTmuxSwapPane(t *testing.T) {
	ctx := context.Background()
	list := fakeTmuxReply{out: "%3:0\n%7:1\n%9:0\n"}
	for _, tc := range []struct {
		dir    SwapDir
		target string
	}{{SwapPrev, "%3"}, {SwapNext, "%9"}} {
		args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("3", "0", "1"), "list-panes": list})
		if err := (tmuxMux{}).SwapPane(ctx, "%7", tc.dir); err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(strings.TrimSpace(args()), "\n")
		want := []string{"list-panes -t %7 -F #{pane_id}:#{pane_active}", "swap-pane -d -s %7 -t " + tc.target, "select-pane -t %7"}
		if len(lines) != 4 || strings.Join(lines[1:], "|") != strings.Join(want, "|") {
			t.Errorf("%s argv = %q", tc.dir, lines)
		}
	}
	// tmux's own -U/-D wrap around; past either end is no swap.
	for _, tc := range []struct {
		pane string
		dir  SwapDir
	}{{"%3", SwapPrev}, {"%9", SwapNext}} {
		args := useFakeTmuxScript(t, map[string]fakeTmuxReply{
			"display-message": {out: "$0:1:" + tc.pane + ":3:0:0:main\n"}, "list-panes": list})
		if err := (tmuxMux{}).SwapPane(ctx, tc.pane, tc.dir); !errors.Is(err, errNoNeighbor) {
			t.Errorf("swap %s %s = %v", tc.pane, tc.dir, err)
		}
		if strings.Contains(args(), "swap-pane") {
			t.Errorf("swapped past the end: %q", args())
		}
	}
	// No active pane listed: nothing to give the focus back to.
	args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("2", "0", "0"), "list-panes": {out: "%7:0\n%9:0\n"}})
	if err := (tmuxMux{}).SwapPane(ctx, "%7", SwapNext); err != nil || strings.Contains(args(), "select-pane") {
		t.Errorf("swap = %v, argv %q", err, args())
	}
	useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("2", "0", "1"), "list-panes": {out: "%7:1\nbad\n"}})
	if err := (tmuxMux{}).SwapPane(ctx, "%7", SwapNext); err == nil || errors.Is(err, errNoNeighbor) {
		t.Errorf("swap with an unreadable list = %v", err)
	}
	for sub, r := range map[string]fakeTmuxReply{
		"list-panes": {stderr: "can't find pane: %7", code: 1},
		"swap-pane":  {stderr: "can't find pane: %9", code: 1},
	} {
		replies := map[string]fakeTmuxReply{"display-message": paneReply("2", "0", "1"), "list-panes": {out: "%7:1\n%9:0\n"}}
		replies[sub] = r
		useFakeTmuxScript(t, replies)
		if err := (tmuxMux{}).SwapPane(ctx, "%7", SwapNext); !errors.Is(err, errUnknownPane) {
			t.Errorf("%s failing = %v", sub, err)
		}
	}
}

func TestTmuxResizePane(t *testing.T) {
	ctx := context.Background()
	for dir, flag := range map[ResizeDir]string{ResizeLeft: "-L", ResizeRight: "-R", ResizeUp: "-U", ResizeDown: "-D"} {
		args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": paneReply("2", "0", "1")})
		if err := (tmuxMux{}).ResizePane(ctx, "%7", dir, 5); err != nil {
			t.Fatal(err)
		}
		if lines := strings.Split(strings.TrimSpace(args()), "\n"); len(lines) != 2 || lines[1] != "resize-pane -t %7 "+flag+" 5" {
			t.Errorf("%s argv = %q", dir, lines)
		}
	}
}

func TestTmuxPaneLayoutRefusals(t *testing.T) {
	ctx := context.Background()
	m := tmuxMux{}
	calls := map[string]func(id string) error{
		"split":  func(id string) error { _, err := m.SplitPane(ctx, id, SplitRight, ""); return err },
		"zoom":   func(id string) error { return m.ZoomPane(ctx, id, ZoomOn) },
		"swap":   func(id string) error { return m.SwapPane(ctx, id, SwapNext) },
		"resize": func(id string) error { return m.ResizePane(ctx, id, ResizeUp, 1) },
	}
	for name, call := range calls {
		args := useFakeTmuxScript(t, map[string]fakeTmuxReply{"display-message": {}})
		if err := call("%7"); !errors.Is(err, errUnknownPane) {
			t.Errorf("%s of a missing pane = %v", name, err)
		}
		if err := call("0.1"); err == nil || err.Error() != "invalid pane id" {
			t.Errorf("%s of a bad id = %v", name, err)
		}
		if lines := strings.Split(strings.TrimSpace(args()), "\n"); len(lines) != 1 {
			t.Errorf("%s ran more than the check: %q", name, lines)
		}
	}
}

// A real server: a split leaves the focus where it was and lists the new
// pane next; a swap keeps the focused pane focused; zoom on and off do
// nothing twice; resize moves the edge.
func TestTmuxPaneLayoutInRealServer(t *testing.T) {
	useRealTmux(t, "termote-layout")
	resetTmuxProcs(t)
	ctx := context.Background()
	m := tmuxMux{}
	dir := t.TempDir()
	if err := tmuxCmd(ctx, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-s", tmuxSession,
		"-c", dir, "exec sleep 60").Run(); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	first := snap.Groups[0].Tabs[0].Panes[0].ID
	q := func(target, format string) string {
		out, _ := tmuxCmd(ctx, "display-message", "-p", "-t", target, format).Output()
		return strings.TrimSpace(string(out))
	}

	second, err := m.SplitPane(ctx, first, SplitRight, "")
	if err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "other")
	os.Mkdir(other, 0o755)
	third, err := m.SplitPane(ctx, second, SplitDown, other)
	if err != nil {
		t.Fatal(err)
	}
	if q(first, "#{pane_active}") != "1" {
		t.Error("a split moved the focus")
	}
	if got := q(third, "#{pane_start_path}"); got != other {
		t.Errorf("third pane starts in %q, want %q", got, other)
	}
	snap, err = m.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, p := range snap.Groups[0].Tabs[0].Panes {
		ids = append(ids, p.ID)
	}
	if strings.Join(ids, ",") != strings.Join([]string{first, second, third}, ",") {
		t.Fatalf("panes = %v", ids)
	}

	// The focused pane swapped to the end stays focused.
	if err := m.SwapPane(ctx, first, SwapNext); err != nil {
		t.Fatal(err)
	}
	if q(first, "#{pane_index}") != "1" || q(first, "#{pane_active}") != "1" {
		t.Errorf("after a swap: index %s, active %s", q(first, "#{pane_index}"), q(first, "#{pane_active}"))
	}
	if err := m.SwapPane(ctx, third, SwapNext); !errors.Is(err, errNoNeighbor) {
		t.Errorf("swap of the last pane after it = %v", err)
	}

	width := q(second, "#{pane_width}")
	if err := m.ResizePane(ctx, second, ResizeLeft, 4); err != nil {
		t.Fatal(err)
	}
	if q(second, "#{pane_width}") == width {
		t.Error("resize changed nothing")
	}

	for range 2 {
		if err := m.ZoomPane(ctx, third, ZoomOn); err != nil {
			t.Fatal(err)
		}
		if q(third, "#{window_zoomed_flag}:#{pane_active}") != "1:1" {
			t.Errorf("zoom on: %s", q(third, "#{window_zoomed_flag}:#{pane_active}"))
		}
	}
	// Another pane zoomed in its place
	if err := m.ZoomPane(ctx, second, ZoomToggle); err != nil {
		t.Fatal(err)
	}
	if q(second, "#{window_zoomed_flag}:#{pane_active}") != "1:1" {
		t.Errorf("zoom toggle of another pane: %s", q(second, "#{window_zoomed_flag}:#{pane_active}"))
	}
	for range 2 {
		if err := m.ZoomPane(ctx, second, ZoomOff); err != nil {
			t.Fatal(err)
		}
		if q(second, "#{window_zoomed_flag}") != "0" {
			t.Error("zoom off left the window zoomed")
		}
	}
}
