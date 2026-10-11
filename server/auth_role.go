package main

import (
	"context"
	"net/http"
)

// role is what a signed-in client may do. full is everything; view watches
// the terminal, the Chat view and Files/Changes, and changes nothing on the
// server.
type role string

const (
	roleFull role = "full"
	roleView role = "view"
)

// authKind says how a request signed in.
type authKind int

const (
	authBasic authKind = iota + 1
	authSession
	authDevice
)

// authInfo is who basicAuth let a request through as. Basic auth and the
// sign-in session are always full; a paired device carries its own role.
type authInfo struct {
	Kind     authKind
	Role     role
	DeviceID string
	// SessionID: the password session's id (authSession only).
	SessionID string
}

// authCtxKey holds the authInfo of a request basicAuth let through.
type authCtxKey struct{}

func withAuth(ctx context.Context, a authInfo) context.Context {
	return context.WithValue(ctx, authCtxKey{}, a)
}

func authFrom(ctx context.Context) (authInfo, bool) {
	a, ok := ctx.Value(authCtxKey{}).(authInfo)
	return a, ok
}

// authenticated reports whether sign-in is on and the request passed it.
func authenticated(ctx context.Context) bool {
	_, ok := authFrom(ctx)
	return ok
}

// requestRole is the request's role: full without an identity (--no-auth,
// where whoever reaches the port has a shell anyway).
func requestRole(ctx context.Context) role {
	if a, ok := authFrom(ctx); ok && a.Role == roleView {
		return roleView
	}
	return roleFull
}

func isViewOnly(r *http.Request) bool { return requestRole(r.Context()) == roleView }

// errViewOnly is every refusal of a view-only client.
var errViewOnly = &codedError{code: "view_only", msg: "view-only device", status: http.StatusForbidden}

func writeViewOnly(w http.ResponseWriter) {
	jsonErrorCode(w, errViewOnly.code, errViewOnly.msg, errViewOnly.status)
}

// requireWriteRole refuses a view-only client. Every handler that changes
// state on the server calls it, behind denyViewWrites, which already refuses
// every write method: a route that forgets this check is still covered.
func requireWriteRole(w http.ResponseWriter, r *http.Request) bool {
	if isViewOnly(r) {
		writeViewOnly(w)
		return false
	}
	return true
}

// requireAgentRead lets every role read a pane's agent: the transcript shows
// what the screen showed (commands, tool output), which a view-only client
// watches in the terminal anyway.
func requireAgentRead(http.ResponseWriter, *http.Request) bool { return true }

// requireFilesRead refuses a view-only client reveal=1 (content, diff and raw
// take it): sensitive files stay hidden from it. The rest of the files rules
// for that role (a git repo only, no hash) need the pane's root and the
// handler, so filesAPI applies them.
func requireFilesRead(w http.ResponseWriter, r *http.Request) bool {
	if isViewOnly(r) && r.URL.Query().Get("reveal") == "1" {
		writeViewOnly(w)
		return false
	}
	return true
}

// serveAs serves a request that passed sign-in as a, after the default
// refusal of a view-only client's writes.
func serveAs(next http.Handler, w http.ResponseWriter, r *http.Request, a authInfo) {
	r = r.WithContext(withAuth(r.Context(), a))
	if denyViewWrites(w, r) {
		return
	}
	next.ServeHTTP(w, r)
}

// denyViewWrites is the default refusal of a view-only client: any write
// method on any path, except logging out (which revokes its own device;
// basicAuth serves it before sign-in, so this only keeps a later reorder
// from locking a device out of it).
// It runs in basicAuth before any handler, so a route added later needs no
// check of its own to be closed to that role. It reports whether it refused.
func denyViewWrites(w http.ResponseWriter, r *http.Request) bool {
	if !isViewOnly(r) || !isWriteMethod(r.Method) {
		return false
	}
	if r.URL.Path == logoutPath && r.Method == http.MethodPost {
		return false
	}
	writeViewOnly(w)
	return true
}
