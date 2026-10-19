//go:build !windows

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/unix"
)

// zellijCheckSocketDir fails unless the dirs zellij keeps its sockets in can
// only be this user's, as tmux checks its socket dir: the socket dir must be
// a directory (not a symlink) of the current user that no other user can
// write, and its contract dir, where the sockets are, one of the current
// user's that nobody else can enter (Zellij makes it 0700) when it is there.
// A socket dir that is missing is made 0700 first, so no other user makes
// it before zellij does. Otherwise another user who made the dir in a shared
// /tmp could serve a session termote would list, attach to and type into.
// Zellij makes the socket dir group-writable under umask 002: its group
// write is taken away before the contract dir is checked, so another member
// of the group cannot swap the contract dir between the check and a command.
func zellijCheckSocketDir() error {
	dir := zellijSocketDir()
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		err = zellijOwnSocketDir(dir)
	}
	if err == nil {
		if err = zellijOwnDir(filepath.Join(dir, zellijContractDir), 0o077); errors.Is(err, fs.ErrNotExist) {
			err = nil
		}
	}
	zellijLogSocketDir(err)
	if err != nil {
		return errZellijSocketDir
	}
	return nil
}

// zellijOwnDir fails unless dir is a directory, not a symlink, of the
// current user with none of the deny permission bits.
func zellijOwnDir(dir string, deny fs.FileMode) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	return zellijOwnInfo(dir, fi, deny)
}

func zellijOwnInfo(dir string, fi fs.FileInfo, deny fs.FileMode) error {
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	if uid, ok := fileOwner(fi); !ok || uid != os.Getuid() {
		return fmt.Errorf("%s is not owned by the current user", dir)
	}
	if fi.Mode().Perm()&deny != 0 {
		return fmt.Errorf("%s has mode %#o", dir, fi.Mode().Perm())
	}
	return nil
}

// zellijOwnSocketDir is zellijOwnDir(dir, 0o002) that also takes the
// group's write permission off dir, keeping its other bits (a setgid bit
// too), and fails when the group can still write it afterwards. It checks
// and changes the dir it opened, never following a symlink, so a dir
// swapped for a link after the check is not what gets the mode.
func zellijOwnSocketDir(dir string) error {
	f, err := os.OpenFile(dir, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_DIRECTORY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if err := zellijOwnInfo(dir, fi, 0o002); err != nil || fi.Mode().Perm()&0o020 == 0 {
		return err
	}
	mode := fi.Mode() & (fs.ModePerm | fs.ModeSetgid | fs.ModeSticky) &^ 0o020
	if err := zellijChmodDir(f, mode); err != nil {
		return err
	}
	// A mount can take the chmod and keep the mode (some FUSE, SMB, vfat)
	if fi, err = f.Stat(); err != nil {
		return err
	}
	if fi.Mode().Perm()&0o020 != 0 {
		return fmt.Errorf("%s keeps mode %#o after chmod", dir, fi.Mode().Perm())
	}
	log.Printf("zellij: socket dir %s made %#o: no write for its group", dir, mode.Perm())
	return nil
}

// zellijChmodDir changes the mode of the open dir f; a test replaces it.
var zellijChmodDir = func(f *os.File, mode fs.FileMode) error { return f.Chmod(mode) }

// zellijSocketDirRefusal is the last reason logged, so each reason is
// logged once, not once per zellij command.
var zellijSocketDirRefusal struct {
	sync.Mutex
	last string
}

func zellijLogSocketDir(err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	zellijSocketDirRefusal.Lock()
	defer zellijSocketDirRefusal.Unlock()
	if msg != "" && msg != zellijSocketDirRefusal.last {
		log.Printf("zellij: socket dir refused: %s", msg)
	}
	zellijSocketDirRefusal.last = msg
}
