package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"time"
)

// registerSettingsProposalRoutes: the CLI posts a proposal over the local
// socket; every device reads it. See the settings proposal entry of
// docs/security-invariants.md.
func registerSettingsProposalRoutes(mux *http.ServeMux, store *settingsProposals, allowed hostAllowlist) {
	mux.HandleFunc(settingsProposalRoute, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			getSettingsProposal(w, r, store, allowed)
		case http.MethodPost:
			postSettingsProposal(w, r, store)
		default:
			w.Header().Set("Allow", "GET, POST")
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// postSettingsProposal: the CLI over the local socket only, with or
// without sign-in. Only this OS user's processes open that socket (it
// signs in as the password would), so writeGuard and requireWriteRole have
// nothing to add; TCP and the machine bridge get 403 whoever signed in.
func postSettingsProposal(w http.ResponseWriter, r *http.Request, store *settingsProposals) {
	if !isLocalSocket(r.Context()) {
		jsonErrorCode(w, "cli_only", "only the termote CLI on this machine can propose settings", http.StatusForbidden)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSettingsProposal))
	if err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			jsonErrorCode(w, "too_large", "the proposal is too large", http.StatusRequestEntityTooLarge)
		} else {
			jsonError(w, "invalid body", http.StatusBadRequest)
		}
		return
	}
	values, problems := validateSettingsProposal(raw)
	if problems != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{"code": "invalid_settings", "error": "the proposal is not valid", "problems": problems})
		return
	}
	p := store.put(values)
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	// Names only: a value (a font, a folder) says nothing the log needs.
	auditf("settings_proposed", "id", p.ID, "keys", keys)
	jsonOK(w, map[string]any{"id": p.ID, "expiresAt": p.ExpiresAt.UTC().Format(time.RFC3339), "count": len(values)})
}

// getSettingsProposal: any role reads it (a view-only device applies its
// own settings too); another site's page gets nothing.
func getSettingsProposal(w http.ResponseWriter, r *http.Request, store *settingsProposals, allowed hostAllowlist) {
	if msg := crossSiteRejection(allowed, r); msg != "" {
		jsonError(w, msg, http.StatusForbidden)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	p := store.get()
	if p == nil {
		jsonErrorCode(w, "not_found", "no settings proposal", http.StatusNotFound)
		return
	}
	jsonOK(w, map[string]any{"id": p.ID, "values": p.Values, "expiresAt": p.ExpiresAt.UTC().Format(time.RFC3339)})
}
