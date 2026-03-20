//go:build integration

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"
	"time"
)

const testSession = "termote-test"

func setupTmux(t *testing.T) {
	t.Helper()
	// Check tmux available
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	// Kill existing test session
	exec.Command("tmux", "kill-session", "-t", testSession).Run()
	// Create test session
	if err := exec.Command("tmux", "new-session", "-d", "-s", testSession).Run(); err != nil {
		t.Fatalf("failed to create tmux session: %v", err)
	}
}

func teardownTmux(t *testing.T) {
	t.Helper()
	exec.Command("tmux", "kill-session", "-t", testSession).Run()
}

func TestIntegrationHandleWindows(t *testing.T) {
	setupTmux(t)
	defer teardownTmux(t)

	req := httptest.NewRequest("GET", "/api/tmux/windows", nil)
	rec := httptest.NewRecorder()

	handleWindows(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleWindows status = %d, want %d", rec.Code, http.StatusOK)
	}

	var resp struct {
		Windows []Window `json:"windows"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if len(resp.Windows) == 0 {
		t.Error("handleWindows returned no windows")
	}
}

func TestIntegrationHandleNew(t *testing.T) {
	setupTmux(t)
	defer teardownTmux(t)

	// Create new window
	req := httptest.NewRequest("POST", "/api/tmux/new?name=testwin", nil)
	rec := httptest.NewRecorder()

	handleNew(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleNew status = %d, want %d, body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	// Verify window exists
	req = httptest.NewRequest("GET", "/api/tmux/windows", nil)
	rec = httptest.NewRecorder()
	handleWindows(rec, req)

	var resp struct {
		Windows []Window `json:"windows"`
	}
	json.NewDecoder(rec.Body).Decode(&resp)

	found := false
	for _, w := range resp.Windows {
		if w.Name == "testwin" {
			found = true
			break
		}
	}
	if !found {
		t.Error("new window 'testwin' not found")
	}
}

func TestIntegrationHandleSelect(t *testing.T) {
	setupTmux(t)
	defer teardownTmux(t)

	// Create second window
	exec.Command("tmux", "new-window", "-t", testSession).Run()
	time.Sleep(100 * time.Millisecond)

	// Select window 0
	req := httptest.NewRequest("POST", "/api/tmux/select/0", nil)
	rec := httptest.NewRecorder()

	handleSelect(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleSelect status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestIntegrationHandleRename(t *testing.T) {
	setupTmux(t)
	defer teardownTmux(t)

	// Rename window 0
	req := httptest.NewRequest("POST", "/api/tmux/rename/0?name=renamed", nil)
	rec := httptest.NewRecorder()

	handleRename(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleRename status = %d, want %d", rec.Code, http.StatusOK)
	}

	// Verify rename
	req = httptest.NewRequest("GET", "/api/tmux/windows", nil)
	rec = httptest.NewRecorder()
	handleWindows(rec, req)

	var resp struct {
		Windows []Window `json:"windows"`
	}
	json.NewDecoder(rec.Body).Decode(&resp)

	found := false
	for _, w := range resp.Windows {
		if w.Name == "renamed" {
			found = true
			break
		}
	}
	if !found {
		t.Error("renamed window not found")
	}
}

func TestIntegrationHandleSendKeys(t *testing.T) {
	setupTmux(t)
	defer teardownTmux(t)

	body, _ := json.Marshal(map[string]string{
		"target": testSession + ":0",
		"keys":   "echo hello",
	})

	req := httptest.NewRequest("POST", "/api/tmux/send-keys", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handleSendKeys(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleSendKeys status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestIntegrationHandleKill(t *testing.T) {
	setupTmux(t)
	defer teardownTmux(t)

	// Create extra window to kill
	exec.Command("tmux", "new-window", "-t", testSession, "-n", "tokill").Run()
	time.Sleep(100 * time.Millisecond)

	// Get window count before
	req := httptest.NewRequest("GET", "/api/tmux/windows", nil)
	rec := httptest.NewRecorder()
	handleWindows(rec, req)
	var before struct {
		Windows []Window `json:"windows"`
	}
	json.NewDecoder(rec.Body).Decode(&before)

	// Kill window 1
	req = httptest.NewRequest("DELETE", "/api/tmux/kill/1", nil)
	rec = httptest.NewRecorder()

	handleKill(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("handleKill status = %d, want %d", rec.Code, http.StatusOK)
	}

	// Verify window count decreased
	time.Sleep(100 * time.Millisecond)
	req = httptest.NewRequest("GET", "/api/tmux/windows", nil)
	rec = httptest.NewRecorder()
	handleWindows(rec, req)
	var after struct {
		Windows []Window `json:"windows"`
	}
	json.NewDecoder(rec.Body).Decode(&after)

	if len(after.Windows) >= len(before.Windows) {
		t.Error("window was not killed")
	}
}

func TestIntegrationFullWorkflow(t *testing.T) {
	setupTmux(t)
	defer teardownTmux(t)

	// 1. List windows
	req := httptest.NewRequest("GET", "/api/tmux/windows", nil)
	rec := httptest.NewRecorder()
	handleWindows(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatal("list windows failed")
	}

	// 2. Create window
	req = httptest.NewRequest("POST", "/api/tmux/new?name=workflow", nil)
	rec = httptest.NewRecorder()
	handleNew(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatal("create window failed")
	}

	// 3. Send keys
	body, _ := json.Marshal(map[string]string{
		"target": testSession + ":workflow",
		"keys":   "pwd",
	})
	req = httptest.NewRequest("POST", "/api/tmux/send-keys", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handleSendKeys(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatal("send keys failed")
	}

	// 4. Rename window
	req = httptest.NewRequest("POST", "/api/tmux/rename/1?name=done", nil)
	rec = httptest.NewRecorder()
	handleRename(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatal("rename failed")
	}

	// 5. Kill window
	req = httptest.NewRequest("DELETE", "/api/tmux/kill/1", nil)
	rec = httptest.NewRecorder()
	handleKill(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatal("kill failed")
	}

	t.Log("full workflow passed")
}
