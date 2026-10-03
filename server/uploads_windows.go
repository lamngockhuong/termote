package main

import "io/fs"

// checkPrivateUploadDir: the dir sits under %LOCALAPPDATA%, which only its
// user can open; Windows has no mode bits to set.
func checkPrivateUploadDir(string) error { return nil }

// privateUploadFile: Windows reports no group or other bits to check.
func privateUploadFile(fs.FileInfo) bool { return true }
