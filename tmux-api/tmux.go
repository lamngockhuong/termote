package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

var tmuxSocket = os.Getenv("TMUX_SOCKET")
var tmuxSession = envOr("TMUX_SESSION", "main")

func init() {
	if !validateTmuxTarget(tmuxSession) {
		log.Fatalf("invalid TMUX_SESSION value: %q", tmuxSession)
	}
}

// invalidTmuxChars matches control characters and null bytes that should be blocked
// tmux supports Unicode and spaces; Go's exec.Command is safe from shell injection
var invalidTmuxChars = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// validateTmuxTarget checks if target is a safe tmux identifier
// Allows Unicode, spaces, and printable chars; blocks control chars and empty/too-long strings
func validateTmuxTarget(target string) bool {
	return target != "" && len(target) <= 64 && !invalidTmuxChars.MatchString(target)
}

// tmuxError logs a tmux command error and writes a generic JSON error response.
func tmuxError(w http.ResponseWriter, op string, err error) {
	log.Printf("tmux %s error: %v", op, err)
	jsonError(w, "tmux command failed", http.StatusInternalServerError)
}

// requireMethod returns true if method matches, otherwise writes 405 error
func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method != method {
		w.Header().Set("Allow", method)
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

// qualifyTarget prefixes a bare window index/name with the session name
// so that psmux (and tmux) can resolve it correctly.
// e.g. "0" → "main:0", "main:0" → "main:0" (unchanged)
func qualifyTarget(target string) string {
	if !strings.Contains(target, ":") {
		return tmuxSession + ":" + target
	}
	return target
}

// tmuxCmd creates a tmux command with optional socket flag
func tmuxCmd(args ...string) *exec.Cmd {
	if tmuxSocket != "" {
		args = append([]string{"-S", tmuxSocket}, args...)
	}
	return exec.Command("tmux", args...)
}

// Window represents a tmux window
type Window struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}

func handleWindows(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	out, err := tmuxCmd("list-windows", "-t", tmuxSession, "-F",
		"#{window_index}:#{window_name}:#{window_active}").Output()
	if err != nil {
		tmuxError(w, "list-windows", err)
		return
	}

	var windows []Window
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) == 3 {
			id, _ := strconv.Atoi(parts[0])
			windows = append(windows, Window{
				ID:     id,
				Name:   parts[1],
				Active: parts[2] == "1",
			})
		}
	}
	jsonOK(w, map[string]any{"windows": windows})
}

func handleSelect(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	id := lastPathSegment(r.URL.Path)
	if !validateTmuxTarget(id) {
		jsonError(w, "invalid window id", http.StatusBadRequest)
		return
	}
	err := tmuxCmd("select-window", "-t", qualifyTarget(id)).Run()
	if err != nil {
		tmuxError(w, "select-window", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

func handleNew(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	name := r.URL.Query().Get("name")
	args := []string{"new-window", "-t", tmuxSession}
	if name != "" {
		if !validateTmuxTarget(name) {
			jsonError(w, "invalid window name", http.StatusBadRequest)
			return
		}
		args = append(args, "-n", name)
	}
	err := tmuxCmd(args...).Run()
	if err != nil {
		tmuxError(w, "new-window", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

func handleKill(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "POST, DELETE")
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := lastPathSegment(r.URL.Path)
	if !validateTmuxTarget(id) {
		jsonError(w, "invalid window id", http.StatusBadRequest)
		return
	}
	err := tmuxCmd("kill-window", "-t", qualifyTarget(id)).Run()
	if err != nil {
		tmuxError(w, "kill-window", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

func handleRename(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	id := lastPathSegment(r.URL.Path)
	if !validateTmuxTarget(id) {
		jsonError(w, "invalid window id", http.StatusBadRequest)
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		jsonError(w, "name is required", http.StatusBadRequest)
		return
	}
	if !validateTmuxTarget(name) {
		jsonError(w, "invalid window name", http.StatusBadRequest)
		return
	}
	err := tmuxCmd("rename-window", "-t", qualifyTarget(id), name).Run()
	if err != nil {
		tmuxError(w, "rename-window", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

func handleSendKeys(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	// Limit request body to 8KB to prevent memory exhaustion
	r.Body = http.MaxBytesReader(w, r.Body, 8*1024)
	var body struct {
		Target string `json:"target"`
		Keys   string `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if !validateTmuxTarget(body.Target) {
		jsonError(w, "invalid target", http.StatusBadRequest)
		return
	}
	// Keys are passed as literal string to tmux send-keys, which handles escaping
	// Limit key length to prevent abuse
	if len(body.Keys) > 4096 {
		jsonError(w, "keys too long", http.StatusBadRequest)
		return
	}
	err := tmuxCmd("send-keys", "-t", qualifyTarget(body.Target), body.Keys).Run()
	if err != nil {
		tmuxError(w, "send-keys", err)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, map[string]any{"status": "ok"})
}

func jsonOK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// lastPathSegment extracts the last segment from a URL path
// e.g. "/api/tmux/select/0" → "0", "/select/0" → "0"
func lastPathSegment(path string) string {
	path = strings.TrimSuffix(path, "/")
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[i+1:]
	}
	return path
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
