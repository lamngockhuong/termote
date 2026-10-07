package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// pushHandler builds a server whose push store lives in a temp dir; noStore
// builds one without push.
func pushHandler(t *testing.T, noStore bool) (http.Handler, *pushStore) {
	t.Helper()
	cfg := testConfig(t)
	if !noStore {
		cfg.PushDir = filepath.Join(t.TempDir(), "push")
	}
	h, _, store, err := buildServer(cfg, &fakeMux{})
	if err != nil {
		t.Fatal(err)
	}
	if (store == nil) != noStore {
		t.Fatalf("store = %v, want one: %v", store, !noStore)
	}
	return h, store
}

func subscribeBody(t *testing.T, sub pushSub) string {
	t.Helper()
	b, _ := json.Marshal(map[string]any{
		"endpoint": sub.Endpoint,
		"keys":     map[string]string{"p256dh": sub.P256dh, "auth": sub.Auth},
	})
	return string(b)
}

func TestPushRoutesSubscribe(t *testing.T) {
	h, store := pushHandler(t, false)
	sub := fcmSub(t, 1)
	rec := serve(h, apiRequest("POST", "/api/mux/push/subscribe", subscribeBody(t, sub)))
	if rec.Code != http.StatusOK || decodeBody(t, rec)["ok"] != true {
		t.Fatalf("subscribe = %d %s", rec.Code, rec.Body)
	}
	if got := store.list(); len(got) != 1 || got[0].Endpoint != sub.Endpoint {
		t.Fatalf("stored = %v", got)
	}
	// An upsert, as the PWA repeats it.
	serve(h, apiRequest("POST", "/api/mux/push/subscribe", subscribeBody(t, sub)))
	if n := len(store.list()); n != 1 {
		t.Fatalf("after a repeat: %d subscriptions", n)
	}

	del := `{"endpoint":"` + sub.Endpoint + `"}`
	rec = serve(h, apiRequest("DELETE", "/api/mux/push/subscribe", del))
	if rec.Code != http.StatusOK || len(store.list()) != 0 {
		t.Fatalf("delete = %d %s, left %d", rec.Code, rec.Body, len(store.list()))
	}
	// Unknown endpoints are no error: a device may already be gone.
	rec = serve(h, apiRequest("DELETE", "/api/mux/push/subscribe", del))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete unknown = %d %s", rec.Code, rec.Body)
	}
}

func TestPushRoutesRejects(t *testing.T) {
	h, store := pushHandler(t, false)
	good := fcmSub(t, 1)
	bad := good
	bad.Endpoint = "https://evil.test/push"
	badKeys := good
	badKeys.Auth = "AAAA"
	for _, tc := range []struct {
		name   string
		req    *http.Request
		status int
		code   string
	}{
		{"invalid endpoint", apiRequest("POST", "/api/mux/push/subscribe", subscribeBody(t, bad)), 400, "invalid_endpoint"},
		{"invalid keys", apiRequest("POST", "/api/mux/push/subscribe", subscribeBody(t, badKeys)), 400, "invalid_keys"},
		{"oversized body", apiRequest("POST", "/api/mux/push/subscribe", `{"endpoint":"`+strings.Repeat("a", 9000)+`"}`), 400, ""},
		{"GET", apiRequest("GET", "/api/mux/push/subscribe", ""), 405, ""},
		{"PUT", apiRequest("PUT", "/api/mux/push/subscribe", subscribeBody(t, good)), 405, ""},
		{"POST on key", apiRequest("POST", "/api/mux/push/key", "{}"), 405, ""},
		{"no auth", func() *http.Request {
			r := apiRequest("POST", "/api/mux/push/subscribe", subscribeBody(t, good))
			r.Header.Del("Authorization")
			return r
		}(), 401, ""},
		{"cross site", func() *http.Request {
			r := apiRequest("POST", "/api/mux/push/subscribe", subscribeBody(t, good))
			r.Header.Set("Sec-Fetch-Site", "cross-site")
			r.Header.Set("Origin", "https://evil.test")
			return r
		}(), 403, ""},
		{"not JSON", func() *http.Request {
			r := apiRequest("POST", "/api/mux/push/subscribe", subscribeBody(t, good))
			r.Header.Set("Content-Type", "text/plain")
			return r
		}(), 415, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := serve(h, tc.req)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.status, rec.Body)
			}
			if tc.code != "" {
				if got := decodeBody(t, rec)["code"]; got != tc.code {
					t.Errorf("code = %v, want %s", got, tc.code)
				}
			}
		})
	}
	if n := len(store.list()); n != 0 {
		t.Fatalf("a refused request stored %d subscriptions", n)
	}
}

