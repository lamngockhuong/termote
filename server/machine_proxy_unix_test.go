//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// mainWithMachine is a main server (sign-in and devices on) reaching a real
// second server over its bridge socket, as the E2E suite does. It returns
// the handler, the agent API and the machine's id.
func mainWithMachine(t *testing.T) (http.Handler, *agentAPI, string) {
	t.Helper()
	dir, port := bridgeTestServer(t)
	cfg := testConfig(t)
	cfg.DevicesDir = filepath.Join(t.TempDir(), "devices")
	cfg.MachineBridges = "Remote=" + strconv.Itoa(port) + "@" + dir
	h, hub, _, agent, err := buildServerWith(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		hub.shutdown(context.Background())
		agent.machines.stop()
	})
	return h, agent, agent.machines.all()[0].rec.ID
}

func TestMachineProxyForwardsRoutes(t *testing.T) {
	h, agent, id := mainWithMachine(t)
	base := "/api/machines/" + id + "/mux/"

	rec := serve(h, apiRequest("GET", base+"snapshot", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"groups"`) {
		t.Fatalf("snapshot through the proxy: %d %s", rec.Code, rec.Body)
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Error("a cookie came back from the machine")
	}
	// The list shows it online with its agents once polled, and names no
	// alias or path.
	agent.machinePoll.pollAll(context.Background())
	rec = serve(h, apiRequest("GET", "/api/mux/machines", ""))
	body := rec.Body.String()
	if rec.Code != http.StatusOK || !strings.Contains(body, `"status":"online"`) || !strings.Contains(body, `"label":"Remote"`) ||
		!strings.Contains(body, `"groups":[`) || strings.Contains(body, "@") || strings.Contains(body, "alias") {
		t.Errorf("machines: %d %s", rec.Code, body)
	}
	snap := decodeBody(t, serve(h, apiRequest("GET", "/api/mux/snapshot", "")))
	if caps := snap["caps"].(map[string]any); caps["machines"] != true || snap["machines"] == nil {
		t.Errorf("snapshot machines: %v", snap["machines"])
	}

	// Writes as full reach the machine; a CLI-only or password-only route
	// never does.
	if rec := serve(h, apiRequest("POST", base+"tabs", `{"groupId":"main"}`)); rec.Code == http.StatusForbidden {
		t.Errorf("full write through the proxy: %d %s", rec.Code, rec.Body)
	}
	for _, p := range []string{"devices", "devices/pair", "signins", "push/key", "push/subscribe", "login-links", "logout", "machines", "brand-new", "snapshotx"} {
		for _, method := range []string{"GET", "POST"} {
			rec := serve(h, apiRequest(method, base+p, `{}`))
			if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "machine_route_forbidden") {
				t.Errorf("%s %s through the proxy: %d %s", method, p, rec.Code, rec.Body)
			}
		}
	}
	for _, p := range []string{base + "panes%2F..%2Fdevices", base + "panes/%5C..", base + "panes/x/./files", base + "tabs//x"} {
		req := apiRequest("GET", "/", "")
		req.URL.Path, req.URL.RawPath = "", ""
		req.URL, _ = req.URL.Parse(p)
		req.RequestURI = p
		rec := serve(h, req)
		// Refused by the proxy, or redirected or refused by the mux before
		// it: never forwarded.
		if !strings.Contains(rec.Body.String(), "machine_route_forbidden") && rec.Code/100 != 3 && rec.Code != http.StatusNotFound {
			t.Errorf("%s through the proxy: %d %s", p, rec.Code, rec.Body)
		}
	}
	if rec := serve(h, apiRequest("GET", "/api/machines/0000000000000000/mux/snapshot", "")); rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "machine_unknown") {
		t.Errorf("unknown machine: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("GET", "/api/machines/nope", "")); rec.Code != http.StatusNotFound {
		t.Errorf("bad machine path: %d", rec.Code)
	}
	// Without credentials the proxy is never reached.
	anon := apiRequest("GET", base+"snapshot", "")
	anon.Header.Del("Authorization")
	if rec := serve(h, anon); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: %d", rec.Code)
	}
}

// The cross-site checks the machine can no longer make run at the edge.
func TestMachineProxyCrossSite(t *testing.T) {
	h, _, id := mainWithMachine(t)
	base := "/api/machines/" + id + "/mux/"
	req := apiRequest("GET", base+"snapshot", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site GET: %d", rec.Code)
	}
	req = apiRequest("GET", base+"snapshot", "")
	req.Header.Set("Origin", "https://evil.example")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("foreign Origin GET: %d", rec.Code)
	}
	req = apiRequest("GET", base+"stream-token", "")
	req.Header.Set("Sec-Fetch-Dest", "document")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("stream-token as a navigation: %d", rec.Code)
	}
	if rec := serve(h, apiRequest("GET", "/api/mux/machines", "")); rec.Code != http.StatusOK {
		t.Errorf("machines list: %d", rec.Code)
	}
	req = apiRequest("GET", "/api/mux/machines", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site machines list: %d", rec.Code)
	}
}

// writeGuard reads the path without its prefix: the raw bodies of
// uploads, files/upload and files/image pass it as on this server, other
// bodies must still be JSON.
func TestMachineProxyWriteGuardPrefix(t *testing.T) {
	h, _, id := mainWithMachine(t)
	base := "/api/machines/" + id + "/mux/"
	raw := func(path, ct string) int {
		req := apiRequest("POST", base+path, "x")
		req.Header.Set("Content-Type", ct)
		return serve(h, req).Code
	}
	for path, ct := range map[string]string{"uploads": "image/png", "panes/0/files/upload?path=a": "application/octet-stream", "panes/0/files/image?path=a.md": "image/png"} {
		if code := raw(path, ct); code == http.StatusUnsupportedMediaType {
			t.Errorf("%s with %s refused at the edge", path, ct)
		}
	}
	if code := raw("tabs", "text/plain"); code != http.StatusUnsupportedMediaType {
		t.Errorf("text body to tabs: %d", code)
	}
	if code := raw("uploads", "multipart/form-data"); code == http.StatusOK || code/100 == 2 {
		t.Errorf("multipart upload: %d", code)
	}
}

// A view-only device here is view-only there: the edge refuses its writes,
// and the machine is told view.
func TestMachineProxyViewOnly(t *testing.T) {
	h, _, id := mainWithMachine(t)
	base := "/api/machines/" + id + "/mux/"
	view := pairDevice(t, h, "view")
	for _, w := range []struct{ method, path, body string }{{"POST", "tabs", `{"groupId":"main"}`}, {"POST", "jobs", `{"title":"t"}`},
		{"PATCH", "jobs/abc", `{"state":"done"}`}, {"POST", "jobs/abc/ci", `{"action":"send"}`}} {
		if rec := serve(h, asDevice(w.method, base+w.path, w.body, view)); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "view_only") {
			t.Errorf("view %s %s through the proxy: %d %s", w.method, w.path, rec.Code, rec.Body)
		}
	}
	// The machine gives a view role the brief of its jobs.
	if rec := serve(h, asDevice("GET", base+"jobs?all=1", "", view)); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"readOnly":true`) {
		t.Errorf("view jobs through the proxy: %d %s", rec.Code, rec.Body)
	}
	snap := decodeBody(t, serve(h, asDevice("GET", base+"snapshot", "", view)))
	if caps, _ := snap["caps"].(map[string]any); caps["role"] != "view" {
		t.Errorf("the machine did not see a view role: %v", snap["caps"])
	}
}

// A machine that cannot be reached is a coded error, with nothing ssh or
// the OS said.
func TestMachineProxyOffline(t *testing.T) {
	cfg := testConfig(t)
	cfg.MachineBridges = "Gone=1@" + filepath.Join(shortDir(t), "run")
	h, hub, _, agent, err := buildServerWith(cfg, &fakeMux{snap: oneTabSnapshot()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hub.shutdown(context.Background()); agent.machines.stop() })
	captureLog(t)
	id := agent.machines.all()[0].rec.ID
	rec := serve(h, apiRequest("GET", "/api/machines/"+id+"/mux/snapshot", ""))
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "machine_offline") || strings.Contains(rec.Body.String(), "no such file") {
		t.Errorf("offline machine: %d %s", rec.Code, rec.Body)
	}
	agent.machinePoll.pollAll(context.Background())
	if body := serve(h, apiRequest("GET", "/api/mux/machines", "")).Body.String(); !strings.Contains(body, `"status":"offline"`) || strings.Contains(body, "groups") {
		t.Errorf("offline machine listed: %s", body)
	}
}

// A terminal stream opens through the proxy with a token the machine
// minted, and a revoke of the device here closes it.
func TestMachineProxyStreamAndRevoke(t *testing.T) {
	// A stream (101) is bounded by neither body wait.
	setMachineBodyWaits(t, 50*time.Millisecond, 100*time.Millisecond)
	h, agent, id := mainWithMachine(t)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	full := pairDevice(t, h, "full")
	base := "/api/machines/" + id + "/mux/"

	req := asDevice("GET", base+"stream-token", "", full)
	rec := serve(h, req)
	var tok struct{ Token string }
	json.Unmarshal(rec.Body.Bytes(), &tok)
	if rec.Code != http.StatusOK || tok.Token == "" {
		t.Fatalf("stream-token through the proxy: %d %s", rec.Code, rec.Body)
	}
	hdr := http.Header{}
	hdr.Set("Cookie", full.Name+"="+full.Value)
	hdr.Set("Origin", srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+base+"stream?pane=0&token="+tok.Token, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatalf("stream through the proxy: %v", err)
	}
	defer ws.CloseNow()
	l := agent.machines.link(id)
	conns := func() int { l.mu.Lock(); defer l.mu.Unlock(); return len(l.conns) }
	before := conns()
	time.Sleep(300 * time.Millisecond)
	if after := conns(); after < before {
		t.Errorf("connections to the machine %d → %d: a body wait closed the stream", before, after)
	}

	// A foreign Origin on the upgrade is refused at the edge.
	bad := hdr.Clone()
	bad.Set("Origin", "https://evil.example")
	if _, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+base+"stream?pane=0&token=x", &websocket.DialOptions{HTTPHeader: bad}); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("foreign Origin upgrade: %v", err)
	}

	devID := deviceIDOf(t, h, "Test full")
	if rec := serve(h, apiRequest("DELETE", "/api/mux/devices/"+devID, "")); rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body)
	}
	rctx, rcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer rcancel()
	for {
		if _, _, err := ws.Read(rctx); err != nil {
			if rctx.Err() != nil {
				t.Fatal("the forwarded stream stayed open after the revoke")
			}
			break
		}
	}
}

