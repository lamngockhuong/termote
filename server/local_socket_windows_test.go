package main

import (
	"errors"
	"net/http"
	"strconv"
	"testing"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// The pipe takes the CLI's request without the password, a second server
// on the port cannot take the name, and a pipe served by another user is
// never used.
func TestLocalPipe(t *testing.T) {
	const port = 47913
	ln, cleanup, err := openLocalSocket("", strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Host != localSocketHost {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		w.Write([]byte(`{"status":"ok","version":"9.9.9"}`))
	})}
	go srv.Serve(ln)
	defer srv.Close()

	if _, _, err := openLocalSocket("", strconv.Itoa(port)); err == nil {
		t.Error("a second pipe of the same name was created")
	}
	c, err := dialLocalServerOS("", port)
	if err != nil {
		t.Fatalf("own pipe: %v", err)
	}
	c.Close()
	tc := newTestCLI(t, "windows")
	if h, code, via := tc.fetchHealthVia(port, "admin", "secret"); code != http.StatusOK || via != transportSocket || h.Version != "9.9.9" {
		t.Fatalf("health over the pipe: %d %s %+v", code, via, h)
	}

	old := pipeOwner
	defer func() { pipeOwner = old }()
	everyone, _ := windows.CreateWellKnownSid(windows.WinWorldSid)
	pipeOwner = func(windows.Handle) (*windows.SID, error) { return everyone, nil }
	if _, err := dialLocalServerOS("", port); !errors.Is(err, errLocalServerUntrusted) {
		t.Errorf("pipe of another user: %v, want errLocalServerUntrusted", err)
	}
	pipeOwner = func(windows.Handle) (*windows.SID, error) { return nil, windows.ERROR_ACCESS_DENIED }
	if _, err := dialLocalServerOS("", port); !errors.Is(err, errLocalServerUntrusted) {
		t.Errorf("pipe whose owner cannot be read: %v, want errLocalServerUntrusted", err)
	}
	system, _ := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	pipeOwner = func(windows.Handle) (*windows.SID, error) { return system, nil }
	c, err = dialLocalServerOS("", port)
	if err != nil {
		t.Errorf("pipe owned by SYSTEM: %v", err)
	} else {
		c.Close()
	}
}

// A pipe of the server's name and ACL, served by a process of the current
// user but owned by someone else (the Administrators group, which only an
// elevated process can name), is refused: the owner of the pipe object
// decides, not the user of the process serving it.
func TestLocalPipeOwnedByAnother(t *testing.T) {
	const port = 47914
	name, err := localPipeName(strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := u.User.Sid.String()
	ln, err := winio.ListenPipe(name, &winio.PipeConfig{SecurityDescriptor: "O:BAD:P(A;;GA;;;" + sid + ")(A;;GA;;;SY)"})
	if err != nil {
		t.Skipf("cannot make a pipe owned by Administrators (not elevated): %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	if c, err := dialLocalServerOS("", port); !errors.Is(err, errLocalServerUntrusted) {
		if c != nil {
			c.Close()
		}
		t.Errorf("pipe owned by Administrators: %v, want errLocalServerUntrusted", err)
	}
}
