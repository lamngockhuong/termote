package main

import "os"

// listenerOwnedLocally reads the owners of the sockets listening on port from
// /proc/net/tcp and tcp6, which list every user's sockets with their uid.
// Every listener on the port counts, whatever its address.
func listenerOwnedLocally(port int) listenerOwner {
	var uids []int
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		uids = append(uids, procNetListenerUIDs(string(b), port)...)
	}
	return ownerOf(uids, os.Getuid())
}
