package main

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// psmuxPortOwner is listenerOwnersOn, also trusting LOCAL SERVICE and
// NETWORK SERVICE, which no local user runs as: a service of either may hold
// the port a psmux session left behind, and must not stop psmux.
func psmuxPortOwner(port int) (listenerOwner, error) {
	return listenerOwnersOn(port, "S-1-5-19", "S-1-5-20")
}

// psmuxDataDir is where psmux keeps its .port files, found as psmux finds it
// (src/paths.rs): PSMUX_DATA_DIR when set, which psmux run by termote
// inherits, else .psmux in the profile directory of the process's user. A
// profile directory that cannot be read is an error, never "no dir": psmux
// may still find one, and its ports would then go unchecked.
func psmuxDataDir() (string, error) {
	if d := os.Getenv("PSMUX_DATA_DIR"); d != "" {
		return d, nil
	}
	home, err := windows.GetCurrentProcessToken().GetUserProfileDirectory()
	if err == nil && home == "" {
		err = errors.New("the profile directory is empty")
	}
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".psmux"), nil
}
