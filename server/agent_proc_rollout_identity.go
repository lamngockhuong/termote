//go:build !windows

package main

import "os"

// rolloutIdentity is the identity of a Codex rollout file. Here the stat
// carries it (fileIdentity); Windows reads it from a handle instead.
func rolloutIdentity(_ string, _ *os.File, fi os.FileInfo) string { return fileIdentity(fi) }
