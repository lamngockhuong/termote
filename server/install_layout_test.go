package main

import (
	"path/filepath"
	"testing"
)

// The PWA names the update command from installKind: each layout must be
// told apart, the installer's first since a checkout may hold an install.
func TestInstallKind(t *testing.T) {
	marker := filepath.Join(t.TempDir(), ".dockerenv")
	saved := containerMarkers
	containerMarkers = []string{marker}
	t.Cleanup(func() { containerMarkers = saved })

	tc := newTestCLI(t, "linux")
	if got := tc.installKind(); got != "unknown" {
		t.Errorf("a binary copied by hand = %q, want unknown", got)
	}

	writeFile(t, marker, "")
	if got := tc.installKind(); got != "container" {
		t.Errorf("in a container = %q, want container", got)
	}

	writeFile(t, filepath.Join(tc.projectDir, "pwa", "package.json"), "{}")
	if got := tc.installKind(); got != "checkout" {
		t.Errorf("a checkout = %q, want checkout", got)
	}

	tc.exe = filepath.Join(tc.versionsDir(), "1.0.0", "bin", "termote")
	if got := tc.installKind(); got != "release" {
		t.Errorf("an installed release = %q, want release", got)
	}
}
