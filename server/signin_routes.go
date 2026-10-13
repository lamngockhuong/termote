package main

import (
	"log"
	"net/http"
)

var (
	errUnknownSession = &codedError{code: "unknown_session", msg: "no such sign-in", status: http.StatusNotFound}
	// errSessionDevicesKept: the browser is signed out, but the devices it
	// paired could not be removed from the disk.
	errSessionDevicesKept = &codedError{code: "devices_not_revoked", msg: "signed out, but the devices it paired are still paired; revoke them with termote devices revoke <id>", status: http.StatusInternalServerError}
)

// registerSigninRoutes mounts /api/mux/signins*: the password sessions
// (browsers signed in with the sign-in form or Basic auth), listed and
// revoked. s is nil without sign-in: every route then answers 501
// unsupported.
//
// A full device lists them but revokes none: only the password (a session,
// Basic auth: the CLI) does, so a device lent for a while cannot sign its
// owner's browsers out. A view-only client gets 403 view_only.
//
// Revoking a session revokes the devices it paired too (and the devices
// those paired): dev is nil without a device store. Signing out (/logout)
// does not.
func registerSigninRoutes(mux *http.ServeMux, s *sessionAuth, dev *deviceAuth, allowed hostAllowlist) {
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
	// auth or over the local socket, a browser has a session by then.
	via := func(a authInfo) string {
		if isCLI(a) {
			return "cli"
		}
		return "settings"
	}
	// revokeDevices revokes what the sessions ids paired, once they are
	// gone; a failure is logged, and answered after the audit line.
	revokeDevices := func(ids []string) ([]string, error) {
		if dev == nil {
			return nil, nil
		}
		gone, err := dev.revokeSessions(ids)
		if err != nil {
			log.Printf("revoke the devices of signed out sessions: %v", err)
		}
		return gone, err
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
		gone, err := revokeDevices(ids)
		auditf("revoke-session", "id", "all", "by", auditBy(a), "via", via(a), "revoked", ids, "devices", gone)
		if err != nil {
			jsonErrorCode(w, errSessionDevicesKept.code, errSessionDevicesKept.msg, errSessionDevicesKept.status)
			return
		}
		jsonOK(w, map[string]any{"ok": true, "revoked": len(ids), "devices": len(gone)})
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
		// A session gone already (a restart, Log out, its 24 hours, a
		// revoke whose devices could not be removed) still revokes the
		// devices it paired; with none it is unknown.
		signedOut := s.revoke(id)
		if !signedOut && (dev == nil || !deviceIDRe.MatchString(id)) {
			jsonErrorCode(w, errUnknownSession.code, errUnknownSession.msg, errUnknownSession.status)
			return
		}
		gone, err := revokeDevices([]string{id})
		if !signedOut && err == nil && len(gone) == 0 {
			jsonErrorCode(w, errUnknownSession.code, errUnknownSession.msg, errUnknownSession.status)
			return
		}
		auditf("revoke-session", "id", id, "by", auditBy(a), "via", via(a), "signedOut", signedOut, "devices", gone)
		if err != nil {
			jsonErrorCode(w, errSessionDevicesKept.code, errSessionDevicesKept.msg, errSessionDevicesKept.status)
			return
		}
		jsonOK(w, map[string]any{"ok": true, "signedOut": signedOut, "devices": len(gone)})
	})
}
