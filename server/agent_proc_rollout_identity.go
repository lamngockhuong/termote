//go:build !windows

package main

import "os"

// rolloutIdentity is the identity of a Codex rollout file. Here the stat
// carries it (fileIdentity); Windows reads it from a handle instead.
func rolloutIdentity(_ string, _ *os.File, fi os.FileInfo) string { return fileIdentity(fi) }

// rolloutStamp is the last write time (ns) and size of a rollout file, from
// its stat; Windows reads them from a handle instead.
func rolloutStamp(_ string, fi os.FileInfo) (int64, int64) { return fi.ModTime().UnixNano(), fi.Size() }
