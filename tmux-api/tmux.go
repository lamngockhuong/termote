package main

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

var tmuxSocket = os.Getenv("TMUX_SOCKET")

// validTmuxID matches safe tmux target identifiers (alphanumeric, underscore, dash, colon, dot)
var validTmuxID = regexp.MustCompile(`^[a-zA-Z0-9_\-:.]+$`)

// validateTmuxTarget checks if target is a safe tmux identifier
func validateTmuxTarget(target string) bool {
	return target != "" && len(target) <= 64 && validTmuxID.MatchString(target)
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
	out, err := tmuxCmd("list-windows", "-F",
		"#{window_index}:#{window_name}:#{window_active}").Output()
	if err != nil {
		jsonError(w, err.Error(), 500)
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
	err := tmuxCmd("select-window", "-t", id).Run()
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

func handleNew(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	name := r.URL.Query().Get("name")
	args := []string{"new-window"}
	if name != "" {
		if !validateTmuxTarget(name) {
			jsonError(w, "invalid window name", http.StatusBadRequest)
			return
		}
		args = append(args, "-n", name)
	}
	err := tmuxCmd(args...).Run()
	if err != nil {
		jsonError(w, err.Error(), 500)
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
	err := tmuxCmd("kill-window", "-t", id).Run()
	if err != nil {
		jsonError(w, err.Error(), 500)
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
	err := tmuxCmd("rename-window", "-t", id, name).Run()
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

func handleSendKeys(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
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
	err := tmuxCmd("send-keys", "-t", body.Target, body.Keys).Run()
	if err != nil {
		jsonError(w, err.Error(), 500)
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
