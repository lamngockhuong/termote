package main

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// listenerOwnedLocally asks lsof for the owners of the sockets listening on
// port. lsof run by a user does not see another user's sockets, so another
// user's listener reads as none seen; so does any without lsof.
func listenerOwnedLocally(port int) listenerOwner {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lsof", "-w", "-n", "-P",
		"-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN", "-Fu").Output()
	if err != nil {
		return listenerNoneSeen
	}
	return ownerOf(lsofUIDs(string(out)), os.Getuid())
}
