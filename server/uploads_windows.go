package main

import "io/fs"

// checkPrivateDir: the dir (uploads, trash) sits under %LOCALAPPDATA%, which only its
// user can open; Windows has no mode bits to set.
func checkPrivateDir(string) error { return nil }

// privateUploadFile: Windows reports no group or other bits to check.
func privateUploadFile(fs.FileInfo) bool { return true }
