//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testSession = "termote-test"

// setupTmux starts an isolated tmux server on a temp socket so the test never
// touches the user's own tmux sessions.
func setupTmux(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	origSocket, origSession := tmuxSocket, tmuxSession
	tmuxSocket = filepath.Join(t.TempDir(), "tmux.sock")
	tmuxSession = testSession
	if err := tmuxCmd(context.Background(), "-f", "/dev/null", "new-session", "-d", "-s", testSession).Run(); err != nil {
		t.Fatalf("failed to create tmux session: %v", err)
	}
	t.Cleanup(func() {
		tmuxCmd(context.Background(), "kill-server").Run()
		tmuxSocket, tmuxSession = origSocket, origSession
	})
}

func tabNames(t *testing.T) []string {
	t.Helper()
	snap, err := tmuxMux{}.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	var names []string
	for _, tab := range snap.Groups[0].Tabs {
		names = append(names, tab.Name)
	}
	return names
}

func TestIntegrationSnapshot(t *testing.T) {
	setupTmux(t)
	snap, err := tmuxMux{}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Groups) != 1 || snap.Groups[0].ID != testSession {
		t.Fatalf("groups = %+v, want one group %q", snap.Groups, testSession)
	}
	tabs := snap.Groups[0].Tabs
	if len(tabs) != 1 || !tabs[0].Active || tabs[0].ID != "0" {
		t.Fatalf("tabs = %+v, want active tab 0", tabs)
	}
	if len(tabs[0].Panes) != 1 || tabs[0].Panes[0].ID != "0" {
		t.Errorf("panes = %+v, want pane id equal to tab id", tabs[0].Panes)
	}
}

func TestIntegrationNewTabKeepsColonInName(t *testing.T) {
	setupTmux(t)
	id, err := tmuxMux{}.NewTab(context.Background(), testSession, "a:b c")
	if err != nil {
		t.Fatal(err)
	}
	if id != "1" {
		t.Errorf("NewTab id = %q, want 1", id)
	}
	if names := tabNames(t); len(names) != 2 || names[1] != "a:b c" {
		t.Errorf("tab names = %q", names)
	}
}

func TestIntegrationSelectRenameClose(t *testing.T) {
	setupTmux(t)
	m, ctx := tmuxMux{}, context.Background()
	if _, err := m.NewTab(ctx, "", "second"); err != nil {
		t.Fatal(err)
	}
	if err := m.SelectTab(ctx, "0"); err != nil {
		t.Fatalf("SelectTab: %v", err)
	}
	snap, _ := m.Snapshot(ctx)
	if !snap.Groups[0].Tabs[0].Active {
		t.Error("tab 0 should be active after select")
	}
	if err := m.RenameTab(ctx, "1", "renamed"); err != nil {
		t.Fatalf("RenameTab: %v", err)
	}
	if names := tabNames(t); names[1] != "renamed" {
		t.Errorf("names = %q", names)
	}
	if err := m.CloseTab(ctx, "1"); err != nil {
		t.Fatalf("CloseTab: %v", err)
	}
	if names := tabNames(t); len(names) != 1 {
		t.Errorf("names after close = %q", names)
	}
}

func TestIntegrationSendKeys(t *testing.T) {
	setupTmux(t)
	ctx := context.Background()
	if err := (tmuxMux{}).SendKeys(ctx, "0", "echo termote-marker"); err != nil {
		t.Fatal(err)
	}
	if err := (tmuxMux{}).SendKeys(ctx, "0", "Enter"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := tmuxCmd(ctx, "capture-pane", "-p", "-t", testSession+":0").Output()
		if strings.Count(string(out), "termote-marker") >= 2 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Error("send-keys output not seen in pane")
}

func TestIntegrationMissingWindowIsServerError(t *testing.T) {
	setupTmux(t)
	if err := (tmuxMux{}).SelectTab(context.Background(), "99"); err == nil {
		t.Error("selecting a missing window should fail")
	}
}

// Full stack: real ServeMux, guards and auth in front of tmux.
func TestIntegrationServeMuxSnapshotIsJSON(t *testing.T) {
	setupTmux(t)
	h := newTestHandler(t, tmuxMux{})

	rec := serve(h, apiRequest("GET", "/api/mux/snapshot", ""))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("snapshot = %d %q, body %s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
	var snap Snapshot
	if err := json.NewDecoder(rec.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	if snap.Backend != "tmux" || snap.APIVersion != apiVersion || !snap.Caps.CopyMode {
		t.Errorf("snapshot header = %+v", snap)
	}

	rec = serve(h, apiRequest("POST", "/api/mux/tabs", `{"name":"via-http"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("new tab = %d %s", rec.Code, rec.Body.String())
	}
	rec = serve(h, apiRequest("POST", "/api/mux/tabs/-x/select", ""))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("flag-like id = %d, want 400", rec.Code)
	}
	rec = serve(h, apiRequest("POST", "/api/mux/tabs/other:0/select", ""))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("cross-session id = %d, want 400", rec.Code)
	}
	if names := tabNames(t); len(names) != 2 || names[1] != "via-http" {
		t.Errorf("names = %q", names)
	}
}
