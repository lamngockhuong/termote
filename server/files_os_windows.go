package main

import (
	"io/fs"
	"os"

	"golang.org/x/sys/windows"
)

// tmuxFilesSupported: psmux is not known to report #{pane_current_path}
// (not verified on Windows yet), so on Windows the files views are offered
// only with Herdr.
const tmuxFilesSupported = false

// openNonblock: Windows opens never wait on a pipe the way a FIFO does.
const openNonblock = 0

// createBadChars are refused in a Windows file name (':' would also name an
// alternate data stream).
const createBadChars = `<>:"|?*`

var systemDenyDirs []string

// ownedByServer is not checked on Windows: a repo git refuses for its owner
// is browsed as a plain directory.
func ownedByServer(string) bool { return false }

// fileLinks is the number of hard links to the file fh has open.
func fileLinks(fh *os.File, _ fs.FileInfo) (uint64, error) {
	var d windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(fh.Fd()), &d); err != nil {
		return 0, err
	}
	return uint64(d.NumberOfLinks), nil
}

// fileOwnedByServer is not checked on Windows: a file the server user cannot
// write is refused by its read-only attribute or by the rename.
func fileOwnedByServer(fs.FileInfo) bool { return true }
