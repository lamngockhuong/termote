package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

// reorderFake is fakeMux with both reorder caps on.
func reorderFake() *fakeMux {
	return &fakeMux{caps: &Caps{ReorderTabs: true, ReorderGroups: true}}
}

func TestMoveRoutes(t *testing.T) {
	f := reorderFake()
	f.moveID = "$3:0"
	h := newTestHandler(t, f)
	rec := serve(h, apiRequest(http.MethodPost, "/api/mux/tabs/$3:2/move", `{"index":0}`))
	if body := decodeBody(t, rec); rec.Code != 200 || body["ok"] != true || body["id"] != "$3:0" {
		t.Errorf("move tab = %d %v", rec.Code, body)
	}
	rec = serve(h, apiRequest(http.MethodPost, "/api/mux/groups/w2/move", `{"index":3}`))
	if body := decodeBody(t, rec); rec.Code != 200 || body["ok"] != true || body["id"] != "w2" {
		t.Errorf("move group = %d %v", rec.Code, body)
	}
	if want := []string{"move tab $3:2 to 0", "move group w2 to 3"}; strings.Join(f.calls, "|") != strings.Join(want, "|") {
		t.Errorf("calls = %q, want %q", f.calls, want)
	}
}

func TestMoveRoutesRefuseBadIndex(t *testing.T) {
	f := reorderFake()
	h := newTestHandler(t, f)
	for _, path := range []string{"/api/mux/tabs/1/move", "/api/mux/groups/w1/move"} {
		for body, want := range map[string]string{`{}`: "invalid_index", `{"index":-1}`: "invalid_index",
			`{"index":null}`: "invalid_index", `{"index":1.5}`: "", `{"index":"1"}`: "", `[]`: ""} {
			rec := serve(h, apiRequest(http.MethodPost, path, body))
			_, code := replyOf(t, rec.Body.Bytes())
			if rec.Code != http.StatusBadRequest || code != want {
				t.Errorf("%s %s: %d %q, want 400 %q", path, body, rec.Code, code, want)
			}
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("backend called: %q", f.calls)
	}
}

// A backend without the cap answers 501 before the body is read.
func TestMoveRoutesCapOff(t *testing.T) {
	f := &fakeMux{}
	h := newTestHandler(t, f)
	for _, path := range []string{"/api/mux/tabs/1/move", "/api/mux/groups/w1/move"} {
		rec := serve(h, apiRequest(http.MethodPost, path, `{"index":0}`))
		if _, code := replyOf(t, rec.Body.Bytes()); rec.Code != http.StatusNotImplemented || code != "unsupported" {
			t.Errorf("%s: %d %q", path, rec.Code, code)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("backend called: %q", f.calls)
	}
}

func TestMoveRoutesErrors(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{errInvalidTabID, 400, "invalid_tab_id"},
		{errInvalidGroupID, 400, "invalid_group_id"},
		{errUnknownTab, 404, "unknown_tab"},
		{errUnknownGroup, 404, "unknown_group"},
		{errInvalidIndex, 400, "invalid_index"},
		{errLinkedWorktree, 409, "linked_worktree"},
		{errUnsupported, 501, "unsupported"},
		{errors.New("tmux exploded"), 500, ""},
	} {
		f := reorderFake()
		f.err = c.err
		h := newTestHandler(t, f)
		for _, path := range []string{"/api/mux/tabs/1/move", "/api/mux/groups/w1/move"} {
			rec := serve(h, apiRequest(http.MethodPost, path, `{"index":0}`))
			msg, code := replyOf(t, rec.Body.Bytes())
			if rec.Code != c.status || code != c.code || strings.Contains(msg, "exploded") {
				t.Errorf("%s %v: %d %q %q", path, c.err, rec.Code, code, msg)
			}
		}
	}
}

// Moves run one at a time; one that waits past reorderLockWait gets 503.
func TestMoveRoutesBusy(t *testing.T) {
	orig := reorderLockWait
	t.Cleanup(func() { reorderLockWait = orig })
	reorderLockWait = 50 * time.Millisecond
	f := reorderFake()
	started, release := make(chan struct{}), make(chan struct{})
	f.move = func(context.Context) error {
		close(started)
		<-release
		return nil
	}
	h := newTestHandler(t, f)
	done := make(chan int)
	go func() {
		done <- serve(h, apiRequest(http.MethodPost, "/api/mux/tabs/1/move", `{"index":0}`)).Code
	}()
	<-started
	f.move = nil
	rec := serve(h, apiRequest(http.MethodPost, "/api/mux/groups/w1/move", `{"index":0}`))
	if _, code := replyOf(t, rec.Body.Bytes()); rec.Code != http.StatusServiceUnavailable || code != "busy" {
		t.Errorf("second move = %d %q, want 503 busy", rec.Code, code)
	}
	close(release)
	if code := <-done; code != 200 {
		t.Errorf("first move = %d", code)
	}
}

// A client leaving never cuts a move short: the backend's context outlives
// the request's.
func TestMoveRoutesOutliveTheClient(t *testing.T) {
	f := reorderFake()
	ctx, cancel := context.WithCancel(context.Background())
	var backendErr error
	f.move = func(c context.Context) error {
		cancel()
		backendErr = c.Err()
		return nil
	}
	req := apiRequest(http.MethodPost, "/api/mux/tabs/1/move", `{"index":0}`).WithContext(ctx)
	serve(newTestHandler(t, f), req)
	if len(f.calls) != 1 || backendErr != nil {
		t.Errorf("calls = %q, backend context error = %v", f.calls, backendErr)
	}
}

func TestMoveRoutesGuards(t *testing.T) {
	f := reorderFake()
	h := newTestHandler(t, f)
	for _, path := range []string{"/api/mux/tabs/1/move", "/api/mux/groups/w1/move"} {
		rec := serve(h, apiRequest(http.MethodGet, path, ""))
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "POST" {
			t.Errorf("GET %s = %d, Allow %q", path, rec.Code, rec.Header().Get("Allow"))
		}
		for _, g := range []struct {
			name   string
			mod    func(*http.Request)
			status int
		}{
			{"cross-site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
			{"foreign origin", func(r *http.Request) { r.Header.Del("Sec-Fetch-Site"); r.Header.Set("Origin", "https://evil.example") }, 403},
			{"not JSON", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
			{"unknown host", func(r *http.Request) { r.Host = "evil.example" }, 403},
			{"no auth", func(r *http.Request) { r.Header.Del("Authorization") }, 401},
		} {
			req := apiRequest(http.MethodPost, path, `{"index":0}`)
			g.mod(req)
			if rec := serve(h, req); rec.Code != g.status {
				t.Errorf("%s %s: %d, want %d", g.name, path, rec.Code, g.status)
			}
		}
		big := `{"index":0,"x":"` + strings.Repeat("a", maxJSONBody) + `"}`
		if rec := serve(h, apiRequest(http.MethodPost, path, big)); rec.Code != http.StatusBadRequest {
			t.Errorf("large body %s: %d", path, rec.Code)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("backend called: %q", f.calls)
	}
}

// A tab close or rename passes its key on; without one the routes behave
// as before keys.
func TestTabRoutesPassTheKey(t *testing.T) {
	f := &fakeMux{}
	h := newTestHandler(t, f)
	for _, req := range []*http.Request{
		apiRequest(http.MethodDelete, "/api/mux/tabs/3?key=%407", ""),
		apiRequest(http.MethodPatch, "/api/mux/tabs/3", `{"name":"x","key":"@7"}`),
		apiRequest(http.MethodDelete, "/api/mux/tabs/3", ""),
	} {
		if rec := serve(h, req); rec.Code != 200 {
			t.Errorf("%s %s = %d", req.Method, req.URL, rec.Code)
		}
	}
	if want := "close 3 key @7|rename 3=x key @7|close 3"; strings.Join(f.calls, "|") != want {
		t.Errorf("calls = %q, want %q", f.calls, want)
	}
	f.err = errTabChanged
	rec := serve(h, apiRequest(http.MethodDelete, "/api/mux/tabs/3?key=%407", ""))
	if _, code := replyOf(t, rec.Body.Bytes()); rec.Code != http.StatusConflict || code != "changed" {
		t.Errorf("stale close = %d %q", rec.Code, code)
	}
}
