package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// serveConfigFromSaved is the one place the server's settings are built from
// the saved config. Bind follows LAN explicitly: without it the server only
// listens on loopback, whatever the environment says.
func serveConfigFromSaved(s savedConfig, defaultPort int) serveConfig {
	port := s.Port
	if port == 0 {
		port = defaultPort
	}
	bind := "127.0.0.1"
	if s.LAN {
		bind = "0.0.0.0"
	}
	mux := s.Mux
	if mux == "" {
		mux = "tmux"
	}
	var hosts []string
	if s.Tailscale != "" {
		host, _ := splitTailscale(s.Tailscale)
		hosts = append(hosts, strings.ToLower(host))
	}
	hosts = append(hosts, s.AllowHosts...)
	return serveConfig{
		Port:             strconv.Itoa(port),
		User:             adminUser,
		Pass:             s.Password,
		NoAuth:           s.NoAuth,
		Bind:             bind,
		AllowedHosts:     strings.Join(hosts, ","),
		AllowLocalAddr:   s.LAN,
		MuxBackend:       mux,
		HerdrAllowNoAuth: s.HerdrAllowNoAuth,
		Tailscale:        s.Tailscale,
	}
}

// errConfigUnusable means the saved config exists but cannot run a server.
var errConfigUnusable = errors.New("saved config unusable")

// loadServeConfig reads the saved config when there is one and ignores every
// TERMOTE_* variable then; only without a config file (the container, tests,
// a manual run) does the environment configure the server, TERMOTE_PWA_DIR
// included.
func (c *cli) loadServeConfig() (serveConfig, error) {
	saved, err := c.loadConfig()
	if err != nil {
		return serveConfig{}, fmt.Errorf("%w: cannot read %s: %v", errConfigUnusable, c.configFile(), err)
	}
	if saved == nil {
		return newServeConfigFromEnv(), nil
	}
	if !saved.NoAuth && saved.Password == "" {
		why := "has no password"
		if saved.PasswordUnreadable {
			why = "has a password that cannot be decrypted (was " + c.secretFile() + " removed or replaced?)"
		}
		return serveConfig{}, fmt.Errorf("%w: %s %s; set a new one with: termote start --fresh", errConfigUnusable, c.configFile(), why)
	}
	return serveConfigFromSaved(*saved, c.defaultPort()), nil
}
