package main

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
)

func TestHerdrTaskTab(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	tab, err := m.NewTaskTab(ctx, "wR", "task:test", "/r/a b")
	if err != nil || tab != (taskTab{TabID: "wR:tNEW", PaneID: "wR:pNEW", Target: "wR:pNEW"}) {
		t.Fatalf("NewTaskTab = %+v %v", tab, err)
	}
	var p map[string]any
	f.mu.Lock()
	json.Unmarshal(f.params["tab.create"][0], &p)
	f.mu.Unlock()
	if p["workspace_id"] != "wR" || p["cwd"] != "/r/a b" || p["label"] != "task:test" || p["focus"] != false {
		t.Errorf("params = %v", p)
	}
	// A name Herdr would refuse is left out.
	if _, err := m.NewTaskTab(ctx, "wR", "bad\x01name", "/r"); err != nil {
		t.Fatal(err)
	}
	p = nil
	f.mu.Lock()
	json.Unmarshal(f.params["tab.create"][1], &p)
	f.mu.Unlock()
	if _, ok := p["label"]; ok {
		t.Errorf("label sent: %v", p)
	}
	var ie inputError
	for _, g := range []string{"x", "wNOPE"} {
		if _, err := m.NewTaskTab(ctx, g, "", "/r"); !errors.As(err, &ie) {
			t.Errorf("group %q = %v", g, err)
		}
	}
	f.mu.Lock()
	f.failCode = "tab_create_failed"
	f.mu.Unlock()
	if _, err := m.NewTaskTab(ctx, "wR", "", "/r"); err == nil {
		t.Error("a failed tab.create made a tab")
	}
	f.mu.Lock()
	f.noRootPane = true
	f.mu.Unlock()
	if _, err := m.NewTaskTab(ctx, "wR", "", "/r"); err == nil {
		t.Error("a tab without a root pane")
	}
}

func TestHerdrTaskShell(t *testing.T) {
	f := newFakeHerdr(t)
	m := newTestHerdrMux(t, f)
	ctx := context.Background()
	shortStart(t)
	if shell, idle, err := m.IdleShell(ctx, startPane); shell != "bash" || !idle || err != nil {
		t.Errorf("idle = %q %v %v", shell, idle, err)
	}
	f.mu.Lock()
	f.procs = map[string]any{startPane: vimProcs}
	f.mu.Unlock()
	if shell, idle, err := m.IdleShell(ctx, startPane); shell != "" || idle || err != nil {
		t.Errorf("busy = %q %v %v", shell, idle, err)
	}
	f.mu.Lock()
	f.procFail = "pane_not_found"
	f.mu.Unlock()
	if _, _, err := m.IdleShell(ctx, startPane); !errors.Is(err, errTaskTargetGone) {
		t.Errorf("gone = %v", err)
	}
	f.mu.Lock()
	f.procFail = "internal"
	f.mu.Unlock()
	if _, _, err := m.IdleShell(ctx, startPane); err == nil || errors.Is(err, errTaskTargetGone) {
		t.Errorf("failure = %v", err)
	}

	if err := m.Interrupt(ctx, startPane); err != nil {
		t.Fatal(err)
	}
	if err := m.TypeLine(ctx, startPane, "make 'x'"); err != nil {
		t.Fatal(err)
	}
	log := f.callLog()
	if !slices.Contains(log, "pane.send_text \x03") || !slices.Contains(log, "pane.send_text make 'x'\r") {
		t.Errorf("log = %q", log)
	}
	f.mu.Lock()
	f.readText = "out\n[termote-task x]\n"
	f.mu.Unlock()
	if text, err := m.ReadTaskText(ctx, startPane, 400); err != nil || text != "out\n[termote-task x]\n" {
		t.Errorf("read = %q %v", text, err)
	}
	var ie inputError
	for _, bad := range []string{"p3", "wR:t1", ""} {
		_, _, err := m.IdleShell(ctx, bad)
		if !errors.As(err, &ie) || !errors.As(m.Interrupt(ctx, bad), &ie) || !errors.As(m.TypeLine(ctx, bad, "x"), &ie) {
			t.Errorf("target %q accepted", bad)
		}
	}
}
