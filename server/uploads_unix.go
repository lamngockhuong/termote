//go:build !windows

package main

import (
	"fmt"
	"io/fs"
	"os"
)

// checkPrivateUploadDir makes dir 0700 and refuses it unless the server user
// owns it: another user could otherwise swap the files an agent is told to read.
func checkPrivateUploadDir(dir string) error {
	if !ownedByServer(dir) {
		return fmt.Errorf("%s is not owned by the server user", dir)
	}
	return os.Chmod(dir, 0o700)
}

// privateUploadFile reports whether only its owner can read or write fi.
func privateUploadFile(fi fs.FileInfo) bool {
	return fi.Mode().Perm()&0o077 == 0
}
