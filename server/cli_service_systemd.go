package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const systemdUnit = "termote.service"

// systemdSupervisor runs serve as a systemd user service.
type systemdSupervisor struct{ c *cli }

func (s *systemdSupervisor) Name() string    { return "systemd --user" }
func (s *systemdSupervisor) AutoStart() bool { return true }

func (s *systemdSupervisor) unitPath() string {
	return filepath.Join(s.c.envDir("XDG_CONFIG_HOME", filepath.Join(s.c.home, ".config")), "systemd", "user", systemdUnit)
}

// Available: a user manager answers. WSL2 without systemd, containers and
// SSH sessions without a user bus fail here.
func (s *systemdSupervisor) Available() bool {
	if _, err := s.c.run.LookPath("systemctl"); err != nil {
		return false
	}
	_, err := s.systemctl("show-environment")
	return err == nil
}

func (s *systemdSupervisor) Installed() bool { return fileExists(s.unitPath()) }

func (s *systemdSupervisor) systemctl(args ...string) ([]byte, error) {
	return s.c.run.Output("", nil, "systemctl", append([]string{"--user"}, args...)...)
}

// systemdUnitFile is the unit for `<exe> serve`. KillMode=process stops only
// the server: the tmux server it started, and every shell in it, stay alive
// across stop, restart and crash, so `termote restart` or `update` typed in
// a pane survives too.
func systemdUnitFile(exe, logPath string, env map[string]string) string {
	var b strings.Builder
	b.WriteString("# Written by `termote start`; `termote uninstall` removes it.\n")
	b.WriteString("[Unit]\nDescription=Termote (terminal in the browser)\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n")
	b.WriteString("[Service]\nType=simple\n")
	fmt.Fprintf(&b, "ExecStart=%s serve\n", systemdQuote(exe, true))
	b.WriteString("Restart=on-failure\nRestartSec=2\n")
	fmt.Fprintf(&b, "RestartPreventExitStatus=%d\n", exitConfigUnusable)
	b.WriteString("KillMode=process\n")
	for _, k := range sortedKeys(env) {
		fmt.Fprintf(&b, "Environment=%s\n", systemdQuote(k+"="+env[k], false))
	}
	fmt.Fprintf(&b, "StandardOutput=append:%s\nStandardError=append:%s\n", systemdEscape(logPath), systemdEscape(logPath))
	b.WriteString("\n[Install]\nWantedBy=default.target\n")
	return b.String()
}

// systemdEscape doubles % so systemd does not read it as a specifier.
func systemdEscape(s string) string { return strings.ReplaceAll(s, "%", "%%") }

// systemdQuote double-quotes a word for a unit file; in ExecStart, $ is also
// escaped since systemd expands variables there.
func systemdQuote(s string, exec bool) string {
	s = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", " ").Replace(systemdEscape(s))
	if exec {
		s = strings.ReplaceAll(s, "$", "$$")
	}
	return `"` + s + `"`
}

func (s *systemdSupervisor) Install(exe string, env map[string]string) error {
	if err := ensureDir(filepath.Dir(s.unitPath())); err != nil {
		return err
	}
	unit := systemdUnitFile(exe, s.c.serverLog(), env)
	if b, err := os.ReadFile(s.unitPath()); err != nil || string(b) != unit {
		if err := os.WriteFile(s.unitPath(), []byte(unit), 0o644); err != nil {
			return err
		}
		if _, err := s.systemctl("daemon-reload"); err != nil {
			return fmt.Errorf("systemctl --user daemon-reload: %w", err)
		}
	}
	if _, err := s.systemctl("enable", systemdUnit); err != nil {
		return fmt.Errorf("systemctl --user enable %s: %w", systemdUnit, err)
	}
	s.lingerHint()
	return nil
}

// lingerHint: without lingering, a user service stops at logout and only
// starts again at the next login.
func (s *systemdSupervisor) lingerHint() {
	user := s.c.getenv("USER")
	if user == "" {
		return
	}
	out, err := s.c.run.Output("", nil, "loginctl", "show-user", user, "-p", "Linger", "--value")
	if err == nil && strings.TrimSpace(string(out)) == "no" {
		s.c.infof("To keep Termote running after you log out (and start it at boot): loginctl enable-linger %s", user)
	}
}

// Start clears a start-limit hit first, so a server that crashed in a loop
// earlier can be started again.
func (s *systemdSupervisor) Start() error {
	s.systemctl("reset-failed", systemdUnit)
	if _, err := s.systemctl("restart", systemdUnit); err != nil {
		return fmt.Errorf("systemctl --user restart %s: %w (see: journalctl --user -u %s)", systemdUnit, err, systemdUnit)
	}
	return nil
}

func (s *systemdSupervisor) Stop() error {
	if _, err := s.systemctl("stop", systemdUnit); err != nil {
		return fmt.Errorf("systemctl --user stop %s: %w", systemdUnit, err)
	}
	return nil
}

func (s *systemdSupervisor) Status() (bool, int, error) {
	out, err := s.systemctl("show", systemdUnit, "-p", "ActiveState", "-p", "MainPID")
	if err != nil {
		return false, 0, err
	}
	var active string
	var pid int
	for _, line := range strings.Split(string(out), "\n") {
		k, v, _ := strings.Cut(strings.TrimSpace(line), "=")
		switch k {
		case "ActiveState":
			active = v
		case "MainPID":
			pid, _ = strconv.Atoi(v)
		}
	}
	return active == "active" && pid > 0, pid, nil
}

func (s *systemdSupervisor) Uninstall() error {
	s.systemctl("disable", "--now", systemdUnit)
	if err := removeFile(s.unitPath()); err != nil {
		return err
	}
	s.systemctl("daemon-reload")
	s.systemctl("reset-failed", systemdUnit)
	return nil
}
