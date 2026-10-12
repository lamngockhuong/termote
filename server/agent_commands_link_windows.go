package main

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Linked skill dirs on Windows. Go reports a directory junction (a mount
// point reparse point) as ModeIrregular, not ModeSymlink, and since Go 1.23
// filepath.EvalSymlinks returns a path through a junction unchanged, while
// os.OpenRoot of that path still follows it. So a junction is classified here
// by its reparse tag, and a linked dir is resolved through an open handle
// (GetFinalPathNameByHandle), which resolves symlinks and junctions alike.

// fileAttributeTagInfo is FILE_ATTRIBUTE_TAG_INFO.
type fileAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

// isJunctionTag reports whether attributes and a reparse tag are those of a
// directory junction. Every other reparse point (app exec links, cloud files,
// WSL symlinks, dedup, ...) is not followed.
func isJunctionTag(attrs, tag uint32) bool {
	return attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 &&
		attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0 &&
		tag == windows.IO_REPARSE_TAG_MOUNT_POINT
}

// isJunction reports whether p is a directory junction whose target is a
// path on a drive letter. The link itself is opened (never its target) for
// its attributes only; a volume GUID (\\?\Volume{...}), UNC or device target
// is refused before anything follows it. Any error is false.
func isJunction(p string) bool {
	if _, ok := winDrivePath(p); !ok {
		return false
	}
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return false
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return false
	}
	var info fileAttributeTagInfo
	err = windows.GetFileInformationByHandleEx(h, windows.FileAttributeTagInfo,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	windows.CloseHandle(h)
	if err != nil || !isJunctionTag(info.FileAttributes, info.ReparseTag) {
		return false
	}
	target, err := os.Readlink(p)
	if err != nil {
		return false
	}
	_, ok := winDrivePath(target)
	return ok
}

// resolveLinkedDir is the real path of the directory p leads to, on a drive
// letter: p is opened (following every link) and the handle's final path
// read. A UNC result, a file, or any error is refused.
func resolveLinkedDir(p string) (string, error) {
	if _, ok := winDrivePath(p); !ok {
		return "", errors.New("not a drive path")
	}
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	var d windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &d); err != nil {
		return "", err
	}
	if d.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return "", errors.New("not a directory")
	}
	real, ok := finalDrivePath(h)
	if !ok {
		return "", errors.New("not a drive path")
	}
	return real, nil
}
