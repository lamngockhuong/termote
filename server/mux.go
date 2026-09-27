package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"
)

// apiVersion is bumped on every breaking change to /api/mux/*. The PWA compares
// it with its own build and reloads when they differ.
const apiVersion = 1

// muxTimeout bounds every backend call made on behalf of one HTTP request.
const muxTimeout = 5 * time.Second

// maxJSONBody caps request bodies on /api/mux/* to prevent memory exhaustion.
const maxJSONBody = 8 * 1024

// maxKeysLen caps a single send-keys payload.
const maxKeysLen = 4096

// Mux is a terminal multiplexer backend (tmux/psmux, herdr) exposed through
// the three-level model group → tab → pane.
type Mux interface {
	Name() string
	Caps() Caps
	Snapshot(ctx context.Context) (Snapshot, error)
	SelectTab(ctx context.Context, tabID string) error
	NewTab(ctx context.Context, groupID, name string) (tabID string, err error)
	CloseTab(ctx context.Context, tabID string) error
	RenameTab(ctx context.Context, tabID, name string) error
	SendKeys(ctx context.Context, paneID, keys string) error
	// Attach opens a terminal on paneID. ctx bounds only the setup; the
	// stream lives until it is closed.
	Attach(ctx context.Context, paneID string, size Size) (TermStream, error)
	Health(ctx context.Context) error
}

// Caps describes behaviour that differs between backends.
type Caps struct {
	// ClientSideSelect: switching tab only changes which pane the client
	// streams; the backend is not told (herdr).
	ClientSideSelect bool `json:"clientSideSelect"`
	// CopyMode: the backend has tmux copy mode.
	CopyMode bool `json:"copyMode"`
}

type Snapshot struct {
	APIVersion int     `json:"apiVersion"`
	Backend    string  `json:"backend"`
	Caps       Caps    `json:"caps"`
	Groups     []Group `json:"groups"`
}

// Group is a tmux session or a herdr workspace.
type Group struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Tabs []Tab  `json:"tabs"`
}

type Tab struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
	Panes  []Pane `json:"panes"`
}

type Pane struct {
	ID     string     `json:"id"`
	Active bool       `json:"active"`
	Title  string     `json:"title,omitempty"`
	Agent  *AgentInfo `json:"agent,omitempty"`
}

// AgentInfo is filled by backends that detect coding agents (herdr).
type AgentInfo struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// inputError is a client mistake; its message is safe to return verbatim.
type inputError string

func (e inputError) Error() string { return string(e) }

// errUnsupported is returned by a backend for an operation it does not offer.
var errUnsupported = errors.New("operation not supported by this backend")

// registerMuxRoutes mounts /api/mux/* for the given backend. Patterns carry no
// method so a wrong method gets a JSON 405 instead of falling through to the
// /api/ JSON 404 handler.
func registerMuxRoutes(mux *http.ServeMux, m Mux, tokens *tokenStore) {
	mux.HandleFunc("/api/mux/health", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		status := "ok"
		if err := m.Health(ctx); err != nil {
			log.Printf("%s health: %v", m.Name(), err)
			status = "degraded"
		}
		jsonOK(w, map[string]any{"status": status, "apiVersion": apiVersion, "backend": m.Name()})
	})

	mux.HandleFunc("/api/mux/snapshot", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		snap, err := m.Snapshot(ctx)
		if err != nil {
			muxError(w, m, "snapshot", err)
			return
		}
		snap.APIVersion = apiVersion
		snap.Backend = m.Name()
		snap.Caps = m.Caps()
		if snap.Groups == nil {
			snap.Groups = []Group{}
		}
		jsonOK(w, snap)
	})

	mux.HandleFunc("/api/mux/tabs", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		var body struct {
			GroupID string `json:"groupId"`
			Name    string `json:"name"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		id, err := m.NewTab(ctx, body.GroupID, body.Name)
		if err != nil {
			muxError(w, m, "new tab", err)
			return
		}
		jsonOK(w, map[string]any{"ok": true, "id": id})
	})

	mux.HandleFunc("/api/mux/tabs/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		switch r.Method {
		case http.MethodPatch:
			var body struct {
				Name string `json:"name"`
			}
			if !decodeJSON(w, r, &body) {
				return
			}
			if err := m.RenameTab(ctx, id, body.Name); err != nil {
				muxError(w, m, "rename tab", err)
				return
			}
		case http.MethodDelete:
			if err := m.CloseTab(ctx, id); err != nil {
				muxError(w, m, "close tab", err)
				return
			}
		default:
			w.Header().Set("Allow", "PATCH, DELETE")
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		jsonOK(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/mux/tabs/{id}/select", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		if err := m.SelectTab(ctx, r.PathValue("id")); err != nil {
			muxError(w, m, "select tab", err)
			return
		}
		jsonOK(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/mux/panes/{id}/keys", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		var body struct {
			Keys string `json:"keys"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		if len(body.Keys) > maxKeysLen {
			jsonError(w, "keys too long", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), muxTimeout)
		defer cancel()
		if err := m.SendKeys(ctx, r.PathValue("id"), body.Keys); err != nil {
			muxError(w, m, "send keys", err)
			return
		}
		jsonOK(w, map[string]any{"ok": true})
	})

	// Only reachable via fetch/XHR from the PWA, not by direct navigation.
	mux.HandleFunc("/api/mux/stream-token", handleTerminalToken(tokens))
}

// decodeJSON reads a size-limited JSON body into v, writing a 400 on failure.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		jsonError(w, "invalid JSON body", http.StatusBadRequest)
		return false
	}
	return true
}

// muxError maps a backend error to a response. Input errors are returned to the
// client; everything else is logged server-side and answered generically.
func muxError(w http.ResponseWriter, m Mux, op string, err error) {
	var ie inputError
	switch {
	case errors.As(err, &ie):
		jsonError(w, ie.Error(), http.StatusBadRequest)
	case errors.Is(err, errUnsupported):
		jsonError(w, errUnsupported.Error(), http.StatusNotImplemented)
	default:
		log.Printf("%s %s error: %v", m.Name(), op, err)
		jsonError(w, "mux command failed", http.StatusInternalServerError)
	}
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

func jsonOK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
