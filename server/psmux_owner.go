package main

import (
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// psmux finds a session's server through <data dir>\<session>.port, a TCP
// port on 127.0.0.1, and sends it the session's key; it never checks who
// listens there. While a server is gone and its .port file stays, another
// user on the machine can listen on that port and be taken for it: the
// sessions it lists, and every key the user types into them, would be its.
// So before termote runs psmux, every port psmux has recorded must be free or
// held by the current user (or SYSTEM).

// errPsmuxPortTaken: a port psmux recorded is held by another user. The
// session may be long gone, its file left behind: the log names the file to
// remove.
var errPsmuxPortTaken = &codedError{
	code:   "psmux_port_taken",
	msg:    "a psmux session's port is held by another user's process; see the server log",
	status: http.StatusServiceUnavailable,
}

// psmuxCheckEvery bounds how often the ports are checked: every psmux command
// asks, and a snapshot runs several.
const psmuxCheckEvery = 2 * time.Second

// psmuxPortFileMax bounds what is read of a .port file.
const psmuxPortFileMax = 32

// psmuxGuard caches the last check. dir and owner are replaced by tests.
type psmuxGuard struct {
	dir   func() string
	owner func(port int) listenerOwner
	mu    sync.Mutex
	at    time.Time
	err   error
}

var psmuxPorts = &psmuxGuard{dir: psmuxDataDir, owner: psmuxPortOwner}

// check returns errPsmuxPortTaken (wrapped with the session's name) when a
// port psmux recorded is held by another user, at most psmuxCheckEvery old.
func (g *psmuxGuard) check() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.at.IsZero() && time.Since(g.at) < psmuxCheckEvery {
		return g.err
	}
	err := psmuxPortsOwned(g.dir(), g.owner)
	if err != nil && (g.err == nil || g.err.Error() != err.Error()) {
		log.Printf("psmux: %v; not running psmux until it is gone", err)
	}
	g.at, g.err = time.Now(), err
	return err
}

// psmuxPortsOwned checks the port of each <session>.port file in dir: one a
// process of another user listens on fails. No dir means no server; a file
// that is not a port is psmux's to refuse.
func psmuxPortsOwned(dir string, owner func(port int) listenerOwner) error {
	if dir == "" {
		return nil
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	for _, e := range ents {
		name, ok := strings.CutSuffix(e.Name(), ".port")
		if !ok || !e.Type().IsRegular() {
			continue
		}
		port, ok := readPsmuxPort(filepath.Join(dir, e.Name()))
		if ok && owner(port) == listenerOtherOwner {
			return &psmuxPortError{session: name, port: port, file: filepath.Join(dir, e.Name())}
		}
	}
	return nil
}

func readPsmuxPort(path string) (int, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, psmuxPortFileMax))
	if err != nil {
		return 0, false
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(b)))
	return port, err == nil && port > 0 && port <= 65535
}

// psmuxPortError names the session whose port another user holds, for the
// log; clients get only the error's code.
type psmuxPortError struct {
	session, file string
	port          int
}

func (e *psmuxPortError) Error() string {
	return "the port of psmux session " + strconv.Quote(e.session) + " (" + strconv.Itoa(e.port) +
		", recorded in " + e.file + ") is held by another user's process; remove that file if the session is gone"
}

func (e *psmuxPortError) Unwrap() error { return errPsmuxPortTaken }
