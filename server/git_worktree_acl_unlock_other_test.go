//go:build !windows

package main

import "testing"

// checkOwnerOnly: off Windows the folder's mode (0700) is the check.
func checkOwnerOnly(*testing.T, string) {}
