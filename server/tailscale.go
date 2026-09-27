package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Termote publishes the local server over Tailscale HTTPS with
// `tailscale serve --bg --https=<tsPort> http://127.0.0.1:<port>`. serve
// applies it at every start (boot, restart, update), so the mapping follows
// the saved config; stop removes only that mapping (`--https=<tsPort> off`,
// never `serve reset`, which would drop mappings that are not Termote's).
// sudo is never used: on Linux the user runs `tailscale set --operator` once.

// tailscaleApplyTimeout bounds serve's attempt, so a hung tailscaled never
// holds anything up.
const tailscaleApplyTimeout = 15 * time.Second

// splitTailscale splits "host[:port]"; the HTTPS port defaults to 443.
func splitTailscale(v string) (host, port string) {
	if h, p, ok := strings.Cut(v, ":"); ok {
		return h, p
	}
	return v, "443"
}

func tailscaleServeArgs(tsPort string, port int) []string {
	return []string{"serve", "--bg", "--https=" + tsPort, fmt.Sprintf("http://127.0.0.1:%d", port)}
}

func tailscaleOffArgs(tsPort string) []string {
	return []string{"serve", "--https=" + tsPort, "off"}
}

// tailscaleRun runs the tailscale CLI; tests replace it.
var tailscaleRun = func(ctx context.Context, args ...string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, "tailscale", args...).CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("tailscale %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// tailscaleServeStatus is the part of `tailscale serve status --json` that
// says where an HTTPS port proxies to.
type tailscaleServeStatus struct {
	Web map[string]struct {
		Handlers map[string]struct {
			Proxy string `json:"Proxy"`
		} `json:"Handlers"`
	} `json:"Web"`
}

// tailscaleMapped reports whether https:<tsPort>/ already proxies to target.
func tailscaleMapped(statusJSON []byte, tsPort, target string) bool {
	var st tailscaleServeStatus
	if json.Unmarshal(statusJSON, &st) != nil {
		return false
	}
	for hostport, web := range st.Web {
		if !strings.HasSuffix(hostport, ":"+tsPort) {
			continue
		}
		if h, ok := web.Handlers["/"]; ok && strings.TrimSuffix(h.Proxy, "/") == target {
			return true
		}
	}
	return false
}

// applyTailscale is what serve runs once it listens: add the mapping when it
// is missing. Failures are only logged; the server runs without it.
func applyTailscale(ctx context.Context, ts string, port int) {
	if ts == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, tailscaleApplyTimeout)
	defer cancel()
	_, tsPort := splitTailscale(ts)
	target := fmt.Sprintf("http://127.0.0.1:%d", port)
	if out, err := tailscaleRun(ctx, "serve", "status", "--json"); err == nil && tailscaleMapped(out, tsPort, target) {
		return
	}
	if _, err := tailscaleRun(ctx, tailscaleServeArgs(tsPort, port)...); err != nil {
		log.Printf("tailscale serve not applied: %v", err)
		return
	}
	log.Printf("tailscale serve: https:%s -> %s", tsPort, target)
}

// tailscaleOperatorHint is the one-time fix for "access denied" on Linux.
func (c *cli) tailscaleOperatorHint() string {
	if c.goos != "linux" {
		return ""
	}
	return "; allow your user to change Tailscale serve once with: sudo tailscale set --operator=$USER"
}

// setupTailscale is start's check that serve will be allowed to publish the
// port: it applies the mapping itself and reports a refusal.
func (c *cli) setupTailscale(ts string, port int) error {
	if _, err := c.run.LookPath("tailscale"); err != nil {
		return errors.New("tailscale not found in PATH (https://tailscale.com/download), or drop --tailscale")
	}
	_, tsPort := splitTailscale(ts)
	if _, err := c.run.Output("", nil, "tailscale", tailscaleServeArgs(tsPort, port)...); err != nil {
		return fmt.Errorf("tailscale serve failed (%v)%s", err, c.tailscaleOperatorHint())
	}
	return nil
}

// removeTailscale removes Termote's mapping for ts; others stay.
func (c *cli) removeTailscale(ts string) {
	if ts == "" {
		return
	}
	if _, err := c.run.LookPath("tailscale"); err != nil {
		return
	}
	_, tsPort := splitTailscale(ts)
	if _, err := c.run.Output("", nil, "tailscale", tailscaleOffArgs(tsPort)...); err != nil {
		c.warnf("Could not remove the Tailscale serve mapping for https:%s: %v", tsPort, err)
		return
	}
	c.infof("Removed the Tailscale serve mapping for https:%s", tsPort)
}

// validTailscale checks a --tailscale value: host[:port].
func validTailscale(ts string) error {
	host, port := splitTailscale(ts)
	if err := validateHostName(host); err != nil {
		return fmt.Errorf("invalid --tailscale: %v", err)
	}
	if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
		return fmt.Errorf("invalid --tailscale port %q", port)
	}
	return nil
}
