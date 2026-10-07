package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeMux records calls and returns canned results, so handler and guard
// tests run through the real ServeMux without tmux.
type fakeMux struct {
	snap   Snapshot
	err    error
	calls  []string
	attach func(pane string, size Size) (TermStream, error)
}

func (f *fakeMux) Name() string { return "fake" }
func (f *fakeMux) Caps() Caps   { return Caps{CopyMode: true} }
func (f *fakeMux) Snapshot(context.Context) (Snapshot, error) {
	f.calls = append(f.calls, "snapshot")
	return f.snap, f.err
}
func (f *fakeMux) SelectTab(_ context.Context, id string) error {
	f.calls = append(f.calls, "select "+id)
	return f.err
}
func (f *fakeMux) NewTab(_ context.Context, group, name string) (string, error) {
	f.calls = append(f.calls, "new "+group+"/"+name)
	return "7", f.err
}
func (f *fakeMux) CloseTab(_ context.Context, id string) error {
	f.calls = append(f.calls, "close "+id)
	return f.err
}
func (f *fakeMux) RenameTab(_ context.Context, id, name string) error {
	f.calls = append(f.calls, "rename "+id+"="+name)
	return f.err
}
func (f *fakeMux) NewGroup(_ context.Context, name, cwd string) (string, error) {
	f.calls = append(f.calls, "new group "+name+" in "+cwd)
	return "g9", f.err
}
func (f *fakeMux) CloseGroup(_ context.Context, id string) error {
	f.calls = append(f.calls, "close group "+id)
	return f.err
}
func (f *fakeMux) RenameGroup(_ context.Context, id, name string) error {
	f.calls = append(f.calls, "rename group "+id+"="+name)
	return f.err
}
func (f *fakeMux) ClosePane(_ context.Context, id string) error {
	f.calls = append(f.calls, "close pane "+id)
	return f.err
}
func (f *fakeMux) SendKeys(_ context.Context, id, keys string) error {
	f.calls = append(f.calls, "keys "+id+"="+keys)
	return f.err
}
func (f *fakeMux) Scroll(_ context.Context, id string, lines int) error {
	f.calls = append(f.calls, fmt.Sprintf("scroll %s=%d", id, lines))
	return f.err
}
func (f *fakeMux) Attach(_ context.Context, pane string, size Size) (TermStream, error) {
	if f.attach == nil {
		return nil, errUnsupported
	}
	return f.attach(pane, size)
}
func (f *fakeMux) Health(context.Context) error { return f.err }

func testConfig(t *testing.T) serveConfig {
	t.Helper()
	return serveConfig{
		PWADir: t.TempDir(),
		User:   "admin",
		Pass:   "secret",
	}
}

func newTestHandler(t *testing.T, m Mux) http.Handler {
	t.Helper()
	h, err := newServeHandler(testConfig(t), m)
	if err != nil {
		t.Fatalf("newServeHandler: %v", err)
	}
	return h
}

// apiRequest builds an authenticated same-origin request, the shape the PWA sends.
func apiRequest(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "localhost:7680"
	req.SetBasicAuth("admin", "secret")
	if method != http.MethodGet {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://localhost:7680")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	return req
}

func serve(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json (body %q)", ct, rec.Body.String())
	}
	var m map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return m
}

func TestSnapshotRoute(t *testing.T) {
	f := &fakeMux{snap: Snapshot{Groups: []Group{{ID: "main", Name: "main", Tabs: []Tab{
		{ID: "0", Name: "shell", Active: true, Panes: []Pane{{ID: "0", Active: true}}},
	}}}}}
	rec := serve(newTestHandler(t, f), apiRequest("GET", "/api/mux/snapshot", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["apiVersion"] != float64(apiVersion) || body["backend"] != "fake" {
		t.Errorf("apiVersion/backend = %v/%v", body["apiVersion"], body["backend"])
	}
	if caps := body["caps"].(map[string]any); caps["copyMode"] != true || caps["clientSideSelect"] != false {
		t.Errorf("caps = %v", caps)
	}
	groups := body["groups"].([]any)
	tab := groups[0].(map[string]any)["tabs"].([]any)[0].(map[string]any)
	if tab["id"] != "0" || tab["name"] != "shell" || tab["active"] != true {
		t.Errorf("tab = %v", tab)
	}
}

func TestSnapshotRouteEmptyGroupsIsArray(t *testing.T) {
	rec := serve(newTestHandler(t, &fakeMux{}), apiRequest("GET", "/api/mux/snapshot", ""))
	if !strings.Contains(rec.Body.String(), `"groups":[]`) {
		t.Errorf("body = %s, want groups:[]", rec.Body.String())
	}
}

func TestHealthRoute(t *testing.T) {
	rec := serve(newTestHandler(t, &fakeMux{}), apiRequest("GET", "/api/mux/health", ""))
	body := decodeBody(t, rec)
	if rec.Code != http.StatusOK || body["status"] != "ok" || body["apiVersion"] != float64(apiVersion) || body["backend"] != "fake" ||
		body["version"] != cliVersion || body["install"] != "unknown" {
		t.Errorf("health = %d %v", rec.Code, body)
	}

	rec = serve(newTestHandler(t, &fakeMux{err: errors.New("down")}), apiRequest("GET", "/api/mux/health", ""))
	if body := decodeBody(t, rec); body["status"] != "degraded" {
		t.Errorf("health on backend error = %v, want degraded", body)
	}
}

func TestWriteRoutesCallBackend(t *testing.T) {
	tests := []struct {
		method, path, body, wantCall string
	}{
		{"POST", "/api/mux/tabs", `{"groupId":"main","name":"dev"}`, "new main/dev"},
		{"PATCH", "/api/mux/tabs/3", `{"name":"renamed"}`, "rename 3=renamed"},
		{"DELETE", "/api/mux/tabs/3", "", "close 3"},
		{"POST", "/api/mux/tabs/3/select", "", "select 3"},
		{"DELETE", "/api/mux/panes/w1M%3Ap4", "", "close pane w1M:p4"},
		{"POST", "/api/mux/panes/3/keys", `{"keys":"ls -la"}`, "keys 3=ls -la"},
		{"POST", "/api/mux/panes/w1M%3Ap4/keys", `{"keys":"x"}`, "keys w1M:p4=x"},
		{"POST", "/api/mux/panes/w1M%3Ap4/scroll", `{"lines":-5}`, "scroll w1M:p4=-5"},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			f := &fakeMux{}
			rec := serve(newTestHandler(t, f), apiRequest(tt.method, tt.path, tt.body))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			if body := decodeBody(t, rec); body["ok"] != true {
				t.Errorf("body = %v", body)
			}
			if len(f.calls) != 1 || f.calls[0] != tt.wantCall {
				t.Errorf("calls = %v, want [%s]", f.calls, tt.wantCall)
			}
		})
	}
}

