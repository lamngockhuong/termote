package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStripMachineHeaders(t *testing.T) {
	h := http.Header{}
	for _, k := range []string{"Cookie", "Authorization", "Origin", "Referer", "Forwarded", "Sec-Fetch-Site", "Sec-Fetch-Mode",
		"X-Termote-Role", "X-Termote-Origin-Auth", "X-Forwarded-For", "X-Forwarded-Proto", "CF-Connecting-IP", "X-Real-Ip", "X-Client"} {
		h.Set(k, "v")
	}
	h.Set("Content-Type", "application/json")
	h.Set("Sec-WebSocket-Key", "k")
	stripMachineHeaders(h, "X-Client")
	if len(h) != 2 || h.Get("Content-Type") == "" || h.Get("Sec-WebSocket-Key") == "" {
		t.Errorf("left: %v", h)
	}
}

func TestMachineProxyHelpers(t *testing.T) {
	for err, code := range map[error]string{errMachineUnauthorized: "machine_unauthorized", errMachineHostKey: "machine_unauthorized",
		errMachineIncompatible: "machine_incompatible", errMachineOffline: "machine_offline", errors.New("x"): "machine_offline"} {
		if got := machineErrorCode(err); got.code != code || got.status != http.StatusBadGateway {
			t.Errorf("machineErrorCode(%v) = %+v", err, got)
		}
	}
	if machineBodyLimit("/api/mux/panes/x/files/upload") != maxUploadFileSize || machineBodyLimit("/api/mux/tabs") < int64(fileWriteBody) {
		t.Error("machineBodyLimit")
	}
	for a, want := range map[authKind]string{authDevice: "device", authSession: "password", authBasic: "password", authLocal: ""} {
		if got := originAuth(authInfo{Kind: a}); got != want {
			t.Errorf("originAuth(%d) = %q", a, got)
		}
	}
	if machinePathClass("panes/%1/files") != "panes" || machinePathClass("snapshot") != "snapshot" {
		t.Error("machinePathClass")
	}
	if machineRest("/api/machines/0123456789abcdef/mux/uploads") != "/api/mux/uploads" || machineRest("/api/mux/uploads") != "/api/mux/uploads" {
		t.Error("machineRest")
	}
	for p, ok := range map[string]bool{"snapshot": true, "panes/x/files": true, "tabs": true, "recent-groups/1": true, "files/places": true,
		"devices": false, "files/other": false, "snapshot/x": false, "panesx": false, "push/key": false} {
		if machineRouteRe.MatchString(p) != ok {
			t.Errorf("route %q allowed=%v", p, !ok)
		}
	}
}

