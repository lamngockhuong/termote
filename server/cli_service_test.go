package main

import "testing"

// The service finds its cache where the shell that ran start does: the
// Files trash and the uploads live there, and uninstall --purge removes
// them from the XDG_CACHE_HOME of its own shell.
func TestServiceEnvKeepsCacheHome(t *testing.T) {
	tc := newTestCLI(t, "linux")
	tc.env = map[string]string{"PATH": "/usr/bin", "HOME": "/home/u", "XDG_CACHE_HOME": "/home/u/cache"}
	env := tc.serviceEnv()
	if env["XDG_CACHE_HOME"] != "/home/u/cache" {
		t.Fatalf("service env %v, want XDG_CACHE_HOME", env)
	}
	if got := tc.trashDir(); got != "/home/u/cache/termote/trash" {
		t.Fatalf("trashDir = %q", got)
	}
}
