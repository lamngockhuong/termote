package main

import (
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"net/url"
	"time"

	"rsc.io/qr"
)

// deviceAuth is everything paired devices need: the store, the waiting
// codes, the pairing rate limiter (apart from the password's, so mistyped
// codes never lock anyone out of signing in) and what a revoke ends.
type deviceAuth struct {
	store   *deviceStore
	codes   *pairCodes
	limiter *authRateLimiter
	tokens  *tokenStore
	hub     *streamHub
}

func newDeviceAuth(store *deviceStore, tokens *tokenStore, hub *streamHub) *deviceAuth {
	return &deviceAuth{store: store, codes: newPairCodes(), limiter: newAuthRateLimiter(), tokens: tokens, hub: hub}
}

// revoke removes a device and ends what it holds: its stream tokens, its
// open streams (a stream still opening is closed by the hub's alive check)
// and the codes it made. A request it already has running finishes.
func (d *deviceAuth) revoke(id string) error {
	if err := d.store.revoke(id); err != nil {
		return err
	}
	d.tokens.revokeDevice(id)
	d.hub.closeDevice(id)
	d.codes.dropCreator(id)
	return nil
}

// deviceCookie returns the request's device, or ok false. unknown reports a
// cookie of this store that names no device at all (revoked, made up): only
// such a cookie is cleared. One of a device of another password is kept, so
// a server run once with another password does not end the device.
func (d *deviceAuth) deviceCookie(r *http.Request) (rec deviceRecord, ok, unknown bool) {
	c, err := r.Cookie(d.store.cookie)
	if err != nil {
		return deviceRecord{}, false, false
	}
	rec, ok, stale := d.store.lookup(c.Value)
	return rec, ok, !ok && !stale
}

// hasDeviceCookie reports a cookie of this store on the request.
func (d *deviceAuth) hasDeviceCookie(r *http.Request) bool {
	_, err := r.Cookie(d.store.cookie)
	return err == nil
}

func (d *deviceAuth) setCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     d.store.cookie,
		Value:    token,
		Path:     "/",
		MaxAge:   int(deviceCookieMaxAge.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   requestIsHTTPS(r),
	})
}

func (d *deviceAuth) clearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     d.store.cookie,
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   requestIsHTTPS(r),
	})
}

// deviceView is a device as the routes list it; never its hash.
type deviceView struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Role       role      `json:"role"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
	Current    bool      `json:"current"`
}

// registerDeviceRoutes mounts /api/mux/devices*: full clients make pairing
// codes, list and revoke devices. d is nil without sign-in or a usable
// store: every route then answers 501 unsupported.
func registerDeviceRoutes(mux *http.ServeMux, d *deviceAuth, allowed hostAllowlist) {
	unsupported := func(w http.ResponseWriter) bool {
		if d == nil {
			jsonErrorCode(w, "unsupported", "pairing devices needs sign-in and a usable state dir", http.StatusNotImplemented)
			return true
		}
		return false
	}
	fail := func(w http.ResponseWriter, op string, err error) {
		var ce *codedError
		if errors.As(err, &ce) {
			jsonErrorCode(w, ce.code, ce.msg, ce.status)
			return
		}
		log.Printf("devices %s: %v", op, err)
		jsonError(w, "internal error", http.StatusInternalServerError)
	}

	mux.HandleFunc("/api/mux/devices/pair", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) || !requireWriteRole(w, r) || unsupported(w) {
			return
		}
		var body struct {
			Role string `json:"role"`
			Name string `json:"name"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		if body.Name != "" && !validDeviceName(body.Name) {
			fail(w, "pair", errInvalidName)
			return
		}
		a, _ := authFrom(r.Context())
		code, exp, err := d.codes.create(role(body.Role), body.Name, a.DeviceID)
		if err != nil {
			fail(w, "pair", err)
			return
		}
		// The link names the host this request reached, which is the one
		// the browser that asked uses. The CLI asks over 127.0.0.1 and
		// builds its own link.
		scheme := "http"
		if requestIsHTTPS(r) {
			scheme = "https"
		}
		link := (&url.URL{Scheme: scheme, Host: r.Host, Path: pairPath, RawQuery: url.Values{"code": {code}}.Encode()}).String()
		resp := map[string]any{"code": code, "expiresAt": exp.UTC(), "url": link}
		if c, err := qr.Encode(link, qr.M); err == nil {
			resp["qr"] = "data:image/png;base64," + base64.StdEncoding.EncodeToString(c.PNG())
		}
		jsonOK(w, resp)
	})

	mux.HandleFunc("/api/mux/devices", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) || !requireWriteRole(w, r) || unsupported(w) {
			return
		}
		// A read, but it names every device: another site's page gets
		// nothing (writeGuard lets GETs by).
		if msg := crossSiteRejection(allowed, r); msg != "" {
			jsonError(w, msg, http.StatusForbidden)
			return
		}
		a, _ := authFrom(r.Context())
		out := []deviceView{}
		for _, rec := range d.store.list() {
			out = append(out, deviceView{rec.ID, rec.Name, rec.Role, rec.CreatedAt, rec.LastUsedAt, rec.ID == a.DeviceID})
		}
		jsonOK(w, map[string]any{"devices": out})
	})

	mux.HandleFunc("/api/mux/devices/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodDelete) || !requireWriteRole(w, r) || unsupported(w) {
			return
		}
		if err := d.revoke(r.PathValue("id")); err != nil {
			fail(w, "revoke", err)
			return
		}
		jsonOK(w, map[string]any{"ok": true})
	})
}
