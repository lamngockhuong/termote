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
)

// zellijCheckSocketDir fails unless the dirs zellij keeps its sockets in can
// only be this user's, as tmux checks its socket dir: the socket dir must be
// a directory (not a symlink) of the current user that no other user can
// write, and its contract dir, where the sockets are, one of the current
// user's that nobody else can enter (Zellij makes it 0700) when it is there.
// A socket dir that is missing is made 0700 first, so no other user makes
// it before zellij does. Otherwise another user who made the dir in a shared
// /tmp could serve a session termote would list, attach to and type into.
func zellijCheckSocketDir() error {
	dir := zellijSocketDir()
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		err = zellijOwnDir(dir, 0o002)
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
