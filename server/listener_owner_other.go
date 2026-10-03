//go:build !linux && !darwin && !windows

package main

// listenerOwnedLocally has no way to see a socket's owner here, so the
// saved password is never sent to a port that answers.
func listenerOwnedLocally(int) listenerOwner { return listenerNoneSeen }
