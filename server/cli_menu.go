package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// cmdMenu is the interactive menu the shims open without arguments. It uses
// numbered prompts, so it needs no extra tool.
func (c *cli) cmdMenu() error {
	if !c.interactive {
		c.printHelp()
		return usageError("the menu needs a terminal; pass a command instead")
	}
	fmt.Fprintf(c.out, "\n%s\n%s\n\n", c.paint(ansiBold, "  TERMOTE - Terminal + Remote"), c.paint(ansiDim, "  v"+c.version))
	switch c.choose("Select action:", []string{
		"Install", "Update", "Uninstall", "Health check", "View logs", "Clean logs", "Show password", "Exit",
	}) {
	case "Install":
		return c.menuInstall()
	case "Update":
		return c.cmdUpdate(nil)
	case "Uninstall":
		return c.cmdUninstall([]string{c.choose("What to remove:", []string{"container", "native", "all"})})
	case "Health check":
		return c.cmdHealth(nil)
	case "View logs":
		return c.cmdLogs([]string{"follow"})
	case "Clean logs":
		return c.cmdLogs([]string{"clean"})
	case "Show password":
		return c.cmdShowPassword()
	}
	return nil
}

// choose prints numbered options and returns the chosen one ("" on EOF).
func (c *cli) choose(header string, options []string) string {
	fmt.Fprintln(c.out, c.paint(ansiCyan, header))
	for i, o := range options {
		fmt.Fprintf(c.out, "  [%d] %s\n", i+1, o)
	}
	for {
		a := c.prompt(fmt.Sprintf("Select (1-%d): ", len(options)))
		if a == "" {
			if _, err := c.in.Peek(1); err != nil {
				return ""
			}
			continue
		}
		if n, err := strconv.Atoi(a); err == nil && n >= 1 && n <= len(options) {
			fmt.Fprintln(c.out)
			return options[n-1]
		}
	}
}

// menuInstall asks every option; the answers replace the saved config
// (--fresh).
func (c *cli) menuInstall() error {
	mode := c.choose("Select mode:", []string{
		"native - Host tool access (claude, gh)",
		"container - Isolated container (docker/podman)",
	})
	if mode == "" {
		return errors.New("cancelled")
	}
	mode, _, _ = strings.Cut(mode, " ")
	args := []string{mode, "--fresh"}
	herdr := false
	if mode == "native" {
		backend, _, _ := strings.Cut(c.choose("Terminal backend:", []string{
			"tmux - tmux (psmux on Windows)",
			"herdr - Herdr workspaces",
		}), " ")
		herdr = backend == "herdr"
		if herdr {
			args = append(args, "--mux", "herdr")
		}
	}
	if c.confirm("Expose to LAN?") {
		args = append(args, "--lan")
	}
	if c.confirm("Disable authentication?") {
		args = append(args, "--no-auth")
		if herdr {
			if !c.confirm("Herdr without auth exposes every workspace. Continue?") {
				return errors.New("cancelled")
			}
			args = append(args, "--allow-herdr-no-auth")
		}
	}
	if c.confirm("Enable Tailscale HTTPS?") {
		if h := c.prompt("Tailscale hostname (e.g. myhost.ts.net): "); h != "" {
			args = append(args, "--tailscale", h)
		}
	}
	return c.cmdInstall(args)
}

func (c *cli) cmdShowPassword() error {
	cfg, err := c.loadConfig()
	if err != nil {
		return err
	}
	switch {
	case cfg == nil:
		return fmt.Errorf("no saved config at %s; run 'termote install' first", c.configFile())
	case cfg.NoAuth:
		c.infof("Authentication is disabled (installed with --no-auth)")
		return nil
	case cfg.PasswordUnreadable:
		return errors.New("the saved password cannot be decrypted by this user on this machine; reset it with: termote install <mode> --fresh")
	case cfg.Password == "":
		return errors.New("no password saved; set one with: termote install <mode> --fresh")
	}
	fmt.Fprintf(c.out, "Username: %s\nPassword: %s\n", adminUser, cfg.Password)
	return nil
}
