package main

import (
	"context"
	"errors"
	"net"
	"time"
)

// A native server also listens on a socket only its own OS user can open: a
// Unix socket <stateDir>/run/<port>.sock (dir 0700, socket 0600) or, on
// Windows, the named pipe \\.\pipe\termote-<SID>-<port> whose ACL names
// that user and SYSTEM. A request arriving there is the CLI of that user,
// signed in without the saved password (authLocal, full): the boundary
// Termote relies on is the OS user, and the socket's permissions enforce it.
// Before sending anything the CLI checks the server end belongs to itself or
// root/SYSTEM, so a socket another user made cannot take its requests. The
// container (configured from the environment) opens no socket, and the CLI
// falls back to TCP with the password (authedRequest) when there is none.

// localSocketHost is the Host of every request over the local socket;
// hostGuard accepts it on that socket only.
const localSocketHost = "termote.local-socket"

// localSocketKey marks the context of a connection accepted on the local
// socket. Only localSocketConnContext sets it, from the connection's type,
// so nothing a TCP client sends can.
type localSocketKey struct{}

// isLocalSocket reports whether the request arrived on the local socket.
func isLocalSocket(ctx context.Context) bool {
	v, _ := ctx.Value(localSocketKey{}).(bool)
	return v
}

// localSocketConn is a connection accepted on the local socket.
type localSocketConn struct{ net.Conn }

// localSocketListener wraps the local socket's listener so its connections
// can be told apart from TCP ones.
type localSocketListener struct{ net.Listener }

func (l localSocketListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &localSocketConn{c}, nil
}

// localSocketConnContext is the server's ConnContext: it marks connections
// of the local socket.
func localSocketConnContext(ctx context.Context, c net.Conn) context.Context {
	if _, ok := c.(*localSocketConn); ok {
		return context.WithValue(ctx, localSocketKey{}, true)
	}
	return ctx
}

// errLocalServerUntrusted means the process at the server end of the local
// socket runs as another user: nothing is sent to it.
var errLocalServerUntrusted = errors.New("the local socket is held by a process of another user")

// errLocalSocketBusy means another live server already listens on the local
// socket (a second server on the same port): this one opens none.
var errLocalSocketBusy = errors.New("another server already listens on it")

// localDialTimeout bounds connecting to the local socket.
const localDialTimeout = time.Second

// dialLocalServer connects to the server's local socket for port (dir: the
// socket dir, unused on Windows) and checks who holds its server end. Tests
// replace it.
var dialLocalServer = dialLocalServerOS
