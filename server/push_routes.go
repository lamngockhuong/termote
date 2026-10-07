package main

import (
	"errors"
	"log"
	"net/http"
)

var errPushUnavailable = &codedError{"push_unavailable", "push notifications are not available on this server", http.StatusServiceUnavailable}

// registerPushRoutes mounts /api/mux/push/*. store is nil when the server
// cannot send Web Push; the routes then answer 503 push_unavailable. No
// route lists the subscriptions or echoes an endpoint: an endpoint is the
// capability to notify that device.
func registerPushRoutes(mux *http.ServeMux, store *pushStore) {
	mux.HandleFunc("/api/mux/push/key", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		if store == nil {
			pushError(w, errPushUnavailable)
			return
		}
		pub, _ := store.keys()
		jsonOK(w, map[string]string{"publicKey": pub})
	})
	mux.HandleFunc("/api/mux/push/subscribe", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "POST, DELETE")
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !requireWriteRole(w, r) {
			return
		}
		var body struct {
			Endpoint string `json:"endpoint"`
			Keys     struct {
				P256dh string `json:"p256dh"`
				Auth   string `json:"auth"`
			} `json:"keys"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		if store == nil {
			pushError(w, errPushUnavailable)
			return
		}
		var err error
		if r.Method == http.MethodPost {
			err = store.add(pushSub{Endpoint: body.Endpoint, P256dh: body.Keys.P256dh, Auth: body.Keys.Auth})
		} else {
			err = store.remove(body.Endpoint)
		}
		if err != nil {
			pushError(w, err)
			return
		}
		jsonOK(w, map[string]bool{"ok": true})
	})
}

// pushError answers a codedError as it is, anything else (a failed save)
// with a generic 500, logged.
func pushError(w http.ResponseWriter, err error) {
	var ce *codedError
	if errors.As(err, &ce) {
		jsonErrorCode(w, ce.code, ce.msg, ce.status)
		return
	}
	log.Printf("push subscriptions: %v", err)
	jsonError(w, "could not save the subscription", http.StatusInternalServerError)
}
