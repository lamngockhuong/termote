package main

import (
	"path/filepath"
	"testing"
)

// The service finds its cache where the shell that ran start does: the
// Files trash and the uploads live there, and uninstall --purge removes
// them from the XDG_CACHE_HOME of its own shell.
func TestServiceEnvKeepsCacheHome(t *testing.T) {
	tc := newTestCLI(t, "linux")
	cache := t.TempDir()
	tc.env = map[string]string{"PATH": "/usr/bin", "XDG_CACHE_HOME": cache}
	env := tc.serviceEnv()
	if env["XDG_CACHE_HOME"] != cache {
		t.Fatalf("service env %v, want XDG_CACHE_HOME", env)
	}
	if got, want := tc.trashDir(), filepath.Join(cache, "termote", "trash"); got != want {
		t.Fatalf("trashDir = %q, want %q", got, want)
	}
}
