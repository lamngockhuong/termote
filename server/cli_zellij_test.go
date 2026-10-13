package main

import (
	"os"
	"strings"
	"testing"
)

// TestStartZellijOnWindowsRefusedBeforeSaving: native Zellij is refused on
// Windows before anything is saved; the container runs it on any host.
func TestStartZellijOnWindowsRefusedBeforeSaving(t *testing.T) {
	tc := newTestCLI(t, "windows")
	tc.runner.paths["zellij"] = true
	if code := tc.main([]string{"start", "--mux", "zellij"}); code != 2 || !strings.Contains(tc.stderr.String(), "not supported on Windows") {
		t.Fatalf("code %d, stderr %s", code, tc.stderr.String())
	}
	if _, err := os.Stat(tc.configFile()); err == nil {
		t.Fatal("a config was saved")
	}
	if err := validateMux("zellij", false, false); err != nil {
		t.Fatalf("validateMux(zellij) = %v (the container shares it)", err)
	}
}

func TestPreflightZellij(t *testing.T) {
	tc := newTestCLI(t, "linux")
	if err := tc.preflight("zellij"); err == nil || !strings.Contains(err.Error(), "zellij not found") {
		t.Fatalf("missing = %v", err)
	}
	tc.runner.paths["zellij"] = true
	tc.runner.outputs["zellij --version"] = "zellij 0.44.3\n"
	if err := tc.preflight("zellij"); err == nil || !strings.Contains(err.Error(), "too old") {
		t.Fatalf("0.44.3 = %v", err)
	}
	tc.runner.outputs["zellij --version"] = "zellij 0.45.1\n"
	if err := tc.preflight("zellij"); err != nil {
		t.Fatalf("0.45.1 = %v", err)
	}
}

func TestServiceEnvCarriesZellijSockets(t *testing.T) {
	for _, goos := range []string{"linux", "darwin"} {
		tc := newTestCLI(t, goos)
		tc.env = map[string]string{"PATH": "/usr/bin", "ZELLIJ_SOCKET_DIR": "/tmp/zs", "XDG_RUNTIME_DIR": "/run/user/1000",
			"TMPDIR": "/var/folders/x/T/", "TERMOTE_PASS": "x"}
		env := tc.serviceEnv()
		if env["ZELLIJ_SOCKET_DIR"] != "/tmp/zs" || env["XDG_RUNTIME_DIR"] != "/run/user/1000" || env["TERMOTE_PASS"] != "" {
			t.Errorf("%s: service env %v", goos, env)
		}
		if got, want := env["TMPDIR"] != "", goos == "darwin"; got != want {
			t.Errorf("%s: TMPDIR passed = %v", goos, got)
		}
	}
}
