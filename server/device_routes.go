package main

import (
	"encoding/base64"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"rsc.io/qr"
)

var (
	errInvalidValidity = &codedError{code: "invalid_validity", msg: "validFor must be 0 (no limit) or 3600 to 34560000 seconds", status: http.StatusBadRequest}
	errValidityNeeded  = &codedError{code: "invalid_validity", msg: "a device with a time limit pairs devices with one too: give validFor", status: http.StatusBadRequest}
	errFullNeedsPass   = &codedError{code: "full_needs_password", msg: "Only a password sign-in or the CLI can pair a full device", status: http.StatusForbidden}
)

// deviceAuth is everything paired devices need: the store, the waiting
// codes, the pairing rate limiter (apart from the password's, so mistyped
// codes never lock anyone out of signing in) and what a revoke or an expiry
// ends.
type deviceAuth struct {
	store   *deviceStore
	codes   *pairCodes
	limiter *authRateLimiter
	tokens  *tokenStore
	hub     *streamHub

	// mu guards the expiry timer and ended. Taken under the store's lock
	// (arm, from the store's onReload), never the other way round.
	mu      sync.Mutex
	timer   *time.Timer
	timerAt time.Time // zero: no timer
	// ended holds the expired devices whose streams, tokens and codes were
	// ended, so each is ended and logged once per process.
	ended map[string]bool
}

func newDeviceAuth(store *deviceStore, tokens *tokenStore, hub *streamHub) *deviceAuth {
	d := &deviceAuth{store: store, codes: newPairCodes(), limiter: newAuthRateLimiter(), tokens: tokens, hub: hub, ended: map[string]bool{}}
	d.codes.alive = store.alive
	store.mu.Lock()
	store.onReload = d.arm
	d.arm(store.nextExpiryLocked())
	store.mu.Unlock()
	return d
}

// arm sets the expiry timer to next (zero: none). The store calls it each
// time its records change, a pairing, a revoke or another process's write.
func (d *deviceAuth) arm(next time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.timer != nil {
		d.timer.Stop()
		d.timer = nil
	}
	d.timerAt = next
	if !next.IsZero() {
		d.timer = time.AfterFunc(max(next.Sub(d.store.now()), 0), d.checkExpiry)
	}
}

// checkExpiry ends what every device past its validUntil holds, then sets
// the timer to the next one. The next limit is read and armed under the
// store's lock, like every change does: read before and armed after, it
// could undo the timer a pairing set meanwhile. A late or early firing (a
// clock change, a suspended machine) only moves when an open stream closes:
// lookup and alive check the limit on their own.
func (d *deviceAuth) checkExpiry() {
	for _, id := range d.store.expiredNow() {
		d.expire(id)
	}
	d.store.mu.Lock()
	defer d.store.mu.Unlock()
	d.arm(d.store.nextExpiryLocked())
}

// expire ends what an expired device holds, once.
func (d *deviceAuth) expire(id string) {
	d.mu.Lock()
	done := d.ended[id]
	d.ended[id] = true
	d.mu.Unlock()
	if done {
		return
	}
	d.end(id)
	auditf("device-expired", "id", id)
}

// end closes what a device holds: its stream tokens, its open streams (a
// stream still opening is closed by the hub's alive check) and the codes it
// made. A request it already has running finishes.
func (d *deviceAuth) end(id string) {
	d.tokens.revokeDevice(id)
	d.hub.closeDevice(id)
	d.codes.dropCreator(id)
}

// revoke removes one device (Log out, a device paired again) and ends what
// it holds; the devices it paired stay.
func (d *deviceAuth) revoke(id string) error {
	if err := d.store.revoke(id); err != nil {
		return err
	}
	d.end(id)
	return nil
}

// revokeCascade removes a device and every device it paired (Settings >
// Devices, `termote devices revoke`), ends what each holds and returns
// their ids, id first.
func (d *deviceAuth) revokeCascade(id string) ([]string, error) {
	ids, err := d.store.revokeCascade(id)
	if err != nil {
		return nil, err
	}
	for _, g := range ids {
		d.end(g)
	}
	return ids, nil
}

// pairValidity checks the validFor a code asks for (seconds, nil or 0: no
// limit). A device with a limit pairs only devices with one, and none that
// outlasts it; the store cuts it again when the code is used.
func (d *deviceAuth) pairValidity(a authInfo, secs *int64) (time.Duration, error) {
	var n int64
	if secs != nil {
		n = *secs
	}
	if n != 0 && (n < int64(minDeviceValidity/time.Second) || n > int64(maxDeviceValidity/time.Second)) {
		return 0, errInvalidValidity
	}
	validFor := time.Duration(n) * time.Second
	if a.Kind != authDevice {
		return validFor, nil
	}
	rec, ok := d.store.get(a.DeviceID)
	if !ok {
		return 0, errCreatorGone
	}
	if rec.ValidUntil == nil {
		return validFor, nil
	}
	if validFor == 0 {
		return 0, errValidityNeeded
	}
	left := rec.ValidUntil.Sub(d.store.now()).Round(time.Second)
	if left <= 0 {
		return 0, errCreatorGone
	}
	return min(validFor, left), nil
}

