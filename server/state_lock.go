package main

import (
	"errors"
	"log"
	"path/filepath"
	"sync"
	"time"
)

// stateLockRetry is how often a lock held by another process is tried again.
const stateLockRetry = 10 * time.Millisecond

// errStateLockTimeout means another process held a state lock past the wait.
var errStateLockTimeout = errors.New("state file is locked by another process")

// unlockedStateFiles logs once that a file system does not lock.
var unlockedStateFiles sync.Once

// lockStateFile takes the exclusive lock of path (created 0600, owner only,
// never through a symlink), trying again until wait has passed, and returns
// what releases it. Every process that reads, changes and writes a state
// file holds it across the three, so none writes back what it read before
// another's write. A file system that cannot lock (NFS without lockd, some
// FUSE mounts) works as before the lock existed, and says so once.
func lockStateFile(path string, wait time.Duration) (func(), error) {
	f, err := openStateLock(path)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		locked, err := tryLockFile(f)
		if lockUnsupported(err) {
			unlockedStateFiles.Do(func() {
				log.Printf("%s: this file system cannot lock (%v): a second process on the same state dir can undo a write", filepath.Base(path), err)
			})
			return func() { f.Close() }, nil
		}
		if err != nil {
			f.Close()
			return nil, err
		}
		if locked {
			return func() { unlockFile(f); f.Close() }, nil
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, errStateLockTimeout
		}
		time.Sleep(stateLockRetry)
	}
}
