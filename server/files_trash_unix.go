//go:build !windows

package main

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// renameNoReplace moves fromName in from to toName in to, failing with
// EEXIST when toName is taken (a Unix rename would replace it) and with
// EXDEV across file systems. Both directories are used through their open
// descriptors, never by path.
func renameNoReplace(from *os.Root, fromName string, to *os.Root, toName string) error {
	return withDirFds(from, to, func(ofd, nfd int) error {
		if err := renameatNoReplace(ofd, fromName, nfd, toName); err != nil {
			return &os.LinkError{Op: "rename", Old: fromName, New: toName, Err: err}
		}
		return nil
	})
}

// renameNoReplaceChecked is renameNoReplace for a rename of the file fi
// describes: where the file system has no flag for it, the hard link
// fallback unlinks fromName only while it is still that file
// (linkCheckUnlink).
func renameNoReplaceChecked(from *os.Root, fromName string, to *os.Root, toName string, fi fs.FileInfo) error {
	return withDirFds(from, to, func(ofd, nfd int) error {
		err := renameatExcl(ofd, fromName, nfd, toName, func(ofd int, old string, nfd int, new string) error {
			return linkCheckUnlink(ofd, old, nfd, new, fi)
		})
		if err != nil {
			return &os.LinkError{Op: "rename", Old: fromName, New: toName, Err: err}
		}
		return nil
	})
}

// linkBeforeCheck runs between the hard link of linkCheckUnlink and its
// check; only tests set it, to replace the old name in between.
var linkBeforeCheck = func() {}

// linkCheckUnlink links old to new, then unlinks old only while it is still
// the file fi describes. A file put at old in between (an agent writing a
// temporary file and renaming it over old) is kept: the new link is removed
// and errEditChanged returned, since the file the client renamed was
// replaced. Accepted risk: old can still be replaced between the check and
// the unlink. When old is gone by then, the new link is the file: kept.
func linkCheckUnlink(ofd int, old string, nfd int, new string, fi fs.FileInfo) error {
	if err := unix.Linkat(ofd, old, nfd, new, 0); err != nil {
		return err
	}
	linkBeforeCheck()
	var st unix.Stat_t
	err := unix.Fstatat(ofd, old, &st, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if want := fi.Sys().(*syscall.Stat_t); err != nil || uint64(st.Dev) != uint64(want.Dev) || uint64(st.Ino) != uint64(want.Ino) {
		if err := unix.Unlinkat(nfd, new, 0); err != nil {
			log.Printf("files rename: removing the link %s: %v", new, err)
		}
		return errEditChanged
	}
	return unix.Unlinkat(ofd, old, 0)
}

// isInUse reports whether err is a move refused because another program
// holds the file open: never on Unix.
func isInUse(error) bool { return false }

// renameIntoTrash moves fromName in from to toName in to with a plain
// rename: toName is a new random name, and a hard link fallback could
// unlink a file swapped in between its two steps.
func renameIntoTrash(from *os.Root, fromName string, to *os.Root, toName string) error {
	return withDirFds(from, to, func(ofd, nfd int) error {
		if err := unix.Renameat(ofd, fromName, nfd, toName); err != nil {
			return &os.LinkError{Op: "rename", Old: fromName, New: toName, Err: err}
		}
		return nil
	})
}

// linkUnlink is renameNoReplace where the file system has no flag for it:
// a hard link never replaces anything. A server that dies in between
// leaves the file with two links; the trash's sweep removes its own.
func linkUnlink(ofd int, old string, nfd int, new string) error {
	if err := unix.Linkat(ofd, old, nfd, new, 0); err != nil {
		return err
	}
	return unix.Unlinkat(ofd, old, 0)
}

// unlinkAt removes the file base in dir, never a directory.
func unlinkAt(dir *os.Root, base string) error {
	return withDirFds(dir, nil, func(fd, _ int) error {
		return pathErr("unlink", base, unix.Unlinkat(fd, base, 0))
	})
}

// rmdirAt removes the empty directory base in dir, never a file: one
// swapped in after the checks fails with ENOTDIR.
func rmdirAt(dir *os.Root, base string) error {
	return withDirFds(dir, nil, func(fd, _ int) error {
		return pathErr("rmdir", base, unix.Unlinkat(fd, base, unix.AT_REMOVEDIR))
	})
}

func pathErr(op, name string, err error) error {
	if err == nil {
		return nil
	}
	return &os.PathError{Op: op, Path: name, Err: err}
}

// withDirFds runs fn with descriptors of a and b (b may be nil).
func withDirFds(a, b *os.Root, fn func(afd, bfd int) error) error {
	af, err := a.Open(".")
	if err != nil {
		return err
	}
	defer af.Close()
	bfd := -1
	if b != nil {
		bf, err := b.Open(".")
		if err != nil {
			return err
		}
		defer bf.Close()
		bfd = int(bf.Fd())
	}
	return fn(int(af.Fd()), bfd)
}

// isCrossDevice reports whether err is a rename across file systems.
func isCrossDevice(err error) bool { return errors.Is(err, syscall.EXDEV) }

// isDirNotEmpty reports whether err is an rmdir of a directory with
// entries (Linux says ENOTEMPTY, some systems EEXIST).
func isDirNotEmpty(err error) bool {
	return errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST)
}

// isNotDir reports whether err is an rmdir of a file (one swapped in).
func isNotDir(err error) bool { return errors.Is(err, syscall.ENOTDIR) }