func TestPushRoutesKeyAndCaps(t *testing.T) {
	h, store := pushHandler(t, false)
	sub := fcmSub(t, 1)
	serve(h, apiRequest("POST", "/api/mux/push/subscribe", subscribeBody(t, sub)))

	rec := serve(h, apiRequest("GET", "/api/mux/push/key", ""))
	body := decodeBody(t, rec)
	pub, _ := store.keys()
	if rec.Code != http.StatusOK || body["publicKey"] != pub || len(pub) != 87 || len(body) != 1 {
		t.Fatalf("key = %d %v", rec.Code, body)
	}
	rec = serve(h, apiRequest("GET", "/api/mux/snapshot", ""))
	snap := rec.Body.String()
	if !strings.Contains(snap, `"push":true`) {
		t.Errorf("snapshot caps lack push: %s", snap)
	}
	// No route returns a stored endpoint.
	for _, path := range []string{"/api/mux/push/key", "/api/mux/snapshot", "/api/mux/health"} {
		if b := serve(h, apiRequest("GET", path, "")).Body.String(); strings.Contains(b, "fcm.googleapis.com") {
			t.Errorf("%s echoes an endpoint: %s", path, b)
		}
	}
}

func TestPushRoutesWithoutStore(t *testing.T) {
	h, _ := pushHandler(t, true)
	for _, req := range []*http.Request{
		apiRequest("GET", "/api/mux/push/key", ""),
		apiRequest("POST", "/api/mux/push/subscribe", subscribeBody(t, fcmSub(t, 1))),
	} {
		rec := serve(h, req)
		if rec.Code != http.StatusServiceUnavailable || decodeBody(t, rec)["code"] != "push_unavailable" {
			t.Errorf("%s %s = %d %s", req.Method, req.URL.Path, rec.Code, rec.Body)
		}
	}
	if snap := serve(h, apiRequest("GET", "/api/mux/snapshot", "")).Body.String(); !strings.Contains(snap, `"push":false`) {
		t.Errorf("snapshot caps: %s", snap)
	}
}

// The push dir sits in the state dir, which the Files view never serves:
// a pane in the home dir cannot read the private key.
func TestPushDirDeniedToFiles(t *testing.T) {
	home := t.TempDir()
	c := &cli{goos: "linux", home: home}
	cfg := testConfig(t)
	cfg.FilesDenyDirs = filesDenyDirs(c.configDir(), c.stateDir())
	cfg.PushDir = filepath.Join(c.stateDir(), "push")
	h, _, store, err := buildServer(cfg, &filesFakeMux{dir: home, files: true})
	if err != nil || store == nil {
		t.Fatalf("buildServer: %v, store %v", err, store)
	}
	rel, _ := filepath.Rel(home, filepath.Join(cfg.PushDir, vapidFile))
	if _, err := os.Stat(filepath.Join(home, rel)); err != nil {
		t.Fatal(err)
	}
	q := url.Values{"path": {filepath.ToSlash(rel)}, "reveal": {"1"}}
	rec := serve(h, apiRequest("GET", "/api/mux/panes/0/files/content?"+q.Encode(), ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("files/content served the push key: %d %s", rec.Code, rec.Body)
	}
}

// peekMux records which read the snapshot route used.
type peekMux struct {
	fakeMux
	peeked, snapped int
}

func (p *peekMux) Snapshot(ctx context.Context) (Snapshot, error) {
	p.snapped++
	return p.fakeMux.Snapshot(ctx)
}

func (p *peekMux) peekSnapshot(ctx context.Context) (Snapshot, error) {
	p.peeked++
	return p.fakeMux.Snapshot(ctx)
}

// The service worker names a push from snapshot?peek=1, which never makes
// tmux's default session again while no page is open.
func TestSnapshotPeekCreatesNothing(t *testing.T) {
	m := &peekMux{}
	h := newTestHandler(t, m)
	if rec := serve(h, apiRequest("GET", "/api/mux/snapshot?peek=1", "")); rec.Code != http.StatusOK {
		t.Fatalf("peek = %d %s", rec.Code, rec.Body)
	}
	serve(h, apiRequest("GET", "/api/mux/snapshot", ""))
	if m.peeked != 1 || m.snapped != 1 {
		t.Fatalf("peeked %d, snapped %d", m.peeked, m.snapped)
	}
}
