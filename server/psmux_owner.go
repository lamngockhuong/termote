package main

import (
	"errors"
	"io"
	"io/fs"
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
// held by the current user (or SYSTEM), and the listeners must be readable:
// while they cannot be, psmux does not run.

// errPsmuxPortTaken: a port psmux recorded is held by another user. The
// session may be long gone, its file left behind: the log names the file to
// remove.
var errPsmuxPortTaken = &codedError{
	code:   "psmux_port_taken",
	msg:    "a psmux session's port is held by another user's process; see the server log",
	status: http.StatusServiceUnavailable,
}

// errPsmuxPortsUnverified: who listens on a port psmux recorded cannot be
// told (the TCP table could not be read); the log has the reason.
var errPsmuxPortsUnverified = &codedError{
	code:   "psmux_ports_unverified",
	msg:    "cannot tell who listens on a psmux session's port; see the server log",
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
	owner func(port int) (listenerOwner, error)
	mu    sync.Mutex
	at    time.Time
	err   error
}

var psmuxPorts = &psmuxGuard{dir: psmuxDataDir, owner: psmuxPortOwner}

// check returns errPsmuxPortTaken (wrapped with the session's name) when a
// port psmux recorded is held by another user, or errPsmuxPortsUnverified
// when who holds it cannot be read, at most psmuxCheckEvery old.
func (g *psmuxGuard) check() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.at.IsZero() && time.Since(g.at) < psmuxCheckEvery {
		return g.err
	}
	err := psmuxPortsOwned(g.dir(), g.owner)
	if err != nil && (g.err == nil || g.err.Error() != err.Error()) {
		log.Printf("psmux: %v; not running psmux meanwhile", err)
	}
	g.at, g.err = time.Now(), err
	return err
}

// psmuxPortsOwned checks the port of each <session>.port file in dir: one a
// process of another user listens on fails, and so does one whose listeners
// cannot be read, or a dir or a .port file that cannot be read. No dir (or
// none named) means no server; a file that is not a port is psmux's to
// refuse.
func psmuxPortsOwned(dir string, owner func(port int) (listenerOwner, error)) error {
	if dir == "" {
		return nil
	}
	// Stat first: on Windows, ReadDir can list a regular file as an empty dir.
	fi, err := os.Stat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err == nil && !fi.IsDir() {
		err = errors.New("not a directory")
	}
	if err != nil {
		return &psmuxPortError{file: dir, unread: err}
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return &psmuxPortError{file: dir, unread: err}
	}
	for _, e := range ents {
		name, ok := strings.CutSuffix(e.Name(), ".port")
		if !ok || !e.Type().IsRegular() {
			continue
		}
		port, ok, err := readPsmuxPort(filepath.Join(dir, e.Name()))
		if err != nil {
			return &psmuxPortError{session: name, file: filepath.Join(dir, e.Name()), unread: err}
		}
		if !ok {
			continue
		}
		o, err := owner(port)
		if err != nil || o == listenerOtherOwner {
			return &psmuxPortError{session: name, port: port, file: filepath.Join(dir, e.Name()), unread: err}
		}
	}
	return nil
}

// readPsmuxPort reads the port in path; ok is false for a file that holds no
// port, err set when the file cannot be read. A file gone since the listing
// (its session ended) holds no port.
func readPsmuxPort(path string) (port int, ok bool, err error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, psmuxPortFileMax))
	if err != nil {
		return 0, false, err
	}
	port, err = strconv.Atoi(strings.TrimSpace(string(b)))
	return port, err == nil && port > 0 && port <= 65535, nil
}

// psmuxPortError names the session whose port another user holds, or what
// could not be read (unread, the reason): the data dir (no session), the
// .port file (no port) or the port's listeners. For the log; clients get
// only the error's code.
type psmuxPortError struct {
	session, file string
	port          int
	unread        error
}

func (e *psmuxPortError) Error() string {
	switch {
	case e.session == "":
		return "cannot read the psmux data dir " + e.file + ": " + e.unread.Error()
	case e.port == 0:
		return "cannot read the port of psmux session " + strconv.Quote(e.session) + " in " + e.file + ": " + e.unread.Error()
	}
	at := "the port of psmux session " + strconv.Quote(e.session) + " (" + strconv.Itoa(e.port) +
		", recorded in " + e.file + ")"
	if e.unread != nil {
		return "cannot tell who listens on " + at + ": " + e.unread.Error()
	}
	return at + " is held by another user's process; remove that file if the session is gone"
}

func (e *psmuxPortError) Unwrap() error {
	if e.unread != nil {
		return errPsmuxPortsUnverified
	}
	return errPsmuxPortTaken
}
