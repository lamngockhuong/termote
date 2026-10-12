//go:build !windows

package main

import "path/filepath"

// isJunction is false off Windows: a link there is a symlink, which the
// dir entry already reports.
func isJunction(string) bool { return false }

// resolveLinkedDir is the real path of a linked skill dir, every symlink on
// the way resolved.
func resolveLinkedDir(p string) (string, error) { return filepath.EvalSymlinks(p) }
