//go:build !windows

package main

import (
	"errors"
	"testing"

	"golang.org/x/sys/unix"
)

// A file system that cannot lock answers ENOLCK or ENOTSUP: the lock is then
// skipped, never every write refused.
func TestLockUnsupported(t *testing.T) {
	for _, err := range []error{unix.ENOLCK, unix.ENOTSUP, unix.EOPNOTSUPP} {
		if !lockUnsupported(err) {
			t.Errorf("%v not taken as a file system that cannot lock", err)
		}
	}
	if lockUnsupported(unix.EWOULDBLOCK) || lockUnsupported(errors.New("x")) || lockUnsupported(nil) {
		t.Error("an ordinary error taken as unsupported")
	}
}