// deviceCookie returns the request's device, or ok false. unknown reports a
// cookie of this store that names no device that can sign in (revoked,
// expired, made up): only such a cookie is cleared. One of a device of
// another password is kept, so a server run once with another password does
// not end the device.
func (d *deviceAuth) deviceCookie(r *http.Request) (rec deviceRecord, ok, unknown bool) {
	c, err := r.Cookie(d.store.cookie)
	if err != nil {
		return deviceRecord{}, false, false
	}
	rec, ok, stale := d.store.lookup(c.Value)
	if !ok {
		if rec.ID != "" {
			d.expire(rec.ID)
		}
		return deviceRecord{}, false, !stale
	}
	return rec, true, false
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

// deviceView is a device as the routes list it; never its hash. ValidUntil
// is null without a limit; PairedBy is "password", "unknown" (a record from
// before it was kept) or a device id, and PairedByName that device's name
// while it is still paired.
type deviceView struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Role         role       `json:"role"`
	CreatedAt    time.Time  `json:"createdAt"`
	LastUsedAt   time.Time  `json:"lastUsedAt"`
	Current      bool       `json:"current"`
	ValidUntil   *time.Time `json:"validUntil"`
	Expired      bool       `json:"expired"`
	PairedBy     string     `json:"pairedBy"`
	PairedByName string     `json:"pairedByName,omitempty"`
}

// deviceViews lists recs as the routes show them; current is the caller's
// device id ("" for none).
func deviceViews(recs []deviceRecord, current string, now time.Time) []deviceView {
	names := map[string]string{}
	for _, rec := range recs {
		names[rec.ID] = rec.Name
	}
	out := []deviceView{}
	for _, rec := range recs {
		v := deviceView{ID: rec.ID, Name: rec.Name, Role: rec.Role, CreatedAt: rec.CreatedAt, LastUsedAt: rec.LastUsedAt,
			Current: rec.ID == current, ValidUntil: rec.ValidUntil, Expired: rec.expired(now), PairedBy: rec.PairedBy}
		switch rec.PairedBy {
		case "":
			v.PairedBy = "unknown"
		case pairedByPassword:
		default:
			v.PairedByName = names[rec.PairedBy]
		}
		out = append(out, v)
	}
	return out
}

// requestIP is the address a request came from, without its port. Behind a
// proxy (tailscale serve) it is the proxy's, loopback.
func requestIP(r *http.Request) string {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip == "" {
		ip = r.RemoteAddr
	}
	return ip
}

// auditUntil names a validUntil in an audit line.
func auditUntil(t *time.Time) string {
	if t == nil {
		return "never"
	}
	return t.UTC().Format(time.RFC3339)
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
			Role     string `json:"role"`
			Name     string `json:"name"`
			ValidFor *int64 `json:"validFor"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		if body.Name != "" && !validDeviceName(body.Name) {
			fail(w, "pair", errInvalidName)
			return
		}
		a, _ := authFrom(r.Context())
		// Only the password (a session, Basic auth: the CLI) pairs a full
		// device. basicAuth tries the device cookie before Basic auth, so a
		// request carrying both is the device's and refused here too.
		if role(body.Role) == roleFull && a.Kind == authDevice {
			fail(w, "pair", errFullNeedsPass)
			return
		}
		validFor, err := d.pairValidity(a, body.ValidFor)
		if err != nil {
			fail(w, "pair", err)
			return
		}
		code, exp, err := d.codes.create(role(body.Role), body.Name, a.DeviceID, validFor)
		if err != nil {
			fail(w, "pair", err)
			return
		}
		auditf("pair-code", "role", body.Role, "validFor", int64(validFor/time.Second), "by", auditBy(a), "ip", requestIP(r))
		// The link names the host this request reached, which is the one
		// the browser that asked uses. The CLI asks over 127.0.0.1 and
		// builds its own link.
		scheme := "http"
		if requestIsHTTPS(r) {
			scheme = "https"
		}
		link := (&url.URL{Scheme: scheme, Host: r.Host, Path: pairPath, RawQuery: url.Values{"code": {code}}.Encode()}).String()
		// expiresIn (seconds) lets a client count down without trusting
		// its own clock against expiresAt.
		// validFor (seconds, 0: no limit) is the device's, as accepted:
		// cut to what is left of the device asking.
		resp := map[string]any{"code": code, "expiresAt": exp.UTC(), "expiresIn": int(time.Until(exp).Round(time.Second).Seconds()), "url": link, "validFor": int64(validFor / time.Second)}
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
		jsonOK(w, map[string]any{"devices": deviceViews(d.store.list(), a.DeviceID, d.store.now())})
	})

	mux.HandleFunc("/api/mux/devices/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodDelete) || !requireWriteRole(w, r) || unsupported(w) {
			return
		}
		ids, err := d.revokeCascade(r.PathValue("id"))
		if err != nil {
			fail(w, "revoke", err)
			return
		}
		a, _ := authFrom(r.Context())
		// The CLI signs in with Basic auth; a browser has a session by then.
		via := "devices"
		if a.Kind == authBasic {
			via = "cli"
		}
		auditf("revoke", "id", ids[0], "by", auditBy(a), "via", via, "cascade", ids[1:])
		jsonOK(w, map[string]any{"ok": true, "revoked": ids})
	})
}