// The machine's job ledger reads and changes through the proxy, on the
// machine; a job's history and its grants never leave this server.
func TestMachineProxyJobs(t *testing.T) {
	h, agent, id := mainWithMachine(t)
	base := "/api/machines/" + id + "/mux/"
	rec := serve(h, apiRequest("POST", base+"jobs", `{"title":"Remote job"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create through the proxy: %d %s", rec.Code, rec.Body)
	}
	var made struct {
		Job struct{ ID, CreatedBy, Updated string }
	}
	json.Unmarshal(rec.Body.Bytes(), &made)
	// Basic auth here is not a browser: the machine names the job its.
	if made.Job.CreatedBy != "machine" {
		t.Errorf("created by %q", made.Job.CreatedBy)
	}
	rec = serve(h, apiRequest("GET", base+"jobs?all=1", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Remote job") || !strings.Contains(rec.Body.String(), `"canGrant":false`) {
		t.Errorf("list through the proxy: %d %s", rec.Code, rec.Body)
	}
	if agent.jobs != nil {
		if _, ok := agent.jobs.job(made.Job.ID); ok {
			t.Error("the job was made on this server")
		}
	}
	job := base + "jobs/" + made.Job.ID
	rec = serve(h, apiRequest("PATCH", job, `{"state":"review","updated":"`+made.Job.Updated+`"}`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"review"`) {
		t.Errorf("patch through the proxy: %d %s", rec.Code, rec.Body)
	}
	// Forwarded: the machine answers, whatever it says about ci.
	if rec := serve(h, apiRequest("POST", job+"/ci", `{"action":"refresh"}`)); strings.Contains(rec.Body.String(), "machine_route_forbidden") || rec.Code/100 == 5 && !strings.Contains(rec.Body.String(), "ci_unavailable") {
		t.Errorf("ci through the proxy: %d %s", rec.Code, rec.Body)
	}
	for _, rt := range []struct{ method, path string }{{"POST", job + "/event"}, {"POST", job + "/grants"}, {"DELETE", job + "/grants/g1"},
		{"POST", job + "/ci/x"}, {"GET", base + "jobs/"}, {"GET", base + "jobsx"}} {
		if rec := serve(h, apiRequest(rt.method, rt.path, `{}`)); rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "machine_route_forbidden") {
			t.Errorf("%s %s through the proxy: %d %s", rt.method, rt.path, rec.Code, rec.Body)
		}
	}
	rec = serve(h, apiRequest("GET", base+"jobs?all=1", ""))
	var list struct {
		Jobs []struct{ ID, Updated string }
	}
	json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list.Jobs) != 1 {
		t.Fatalf("jobs %s", rec.Body)
	}
	if rec := serve(h, apiRequest("DELETE", job+"?updated="+url.QueryEscape(list.Jobs[0].Updated), "")); rec.Code != http.StatusOK {
		t.Errorf("delete through the proxy: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("GET", base+"jobs?all=1", "")); !strings.Contains(rec.Body.String(), `"jobs":[]`) {
		t.Errorf("after delete: %s", rec.Body)
	}
}

