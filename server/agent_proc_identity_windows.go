package main

import (
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

// Paths and identities of the files found by procWriteFiles.

// winDrivePath strips the \\?\ prefix GetFinalPathNameByHandle adds and
// accepts only a path on a drive letter: a UNC path (\\?\UNC\host\share)
// would make a later stat reach that host, sending the user's NTLM hash.
func winDrivePath(p string) (string, bool) {
	p = strings.TrimPrefix(p, `\\?\`)
	if len(p) < 3 || p[1] != ':' || p[2] != '\\' {
		return "", false
	}
	if c := p[0] | 0x20; c < 'a' || c > 'z' {
		return "", false
	}
	return p, true
}

// handleIdentity is the volume serial number and file index of an open file,
// "" when unknown.
func handleIdentity(h windows.Handle) string {
	var d windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(h, &d) != nil ||
		(d.VolumeSerialNumber == 0 && d.FileIndexHigh == 0 && d.FileIndexLow == 0) {
		return ""
	}
	return fmt.Sprintf("%x:%x%08x", d.VolumeSerialNumber, d.FileIndexHigh, d.FileIndexLow)
}

// rolloutIdentity is the identity of a rollout file, comparable with the
// procFile.id procWriteFiles reports: through f when it is open, else
// through path opened for its attributes only (never conflicting with the
// writer's share mode). os.FileInfo carries no file index on Windows, so fi
// is unused here.
func rolloutIdentity(path string, f *os.File, _ os.FileInfo) string {
	if f != nil {
		return handleIdentity(windows.Handle(f.Fd()))
	}
	if _, ok := winDrivePath(path); !ok {
		return ""
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	h, err := windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	return handleIdentity(h)
}
