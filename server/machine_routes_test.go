package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/http/httputil"
	"net/textproto"
	"net/url"
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
	mm.keepUp = func() bool { return true }
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

// A linked hub that runs out of time never keeps the main one's streams
// open or its store unwritten.
func TestStreamHubShutdownLinkedTimeout(t *testing.T) {
	hub := newStreamHub(4)
	fwd := newStreamHub(4)
	hub.linked = []*streamHub{fwd}
	flushed := false
	hub.onShutdown = func() { flushed = true }
	var cause error
	hub.addFor(func(err error) { cause = err }, roleFull, "", "")
	fwd.addFor(func(error) {}, roleFull, "", "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := hub.shutdown(ctx); err == nil {
		t.Error("shutdown past its deadline reported nothing")
	}
	if !errors.Is(cause, errServerShutdown) || !flushed {
		t.Errorf("main hub: cause %v, flushed %v", cause, flushed)
	}
}

// A machine's answer never acts on this origin: sandboxed, and only the
// headers a page of it needs pass (no cookie, service worker scope, site
// data clearing, reporting, challenge, refresh or redirect).
func TestConfineMachineResponse(t *testing.T) {
	drop := []string{"Set-Cookie", "Service-Worker-Allowed", "Clear-Site-Data", "Refresh", "Link",
		"Location", "NEL", "Report-To", "Reporting-Endpoints", "WWW-Authenticate", "Strict-Transport-Security",
		"X-Anything"}
	resp := &http.Response{StatusCode: http.StatusOK, Header: http.Header{}}
	for _, k := range drop {
		resp.Header.Set(k, "x")
	}
	resp.Header["nel"] = []string{"x"} // not canonical
	resp.Header.Set("Content-Type", "text/html")
	resp.Header.Set("Content-Disposition", "attachment")
	resp.Header.Set("ETag", `"1"`)
	confineMachineResponse(resp)
	for _, k := range append(drop, "nel") {
		if len(resp.Header[k]) != 0 || resp.Header.Get(k) != "" {
			t.Errorf("%s passed on", k)
		}
	}
	for _, k := range []string{"Content-Type", "Content-Disposition", "ETag"} {
		if resp.Header.Get(k) == "" {
			t.Errorf("%s dropped", k)
		}
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Security-Policy"), "sandbox") || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("not confined: %v", resp.Header)
	}
	up := &http.Response{StatusCode: http.StatusSwitchingProtocols, Header: http.Header{
		"Set-Cookie": {"a"}, "Nel": {"x"}, "Connection": {"Upgrade"}, "Upgrade": {"websocket"},
		"Sec-Websocket-Accept": {"k"},
	}}
	confineMachineResponse(up)
	if up.Header.Get("Set-Cookie") != "" || up.Header.Get("Nel") != "" || up.Header.Get("Content-Security-Policy") != "" {
		t.Errorf("upgrade: %v", up.Header)
	}
	if up.Header.Get("Upgrade") != "websocket" || up.Header.Get("Sec-Websocket-Accept") != "k" {
		t.Errorf("upgrade headers dropped: %v", up.Header)
	}
}

// A machine's interim answer (103 Early Hints) carries none of its headers
// to the browser, and leaves this server's own headers on the final one.
func TestMachineInterimAnswerDropped(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Set-Cookie", "x=1; Path=/")
		w.Header().Set("Nel", `{"report_to":"x","max_age":1}`)
		w.WriteHeader(http.StatusEarlyHints)
		w.Header().Del("Set-Cookie")
		w.Header().Del("Nel")
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, "ok")
	}))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	proxy := &httputil.ReverseProxy{
		Rewrite:        func(pr *httputil.ProxyRequest) { pr.SetURL(u) },
		ModifyResponse: func(resp *http.Response) error { confineMachineResponse(resp); return nil },
	}
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		proxy.ServeHTTP(newMachineInterimDrop(w), r)
	}))
	defer front.Close()
	var interim []int
	req, _ := http.NewRequest(http.MethodGet, front.URL, nil)
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		Got1xxResponse: func(code int, h textproto.MIMEHeader) error {
			interim = append(interim, code)
			return nil
		},
	}))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(interim) != 0 {
		t.Errorf("interim answers passed on: %v", interim)
	}
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Set-Cookie") != "" || resp.Header.Get("Nel") != "" {
		t.Errorf("final answer: %d %v", resp.StatusCode, resp.Header)
	}
	if resp.Header.Get("X-Frame-Options") != "DENY" || !strings.HasPrefix(resp.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("own or confining headers lost: %v", resp.Header)
	}
}

// A client asks a machine for at most so many stream tokens per window:
// the others' pending tokens stay in the machine's store.
func TestTokenLimiter(t *testing.T) {
	l := &tokenLimiter{seen: map[string][]time.Time{}}
	now := time.Now()
	for i := 0; i < 2; i++ {
		if !l.allow("m|device:a", 2, now) {
			t.Fatalf("request %d refused", i)
		}
	}
	if l.allow("m|device:a", 2, now) {
		t.Error("past the limit")
	}
	if !l.allow("m|device:b", 2, now) {
		t.Error("another client refused")
	}
	if !l.allow("m|device:a", 2, now.Add(machineTokenWindow)) || len(l.seen["m|device:b"]) != 0 {
		t.Error("the window did not pass")
	}
	for a, want := range map[authInfo]string{{DeviceID: "d"}: "device:d", {SessionID: "s"}: "session:s", {}: "password"} {
		if got := tokenClient(a); got != want {
			t.Errorf("tokenClient(%+v) = %q", a, got)
		}
	}
}

// Removing a machine closes its connections, in use or not.
func TestMachineRemovedClosesConns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machines.json")
	saveMachines(path, []machineRecord{testMachine("0123456789abcdef", "Box", "box")})
	d := &fakeDialer{t: t, v: apiVersion}
	mm := newMachineManager(path, d)
	t.Cleanup(mm.stop)
	l := mm.link("0123456789abcdef")
	c, err := l.dial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	saveMachines(path, nil)
	mm.reload()
	if _, err := c.Write([]byte("x")); err == nil {
		t.Error("a connection of a removed machine stayed open")
	}
	if len(l.conns) != 0 {
		t.Error("closed connections still tracked")
	}
}
