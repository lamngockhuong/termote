package main

import (
	"errors"

	"golang.org/x/sys/unix"
)

// renameatNoReplace renames with RENAME_EXCL, or through a hard link on a
// file system without it.
func renameatNoReplace(ofd int, old string, nfd int, new string) error {
	err := unix.RenameatxNp(ofd, old, nfd, new, unix.RENAME_EXCL)
	if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOTSUP) {
		return linkUnlink(ofd, old, nfd, new)
	}
	return err
}
