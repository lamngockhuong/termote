package main

import (
	"fmt"
	"strings"
	"testing"
)

// panelKeys makes tc an interactive terminal that presses keys in order,
// then fails to read (the popup closing).
func panelKeys(tc *testCLI, keys string) {
	tc.interactive, tc.outTTY = true, true
	i := 0
	tc.readKey = func() (byte, error) {
		if i >= len(keys) {
			return 0, errKeysDone
		}
		i++
		return keys[i-1], nil
	}
}

func TestPanelRunning(t *testing.T) {
	tc := newTestCLI(t, "linux")
	port, _ := serveHealth(t, "p", herdrHealth)
	tc.saveConfig(savedConfig{Port: port, LAN: true, Tailscale: "box.ts.net", Password: "p"})
	tc.env["HERDR_PLUGIN_CONTEXT_JSON"] = `{"workspace_id":"w1","tab_id":"w1:t1","focused_pane_id":"w1:p2"}`

	// Not a terminal: drawn once.
	if code := tc.main([]string{"panel"}); code != 0 {
		t.Fatalf("code %d", code)
	}
	out := tc.stdout.String()
	for _, want := range []string{"v1.0.0 · herdr · ok", "https://box.ts.net/#/s/w1/w1%3At1/w1%3Ap2", "█",
		fmt.Sprintf("Local: http://localhost:%d", port), "LAN: http://192.168.1.20:", "Tailscale: https://box.ts.net", "o open  c copy"} {
		if !strings.Contains(out, want) {
			t.Errorf("panel misses %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "\033[2J") || strings.Contains(out, "Not opened from Herdr") {
		t.Fatalf("non-interactive panel cleared the screen or lost Herdr:\n%s", out)
	}

	// o opens, c copies, s is ignored while running, x stops, r restarts, q closes.
	link := "https://box.ts.net/#/s/w1/w1%3At1/w1%3Ap2"
	tc.runner.paths["xdg-open"], tc.runner.paths["xclip"] = true, true
	tc.runner.outputs["xdg-open "+link] = ""
	panelKeys(tc, "ocs"+"x "+"r "+"q")
	tc.stdout.Reset()
	// Clear runner state from first test but keep the runner object
	tc.runner.mu.Lock()
	tc.runner.calls, tc.runner.inputs = []string{}, []string{}
	tc.runner.fail = map[string]bool{}
	tc.runner.mu.Unlock()
	if code := tc.main([]string{"panel"}); code != 0 {
		t.Fatalf("interactive code %d", code)
	}
	out = tc.stdout.String()
	exe := tc.stableExe()
	// inputs[0] is "" from openURL, inputs[1] is link from copyText
	if !tc.runner.called("xdg-open "+link) || (len(tc.runner.inputs) < 2 || tc.runner.inputs[1] != link) || tc.runner.called(exe+" start") ||
		!tc.runner.called(exe+" stop") || !tc.runner.called(exe+" restart") {
		t.Fatalf("calls %v inputs %v", tc.runner.calls, tc.runner.inputs)
	}
	for _, want := range []string{"\033[H\033[2J", "Opened the link in the browser", "Copied the link (xclip)", "$ termote stop", "Press a key to go back"} {
		if !strings.Contains(out, want) {
			t.Errorf("interactive panel misses %q", want)
		}
	}

	// A failing open and a failing command are shown, then Esc closes.
	tc.runner.fail["xdg-open "+link] = true
	tc.runner.fail[exe+" restart"] = true
	panelKeys(tc, "or \x1b")
	tc.stdout.Reset()
	tc.main([]string{"panel"})
	if out := tc.stdout.String(); !strings.Contains(out, "xdg-open could not open") || !strings.Contains(out, "termote restart failed") {
		t.Fatalf("failures not shown:\n%s", out)
	}
}

func TestPanelStopped(t *testing.T) {
	tc := newTestCLI(t, "linux")
	port, srv := serveHealth(t, "p", herdrHealth)
	srv.Close()
	tc.saveConfig(savedConfig{Port: port, Password: "p"})
	// o, c, x and r do nothing while stopped; s starts; Ctrl-C closes.
	panelKeys(tc, "ocxrs \x03")
	if code := tc.main([]string{"panel"}); code != 0 {
		t.Fatalf("code %d", code)
	}
	exe := tc.stableExe()
	if len(tc.runner.calls) != 1 || tc.runner.calls[0] != exe+" start" {
		t.Fatalf("calls %v", tc.runner.calls)
	}
	if out := tc.stdout.String(); !strings.Contains(out, "not running") || !strings.Contains(out, "s start  q close") {
		t.Fatalf("stopped panel:\n%s", out)
	}
	if code := tc.main([]string{"panel", "extra"}); code != 2 {
		t.Fatalf("args code %d", code)
	}
}

// Another user's process on the port: the panel says so, offers no link and
// no start (it would fail on the busy port).
func TestPanelUntrustedListener(t *testing.T) {
	tc := newTestCLI(t, "linux")
	port, _ := serveHealth(t, "p", herdrHealth)
	tc.saveConfig(savedConfig{Port: port, Password: "p"})
	old := listenerOwnerOf
	listenerOwnerOf = func(int) listenerOwner { return listenerOtherOwner }
	t.Cleanup(func() { listenerOwnerOf = old })
	panelKeys(tc, "ocs \x03")
	if code := tc.main([]string{"panel"}); code != 0 {
		t.Fatalf("code %d", code)
	}
	if len(tc.runner.calls) != 0 {
		t.Fatalf("calls %v", tc.runner.calls)
	}
	out := tc.stdout.String()
	if !strings.Contains(out, untrustedListenerMsg) || strings.Contains(out, "s start") {
		t.Fatalf("untrusted panel:\n%s", out)
	}
}

func TestPanelOutsideHerdrAndTmux(t *testing.T) {
	tc := newTestCLI(t, "linux")
	port, _ := serveHealth(t, "p", `{"status":"ok","version":"1.0.0","backend":"tmux","pid":1}`)
	tc.saveConfig(savedConfig{Port: port, Password: "p"})
	tc.main([]string{"panel"})
	if out := tc.stdout.String(); !strings.Contains(out, "Not opened from Herdr") || !strings.Contains(out, fmt.Sprintf("http://localhost:%d/\n", port)) {
		t.Fatalf("outside Herdr:\n%s", out)
	}
	tc.stdout.Reset()
	tc.env["HERDR_PLUGIN_CONTEXT_JSON"] = `{"workspace_id":"w1","tab_id":"w1:t1"}`
	tc.main([]string{"panel"})
	if out := tc.stdout.String(); !strings.Contains(out, "tmux backend") || strings.Contains(out, "#/s/") {
		t.Fatalf("tmux backend:\n%s", out)
	}
}

func TestPanelClosesWhenInputEnds(t *testing.T) {
	tc := newTestCLI(t, "linux")
	port, _ := serveHealth(t, "p", herdrHealth)
	tc.saveConfig(savedConfig{Port: port, Password: "p"})
	panelKeys(tc, "")
	if code := tc.main([]string{"panel"}); code != 0 || !strings.Contains(tc.stdout.String(), "o open") {
		t.Fatalf("code %d\n%s", code, tc.stdout.String())
	}
}