func TestNewTabReturnsID(t *testing.T) {
	rec := serve(newTestHandler(t, &fakeMux{}), apiRequest("POST", "/api/mux/tabs", `{}`))
	if body := decodeBody(t, rec); body["id"] != "7" {
		t.Errorf("body = %v, want id 7", body)
	}
}

func TestMuxRouteErrors(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		req      *http.Request
		wantCode int
		wantMsg  string
	}{
		{"input error", inputError("invalid tab id"), apiRequest("POST", "/api/mux/tabs/x/select", ""), 400, "invalid tab id"},
		{"unsupported", errUnsupported, apiRequest("POST", "/api/mux/tabs/x/select", ""), 501, errUnsupported.Error()},
		{"internal", errors.New("secret internal detail"), apiRequest("GET", "/api/mux/snapshot", ""), 500, "mux command failed"},
		{"invalid json", nil, apiRequest("POST", "/api/mux/tabs", "not json"), 400, "invalid JSON body"},
		{"body over 8KB", nil, apiRequest("POST", "/api/mux/panes/0/keys", `{"keys":"`+strings.Repeat("x", 9000)+`"}`), 400, "invalid JSON body"},
		{"scroll too far", nil, apiRequest("POST", "/api/mux/panes/0/scroll", `{"lines":10001}`), 400, "lines out of range"},
		{"wrong method on scroll", nil, apiRequest("GET", "/api/mux/panes/0/scroll", ""), 405, "method not allowed"},
		{"keys too long", nil, apiRequest("POST", "/api/mux/panes/0/keys", `{"keys":"`+strings.Repeat("x", 5000)+`"}`), 400, "keys too long"},
		{"wrong method", nil, apiRequest("GET", "/api/mux/tabs", ""), 405, "method not allowed"},
		{"wrong method on pane", nil, apiRequest("POST", "/api/mux/panes/3", "{}"), 405, "method not allowed"},
		{"wrong method on tab", nil, apiRequest("POST", "/api/mux/tabs/3", "{}"), 405, "method not allowed"},
		{"old tmux route", nil, apiRequest("GET", "/api/tmux/windows", ""), 404, "not found"},
		{"unknown api", nil, apiRequest("GET", "/api/nope", ""), 404, "not found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := serve(newTestHandler(t, &fakeMux{err: tt.err}), tt.req)
			if rec.Code != tt.wantCode {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tt.wantCode, rec.Body.String())
			}
			if body := decodeBody(t, rec); body["error"] != tt.wantMsg {
				t.Errorf("error = %v, want %q", body["error"], tt.wantMsg)
			}
		})
	}
}

func TestStreamTokenRoute(t *testing.T) {
	rec := serve(newTestHandler(t, &fakeMux{}), apiRequest("GET", "/api/mux/stream-token", ""))
	if body := decodeBody(t, rec); rec.Code != http.StatusOK || len(body["token"].(string)) != 32 {
		t.Errorf("stream-token = %d %v", rec.Code, body)
	}

	rec = serve(newTestHandler(t, &fakeMux{}), apiRequest("POST", "/api/mux/stream-token", "{}"))
	if body := decodeBody(t, rec); rec.Code != http.StatusMethodNotAllowed || body["error"] != "method not allowed" {
		t.Errorf("POST stream-token = %d %v, want JSON 405", rec.Code, body)
	}

	req := apiRequest("GET", "/api/mux/stream-token", "")
	req.Header.Set("Sec-Fetch-Dest", "document")
	if rec := serve(newTestHandler(t, &fakeMux{}), req); rec.Code != http.StatusForbidden {
		t.Errorf("direct navigation status = %d, want 403", rec.Code)
	}

	for _, site := range []string{"cross-site", "same-site"} {
		req = apiRequest("GET", "/api/mux/stream-token", "")
		req.Header.Set("Sec-Fetch-Site", site)
		if rec := serve(newTestHandler(t, &fakeMux{}), req); rec.Code != http.StatusForbidden {
			t.Errorf("Sec-Fetch-Site %s status = %d, want 403", site, rec.Code)
		}
	}
	req = apiRequest("GET", "/api/mux/stream-token", "")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if rec := serve(newTestHandler(t, &fakeMux{}), req); rec.Code != http.StatusOK {
		t.Errorf("same-origin status = %d, want 200", rec.Code)
	}
}

func TestNewMux(t *testing.T) {
	if m, err := newMux(context.Background(), "tmux"); err != nil || m.Name() != "tmux" {
		t.Errorf("newMux(tmux) = %v, %v", m, err)
	}
	if _, err := newMux(context.Background(), "zellij"); err == nil {
		t.Error("newMux(zellij) should fail")
	}
}
