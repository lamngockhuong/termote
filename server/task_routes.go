package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
)

// registerUserTaskRoutes mounts /api/mux/tasks and /api/mux/tasks/{id}, the
// tasks the user defined. store is nil when the state dir cannot hold them;
// the routes then answer 503 tasks_unavailable. Only a full client reads
// them (a command can hold a token or a path) or changes them, same-site.
func registerUserTaskRoutes(mux *http.ServeMux, store *taskStore, allowed hostAllowlist) {
	mux.HandleFunc("/api/mux/tasks", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// writeGuard lets GETs by: another site's page gets nothing.
			if msg := crossSiteRejection(allowed, r); msg != "" {
				jsonError(w, msg, http.StatusForbidden)
				return
			}
			if !requireWriteRole(w, r) {
				return
			}
			if store == nil {
				writeTaskError(w, errTasksUnavailable)
				return
			}
			list, readOnly := store.tasks()
			jsonOK(w, map[string]any{"tasks": list, "readOnly": readOnly})
		case http.MethodPost:
			var in taskInput
			if !requireWriteRole(w, r) || !decodeTaskBody(w, r, &in) {
				return
			}
			if store == nil {
				writeTaskError(w, errTasksUnavailable)
				return
			}
			t, err := store.create(in)
			if err != nil {
				writeTaskError(w, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{"task": t})
		default:
			w.Header().Set("Allow", "GET, POST")
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/mux/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "PUT, DELETE")
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !requireWriteRole(w, r) {
			return
		}
		var body struct {
			taskInput
			Updated string `json:"updated"`
		}
		if r.Method == http.MethodPut && !decodeTaskBody(w, r, &body) {
			return
		}
		if store == nil {
			writeTaskError(w, errTasksUnavailable)
			return
		}
		id := r.PathValue("id")
		if !validTemplateID(id) {
			writeTaskError(w, errTaskNotFound)
			return
		}
		if r.Method == http.MethodDelete {
			if err := store.remove(id, r.URL.Query().Get("updated")); err != nil {
				writeTaskError(w, err)
				return
			}
			jsonOK(w, map[string]bool{"ok": true})
			return
		}
		t, err := store.update(id, body.taskInput, body.Updated)
		if err != nil {
			writeTaskError(w, err)
			return
		}
		jsonOK(w, map[string]any{"task": t})
	})
}

// decodeTaskBody reads a JSON body of at most taskBody bytes into v: a
// larger one is 413 too_large, anything unreadable 400.
func decodeTaskBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, taskBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			writeTaskError(w, errTasksTooLarge)
		} else {
			jsonError(w, "invalid JSON body", http.StatusBadRequest)
		}
		return false
	}
	return true
}

// writeTaskError answers a codedError with its code, a conflict with the
// task as it is now, an input error with the field it names, and anything
// else (a failed read or save) with a generic 500, logged: no OS text or
// path reaches the client.
func writeTaskError(w http.ResponseWriter, err error) {
	var (
		conflict *taskConflict
		input    *taskInputError
		ce       *codedError
	)
	body := map[string]any{}
	var status int
	switch {
	case errors.As(err, &conflict):
		body["code"], body["error"], status = conflict.code, conflict.msg, conflict.status
		body["task"] = conflict.task
	case errors.As(err, &input):
		body["code"], body["error"], body["field"], status = input.code, input.msg, input.field, input.status
	case errors.As(err, &ce):
		body["code"], body["error"], status = ce.code, ce.msg, ce.status
	default:
		log.Printf("tasks: %v", err)
		jsonError(w, "could not save the tasks", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}