// The machine's questions list through the proxy and an answer reaches it;
// adding, closing or reporting one never leaves this server.
func TestMachineProxyAsks(t *testing.T) {
	h, _, id := mainWithMachine(t)
	base := "/api/machines/" + id + "/mux/"
	if rec := serve(h, apiRequest("GET", base+"asks", "")); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"asks":[]`) {
		t.Errorf("asks through the proxy: %d %s", rec.Code, rec.Body)
	}
	// Forwarded: the machine refuses an answer from Basic auth here.
	if rec := serve(h, apiRequest("POST", base+"asks/Q1/answer", `{"choice":1,"updated":"x"}`)); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "ask_browser_only") {
		t.Errorf("answer through the proxy: %d %s", rec.Code, rec.Body)
	}
	for _, rt := range []struct{ method, path string }{{"POST", "asks"}, {"PUT", "asks"}, {"POST", "asks/Q1/close"}, {"POST", "asks/Q1/reported"},
		{"GET", "asks/Q1"}, {"POST", "asks/Q1/answer/x"}} {
		if rec := serve(h, apiRequest(rt.method, base+rt.path, `{}`)); rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "machine_route_forbidden") {
			t.Errorf("%s %s through the proxy: %d %s", rt.method, rt.path, rec.Code, rec.Body)
		}
	}
	view := pairDevice(t, h, "view")
	if rec := serve(h, asDevice("POST", base+"asks/Q1/answer", `{"choice":1}`, view)); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "view_only") {
		t.Errorf("view answer through the proxy: %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, asDevice("GET", base+"asks", "", view)); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"readOnly":true`) {
		t.Errorf("view asks through the proxy: %d %s", rec.Code, rec.Body)
	}
}
