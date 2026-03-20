package main

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

var tmuxSocket = os.Getenv("TMUX_SOCKET")

// tmuxCmd creates a tmux command with optional socket flag
func tmuxCmd(args ...string) *exec.Cmd {
	if tmuxSocket != "" {
		args = append([]string{"-S", tmuxSocket}, args...)
	}
	return exec.Command("tmux", args...)
}

type Window struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}

func main() {
	http.HandleFunc("/windows", handleWindows)
	http.HandleFunc("/select/", handleSelect)
	http.HandleFunc("/new", handleNew)
	http.HandleFunc("/kill/", handleKill)
	http.HandleFunc("/send-keys", handleSendKeys)
	http.HandleFunc("/health", handleHealth)

	http.ListenAndServe(":7682", nil)
}

func handleWindows(w http.ResponseWriter, r *http.Request) {
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
	id := strings.TrimPrefix(r.URL.Path, "/select/")
	err := tmuxCmd("select-window", "-t", id).Run()
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

func handleNew(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	args := []string{"new-window"}
	if name != "" {
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
	id := strings.TrimPrefix(r.URL.Path, "/kill/")
	err := tmuxCmd("kill-window", "-t", id).Run()
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}

func handleSendKeys(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Target string `json:"target"`
		Keys   string `json:"keys"`
	}
	json.NewDecoder(r.Body).Decode(&body)
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

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
