package main

import (
	"net/http"
)

var errUnknownSession = &codedError{code: "unknown_session", msg: "no such sign-in", status: http.StatusNotFound}

// registerSigninRoutes mounts /api/mux/signins*: the password sessions
// (browsers signed in with the sign-in form or Basic auth), listed and
// revoked. s is nil without sign-in: every route then answers 501
// unsupported.
//
// A full device lists them but revokes none: only the password (a session,
// Basic auth: the CLI) does, so a device lent for a while cannot sign its
// owner's browsers out. A view-only client gets 403 view_only.
func registerSigninRoutes(mux *http.ServeMux, s *sessionAuth, allowed hostAllowlist) {
	unsupported := func(w http.ResponseWriter) bool {
		if s == nil {
			jsonErrorCode(w, "unsupported", "sign-ins need sign-in to be on", http.StatusNotImplemented)
			return true
		}
		return false
	}
	// canRevoke refuses a paired device.
	canRevoke := func(w http.ResponseWriter, a authInfo) bool {
		if a.Kind == authDevice {
			jsonErrorCode(w, errFullNeedsPass.code, "Only a password sign-in or the CLI can sign a browser out", errFullNeedsPass.status)
			return false
		}
		return true
	}
	// via names where a revoke came from: the CLI signs in with Basic
	// auth, a browser has a session by then.
	via := func(a authInfo) string {
		if a.Kind == authBasic {
			return "cli"
		}
		return "settings"
	}

	mux.HandleFunc("/api/mux/signins", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "GET, DELETE")
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !requireWriteRole(w, r) || unsupported(w) {
			return
		}
		a, _ := authFrom(r.Context())
		if r.Method == http.MethodGet {
			// A read, but it names every browser signed in: another
			// site's page gets nothing (writeGuard lets GETs by).
			if msg := crossSiteRejection(allowed, r); msg != "" {
				jsonError(w, msg, http.StatusForbidden)
				return
			}
			// canRevoke: the caller may sign browsers out (not a device;
			// the PWA hides the buttons, the server refuses anyway).
			jsonOK(w, map[string]any{"sessions": s.list(a.SessionID), "canRevoke": a.Kind != authDevice})
			return
		}
		if !canRevoke(w, a) {
			return
		}
		// Every session but the caller's own; the CLI (Basic auth) has
		// none, so it signs every browser out.
		ids := s.revokeOthers(a.SessionID)
		auditf("revoke-session", "id", "all", "by", auditBy(a), "via", via(a), "revoked", ids)
		jsonOK(w, map[string]any{"ok": true, "revoked": len(ids)})
	})

	mux.HandleFunc("/api/mux/signins/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodDelete) || !requireWriteRole(w, r) || unsupported(w) {
			return
		}
		a, _ := authFrom(r.Context())
		if !canRevoke(w, a) {
			return
		}
		id := r.PathValue("id")
		if !s.revoke(id) {
			jsonErrorCode(w, errUnknownSession.code, errUnknownSession.msg, errUnknownSession.status)
			return
		}
		auditf("revoke-session", "id", id, "by", auditBy(a), "via", via(a))
		jsonOK(w, map[string]any{"ok": true})
	})
}
