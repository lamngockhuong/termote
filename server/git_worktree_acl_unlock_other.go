//go:build !windows

package main

import "context"

// restrictWorktreeDir is a no-op off Windows: the folder is made 0700.
func restrictWorktreeDir(string) error { return nil }

// waitWorktreeFree is a no-op off Windows, where a folder a process still
// holds can be deleted (the groups working there are closed first).
func waitWorktreeFree(context.Context, string) error { return nil }
