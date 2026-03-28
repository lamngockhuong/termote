package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateTmuxTarget(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		// Valid targets
		{"main", true},
		{"0", true},
		{"session:window", true},
		{"my-session", true},
		{"my_session", true},
		{"session.pane", true},
		{"Session123", true},

		// Invalid targets
		{"", false},
		{"$(whoami)", false},
		{"; rm -rf /", false},
		{"session`id`", false},
		{"session|cat", false},
		{"session&echo", false},
		{"session\nid", false},
		{"session name", false}, // space not allowed
		{string(make([]byte, 65)), false}, // too long
	}

	for _, tt := range tests {
		got := validateTmuxTarget(tt.input)
		if got != tt.want {
			t.Errorf("validateTmuxTarget(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestQualifyTarget(t *testing.T) {
	// Save and restore original
	orig := tmuxSession
	defer func() { tmuxSession = orig }()

	tmuxSession = "main"
	tests := []struct {
		input string
		want  string
	}{
		{"0", "main:0"},
		{"1", "main:1"},
		{"my-window", "main:my-window"},
		{"main:0", "main:0"},       // already qualified, unchanged
		{"other:0", "other:0"},     // different session prefix, unchanged
		{"sess:win:extra", "sess:win:extra"}, // multiple colons, unchanged
	}

	for _, tt := range tests {
		got := qualifyTarget(tt.input)
		if got != tt.want {
			t.Errorf("qualifyTarget(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}

	// Test with custom session name
	tmuxSession = "custom"
	if got := qualifyTarget("0"); got != "custom:0" {
		t.Errorf("qualifyTarget with custom session: got %q, want %q", got, "custom:0")
	}
}

func TestLastPathSegment(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/api/tmux/select/0", "0"},
		{"/api/tmux/kill/main", "main"},
		{"/select/session:0", "session:0"},
		{"/path/with/trailing/", "trailing"},
		{"single", "single"},
		{"/", ""},
	}

	for _, tt := range tests {
		got := lastPathSegment(tt.path)
		if got != tt.want {
			t.Errorf("lastPathSegment(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestRequireMethod(t *testing.T) {
	tests := []struct {
		reqMethod  string
		wantMethod string
		wantOK     bool
		wantCode   int
	}{
		{"GET", "GET", true, 0},
		{"POST", "POST", true, 0},
		{"GET", "POST", false, http.StatusMethodNotAllowed},
		{"POST", "GET", false, http.StatusMethodNotAllowed},
	}

	for _, tt := range tests {
		req := httptest.NewRequest(tt.reqMethod, "/test", nil)
		rec := httptest.NewRecorder()

		got := requireMethod(rec, req, tt.wantMethod)
		if got != tt.wantOK {
			t.Errorf("requireMethod(%s, %s) = %v, want %v", tt.reqMethod, tt.wantMethod, got, tt.wantOK)
		}
		if !tt.wantOK && rec.Code != tt.wantCode {
			t.Errorf("requireMethod(%s, %s) code = %d, want %d", tt.reqMethod, tt.wantMethod, rec.Code, tt.wantCode)
		}
	}
}

func TestHandleHealth(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/tmux/health", nil)
	rec := httptest.NewRecorder()

	handleHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleHealth status = %d, want %d", rec.Code, http.StatusOK)
	}

	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["status"] != "ok" {
		t.Errorf("handleHealth response = %v, want status=ok", resp)
	}
}

func TestHandleSelectMethodValidation(t *testing.T) {
	// GET should be rejected
	req := httptest.NewRequest("GET", "/api/tmux/select/0", nil)
	rec := httptest.NewRecorder()

	handleSelect(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("handleSelect(GET) status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleSelectInvalidID(t *testing.T) {
	// POST with injection attempt
	req := httptest.NewRequest("POST", "/api/tmux/select/$(whoami)", nil)
	rec := httptest.NewRecorder()

	handleSelect(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("handleSelect(injection) status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleKillMethodValidation(t *testing.T) {
	// GET should be rejected (CSRF protection)
	req := httptest.NewRequest("GET", "/api/tmux/kill/0", nil)
	rec := httptest.NewRecorder()

	handleKill(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("handleKill(GET) status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}

	// DELETE should be allowed (use invalid target to avoid killing real windows)
	req = httptest.NewRequest("DELETE", "/api/tmux/kill/nonexistent-test-window-99", nil)
	rec = httptest.NewRecorder()

	handleKill(rec, req)

	// Will fail because window doesn't exist, but should not be 405
	if rec.Code == http.StatusMethodNotAllowed {
		t.Error("handleKill(DELETE) should allow DELETE method")
	}
}

func TestHandleSendKeysValidation(t *testing.T) {
	tests := []struct {
		name     string
		method   string
		body     any
		wantCode int
	}{
		{"wrong method", "GET", nil, http.StatusMethodNotAllowed},
		{"invalid json", "POST", "not json", http.StatusBadRequest},
		{"invalid target", "POST", map[string]string{"target": "$(id)", "keys": "test"}, http.StatusBadRequest},
		{"keys too long", "POST", map[string]string{"target": "main", "keys": string(make([]byte, 5000))}, http.StatusBadRequest},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body []byte
			if tt.body != nil {
				if s, ok := tt.body.(string); ok {
					body = []byte(s)
				} else {
					body, _ = json.Marshal(tt.body)
				}
			}

			req := httptest.NewRequest(tt.method, "/api/tmux/send-keys", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handleSendKeys(rec, req)

			if rec.Code != tt.wantCode {
				t.Errorf("handleSendKeys(%s) status = %d, want %d", tt.name, rec.Code, tt.wantCode)
			}
		})
	}
}

func TestHandleNewMethodValidation(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/tmux/new", nil)
	rec := httptest.NewRecorder()

	handleNew(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("handleNew(GET) status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleRenameValidation(t *testing.T) {
	// Wrong method
	req := httptest.NewRequest("GET", "/api/tmux/rename/0?name=test", nil)
	rec := httptest.NewRecorder()
	handleRename(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("handleRename(GET) status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}

	// Invalid ID
	req = httptest.NewRequest("POST", "/api/tmux/rename/$(id)?name=test", nil)
	rec = httptest.NewRecorder()
	handleRename(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("handleRename(invalid id) status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	// Missing name parameter
	req = httptest.NewRequest("POST", "/api/tmux/rename/0", nil)
	rec = httptest.NewRecorder()
	handleRename(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("handleRename(no name) status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	// Invalid name
	req = httptest.NewRequest("POST", "/api/tmux/rename/0?name=$(id)", nil)
	rec = httptest.NewRecorder()
	handleRename(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("handleRename(invalid name) status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleWindowsMethodValidation(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/tmux/windows", nil)
	rec := httptest.NewRecorder()

	handleWindows(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("handleWindows(POST) status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleNewInvalidName(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/tmux/new?name=$(whoami)", nil)
	rec := httptest.NewRecorder()

	handleNew(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("handleNew(invalid name) status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleKillInvalidID(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/tmux/kill/$(id)", nil)
	rec := httptest.NewRecorder()

	handleKill(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("handleKill(invalid id) status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestJsonOK(t *testing.T) {
	rec := httptest.NewRecorder()
	jsonOK(rec, map[string]string{"status": "ok"})

	if rec.Header().Get("Content-Type") != "application/json" {
		t.Error("jsonOK should set Content-Type to application/json")
	}

	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["status"] != "ok" {
		t.Errorf("jsonOK response = %v, want status=ok", resp)
	}
}

func TestJsonError(t *testing.T) {
	rec := httptest.NewRecorder()
	jsonError(rec, "test error", http.StatusBadRequest)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("jsonError status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if rec.Header().Get("Content-Type") != "application/json" {
		t.Error("jsonError should set Content-Type to application/json")
	}

	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["error"] != "test error" {
		t.Errorf("jsonError response = %v, want error=test error", resp)
	}
}

func TestTmuxError(t *testing.T) {
	rec := httptest.NewRecorder()
	tmuxError(rec, "test-op", fmt.Errorf("some internal detail"))

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("tmuxError status = %d, want 500", rec.Code)
	}

	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["error"] != "tmux command failed" {
		t.Errorf("tmuxError response = %q, want generic message", resp["error"])
	}
	// Must NOT leak internal error details
	body := rec.Body.String()
	if bytes.Contains([]byte(body), []byte("internal detail")) {
		t.Error("tmuxError leaked internal error to client")
	}
}

func TestSendKeysBodyLimit(t *testing.T) {
	// 8KB+ body should be rejected by MaxBytesReader
	largeBody := `{"target":"main","keys":"` + strings.Repeat("x", 9000) + `"}`
	req := httptest.NewRequest("POST", "/api/tmux/send-keys", bytes.NewReader([]byte(largeBody)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handleSendKeys(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("oversized body: got %d, want 400", rec.Code)
	}
}

func TestTmuxCmd(t *testing.T) {
	// Without socket
	cmd := tmuxCmd("list-windows")
	if cmd.Path == "" {
		t.Error("tmuxCmd should create a command")
	}

	// Verify args
	args := cmd.Args
	if args[0] != "tmux" || args[1] != "list-windows" {
		t.Errorf("tmuxCmd args = %v, want [tmux list-windows]", args)
	}
}

func TestTmuxCmdWithSocket(t *testing.T) {
	// Save and restore original
	orig := tmuxSocket
	defer func() { tmuxSocket = orig }()

	tmuxSocket = "/tmp/test.sock"
	cmd := tmuxCmd("list-windows")

	args := cmd.Args
	// Should have: tmux -S /tmp/test.sock list-windows
	if len(args) < 4 || args[1] != "-S" || args[2] != "/tmp/test.sock" {
		t.Errorf("tmuxCmd with socket args = %v, want [-S /tmp/test.sock ...]", args)
	}
}
