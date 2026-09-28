package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// cmdMenu is the interactive menu `termote` opens without arguments. It uses
// numbered prompts, so it needs no extra tool.
func (c *cli) cmdMenu() error {
	if !c.interactive {
		c.printHelp()
		return usageError("the menu needs a terminal; pass a command instead")
	}
	fmt.Fprintf(c.out, "\n%s\n%s\n\n", c.paint(ansiBold, "  TERMOTE - Terminal + Remote"), c.paint(ansiDim, "  v"+c.version))
	switch c.choose("Select action:", []string{
		"Start (set options)", "Stop", "Restart", "Status", "Update", "View logs", "Clean logs",
		"Show password", "Container up", "Container down", "Uninstall", "Exit",
	}) {
	case "Start (set options)":
		return c.menuStart()
	case "Stop":
		return c.cmdStop(nil)
	case "Restart":
		return c.cmdRestart(nil)
	case "Status":
		return c.cmdStatus(nil)
	case "Update":
		return c.cmdUpdate(nil)
	case "View logs":
		return c.cmdLogs([]string{"follow"})
	case "Clean logs":
		return c.cmdLogs([]string{"clean"})
	case "Show password":
		return c.cmdShowPassword()
	case "Container up":
		return c.cmdContainer([]string{"up"})
	case "Container down":
		return c.cmdContainer([]string{"down"})
	case "Uninstall":
		return c.cmdUninstall(nil)
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

// menuStart asks every option and passes each answer explicitly, so the
// answers replace the saved values.
func (c *cli) menuStart() error {
	var args []string
	backend, _, _ := strings.Cut(c.choose("Terminal backend:", []string{
		"auto - herdr when it runs, else tmux",
		"tmux - tmux (psmux on Windows)",
		"herdr - Herdr workspaces",
	}), " ")
	if backend == "" {
		return errors.New("cancelled")
	}
	herdr := backend == "herdr"
	if backend != "auto" {
		args = append(args, "--mux", backend)
	}
	args = append(args, "--lan="+strconv.FormatBool(c.confirm("Expose to LAN?")))
	noAuth := c.confirm("Disable authentication?")
	if noAuth && herdr {
		if !c.confirm("Herdr without auth exposes every workspace. Continue?") {
			return errors.New("cancelled")
		}
		args = append(args, "--allow-herdr-no-auth")
	}
	args = append(args, "--no-auth="+strconv.FormatBool(noAuth))
	if c.confirm("Publish over Tailscale HTTPS?") {
		if h := c.prompt("Tailscale hostname (e.g. myhost.ts.net): "); h != "" {
			args = append(args, "--tailscale", h)
		}
	} else {
		args = append(args, "--no-tailscale")
	}
	return c.cmdStart(args)
}

func (c *cli) cmdShowPassword() error {
	cfg, err := c.loadConfig()
	if err != nil {
		return err
	}
	switch {
	case cfg == nil:
		return fmt.Errorf("no saved config at %s; run 'termote start' first", c.configFile())
	case cfg.NoAuth:
		c.infof("Authentication is disabled (started with --no-auth)")
		return nil
	case cfg.PasswordUnreadable:
		return errors.New("the saved password cannot be decrypted by this user on this machine; reset it with: termote start --fresh")
	case cfg.Password == "":
		return errors.New("no password saved; set one with: termote start --fresh")
	}
	fmt.Fprintf(c.out, "Username: %s\nPassword: %s\n", adminUser, cfg.Password)
	return nil
}
