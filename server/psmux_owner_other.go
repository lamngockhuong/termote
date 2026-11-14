//go:build !windows

package main

// psmuxPortOwner: psmux runs on Windows only.
func psmuxPortOwner(port int) listenerOwner { return listenerOwnerOf(port) }

// psmuxDataDir: psmux runs on Windows only.
func psmuxDataDir() string { return "" }
