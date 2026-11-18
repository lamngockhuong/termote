//go:build !windows

package main

// psmuxPortOwner: psmux runs on Windows only.
func psmuxPortOwner(port int) (listenerOwner, error) { return listenerOwnerOf(port), nil }

// psmuxDataDir: psmux runs on Windows only.
func psmuxDataDir() (string, error) { return "", nil }
