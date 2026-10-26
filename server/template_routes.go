package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
)

// registerTemplateRoutes mounts /api/mux/templates*. store is nil when the
// state dir cannot hold them; the routes then answer 503
// templates_unavailable. Every role reads them (same-site only, as they may
// name a project); a full client changes them.
func registerTemplateRoutes(mux *http.ServeMux, store *templateStore, allowed hostAllowlist) {
	mux.HandleFunc("/api/mux/templates", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// A read, but what a user saves: another site's page gets
			// nothing (writeGuard lets GETs by).
			if msg := crossSiteRejection(allowed, r); msg != "" {
				jsonError(w, msg, http.StatusForbidden)
				return
			}
			if store == nil {
				writeTemplateError(w, errTemplatesUnavailable)
				return
			}
			list, readOnly := store.templates()
			jsonOK(w, map[string]any{"templates": list, "readOnly": readOnly})
		case http.MethodPost:
			var in templateInput
			if !requireWriteRole(w, r) || !decodeTemplateBody(w, r, templateBody, &in) {
				return
			}
			if store == nil {
				writeTemplateError(w, errTemplatesUnavailable)
				return
			}
			t, err := store.create(in)
			if err != nil {
				writeTemplateError(w, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{"template": t})
		default:
			w.Header().Set("Allow", "GET, POST")
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/mux/templates/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "PUT, DELETE")
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !requireWriteRole(w, r) {
			return
		}
		var body struct {
			templateInput
			Updated string `json:"updated"`
		}
		if r.Method == http.MethodPut && !decodeTemplateBody(w, r, templateBody, &body) {
			return
		}
		if store == nil {
			writeTemplateError(w, errTemplatesUnavailable)
			return
		}
		id := r.PathValue("id")
		if !validTemplateID(id) {
			writeTemplateError(w, errTemplateNotFound)
			return
		}
		if r.Method == http.MethodDelete {
			if err := store.remove(id, r.URL.Query().Get("updated")); err != nil {
				writeTemplateError(w, err)
				return
			}
			jsonOK(w, map[string]bool{"ok": true})
			return
		}
		t, err := store.update(id, body.templateInput, body.Updated)
		if err != nil {
			writeTemplateError(w, err)
			return
		}
		jsonOK(w, map[string]any{"template": t})
	})

	mux.HandleFunc("/api/mux/templates/import", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) {
			return
		}
		var body struct {
			Templates []templateInput `json:"templates"`
			Replace   []string        `json:"replace"`
		}
		if !decodeTemplateBody(w, r, templateImportBody, &body) {
			return
		}
		if store == nil {
			writeTemplateError(w, errTemplatesUnavailable)
			return
		}
		if r.URL.Query().Get("dryRun") == "1" {
			added, replaced, err := store.preview(body.Templates)
			if err != nil {
				writeTemplateError(w, err)
				return
			}
			jsonOK(w, map[string]any{"added": added, "replaced": replaced})
			return
		}
		added, replaced, err := store.importAll(body.Templates, body.Replace)
		if err != nil {
			writeTemplateError(w, err)
			return
		}
		jsonOK(w, map[string]int{"added": added, "replaced": replaced})
	})
}

// decodeTemplateBody reads a JSON body of at most limit bytes into v: a
// larger one is 413 too_large, anything unreadable 400.
func decodeTemplateBody(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			writeTemplateError(w, errTemplatesTooLarge)
		} else {
			jsonError(w, "invalid JSON body", http.StatusBadRequest)
		}
		return false
	}
	return true
}

// writeTemplateError answers a codedError with its code, a conflict with
// the template as it is now, an input error with what it names, and
// anything else (a failed read or save) with a generic 500, logged: no OS
// text or path reaches the client.
func writeTemplateError(w http.ResponseWriter, err error) {
	var (
		conflict *templateConflict
		input    *templateInputError
		ce       *codedError
	)
	body := map[string]any{}
	var status int
	switch {
	case errors.As(err, &conflict):
		body["code"], body["error"], status = conflict.code, conflict.msg, conflict.status
		body["template"] = conflict.template
	case errors.As(err, &input):
		body["code"], body["error"], status = input.code, input.msg, input.status
		if input.field != "" {
			body["field"] = input.field
		}
		if input.index >= 0 {
			body["index"] = input.index
		}
	case errors.As(err, &ce):
		body["code"], body["error"], status = ce.code, ce.msg, ce.status
	default:
		log.Printf("templates: %v", err)
		jsonError(w, "could not save the templates", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}
