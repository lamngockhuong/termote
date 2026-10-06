//go:build !windows

package main

import "testing"

func TestStartHiddenPowerShellOnlyOnWindows(t *testing.T) {
	if startHiddenPowerShell("exit") == nil {
		t.Fatal("started a PowerShell outside Windows")
	}
}
