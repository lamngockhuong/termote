package main

// tmuxFilesSupported: psmux is not known to report #{pane_current_path}
// (not verified on Windows yet), so on Windows the files views are offered
// only with Herdr.
const tmuxFilesSupported = false

// openNonblock: Windows opens never wait on a pipe the way a FIFO does.
const openNonblock = 0

var systemDenyDirs []string

// ownedByServer is not checked on Windows: a repo git refuses for its owner
// is browsed as a plain directory.
func ownedByServer(string) bool { return false }
