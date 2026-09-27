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

// tailscaleTarget returns where https:<tsPort>/ proxies to, or "".
func tailscaleTarget(statusJSON []byte, tsPort string) string {
	var st tailscaleServeStatus
	if json.Unmarshal(statusJSON, &st) != nil {
		return ""
	}
	for hostport, web := range st.Web {
		if !strings.HasSuffix(hostport, ":"+tsPort) {
			continue
		}
		if h, ok := web.Handlers["/"]; ok {
			return strings.TrimSuffix(h.Proxy, "/")
		}
	}
	return ""
}

// tailscaleMapped reports whether https:<tsPort>/ already proxies to target.
func tailscaleMapped(statusJSON []byte, tsPort, target string) bool {
	return tailscaleTarget(statusJSON, tsPort) == target
}

func localTarget(port int) string { return fmt.Sprintf("http://127.0.0.1:%d", port) }

// applyTailscale is what serve runs once it listens: add the mapping when it
// is missing. An HTTPS port that serves something else (the container, a
// service of the user) is left alone. Failures are only logged; the server
// runs without it.
func applyTailscale(ctx context.Context, ts string, port int) {
	if ts == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, tailscaleApplyTimeout)
	defer cancel()
	_, tsPort := splitTailscale(ts)
	target := fmt.Sprintf("http://127.0.0.1:%d", port)
	if out, err := tailscaleRun(ctx, "serve", "status", "--json"); err == nil {
		switch other := tailscaleTarget(out, tsPort); other {
		case target:
			return
		case "":
		default:
			log.Printf("tailscale serve not applied: https:%s already serves %s", tsPort, other)
			return
		}
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

// tailscaleServeStatus reads `tailscale serve status --json`, nil when it
// cannot.
func (c *cli) tailscaleStatus() []byte {
	out, err := c.run.Output("", nil, "tailscale", "serve", "status", "--json")
	if err != nil {
		return nil
	}
	return out
}

// setupTailscale is start's (and container up's) check that the port can be
// published: it applies the mapping itself and reports a refusal. An HTTPS
// port already serving something other than this server (at port, or at
// prevPort before a port change) is refused rather than taken over.
func (c *cli) setupTailscale(ts string, port, prevPort int) error {
	if _, err := c.run.LookPath("tailscale"); err != nil {
		return errors.New("tailscale not found in PATH (https://tailscale.com/download), or drop --tailscale")
	}
	host, tsPort := splitTailscale(ts)
	if other := tailscaleTarget(c.tailscaleStatus(), tsPort); other != "" && other != localTarget(port) &&
		(prevPort == 0 || other != localTarget(prevPort)) {
		return fmt.Errorf("https:%s on Tailscale already serves %s; publish on another HTTPS port, e.g. --tailscale %s:8443", tsPort, other, host)
	}
	if _, err := c.run.Output("", nil, "tailscale", tailscaleServeArgs(tsPort, port)...); err != nil {
		return fmt.Errorf("tailscale serve failed (%v)%s", err, c.tailscaleOperatorHint())
	}
	return nil
}

// removeTailscale removes the mapping of ts when it still proxies to this
// server's port; a mapping to anything else (the other of native and
// container, a service of the user) stays.
func (c *cli) removeTailscale(ts string, port int) {
	if ts == "" {
		return
	}
	if _, err := c.run.LookPath("tailscale"); err != nil {
		return
	}
	_, tsPort := splitTailscale(ts)
	if target := tailscaleTarget(c.tailscaleStatus(), tsPort); target != localTarget(port) {
		if target != "" {
			c.infof("Left the Tailscale mapping https:%s alone: it serves %s now", tsPort, target)
		}
		return
	}
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
