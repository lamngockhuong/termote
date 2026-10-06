package main

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// renameNoReplace moves fromName in from to toName in to. os.Root exposes
// no handle on Windows, so the move goes by absolute path once every
// directory on it was checked; MoveFileEx without MOVEFILE_REPLACE_EXISTING
// never replaces. Accepted risk: a local process able to write the root
// could swap a directory in between, but it has a shell anyway, and a
// delete checks what landed in the trash afterwards.
func renameNoReplace(from *os.Root, fromName string, to *os.Root, toName string) error {
	src, dst := filepath.Join(from.Name(), fromName), filepath.Join(to.Name(), toName)
	s, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	d, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(s, d, 0); err != nil {
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) || errors.Is(err, windows.ERROR_FILE_EXISTS) {
			err = os.ErrExist
		}
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: err}
	}
	return nil
}

// renameIntoTrash: MoveFileEx without a replace flag never replaces, as
// renameNoReplace.
var renameIntoTrash = renameNoReplace

// unlinkAt removes the file base in dir, never a directory.
func unlinkAt(dir *os.Root, base string) error {
	p := filepath.Join(dir.Name(), base)
	u, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return err
	}
	if err := windows.DeleteFile(u); err != nil {
		return &os.PathError{Op: "unlink", Path: p, Err: err}
	}
	return nil
}

// rmdirAt removes the empty directory base in dir, never a file.
func rmdirAt(dir *os.Root, base string) error {
	p := filepath.Join(dir.Name(), base)
	u, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return err
	}
	if err := windows.RemoveDirectory(u); err != nil {
		return &os.PathError{Op: "rmdir", Path: p, Err: err}
	}
	return nil
}

// isCrossDevice reports whether err is a move across volumes.
func isCrossDevice(err error) bool { return errors.Is(err, windows.ERROR_NOT_SAME_DEVICE) }

// isDirNotEmpty reports whether err is a removal of a directory with entries.
func isDirNotEmpty(err error) bool { return errors.Is(err, windows.ERROR_DIR_NOT_EMPTY) }

// isNotDir reports whether err is an rmdir of a file (one swapped in).
func isNotDir(err error) bool { return errors.Is(err, windows.ERROR_DIRECTORY) }
