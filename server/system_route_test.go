package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestSystemRoute(t *testing.T) {
	h := newTestHandler(t, &fakeMux{})
	rec := serve(h, apiRequest("GET", "/api/mux/system", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: %d %s", rec.Code, rec.Body)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"scope", "cpu", "load", "memory", "swap", "disks", "battery", "sampledAt", "history"} {
		if _, ok := body[k]; !ok {
			t.Errorf("no %q in %s", k, rec.Body)
		}
	}
	if home, err := os.UserHomeDir(); err == nil && strings.Contains(rec.Body.String(), home) {
		t.Errorf("answer names the home dir: %s", rec.Body)
	}

	rec = serve(h, apiRequest("POST", "/api/mux/system", "{}"))
	if rec.Code != http.StatusMethodNotAllowed || !strings.Contains(rec.Header().Get("Content-Type"), "json") {
		t.Errorf("POST: %d %s", rec.Code, rec.Body)
	}

	req := apiRequest("GET", "/api/mux/system", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("cross-site: %d", rec.Code)
	}
	req = apiRequest("GET", "/api/mux/system", "")
	req.Header.Set("Origin", "https://evil.example")
	if rec := serve(h, req); rec.Code != http.StatusForbidden {
		t.Errorf("foreign origin: %d", rec.Code)
	}

	req = apiRequest("GET", "/api/mux/system", "")
	req.Header.Del("Authorization")
	if rec := serve(h, req); rec.Code != http.StatusUnauthorized {
		t.Errorf("without sign-in: %d", rec.Code)
	}
}

// A view-only device reads the host stats, by design.
func TestSystemRouteViewOnly(t *testing.T) {
	h, _ := newRoleHandler(t, &fakeMux{}, true)
	rec := serve(h, viewRequest("GET", "/api/mux/system", ""))
	if rec.Code != http.StatusOK {
		t.Errorf("view-only GET: %d %s", rec.Code, rec.Body)
	}
}