// Only the CLI over the local socket reloads the machines; the list works
// without any machine.
func TestMachineReloadRoute(t *testing.T) {
	cfg := testConfig(t)
	store := filepath.Join(t.TempDir(), "machines.json")
	cfg.MachinesFile = store
	cfg.MachineSSHDir = t.TempDir()
	h, hub, _, agent, err := buildServerWith(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()); agent.machines.stop() })
	if rec := serve(h, apiRequest("POST", "/api/mux/machines/reload", `{}`)); rec.Code != http.StatusForbidden {
		t.Errorf("reload with the password over TCP: %d", rec.Code)
	}
	saveMachines(store, []machineRecord{testMachine("0123456789abcdef", "Box", "box")})
	rec := serve(h, onLocalSocket(apiRequest("POST", "/api/mux/machines/reload", `{}`)))
	if rec.Code != http.StatusOK || decodeBody(t, rec)["machines"] != float64(1) {
		t.Errorf("reload over the local socket: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("GET", "/api/mux/machines", "")); !strings.Contains(rec.Body.String(), `"status":"connecting"`) {
		t.Errorf("list after reload: %s", rec.Body)
	}
	writeFile(t, store, "{")
	captureLog(t)
	if rec := serve(h, onLocalSocket(apiRequest("POST", "/api/mux/machines/reload", `{}`))); rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "machines.json") {
		t.Errorf("reload of a broken store: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("GET", "/api/mux/machines/reload", "")); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET reload: %d", rec.Code)
	}

	// A server without machines answers both.
	plain := newTestHandler(t, &fakeMux{snap: oneTabSnapshot()})
	if rec := serve(plain, apiRequest("GET", "/api/mux/machines", "")); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"machines":[]`) {
		t.Errorf("list without machines: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(plain, onLocalSocket(apiRequest("POST", "/api/mux/machines/reload", `{}`))); rec.Code != http.StatusOK {
		t.Errorf("reload without machines: %d", rec.Code)
	}
	if rec := serve(plain, apiRequest("POST", "/api/mux/machines", `{}`)); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST machines: %d", rec.Code)
	}
}

// A machine's snapshot is polled while a client lists machines, then not;
// a failed or odd read only drops what was kept.
func TestMachinePoller(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machines.json")
	saveMachines(path, []machineRecord{testMachine("0123456789abcdef", "Box", "box")})
	d := &fakeDialer{t: t, v: apiVersion}
	mm := newMachineManager(path, d)
	t.Cleanup(mm.stop)
	p := newMachinePoller(mm)
	if p.active() {
		t.Error("active before any client")
	}
	p.touch()
	if !p.active() {
		t.Error("inactive right after a client listed")
	}
	got := map[string]bool{}
	p.setOnSnapshot(func(id string, s Snapshot) { got[id] = true })
	l := mm.link("0123456789abcdef")
	// The fake answers health only: a snapshot read that fails to decode
	// as one keeps nothing.
	l.mu.Lock()
	l.checked, l.status = true, "online"
	l.mu.Unlock()
	p.mu.Lock()
	p.last[l.rec.ID] = Snapshot{Groups: []Group{{ID: "g", Name: "G", Tabs: []Tab{{ID: "t", Name: "T", Panes: []Pane{{ID: "p", Title: "secret", Agent: &AgentInfo{Name: "claude", Status: "working"}}}}}}}}
	p.mu.Unlock()
	infos := p.infos(true)
	b, _ := json.Marshal(infos)
	if !strings.Contains(string(b), `"name":"claude"`) || strings.Contains(string(b), "secret") {
		t.Errorf("infos: %s", b)
	}
	if infos := p.infos(false); infos[0].Groups != nil {
		t.Error("groups without asking")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p.run(ctx)
	if _, ok := p.last[l.rec.ID]; ok {
		t.Error("a snapshot that did not decode was kept")
	}
	d.set(errMachineOffline, apiVersion)
	l.retryNow()
	p.pollAll(context.Background())
	if s, _ := l.state(); s != "offline" {
		t.Errorf("status after a failed poll: %q", s)
	}
	mm.keepUp = true
	p.listed = time.Time{}
	if !p.active() {
		t.Error("inactive while Web Push keeps machines polled")
	}
}

// The push watcher keys a machine's panes under its id and names it in the
// event.
func TestPushWatcherObserveMachine(t *testing.T) {
	store, err := newPushStore(t.TempDir(), "admin", "secret", false)
	if err != nil {
		t.Fatal(err)
	}
	w := newPushWatcher(nil, store, nil)
	snap := func(status string) Snapshot {
		return Snapshot{Groups: []Group{{ID: "g", Tabs: []Tab{{ID: "t", Panes: []Pane{{ID: "p", Agent: &AgentInfo{Name: "claude", Status: status}}}}}}}}
	}
	w.observeMachine("m1", snap("working"))
	if len(w.machinePrev) != 0 {
		t.Error("statuses kept without a subscription")
	}
	if err := store.add(fcmSub(t, 1)); err != nil {
		t.Fatal(err)
	}
	w.observeMachine("m1", snap("working"))
	w.observeMachine("m2", snap("working"))
	w.observeMachine("m1", snap("blocked"))
	select {
	case e := <-w.queue:
		if e.MachineID != "m1" || e.Kind != "blocked" || e.PaneID != "p" {
			t.Errorf("event %+v", e)
		}
	default:
		t.Fatal("no event for the machine's blocked agent")
	}
	if w.machinePrev["m2/"+paneKey(Pane{ID: "p"})] != "working" {
		t.Errorf("machine statuses: %v", w.machinePrev)
	}
}
