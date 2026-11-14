package main

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// psmuxPortOwner is listenerOwnedLocally that also trusts LOCAL SERVICE and
// NETWORK SERVICE, which no local user runs as: a service of either may hold
// the port a psmux session left behind, and must not stop psmux.
func psmuxPortOwner(port int) listenerOwner {
	return listenerOwnedLocallyOr(port, "S-1-5-19", "S-1-5-20")
}

// psmuxDataDir is where psmux keeps its .port files, found as psmux finds it
// (src/paths.rs): PSMUX_DATA_DIR when set, which psmux run by termote
// inherits, else .psmux in the profile directory of the process's user.
func psmuxDataDir() string {
	if d := os.Getenv("PSMUX_DATA_DIR"); d != "" {
		return d
	}
	home, err := windows.GetCurrentProcessToken().GetUserProfileDirectory()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".psmux")
}
