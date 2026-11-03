package main

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

// A stopped Tailscale is named in start's error, with the two ways out,
// instead of a bare "exit status 1".
func TestTailscaleServeStoppedHint(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	_, err := exec.Command("sh", "-c", "echo 'Tailscale is stopped.' >&2; exit 1").Output()
	if err == nil {
		t.Fatal("expected an exit error")
	}
	if got := tailscaleErrText(err); !strings.Contains(got, "Tailscale is stopped.") {
		t.Fatalf("stderr dropped: %q", got)
	}
	c := newTestCLI(t, "linux")
	hint := c.tailscaleServeHint(err)
	if !strings.Contains(hint, "tailscale up") || !strings.Contains(hint, "--no-tailscale") {
		t.Fatalf("hint %q", hint)
	}
	if strings.Contains(hint, "--operator") {
		t.Fatalf("operator hint for a stopped Tailscale: %q", hint)
	}
}
