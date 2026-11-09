package main

import (
	"context"
	"net"
	"net/http"
	"path"
	"runtime"
	"strconv"
	"strings"
)

// A native server opens a second socket beside the CLI's: the machine bridge,
// <stateDir>/run/<port>.bridge.sock (Windows: the pipe
// \\.\pipe\termote-<SID>-<port>-bridge), with the same permissions. Another
// termote reaches it over SSH: the key it installed here may only run
// `termote bridge` (a forced command), which joins its stdin and stdout to
// this socket. A request arriving there signs in as authMachine, never as
// the CLI: it carries the role the other termote sends (view when it sends
// none), and pairs, revokes or subscribes nothing here.

// bridgeGreeting starts the line `termote bridge` writes before any HTTP
// byte, followed by its version: the other end reads it to tell a bridge
// from a shell that answered instead (a key installed without the forced
// command).
const bridgeGreeting = "TERMOTE-BRIDGE 1 "

// bridgeRoleHeader carries the role of the request the other termote
// forwards; bridgeOriginAuthHeader how that request signed in there (only
// written to the audit log here).
const (
	bridgeRoleHeader       = "X-Termote-Role"
	bridgeOriginAuthHeader = "X-Termote-Origin-Auth"
)

// bridgeSocketName is the name openLocalSocket and dialSocketOS take for the
// bridge of the server on port: <port>.bridge.sock in the socket dir, or the
// pipe termote-<SID>-<port>-bridge.
func bridgeSocketName(port string) string {
	if runtime.GOOS == "windows" {
		return port + "-bridge"
	}
	return port + ".bridge"
}

// dialBridgeServer connects to the bridge of the server on port and checks
// who holds its server end, as dialLocalServer does. Tests replace it.
var dialBridgeServer = func(dir string, port int) (net.Conn, error) {
	return dialSocketOS(dir, bridgeSocketName(strconv.Itoa(port)))
}

// bridgeKey marks the context of a connection accepted on the bridge socket.
// Only localSocketConnContext sets it, from the connection's type.
type bridgeKey struct{}

// isBridge reports whether the request arrived on the bridge socket.
func isBridge(ctx context.Context) bool {
	v, _ := ctx.Value(bridgeKey{}).(bool)
	return v
}

// bridgeConn is a connection accepted on the bridge socket.
type bridgeConn struct{ net.Conn }

// bridgeListener wraps the bridge socket's listener so its connections can
// be told apart from the CLI's and from TCP ones.
type bridgeListener struct{ net.Listener }

func (l bridgeListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &bridgeConn{c}, nil
}

// errMachineForbidden refuses another termote what only someone holding this
// machine's password, or its CLI, may do.
var errMachineForbidden = &codedError{code: "machine_forbidden", msg: "not available through another termote", status: http.StatusForbidden}

// machineForbiddenPath reports whether p (cleaned) is a route a bridge
// request never reaches: signing in or out, pairing a device, sign-in links,
// the devices and sign-ins lists with their revokes, Web Push, and settings
// proposals (a machine's are for its own browsers).
func machineForbiddenPath(p string) bool {
	switch p {
	case loginPath, pairPath, loginLinkPath, logoutPath, loginLinksRoute:
		return true
	}
	for _, prefix := range []string{"/api/mux/devices", "/api/mux/signins", "/api/mux/push", "/api/mux/settings"} {
		if p == prefix || strings.HasPrefix(p, prefix+"/") {
			return true
		}
	}
	return false
}

// bridgeAuth signs in a request of the bridge socket as authMachine and
// serves it with inner, the routes without basicAuth: it sits outside
// basicAuth, so it applies when this server runs with --no-auth too. Any
// other request goes on to next. The role is X-Termote-Role (full or view),
// view when missing; the header means nothing on any other connection.
func bridgeAuth(inner, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isBridge(r.Context()) {
			next.ServeHTTP(w, r)
			return
		}
		if machineForbiddenPath(path.Clean("/" + r.URL.Path)) {
			jsonErrorCode(w, errMachineForbidden.code, errMachineForbidden.msg, errMachineForbidden.status)
			return
		}
		a := authInfo{Kind: authMachine, Role: roleView}
		switch v := r.Header.Get(bridgeRoleHeader); v {
		case "", string(roleView):
		case string(roleFull):
			a.Role = roleFull
		default:
			jsonError(w, "invalid "+bridgeRoleHeader, http.StatusBadRequest)
			return
		}
		switch v := r.Header.Get(bridgeOriginAuthHeader); v {
		case "password", "device":
			a.OriginAuth = v
		}
		serveAs(inner, w, r, a)
	})
}
