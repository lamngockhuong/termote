package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// Worktrees from git on Windows (psmux, herdr-core): what Unix gets from
// file modes and from deleting a folder while a process still works in it.

// restrictWorktreeDir gives only the current user access to dir and, by
// inheritance, to every checkout made in it: Windows has no 0700, and
// traverse checking is off for everyone, so a folder's children need an ACL
// of their own.
func restrictWorktreeDir(dir string) error {
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + tu.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// worktreeFreeWait bounds how long a remove waits for the processes of the
// groups it closed to end; worktreeFreePoll is how often it looks.
var (
	worktreeFreeWait = 10 * time.Second
	worktreeFreePoll = 250 * time.Millisecond
)

// renameBackWait bounds how long renameBack keeps trying: well past a
// scanner's look, within the remove's 60 s.
var renameBackWait = 30 * time.Second

// renameBack moves the probed folder back to dir. Right after the move, a
// scanner (Defender, the search indexer) can hold the folder for a moment,
// so a refused move is tried again, whatever the request's context: the
// worktree must not stay under the probe's name.
func renameBack(probe, dir string) error {
	deadline := time.Now().Add(renameBackWait)
	for {
		err := os.Rename(probe, dir)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			// The checkout is whole, under the probe's name; moving it back
			// by hand (or git worktree repair there) restores it.
			return fmt.Errorf("worktree %s left whole at %s, move it back: %w", dir, probe, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitWorktreeFree waits until nothing holds dir open: Windows refuses to
// rename a folder while a file in it is open or a process works in it, so
// renaming dir to a sibling and back proves it free. git deletes a worktree
// file by file and stops at the first locked one, with the .git file
// usually gone already, which leaves a checkout git no longer removes: so
// the remove starts only once dir is free, and answers in_use when it does
// not get free in time. A dir that is gone is free (git reports it).
func waitWorktreeFree(ctx context.Context, dir string) error {
	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	probe := dir + ".termote-" + hex.EncodeToString(suffix[:])
	deadline := time.Now().Add(worktreeFreeWait)
	for {
		err := os.Rename(dir, probe)
		if err == nil {
			return renameBack(probe, dir)
		}
		switch {
		case errors.Is(err, os.ErrNotExist):
			return nil
		case !errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_SHARING_VIOLATION):
			return err
		case time.Now().After(deadline):
			return errWorktreeInUse
		}
		select {
		case <-ctx.Done():
			return errWorktreeInUse
		case <-time.After(worktreeFreePoll):
		}
	}
}
