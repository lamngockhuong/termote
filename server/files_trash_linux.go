package main

import (
	"errors"

	"golang.org/x/sys/unix"
)

// renameat2 is unix.Renameat2; tests replace it to take the fallback.
var renameat2 = unix.Renameat2

// renameatNoReplace renames with RENAME_NOREPLACE, or through a hard link
// on a file system without it.
func renameatNoReplace(ofd int, old string, nfd int, new string) error {
	err := renameat2(ofd, old, nfd, new, unix.RENAME_NOREPLACE)
	if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOSYS) {
		return linkUnlink(ofd, old, nfd, new)
	}
	return err
}
