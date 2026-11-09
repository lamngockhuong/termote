package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func newSettingsTestServer(t *testing.T, cfg serveConfig) (http.Handler, *agentAPI) {
	t.Helper()
	h, hub, _, agent, err := buildServerWith(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()) })
	return h, agent
}

func readSettingsSnapshot(t *testing.T, h http.Handler, req *http.Request) Snapshot {
	t.Helper()
	rec := serve(h, req)
	var snap Snapshot
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &snap) != nil {
		t.Fatalf("snapshot: %d %s", rec.Code, rec.Body)
	}
	return snap
}

// Only the CLI over the local socket proposes; every device reads the
// proposal and the snapshot names it; the machine bridge gets none of it.
func TestSettingsProposalRoutes(t *testing.T) {
	h, _ := newSettingsTestServer(t, testConfig(t))
	logs := captureLog(t)
	body := `{"editorVim":true,"terminalFont":"Secret Mono"}`

	if rec := serve(h, apiRequest("POST", settingsProposalRoute, body)); rec.Code != http.StatusForbidden || decodeBody(t, rec)["code"] != "cli_only" {
		t.Errorf("POST with the password over TCP: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, onBridge(withBridgeRole(apiRequest("POST", settingsProposalRoute, body), "full"))); rec.Code != http.StatusForbidden || decodeBody(t, rec)["code"] != "machine_forbidden" {
		t.Errorf("POST over the bridge: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("GET", settingsProposalRoute, "")); rec.Code != http.StatusNotFound || decodeBody(t, rec)["code"] != "not_found" {
		t.Errorf("GET without a proposal: %d %s", rec.Code, rec.Body)
	}
	if snap := readSettingsSnapshot(t, h, apiRequest("GET", "/api/mux/snapshot", "")); snap.SettingsProposal != nil || !snap.Caps.SettingsProposals {
		t.Errorf("snapshot without a proposal: %+v %v", snap.SettingsProposal, snap.Caps.SettingsProposals)
	}

	rec := serve(h, onLocalSocket(apiRequest("POST", settingsProposalRoute, body)))
	res := decodeBody(t, rec)
	id, _ := res["id"].(string)
	if rec.Code != http.StatusOK || len(id) != 16 || res["count"] != float64(2) || res["expiresAt"] == "" {
		t.Fatalf("POST over the local socket: %d %s", rec.Code, rec.Body)
	}
	line := logs.String()
	if !strings.Contains(line, `audit: settings_proposed id="`+id+`" keys="editorVim,terminalFont"`) || strings.Contains(line, "Secret Mono") {
		t.Errorf("audit line: %s", line)
	}

	rec = serve(h, apiRequest("GET", settingsProposalRoute, ""))
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("GET: %d %v", rec.Code, rec.Header())
	}
	var got struct {
		ID     string                     `json:"id"`
		Values map[string]json.RawMessage `json:"values"`
	}
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got.ID != id || string(got.Values["editorVim"]) != "true" || string(got.Values["terminalFont"]) != `"Secret Mono"` {
		t.Errorf("GET body: %s", rec.Body)
	}
	if snap := readSettingsSnapshot(t, h, apiRequest("GET", "/api/mux/snapshot", "")); snap.SettingsProposal == nil || snap.SettingsProposal.ID != id {
		t.Errorf("snapshot: %+v", snap.SettingsProposal)
	}

	// Through the bridge: the route is forbidden and the snapshot names
	// no proposal.
	if rec := serve(h, onBridge(apiRequest("GET", settingsProposalRoute, ""))); rec.Code != http.StatusForbidden {
		t.Errorf("GET over the bridge: %d", rec.Code)
	}
	if snap := readSettingsSnapshot(t, h, onBridge(apiRequest("GET", "/api/mux/snapshot", ""))); snap.SettingsProposal != nil || snap.Caps.SettingsProposals {
		t.Errorf("snapshot over the bridge: %+v %v", snap.SettingsProposal, snap.Caps.SettingsProposals)
	}

	cross := apiRequest("GET", settingsProposalRoute, "")
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, cross); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site GET: %d", rec.Code)
	}
	if rec := serve(h, apiRequest("PUT", settingsProposalRoute, body)); rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, POST" {
		t.Errorf("PUT: %d %v", rec.Code, rec.Header())
	}
}

