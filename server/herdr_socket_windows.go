//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// herdrPipePrefix is the local named pipe namespace. herdr serves its API on
// the pipe named after the socket path; the file at that path only records
// the server's pid.
const herdrPipePrefix = `\\.\pipe\`

// herdrSocketPath returns $HERDR_SOCKET_PATH, else herdr.sock in herdr's
// config directory, found in the order herdr itself uses: $XDG_CONFIG_HOME,
// %APPDATA%, %USERPROFILE%\AppData\Roaming, $HOME\.config, then the temp
// directory. The pipe is named after the path string, so it is joined the way
// herdr joins it (Rust's PathBuf::join), without cleaning.
func herdrSocketPath() string {
	if p := os.Getenv("HERDR_SOCKET_PATH"); p != "" {
		return p
	}
	var dir string
	switch {
	case os.Getenv("XDG_CONFIG_HOME") != "":
		dir = herdrJoin(os.Getenv("XDG_CONFIG_HOME"), "herdr")
	case os.Getenv("APPDATA") != "":
		dir = herdrJoin(os.Getenv("APPDATA"), "herdr")
	case os.Getenv("USERPROFILE") != "":
		dir = herdrJoin(herdrJoin(herdrJoin(os.Getenv("USERPROFILE"), "AppData"), "Roaming"), "herdr")
	case os.Getenv("HOME") != "":
		dir = herdrJoin(os.Getenv("HOME"), ".config/herdr")
	default:
		dir = herdrJoin(os.TempDir(), "herdr")
	}
	return herdrJoin(dir, "herdr.sock")
}

// herdrJoin appends elem to dir with a backslash unless dir already ends in a
// separator.
func herdrJoin(dir, elem string) string {
	if strings.HasSuffix(dir, `\`) || strings.HasSuffix(dir, "/") {
		return dir + elem
	}
	return dir + `\` + elem
}

// herdrPipeName is the pipe herdr listens on for the socket path; a path
// that already names a pipe is kept.
func herdrPipeName(path string) string {
	if strings.HasPrefix(path, herdrPipePrefix) {
		return path
	}
	return herdrPipePrefix + path
}

// dialHerdr connects to the named pipe of herdr's socket path. It fails at
// once when no pipe exists, and waits only while every instance is busy.
//
// Pipe names are shared by every user of the machine, unlike a socket in the
// user's own config directory: another local user could create the pipe
// before herdr starts and receive what is typed in the PWA. The connection is
// kept only if the process serving the pipe runs as the same user.
func dialHerdr(ctx context.Context, path string) (net.Conn, error) {
	conn, err := winio.DialPipeContext(ctx, herdrPipeName(path))
	if err != nil {
		return nil, err
	}
	if err := checkPipeServerUser(conn); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// herdrExpectedUser is the user a herdr pipe server must run as; tests
// replace it.
var herdrExpectedUser = func() (*windows.SID, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return u.User.Sid, nil
}

// checkPipeServerUser fails unless the process serving conn's pipe runs as
// herdrExpectedUser. A server that cannot be inspected is refused too.
func checkPipeServerUser(conn net.Conn) error {
	f, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return errors.New("herdr pipe: no handle to check its server")
	}
	server, err := pipeServerUser(windows.Handle(f.Fd()))
	if err != nil {
		return fmt.Errorf("herdr pipe: cannot check its server: %w", err)
	}
	want, err := herdrExpectedUser()
	if err != nil {
		return fmt.Errorf("herdr pipe: current user: %w", err)
	}
	if !windows.EqualSid(server, want) {
		return fmt.Errorf("herdr pipe is served by another user (%s)", server)
	}
	return nil
}

// pipeServerUser returns the user of the process serving pipe h.
func pipeServerUser(h windows.Handle) (*windows.SID, error) {
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(h, &pid); err != nil {
		return nil, err
	}
	proc, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(proc)
	var token windows.Token
	if err := windows.OpenProcessToken(proc, windows.TOKEN_QUERY, &token); err != nil {
		return nil, err
	}
	defer token.Close()
	u, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	// The SID lives in u's buffer; copy it before the token closes.
	return u.User.Sid.Copy()
}