// The server checks a proposal again, whatever the CLI did.
func TestSettingsProposalRefusals(t *testing.T) {
	h, agent := newSettingsTestServer(t, testConfig(t))
	rec := serve(h, onLocalSocket(apiRequest("POST", settingsProposalRoute, `{"editorFontSize":99,"nope":1}`)))
	var res struct {
		Code     string            `json:"code"`
		Problems []settingsProblem `json:"problems"`
	}
	json.Unmarshal(rec.Body.Bytes(), &res)
	if rec.Code != http.StatusBadRequest || res.Code != "invalid_settings" || len(res.Problems) != 2 || res.Problems[0].Key != "editorFontSize" || res.Problems[1].Key != "nope" {
		t.Errorf("invalid: %d %s", rec.Code, rec.Body)
	}
	big := `{"terminalFont":"` + strings.Repeat("a", maxSettingsProposal) + `"}`
	if rec := serve(h, onLocalSocket(apiRequest("POST", settingsProposalRoute, big))); rec.Code != http.StatusRequestEntityTooLarge || decodeBody(t, rec)["code"] != "too_large" {
		t.Errorf("too large: %d %s", rec.Code, rec.Body)
	}
	req := onLocalSocket(apiRequest("POST", settingsProposalRoute, ""))
	req.Body = errReader{}
	if rec := serve(h, req); rec.Code != http.StatusBadRequest {
		t.Errorf("unreadable body: %d %s", rec.Code, rec.Body)
	}
	if agent.settings.get() != nil {
		t.Error("a refused proposal was kept")
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, context.Canceled }
func (errReader) Close() error             { return nil }

// Without sign-in the local socket still proposes, and TCP still cannot.
func TestSettingsProposalNoAuth(t *testing.T) {
	cfg := testConfig(t)
	cfg.NoAuth, cfg.Pass = true, ""
	h, _ := newSettingsTestServer(t, cfg)
	if rec := serve(h, onLocalSocket(apiRequest("POST", settingsProposalRoute, `{"theme":"dark"}`))); rec.Code != http.StatusOK {
		t.Errorf("local socket with --no-auth: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("POST", settingsProposalRoute, `{"theme":"dark"}`)); rec.Code != http.StatusForbidden {
		t.Errorf("TCP with --no-auth: %d", rec.Code)
	}
}

func TestSettingsProposalStore(t *testing.T) {
	at := time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)
	s := newSettingsProposals()
	s.now = func() time.Time { return at }
	if s.get() != nil || s.ref() != nil {
		t.Fatal("a new store has a proposal")
	}
	notified := 0
	s.setNotify(func() { notified++ })
	first := s.put(map[string]json.RawMessage{"theme": json.RawMessage(`"dark"`)})
	at = at.Add(time.Minute)
	second := s.put(map[string]json.RawMessage{"editorVim": json.RawMessage(`true`)})
	if first.ID == second.ID || s.get().ID != second.ID || string(s.get().Values["editorVim"]) != "true" {
		t.Fatalf("the newest proposal replaces the one before: %+v", s.get())
	}
	if notified != 1 {
		t.Errorf("notified %d times within %v, want 1", notified, settingsPushEvery)
	}
	at = at.Add(settingsPushEvery)
	third := s.put(map[string]json.RawMessage{"editorVim": json.RawMessage(`false`)})
	if notified != 2 {
		t.Errorf("notified %d times after %v, want 2", notified, settingsPushEvery)
	}
	if r := s.ref(); r == nil || r.ID != third.ID || r.ExpiresAt != at.Add(settingsProposalTTL).Format(time.RFC3339) {
		t.Errorf("ref = %+v", r)
	}
	at = at.Add(settingsProposalTTL - time.Second)
	if s.get() == nil {
		t.Error("expired before its time")
	}
	at = at.Add(time.Second)
	if s.get() != nil || s.ref() != nil {
		t.Error("kept after it expired")
	}
	// The expiry is on the wall clock: a time read with a monotonic
	// reading far off still compares by wall time.
	s.now = time.Now
	p := s.put(map[string]json.RawMessage{"theme": json.RawMessage(`"light"`)})
	if p.ExpiresAt != p.ExpiresAt.Round(0) || p.CreatedAt != p.CreatedAt.Round(0) {
		t.Error("times keep a monotonic reading")
	}
}

// A proposal pushes its kind only, on a topic of its own.
func TestPushWatcherSettingsEvent(t *testing.T) {
	w, f, _ := newTestWatcher(t, nil)
	if err := w.store.add(fcmSub(t, 1)); err != nil {
		t.Fatal(err)
	}
	w.notifySettings()
	e := <-w.queue
	if e != (pushEvent{Kind: "settings"}) {
		t.Fatalf("event = %+v", e)
	}
	w.deliverEvent(context.Background(), e)
	if f.count() != 1 || !strings.HasSuffix(f.sent[0], ` {"kind":"settings"}`) {
		t.Fatalf("sent %v", f.sent)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if startPushWatcher(ctx, &fakeMux{}, w.store, nil, nil) == nil {
		t.Error("no watcher with a store")
	}
}
